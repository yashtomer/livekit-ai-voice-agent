import { useEffect, useRef, type RefObject } from 'react'
import type { GeminiStatus } from '../../hooks/useGeminiVoice'

/**
 * 3D avatar rendered with TalkingHead.js (met4citizen/TalkingHead@1.7), replacing
 * the previous react-three-fiber GLB renderer.
 *
 * ── Audio / playback ──
 * The Gemini Live audio is raw 16-bit PCM @ 24 kHz, streamed over the WebSocket in
 * useGeminiVoice. TalkingHead OWNS playback here: streamStart({sampleRate:24000})
 * recreates its AudioContext at 24 kHz (so the PCM plays at the correct pitch) and
 * each chunk is fed to head.streamAudio({ audio }). We attach to useGeminiVoice via
 * `audioSinkRef` (raw PCM in — replaces the hook's built-in playback) and
 * `audioInterruptRef` (barge-in / hang-up flush → head.streamInterrupt()).
 *
 * ── Lip-sync ──
 * TalkingHead's streaming only animates the mouth when given viseme/word *timing*
 * data, which Gemini's raw audio doesn't carry. So we drive an energy-based mouth
 * ourselves: each animation frame we read TalkingHead's own speech AnalyserNode
 * (head.audioAnalyzerNode) and set viseme/jaw morphs via head.setValue() — which
 * writes the `system` morph channel, overriding idle animation while speaking.
 * Idle breathing / blinking come from TalkingHead's built-in animation system.
 *
 * TalkingHead's `three` deps load from a CDN at runtime (see the importmap in
 * index.html). The avatar GLB is served LOCALLY from /public by default so it works
 * on networks that can't resolve a model CDN (the Ready Player Me host) — set
 * VITE_AVATAR_URL to a remote RPM URL only if your network can reach it.
 */

const TALKINGHEAD_URL =
  'https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/modules/talkinghead.mjs'

/**
 * Minimal typing for the TalkingHead instance — the library ships no TS types, so we
 * describe only the surface we actually touch: streaming playback, avatar/camera
 * control, and the morph-target map our energy-based lip-sync writes into.
 */
interface TalkingHeadMorph {
  realtime: number | null
  needsUpdate: boolean
}
interface TalkingHead {
  start(): void
  stop(): void
  showAvatar(opts: Record<string, unknown>): Promise<void>
  setView(view: CameraView): void
  streamStart(opts: Record<string, unknown>): Promise<void>
  streamStop(): void
  streamAudio(chunk: { audio: ArrayBuffer }): void
  streamInterrupt?(): void
  isStreaming?: boolean
  isSpeaking?: boolean
  audioAnalyzerNode?: AnalyserNode
  mtAvatar?: Record<string, TalkingHeadMorph | undefined>
}
type TalkingHeadModule = {
  TalkingHead: new (node: HTMLElement, opt?: Record<string, unknown>) => TalkingHead
}

/**
 * Selectable avatars — TalkingHead's official demo avatars, bundled in its repo and
 * served LOCALLY from /public (the original models.readyplayer.me URL now returns
 * NXDOMAIN, so we never reach a model CDN). Each carries the Oculus/ARKit visemes our
 * lip-sync drives. `opts` is the full descriptor passed to head.showAvatar() — the
 * retarget/baseline values (copied from TalkingHead's siteconfig.js) fix the resting
 * pose for the non-RPM rigs (Avaturn / AvatarSDK / VRoid), which otherwise stand wrong.
 */
export interface AvatarChoice {
  id: string
  label: string
  url: string
  opts: Record<string, unknown>
}

