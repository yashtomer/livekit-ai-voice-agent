import { useState, useEffect, useRef, useCallback, type ComponentType, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../api/client'
import { Device, Call } from '@twilio/voice-sdk'
import { Phone, PhoneOff, Mic, MicOff, ChevronDown, Settings, Home, ListVideo, Eye, X, RefreshCw, Play, Loader2, Mic2, FileCode, ArrowRight, Globe, Cloud, Server, Cpu, PhoneCall, Wrench, Bot, Plus, Pencil, Trash2, Star, Lock, Webhook, FlaskConical, IndianRupee, Volume2, VolumeX, ArrowLeft, Music, BookOpen, FileText, Upload, Search, Database, BarChart3, Clock, TrendingUp, AlertTriangle } from 'lucide-react'
import Layout from '../components/Layout'
import useGeminiVoice, { type GeminiStatus } from '../hooks/useGeminiVoice'
import GeminiAvatar, { AVATARS, DEFAULT_AVATAR_URL, CAMERA_VIEWS, DEFAULT_CAMERA_VIEW, type CameraView } from '../components/GeminiAvatar'
import { useUIStore } from '../store/uiStore'

// ── Helpers ──────────────────────────────────────────────────────────────────

function backendBase(): string {
  const raw = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
  if (raw && !raw.includes('host.docker.internal')) return raw
  // Local dev: frontend on :3000, backend on :8000 → explicit port needed.
  // Production: nginx reverse-proxies /api/* on the same origin → no port.
  const h = window.location.hostname
  if (h === 'localhost' || h === '127.0.0.1') {
    return `${window.location.protocol}//${h}:8000`
  }
  return window.location.origin
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

/** Inline timeline chip for a tool/function call made by the agent. */
function ToolChip({ name, args, status, result }: {
  name?: string
  args?: Record<string, unknown> | null
  status?: string | null
  result?: unknown
}) {
  const argStr = args && Object.keys(args).length
    ? Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')
    : ''
  const ok = status == null || status === 'ok'
  return (
    <div className="flex justify-center my-1">
      <div className="max-w-[90%] flex items-start gap-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-700 dark:text-amber-300">
        <Wrench className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <div className="min-w-0">
          <span className="font-semibold font-mono">{name || 'tool'}</span>
          {argStr && <span className="opacity-70"> ({argStr})</span>}
          {status && !ok && <span className="ml-1 font-semibold text-destructive">· {status}</span>}
          {result != null && (
            <span className="block opacity-60 mt-0.5 break-all">
              → {typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Compact live caller-sentiment meter (positive ↔ negative + frustration cue). */
function SentimentMeter({ sentiment }: { sentiment: { label: string; score: number; frustration: number } | null }) {
  const score = sentiment?.score ?? 0
  const label = sentiment?.label ?? 'neutral'
  const frustrated = (sentiment?.frustration ?? 0) >= 0.5
  // Map score [-1,1] → marker position [0,100]%.
  const pos = Math.round(((score + 1) / 2) * 100)
  const color = label === 'positive' ? 'text-green-600 dark:text-green-400'
    : label === 'negative' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'
  return (
    <div className="flex items-center gap-2" title="Live caller sentiment (heuristic)">
      <span className={`text-[11px] font-semibold capitalize ${color}`}>
        {frustrated ? '😠 ' : label === 'positive' ? '🙂 ' : ''}{label}
      </span>
      <div className="relative w-24 h-2 rounded-full overflow-hidden" style={{ background: 'linear-gradient(to right, #ef4444, #f59e0b, #22c55e)' }}>
        <span
          className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-foreground rounded-full border border-card transition-all duration-500"
          style={{ left: `calc(${pos}% - 3px)` }}
        />
      </div>
    </div>
  )
}

type AgentTemplate = {
  label: string; prompt: string; voice?: string; language?: string; tool_ids?: number[]
  kb_collection_ids?: number[]
  ambient_always?: string | null; ambient_tool_call?: string | null; ambient_volume?: number
}

let _agentTemplatesCache: AgentTemplate[] | null = null

function useAgentTemplates(fallback: AgentTemplate[]): AgentTemplate[] {
  const [list, setList] = useState<AgentTemplate[]>(_agentTemplatesCache || fallback)
  useEffect(() => {
    let cancelled = false
    fetch(`${backendBase()}/api/agents/`)
      .then(r => r.ok ? r.json() : null)
      .then(body => {
        if (cancelled || !body) return
        const mapped: AgentTemplate[] = (body.items || []).map((a: Agent) => ({
          label: a.name, prompt: a.system_prompt, voice: a.voice, language: a.language,
          tool_ids: a.tool_ids || [],
          kb_collection_ids: a.kb_collection_ids || [],
          ambient_always: a.ambient_always, ambient_tool_call: a.ambient_tool_call,
          ambient_volume: a.ambient_volume,
        }))
        if (mapped.length) {
          _agentTemplatesCache = mapped
          setList(mapped)
        }
      })
      .catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [])
  return list
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

// ── Twilio Config Card ───────────────────────────────────────────────────────

type TwilioConfig = {
  public_host: string
  voice_webhook_url: string
  voice_webhook_method: string
  stream_ws_url: string
  twiml_app_sid: string | null
  phone_number: string | null
  missing_env: string[]
}

function TwilioConfigCard() {
  const [cfg, setCfg] = useState<TwilioConfig | null>(null)
  const [error, setError] = useState('')
  const [copiedField, setCopiedField] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${backendBase()}/api/twilio/config`)
      .then(r => r.json())
      .then(setCfg)
      .catch(e => setError((e as Error).message))
  }, [])

  function copy(field: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 1500)
    })
  }

  if (error) return <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">Failed to load Twilio config: {error}</div>
  if (!cfg)  return <div className="text-xs text-muted-foreground">Loading Twilio config…</div>

  const Row = ({ label, value, field, hint }: { label: string; value: string; field: string; hint?: string }) => (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all">
          {value}
        </code>
        <button
          onClick={() => copy(field, value)}
          className="px-3 py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium whitespace-nowrap"
        >
          {copiedField === field ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  )

  return (
    <div className="w-full card flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">Twilio Setup</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Paste these into your Twilio Console <strong>TwiML App</strong> &rarr; <em>Voice Configuration</em>.
        </p>
      </div>

      {cfg.missing_env.length > 0 && (
        <div className="bg-yellow-500/10 border border-yellow-500/25 rounded-lg px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
          Missing env vars on the backend: <code className="font-mono">{cfg.missing_env.join(', ')}</code>
        </div>
      )}

      {cfg.phone_number && (
        <div className="bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/25 rounded-xl px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
            <PhoneCall className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Call our agent</p>
            <a
              href={`tel:${cfg.phone_number}`}
              className="block text-xl font-bold font-mono text-foreground hover:underline mt-0.5"
            >
              {cfg.phone_number}
            </a>
            <p className="text-xs text-muted-foreground mt-1">
              Dial this Twilio number from any phone to talk to the AI voice agent live.
            </p>
          </div>
          <button
            onClick={() => copy('phone', cfg.phone_number!)}
            className="px-3 py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium whitespace-nowrap"
          >
            {copiedField === 'phone' ? 'Copied ✓' : 'Copy number'}
          </button>
        </div>
      )}

      <Row
        label="Voice Request URL"
        value={cfg.voice_webhook_url}
        field="voice"
        hint={`Method: ${cfg.voice_webhook_method}. This is where Twilio fetches TwiML when the call connects.`}
      />
      <Row
        label="Media Stream (WebSocket)"
        value={cfg.stream_ws_url}
        field="stream"
        hint="Set automatically by the TwiML response. You don't need to paste this — shown for reference."
      />

      {cfg.twiml_app_sid && (
        <div className="text-[11px] text-muted-foreground">
          Backend is configured for TwiML App SID <code className="font-mono">{cfg.twiml_app_sid}</code>.
        </div>
      )}
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
    : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? `${window.location.protocol}//${window.location.hostname}:8000`
        : window.location.origin)

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
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold transition-all shadow-lg active:scale-95"
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
  const templates = useAgentTemplates(TEMPLATES)
  const [phone, setPhone] = useState('')
  const [templateIdx, setTemplateIdx] = useState(0)
  const [systemPrompt, setSystemPrompt] = useState(templates[0]?.prompt || '')
  const [language, setLanguage] = useState(templates[0]?.language || 'en')
  const [voice, setVoice] = useState(templates[0]?.voice || 'Aoede')
  const [toolIds, setToolIds] = useState<number[]>(templates[0]?.tool_ids || [])
  const [kbCollectionIds, setKbCollectionIds] = useState<number[]>(templates[0]?.kb_collection_ids || [])
  const [ambientAlways, setAmbientAlways] = useState<string | null>(templates[0]?.ambient_always ?? null)
  const [ambientToolCall, setAmbientToolCall] = useState<string | null>(templates[0]?.ambient_tool_call ?? null)
  const [ambientVolume, setAmbientVolume] = useState<number>(templates[0]?.ambient_volume ?? 0.15)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; msg: string }>({ kind: 'idle', msg: '' })

  const rawBackend = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
  const backendUrl = rawBackend && !rawBackend.includes('host.docker.internal')
    ? rawBackend
    : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? `${window.location.protocol}//${window.location.hostname}:8000`
        : window.location.origin)

  function handleTemplateChange(idx: number) {
    setTemplateIdx(idx)
    const t = templates[idx]
    if (t) {
      setSystemPrompt(t.prompt)
      if (t.voice) setVoice(t.voice)
      if (t.language) setLanguage(t.language)
      setToolIds(t.tool_ids || [])
      setKbCollectionIds(t.kb_collection_ids || [])
      setAmbientAlways(t.ambient_always ?? null)
      setAmbientToolCall(t.ambient_tool_call ?? null)
      setAmbientVolume(t.ambient_volume ?? 0.15)
    }
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
        body: JSON.stringify({
          to, system_prompt: systemPrompt, language, voice, tool_ids: toolIds,
          kb_collection_ids: kbCollectionIds,
          ambient_always: ambientAlways, ambient_tool_call: ambientToolCall, ambient_volume: ambientVolume,
        }),
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
        <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center mx-auto mb-3 shadow-2xl">
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
              {templates.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
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
          className="flex items-center gap-2 px-8 py-3 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
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
  summary: string | null
  sentiment: string | null
}

type TranscriptItem = {
  role: string
  text?: string
  ts?: string
  // tool events
  name?: string
  args?: Record<string, unknown>
  result?: unknown
}

type CallDetail = CallSummary & {
  system_prompt: string | null
  transcript: TranscriptItem[]
  error_message: string | null
  extracted: Record<string, unknown> | unknown[] | null
}

const SENTIMENT_BADGE: Record<string, string> = {
  positive: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  neutral:  'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  negative: 'bg-destructive/10 text-destructive border-destructive/20',
}

const CALLS_PAGE_SIZE = 20

// ── Analytics Dashboard ──────────────────────────────────────────────────────

type CallStats = {
  total_calls: number
  ended_calls: number
  active_calls: number
  errored_calls: number
  avg_duration_s: number
  total_duration_s: number
  by_type: { key: string; count: number }[]
  by_language: { key: string; count: number }[]
  by_sentiment: Record<string, number>
  by_voice: { key: string; count: number }[]
  top_tools: { key: string; count: number }[]
  calls_by_day: { day: string; count: number }[]
}

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: ComponentType<{ className?: string }>; label: string; value: string; sub?: string; color: string
}) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">{label}</p>
        <p className="text-xl font-bold text-foreground leading-tight">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

/** Horizontal bar list — used for breakdowns by type/language/tool. */
function BarList({ title, data, labelMap }: {
  title: string; data: { key: string; count: number }[]; labelMap?: Record<string, string>
}) {
  const max = Math.max(1, ...data.map(d => d.count))
  return (
    <div className="card flex flex-col gap-3 p-4">
      <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">{title}</h3>
      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No data yet.</p>
      ) : data.map(d => (
        <div key={d.key} className="flex items-center gap-2">
          <span className="text-xs text-foreground w-28 truncate capitalize">{labelMap?.[d.key] || d.key}</span>
          <div className="flex-1 h-2.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full" style={{ width: `${(d.count / max) * 100}%` }} />
          </div>
          <span className="text-xs font-mono text-muted-foreground w-8 text-right">{d.count}</span>
        </div>
      ))}
    </div>
  )
}

function AnalyticsView() {
  const [stats, setStats] = useState<CallStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/gemini-calls/stats`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      setStats(await res.json())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const langMap = Object.fromEntries(LANGUAGES.map(l => [l.code, l.label]))
  const typeMap = CALL_TYPE_LABEL
  const sentiments = stats?.by_sentiment || {}
  const sentTotal = (sentiments.positive || 0) + (sentiments.neutral || 0) + (sentiments.negative || 0)
  const dayMax = Math.max(1, ...(stats?.calls_by_day || []).map(d => d.count))

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground">Aggregate insights across all Gemini Live calls</p>
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
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {!stats ? (
        <p className="text-sm text-muted-foreground py-10 text-center">{loading ? 'Loading…' : 'No data.'}</p>
      ) : (
        <>
          {/* Top stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={ListVideo} label="Total Calls" value={String(stats.total_calls)}
              sub={`${stats.ended_calls} ended · ${stats.active_calls} active`} color="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
            <StatCard icon={Clock} label="Avg Duration" value={formatDuration(stats.avg_duration_s)}
              sub={`${formatDuration(stats.total_duration_s)} total`} color="bg-violet-500/10 text-violet-600 dark:text-violet-400" />
            <StatCard icon={TrendingUp} label="Positive" value={`${sentTotal ? Math.round((sentiments.positive || 0) / sentTotal * 100) : 0}%`}
              sub={`${sentTotal} analysed`} color="bg-green-500/10 text-green-600 dark:text-green-400" />
            <StatCard icon={AlertTriangle} label="Errored" value={String(stats.errored_calls)}
              sub="failed sessions" color="bg-destructive/10 text-destructive" />
          </div>

          {/* Calls per day */}
          <div className="card flex flex-col gap-3 p-4">
            <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">Calls per day</h3>
            {stats.calls_by_day.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No data yet.</p>
            ) : (
              <div className="flex items-end gap-1.5 h-32">
                {stats.calls_by_day.map(d => (
                  <div key={d.day} className="flex-1 flex flex-col items-center justify-end gap-1 group" title={`${d.day}: ${d.count}`}>
                    <span className="text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100">{d.count}</span>
                    <div className="w-full bg-primary/80 rounded-t hover:bg-primary transition-all" style={{ height: `${(d.count / dayMax) * 100}%`, minHeight: 2 }} />
                    <span className="text-[8px] text-muted-foreground rotate-0 truncate w-full text-center">{d.day.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sentiment breakdown */}
          <div className="card flex flex-col gap-3 p-4">
            <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">Sentiment</h3>
            {sentTotal === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No analysed calls yet.</p>
            ) : (
              <>
                <div className="flex h-4 rounded-full overflow-hidden">
                  <div className="bg-green-500" style={{ width: `${(sentiments.positive || 0) / sentTotal * 100}%` }} />
                  <div className="bg-slate-400" style={{ width: `${(sentiments.neutral || 0) / sentTotal * 100}%` }} />
                  <div className="bg-destructive" style={{ width: `${(sentiments.negative || 0) / sentTotal * 100}%` }} />
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-500" /> Positive {sentiments.positive || 0}</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-slate-400" /> Neutral {sentiments.neutral || 0}</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-destructive" /> Negative {sentiments.negative || 0}</span>
                </div>
              </>
            )}
          </div>

          {/* Breakdown grids */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <BarList title="By channel" data={stats.by_type} labelMap={typeMap} />
            <BarList title="By language" data={stats.by_language} labelMap={langMap} />
            <BarList title="Top tools called" data={stats.top_tools} />
            <BarList title="By voice" data={stats.by_voice} />
          </div>
        </>
      )}
    </div>
  )
}

function CallsView() {
  const [items, setItems] = useState<CallSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<CallDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)

  const load = useCallback(async (pageArg: number) => {
    setLoading(true)
    setError('')
    try {
      const offset = pageArg * CALLS_PAGE_SIZE
      const res = await fetch(`${backendBase()}/api/gemini-calls/?limit=${CALLS_PAGE_SIZE}&offset=${offset}`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      const body = await res.json()
      setItems(body.items || [])
      setTotal(body.total ?? 0)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(page) }, [load, page])

  const pageCount = Math.max(1, Math.ceil(total / CALLS_PAGE_SIZE))
  const rangeStart = total === 0 ? 0 : page * CALLS_PAGE_SIZE + 1
  const rangeEnd = Math.min(total, (page + 1) * CALLS_PAGE_SIZE)

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
          onClick={() => load(page)}
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
              <th className="px-4 py-3 font-semibold">Sentiment</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-10 text-center text-muted-foreground">No calls yet.</td></tr>
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
                  {row.sentiment ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border capitalize ${SENTIMENT_BADGE[row.sentiment] || SENTIMENT_BADGE.neutral}`}>
                      {row.sentiment}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
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

      {/* Pagination footer */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs text-muted-foreground">
          {total === 0 ? 'No calls' : `Showing ${rangeStart}–${rangeEnd} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Prev
          </button>
          <span className="text-xs text-muted-foreground tabular-nums px-1">
            Page {page + 1} / {pageCount}
          </span>
          <button
            onClick={() => setPage(p => (p + 1 < pageCount ? p + 1 : p))}
            disabled={page + 1 >= pageCount || loading}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
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

              {/* AI post-call analysis */}
              {(selected.summary || selected.sentiment || selected.extracted) && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl px-4 py-3 mb-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-primary">AI Summary</span>
                    {selected.sentiment && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border capitalize ${SENTIMENT_BADGE[selected.sentiment] || SENTIMENT_BADGE.neutral}`}>
                        {selected.sentiment}
                      </span>
                    )}
                  </div>
                  {selected.summary && <p className="text-sm text-foreground leading-relaxed">{selected.summary}</p>}
                  {selected.extracted && typeof selected.extracted === 'object' && !Array.isArray(selected.extracted) && Object.keys(selected.extracted).length > 0 && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1">
                      {Object.entries(selected.extracted as Record<string, unknown>).map(([k, v]) => (
                        <div key={k} className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">{k.replace(/_/g, ' ')}</span>
                          <span className="text-xs text-foreground break-words">{v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {selected.transcript.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No transcript captured.</p>
              ) : selected.transcript.map((t, i) => (
                t.role === 'tool' ? (
                  <ToolChip key={i} name={t.name} args={t.args} result={t.result} />
                ) : (
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
                )
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

// ── Tech Specs View ──────────────────────────────────────────────────────────

type NodeColor = 'sky' | 'amber' | 'violet' | 'emerald' | 'rose' | 'slate'

const NODE_STYLES: Record<NodeColor, string> = {
  sky:     'bg-sky-500/10     border-sky-500/30     text-sky-700     dark:text-sky-300',
  amber:   'bg-amber-500/10   border-amber-500/30   text-amber-700   dark:text-amber-300',
  violet:  'bg-violet-500/10  border-violet-500/30  text-violet-700  dark:text-violet-300',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
  rose:    'bg-rose-500/10    border-rose-500/30    text-rose-700    dark:text-rose-300',
  slate:   'bg-slate-500/10   border-slate-500/30   text-slate-700   dark:text-slate-300',
}

function FlowNode({ icon: Icon, label, sub, color = 'slate' }: {
  icon: ComponentType<{ className?: string }>
  label: string
  sub?: string
  color?: NodeColor
}) {
  return (
    <div className={`flex flex-col items-center text-center px-4 py-4 rounded-2xl border-2 ${NODE_STYLES[color]} min-w-[140px] max-w-[180px] shadow-sm`}>
      <Icon className="w-7 h-7 mb-2" />
      <span className="text-sm font-bold leading-tight">{label}</span>
      {sub && <span className="text-[11px] opacity-70 mt-1 leading-tight">{sub}</span>}
    </div>
  )
}

/** Bidirectional connector between two nodes — shows both directions stacked. */
function FlowLink({ forward, backward }: { forward: string; backward?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-2 self-center min-w-[120px]">
      <div className="flex items-center gap-1 w-full">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-border to-border" />
        <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      </div>
      <span className="text-[10px] font-mono text-foreground/80 bg-muted px-2 py-0.5 rounded-full whitespace-nowrap">
        {forward}
      </span>
      {backward && (
        <>
          <span className="text-[10px] font-mono text-foreground/80 bg-muted px-2 py-0.5 rounded-full whitespace-nowrap">
            {backward}
          </span>
          <div className="flex items-center gap-1 w-full">
            <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0 rotate-180" />
            <div className="flex-1 h-px bg-gradient-to-l from-transparent via-border to-border" />
          </div>
        </>
      )}
    </div>
  )
}

/** A vertical branch below a node — used for side-channels like tool dispatch. */
function FlowBranch({ label, child }: { label: string; child: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 pt-2">
      <div className="w-px h-5 bg-border" />
      <span className="text-[10px] font-mono text-foreground/80 bg-muted px-2 py-0.5 rounded-full">{label}</span>
      <div className="w-px h-2 bg-border" />
      {child}
    </div>
  )
}

function SpecSection({
  title,
  subtitle,
  badge,
  badgeColor,
  diagram,
  steps,
  details,
}: {
  title: string
  subtitle: string
  badge: string
  badgeColor: string
  diagram: ReactNode
  steps: { title: string; body: string }[]
  details: { label: string; value: string }[]
}) {
  return (
    <div className="card flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border ${badgeColor}`}>
          {badge}
        </span>
      </div>

      <div className="bg-muted/20 border border-border rounded-xl p-5 overflow-x-auto">
        {diagram}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {steps.map((s, i) => (
          <div key={i} className="flex gap-3 p-3 rounded-lg bg-muted/30 border border-border">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">{i + 1}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">{s.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{s.body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 border-t border-border">
        {details.map((d, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">{d.label}</span>
            <span className="text-xs font-mono text-foreground break-all">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TechSpecsView() {
  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-6 overflow-y-auto">
      <div>
        <h1 className="text-xl font-bold text-foreground">Technical Architecture</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          How real-time voice flows from each entry point through Google's Gemini Live API and back.
        </p>
      </div>

      {/* ── Browser Voice ── */}
      <SpecSection
        title="Browser Voice"
        subtitle="Direct browser-to-Gemini WebSocket bridge — lowest latency, no telephony provider."
        badge="WEB"
        badgeColor="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
        diagram={
          <div className="flex flex-col items-center gap-2 min-w-fit">
            <div className="flex items-stretch justify-center flex-nowrap min-w-fit">
              <FlowNode icon={Globe} label="Browser" sub="Mic + Speaker" color="sky" />
              <FlowLink forward="→ PCM16 @ 16 kHz (mic)" backward="← PCM16 @ 24 kHz (speech)" />
              <FlowNode icon={Server} label="FastAPI" sub="/api/gemini/ws" color="violet" />
              <FlowLink forward="→ WebSocket (audio)" backward="← audio + tool_call" />
              <FlowNode icon={Cpu} label="Gemini Live" sub="WebSocket API" color="emerald" />
            </div>
            <FlowBranch
              label="tool_call ↓ ↑ send_tool_response"
              child={<FlowNode icon={Wrench} label="agent_tools.py" sub="get_doctors_by_department" color="amber" />}
            />
          </div>
        }
        steps={[
          { title: 'Capture mic audio',  body: 'Web Audio API captures the user\'s mic at 16 kHz, encodes Int16 PCM, and streams binary frames over WebSocket to /api/gemini/ws.' },
          { title: 'Authenticate session', body: 'Backend resolves the user\'s stored Google API key from the DB (fallback to server key for admins) and opens a Gemini Live session.' },
          { title: 'Stream to Gemini',  body: 'Each chunk is forwarded to Gemini\'s WebSocket via google-genai SDK. The session config sets voice, language, system prompt, and registered tools.' },
          { title: 'Receive audio',     body: 'Gemini streams back PCM16 @ 24 kHz. The backend relays each chunk to the browser as binary frames; the browser plays them through Web Audio.' },
          { title: 'Handle tool calls', body: 'If Gemini emits a tool_call, the backend dispatches it locally (e.g. get_doctors_by_department) and sends the structured response back so the model can continue.' },
          { title: 'Auto-reconnect',    body: 'Preview Gemini Live models drop ~1006 every ~1 turn. The backend silently reconnects without dropping the browser WebSocket — caller hears it as a brief pause.' },
        ]}
        details={[
          { label: 'Sample rate (in)',  value: '16 kHz PCM16' },
          { label: 'Sample rate (out)', value: '24 kHz PCM16' },
          { label: 'Transport',         value: 'WebSocket' },
          { label: 'Endpoint',          value: '/api/gemini/ws' },
        ]}
      />

      {/* ── Twilio Phone Bridge ── */}
      <SpecSection
        title="Twilio Phone Bridge"
        subtitle="Caller dials a Twilio number; Twilio streams audio to us; we relay to Gemini Live."
        badge="TWILIO"
        badgeColor="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20"
        diagram={
          <div className="flex flex-col items-center gap-6 min-w-fit">
            <div className="flex items-stretch justify-center flex-nowrap min-w-fit">
              <FlowNode icon={PhoneCall} label="Caller" sub="PSTN phone" color="sky" />
              <FlowLink forward="→ μ-law 8 kHz (voice)" backward="← μ-law 8 kHz (response)" />
              <FlowNode icon={Cloud} label="Twilio" sub="Media Streams" color="violet" />
              <FlowLink forward="→ WebSocket μ-law 8k" backward="← media events μ-law 8k" />
              <FlowNode icon={Server} label="FastAPI" sub="transcode + bridge" color="amber" />
              <FlowLink forward="→ PCM16 @ 16 kHz" backward="← PCM16 @ 24 kHz" />
              <FlowNode icon={Cpu} label="Gemini Live" color="emerald" />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground bg-muted/40 border border-dashed border-border rounded-lg px-3 py-2">
              <span className="font-bold uppercase tracking-wide text-foreground/70">Setup</span>
              <span>1. Caller dials Twilio number</span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>2. Twilio POSTs <code className="font-mono">/api/twilio/voice</code></span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>3. We reply with TwiML <code className="font-mono">&lt;Stream&gt;</code></span>
            </div>
            <FlowBranch
              label="tool_call ↕ on demand"
              child={<FlowNode icon={Wrench} label="agent_tools.py" sub="get_doctors_by_department" color="rose" />}
            />
          </div>
        }
        steps={[
          { title: 'Caller dials Twilio',  body: 'PSTN call hits a Twilio number provisioned in your TwiML App. Twilio HTTP-POSTs to our /api/twilio/voice with the call SID.' },
          { title: 'Respond with TwiML',   body: 'Backend returns a TwiML <Connect><Stream url="wss://…/api/twilio/stream"/></Connect> response, instructing Twilio to open a bidirectional media-streams WebSocket.' },
          { title: 'Audio transcoding',    body: 'Twilio Media Streams sends μ-law 8 kHz frames. We decode μ-law and resample to PCM16 @ 16 kHz before forwarding to Gemini. The reverse path resamples PCM16 24 kHz → μ-law 8 kHz.' },
          { title: 'Reconnect handling',   body: 'When Gemini\'s preview model drops the session, we transparently reopen it while keeping Twilio\'s WebSocket alive — the caller hears only a brief pause.' },
          { title: 'Tool dispatch',        body: 'Same agent_tools.py runs here as in browser mode. If Gemini asks for get_doctors_by_department, the backend resolves it inline and responds within the same session.' },
          { title: 'Call logging',         body: 'Each call is persisted to gemini_call_logs (type=twilio) with transcript fragments, start/end timestamps, and duration, visible under the Calls sidebar entry.' },
        ]}
        details={[
          { label: 'Caller audio',  value: 'μ-law 8 kHz' },
          { label: 'Gemini audio',  value: 'PCM16 16/24 kHz' },
          { label: 'Webhook',       value: '/api/twilio/voice' },
          { label: 'Media stream',  value: '/api/twilio/stream' },
        ]}
      />

      {/* ── Vobiz ── */}
      <SpecSection
        title="Vobiz (Plivo-compatible)"
        subtitle="Outbound or inbound calls via Vobiz; per-call config (prompt/voice/language) passed through the answer URL."
        badge="VOBIZ"
        badgeColor="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
        diagram={
          <div className="flex flex-col items-center gap-6 min-w-fit">
            <div className="flex items-stretch justify-center flex-nowrap min-w-fit">
              <FlowNode icon={PhoneCall} label="Recipient" sub="Indian mobile" color="sky" />
              <FlowLink forward="→ μ-law 8 kHz (voice)" backward="← μ-law 8 kHz (response)" />
              <FlowNode icon={Cloud} label="Vobiz" sub="Plivo-compatible" color="violet" />
              <FlowLink forward="→ WebSocket μ-law 8k" backward="← playAudio events" />
              <FlowNode icon={Server} label="FastAPI" sub="transcode + bridge" color="amber" />
              <FlowLink forward="→ PCM16 @ 16 kHz" backward="← PCM16 @ 24 kHz" />
              <FlowNode icon={Cpu} label="Gemini Live" color="emerald" />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground bg-muted/40 border border-dashed border-border rounded-lg px-3 py-2">
              <span className="font-bold uppercase tracking-wide text-foreground/70">Outbound setup</span>
              <span>1. Frontend POSTs <code className="font-mono">/api/vobiz/call</code></span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>2. Backend calls Vobiz REST <code className="font-mono">/Call/</code></span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>3. Vobiz dials; on answer hits our <code className="font-mono">answer_url?cfg=…</code></span>
            </div>
            <FlowBranch
              label="tool_call ↕ on demand"
              child={<FlowNode icon={Wrench} label="agent_tools.py" sub="get_doctors_by_department" color="rose" />}
            />
          </div>
        }
        steps={[
          { title: 'Outbound trigger',     body: 'Frontend POSTs /api/vobiz/call with phone + system_prompt + language + voice. Backend stashes the config under a short UUID and asks Vobiz to dial.' },
          { title: 'Recipient answers',    body: 'Vobiz hits our answer URL (with ?cfg=<id>). We return XML containing a <Stream> tag pointing to our WebSocket, with the cfg id baked into the URL.' },
          { title: 'Bidirectional stream', body: 'Vobiz opens a WebSocket to /api/vobiz/stream. We read the cfg, open a Gemini Live session with the requested prompt/voice/language, and start bridging audio.' },
          { title: 'Audio transcoding',    body: 'Vobiz μ-law 8 kHz ↔ Gemini PCM16 16/24 kHz, same pipeline as Twilio. Both directions use audioop.ratecv for high-quality resampling.' },
          { title: 'Tools + barge-in',     body: 'agent_tools.py executes locally on tool_call events. When the caller interrupts, Gemini emits sc.interrupted; we send a clearAudio event to Vobiz so playback flushes immediately.' },
          { title: 'Lifecycle + logging',  body: 'Calls auto-clean per-call configs after 1h. Every call is logged (type=vobiz, direction=outbound|inbound) with full transcript.' },
        ]}
        details={[
          { label: 'Provider',     value: 'Vobiz (Plivo-compat)' },
          { label: 'Answer URL',   value: '/api/vobiz/voice' },
          { label: 'Media stream', value: '/api/vobiz/stream' },
          { label: 'Outbound API', value: '/api/vobiz/call' },
        ]}
      />

      {/* ── Shared concepts ── */}
      <div className="card flex flex-col gap-3">
        <h2 className="text-lg font-bold text-foreground">Shared across all channels</h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-muted-foreground">
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Single tool registry</strong> — <code className="text-xs font-mono bg-muted/50 px-1 py-0.5 rounded">app/gemini/agent_tools.py</code> defines tools once; all three bridges import and dispatch the same functions.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Shared agent prompts</strong> — <code className="text-xs font-mono bg-muted/50 px-1 py-0.5 rounded">app/gemini/agents.py</code> centralises the Healthcare Booking persona so every channel speaks identically.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Transparent reconnects</strong> — preview-model 1006 closures auto-recover (~300 ms gap) without surfacing errors to the caller.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Unified logging</strong> — <code className="text-xs font-mono bg-muted/50 px-1 py-0.5 rounded">gemini_call_logs</code> stores call type, direction, transcript, duration, and status for every session.</span></li>
        </ul>
      </div>
    </div>
  )
}

// ── Tools View ───────────────────────────────────────────────────────────────

type ToolParam = { name: string; type: string; required: boolean; description: string }
type ToolResponseKey = { key: string; type: string; description: string }

type Tool = {
  id: number
  slug: string
  name: string
  description: string
  http_method: string
  url: string | null
  headers: Record<string, string>
  parameters: ToolParam[]
  response_schema: ToolResponseKey[]
  is_builtin: boolean
}

type ToolDraft = {
  name: string
  description: string
  http_method: string
  url: string
  headers: { key: string; value: string }[]
  parameters: ToolParam[]
  response_schema: ToolResponseKey[]
}

function emptyToolDraft(): ToolDraft {
  return {
    name: '', description: '', http_method: 'GET', url: '',
    headers: [], parameters: [], response_schema: [],
  }
}

function ToolsView() {
  const [items, setItems] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Tool | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<ToolDraft>(emptyToolDraft())
  const [saving, setSaving] = useState(false)
  const [testArgs, setTestArgs] = useState('{\n}')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch(`${backendBase()}/api/tools/`)
      if (!r.ok) throw new Error(`Failed: ${r.status}`)
      setItems((await r.json()).items || [])
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function startCreate() {
    setDraft(emptyToolDraft())
    setCreating(true); setTestResult(null)
  }
  function startEdit(t: Tool) {
    setDraft({
      name: t.name,
      description: t.description,
      http_method: t.http_method,
      url: t.url || '',
      headers: Object.entries(t.headers || {}).map(([key, value]) => ({ key, value })),
      parameters: [...t.parameters],
      response_schema: [...t.response_schema],
    })
    setEditing(t); setTestResult(null); setTestArgs('{\n}')
  }
  function closeModal() { setCreating(false); setEditing(null) }

  async function save() {
    setError('')
    if (!draft.name.trim() || !draft.description.trim()) {
      setError('Name and description are required.')
      return
    }
    if (!editing?.is_builtin && !draft.url.trim()) {
      setError('URL is required for non-builtin tools.')
      return
    }
    setSaving(true)
    try {
      const headers = Object.fromEntries(draft.headers.filter(h => h.key.trim()).map(h => [h.key.trim(), h.value]))
      const body: Record<string, unknown> = {
        description: draft.description,
        parameters: draft.parameters,
        response_schema: draft.response_schema,
        headers,
        // URL & method are editable on built-ins too — empty URL keeps the
        // Python implementation, any URL switches dispatch to HTTP.
        http_method: draft.http_method,
        url: draft.url,
      }
      if (!editing?.is_builtin) {
        body.name = draft.name
      }
      const url = editing ? `${backendBase()}/api/tools/${editing.id}` : `${backendBase()}/api/tools/`
      const method = editing ? 'PATCH' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Failed: ${res.status}`)
      }
      closeModal(); await load()
    } catch (e) { setError((e as Error).message) }
    finally { setSaving(false) }
  }

  async function remove(t: Tool) {
    if (!confirm(`Delete tool "${t.name}"?`)) return
    try {
      const res = await fetch(`${backendBase()}/api/tools/${t.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Failed: ${res.status}`)
      }
      await load()
    } catch (e) { setError((e as Error).message) }
  }

  async function runTest() {
    if (!editing) return
    setTesting(true); setTestResult(null)
    try {
      let args = {}
      try { args = JSON.parse(testArgs || '{}') } catch { throw new Error('Invalid JSON in args') }
      const res = await fetch(`${backendBase()}/api/tools/${editing.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args }),
      })
      const data = await res.json()
      setTestResult(JSON.stringify(data, null, 2))
    } catch (e) {
      setTestResult(`Error: ${(e as Error).message}`)
    } finally { setTesting(false) }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Tools</h1>
          <p className="text-sm text-muted-foreground">
            Define HTTP endpoints agents can call mid-conversation. Each tool's parameters and response keys are passed to Gemini so it knows when and how to call them.
          </p>
        </div>
        <button
          onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          New Tool
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 overflow-auto pb-4">
        {loading && items.length === 0 ? (
          <p className="col-span-full text-center text-muted-foreground py-10">Loading…</p>
        ) : items.length === 0 ? (
          <p className="col-span-full text-center text-muted-foreground py-10">No tools yet.</p>
        ) : items.map(t => (
          <div key={t.id} className="card flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Webhook className="w-5 h-5 text-primary flex-shrink-0" />
                <h3 className="font-bold text-foreground truncate">{t.name}</h3>
              </div>
              {t.is_builtin && (
                <span title="Built-in Python tool" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/25 flex-shrink-0">
                  <Lock className="w-3 h-3" /> BUILTIN
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
            {t.url ? (
              <div className="text-[11px] font-mono bg-muted/30 border border-border rounded-lg px-2.5 py-1.5">
                <span className="font-bold text-foreground">{t.http_method}</span>{' '}
                <span className="text-muted-foreground break-all">{t.url}</span>
              </div>
            ) : (
              <div className="text-[11px] font-mono text-muted-foreground italic">Python builtin (no HTTP)</div>
            )}
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span><span className="font-semibold text-foreground">{t.parameters.length}</span> param{t.parameters.length === 1 ? '' : 's'}</span>
              <span><span className="font-semibold text-foreground">{t.response_schema.length}</span> response key{t.response_schema.length === 1 ? '' : 's'}</span>
              <span className="font-mono opacity-50">#{t.slug}</span>
            </div>
            <div className="flex items-center gap-2 pt-1 border-t border-border">
              <button onClick={() => startEdit(t)} className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs font-medium">
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
              {!t.is_builtin && (
                <button onClick={() => remove(t)} className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10" title="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-bold text-foreground">{editing ? `Edit "${editing.name}"` : 'New Tool'}</h2>
              <button onClick={closeModal} className="w-8 h-8 rounded-lg border border-border hover:bg-muted flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Name</label>
                  <input type="text" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                    placeholder="e.g. Order Lookup" />
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">HTTP Method</label>
                  <div className="relative">
                    <select value={draft.http_method} onChange={e => setDraft({ ...draft, http_method: e.target.value })}
                      className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm pr-8 focus:outline-none focus:border-primary">
                      <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
                    </select>
                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  </div>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">URL</label>
                <input type="url" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                  placeholder="https://api.example.com/lookup" />
                {editing?.is_builtin && <p className="text-[11px] text-muted-foreground mt-1">Built-in tool: leave URL blank to keep using the Python implementation, or set a URL to switch this slug to HTTP dispatch.</p>}
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Description <span className="opacity-60 normal-case">(shown to the LLM — describe when to call this tool)</span></label>
                <textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} rows={3}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary resize-y" />
              </div>

              {/* Headers */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">HTTP Headers</label>
                  <button onClick={() => setDraft({ ...draft, headers: [...draft.headers, { key: '', value: '' }] })}
                    className="text-xs text-primary hover:underline">+ Add header</button>
                </div>
                {draft.headers.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No custom headers.</p>
                ) : draft.headers.map((h, i) => (
                  <div key={i} className="flex gap-2 mb-1.5">
                    <input value={h.key} placeholder="Header name" onChange={e => { const next = [...draft.headers]; next[i] = { ...next[i], key: e.target.value }; setDraft({ ...draft, headers: next }) }}
                      className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono" />
                    <input value={h.value} placeholder="Value" onChange={e => { const next = [...draft.headers]; next[i] = { ...next[i], value: e.target.value }; setDraft({ ...draft, headers: next }) }}
                      className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono" />
                    <button onClick={() => setDraft({ ...draft, headers: draft.headers.filter((_, j) => j !== i) })}
                      className="w-8 h-8 rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive flex items-center justify-center"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>

              {/* Parameters */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters <span className="opacity-60 normal-case">(what the agent sends)</span></label>
                  <button onClick={() => setDraft({ ...draft, parameters: [...draft.parameters, { name: '', type: 'string', required: false, description: '' }] })}
                    className="text-xs text-primary hover:underline">+ Add parameter</button>
                </div>
                {draft.parameters.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No parameters.</p>
                ) : draft.parameters.map((p, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 mb-1.5">
                    <input value={p.name} placeholder="param_name" onChange={e => { const n = [...draft.parameters]; n[i] = { ...n[i], name: e.target.value }; setDraft({ ...draft, parameters: n }) }}
                      className="col-span-3 bg-background border border-border rounded-lg px-2 py-1.5 text-xs font-mono" />
                    <select value={p.type} onChange={e => { const n = [...draft.parameters]; n[i] = { ...n[i], type: e.target.value }; setDraft({ ...draft, parameters: n }) }}
                      className="col-span-2 bg-background border border-border rounded-lg px-2 py-1.5 text-xs">
                      <option>string</option><option>number</option><option>integer</option><option>boolean</option>
                    </select>
                    <input value={p.description} placeholder="What this param means…" onChange={e => { const n = [...draft.parameters]; n[i] = { ...n[i], description: e.target.value }; setDraft({ ...draft, parameters: n }) }}
                      className="col-span-5 bg-background border border-border rounded-lg px-2 py-1.5 text-xs" />
                    <label className="col-span-1 inline-flex items-center gap-1 text-xs justify-center">
                      <input type="checkbox" checked={p.required} onChange={e => { const n = [...draft.parameters]; n[i] = { ...n[i], required: e.target.checked }; setDraft({ ...draft, parameters: n }) }} />
                      req
                    </label>
                    <button onClick={() => setDraft({ ...draft, parameters: draft.parameters.filter((_, j) => j !== i) })}
                      className="col-span-1 w-full h-full rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive flex items-center justify-center"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>

              {/* Response schema */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Response keys <span className="opacity-60 normal-case">(documented for the LLM)</span></label>
                  <button onClick={() => setDraft({ ...draft, response_schema: [...draft.response_schema, { key: '', type: 'string', description: '' }] })}
                    className="text-xs text-primary hover:underline">+ Add response key</button>
                </div>
                {draft.response_schema.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No documented response keys.</p>
                ) : draft.response_schema.map((r, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 mb-1.5">
                    <input value={r.key} placeholder="key_name" onChange={e => { const n = [...draft.response_schema]; n[i] = { ...n[i], key: e.target.value }; setDraft({ ...draft, response_schema: n }) }}
                      className="col-span-3 bg-background border border-border rounded-lg px-2 py-1.5 text-xs font-mono" />
                    <select value={r.type} onChange={e => { const n = [...draft.response_schema]; n[i] = { ...n[i], type: e.target.value }; setDraft({ ...draft, response_schema: n }) }}
                      className="col-span-2 bg-background border border-border rounded-lg px-2 py-1.5 text-xs">
                      <option>string</option><option>number</option><option>integer</option><option>boolean</option><option>array</option><option>object</option>
                    </select>
                    <input value={r.description} placeholder="What this key contains…" onChange={e => { const n = [...draft.response_schema]; n[i] = { ...n[i], description: e.target.value }; setDraft({ ...draft, response_schema: n }) }}
                      className="col-span-6 bg-background border border-border rounded-lg px-2 py-1.5 text-xs" />
                    <button onClick={() => setDraft({ ...draft, response_schema: draft.response_schema.filter((_, j) => j !== i) })}
                      className="col-span-1 w-full h-full rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive flex items-center justify-center"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>

              {/* Test runner (only for existing tools) */}
              {editing && (
                <details className="border border-border rounded-xl">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                    <FlaskConical className="w-3.5 h-3.5" /> Test this tool
                  </summary>
                  <div className="px-3 pb-3 pt-1 space-y-2">
                    <p className="text-[11px] text-muted-foreground">Send a JSON object of arguments. The response is what Gemini will receive.</p>
                    <textarea value={testArgs} onChange={e => setTestArgs(e.target.value)} rows={4}
                      className="w-full bg-muted/30 border border-border rounded-lg px-2.5 py-2 text-xs font-mono focus:outline-none focus:border-primary" />
                    <button onClick={runTest} disabled={testing}
                      className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5">
                      {testing && <Loader2 className="w-3 h-3 animate-spin" />} Run test
                    </button>
                    {testResult && (
                      <pre className="bg-muted/30 border border-border rounded-lg px-2.5 py-2 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">{testResult}</pre>
                    )}
                  </div>
                </details>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
              <button onClick={closeModal} className="px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium">Cancel</button>
              <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2">
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {editing ? 'Save changes' : 'Create tool'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Agents View ──────────────────────────────────────────────────────────────

type Agent = {
  id: number
  slug: string
  name: string
  description: string | null
  system_prompt: string
  language: string
  voice: string
  tool_ids: number[]
  kb_collection_ids: number[]
  ambient_always: string | null
  ambient_tool_call: string | null
  ambient_volume: number
  is_builtin: boolean
  is_default_phone: boolean
  created_at: string | null
  updated_at: string | null
}

type AgentDraft = {
  name: string
  description: string
  system_prompt: string
  language: string
  voice: string
  tool_ids: number[]
  kb_collection_ids: number[]
  ambient_always: string | null
  ambient_tool_call: string | null
  ambient_volume: number
}

function emptyDraft(): AgentDraft {
  return {
    name: '', description: '', system_prompt: '',
    language: 'en', voice: 'Aoede', tool_ids: [], kb_collection_ids: [],
    ambient_always: null, ambient_tool_call: null, ambient_volume: 0.15,
  }
}

type Ambience = { slug: string; label: string; category: string; description: string }

function AgentsView() {
  const [items, setItems] = useState<Agent[]>([])
  const [allTools, setAllTools] = useState<Tool[]>([])
  const [ambience, setAmbience] = useState<Ambience[]>([])
  const [kbCollections, setKbCollections] = useState<KbCollection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Agent | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft())

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [a, t, amb, kb] = await Promise.all([
        fetch(`${backendBase()}/api/agents/`).then(r => r.ok ? r.json() : Promise.reject(`agents ${r.status}`)),
        fetch(`${backendBase()}/api/tools/`).then(r => r.ok ? r.json() : Promise.reject(`tools ${r.status}`)),
        fetch(`${backendBase()}/api/ambience/`).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
        fetch(`${backendBase()}/api/kb/collections`).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
      ])
      setItems(a.items || [])
      setAllTools(t.items || [])
      setAmbience(amb.items || [])
      setKbCollections(kb.items || [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function startCreate() {
    setDraft(emptyDraft())
    setCreating(true)
  }

  function startEdit(a: Agent) {
    setDraft({
      name: a.name,
      description: a.description || '',
      system_prompt: a.system_prompt,
      language: a.language,
      voice: a.voice,
      tool_ids: [...(a.tool_ids || [])],
      kb_collection_ids: [...(a.kb_collection_ids || [])],
      ambient_always: a.ambient_always,
      ambient_tool_call: a.ambient_tool_call,
      ambient_volume: a.ambient_volume ?? 0.15,
    })
    setEditing(a)
  }

  function toggleTool(id: number) {
    setDraft((d: AgentDraft) => ({
      ...d,
      tool_ids: d.tool_ids.includes(id) ? d.tool_ids.filter((x: number) => x !== id) : [...d.tool_ids, id],
    }))
  }

  function toggleKb(id: number) {
    setDraft((d: AgentDraft) => ({
      ...d,
      kb_collection_ids: d.kb_collection_ids.includes(id) ? d.kb_collection_ids.filter((x: number) => x !== id) : [...d.kb_collection_ids, id],
    }))
  }

  function closeEditor() {
    setCreating(false)
    setEditing(null)
  }

  async function save() {
    setError('')
    if (!draft.name.trim() || !draft.system_prompt.trim()) {
      setError('Name and system prompt are required.')
      return
    }
    setSaving(true)
    try {
      const url = editing ? `${backendBase()}/api/agents/${editing.id}` : `${backendBase()}/api/agents/`
      const method = editing ? 'PATCH' : 'POST'
      const body = editing
        ? {
            description: draft.description,
            system_prompt: draft.system_prompt,
            language: draft.language,
            voice: draft.voice,
            tool_ids: draft.tool_ids,
            kb_collection_ids: draft.kb_collection_ids,
            ambient_always: draft.ambient_always,
            ambient_tool_call: draft.ambient_tool_call,
            ambient_volume: draft.ambient_volume,
            ...(editing.is_builtin ? {} : { name: draft.name }),
          }
        : draft
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Failed: ${res.status}`)
      }
      closeEditor()
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(a: Agent) {
    if (!confirm(`Delete agent "${a.name}"? This cannot be undone.`)) return
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/agents/${a.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Failed: ${res.status}`)
      }
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function makeDefault(a: Agent) {
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/agents/${a.id}/default-phone`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Failed: ${res.status}`)
      }
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ─── Full-page editor (replaces the list when creating/editing) ───
  if (creating || editing) {
    return (
      <AgentEditor
        editing={editing}
        draft={draft}
        setDraft={setDraft}
        allTools={allTools}
        ambience={ambience}
        kbCollections={kbCollections}
        toggleTool={toggleTool}
        toggleKb={toggleKb}
        saving={saving}
        error={error}
        onCancel={closeEditor}
        onSave={save}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Manage system prompts shared by browser voice, Twilio bridge, and Vobiz. The agent marked <Star className="inline w-3.5 h-3.5 fill-current text-yellow-500" /> is used for inbound phone calls.
          </p>
        </div>
        <button
          onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          New Agent
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 overflow-auto pb-4">
        {loading && items.length === 0 ? (
          <p className="col-span-full text-center text-muted-foreground py-10">Loading…</p>
        ) : items.length === 0 ? (
          <p className="col-span-full text-center text-muted-foreground py-10">No agents yet.</p>
        ) : items.map(a => (
          <div key={a.id} className={`card flex flex-col gap-3 ${a.is_default_phone ? 'ring-2 ring-yellow-500/40' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Bot className="w-5 h-5 text-primary flex-shrink-0" />
                <h3 className="font-bold text-foreground truncate">{a.name}</h3>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {a.is_default_phone && (
                  <span title="Default phone agent" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border border-yellow-500/25">
                    <Star className="w-3 h-3 fill-current" /> PHONE
                  </span>
                )}
                {a.is_builtin && (
                  <span title="Built-in agent" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/25">
                    <Lock className="w-3 h-3" /> BUILTIN
                  </span>
                )}
              </div>
            </div>

            {a.description && <p className="text-xs text-muted-foreground line-clamp-2">{a.description}</p>}

            <div className="text-xs font-mono bg-muted/30 border border-border rounded-lg px-2.5 py-2 max-h-24 overflow-y-auto text-foreground/80 whitespace-pre-wrap leading-relaxed">
              {a.system_prompt.slice(0, 200)}{a.system_prompt.length > 200 ? '…' : ''}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span><span className="font-semibold text-foreground">Voice:</span> {a.voice}</span>
              <span><span className="font-semibold text-foreground">Lang:</span> {a.language}</span>
              <span className="font-mono opacity-50">#{a.slug}</span>
            </div>

            <div className="flex items-center gap-2 pt-1 border-t border-border">
              <button
                onClick={() => startEdit(a)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-xs font-medium"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
              {!a.is_default_phone && (
                <button
                  onClick={() => makeDefault(a)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-yellow-500/40 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-500/10 text-xs font-medium"
                  title="Use as default for inbound phone calls"
                >
                  <Star className="w-3.5 h-3.5" />
                  Set default
                </button>
              )}
              {!a.is_builtin && (
                <button
                  onClick={() => remove(a)}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}

// ── Agent editor (full-page, replaces the agents list while open) ────────────

type AgentEditorProps = {
  editing: Agent | null
  draft: AgentDraft
  setDraft: (d: AgentDraft | ((p: AgentDraft) => AgentDraft)) => void
  allTools: Tool[]
  ambience: Ambience[]
  kbCollections: KbCollection[]
  toggleTool: (id: number) => void
  toggleKb: (id: number) => void
  saving: boolean
  error: string
  onCancel: () => void
  onSave: () => void
}

function AmbiencePicker({ label, hint, value, volume, options, onChange }: {
  label: string
  hint: string
  value: string | null
  volume: number
  options: Ambience[]
  onChange: (slug: string | null) => void
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)

  // Keep any in-flight preview in sync with live volume changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume))
  }, [volume])

  function previewSlug(slug: string) {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (previewing === slug) {
      setPreviewing(null)
      return
    }
    const audio = new Audio(`${backendBase()}/api/ambience/preview/${slug}.wav`)
    audio.volume = Math.max(0, Math.min(1, volume))
    audioRef.current = audio
    audio.onended = () => { setPreviewing(null); audioRef.current = null }
    audio.onerror = () => { setPreviewing(null); audioRef.current = null }
    setPreviewing(slug)
    audio.play().catch(() => setPreviewing(null))
  }

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null }, [])

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground block">{label}</label>
        <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-xs font-medium transition-all ${
            value == null
              ? 'bg-primary/10 border-primary/30 text-foreground'
              : 'border-border hover:bg-muted/50 text-muted-foreground'
          }`}
        >
          <VolumeX className="w-3.5 h-3.5 flex-shrink-0" />
          <span>None (silent)</span>
        </button>
        {options.map(o => {
          const selected = value === o.slug
          const playing = previewing === o.slug
          return (
            <div
              key={o.slug}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left text-xs transition-all ${
                selected ? 'bg-primary/10 border-primary/30' : 'border-border hover:bg-muted/40'
              }`}
            >
              <button
                type="button"
                onClick={() => onChange(o.slug)}
                className="flex-1 min-w-0 flex items-center gap-2"
                title={o.description}
              >
                <Music className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <span className="font-semibold text-foreground truncate">{o.label}</span>
              </button>
              <button
                type="button"
                onClick={() => previewSlug(o.slug)}
                className={`w-7 h-7 flex-shrink-0 rounded-md border flex items-center justify-center transition-all ${
                  playing
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border hover:bg-muted text-muted-foreground'
                }`}
                title={playing ? 'Stop preview' : 'Preview'}
              >
                {playing ? <X className="w-3.5 h-3.5" /> : <Play className="w-3 h-3 ml-0.5" />}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AgentEditor({ editing, draft, setDraft, allTools, ambience, kbCollections, toggleTool, toggleKb, saving, error, onCancel, onSave }: AgentEditorProps) {
  const alwaysOptions   = ambience.filter(a => a.category === 'always' || a.category === 'both')
  const toolCallOptions = ambience.filter(a => a.category === 'tool_call' || a.category === 'both')

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onCancel}
            className="w-9 h-9 rounded-lg border border-border hover:bg-muted flex items-center justify-center flex-shrink-0"
            title="Back to agents"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-foreground truncate">
              {editing ? `Edit "${editing.name}"` : 'New Agent'}
            </h1>
            <p className="text-xs text-muted-foreground">
              {editing
                ? <>Updating <code className="font-mono">#{editing.slug}</code></>
                : 'Configure prompt, voice, tools, and background ambience'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {editing ? 'Save changes' : 'Create agent'}
          </button>
        </div>
      </div>

      <div className="px-6 py-5 max-w-5xl w-full mx-auto flex flex-col gap-5">
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ─── Basics ─── */}
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Basics</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Name</label>
              <input
                type="text"
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                disabled={editing?.is_builtin}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary disabled:opacity-50"
                placeholder="e.g. Pizza Order Taker"
              />
              {editing?.is_builtin && <p className="text-[11px] text-muted-foreground mt-1">Name is locked for built-in agents.</p>}
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Description</label>
              <input
                type="text"
                value={draft.description}
                onChange={e => setDraft({ ...draft, description: e.target.value })}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                placeholder="Short one-liner shown on the agent card"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Language</label>
              <div className="relative">
                <select
                  value={draft.language}
                  onChange={e => setDraft({ ...draft, language: e.target.value })}
                  className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm pr-8 focus:outline-none focus:border-primary"
                >
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Voice</label>
              <div className="relative">
                <select
                  value={draft.voice}
                  onChange={e => setDraft({ ...draft, voice: e.target.value })}
                  className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm pr-8 focus:outline-none focus:border-primary"
                >
                  {VOICES.map(v => <option key={v.name} value={v.name}>{v.name} ({v.gender}) — {v.style}</option>)}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          </div>
        </section>

        {/* ─── System prompt ─── */}
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">System Prompt</h2>
          <textarea
            value={draft.system_prompt}
            onChange={e => setDraft({ ...draft, system_prompt: e.target.value })}
            rows={14}
            className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:border-primary resize-y"
            placeholder="You are a helpful assistant…"
          />
        </section>

        {/* ─── Tools ─── */}
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">
            Tools <span className="text-[11px] font-normal text-muted-foreground normal-case ml-1">({draft.tool_ids.length} selected — Gemini decides when to call them)</span>
          </h2>
          {allTools.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No tools defined yet. Create some in the Tools tab.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {allTools.map((t: Tool) => {
                const checked = draft.tool_ids.includes(t.id)
                return (
                  <label key={t.id}
                    className={`flex items-start gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-all border ${
                      checked ? 'bg-primary/10 border-primary/30' : 'border-border hover:bg-muted/40'
                    }`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleTool(t.id)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Webhook className="w-3 h-3 text-primary flex-shrink-0" />
                        <span className="text-xs font-bold text-foreground truncate">{t.name}</span>
                        {t.is_builtin && <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400">BUILTIN</span>}
                      </div>
                      <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{t.description}</p>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </section>

        {/* ─── Knowledge bases ─── */}
        <section className="card flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-foreground flex items-center gap-2">
              <BookOpen className="w-4 h-4" /> Knowledge Bases
              <span className="text-[11px] font-normal text-muted-foreground normal-case ml-1">
                ({draft.kb_collection_ids.length} selected — the agent can search these during calls)
              </span>
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              When at least one is selected, a <code className="font-mono">search_knowledge_base</code> tool is auto-enabled for this agent.
            </p>
          </div>
          {kbCollections.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No knowledge bases yet. Create one in the Knowledge Base tab.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {kbCollections.map((c: KbCollection) => {
                const checked = draft.kb_collection_ids.includes(c.id)
                return (
                  <label key={c.id}
                    className={`flex items-start gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-all border ${
                      checked ? 'bg-primary/10 border-primary/30' : 'border-border hover:bg-muted/40'
                    }`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleKb(c.id)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Database className="w-3 h-3 text-primary flex-shrink-0" />
                        <span className="text-xs font-bold text-foreground truncate">{c.name}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{c.document_count} docs · {c.chunk_count} chunks</p>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </section>

        {/* ─── Background ambience ─── */}
        <section className="card flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wide text-foreground flex items-center gap-2">
                <Volume2 className="w-4 h-4" /> Background Ambience
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Mixed into the agent's outgoing audio (browser, Twilio, Vobiz). Click <Play className="inline w-3 h-3 mx-0.5" /> to preview.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Volume</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={draft.ambient_volume}
                onChange={e => setDraft({ ...draft, ambient_volume: parseFloat(e.target.value) })}
                className="w-40 accent-primary"
              />
              <span className="text-xs font-mono text-foreground w-10 text-right">{Math.round(draft.ambient_volume * 100)}%</span>
            </div>
          </div>

          <AmbiencePicker
            label="Always-on ambience"
            hint="Plays softly under the entire conversation (e.g. office hum, cafe)."
            value={draft.ambient_always}
            volume={draft.ambient_volume}
            options={alwaysOptions}
            onChange={slug => setDraft({ ...draft, ambient_always: slug })}
          />

          <AmbiencePicker
            label="During tool calls"
            hint="Plays only while the agent is dispatching a tool (e.g. typing, mouse clicks)."
            value={draft.ambient_tool_call}
            volume={draft.ambient_volume}
            options={toolCallOptions}
            onChange={slug => setDraft({ ...draft, ambient_tool_call: slug })}
          />
        </section>
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

type Mode = 'browser' | 'phone' | 'outbound'
// ── Costing View ─────────────────────────────────────────────────────────────

function CostingField({ label, value, onChange, step = 1, min = 0, suffix }: {
  label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; suffix?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={min}
          step={step}
          onChange={e => onChange(Number(e.target.value) || 0)}
          className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
        />
        {suffix && <span className="text-xs text-muted-foreground whitespace-nowrap">{suffix}</span>}
      </div>
    </div>
  )
}

function CostingView() {
  const { data: fxData } = useQuery({
    queryKey: ['fx-rate'],
    queryFn: () => api.get('/fx-rate').then(r => r.data),
    staleTime: 3_600_000,
  })

  const [hoursPerDay, setHoursPerDay] = useState(2)
  const [daysPerMonth, setDaysPerMonth] = useState(30)
  const [geminiUsdPerMin, setGeminiUsdPerMin] = useState(0.03)
  const [telephonyInrPerMin, setTelephonyInrPerMin] = useState(0.5)
  const [usdToInr, setUsdToInr] = useState(83)
  const [fxOverridden, setFxOverridden] = useState(false)
  const [includeTelephony, setIncludeTelephony] = useState(false)

  // Adopt the live FX rate from the navbar query unless the user has manually overridden.
  useEffect(() => {
    if (!fxOverridden && fxData?.rate > 0) {
      setUsdToInr(fxData.rate)
    }
  }, [fxData, fxOverridden])

  const minutesPerMonth = hoursPerDay * 60 * daysPerMonth
  const geminiInrPerMin = geminiUsdPerMin * usdToInr
  const perMinInr = geminiInrPerMin + (includeTelephony ? telephonyInrPerMin : 0)
  const monthlyInr = perMinInr * minutesPerMonth
  const dailyInr = perMinInr * hoursPerDay * 60

  const fmtInr = (n: number) =>
    new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n))

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4 overflow-y-auto">
      <div>
        <h1 className="text-xl font-bold text-foreground">Costing</h1>
        <p className="text-sm text-muted-foreground">
          Estimate monthly cost of the voice agent in Indian rupees based on daily usage.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card flex flex-col gap-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Usage</h2>
          <div className="grid grid-cols-2 gap-3">
            <CostingField label="Hours / day" value={hoursPerDay} onChange={setHoursPerDay} step={0.5} suffix="hrs" />
            <CostingField label="Days / month" value={daysPerMonth} onChange={setDaysPerMonth} step={1} suffix="days" />
          </div>

          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground mt-2">Rates</h2>
          <div className="grid grid-cols-2 gap-3">
            <CostingField label="Gemini Live" value={geminiUsdPerMin} onChange={setGeminiUsdPerMin} step={0.01} suffix="$ / min" />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center justify-between">
                <span>USD → INR</span>
                {fxOverridden && (
                  <button
                    type="button"
                    onClick={() => { setFxOverridden(false); if (fxData?.rate > 0) setUsdToInr(fxData.rate) }}
                    className="text-[10px] font-semibold text-primary hover:underline normal-case tracking-normal"
                  >
                    use live
                  </button>
                )}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={usdToInr}
                  min={0}
                  step={0.5}
                  onChange={e => { setFxOverridden(true); setUsdToInr(Number(e.target.value) || 0) }}
                  className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                />
                <span className="text-xs text-muted-foreground whitespace-nowrap">₹</span>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {fxOverridden
                  ? 'Manual override'
                  : fxData?.rate > 0
                    ? <>Live rate from navbar{fxData?.date ? ` · ${fxData.date}` : ''}</>
                    : 'Loading live rate…'}
              </span>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground mt-1">
            <input
              type="checkbox"
              checked={includeTelephony}
              onChange={e => setIncludeTelephony(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            Include telephony (Twilio / Vobiz)
          </label>
          {includeTelephony && (
            <CostingField label="Telephony" value={telephonyInrPerMin} onChange={setTelephonyInrPerMin} step={0.1} suffix="₹ / min" />
          )}

          <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
            Default Gemini Live rate ≈ $0.03 / min (native-audio model: $3/M input + $12/M output tokens at ~32 tok/sec each way).
            Telephony optional; browser-voice has no per-minute charge.
          </p>
        </div>

        <div className="card flex flex-col gap-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Estimate</h2>

          <div className="bg-primary/10 border border-primary/20 rounded-xl p-5 flex flex-col items-center gap-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Monthly cost</span>
            <span className="text-4xl font-bold text-primary flex items-center">
              <IndianRupee className="w-7 h-7" />
              {fmtInr(monthlyInr)}
            </span>
            <span className="text-xs text-muted-foreground">
              per month
              {usdToInr > 0 && <> · ≈ ${(monthlyInr / usdToInr).toLocaleString('en-US', { maximumFractionDigits: 2 })}</>}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/40 border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Per day</div>
              <div className="text-lg font-bold text-foreground">₹{fmtInr(dailyInr)}</div>
              {usdToInr > 0 && <div className="text-[11px] font-medium text-muted-foreground/70">≈ ${(dailyInr / usdToInr).toFixed(2)}</div>}
            </div>
            <div className="bg-muted/40 border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Per minute</div>
              <div className="text-lg font-bold text-foreground">₹{perMinInr.toFixed(2)}</div>
              {usdToInr > 0 && <div className="text-[11px] font-medium text-muted-foreground/70">≈ ${(perMinInr / usdToInr).toFixed(3)}</div>}
            </div>
            <div className="bg-muted/40 border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Minutes / month</div>
              <div className="text-lg font-bold text-foreground">{minutesPerMonth.toLocaleString('en-IN')}</div>
            </div>
            <div className="bg-muted/40 border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Gemini rate</div>
              <div className="text-lg font-bold text-foreground">₹{geminiInrPerMin.toFixed(2)} / min</div>
              {usdToInr > 0 && <div className="text-[11px] font-medium text-muted-foreground/70">≈ ${(geminiInrPerMin / usdToInr).toFixed(3)} / min</div>}
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground border-t border-border pt-3 leading-relaxed">
            Formula: <code className="font-mono">hours/day × 60 × days/month × (gemini ₹/min{includeTelephony ? ' + telephony ₹/min' : ''})</code>.
            Adjust rates above to match your actual contract.
          </div>
        </div>
      </div>

      {/* ── Pricing breakdown ────────────────────────────────────────── */}
      <div className="card flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-base font-bold text-foreground">Pricing Breakdown</h2>
            <p className="text-sm text-muted-foreground mt-0.5">How the $0.03/min default is derived, and where the real cost can drift.</p>
          </div>
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
            ACTIVE MODEL
          </span>
        </div>

        {/* Current model card */}
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span className="text-xs uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-400">Currently in use</span>
          </div>
          <code className="font-mono text-sm text-foreground font-bold block">gemini-3.1-flash-live-preview</code>
          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
            Native-audio preview model. Used by the browser (<code className="font-mono text-[11px]">/api/gemini/ws</code>) and Twilio bridge (<code className="font-mono text-[11px]">/api/twilio/stream</code>).
            Override via <code className="font-mono text-[11px]">GEMINI_LIVE_MODEL</code> env var.
          </p>
        </div>

        {/* Token rates table */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Official Google Pricing (per 1M tokens, USD)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
              <thead className="bg-muted/50">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Model</th>
                  <th className="px-3 py-2 font-semibold text-right">Audio In</th>
                  <th className="px-3 py-2 font-semibold text-right">Audio Out</th>
                  <th className="px-3 py-2 font-semibold text-right">Text In</th>
                  <th className="px-3 py-2 font-semibold text-right">Text Out</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                <tr className="border-t border-border bg-emerald-500/5">
                  <td className="px-3 py-2 font-bold">gemini-3.1-flash-live-preview <span className="text-[10px] font-sans uppercase tracking-wide text-emerald-600 ml-1">active</span></td>
                  <td className="px-3 py-2 text-right">$3.00</td>
                  <td className="px-3 py-2 text-right">$12.00</td>
                  <td className="px-3 py-2 text-right">$0.50</td>
                  <td className="px-3 py-2 text-right">$2.00</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Rates as published on ai.google.dev/pricing for preview Live models. Preview pricing can change without notice — verify before locking commercial pricing.
          </p>
        </div>

        {/* Math */}
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">How $0.03 / min is computed</h3>
          <div className="bg-muted/30 border border-border rounded-lg p-4 text-xs font-mono leading-relaxed">
            <div className="text-muted-foreground mb-2 font-sans italic">Assumes continuous audio in + out, ~32 audio tokens / second per direction:</div>
            <div>input  = 60 s × 32 tok/s × $3 / 1,000,000 = <span className="text-foreground font-bold">$0.00576</span></div>
            <div>output = 60 s × 32 tok/s × $12 / 1,000,000 = <span className="text-foreground font-bold">$0.02304</span></div>
            <div className="border-t border-border mt-2 pt-2">
              total  = $0.00576 + $0.02304 ≈ <span className="text-primary font-bold">$0.029 / min</span> ≈ ₹{(0.029 * usdToInr).toFixed(2)} / min (at ₹{usdToInr}/$)
            </div>
          </div>
        </div>

        {/* What's included / not included */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3">
            <h4 className="text-xs font-bold uppercase tracking-wide text-green-700 dark:text-green-400 mb-2">✓ Included in the estimate</h4>
            <ul className="text-xs text-foreground space-y-1.5 leading-relaxed">
              <li>• Real-time audio input (your speech → Gemini)</li>
              <li>• Real-time audio output (Gemini → speaker)</li>
              <li>• Optional telephony per-minute charge (Twilio / Vobiz)</li>
            </ul>
          </div>
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
            <h4 className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-2">⚠ Not included (extras)</h4>
            <ul className="text-xs text-foreground space-y-1.5 leading-relaxed">
              <li>• System prompt re-billed as text on each turn</li>
              <li>• Tool/function-call payloads (text in + text out)</li>
              <li>• Voice-sample WAV generation (one-off, cached)</li>
              <li>• Server hosting, bandwidth, database, storage</li>
            </ul>
          </div>
        </div>

        {/* Reality check */}
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
          <h4 className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-400 mb-2">Why your actual bill may differ</h4>
          <ul className="text-xs text-foreground space-y-1.5 leading-relaxed">
            <li><strong>Silence / turn-taking:</strong> real conversations bill ~40–60% of wall-clock audio in each direction, not 100% — actual cost is often <em>lower</em> than $0.03/min.</li>
            <li><strong>Long system prompts:</strong> a 2,000-token prompt re-sent on each turn adds noticeable text-input cost over a long call.</li>
            <li><strong>Tool calls:</strong> function definitions + arguments + responses are billed as text I/O.</li>
            <li><strong>Preview repricing:</strong> the <code className="font-mono text-[11px]">3.1-flash-live-preview</code> rate is preview-tier; expect it to change at GA.</li>
            <li><strong>Currency:</strong> Google bills in USD — your INR cost moves with FX. Default ₹{usdToInr}/$ here.</li>
          </ul>
        </div>

        <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
          Source: <code className="font-mono">ai.google.dev/gemini-api/docs/pricing</code> · model in use is set in <code className="font-mono">backend/app/gemini/routes/call.py</code> and <code className="font-mono">twilio_bridge.py</code>.
        </p>
      </div>
    </div>
  )
}

// ── Knowledge Base ───────────────────────────────────────────────────────────

type KbCollection = {
  id: number
  slug: string
  name: string
  description: string | null
  embedding_model: string
  chunk_size: number
  chunk_overlap: number
  document_count: number
  chunk_count: number
  created_at: string | null
  updated_at: string | null
}

type KbDocument = {
  id: number
  collection_id: number
  source: string
  filename: string | null
  mime_type: string | null
  char_count: number
  chunk_count: number
  status: string
  error: string | null
  created_at: string | null
  indexed_at: string | null
}

type KbSearchHit = {
  chunk_id: number
  document_id: number
  page_number: number | null
  content: string
  filename: string | null
  score: number
}

const KB_STATUS_BADGE: Record<string, string> = {
  ready:      'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  processing: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
  pending:    'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  failed:     'bg-destructive/10 text-destructive border-destructive/20',
}

function KnowledgeBaseView() {
  const [collections, setCollections] = useState<KbCollection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<KbCollection | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      const body = await res.json()
      setCollections(body.items || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function createCollection() {
    if (!newName.trim()) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.detail || `Failed: ${res.status}`)
      }
      setNewName(''); setNewDesc(''); setCreating(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function removeCollection(c: KbCollection) {
    if (!confirm(`Delete knowledge base "${c.name}" and all its documents? This cannot be undone.`)) return
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections/${c.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (selected) {
    return (
      <KbCollectionDetail
        collection={selected}
        onBack={() => { setSelected(null); load() }}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Knowledge Base</h1>
          <p className="text-sm text-muted-foreground">
            Upload PDFs, text, or markdown. Agents you link to a KB can search it during calls via <code className="font-mono text-xs">search_knowledge_base</code>.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          New Knowledge Base
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {creating && (
        <div className="card flex flex-col gap-3">
          <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">New Knowledge Base</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Product Manual"
              className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
            />
            <input
              type="text"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="Short description (optional)"
              className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={createCollection}
              disabled={saving || !newName.trim()}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Create
            </button>
            <button onClick={() => { setCreating(false); setNewName(''); setNewDesc('') }} className="px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 overflow-auto pb-4">
        {loading && collections.length === 0 ? (
          <p className="col-span-full text-center text-muted-foreground py-10">Loading…</p>
        ) : collections.length === 0 ? (
          <p className="col-span-full text-center text-muted-foreground py-10">No knowledge bases yet. Create one to get started.</p>
        ) : collections.map(c => (
          <div key={c.id} className="card flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Database className="w-5 h-5 text-primary flex-shrink-0" />
                <h3 className="font-bold text-foreground truncate">{c.name}</h3>
              </div>
              <button
                onClick={() => removeCollection(c)}
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 flex-shrink-0"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {c.description && <p className="text-xs text-muted-foreground line-clamp-2">{c.description}</p>}
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
              <span><span className="font-semibold text-foreground">{c.document_count}</span> docs</span>
              <span><span className="font-semibold text-foreground">{c.chunk_count}</span> chunks</span>
              <span className="font-mono opacity-50">#{c.slug}</span>
            </div>
            <button
              onClick={() => setSelected(c)}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border hover:bg-muted text-xs font-medium mt-1"
            >
              <FileText className="w-3.5 h-3.5" />
              Manage documents
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function KbCollectionDetail({ collection, onBack }: { collection: KbCollection; onBack: () => void }) {
  const [docs, setDocs] = useState<KbDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [showText, setShowText] = useState(false)
  const [textTitle, setTextTitle] = useState('')
  const [textBody, setTextBody] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Test-search state
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<KbSearchHit[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections/${collection.id}/documents`)
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      const body = await res.json()
      setDocs(body.items || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [collection.id])

  useEffect(() => { load() }, [load])

  // Poll while any doc is still processing.
  useEffect(() => {
    const anyPending = docs.some(d => d.status === 'pending' || d.status === 'processing')
    if (!anyPending) return
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [docs, load])

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(`${backendBase()}/api/kb/collections/${collection.id}/documents`, {
          method: 'POST',
          body: fd,
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.detail || `Upload failed: ${res.status}`)
        }
      }
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function uploadText() {
    if (!textTitle.trim() || !textBody.trim()) return
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('title', textTitle.trim())
      fd.append('content', textBody)
      const res = await fetch(`${backendBase()}/api/kb/collections/${collection.id}/documents`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.detail || `Failed: ${res.status}`)
      }
      setTextTitle(''); setTextBody(''); setShowText(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function removeDoc(d: KbDocument) {
    if (!confirm(`Delete "${d.filename}"?`)) return
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections/${collection.id}/documents/${d.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function reindexDoc(d: KbDocument) {
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections/${collection.id}/documents/${d.id}/reindex`, { method: 'POST' })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function runSearch() {
    if (!query.trim()) return
    setSearching(true)
    setHits(null)
    setError('')
    try {
      const res = await fetch(`${backendBase()}/api/kb/collections/${collection.id}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), top_k: 5 }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      const body = await res.json()
      setHits(body.items || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border px-6 py-3 flex items-center gap-3">
        <button onClick={onBack} className="w-9 h-9 rounded-lg border border-border hover:bg-muted flex items-center justify-center flex-shrink-0" title="Back to knowledge bases">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-foreground truncate flex items-center gap-2">
            <Database className="w-4 h-4 text-primary" /> {collection.name}
          </h1>
          <p className="text-xs text-muted-foreground">
            {docs.length} documents · {docs.reduce((n, d) => n + (d.chunk_count || 0), 0)} chunks · chunk size {collection.chunk_size}/{collection.chunk_overlap}
          </p>
        </div>
      </div>

      <div className="px-6 py-5 max-w-5xl w-full mx-auto flex flex-col gap-5">
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">{error}</div>
        )}

        {/* Upload zone */}
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Add documents</h2>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
              multiple
              onChange={e => uploadFiles(e.target.files)}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Upload PDF / TXT / MD
            </button>
            <button
              onClick={() => setShowText(v => !v)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium"
            >
              <FileText className="w-4 h-4" />
              Paste text
            </button>
            <span className="text-[11px] text-muted-foreground">PDFs must contain selectable text (scanned images aren't OCR'd).</span>
          </div>

          {showText && (
            <div className="flex flex-col gap-2 pt-2 border-t border-border">
              <input
                type="text"
                value={textTitle}
                onChange={e => setTextTitle(e.target.value)}
                placeholder="Title (e.g. Refund Policy)"
                className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
              />
              <textarea
                value={textBody}
                onChange={e => setTextBody(e.target.value)}
                rows={8}
                placeholder="Paste the knowledge text here…"
                className="bg-muted/30 border border-border rounded-lg px-3 py-2 text-xs leading-relaxed focus:outline-none focus:border-primary resize-y"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={uploadText}
                  disabled={uploading || !textTitle.trim() || !textBody.trim()}
                  className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {uploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Add text
                </button>
                <button onClick={() => { setShowText(false); setTextTitle(''); setTextBody('') }} className="px-4 py-2 rounded-lg border border-border hover:bg-muted text-sm font-medium">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Documents list */}
        <section className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Documents</h2>
            <button onClick={load} className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-border hover:bg-muted">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                <tr className="text-left">
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">Type</th>
                  <th className="px-4 py-2 font-semibold text-center">Chunks</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No documents yet.</td></tr>
                ) : docs.map(d => (
                  <tr key={d.id} className="border-t border-border/50 hover:bg-muted/20">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        {d.source === 'text' ? <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" /> : <FileCode className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                        <span className="truncate max-w-[260px]" title={d.filename || ''}>{d.filename || '—'}</span>
                      </div>
                      {d.status === 'failed' && d.error && (
                        <p className="text-[11px] text-destructive mt-0.5 line-clamp-2">{d.error}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs uppercase">{d.source}</td>
                    <td className="px-4 py-2.5 text-center">{d.chunk_count}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${KB_STATUS_BADGE[d.status] || 'bg-muted text-foreground border-border'}`}>
                        {(d.status === 'pending' || d.status === 'processing') && <Loader2 className="w-3 h-3 animate-spin" />}
                        {d.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        {d.status === 'failed' && (
                          <button onClick={() => reindexDoc(d)} className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border hover:bg-muted" title="Re-index">
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => removeDoc(d)} className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Test search */}
        <section className="card flex flex-col gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground flex items-center gap-2">
            <Search className="w-4 h-4" /> Test search
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
              placeholder="Ask something the way a caller would…"
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
            />
            <button
              onClick={runSearch}
              disabled={searching || !query.trim()}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </button>
          </div>
          {hits != null && (
            hits.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No matches found.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {hits.map(h => (
                  <div key={h.chunk_id} className="bg-muted/30 border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                      <span className="font-mono">{h.filename || '—'}{h.page_number ? ` · p.${h.page_number}` : ''}</span>
                      <span className="font-mono">score {h.score.toFixed(3)}</span>
                    </div>
                    <p className="text-xs text-foreground/90 leading-relaxed line-clamp-4">{h.content}</p>
                  </div>
                ))}
              </div>
            )
          )}
        </section>
      </div>
    </div>
  )
}

type View = 'home' | 'calls' | 'analytics' | 'voices' | 'techspecs' | 'agents' | 'tools' | 'costing' | 'kb'

export default function GeminiPage() {
  const templates = useAgentTemplates(TEMPLATES)
  const [view, setView] = useState<View>('home')
  const [mode, setMode] = useState<Mode>('browser')
  const [language, setLanguage] = useState('en')
  const [templateIdx, setTemplateIdx] = useState(0)
  const [systemPrompt, setSystemPrompt] = useState(templates[0]?.prompt || '')
  const [muted, setMuted] = useState(false)
  const [voice, setVoice] = useState('Aoede')
  const [avatarUrl, setAvatarUrl] = useState<string>(DEFAULT_AVATAR_URL)
  const [cameraView, setCameraView] = useState<CameraView>(DEFAULT_CAMERA_VIEW)
  const [toolIds, setToolIds] = useState<number[]>(templates[0]?.tool_ids || [])
  const [kbCollectionIds, setKbCollectionIds] = useState<number[]>(templates[0]?.kb_collection_ids || [])
  const [ambientAlways, setAmbientAlways] = useState<string | null>(templates[0]?.ambient_always ?? null)
  const [ambientToolCall, setAmbientToolCall] = useState<string | null>(templates[0]?.ambient_tool_call ?? null)
  const [ambientVolume, setAmbientVolume] = useState<number>(templates[0]?.ambient_volume ?? 0.15)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const { openConfigModal } = useUIStore()

  const { status, inCall, isConnected, transcript, errorCode, lastLatencyMs, sentiment, startCall, hangUp, clearTranscript, clearError, audioSinkRef, audioInterruptRef } =
    useGeminiVoice(systemPrompt, language, voice, toolIds, ambientAlways, ambientToolCall, ambientVolume, kbCollectionIds)

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  function handleTemplateChange(idx: number) {
    setTemplateIdx(idx)
    const t = templates[idx]
    if (t) {
      setSystemPrompt(t.prompt)
      if (t.voice) setVoice(t.voice)
      if (t.language) setLanguage(t.language)
      setToolIds(t.tool_ids || [])
      setKbCollectionIds(t.kb_collection_ids || [])
      setAmbientAlways(t.ambient_always ?? null)
      setAmbientToolCall(t.ambient_tool_call ?? null)
      setAmbientVolume(t.ambient_volume ?? 0.15)
    }
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
            onClick={() => { if (inCall) hangUp(); setView('analytics') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'analytics'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            Analytics
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
          <button
            onClick={() => { if (inCall) hangUp(); setView('agents') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'agents'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <Bot className="w-4 h-4" />
            Agents
          </button>
          <button
            onClick={() => { if (inCall) hangUp(); setView('tools') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'tools'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <Webhook className="w-4 h-4" />
            Tools
          </button>
          <button
            onClick={() => { if (inCall) hangUp(); setView('kb') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'kb'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            Knowledge Base
          </button>
          <button
            onClick={() => { if (inCall) hangUp(); setView('costing') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'costing'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <IndianRupee className="w-4 h-4" />
            Costing
          </button>
          <button
            onClick={() => { if (inCall) hangUp(); setView('techspecs') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'techspecs'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <FileCode className="w-4 h-4" />
            TechSpecs
          </button>
        </aside>

        {/* ─── Main content ─── */}
        {view === 'calls' ? <CallsView /> : view === 'analytics' ? <AnalyticsView /> : view === 'voices' ? <VoicesView /> : view === 'techspecs' ? <TechSpecsView /> : view === 'agents' ? <AgentsView /> : view === 'tools' ? <ToolsView /> : view === 'costing' ? <CostingView /> : view === 'kb' ? <KnowledgeBaseView /> : (
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
                        {templates.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
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
                  <div className="flex items-center gap-3">
                    {inCall && sentiment && <SentimentMeter sentiment={sentiment} />}
                    {lastLatencyMs != null && (
                      <span
                        className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                          lastLatencyMs < 800
                            ? 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20'
                            : lastLatencyMs < 1500
                            ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20'
                            : 'bg-destructive/10 text-destructive border-destructive/20'
                        }`}
                        title="Time from end of your speech to the agent's first audio"
                      >
                        ⚡ {lastLatencyMs} ms
                      </span>
                    )}
                    <div className={`flex items-center gap-1.5 text-xs font-semibold ${sm.color}`}>
                      <span className={`w-2 h-2 rounded-full ${sm.dot}`} />
                      {sm.label}
                    </div>
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

                {/* Avatar stage — controls float in the surrounding whitespace */}
                <div className="relative flex-1 w-full flex items-center justify-center min-h-0">
                  {/* Avatar picker — top-left */}
                  <div className="absolute top-3 left-3 z-10 flex flex-col gap-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60 pl-1">Avatar</span>
                    {AVATARS.map(a => (
                      <button
                        key={a.id}
                        onClick={() => setAvatarUrl(a.url)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-left transition-all border ${
                          avatarUrl === a.url
                            ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                            : 'bg-card/70 backdrop-blur text-foreground border-border hover:bg-muted'
                        }`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>

                  <GeminiAvatar inCall={inCall} status={status} audioSinkRef={audioSinkRef} audioInterruptRef={audioInterruptRef} avatarUrl={avatarUrl} cameraView={cameraView} width={340} height={460} mood={inCall ? (sentiment?.label ?? null) : null} />

                  {/* Camera framing — bottom-center segmented control */}
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-card/70 backdrop-blur border border-border rounded-full p-1 shadow-sm">
                    {CAMERA_VIEWS.map(v => (
                      <button
                        key={v.value}
                        onClick={() => setCameraView(v.value)}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                          cameraView === v.value
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
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
                    {transcript.length > 0 && (
                      <div className="flex items-center justify-between sticky -top-3 -mx-3 -mt-3 px-3 pt-2.5 pb-1.5 mb-1 bg-muted/95 backdrop-blur z-10 border-b border-border">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">Transcript</span>
                        <button
                          onClick={clearTranscript}
                          className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          Clear
                        </button>
                      </div>
                    )}
                    {inCall && transcript.length === 0 && (
                      <p className="text-xs text-muted-foreground/60 text-center py-2">Listening… start speaking</p>
                    )}
                    {transcript.map(entry => (
                      entry.role === 'tool' ? (
                        <ToolChip key={entry.id} name={entry.toolName} args={entry.toolArgs} status={entry.toolStatus} />
                      ) : (
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
                      )
                    ))}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </>
            ) : mode === 'phone' ? (
              <div className="w-full flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5 overflow-y-auto items-center">
                <TwilioConfigCard />
                <div className="card flex flex-col items-center gap-5 py-7">
                  <div className="flex items-center gap-3 self-start">
                    <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Phone className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">Healthcare Phone Agent</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">Powered by Twilio + Gemini Live</p>
                    </div>
                  </div>
                  <div className="w-full border-t border-border" />
                  <PhoneDialer />
                </div>
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
