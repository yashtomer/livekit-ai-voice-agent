require("dotenv").config();
const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");
const {
  RTCPeerConnection,
  RTCSessionDescription,
  MediaStream,
  nonstandard: { RTCAudioSink, RTCAudioSource },
} = require("@roamhq/wrtc");

const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.ACCESS_TOKEN}`;
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

const ICE_SERVERS = [{ urls: "stun:stun.relay.metered.ca:80" }];

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-ultravox-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// callId -> { pc, sink, audioSource, uvWs }
const activeCalls = new Map();

// ── Webhook verification ────────────────────────────────────────────────────
app.get("/call-events", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming call webhook ───────────────────────────────────────────────────
app.post("/call-events", async (req, res) => {
  res.sendStatus(200); // ACK immediately so Meta doesn't retry

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const call = value?.calls?.[0];
    const contact = value?.contacts?.[0];

    if (!call?.id || !call?.event) return;

    const callId = call.id;

    if (call.event === "connect") {
      const whatsappSdp = call?.session?.sdp;
      const callerName = contact?.profile?.name || "Unknown";
      console.log(`\nIncoming call from ${callerName}`);
      handleCall(callId, whatsappSdp).catch((err) => console.error("Call handler error:", err));
    } else if (call.event === "terminate") {
      console.log(`Call ${callId} terminated`);
      cleanup(callId);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ── Core call handler ───────────────────────────────────────────────────────
async function handleCall(callId, whatsappSdp) {
  // 1. Create Ultravox AI session
  const uvCall = await createUltravoxCall();
  console.log("Ultravox session created, connecting...");

  // 2. Set up server-side WebRTC peer connection for WhatsApp
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // RTCAudioSource lets us push PCM audio into the WhatsApp WebRTC track
  const audioSource = new RTCAudioSource();
  const sourceTrack = audioSource.createTrack();
  pc.addTrack(sourceTrack, new MediaStream([sourceTrack]));

  let uvWs = null;
  let sink = null;

  // When WhatsApp sends us their audio track, forward it to Ultravox
  pc.ontrack = ({ track }) => {
    console.log("WhatsApp audio track received — bridging to Ultravox");
    sink = new RTCAudioSink(track);
    sink.ondata = ({ samples }) => {
      if (uvWs?.readyState === WebSocket.OPEN) {
        // samples is Int16Array (s16le PCM) — exactly what Ultravox expects
        uvWs.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
      }
    };
  };

  // 3. Process WhatsApp's SDP offer and build our answer
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: whatsappSdp }));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // Wait for ICE gathering so the SDP includes reachable candidates
  await waitForIceGathering(pc, 4000);
  const finalSdp = pc.localDescription.sdp.replace("a=setup:actpass", "a=setup:active");

  // 4. Connect to Ultravox WebSocket
  uvWs = new WebSocket(uvCall.joinUrl);

  uvWs.on("open", async () => {
    console.log("Connected to Ultravox");
    activeCalls.set(callId, { pc, sink, audioSource, uvWs });

    // Answer the WhatsApp call once Ultravox is ready
    const preOk = await whatsappAction(callId, finalSdp, "pre_accept");
    if (preOk) {
      await delay(1000);
      const acceptOk = await whatsappAction(callId, finalSdp, "accept");
      if (acceptOk) {
        console.log("Call accepted — Ultravox AI is live");
      } else {
        console.error("Accept failed — cleaning up");
        cleanup(callId);
      }
    } else {
      console.error("Pre-accept failed — cleaning up");
      cleanup(callId);
    }
  });

  let audioChunkCount = 0;

  uvWs.on("message", (data, isBinary) => {
    if (isBinary) {
      // @roamhq/wrtc requires exactly 480 frames per onData call (10ms at 48kHz).
      // Ultravox sends 960-sample (20ms) chunks, so we split each into two.
      // We also slice to a fresh ArrayBuffer to avoid Node Buffer pool offset bugs.
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const allSamples = new Int16Array(ab);

      audioChunkCount++;
      if (audioChunkCount === 1 || audioChunkCount % 100 === 0) {
        console.log(`Ultravox audio → WhatsApp: chunk #${audioChunkCount}, ${allSamples.length} samples`);
      }

      const FRAME_SIZE = 480;
      for (let offset = 0; offset + FRAME_SIZE <= allSamples.length; offset += FRAME_SIZE) {
        // slice gives a fresh ArrayBuffer with byteOffset 0 — safe for native wrtc code
        const frame = new Int16Array(ab.slice(offset * 2, (offset + FRAME_SIZE) * 2));
        try {
          audioSource.onData({
            samples: frame,
            sampleRate: 48000,
            bitsPerSample: 16,
            channelCount: 1,
            numberOfFrames: FRAME_SIZE,
          });
        } catch (e) {
          console.error("audioSource.onData error:", e.message);
          break;
        }
      }
    } else {
      // JSON control/transcript messages
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "transcript" && msg.text) {
          console.log(`[${msg.role}] ${msg.text}`);
        } else if (msg.type !== "ping") {
          console.log(`Ultravox event: ${msg.type}`);
        }
      } catch (_) { }
    }
  });

  uvWs.on("error", (err) => console.error("Ultravox WS error:", err.message));
  uvWs.on("close", () => console.log("Ultravox WS closed"));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function waitForIceGathering(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function cleanup(callId) {
  const state = activeCalls.get(callId);
  if (!state) return;
  try { state.sink?.stop(); } catch (_) { }
  try { state.uvWs?.close(); } catch (_) { }
  try { state.pc?.close(); } catch (_) { }
  activeCalls.delete(callId);
}

async function createUltravoxCall() {
  const { data } = await axios.post(
    "https://api.ultravox.ai/api/calls",
    {
      systemPrompt:
        "You are a helpful AI voice assistant. Greet the caller warmly and ask how you can help them today. Keep responses concise.",
      voice: "Mark",
      medium: {
        serverWebSocket: {
          inputSampleRate: 48000,
          outputSampleRate: 48000,
        },
      },
    },
    {
      headers: {
        "X-API-Key": ULTRAVOX_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );
  return data;
}

async function whatsappAction(callId, sdp, action) {
  try {
    const { data } = await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: "whatsapp",
        call_id: callId,
        action,
        session: { sdp_type: "answer", sdp },
      },
      { headers: { Authorization: ACCESS_TOKEN, "Content-Type": "application/json" } }
    );
    console.log(`WhatsApp ${action}: ${data?.success ? "OK" : "FAILED"}`);
    return data?.success === true;
  } catch (err) {
    console.error(`WhatsApp ${action} error:`, err.response?.data || err.message);
    return false;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Browser web-call endpoint ─────────────────────────────────────────────────
// Called by the React frontend to get a joinUrl for ultravox-client in the browser.
app.post("/create-web-call", async (req, res) => {
  try {
    const apiKey = req.headers["x-ultravox-key"] || ULTRAVOX_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Ultravox API key not configured" });

    const { data } = await axios.post(
      "https://api.ultravox.ai/api/calls",
      {
        systemPrompt:
          "You are a helpful AI voice assistant. Greet the caller warmly and ask how you can help them today. Keep responses concise.",
        voice: "Mark",
        medium: { webRtc: {} },
      },
      { headers: { "X-API-Key": apiKey, "Content-Type": "application/json" } }
    );
    res.json({ joinUrl: data.joinUrl });
  } catch (err) {
    console.error("create-web-call error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ultravox WhatsApp server running on port ${PORT}`);
});
