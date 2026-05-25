"""
WhatsApp ↔ Ultravox AI call bridge.

Endpoints (prefix /whatsapp in main.py):
  GET  /call-events  — Meta webhook verification
  POST /call-events  — Incoming call events from WhatsApp
  POST /create-web-call — Create an Ultravox web-call session for browser use

When a WhatsApp call arrives, this module:
  1. Creates an Ultravox AI session (serverWebSocket medium)
  2. Establishes a server-side WebRTC peer connection with WhatsApp
  3. Bridges audio bidirectionally: WhatsApp ↔ Ultravox WS

Requires network_mode: host on the backend container so STUN can
discover the real public IP (Docker NAT hides it, causing Meta to
reject the SDP answer).
"""

import asyncio
import fractions
import json
import os
import re

import av
from av.audio.resampler import AudioResampler
import httpx
import numpy as np
import websockets
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc import MediaStreamTrack
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse

PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID", "")
WHATSAPP_API_URL = f"https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/calls"
ACCESS_TOKEN = f"Bearer {os.environ.get('ACCESS_TOKEN', '')}"
ULTRAVOX_API_KEY = os.environ.get("ULTRAVOX_API_KEY", "")
META_VERIFY_TOKEN = os.environ.get("META_VERIFY_TOKEN", "my_super_secret_token_123")

ICE_SERVERS = [RTCIceServer(urls=["stun:stun.relay.metered.ca:80"])]


def _sanitize_sdp(sdp: str) -> str:
    """Fix aiortc SDP quirks that cause WhatsApp to reject with SDP Validation error.

    1. aiortc emits sha-256 + sha-384 + sha-512 fingerprints; WhatsApp accepts only one.
    2. aiortc omits a=fmtp for Opus; WhatsApp requires minptime/useinbandfec.
    """
    lines = [l.rstrip("\r") for l in sdp.split("\n")]
    has_fmtp = any(l.startswith("a=fmtp:") for l in lines)

    result: list[str] = []
    sha256_added = False

    for line in lines:
        # Keep only the sha-256 fingerprint.
        if line.startswith("a=fingerprint:"):
            if "sha-256" in line and not sha256_added:
                result.append(line)
                sha256_added = True
            continue

        result.append(line)

        # Inject fmtp for Opus right after its rtpmap if not already present.
        if not has_fmtp:
            m = re.match(r"a=rtpmap:(\d+) opus/", line)
            if m:
                result.append(f"a=fmtp:{m.group(1)} minptime=10;useinbandfec=1")

    return "\n".join(result)

router = APIRouter()

# callId -> {"pc": RTCPeerConnection, "audio_track": UltravoxAudioTrack, "uv_ws": WebSocket}
_active_calls: dict[str, dict] = {}


class _UltravoxAudioTrack(MediaStreamTrack):
    """Feeds raw PCM frames received from Ultravox into the WhatsApp WebRTC connection."""

    kind = "audio"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._pts = 0

    async def recv(self) -> av.AudioFrame:
        pcm_bytes = await self._queue.get()
        samples = np.frombuffer(pcm_bytes, dtype=np.int16)
        frame = av.AudioFrame(format="s16", layout="mono", samples=len(samples))
        frame.sample_rate = 48000
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, 48000)
        frame.planes[0].update(pcm_bytes)
        self._pts += len(samples)
        return frame

    async def push(self, pcm_bytes: bytes) -> None:
        await self._queue.put(pcm_bytes)