export const AVATARS: AvatarChoice[] = [
  { id: 'brunette', label: 'Brunette', url: '/brunette.glb', opts: { url: '/brunette.glb', body: 'F', avatarMood: 'neutral' } },
  { id: 'avatar-girl', label: 'Avatar Girl', url: '/avatar-girl.glb', opts: { url: '/avatar-girl.glb', body: 'F', avatarMood: 'neutral' } },
  {
    id: 'avatarsdk', label: 'Avatar SDK', url: '/avatarsdk.glb',
    opts: {
      url: '/avatarsdk.glb', body: 'M', avatarMood: 'neutral',
      retarget: {
        Neck: { z: -0.01, rx: -0.15 }, Neck1: { z: -0.01, rx: -0.15 }, Neck2: { z: -0.01, rx: -0.15 },
        LeftShoulder: { rz: -0.3 }, RightShoulder: { rz: 0.3 }, scaleToEyesLevel: 1.0, origin: { y: -0.1 },
      },
      baseline: { headRotateX: -0.04, eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
    },
  },
  {
    id: 'avaturn', label: 'Avaturn', url: '/avaturn.glb',
    opts: {
      url: '/avaturn.glb', body: 'F', avatarMood: 'happy',
      retarget: {
        Hips: { y: 0.03 }, Spine: { y: 0.02 }, Spine1: { y: 0.02, z: 0.01 }, Spine2: { y: 0.02, z: 0.01 },
        Neck: { z: 0.02, y: 0.01 }, Head: { z: 0.02 }, LeftShoulder: { rx: -0.5 }, RightShoulder: { rx: -0.5 },
        scaleToHipsLevel: 1.0,
      },
      baseline: { headRotateX: -0.05, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
    },
  },
  {
    id: 'mpfb', label: 'MPFB', url: '/mpfb.glb',
    opts: { url: '/mpfb.glb', body: 'F', avatarMood: 'happy', baseline: { headRotateX: -0.01, eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 } },
  },
  // NOTE: TalkingHead's demo VRoid avatar is intentionally omitted — it's a VRM-style
  // rig (no single "Armature" root, which TalkingHead's loader requires) and is meshopt
  // compressed, so it can't load here without VRM→RPM bone retargeting.
]

// Optional env override points at a custom local/remote GLB (must carry visemes).
const ENV_AVATAR_URL = (import.meta.env.VITE_AVATAR_URL as string | undefined) || null
export const DEFAULT_AVATAR_URL = ENV_AVATAR_URL || AVATARS[0].url

// Camera framings supported by TalkingHead (head.setView), exposed for a UI picker.
export type CameraView = 'head' | 'upper' | 'mid' | 'full'
export const CAMERA_VIEWS: { value: CameraView; label: string }[] = [
  { value: 'head', label: 'Head' },
  { value: 'upper', label: 'Upper body' },
  { value: 'mid', label: 'Waist-up' },
  { value: 'full', label: 'Full body' },
]
export const DEFAULT_CAMERA_VIEW: CameraView = 'mid'

// Resolve a URL to its full showAvatar() descriptor (falls back to a plain RPM-style
// descriptor for custom/env URLs not in the preset list).
function resolveAvatarOpts(url: string): Record<string, unknown> {
  const found = AVATARS.find(a => a.url === url)
  return found ? found.opts : { url, body: 'F', avatarMood: 'neutral' }
}

// Gemini Live output PCM sample rate (matches PLAY_SAMPLE_RATE in useGeminiVoice).
const PLAY_SAMPLE_RATE = 24000

// Lip-sync tuning — mouth opening driven by the RMS energy of the output audio.
// ATTACK/RELEASE are per-frame lerp factors (higher = snappier). We apply the value
// through TalkingHead's `realtime` morph channel, which is instant (no easing), so
// these are the ONLY smoothing — keep ATTACK high so the mouth tracks syllables.
const GAIN = 2.2
const FLOOR = 0.015
const ATTACK = 0.5
const RELEASE = 0.3
const MAX_OPEN = 0.6

interface GeminiAvatarProps {
  inCall: boolean
  status: GeminiStatus
  /** TalkingHead attaches here to receive raw PCM chunks and own playback. */
  audioSinkRef: RefObject<((buf: ArrayBuffer) => void) | null>
  /** TalkingHead attaches here to flush audio on barge-in / hang-up. */
  audioInterruptRef: RefObject<(() => void) | null>
  /** Local GLB URL of the avatar to show (see AVATARS). Swaps live when changed. */
  avatarUrl?: string
  /** Camera framing (see CAMERA_VIEWS). Re-frames live when changed. */
  cameraView?: CameraView
  /** Render box in px (keeps a portrait-ish aspect). */
  width?: number
  height?: number
  /** Live caller mood — tints the glow (green/amber/red) when in call. */
  mood?: 'positive' | 'neutral' | 'negative' | null
}

export default function GeminiAvatar({
  inCall,
  status,
  audioSinkRef,
  audioInterruptRef,
  avatarUrl = DEFAULT_AVATAR_URL,
  cameraView = DEFAULT_CAMERA_VIEW,
  width = 260,
  height = 300,
  mood = null,
}: GeminiAvatarProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<TalkingHead | null>(null)
  const readyRef = useRef(false)
  const streamingRef = useRef(false)
  const inCallRef = useRef(inCall)
  const rafRef = useRef<number | null>(null)
  const smoothed = useRef(0)
  const freqBuf = useRef<Uint8Array | null>(null)
  // PCM chunks that arrive before streamStart() has finished initialising.
  const pendingRef = useRef<ArrayBuffer[]>([])
  // Currently-shown avatar URL + a flag set while a swap is loading (so the lip
  // loop doesn't poke morphs on a half-loaded model).
  const avatarUrlRef = useRef(avatarUrl)
  const swappingRef = useRef(false)
  const cameraViewRef = useRef(cameraView)

  // Keep live views for the async paths (which may finish after props change)
  // without re-running the heavy init effect.
  inCallRef.current = inCall
  avatarUrlRef.current = avatarUrl
  cameraViewRef.current = cameraView

  // ── Streaming lifecycle (TalkingHead owns audio playback) ──────────────────
  const beginStreaming = async () => {
    const head = headRef.current
    if (!head || !readyRef.current || streamingRef.current) return
    try {
      // sampleRate:24000 rebuilds TalkingHead's AudioContext so the 24 kHz PCM
      // plays at the right pitch; lipsyncType:'visemes' keeps its viseme channel.
      await head.streamStart({ sampleRate: PLAY_SAMPLE_RATE, lipsyncType: 'visemes', mood: 'neutral' })
      streamingRef.current = true
      const pending = pendingRef.current
      pendingRef.current = []
      for (const buf of pending) {
        try { head.streamAudio({ audio: buf }) } catch { /* noop */ }
      }
    } catch (err) {
      console.error('[GeminiAvatar] streamStart failed', err)
    }
  }

  const endStreaming = () => {
    pendingRef.current = []
    smoothed.current = 0
    const head = headRef.current
    if (!head || !streamingRef.current) return
    try { head.streamStop() } catch { /* noop */ }
    streamingRef.current = false
  }

  // ── Energy-driven mouth: read TalkingHead's speech analyser, set viseme morphs ─
  const startLipLoop = () => {
    // Write a morph through the `realtime` channel (instant, no easing). Passing null
    // releases it so idle animation / baseline resumes (mouth fully closes).
    const setRT = (head: TalkingHead, mt: string, v: number | null) => {
      const o = head.mtAvatar?.[mt]
      if (o) { o.realtime = v; o.needsUpdate = true }
    }
    // Mouth morphs we drive — released together on silence.
    const MOUTH = ['viseme_aa', 'viseme_O', 'viseme_E', 'jawOpen']

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop)
      const head = headRef.current
      if (!head || swappingRef.current) return
      const analyser = head.audioAnalyzerNode

      let rms = 0
      let centroid = 0.5
      if (analyser && head.isSpeaking) {
        const fft = analyser.fftSize
        if (!freqBuf.current || freqBuf.current.length !== fft) {
          freqBuf.current = new Uint8Array(fft)
        }
        const buf = freqBuf.current
        // Time-domain RMS → loudness (strong, low-latency signal).
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < fft; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        rms = Math.sqrt(sum / fft)
        // Cheap spectral tilt for vowel shape (reuse buf for frequency data).
        analyser.getByteFrequencyData(buf)
        let num = 0
        let den = 0
        const bins = analyser.frequencyBinCount
        for (let i = 0; i < bins; i++) { num += i * buf[i]; den += buf[i] }
        if (den > 0) centroid = Math.min(1, num / den / bins / 0.5)
      }

      const target = Math.max(0, Math.min(MAX_OPEN, (rms - FLOOR) * GAIN))
      const s = smoothed.current
      smoothed.current = s + (target - s) * (target > s ? ATTACK : RELEASE)
      const open = smoothed.current

      if (open < 0.01) {
        // Closed → release the channel so blink/breathing idle takes over.
        for (const mt of MOUTH) setRT(head, mt, null)
        return
      }
      const round = 1 - centroid
      setRT(head, 'viseme_aa', open * (0.55 + 0.45 * centroid))
      setRT(head, 'viseme_O', open * 0.5 * round)
      setRT(head, 'viseme_E', open * 0.45 * centroid)
      setRT(head, 'jawOpen', open * 0.4)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  // ── Init TalkingHead once on mount ─────────────────────────────────────────
  useEffect(() => {
    let disposed = false

    const init = async () => {
      let mod: TalkingHeadModule
      try {
        mod = await import(/* @vite-ignore */ TALKINGHEAD_URL)
      } catch (err) {
        console.error('[GeminiAvatar] failed to load TalkingHead module', err)
        return
      }
      if (disposed || !containerRef.current) return

      const head = new mod.TalkingHead(containerRef.current, {
        ttsEndpoint: null,        // we never use TalkingHead's TTS
        lipsyncModules: [],       // no text→viseme; we drive the mouth from audio
        cameraView: cameraViewRef.current, // initial framing (see CAMERA_VIEWS)
        cameraRotateEnable: false,
        avatarMood: 'neutral',
        // TalkingHead renders at modelPixelRatio × devicePixelRatio. Default 1 looks
        // soft on 1× displays — target ~2.5× effective for a crisp/HD look without
        // ever rendering below the screen's native ratio.
        modelPixelRatio: Math.max(1, 2.5 / (window.devicePixelRatio || 1)),
      })
      headRef.current = head

      try {
        await head.showAvatar(resolveAvatarOpts(avatarUrlRef.current))
      } catch (err) {
        console.error('[GeminiAvatar] failed to load avatar', err)
        return
      }
      if (disposed) {
        try { head.stop() } catch { /* noop */ }
        return
      }

      head.start()
      readyRef.current = true

      // Wire useGeminiVoice → TalkingHead. PCM arriving before streamStart() is
      // ready is buffered and flushed in beginStreaming().
      audioSinkRef.current = (buf: ArrayBuffer) => {
        const h = headRef.current
        if (!h || !streamingRef.current || !h.isStreaming) {
          pendingRef.current.push(buf)
          return
        }
        try { h.streamAudio({ audio: buf }) } catch { /* noop */ }
      }
      audioInterruptRef.current = () => {
        pendingRef.current = []
        smoothed.current = 0
        try { headRef.current?.streamInterrupt?.() } catch { /* noop */ }
      }

      startLipLoop()
      // If a call was started while the avatar was still loading, begin now.
      if (inCallRef.current) void beginStreaming()
    }

    void init()

    return () => {
      disposed = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      audioSinkRef.current = null
      audioInterruptRef.current = null
      try { headRef.current?.streamStop?.() } catch { /* noop */ }
      try { headRef.current?.stop?.() } catch { /* noop */ }
      headRef.current = null
      readyRef.current = false
      streamingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Hot-swap the avatar when the selected URL changes ──────────────────────
  useEffect(() => {
    const head = headRef.current
    if (!head || !readyRef.current) return // initial load is handled by init()
    let cancelled = false
    swappingRef.current = true
    smoothed.current = 0
    ;(async () => {
      try {
        await head.showAvatar(resolveAvatarOpts(avatarUrl))
      } catch (err) {
        console.error('[GeminiAvatar] failed to swap avatar', err)
      } finally {
        if (!cancelled) swappingRef.current = false
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarUrl])

  // ── Re-frame the camera when the view changes (animates) ───────────────────
  useEffect(() => {
    const head = headRef.current
    if (!head || !readyRef.current) return // initial framing comes from the constructor
    try { head.setView(cameraView) } catch { /* noop */ }
  }, [cameraView])

  // ── Start/stop streaming as the call begins/ends ───────────────────────────
  useEffect(() => {
    if (!readyRef.current) return
    if (inCall) void beginStreaming()
    else endStreaming()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall])

  const isListening = inCall && status === 'listening'
  const isSpeaking = inCall && status === 'speaking'
  const glow = Math.round(Math.min(width, height) * 0.82)

  // When a live caller mood is known, it overrides the default state colour so
  // the glow reads green (happy) → amber (neutral) → red (frustrated).
  const moodRGB = mood === 'negative' ? '239,68,68' : mood === 'positive' ? '34,197,94' : mood === 'neutral' ? '245,158,11' : null
  const ringRGB = moodRGB || '34,197,94'
  const glowBg = moodRGB
    ? `radial-gradient(circle, rgba(${moodRGB},${isSpeaking ? 0.38 : 0.26}), transparent 70%)`
    : isSpeaking
    ? 'radial-gradient(circle, rgba(192,132,252,0.35), transparent 70%)'
    : isListening
    ? 'radial-gradient(circle, rgba(34,197,94,0.22), transparent 70%)'
    : 'radial-gradient(circle, rgba(148,163,184,0.12), transparent 70%)'

  return (
    <div className="relative flex items-center justify-center" style={{ width, height }}>
      {/* Glow behind the avatar reflects call state + caller mood */}
      <span
        className="absolute rounded-full transition-all duration-500"
        style={{ width: glow, height: glow, background: glowBg, filter: 'blur(10px)' }}
      />
      {isListening && (
        <>
          <span className="gemini-orb-ring absolute" style={{ width: glow, height: glow, borderColor: `rgba(${ringRGB},0.45)` }} />
          <span className="gemini-orb-ring gemini-orb-ring--2 absolute" style={{ width: glow, height: glow, borderColor: `rgba(${ringRGB},0.3)` }} />
        </>
      )}

      {/* TalkingHead mounts its own canvas into this container. */}
      <div ref={containerRef} className="relative rounded-2xl overflow-hidden" style={{ width, height }} />
    </div>
  )
}
