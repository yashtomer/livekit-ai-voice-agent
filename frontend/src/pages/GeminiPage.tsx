import { useState, useEffect, useRef } from 'react'
import { Device, Call } from '@twilio/voice-sdk'
import { Phone, PhoneOff, Mic, MicOff, ChevronDown, Settings } from 'lucide-react'
import Layout from '../components/Layout'
import useGeminiVoice, { type GeminiStatus } from '../hooks/useGeminiVoice'
import { useUIStore } from '../store/uiStore'

// ── Constants ────────────────────────────────────────────────────────────────

const VOICES = [
  { name: 'Aoede',    gender: 'F', style: 'Warm & Natural' },
  { name: 'Charon',   gender: 'M', style: 'Deep & Authoritative' },
  { name: 'Fenrir',   gender: 'M', style: 'Expressive & Dynamic' },
  { name: 'Kore',     gender: 'F', style: 'Clear & Professional' },
  { name: 'Puck',     gender: 'M', style: 'Upbeat & Friendly' },
  { name: 'Zephyr',   gender: 'F', style: 'Bright & Energetic' },
  { name: 'Leda',     gender: 'F', style: 'Soft & Soothing' },
  { name: 'Orus',     gender: 'M', style: 'Professional & Calm' },
  { name: 'Schedar',  gender: 'M', style: 'Formal & Confident' },
  { name: 'Orbit',    gender: 'N', style: 'Neutral & Versatile' },
  { name: 'Callirrhoe', gender: 'F', style: 'Natural & Conversational' },
  { name: 'Sulafat',  gender: 'F', style: 'Smooth & Melodic' },
  { name: 'Umbriel',  gender: 'N', style: 'Balanced & Clear' },
  { name: 'Algieba',  gender: 'M', style: 'Rich & Resonant' },
  { name: 'Despina',  gender: 'F', style: 'Light & Cheerful' },
  { name: 'Erinome',  gender: 'F', style: 'Crisp & Articulate' },
  { name: 'Gacrux',   gender: 'M', style: 'Steady & Reliable' },
  { name: 'Isonoe',   gender: 'F', style: 'Calm & Measured' },
  { name: 'Laomedeia', gender: 'F', style: 'Warm & Engaging' },
  { name: 'Pulcherrima', gender: 'F', style: 'Elegant & Refined' },
  { name: 'Rasalgethi', gender: 'M', style: 'Smooth & Assured' },
  { name: 'Sadachbia', gender: 'N', style: 'Clear & Direct' },
  { name: 'Sadaltager', gender: 'M', style: 'Bold & Assertive' },
  { name: 'Vindemiatrix', gender: 'F', style: 'Expressive & Nuanced' },
  { name: 'Zubenelgenubi', gender: 'M', style: 'Deep & Deliberate' },
  { name: 'Achernar', gender: 'F', style: 'Bright & Vivid' },
  { name: 'Achird',   gender: 'N', style: 'Neutral & Approachable' },
  { name: 'Alnilam',  gender: 'M', style: 'Strong & Structured' },
  { name: 'Autonoe',  gender: 'F', style: 'Fluid & Lifelike' },
  { name: 'Enceladus', gender: 'M', style: 'Composed & Thoughtful' },
]