async def _wait_for_ice(pc: RTCPeerConnection, timeout: float = 4.0) -> None:
    if pc.iceGatheringState == "complete":
        return
    done = asyncio.Event()

    @pc.on("icegatheringstatechange")
    def _on_change():
        if pc.iceGatheringState == "complete":
            done.set()

    try:
        await asyncio.wait_for(done.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


async def _whatsapp_action(call_id: str, sdp: str, action: str) -> bool:
    body = {
        "messaging_product": "whatsapp",
        "call_id": call_id,
        "action": action,
        "session": {"sdp_type": "answer", "sdp": sdp},
    }
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(
                WHATSAPP_API_URL,
                json=body,
                headers={"Authorization": ACCESS_TOKEN},
                timeout=10,
            )
            ok = r.json().get("success") is True
            if ok:
                print(f"WhatsApp {action}: OK")
            else:
                print(f"WhatsApp {action} FAILED ({r.status_code}): {r.text}")
            return ok
        except Exception as e:
            print(f"WhatsApp {action} error: {e}")
            return False


async def _create_ultravox_call() -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.ultravox.ai/api/calls",
            json={
                "systemPrompt": (
                    "You are a helpful AI voice assistant. Greet the caller warmly "
                    "and ask how you can help them today. Keep responses concise."
                ),
                "voice": "Mark",
                "medium": {
                    "serverWebSocket": {
                        "inputSampleRate": 48000,
                        "outputSampleRate": 48000,
                    }
                },
            },
            headers={"X-API-Key": ULTRAVOX_API_KEY},
            timeout=15,
        )
        r.raise_for_status()
        return r.json()


def _cleanup(call_id: str) -> None:
    state = _active_calls.pop(call_id, None)
    if not state:
        return
    try:
        asyncio.ensure_future(state["pc"].close())
    except Exception:
        pass
    uv_ws = state.get("uv_ws")
    if uv_ws:
        try:
            asyncio.ensure_future(uv_ws.close())
        except Exception:
            pass


async def _forward_whatsapp_to_ultravox(
    track: MediaStreamTrack, uv_ws_future: "asyncio.Future", call_id: str
) -> None:
    print("WhatsApp→Ultravox: waiting for Ultravox WS to be ready...")
    uv_ws = await uv_ws_future
    print(f"WhatsApp→Ultravox: WS ready, starting audio forward (ws.closed={uv_ws.closed})")
    resampler = AudioResampler(format="s16", layout="mono", rate=48000)
    frame_count = 0
    while True:
        try:
            frame: av.AudioFrame = await track.recv()
            for resampled in resampler.resample(frame):
                pcm_bytes = bytes(resampled.planes[0])
                if not uv_ws.closed:
                    await uv_ws.send(pcm_bytes)
                    frame_count += 1
                    if frame_count <= 5 or frame_count % 100 == 0:
                        print(f"WhatsApp→Ultravox: frame #{frame_count} ({len(pcm_bytes)} bytes)")
        except Exception as e:
            print(f"WhatsApp→Ultravox forward stopped after {frame_count} frames: {e}")
            break


async def _forward_ultravox_to_whatsapp(
    uv_ws, audio_track: _UltravoxAudioTrack, call_id: str
) -> None:
    chunk_count = 0
    try:
        async for message in uv_ws:
            if isinstance(message, bytes):
                chunk_count += 1
                if chunk_count == 1 or chunk_count % 100 == 0:
                    print(f"Ultravox→WhatsApp chunk #{chunk_count}, {len(message) // 2} samples")
                await audio_track.push(message)
            else:
                try:
                    msg = json.loads(message)
                    if msg.get("type") == "transcript" and msg.get("text"):
                        print(f"[{msg.get('role')}] {msg['text']}")
                    elif msg.get("type") != "ping":
                        print(f"Ultravox event: {msg.get('type')}")
                except Exception:
                    pass
    except Exception as e:
        print(f"Ultravox WS closed: {e}")


