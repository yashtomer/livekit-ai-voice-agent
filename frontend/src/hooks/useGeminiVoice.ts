import { useCallback, useEffect, useRef, useState } from 'react'

export type GeminiStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'error'
export type GeminiErrorCode = 'no_api_key' | 'generic'

export interface GeminiTranscriptEntry {
  id: number
  role: 'user' | 'model'
  text: string
}

const RECORD_SAMPLE_RATE = 16000
const PLAY_SAMPLE_RATE = 24000
const WORKLET_URL = '/audio-capture-worklet.js'

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
  const token = localStorage.getItem('access_token') || ''
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : ''
  if (base && !base.includes('host.docker.internal')) {
    return base.replace(/^https?/, proto.slice(0, -1)) + '/api/gemini/ws' + tokenParam
  }
  return `${proto}//${window.location.hostname}:8000/api/gemini/ws${tokenParam}`
}

function int16ToFloat32(buf: ArrayBuffer): Float32Array {
  const i16 = new Int16Array(buf)
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / (i16[i] < 0 ? 32768 : 32767)
  }
  return f32
}

export default function useGeminiVoice(systemPrompt = '', language = 'en', voice = 'Aoede') {
  const [status, setStatus] = useState<GeminiStatus>('idle')
  const [inCall, setInCall] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [transcript, setTranscript] = useState<GeminiTranscriptEntry[]>([])
  const [errorCode, setErrorCode] = useState<GeminiErrorCode | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordCtxRef = useRef<AudioContext | null>(null)
  const playCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const nextPlayTimeRef = useRef(0)
  const transcriptIdRef = useRef(0)
  const inCallRef = useRef(false)
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const systemPromptRef = useRef(systemPrompt)
  const languageRef = useRef(language)
  const voiceRef = useRef(voice)

  useEffect(() => { systemPromptRef.current = systemPrompt }, [systemPrompt])
  useEffect(() => { languageRef.current = language }, [language])
  useEffect(() => { voiceRef.current = voice }, [voice])
  useEffect(() => { inCallRef.current = inCall }, [inCall])

  function appendTranscript(role: 'user' | 'model', text: string) {
    setTranscript(prev => {
      if (prev.length > 0 && prev[prev.length - 1].role === role) {
        const u = [...prev]
        u[u.length - 1] = { ...u[u.length - 1], text: u[u.length - 1].text + ' ' + text }
        return u
      }
      return [...prev, { role, text, id: ++transcriptIdRef.current }]
    })
  }

  function playAudioBuffer(arrayBuf: ArrayBuffer) {
    const ctx = playCtxRef.current
    if (!ctx) return
    const f32 = int16ToFloat32(arrayBuf)
    const buf = ctx.createBuffer(1, f32.length, PLAY_SAMPLE_RATE)
    buf.copyToChannel(f32, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const at = Math.max(ctx.currentTime, nextPlayTimeRef.current)
    src.start(at)
    nextPlayTimeRef.current = at + buf.duration
    scheduledSourcesRef.current.push(src)
    src.onended = () => {
      const i = scheduledSourcesRef.current.indexOf(src)
      if (i >= 0) scheduledSourcesRef.current.splice(i, 1)
    }
  }

  function stopAllPlayback() {
    scheduledSourcesRef.current.forEach(s => { try { s.stop() } catch { /* noop */ } })
    scheduledSourcesRef.current = []
    nextPlayTimeRef.current = 0
  }

  function connectWS(onOpenCb: () => void) {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      onOpenCb()
      return
    }
    setStatus('connecting')
    const ws = new WebSocket(getWsUrl())
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      ws.send(JSON.stringify({
        type: 'config',
        system_prompt: systemPromptRef.current,
        language: languageRef.current,
        voice: voiceRef.current,
      }))
      onOpenCb()
    }

    ws.onclose = () => {
      setIsConnected(false)
      setInCall(false)
      inCallRef.current = false
      setStatus('idle')
      stopMicInternal()
    }

    ws.onerror = () => setStatus('error')

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        playAudioBuffer(event.data)
        return
      }
      let msg: Record<string, unknown>
      try { msg = JSON.parse(event.data as string) } catch { return }
      switch (msg.type) {
        case 'transcript':
          appendTranscript(msg.role as 'user' | 'model', msg.text as string)
          break
        case 'status':
          if (inCallRef.current) setStatus(msg.state as GeminiStatus)
          break
        case 'interrupted':
          stopAllPlayback()
          if (inCallRef.current) setStatus('listening')
          break
        case 'error':
          setStatus('error')
          setErrorCode(msg.code === 'no_api_key' ? 'no_api_key' : 'generic')
          break
      }
    }
  }

  async function startMicInternal(): Promise<boolean> {
    if (streamRef.current) return true
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: RECORD_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      setStatus('error')
      return false
    }
    streamRef.current = stream

    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
      sampleRate: RECORD_SAMPLE_RATE,
      latencyHint: 'interactive',
    })
    if (ctx.state === 'suspended') await ctx.resume()
    recordCtxRef.current = ctx

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL)
    } catch {
      setStatus('error')
      return false
    }

    const source = ctx.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(ctx, 'capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
    })
    sourceNodeRef.current = source
    processorRef.current = worklet

    worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (!inCallRef.current) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(ev.data)
    }
    source.connect(worklet)
    return true
  }

  function stopMicInternal() {
    processorRef.current?.disconnect()
    sourceNodeRef.current?.disconnect()
    processorRef.current = null
    sourceNodeRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    recordCtxRef.current?.close().catch(() => {})
    recordCtxRef.current = null
    nextPlayTimeRef.current = 0
  }

  async function preWarmPlayback() {
    if (!playCtxRef.current || playCtxRef.current.state === 'closed') {
      playCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
        sampleRate: PLAY_SAMPLE_RATE,
      })
    }
    if (playCtxRef.current.state === 'suspended') await playCtxRef.current.resume()
    nextPlayTimeRef.current = 0
  }

  const startCall = useCallback(async () => {
    await preWarmPlayback()
    connectWS(async () => {
      const ok = await startMicInternal()
      if (ok) {
        setInCall(true)
        inCallRef.current = true
        setStatus('listening')
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const hangUp = useCallback(() => {
    stopMicInternal()
    stopAllPlayback()
    inCallRef.current = false
    setInCall(false)
    setStatus('idle')
    wsRef.current?.close()
    wsRef.current = null
    playCtxRef.current?.close().catch(() => {})
    playCtxRef.current = null
  }, [])

  const clearTranscript = useCallback(() => setTranscript([]), [])
  const clearError = useCallback(() => setErrorCode(null), [])

  useEffect(() => {
    return () => {
      stopMicInternal()
      wsRef.current?.close()
      playCtxRef.current?.close().catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, inCall, isConnected, transcript, errorCode, startCall, hangUp, clearTranscript, clearError }
}
