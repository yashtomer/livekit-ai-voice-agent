import { useState, useEffect, useRef, useCallback } from 'react'
import { Device, Call } from '@twilio/voice-sdk'
import { Phone, PhoneOff, Mic, MicOff, ChevronDown, Settings, Home, ListVideo, Eye, X, RefreshCw, Play, Loader2, Mic2 } from 'lucide-react'
import Layout from '../components/Layout'
import useGeminiVoice, { type GeminiStatus } from '../hooks/useGeminiVoice'
import { useUIStore } from '../store/uiStore'

// ── Helpers ──────────────────────────────────────────────────────────────────

function backendBase(): string {
  const raw = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
  if (raw && !raw.includes('host.docker.internal')) return raw
  return `${window.location.protocol}//${window.location.hostname}:8000`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDuration(s: number | null): string {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m ${r}s`
}

const CALL_TYPE_LABEL: Record<string, string> = {
  browser: 'Browser Voice',
  twilio:  'Twilio Bridge',
  vobiz:   'Vobiz',
}

const CALL_TYPE_BADGE: Record<string, string> = {
  browser: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  twilio:  'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  vobiz:   'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
}

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
    const res = await fetch(`${backendUrl}/api/twilio/token`)
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

// ── Outbound Call Dialer ─────────────────────────────────────────────────────

function OutboundDialer() {
  const [phone, setPhone] = useState('')
  const [templateIdx, setTemplateIdx] = useState(1) // default Healthcare
  const [systemPrompt, setSystemPrompt] = useState(TEMPLATES[1].prompt)
  const [language, setLanguage] = useState('en')
  const [voice, setVoice] = useState('Aoede')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; msg: string }>({ kind: 'idle', msg: '' })

  const rawBackend = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
  const backendUrl = rawBackend && !rawBackend.includes('host.docker.internal')
    ? rawBackend
    : `${window.location.protocol}//${window.location.hostname}:8000`

  function handleTemplateChange(idx: number) {
    setTemplateIdx(idx)
    setSystemPrompt(TEMPLATES[idx].prompt)
  }

  function normalizePhone(raw: string): string | null {
    const digits = raw.replace(/[^\d]/g, '')
    if (!digits) return null
    // Indian default: 10 digits → prefix +91. Otherwise expect E.164.
    if (digits.length === 10) return '+91' + digits
    if (raw.trim().startsWith('+')) return '+' + digits
    if (digits.length > 10) return '+' + digits
    return null
  }

  async function placeCall() {
    setStatus({ kind: 'idle', msg: '' })
    const to = normalizePhone(phone)
    if (!to) {
      setStatus({ kind: 'error', msg: 'Enter a valid 10-digit Indian number or full E.164 (+91…)' })
      return
    }
    const token = localStorage.getItem('access_token') || ''
    setBusy(true)
    try {
      const res = await fetch(`${backendUrl}/api/vobiz/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ to, system_prompt: systemPrompt, language, voice }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body)
        setStatus({ kind: 'error', msg: detail || `Call failed (${res.status})` })
        return
      }
      setStatus({ kind: 'ok', msg: `Calling ${to}… (your phone should ring shortly)` })
    } catch (e) {
      setStatus({ kind: 'error', msg: (e as Error).message || 'Network error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-2xl flex flex-col gap-5 py-2">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center mx-auto mb-3 shadow-2xl">
          <Phone className="w-7 h-7 text-white" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Outbound Call</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Place a Vobiz call to any Indian number. The agent calls them and speaks via Gemini Live.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Phone number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            disabled={busy}
            placeholder="9876543210  or  +91 98765 43210"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary disabled:opacity-50"
          />
          <p className="text-[11px] text-muted-foreground mt-1">10-digit Indian numbers auto-prefix +91.</p>
        </div>

        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Agent</label>
          <div className="relative">
            <select
              value={templateIdx}
              onChange={e => handleTemplateChange(Number(e.target.value))}
              disabled={busy}
              className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground pr-8 focus:outline-none focus:border-primary disabled:opacity-50"
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
              disabled={busy}
              className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground pr-8 focus:outline-none focus:border-primary disabled:opacity-50"
            >
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          </div>
        </div>

        <div className="sm:col-span-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Voice</label>
          <div className="relative">
            <select
              value={voice}
              onChange={e => setVoice(e.target.value)}
              disabled={busy}
              className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground pr-8 focus:outline-none focus:border-primary disabled:opacity-50"
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

        <div className="sm:col-span-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
            Agent prompt (editable)
          </label>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            disabled={busy}
            className="w-full min-h-[140px] bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-xs text-foreground resize-y leading-relaxed focus:outline-none focus:border-primary disabled:opacity-50"
          />
        </div>
      </div>

      {status.kind !== 'idle' && (
        <div className={`rounded-xl px-4 py-3 text-sm border ${
          status.kind === 'ok'
            ? 'bg-green-500/10 border-green-500/25 text-green-700 dark:text-green-400'
            : 'bg-destructive/10 border-destructive/25 text-destructive'
        }`}>
          {status.msg}
        </div>
      )}

      <div className="flex justify-center">
        <button
          onClick={placeCall}
          disabled={busy || !phone.trim()}
          className="flex items-center gap-2 px-8 py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Phone className="w-5 h-5" />
          {busy ? 'Placing call…' : 'Call Now'}
        </button>
      </div>
    </div>
  )
}

// ── Calls List View ──────────────────────────────────────────────────────────

type CallSummary = {
  id: number
  call_type: string
  direction: string | null
  phone_number: string | null
  language: string | null
  voice: string | null
  status: string
  started_at: string | null
  ended_at: string | null
  duration_s: number | null
  turn_count: number
}

type CallDetail = CallSummary & {
  system_prompt: string | null
  transcript: { role: string; text: string; ts: string }[]
  error_message: string | null
}

function CallsView() {
  const [items, setItems] = useState<CallSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<CallDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/gemini-calls/`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      const body = await res.json()
      setItems(body.items || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function openCall(id: number) {
    setDetailLoading(true)
    try {
      const res = await fetch(`${backendBase()}/api/gemini-calls/${id}`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      setSelected(await res.json())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Calls</h1>
          <p className="text-sm text-muted-foreground">History of all Gemini Live calls with transcripts</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border bg-background hover:bg-muted transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="card flex-1 min-h-0 overflow-auto p-0">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card border-b border-border">
            <tr className="text-left text-muted-foreground text-xs uppercase tracking-wide">
              <th className="px-4 py-3 font-semibold">ID</th>
              <th className="px-4 py-3 font-semibold">Type</th>
              <th className="px-4 py-3 font-semibold">Direction</th>
              <th className="px-4 py-3 font-semibold">Phone</th>
              <th className="px-4 py-3 font-semibold">Started</th>
              <th className="px-4 py-3 font-semibold">Duration</th>
              <th className="px-4 py-3 font-semibold">Turns</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">No calls yet.</td></tr>
            ) : items.map(row => (
              <tr key={row.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">#{row.id}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${CALL_TYPE_BADGE[row.call_type] || 'bg-muted text-foreground border-border'}`}>
                    {CALL_TYPE_LABEL[row.call_type] || row.call_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground capitalize">{row.direction || '—'}</td>
                <td className="px-4 py-3 font-mono text-xs">{row.phone_number || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDateTime(row.started_at)}</td>
                <td className="px-4 py-3">{formatDuration(row.duration_s)}</td>
                <td className="px-4 py-3 text-center">{row.turn_count}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${
                    row.status === 'ended' ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                    : row.status === 'active' ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                    : 'bg-destructive/10 text-destructive'
                  }`}>
                    {row.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openCall(row.id)}
                    className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-muted transition-all"
                    title="View transcript"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Transcript drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="text-base font-bold text-foreground">Call #{selected.id} transcript</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {CALL_TYPE_LABEL[selected.call_type] || selected.call_type} · {formatDateTime(selected.started_at)} · {formatDuration(selected.duration_s)}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="w-8 h-8 rounded-lg border border-border hover:bg-muted flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-5 py-4 space-y-2">
              {selected.error_message && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2 text-xs text-destructive mb-3">
                  Error: {selected.error_message}
                </div>
              )}
              {selected.transcript.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No transcript captured.</p>
              ) : selected.transcript.map((t, i) => (
                <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                    t.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : 'bg-muted border border-border text-foreground rounded-bl-sm'
                  }`}>
                    <span className="block text-[10px] font-bold opacity-60 mb-0.5">
                      {t.role === 'user' ? 'User' : 'Gemini'}
                    </span>
                    {t.text}
                  </div>
                </div>
              ))}
            </div>
            {selected.system_prompt && (
              <details className="border-t border-border px-5 py-3 text-xs">
                <summary className="cursor-pointer font-semibold text-muted-foreground">System prompt</summary>
                <pre className="mt-2 whitespace-pre-wrap text-muted-foreground/80 max-h-32 overflow-auto">{selected.system_prompt}</pre>
              </details>
            )}
          </div>
        </div>
      )}
      {detailLoading && <div className="fixed bottom-4 right-4 bg-card border border-border rounded-lg px-3 py-2 text-sm shadow-lg">Loading transcript…</div>}
    </div>
  )
}

// ── Voices View ──────────────────────────────────────────────────────────────

function VoicesView() {
  const [playing, setPlaying] = useState<string | null>(null)
  const [loadingVoice, setLoadingVoice] = useState<string | null>(null)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  function genderLabel(g: string): string {
    return g === 'F' ? 'Female' : g === 'M' ? 'Male' : 'Neutral'
  }
  function genderBadge(g: string): string {
    if (g === 'F') return 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20'
    if (g === 'M') return 'bg-sky-500/10  text-sky-600  dark:text-sky-400  border-sky-500/20'
    return 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'
  }

  async function play(name: string) {
    setError('')
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (playing === name) { setPlaying(null); return }

    setLoadingVoice(name)
    try {
      const audio = new Audio(`${backendBase()}/api/voice-samples/${name}.wav`)
      audioRef.current = audio
      audio.onplaying = () => { setLoadingVoice(null); setPlaying(name) }
      audio.onended  = () => { setPlaying(null); audioRef.current = null }
      audio.onerror  = () => { setLoadingVoice(null); setPlaying(null); setError(`Failed to load sample for ${name}`) }
      await audio.play()
    } catch (e) {
      setLoadingVoice(null)
      setPlaying(null)
      setError((e as Error).message || 'Playback error')
    }
  }

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null }, [])

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">Voices</h1>
        <p className="text-sm text-muted-foreground">
          {VOICES.length} Gemini Live voices. Click <Play className="inline w-3.5 h-3.5 mx-0.5" /> to hear a sample (first play is generated on demand and cached).
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 overflow-auto pb-4">
        {VOICES.map(v => {
          const isPlaying = playing === v.name
          const isLoading = loadingVoice === v.name
          return (
            <div
              key={v.name}
              className={`card flex items-center gap-3 p-3 transition-all ${isPlaying ? 'ring-2 ring-primary' : ''}`}
            >
              <button
                onClick={() => play(v.name)}
                className={`w-11 h-11 flex-shrink-0 rounded-full flex items-center justify-center transition-all ${
                  isPlaying
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-primary/10 text-foreground hover:text-primary border border-border'
                }`}
                title={isPlaying ? 'Stop' : 'Play sample'}
              >
                {isLoading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : isPlaying ? <X className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm text-foreground truncate">{v.name}</span>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border ${genderBadge(v.gender)}`}>
                    {genderLabel(v.gender)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">{v.style}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

type Mode = 'browser' | 'phone' | 'outbound'
type View = 'home' | 'calls' | 'voices'

export default function GeminiPage() {
  const [view, setView] = useState<View>('home')
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
      <div className="flex h-[calc(100vh-3.5rem)] w-full">

        {/* ─── Sidebar ─── */}
        <aside className="w-56 flex-shrink-0 border-r border-border bg-card/40 flex flex-col py-4 px-3 gap-1">
          <div className="px-3 py-2 mb-2">
            <p className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Gemini Live</p>
          </div>
          <button
            onClick={() => setView('home')}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'home'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <Home className="w-4 h-4" />
            Home
          </button>
          <button
            onClick={() => { if (inCall) hangUp(); setView('calls') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'calls'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <ListVideo className="w-4 h-4" />
            Calls
          </button>
          <button
            onClick={() => { if (inCall) hangUp(); setView('voices') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'voices'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <Mic2 className="w-4 h-4" />
            Voices
          </button>
        </aside>

        {/* ─── Main content ─── */}
        {view === 'calls' ? <CallsView /> : view === 'voices' ? <VoicesView /> : (
        <div className="flex-1 px-6 py-6 flex flex-col gap-4 min-w-0">

        {/* Page header + mode switcher */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Gemini Live Voice</h1>
            <p className="text-sm text-muted-foreground">Real-time AI voice calls powered by Google Gemini</p>
          </div>
          <div className="flex items-center bg-muted p-1 rounded-lg border border-border gap-0.5">
            {(['browser', 'phone', 'outbound'] as const).map(m => (
              <button
                key={m}
                onClick={() => { if (inCall) hangUp(); setMode(m) }}
                className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-all ${
                  mode === m
                    ? 'bg-card text-foreground shadow-sm border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'browser' ? 'Browser Voice' : m === 'phone' ? 'Phone Bridge' : 'Outbound Call'}
              </button>
            ))}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex gap-6 min-h-0">

          {/* LEFT — config panel (only in browser mode) */}
          {mode === 'browser' && (
            <div className="w-[36rem] flex-shrink-0 flex flex-col gap-4">
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
            ) : mode === 'phone' ? (
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
            ) : (
              <div className="w-full flex flex-col items-center justify-start flex-1 overflow-y-auto">
                <OutboundDialer />
              </div>
            )}
          </div>
        </div>
        </div>
        )}
      </div>
    </Layout>
  )
}