async def _handle_call(call_id: str, whatsapp_sdp: str) -> None:
    # Run Ultravox session creation and WebRTC ICE gathering in parallel
    # so we hit pre_accept as fast as possible (Meta has a short window).
    audio_track = _UltravoxAudioTrack()
    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ICE_SERVERS))
    pc.addTrack(audio_track)

    # Resolved once the Ultravox WS is open — forwarding task waits on this
    # so no WhatsApp audio frames are dropped before uv_ws is ready.
    uv_ws_ready: asyncio.Future = asyncio.get_event_loop().create_future()

    @pc.on("track")
    def on_track(track):
        print(f"on_track fired: kind={track.kind} id={track.id}")
        if track.kind == "audio":
            print("WhatsApp audio track received — queuing forward task")
            asyncio.ensure_future(_forward_whatsapp_to_ultravox(track, uv_ws_ready, call_id))

    async def _setup_webrtc():
        await pc.setRemoteDescription(RTCSessionDescription(sdp=whatsapp_sdp, type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await _wait_for_ice(pc, timeout=2.0)
        return _sanitize_sdp(pc.localDescription.sdp.replace("a=setup:actpass", "a=setup:active"))

    uv_call, final_sdp = await asyncio.gather(
        _create_ultravox_call(),
        _setup_webrtc(),
    )
    print("Ultravox session created, WebRTC ICE complete — sending pre_accept")

    pre_ok = await _whatsapp_action(call_id, final_sdp, "pre_accept")
    if not pre_ok:
        print("Pre-accept failed — cleaning up")
        await pc.close()
        return

    # Connect Ultravox WS while the 1s window before accept ticks
    uv_ws_task = asyncio.ensure_future(websockets.connect(uv_call["joinUrl"]))
    await asyncio.sleep(1)
    accept_ok = await _whatsapp_action(call_id, final_sdp, "accept")

    uv_ws = await uv_ws_task
    _active_calls[call_id] = {"pc": pc, "audio_track": audio_track, "uv_ws": uv_ws}

    # Unblock the WhatsApp→Ultravox forwarding task
    if not uv_ws_ready.done():
        uv_ws_ready.set_result(uv_ws)

    asyncio.ensure_future(_forward_ultravox_to_whatsapp(uv_ws, audio_track, call_id))

    if accept_ok:
        print("Call accepted — Ultravox AI is live")
    else:
        print("Accept failed — cleaning up")
        _cleanup(call_id)


# ── Webhook verification ──────────────────────────────────────────────────────

@router.get("/call-events")
async def verify_webhook(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge"),
):
    if hub_mode == "subscribe" and hub_verify_token == META_VERIFY_TOKEN:
        print("WhatsApp webhook verified")
        return PlainTextResponse(hub_challenge)
    return PlainTextResponse("Forbidden", status_code=403)


# ── Incoming call webhook ─────────────────────────────────────────────────────

@router.post("/call-events")
async def call_events(request: Request):
    try:
        body = await request.json()
        value = (
            body.get("entry", [{}])[0]
            .get("changes", [{}])[0]
            .get("value", {})
        )
        calls = value.get("calls") or []
        contacts = value.get("contacts") or []
        call = calls[0] if calls else None
        contact = contacts[0] if contacts else None

        if not call or not call.get("id") or not call.get("event"):
            return PlainTextResponse("OK")

        call_id = call["id"]

        if call["event"] == "connect":
            whatsapp_sdp = call.get("session", {}).get("sdp")
            caller_name = (contact or {}).get("profile", {}).get("name", "Unknown")
            print(f"\nIncoming WhatsApp call from {caller_name}")
            asyncio.create_task(_handle_call(call_id, whatsapp_sdp))

        elif call["event"] == "terminate":
            print(f"WhatsApp call {call_id} terminated")
            _cleanup(call_id)

    except Exception as e:
        print(f"WhatsApp webhook error: {e}")

    return PlainTextResponse("OK")


# ── Browser web-call endpoint ─────────────────────────────────────────────────

@router.post("/create-web-call")
async def create_web_call(request: Request):
    api_key = request.headers.get("x-ultravox-key") or ULTRAVOX_API_KEY
    if not api_key:
        return JSONResponse({"error": "Ultravox API key not configured"}, status_code=500)

    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(
                "https://api.ultravox.ai/api/calls",
                json={
                    "systemPrompt": (
                        "You are a helpful AI voice assistant. Greet the caller warmly "
                        "and ask how you can help them today. Keep responses concise."
                    ),
                    "voice": "Mark",
                    "medium": {"webRtc": {}},
                },
                headers={"X-API-Key": api_key},
                timeout=15,
            )
            r.raise_for_status()
            return JSONResponse({"joinUrl": r.json()["joinUrl"]})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