const LANGUAGES = [
  { code: 'en', label: 'English' }, { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' }, { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' }, { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' }, { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' }, { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
]

const TEMPLATES = [
  {
    label: 'General Assistant',
    prompt: `You are a friendly, knowledgeable voice assistant named Alex.
Be extremely concise and natural—like talking to a smart friend on the phone.
Do NOT over-explain. Keep every reply to 1–2 sentences unless more detail is explicitly asked for.

RULES
- Ask only ONE question at a time
- Never list more than 3 options at once
- If you don't know something, say so honestly
- Match the user's energy: casual if they're casual, professional if they're formal
- Always respond in the same language the user is speaking`,
  },
  {
    label: 'Healthcare Booking',
    prompt: `You are a professional medical appointment booking assistant.
Be extremely concise, natural, and conversational—like a real phone operator.

WORKFLOW: Greet → get patient name → ask doctor/department → validate against roster → ask date & time (9am–5pm only) → check availability → ask for remarks → confirm all details → say goodbye.

DOCTORS: General Physician (Dr. John Smith, Dr. Emily Johnson) | Cardiology (Dr. Michael Brown, Dr. Sarah Davis) | Orthopedics (Dr. David Wilson, Dr. Laura Martinez) | Dermatology (Dr. James Anderson, Dr. Jessica Taylor) | Pediatrics (Dr. Daniel Thomas, Dr. Amanda White)

RULES: One question at a time. Max 2 lines per reply. If user declines, say goodbye immediately.`,
  },
  {
    label: 'Customer Support',
    prompt: `You are a customer support agent named Maya for QuickKart, an e-commerce platform.
Be warm, empathetic, and solution-oriented. Keep every response under 3 sentences.
Acknowledge frustration BEFORE solving the problem.

Workflow: Greet → identify issue → get Order ID if needed → resolve or escalate → close warmly.
For returns: explain 5–7 business day refund. For escalations: "I'll escalate this within 24 hours."`,
  },
  {
    label: 'Sales Agent',
    prompt: `You are an outbound sales agent named Riya for SoftNest, a B2B SaaS company.
Be confident, warm, and consultative—never pushy. Keep every response to 1–2 sentences.

Workflow: Brief intro → ask if good time → qualify lead (one question) → identify pain point → present matching feature → handle objections → close with demo offer or next step.
If not interested twice, politely end the call.`,
  },
]

const STATUS_META: Record<GeminiStatus, { label: string; color: string; dot: string }> = {
  idle:       { label: 'Ready',       color: 'text-muted-foreground',             dot: 'bg-muted-foreground/40' },
  connecting: { label: 'Connecting…', color: 'text-yellow-500',                   dot: 'bg-yellow-500 animate-ping' },
  listening:  { label: 'Listening',   color: 'text-green-500 dark:text-green-400', dot: 'bg-green-500 animate-pulse' },
  processing: { label: 'Processing',  color: 'text-blue-500',                     dot: 'bg-blue-500 animate-pulse' },
  speaking:   { label: 'Speaking',    color: 'text-purple-400',                   dot: 'bg-purple-400 animate-pulse' },
  error:      { label: 'Error',       color: 'text-destructive',                  dot: 'bg-destructive' },
}

// ── Orb component ────────────────────────────────────────────────────────────

function AgentOrb({ inCall, status }: { inCall: boolean; status: GeminiStatus }) {
  const isListening = inCall && status === 'listening'
  const isSpeaking  = inCall && status === 'speaking'

  return (
    <div className="relative flex items-center justify-center w-[260px] h-[260px]">
      {isListening && (
        <>
          <span className="gemini-orb-ring absolute" />
          <span className="gemini-orb-ring gemini-orb-ring--2 absolute" />
          <span className="gemini-orb-ring gemini-orb-ring--3 absolute" />
        </>
      )}
      <div className={`gemini-orb ${inCall ? 'gemini-orb--active' : ''} ${isSpeaking ? 'gemini-orb--speaking' : ''}`}>
        <svg className="gemini-orb-pattern" viewBox="0 0 120 120" fill="none">
          <circle cx="60" cy="60" r="28" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
          <circle cx="60" cy="60" r="18" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
          <circle cx="60" cy="32" r="28" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
          <circle cx="60" cy="88" r="28" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
          <circle cx="36" cy="46" r="28" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
          <circle cx="84" cy="46" r="28" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
          <circle cx="36" cy="74" r="28" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
          <circle cx="84" cy="74" r="28" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
          <circle cx="60" cy="60" r="6" fill="rgba(255,255,255,0.5)" />
        </svg>
      </div>
    </div>
  )
}

// ── Twilio Phone Dialer ──────────────────────────────────────────────────────

type PhoneStatus = 'idle' | 'connecting' | 'ready' | 'in-call' | 'error'

function PhoneDialer() {
  const [status, setStatus] = useState<PhoneStatus>('idle')
  const [error, setError] = useState('')
  const [muted, setMuted] = useState(false)
  const deviceRef = useRef<Device | null>(null)
  const callRef   = useRef<Call | null>(null)

  const rawBackend = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
  const backendUrl = rawBackend && !rawBackend.includes('host.docker.internal')
    ? rawBackend
    : `${window.location.protocol}//${window.location.hostname}:8000`

  async function ensureDevice() {
    if (deviceRef.current) return deviceRef.current
    const res = await fetch(`${backendUrl}/twilio/token`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.detail || `Token fetch failed: ${res.status}`)
    }
    const { token } = await res.json()
    const device = new Device(token, { logLevel: 1, codecPreferences: ['opus', 'pcmu'] as unknown as never[] })
    device.on('error', (e: Error) => { setError(e.message); setStatus('error') })
    await device.register()
    deviceRef.current = device
    return device
  }

  async function startCall() {
    setError('')
    setStatus('connecting')
    try {
      const device = await ensureDevice()
      const call = await device.connect({})
      callRef.current = call
      call.on('accept',     () => setStatus('in-call'))
      call.on('disconnect', () => { setStatus('ready'); callRef.current = null; setMuted(false) })
      call.on('cancel',     () => { setStatus('ready'); callRef.current = null })
      call.on('error',      (e: Error) => { setError(e.message); setStatus('error') })
    } catch (e: unknown) {
      setError((e as Error).message || String(e))
      setStatus('error')
    }
  }

  function hangUp() { callRef.current?.disconnect() }

  function toggleMute() {
    if (!callRef.current) return
    const next = !muted
    callRef.current.mute(next)
    setMuted(next)
  }

  useEffect(() => () => {
    callRef.current?.disconnect()
    deviceRef.current?.destroy()
  }, [])

  const busy = status === 'connecting' || status === 'in-call'

  const statusLabel: Record<PhoneStatus, string> = {
    idle:       'Not connected',
    connecting: 'Connecting to Twilio…',
    ready:      'Ready to call',
    'in-call':  'In call — agent is listening',
    error:      'Error',
  }

  const statusColor: Record<PhoneStatus, string> = {
    idle:       'text-muted-foreground',
    connecting: 'text-yellow-500',
    ready:      'text-green-500',
    'in-call':  'text-green-500',
    error:      'text-destructive',
  }

  return (
    <div className="flex flex-col items-center gap-8 py-8">
      {/* Status */}
      <div className={`flex items-center gap-2 text-sm font-medium ${statusColor[status]}`}>
        <span className={`w-2 h-2 rounded-full ${
          status === 'in-call' ? 'bg-green-500 animate-pulse' :
          status === 'connecting' ? 'bg-yellow-500 animate-ping' :
          status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'
        }`} />
        {statusLabel[status]}
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive max-w-sm text-center">
          {error}
        </div>
      )}

      {/* Description */}
      <div className="text-center text-sm text-muted-foreground max-w-xs leading-relaxed">
        Click <strong className="text-foreground">Call Healthcare Agent</strong> to connect via phone.
        Audio is routed: <span className="font-mono text-xs">browser → Twilio → Gemini Live</span>.
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4">
        {!busy ? (
          <button
            onClick={startCall}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold transition-all shadow-lg active:scale-95"
          >
            <Phone className="w-5 h-5" />
            Call Healthcare Agent
          </button>
        ) : (
          <>
            <button
              onClick={toggleMute}
              className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all border ${
                muted
                  ? 'bg-destructive/10 text-destructive border-destructive/30'
                  : 'bg-muted text-foreground border-border hover:bg-muted/80'
              }`}
            >
              {muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
            <button
              onClick={hangUp}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-destructive hover:bg-destructive/90 text-white font-semibold transition-all shadow-lg active:scale-95"
            >
              <PhoneOff className="w-5 h-5" />
              Hang Up
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

type Mode = 'browser' | 'phone'

export default function GeminiPage() {
  const [mode, setMode] = useState<Mode>('browser')
  const [language, setLanguage] = useState('en')
  const [templateIdx, setTemplateIdx] = useState(0)
  const [systemPrompt, setSystemPrompt] = useState(TEMPLATES[0].prompt)
  const [muted, setMuted] = useState(false)
  const [voice, setVoice] = useState('Aoede')
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const { openConfigModal } = useUIStore()

  const { status, inCall, isConnected, transcript, errorCode, startCall, hangUp, clearTranscript, clearError } =
    useGeminiVoice(systemPrompt, language, voice)

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  function handleTemplateChange(idx: number) {
    setTemplateIdx(idx)
    setSystemPrompt(TEMPLATES[idx].prompt)
  }

  async function handleStart() {
    clearError()
    clearTranscript()
    await startCall()
  }

  const sm = STATUS_META[status]
  const isActive = inCall || status === 'connecting'

  return (
    <Layout>
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6 h-[calc(100vh-3.5rem)] flex flex-col gap-4">

        {/* Page header + mode switcher */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Gemini Live Voice</h1>
            <p className="text-sm text-muted-foreground">Real-time AI voice calls powered by Google Gemini</p>
          </div>
          <div className="flex items-center bg-muted p-1 rounded-lg border border-border gap-0.5">
            {(['browser', 'phone'] as const).map(m => (
              <button
                key={m}
                onClick={() => { if (inCall) hangUp(); setMode(m) }}
                className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-all ${
                  mode === m
                    ? 'bg-card text-foreground shadow-sm border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'browser' ? 'Browser Voice' : 'Phone Bridge'}
              </button>
            ))}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex gap-6 min-h-0">

          {/* LEFT — config panel (only in browser mode) */}
          {mode === 'browser' && (
            <div className="w-80 flex-shrink-0 flex flex-col gap-4">
              <div className="card flex flex-col gap-4 flex-1">
                <h2 className="text-sm font-bold text-foreground uppercase tracking-wide">Agent Config</h2>

                <textarea
                  value={systemPrompt}
                  onChange={e => setSystemPrompt(e.target.value)}
                  disabled={isActive}
                  placeholder="Describe how your agent should behave…"
                  className="flex-1 min-h-[200px] bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-xs text-foreground resize-none leading-relaxed focus:outline-none focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
                />

                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Template</label>
                    <div className="relative">
                      <select
                        value={templateIdx}
                        onChange={e => handleTemplateChange(Number(e.target.value))}
                        disabled={isActive}
                        className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground pr-8 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-primary"
                      >
                        {TEMPLATES.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Language</label>
                    <div className="relative">
                      <select
                        value={language}
                        onChange={e => setLanguage(e.target.value)}
                        disabled={isActive}
                        className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground pr-8 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-primary"
                      >
                        {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Voice</label>
                    <div className="relative">
                      <select
                        value={voice}
                        onChange={e => setVoice(e.target.value)}
                        disabled={isActive}
                        className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground pr-8 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-primary"
                      >
                        {VOICES.map(v => (
                          <option key={v.name} value={v.name}>
                            {v.name} ({v.gender === 'F' ? 'Female' : v.gender === 'M' ? 'Male' : 'Neutral'}) — {v.style}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* RIGHT — orb + controls + transcript */}
          <div className="flex-1 card flex flex-col items-center justify-between min-h-0 overflow-hidden">

            {mode === 'browser' ? (
              <>
                {/* Top: connection + status */}
                <div className="w-full flex items-center justify-between pb-4 border-b border-border">
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                    <span className="text-muted-foreground">{isConnected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                  <div className={`flex items-center gap-1.5 text-xs font-semibold ${sm.color}`}>
                    <span className={`w-2 h-2 rounded-full ${sm.dot}`} />
                    {sm.label}
                  </div>
                </div>

                {/* API key error banner */}
                {errorCode === 'no_api_key' && (
                  <div className="w-full bg-destructive/10 border border-destructive/25 rounded-xl px-4 py-3 flex items-start gap-3">
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-destructive">Google (Gemini) API key not configured</p>
                      <p className="text-xs text-destructive/80 mt-0.5">Add your API key in Config to use Gemini Live voice calls.</p>
                    </div>
                    <button
                      onClick={() => { clearError(); openConfigModal('google') }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-destructive text-white text-xs font-semibold hover:bg-destructive/90 transition-all whitespace-nowrap"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      Open Config
                    </button>
                  </div>
                )}

                {/* Orb */}
                <div className="flex-1 flex items-center justify-center">
                  <AgentOrb inCall={inCall} status={status} />
                </div>

                {/* Call button */}
                <div className="pt-4 border-t border-border w-full flex items-center justify-center gap-4">
                  {inCall && (
                    <button
                      onClick={() => setMuted(m => !m)}
                      className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all border ${
                        muted
                          ? 'bg-destructive/10 text-destructive border-destructive/30'
                          : 'bg-muted text-foreground border-border hover:bg-muted/80'
                      }`}
                    >
                      {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </button>
                  )}
                  {!inCall ? (
                    <button
                      onClick={handleStart}
                      disabled={status === 'connecting'}
                      className="flex items-center gap-2 px-8 py-3 rounded-xl bg-primary text-primary-foreground font-bold text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg active:scale-95"
                    >
                      <Phone className="w-4 h-4" />
                      Start Speaking
                    </button>
                  ) : (
                    <button
                      onClick={hangUp}
                      className="flex items-center gap-2 px-8 py-3 rounded-xl bg-destructive text-white font-bold text-sm hover:bg-destructive/90 transition-all shadow-lg active:scale-95"
                    >
                      <PhoneOff className="w-4 h-4" />
                      End Call
                    </button>
                  )}
                </div>

                {/* Transcript */}
                {(transcript.length > 0 || (inCall && transcript.length === 0)) && (
                  <div className="w-full mt-4 bg-muted/30 border border-border rounded-xl p-3 max-h-44 overflow-y-auto space-y-2">
                    {inCall && transcript.length === 0 && (
                      <p className="text-xs text-muted-foreground/60 text-center py-2">Listening… start speaking</p>
                    )}
                    {transcript.map(entry => (
                      <div key={entry.id} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                          entry.role === 'user'
                            ? 'bg-primary text-primary-foreground rounded-br-sm'
                            : 'bg-card border border-border text-foreground rounded-bl-sm'
                        }`}>
                          <span className="block text-[10px] font-bold opacity-60 mb-0.5">
                            {entry.role === 'user' ? 'You' : 'Gemini'}
                          </span>
                          {entry.text}
                        </div>
                      </div>
                    ))}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </>
            ) : (
              <div className="w-full flex flex-col items-center justify-center flex-1">
                <div className="text-center mb-6">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mx-auto mb-4 shadow-2xl">
                    <Phone className="w-9 h-9 text-white" />
                  </div>
                  <h2 className="text-lg font-bold text-foreground">Healthcare Phone Agent</h2>
                  <p className="text-sm text-muted-foreground mt-1">Powered by Twilio + Gemini Live</p>
                </div>
                <PhoneDialer />
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
