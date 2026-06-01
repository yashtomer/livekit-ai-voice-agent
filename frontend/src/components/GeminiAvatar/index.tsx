import { Suspense, useMemo, useRef, type RefObject } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { GeminiStatus } from '../../hooks/useGeminiVoice'

/**
 * Ready Player Me avatar — served LOCALLY from /public so it works on networks
 * that can't reach models.readyplayer.me (no runtime CDN fetch, no CORS).
 *
 * To use YOUR OWN face: create a full-body avatar at https://readyplayer.me,
 * download the .glb with the morph-target params so visemes + blink blendshapes
 * are baked in (…?morphTargets=ARKit,Oculus Visemes), drop it in frontend/public,
 * and point AVATAR_URL (or VITE_AVATAR_URL) at it, e.g. '/my-avatar.glb'.
 */
const DEFAULT_AVATAR = '/avatar-girl.glb'
const AVATAR_URL =
  (import.meta.env.VITE_AVATAR_URL as string | undefined) || DEFAULT_AVATAR

// Lip-sync tuning — mouth opening is driven by RMS energy of the output audio.
const GAIN = 2.6
const FLOOR = 0.014
const ATTACK = 0.5
const RELEASE = 0.2
const MAX_OPEN = 0.7 // cap so it never gapes into a full yawn

interface GeminiAvatarProps {
  inCall: boolean
  status: GeminiStatus
  analyserRef: RefObject<AnalyserNode | null>
  /** Render box in px (keeps a portrait-ish aspect). Defaults to the full page size. */
  width?: number
  height?: number
  /** Live caller mood — tints the glow (green/amber/red) when in call. */
  mood?: 'positive' | 'neutral' | 'negative' | null
}

interface MorphMesh {
  influences: number[]
  dict: { [key: string]: number }
}

function AvatarModel({ analyserRef }: { analyserRef: RefObject<AnalyserNode | null> }) {
  const { scene } = useGLTF(AVATAR_URL)
  const groupRef = useRef<THREE.Group>(null)
  const smoothed = useRef(0)

  // Collect every skinned mesh that carries blendshapes (head, teeth, etc.).
  const morphMeshes = useMemo<MorphMesh[]>(() => {
    const out: MorphMesh[] = []
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.morphTargetInfluences && m.morphTargetDictionary) {
        out.push({ influences: m.morphTargetInfluences, dict: m.morphTargetDictionary })
      }
    })
    return out
  }, [scene])

  const timeBuf = useMemo(() => new Uint8Array(1024), [])
  const freqBuf = useMemo(() => new Uint8Array(512), [])

  const setMorph = (name: string, value: number) => {
    for (const mm of morphMeshes) {
      const idx = mm.dict[name]
      if (idx !== undefined) mm.influences[idx] = value
    }
  }

  useFrame((state) => {
    const analyser = analyserRef.current

    // ── Audio level → mouth openness ──
    let level = 0
    let centroid = 0.5
    if (analyser) {
      analyser.getByteTimeDomainData(timeBuf)
      let sum = 0
      for (let i = 0; i < timeBuf.length; i++) {
        const v = (timeBuf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / timeBuf.length)
      level = Math.max(0, Math.min(1, (rms - FLOOR) * GAIN))

      // Spectral balance → vowel shape (low = round "O", high = wide "E/I").
      analyser.getByteFrequencyData(freqBuf)
      let num = 0
      let den = 0
      for (let i = 0; i < freqBuf.length; i++) {
        num += i * freqBuf[i]
        den += freqBuf[i]
      }
      if (den > 0) centroid = Math.min(1, num / den / freqBuf.length / 0.5)
    }

    const s = smoothed.current
    smoothed.current = s + (level - s) * (level > s ? ATTACK : RELEASE)
    const open = Math.min(MAX_OPEN, smoothed.current)

    // Blend visemes for a more natural shape than a single jaw flap.
    const round = 1 - centroid // low centroid → rounder mouth
    setMorph('jawOpen', open * 0.4)
    setMorph('viseme_aa', open * (0.3 + 0.3 * centroid))
    setMorph('viseme_O', open * 0.45 * round)
    setMorph('viseme_E', open * 0.4 * centroid)
    setMorph('mouthSmileLeft', 0.12) // gentle resting smile
    setMorph('mouthSmileRight', 0.12)

    // ── Blink every ~4.2s ──
    const t = state.clock.elapsedTime
    const cyc = t % 4.2
    const blink = cyc < 0.14 ? Math.sin((cyc / 0.14) * Math.PI) : 0
    setMorph('eyeBlinkLeft', blink)
    setMorph('eyeBlinkRight', blink)

    // ── Subtle idle head motion ──
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(t * 0.5) * 0.06
      groupRef.current.rotation.x = Math.sin(t * 0.4) * 0.025
      groupRef.current.position.y = -1.55 + Math.sin(t * 1.2) * 0.004
    }
  })

  // Shift the full-body model down so the head/shoulders frame the camera.
  return (
    <group ref={groupRef} position={[0, -1.55, 0]}>
      <primitive object={scene} />
    </group>
  )
}

useGLTF.preload(AVATAR_URL)

export default function GeminiAvatar({ inCall, status, analyserRef, width = 260, height = 300, mood = null }: GeminiAvatarProps) {
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

      <Canvas
        className="relative"
        camera={{ position: [0, 0.02, 1.4], fov: 22 }}
        gl={{ antialias: true, alpha: true }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={1.1} />
        <directionalLight position={[2, 3, 3]} intensity={1.6} />
        <directionalLight position={[-2, 1, 2]} intensity={0.5} />
        <Suspense fallback={null}>
          <AvatarModel analyserRef={analyserRef} />
        </Suspense>
      </Canvas>
    </div>
  )
}
