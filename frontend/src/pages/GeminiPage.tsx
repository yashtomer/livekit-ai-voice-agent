import { useState, useEffect, useLayoutEffect, useRef, useCallback, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../api/client'
import { Device, Call } from '@twilio/voice-sdk'
import { Phone, PhoneOff, Mic, MicOff, ChevronDown, Settings, Home, ListVideo, Eye, X, RefreshCw, Play, Loader2, Mic2, FileCode, ArrowRight, Globe, Cloud, Server, Cpu, PhoneCall, Wrench, Bot, Plus, Pencil, Trash2, Star, Lock, Webhook, FlaskConical, IndianRupee, Volume2, VolumeX, ArrowLeft, Music, BookOpen, FileText, Upload, Search, Database, BarChart3, Clock, TrendingUp, AlertTriangle, Sparkles, Variable, Braces, Info, CalendarDays, ChevronLeft, ChevronRight, CheckCircle2, Stethoscope, User, Download, PhoneIncoming, PhoneOutgoing, MessageCircle, Voicemail, UserCheck, Network } from 'lucide-react'
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

/** Inline timeline card for a tool/function call made by the agent.
 *  Shows the request args and (collapsible) the response the tool returned. */
function ToolChip({ name, args, status, result, request }: {
  name?: string
  args?: Record<string, unknown> | null
  status?: string | null
  result?: unknown
  request?: { kind?: string; method?: string; url?: string; payload?: unknown } | null
}) {
  // The actual payload sent to the endpoint (after constant/dynamic-variable
  // substitution) — falls back to the raw LLM args when no request meta exists.
  const payload = request?.payload != null ? request.payload : (args && Object.keys(args).length ? args : null)
  const payloadStr = payload == null ? ''
    : typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const url = request?.url
  const method = request?.method
  const resultStr = result == null ? ''
    : typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  // Derive status from the result payload if it wasn't passed explicitly.
  const derived = status ?? (result && typeof result === 'object' && 'status' in (result as Record<string, unknown>)
    ? String((result as Record<string, unknown>).status) : null)
  const isError = derived === 'error' || derived === 'unavailable'
  const ok = derived == null || derived === 'ok'
  const big = resultStr.length > 160 || resultStr.includes('\n') || payloadStr.length > 120
  const [open, setOpen] = useState(!big)
  const hasDetail = !!(payloadStr || resultStr)

  const pill = `text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 leading-none ${
    isError ? 'bg-destructive/15 text-destructive'
      : ok ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'}`

  return (
    <div className="flex justify-center my-1.5">
      <div className="w-[92%] max-w-xl rounded-xl border border-border bg-muted/40 overflow-hidden shadow-sm">
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/70 transition-colors"
        >
          <span className="w-5 h-5 rounded-md bg-background border border-border flex items-center justify-center flex-shrink-0">
            <Wrench className="w-3 h-3 text-muted-foreground" />
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground flex-shrink-0">Tool</span>
          <span className="text-xs font-mono font-semibold text-foreground truncate">{name || 'tool'}</span>
          <span className={pill}>{derived || 'called'}</span>
          {hasDetail && (
            <ChevronDown className={`w-4 h-4 ml-auto text-muted-foreground transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
          )}
        </button>

        {/* Endpoint hit — method + URL (HTTP tools only). Always visible. */}
        {url && (
          <div className="px-3 pb-2 flex items-center gap-1.5 min-w-0">
            {method && (
              <span className="text-[9px] font-bold rounded px-1.5 py-0.5 bg-primary/10 text-primary flex-shrink-0">{method}</span>
            )}
            <code className="text-[11px] font-mono text-foreground/70 truncate" title={url}>{url}</code>
          </div>
        )}

        {open && hasDetail && (
          <div className="border-t border-border bg-background/50 divide-y divide-border">
            {payloadStr && (
              <div className="px-3 py-2">
                <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground/70">Payload</span>
                <pre className="mt-1 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words text-foreground/90 max-h-44 overflow-auto">{payloadStr}</pre>
              </div>
            )}
            {resultStr && (
              <div className="px-3 py-2">
                <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground/70">Response</span>
                <pre className="mt-1 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words text-foreground/90 max-h-60 overflow-auto">{resultStr}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Join two transcript fragments with correct spacing (no space before
 *  punctuation; works for both Latin and Devanagari scripts). */
function joinFragment(a: string, b: string): string {
  const left = (a || '').replace(/\s+$/, '')
  const right = (b || '').replace(/^\s+/, '')
  if (!left) return right
  if (!right) return left
  if (/^[,.!?।:;%)\]}'"]/.test(right)) return left + right
  return left + ' ' + right
}

/** Gemini Live streams the agent's (and caller's) speech as many word-level
 *  transcription events; the phone bridges log each as its own turn. Merge
 *  consecutive same-speaker text turns back into a single bubble so a sentence
 *  reads as one message instead of one-word fragments. Tool turns break a run. */
function coalesceTranscript(turns: TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (const t of turns) {
    const prev = out[out.length - 1]
    if ((t.role === 'user' || t.role === 'model') && prev && prev.role === t.role) {
      prev.text = joinFragment(prev.text || '', t.text || '')
    } else {
      out.push({ ...t })
    }
  }
  return out
}

/** A single chat message bubble (caller = brand accent, agent = clean card). */
function ChatBubble({ role, text }: { role: 'user' | 'model'; text: string }) {
  const isUser = role === 'user'
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center mt-5 ${
        isUser ? 'bg-muted border border-border text-muted-foreground' : 'bg-primary/10 text-primary'
      }`}>
        {isUser ? <Mic className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>
      <div className={`flex flex-col gap-1 min-w-0 max-w-[86%] ${isUser ? 'items-end' : 'items-start'}`}>
        <span className="text-[11px] font-medium text-muted-foreground px-1">{isUser ? 'Caller' : 'Agent'}</span>
        <div className={`px-4 py-2.5 text-sm leading-relaxed break-words shadow-sm ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-2xl rounded-tr-md'
            : 'bg-card border border-border text-foreground rounded-2xl rounded-tl-md'
        }`}>
          {text}
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
  label: string; prompt: string; first_message?: string | null; voice?: string; language?: string; tool_ids?: number[]
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
          label: a.name, prompt: a.system_prompt, first_message: a.first_message, voice: a.voice, language: a.language,
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
  tata:    'TATA Smartflo',
  twilio:  'Twilio Bridge',
  vobiz:   'Vobiz',
}

const CALL_TYPE_BADGE: Record<string, string> = {
  browser: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  tata:    'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
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

// Languages offered in the dropdown. Full Indian-language set (Gemini's
// documented Indian languages) plus the major global languages. Codes are
// ISO-639-1 (generic BCP-47), matching the existing scheme so previously-saved
// agents keep resolving. Must stay in sync with LANGUAGE_NAMES in
// backend/app/gemini/routes/{call,*_bridge}.py.
const LANGUAGES = [
  { code: 'en', label: 'English' }, { code: 'hi', label: 'Hindi' },
  // Indian languages
  { code: 'as', label: 'Assamese' }, { code: 'bn', label: 'Bengali' },
  { code: 'gu', label: 'Gujarati' }, { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' }, { code: 'mr', label: 'Marathi' },
  { code: 'or', label: 'Odia' }, { code: 'pa', label: 'Punjabi' },
  { code: 'ta', label: 'Tamil' }, { code: 'te', label: 'Telugu' },
  { code: 'ur', label: 'Urdu' },
  // Major global languages
  { code: 'ar', label: 'Arabic' }, { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' }, { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' }, { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' }, { code: 'es', label: 'Spanish' },
]

// Pre-built option lists for the searchable dropdowns (SearchableSelect).
// Gemini's prebuilt voices are multilingual — they speak whichever language is
// selected — so the sublabel describes gender + character, not a language.
const LANGUAGE_OPTIONS: SelectOption[] = LANGUAGES.map(l => ({ value: l.code, label: l.label }))
const VOICE_OPTIONS: SelectOption[] = VOICES.map(v => ({
  value: v.name,
  label: v.name,
  sublabel: `${v.gender === 'F' ? 'Female' : v.gender === 'M' ? 'Male' : 'Neutral'} · ${v.style}`,
  keywords: v.gender === 'F' ? 'female woman' : v.gender === 'M' ? 'male man' : 'neutral',
}))

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

// ── Searchable dropdown (type-to-filter combobox) ────────────────────────────

type SelectOption = { value: string; label: string; sublabel?: string; keywords?: string }

/** Plays on-demand voice samples (the same /api/voice-samples/<name>.wav
 *  endpoint the voice gallery uses). `toggle` starts a sample, or stops it if
 *  that voice is already playing. Only one sample plays at a time. */
function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  const toggle = useCallback((name: string) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    if (playing === name) { setPlaying(null); return }
    setLoading(name)
    const audio = new Audio(`${backendBase()}/api/voice-samples/${name}.wav`)
    audioRef.current = audio
    audio.onplaying = () => { setLoading(null); setPlaying(name) }
    audio.onended  = () => { setPlaying(null); audioRef.current = null }
    audio.onerror  = () => { setLoading(null); setPlaying(null); audioRef.current = null }
    audio.play().catch(() => { setLoading(null); setPlaying(null) })
  }, [playing])

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null }, [])

  return { playing, loading, toggle }
}

/** A <select>-styled combobox: click to open, type to filter by label, sublabel
 *  or keywords. Used for the language / agent / voice pickers, whose lists are
 *  long enough that plain scrolling is painful. `value` is always a string —
 *  for the agent picker pass String(index) and parse it back in onChange.
 *  With `preview`, each option gets a play button that auditions its voice. */
function SearchableSelect({
  value, onChange, options, disabled, placeholder = 'Select…', searchPlaceholder = 'Type to search…', preview = false,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  placeholder?: string
  searchPlaceholder?: string
  preview?: boolean
}) {
  const { playing, loading, toggle } = useVoicePreview()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Trigger geometry — the menu is portalled to <body> with fixed positioning
  // so it escapes any ancestor with overflow-hidden/auto (cards clip it
  // otherwise). `up` flips the menu above the trigger when there's no room below.
  const [pos, setPos] = useState<{ left: number; width: number; rectTop: number; rectBottom: number; vh: number; up: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.value === value) || null
  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter(o => `${o.label} ${o.sublabel || ''} ${o.keywords || ''}`.toLowerCase().includes(q))
    : options

  const measure = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const up = spaceBelow < 280 && r.top > spaceBelow
    setPos({ left: r.left, width: r.width, rectTop: r.top, rectBottom: r.bottom, vh: window.innerHeight, up })
  }, [])

  // Position the menu before paint, and keep it pinned on scroll/resize.
  useLayoutEffect(() => { if (open) measure() }, [open, measure])
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false); setQuery('')
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setOpen(false); setQuery('') } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, measure])

  // Focus the search box as soon as the menu opens.
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  function pick(v: string) { onChange(v); setOpen(false); setQuery('') }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground text-left focus:outline-none focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="flex-1 min-w-0 truncate">
          {selected ? (
            <>
              {selected.label}
              {selected.sublabel && <span className="text-muted-foreground"> — {selected.sublabel}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            zIndex: 1000,
            left: pos.left,
            width: pos.width,
            ...(pos.up
              ? { bottom: pos.vh - pos.rectTop + 4 }
              : { top: pos.rectBottom + 4 }),
            maxHeight: (pos.up ? pos.rectTop : pos.vh - pos.rectBottom) - 12,
          }}
          className="flex flex-col rounded-lg border border-border bg-card shadow-lg overflow-hidden"
        >
          {/* When the menu flips upward, the search bar sits at the bottom (next
              to the trigger) and results scroll above it; `order` reorders the
              flex children without duplicating markup. */}
          <div className={`p-2 bg-card flex-shrink-0 ${pos.up ? 'order-2 border-t' : 'order-1 border-b'} border-border`}>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-muted/50 border border-border rounded-md pl-8 pr-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
              />
            </div>
          </div>
          <div className={`overflow-auto py-1 ${pos.up ? 'order-1' : 'order-2'}`}>
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">No matches</div>
            ) : (
              filtered.map(o => (
                <div
                  key={o.value}
                  onClick={() => pick(o.value)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm cursor-pointer hover:bg-muted/70 transition-colors ${
                    o.value === value ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                  }`}
                >
                  <span className="flex-1 min-w-0 truncate">
                    {o.label}
                    {o.sublabel && (
                      <span className={o.value === value ? 'text-primary/80' : 'text-muted-foreground'}> — {o.sublabel}</span>
                    )}
                  </span>
                  {o.value === value && <CheckCircle2 className="w-4 h-4 flex-shrink-0" />}
                  {preview && (
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); toggle(o.value) }}
                      title={playing === o.value ? 'Stop' : 'Play sample'}
                      className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-primary/15 hover:text-primary transition-colors"
                    >
                      {loading === o.value ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : playing === o.value ? <X className="w-3.5 h-3.5" />
                        : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
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

// ── Inbound Call (TATA) ──────────────────────────────────────────────────────

interface TataConfig {
  stream_ws_url: string
  outbound_enabled: boolean
  inbound_enabled: boolean
  transfer_enabled: boolean
  transfer_code: string | null
  outbound_number: string | null
  agent_number: string | null
  missing_env: string[]
}

function InboundCard() {
  const [cfg, setCfg] = useState<TataConfig | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch(`${backendBase()}/api/tata/config`)
      .then(r => r.json())
      .then(setCfg)
      .catch(e => setError((e as Error).message))
  }, [])

  function copyNumber(value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (error) return <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">Failed to load TATA config: {error}</div>
  if (!cfg)  return <div className="text-xs text-muted-foreground">Loading TATA config…</div>

  const Status = ({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) => (
    <div className="flex items-start gap-2.5">
      <span className={`mt-0.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${ok ? 'bg-green-500' : 'bg-destructive'}`} />
      <div className="min-w-0">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {detail && <span className="block text-[11px] text-muted-foreground font-mono break-all">{detail}</span>}
      </div>
    </div>
  )

  // UI-only: show numbers with a leading "+" (without duplicating one).
  const withPlus = (n: string | null | undefined) => (n ? '+' + n.replace(/^\+/, '') : '')
  const displayNumber = withPlus(cfg.agent_number)

  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-5 py-2">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-primary flex items-center justify-center mx-auto mb-3 shadow-2xl">
          <PhoneCall className="w-7 h-7 text-white" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Inbound Call</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Dial the number below to talk to the agent. TATA streams the call to Gemini Live.
        </p>
      </div>

      {/* The number to call (TATA_AGENT_NUMBER) */}
      {cfg.agent_number ? (
        <div className="bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/25 rounded-xl px-4 py-5 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
            <Phone className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Call our agent</p>
            <a href={`tel:${displayNumber}`} className="block text-2xl font-bold font-mono text-foreground hover:underline mt-0.5">
              {displayNumber}
            </a>
            <p className="text-xs text-muted-foreground mt-1">Dial this number from any phone to talk to the AI voice agent live.</p>
          </div>
          <button
            onClick={() => copyNumber(displayNumber)}
            className="px-3 py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium whitespace-nowrap"
          >
            {copied ? 'Copied ✓' : 'Copy number'}
          </button>
        </div>
      ) : (
        <div className="bg-yellow-500/10 border border-yellow-500/25 rounded-lg px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
          No inbound number configured — set <code className="font-mono">TATA_AGENT_NUMBER</code> in the backend env.
        </div>
      )}

      {/* Config readiness — verify before deploying to the server */}
      <div className="card flex flex-col gap-3">
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">Server configuration</h3>
        <Status ok={cfg.inbound_enabled}  label="Inbound ready"  detail={displayNumber || 'TATA_AGENT_NUMBER not set'} />
        <Status ok={cfg.outbound_enabled} label="Outbound ready" detail={cfg.outbound_enabled ? `Agent number: ${withPlus(cfg.agent_number || cfg.outbound_number)}` : 'TATA_AUTH_TOKEN + agent number required'} />
        <Status ok={cfg.transfer_enabled} label="Transfer ready" detail={cfg.transfer_enabled ? `Transfer code: ${cfg.transfer_code}` : 'TATA_TRANSFER_CODE not set (transfers fall back to per-call code)'} />
        <div className="border-t border-border pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Stream WS URL (paste in TATA portal)</span>
          <code className="block bg-muted/50 border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all mt-1">{cfg.stream_ws_url}</code>
        </div>
        {cfg.missing_env.length > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/25 rounded-lg px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
            Missing env vars on the backend: <code className="font-mono">{cfg.missing_env.join(', ')}</code>
          </div>
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
  const [firstMessage, setFirstMessage] = useState(templates[0]?.first_message || '')
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
      setFirstMessage(t.first_message || '')
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
      // ── Vobiz outbound (disabled — switched to TATA) ──────────────────────
      // const res = await fetch(`${backendUrl}/api/vobiz/call`, {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     ...(token ? { Authorization: `Bearer ${token}` } : {}),
      //   },
      //   body: JSON.stringify({
      //     to, system_prompt: systemPrompt, first_message: firstMessage, language, voice, tool_ids: toolIds,
      //     kb_collection_ids: kbCollectionIds,
      //     ambient_always: ambientAlways, ambient_tool_call: ambientToolCall, ambient_volume: ambientVolume,
      //   }),
      // })

      // ── TATA outbound (Click-to-Call) ────────────────────────────────────
      const res = await fetch(`${backendUrl}/api/tata/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          to, system_prompt: systemPrompt, first_message: firstMessage, language, voice, tool_ids: toolIds,
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
          Place a TATA call to any Indian number. The agent dials them and speaks via Gemini Live.
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
          <SearchableSelect
            value={String(templateIdx)}
            onChange={v => handleTemplateChange(Number(v))}
            options={templates.map((t, i) => ({ value: String(i), label: t.label }))}
            disabled={busy}
            searchPlaceholder="Search agents…"
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Language</label>
          <SearchableSelect
            value={language}
            onChange={setLanguage}
            options={LANGUAGE_OPTIONS}
            disabled={busy}
            searchPlaceholder="Search languages…"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Voice</label>
          <SearchableSelect
            value={voice}
            onChange={setVoice}
            options={VOICE_OPTIONS}
            disabled={busy}
            preview
            searchPlaceholder="Search voices by name, gender or style…"
          />
          <p className="text-[11px] text-muted-foreground mt-1">All Gemini voices are multilingual — they speak whichever language you pick above.</p>
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
  end_reason: string | null
  started_at: string | null
  ended_at: string | null
  duration_s: number | null
  turn_count: number
  summary: string | null
  sentiment: string | null
  has_recording: boolean
  cost_usd: number | null
}

type CallUsage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  audio_in_tokens: number
  text_in_tokens: number
  audio_out_tokens: number
  text_out_tokens: number
  input_audio_min: number
  output_audio_min: number
  telephony_min: number
  usd_inr_rate: number
  gemini_usd: number
  telephony_usd: number
  cost_usd: number
  gemini_inr: number
  telephony_inr: number
  cost_inr: number
}

type TranscriptItem = {
  role: string
  text?: string
  ts?: string
  // tool events
  name?: string
  args?: Record<string, unknown>
  status?: string | null
  result?: unknown
  request?: { kind?: string; method?: string; url?: string; payload?: unknown } | null
}

type CallDetail = CallSummary & {
  system_prompt: string | null
  transcript: TranscriptItem[]
  error_message: string | null
  extracted: Record<string, unknown> | unknown[] | null
  usage: CallUsage | null
}

const SENTIMENT_BADGE: Record<string, string> = {
  positive: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  neutral:  'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  negative: 'bg-destructive/10 text-destructive border-destructive/20',
}

// Human-readable label + badge colour for gemini_call_logs.end_reason.
const END_REASON_LABEL: Record<string, string> = {
  COMPLETED:           'Completed',
  CLIENT_DISCONNECTED: 'Client Disconnected',
  AGENT_ENDED:         'Agent Ended',
  NETWORK_ISSUE:       'Network Issue',
  MODEL_ERROR:         'Server Error',
  INTERNAL_ERROR:      'Internal Error',
}

const END_REASON_BADGE: Record<string, string> = {
  COMPLETED:           'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  CLIENT_DISCONNECTED: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  AGENT_ENDED:         'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  NETWORK_ISSUE:       'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  MODEL_ERROR:         'bg-destructive/10 text-destructive border-destructive/20',
  INTERNAL_ERROR:      'bg-destructive/10 text-destructive border-destructive/20',
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
  total_cost_usd: number
  avg_cost_usd: number
  total_cost_inr: number
  avg_cost_inr: number
  usd_inr_rate: number
  total_input_tokens: number
  total_output_tokens: number
  by_type: { key: string; count: number }[]
  by_language: { key: string; count: number }[]
  by_sentiment: Record<string, number>
  by_voice: { key: string; count: number }[]
  top_tools: { key: string; count: number }[]
  calls_by_day: { day: string; count: number }[]
  cost_by_day: { day: string; cost: number }[]
}

/** Format a USD cost compactly: sub-cent shows 4 dp, otherwise 2–3 dp. */
function formatUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** Format an INR cost compactly. */
function formatInr(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v === 0) return '₹0'
  if (v < 1) return `₹${v.toFixed(2)}`
  if (v < 100) return `₹${v.toFixed(2)}`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: ComponentType<{ className?: string }>; label: string; value: string; sub?: string; color: string
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 flex items-start justify-between gap-3 transition-all hover:shadow-sm hover:border-border">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">{label}</p>
        <p className="text-[28px] font-bold text-foreground leading-none mt-2 tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1.5">{sub}</p>}
      </div>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  )
}

/** Horizontal bar list — used for breakdowns by type/language/tool. */
const BARLIST_ACCENTS: Record<string, string> = {
  primary: 'bg-primary',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  emerald: 'bg-emerald-500',
}
function BarList({ title, data, labelMap, accent = 'primary' }: {
  title: string; data: { key: string; count: number }[]; labelMap?: Record<string, string>; accent?: string
}) {
  const max = Math.max(1, ...data.map(d => d.count))
  const total = data.reduce((s, d) => s + d.count, 0)
  const bar = BARLIST_ACCENTS[accent] || BARLIST_ACCENTS.primary
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {total > 0 && <span className="text-xs font-medium text-muted-foreground tabular-nums">{total}</span>}
      </div>
      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No data yet.</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {data.map(d => (
            <div key={d.key} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs gap-2">
                <span className="text-foreground/90 truncate capitalize">{labelMap?.[d.key] || d.key}</span>
                <span className="font-semibold text-muted-foreground tabular-nums flex-shrink-0">{d.count}</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className={`h-full ${bar} rounded-full transition-all duration-500`} style={{ width: `${(d.count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
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
  const costDays = stats?.cost_by_day || []
  const costMax = Math.max(0.0001, ...costDays.map(d => d.cost))

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-5 overflow-y-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground">Aggregate insights across all Gemini Live calls</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg border border-border bg-card hover:bg-muted transition-all"
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
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            <StatCard icon={ListVideo} label="Total Calls" value={String(stats.total_calls)}
              sub={`${stats.ended_calls} ended · ${stats.active_calls} active`} color="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
            <StatCard icon={Clock} label="Avg Duration" value={formatDuration(stats.avg_duration_s)}
              sub={`${formatDuration(stats.total_duration_s)} total`} color="bg-violet-500/10 text-violet-600 dark:text-violet-400" />
            <StatCard icon={IndianRupee} label="Est. Cost" value={formatInr(stats.total_cost_inr)}
              sub={`${formatUsd(stats.total_cost_usd)} · ${formatInr(stats.avg_cost_inr)} avg/call`} color="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
            <StatCard icon={TrendingUp} label="Positive" value={`${sentTotal ? Math.round((sentiments.positive || 0) / sentTotal * 100) : 0}%`}
              sub={`${sentTotal} analysed`} color="bg-green-500/10 text-green-600 dark:text-green-400" />
            <StatCard icon={AlertTriangle} label="Errored" value={String(stats.errored_calls)}
              sub="failed sessions" color="bg-destructive/10 text-destructive" />
          </div>

          {/* Calls per day + Sentiment — two cards in one row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Calls per day */}
            <div className="rounded-2xl border border-border/70 bg-card p-5">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-sm font-semibold text-foreground">Calls per day</h3>
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  {stats.calls_by_day.reduce((s, d) => s + d.count, 0)} total
                </span>
              </div>
              {stats.calls_by_day.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No data yet.</p>
              ) : (
                <div className="flex items-end gap-3 h-40">
                  {stats.calls_by_day.map(d => (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-2 h-full group">
                      <div className="w-full flex-1 flex items-end justify-center">
                        <div
                          className="w-full max-w-[34px] bg-primary/85 group-hover:bg-primary rounded-t-md transition-all duration-500"
                          style={{ height: `${Math.max((d.count / dayMax) * 100, d.count > 0 ? 4 : 0)}%` }}
                          title={`${d.day}: ${d.count}`}
                        />
                      </div>
                      <span className="text-[11px] font-semibold text-foreground/80 tabular-nums">{d.count}</span>
                      <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Sentiment breakdown */}
            <div className="rounded-2xl border border-border/70 bg-card p-5 flex flex-col">
              <h3 className="text-sm font-semibold text-foreground mb-4">Sentiment</h3>
              {sentTotal === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No analysed calls yet.</p>
              ) : (
                <div className="flex-1 flex flex-col justify-center gap-4">
                  <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
                    <div className="bg-green-500 transition-all duration-500" style={{ width: `${(sentiments.positive || 0) / sentTotal * 100}%` }} />
                    <div className="bg-slate-400 transition-all duration-500" style={{ width: `${(sentiments.neutral || 0) / sentTotal * 100}%` }} />
                    <div className="bg-destructive transition-all duration-500" style={{ width: `${(sentiments.negative || 0) / sentTotal * 100}%` }} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {([
                      ['Positive', sentiments.positive || 0, 'bg-green-500'],
                      ['Neutral', sentiments.neutral || 0, 'bg-slate-400'],
                      ['Negative', sentiments.negative || 0, 'bg-destructive'],
                    ] as const).map(([label, val, dot]) => (
                      <div key={label} className="rounded-lg bg-muted/40 px-3 py-2.5">
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <span className={`w-2 h-2 rounded-full ${dot}`} /> {label}
                        </div>
                        <p className="text-lg font-bold text-foreground tabular-nums mt-1 leading-none">{val}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Cost per day */}
          <div className="rounded-2xl border border-border/70 bg-card p-5">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-foreground">Estimated cost per day</h3>
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                {formatInr(stats.total_cost_inr)} · {formatUsd(stats.total_cost_usd)} total
              </span>
            </div>
            {costDays.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No cost data yet.</p>
            ) : (
              <div className="flex items-end gap-3 h-40">
                {costDays.map(d => (
                  <div key={d.day} className="flex-1 flex flex-col items-center gap-2 h-full group">
                    <div className="w-full flex-1 flex items-end justify-center">
                      <div
                        className="w-full max-w-[34px] bg-amber-500/85 group-hover:bg-amber-500 rounded-t-md transition-all duration-500"
                        style={{ height: `${Math.max((d.cost / costMax) * 100, d.cost > 0 ? 4 : 0)}%` }}
                        title={`${d.day}: ${formatInr(d.cost * stats.usd_inr_rate)} (${formatUsd(d.cost)})`}
                      />
                    </div>
                    <span className="text-[10px] font-semibold text-foreground/80 tabular-nums">{formatInr(d.cost * stats.usd_inr_rate)}</span>
                    <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground/70 mt-3">Estimate — Gemini audio tokens + telephony minutes at configured rates (₹{stats.usd_inr_rate}/$).</p>
          </div>

          {/* Breakdown grids */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <BarList title="By channel" data={stats.by_type} labelMap={typeMap} accent="blue" />
            <BarList title="By language" data={stats.by_language} labelMap={langMap} accent="violet" />
            <BarList title="Top tools called" data={stats.top_tools} accent="primary" />
            <BarList title="By voice" data={stats.by_voice} accent="emerald" />
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

  const [deleting, setDeleting] = useState(false)
  const deleteCall = useCallback(async (id: number) => {
    if (!window.confirm(`Delete Call #${id}? Its transcript and recording are removed permanently.`)) return
    setDeleting(true)
    try {
      const res = await fetch(`${backendBase()}/api/gemini-calls/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      setSelected(null)
      await load(page)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }, [load, page])

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
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Calls</h1>
          <p className="text-sm text-muted-foreground">History of all Gemini Live calls with transcripts</p>
        </div>
        <button
          onClick={() => load(page)}
          className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg border border-border bg-card hover:bg-muted transition-all"
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

      <div className="rounded-2xl border border-border/70 bg-card flex-1 min-h-0 overflow-auto">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-muted-foreground text-[11px] uppercase tracking-wider bg-muted/40 backdrop-blur">
              <th className="px-4 py-3 font-semibold border-b border-border">ID</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Type</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Direction</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Phone</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Started</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Duration</th>
              <th className="px-4 py-3 font-semibold border-b border-border text-center">Turns</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Sentiment</th>
              <th className="px-4 py-3 font-semibold border-b border-border">Status</th>
              <th className="px-4 py-3 font-semibold border-b border-border">End Reason</th>
              <th className="px-4 py-3 font-semibold border-b border-border text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr><td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">No calls yet.</td></tr>
            ) : items.map(row => (
              <tr key={row.id} className="hover:bg-muted/30 transition-colors group">
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground border-b border-border/40">#{row.id}</td>
                <td className="px-4 py-3 border-b border-border/40">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${CALL_TYPE_BADGE[row.call_type] || 'bg-muted text-foreground border-border'}`}>
                    {CALL_TYPE_LABEL[row.call_type] || row.call_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground capitalize border-b border-border/40">{row.direction || '—'}</td>
                <td className="px-4 py-3 font-mono text-xs border-b border-border/40">{row.phone_number || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap border-b border-border/40">{formatDateTime(row.started_at)}</td>
                <td className="px-4 py-3 tabular-nums border-b border-border/40">{formatDuration(row.duration_s)}</td>
                <td className="px-4 py-3 text-center tabular-nums border-b border-border/40">{row.turn_count}</td>
                <td className="px-4 py-3 border-b border-border/40">
                  {row.sentiment ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border capitalize ${SENTIMENT_BADGE[row.sentiment] || SENTIMENT_BADGE.neutral}`}>
                      {row.sentiment}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3 border-b border-border/40">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium ${
                    row.status === 'ended' ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                    : row.status === 'active' ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                    : 'bg-destructive/10 text-destructive'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      row.status === 'ended' ? 'bg-green-500' : row.status === 'active' ? 'bg-yellow-500 animate-pulse' : 'bg-destructive'
                    }`} />
                    {row.status}
                  </span>
                </td>
                <td className="px-4 py-3 border-b border-border/40">
                  {row.end_reason ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${END_REASON_BADGE[row.end_reason] || 'bg-muted text-foreground border-border'}`}>
                      {END_REASON_LABEL[row.end_reason] || row.end_reason}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-3 text-right border-b border-border/40">
                  <button
                    onClick={() => openCall(row.id)}
                    className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
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
          <div className="bg-card border border-border rounded-2xl w-full max-w-6xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${CALL_TYPE_BADGE[selected.call_type] || 'bg-muted text-foreground border-border'}`}>
                  {CALL_TYPE_LABEL[selected.call_type] || selected.call_type}
                </span>
                <div>
                  <h2 className="text-base font-bold text-foreground leading-tight">Call #{selected.id}</h2>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(selected.started_at)} · {formatDuration(selected.duration_s)}
                  </p>
                </div>
                <button
                  onClick={() => deleteCall(selected.id)}
                  disabled={deleting}
                  title="Delete call"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <button onClick={() => setSelected(null)} className="w-9 h-9 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 lg:divide-x divide-border overflow-hidden">
              {/* LEFT — summary & result */}
              <div className="overflow-auto px-6 py-5 space-y-3.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Sparkles className="w-4 h-4 text-primary" /> Summary &amp; Result
                </div>

                {selected.error_message && (
                  <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2 text-xs text-destructive">
                    Error: {selected.error_message}
                  </div>
                )}

                {(selected.summary || selected.sentiment) && (
                  <div className="bg-primary/5 border border-primary/20 rounded-xl px-4 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-primary">AI Summary</span>
                      {selected.sentiment && (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border capitalize ${SENTIMENT_BADGE[selected.sentiment] || SENTIMENT_BADGE.neutral}`}>
                          {selected.sentiment}
                        </span>
                      )}
                    </div>
                    {selected.summary
                      ? <p className="text-sm text-foreground leading-relaxed">{selected.summary}</p>
                      : <p className="text-xs text-muted-foreground italic">No summary generated.</p>}
                  </div>
                )}

                {selected.has_recording && (
                  <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Music className="w-3.5 h-3.5 text-primary" />
                      <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Recording</span>
                    </div>
                    <audio
                      controls
                      preload="none"
                      className="w-full h-9"
                      src={`${backendBase()}/api/gemini-calls/${selected.id}/recording.wav`}
                    />
                  </div>
                )}

                {selected.usage && (
                  <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IndianRupee className="w-3.5 h-3.5 text-primary" />
                        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Estimated cost</span>
                      </div>
                      <span className="text-sm font-bold text-foreground tabular-nums">
                        {formatInr(selected.usage.cost_inr)} <span className="text-muted-foreground font-medium">· {formatUsd(selected.usage.cost_usd)}</span>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 pt-3">
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Gemini</span>
                        <span className="text-xs text-foreground tabular-nums">{formatInr(selected.usage.gemini_inr)} · {formatUsd(selected.usage.gemini_usd)}</span>
                      </div>
                      {selected.call_type !== 'browser' && (
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Telephony</span>
                          <span className="text-xs text-foreground tabular-nums">{formatInr(selected.usage.telephony_inr)} · {selected.usage.telephony_min}m</span>
                        </div>
                      )}
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Audio in</span>
                        <span className="text-xs text-foreground tabular-nums">{selected.usage.input_audio_min ?? 0} min</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Audio out</span>
                        <span className="text-xs text-foreground tabular-nums">{selected.usage.output_audio_min ?? 0} min</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground/70 mt-2">
                      Estimate — Gemini priced by modality: audio {(selected.usage.audio_in_tokens ?? 0).toLocaleString()} in / {(selected.usage.audio_out_tokens ?? 0).toLocaleString()} out ($3 / $12 per 1M), text {(selected.usage.text_in_tokens ?? 0).toLocaleString()} in / {(selected.usage.text_out_tokens ?? 0).toLocaleString()} out ($0.75 / $4.50 per 1M — prompt, KB &amp; tools) + telephony. ₹{selected.usage.usd_inr_rate}/$.
                    </p>
                  </div>
                )}

                {selected.extracted && typeof selected.extracted === 'object' && !Array.isArray(selected.extracted) && Object.keys(selected.extracted).length > 0 && (
                  <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Extracted data</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 pt-2">
                      {Object.entries(selected.extracted as Record<string, unknown>).map(([k, v]) => (
                        <div key={k} className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">{k.replace(/_/g, ' ')}</span>
                          <span className="text-xs text-foreground break-words">{v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!selected.summary && !selected.sentiment && !selected.error_message &&
                  !(selected.extracted && typeof selected.extracted === 'object' && Object.keys(selected.extracted as object).length > 0) && (
                  <p className="text-sm text-muted-foreground italic py-2">No analysis available for this call.</p>
                )}

                {selected.system_prompt && (
                  <details className="rounded-xl border border-border text-xs">
                    <summary className="cursor-pointer font-semibold text-muted-foreground px-3 py-2">System prompt</summary>
                    <pre className="mt-1 mx-3 mb-3 whitespace-pre-wrap text-muted-foreground/80 max-h-48 overflow-auto">{selected.system_prompt}</pre>
                  </details>
                )}
              </div>

              {/* RIGHT — transcript */}
              {(() => {
                const turns = coalesceTranscript(selected.transcript)
                return (
                  <div className="overflow-auto px-6 py-5 space-y-4 bg-muted/[0.15]">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground sticky top-0 bg-card/90 backdrop-blur -mx-6 px-6 -mt-5 pt-5 pb-3 z-10 border-b border-border/50">
                      <ListVideo className="w-4 h-4 text-primary" /> Transcript
                      <span className="text-xs font-normal text-muted-foreground">· {turns.length} turns</span>
                    </div>
                    {turns.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">No transcript captured.</p>
                    ) : turns.map((t, i) => (
                      t.role === 'tool' ? (
                        <ToolChip key={i} name={t.name} args={t.args} status={t.status} result={t.result} request={t.request} />
                      ) : (
                        <ChatBubble key={i} role={t.role as 'user' | 'model'} text={t.text || ''} />
                      )
                    ))}
                  </div>
                )
              })()}
            </div>
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

// ── End-to-end call-flow diagram (data-driven SVG) ───────────────────────────
// Covers every use case: Browser, TATA inbound, TATA outbound → one Gemini Live
// session → tools / transfer / off-topic / end_call → post-call. Edit the NODES
// and EDGES arrays to change the diagram.

type FlowCls = 'entry' | 'carrier' | 'backend' | 'gemini' | 'tool' | 'external' | 'datastore' | 'decision' | 'terminal' | 'good'
type FlowShape = 'round' | 'diamond' | 'cyl'
type FlowNodeDef = { id: string; x: number; y: number; w: number; h?: number; cls: FlowCls; shape: FlowShape; title: string; sub: string }
type FlowEdgeOpt = { label?: string; dash?: boolean; fs?: 'top' | 'bottom' | 'left' | 'right'; ts?: 'top' | 'bottom' | 'left' | 'right'; viaX?: number }
type FlowEdgeDef = [string, string, FlowEdgeOpt?]

const FLOW_W = 1580, FLOW_H = 2680

const FLOW_CLS: Record<FlowCls, { fill: string; stroke: string }> = {
  entry:    { fill: '#eef2f7', stroke: '#44607f' },
  carrier:  { fill: '#fde9d9', stroke: '#e08a3b' },
  backend:  { fill: '#daecf6', stroke: '#3b96cf' },
  gemini:   { fill: '#e9ddf6', stroke: '#8a63c9' },
  tool:     { fill: '#dff0df', stroke: '#4caf50' },
  external: { fill: '#d8f1ed', stroke: '#23a596' },
  datastore:{ fill: '#e6e9ef', stroke: '#6b7a99' },
  decision: { fill: '#fdf3d0', stroke: '#dca91d' },
  terminal: { fill: '#fbdede', stroke: '#d65a5a' },
  good:     { fill: '#dff0df', stroke: '#3a9d5d' },
}

const FLOW_LANES = [
  { label: 'CONNECT',   y0: 100,  y1: 912,  fill: '#fef6f3' },
  { label: 'CONVERSE',  y0: 912,  y1: 1652, fill: '#f4f9fb' },
  { label: 'RESOLVE',   y0: 1652, y1: 2212, fill: '#fbf9f1' },
  { label: 'POST-CALL', y0: 2212, y1: 2648, fill: '#f3f9f4' },
]

const FLOW_NODES: FlowNodeDef[] = [
  { id: 'browser', x: 250,  y: 152, w: 200, cls: 'entry', shape: 'round', title: '📱 Browser Voice', sub: 'User clicks “Start”' },
  { id: 'tin',     x: 660,  y: 152, w: 200, cls: 'entry', shape: 'round', title: '📞 TATA Inbound', sub: 'Caller dials the DID' },
  { id: 'tout',    x: 1030, y: 152, w: 210, cls: 'entry', shape: 'round', title: '📲 TATA Outbound', sub: 'POST /api/tata/call' },

  { id: 'b_ws',  x: 250, y: 252, w: 210, cls: 'backend',  shape: 'round', title: 'WS /api/gemini/ws', sub: '?token = JWT' },
  { id: 'b_key', x: 250, y: 350, w: 230, cls: 'backend',  shape: 'round', title: '_resolve_api_key', sub: 'JWT → user Google key (admin → server key)' },
  { id: 'b_dec', x: 250, y: 462, w: 210, h: 96, cls: 'decision', shape: 'diamond', title: 'API key present?', sub: '' },
  { id: 'b_term',x: 72,  y: 462, w: 150, cls: 'terminal', shape: 'round', title: 'Close WS', sub: 'code: no_api_key' },
  { id: 'b_cfg', x: 250, y: 585, w: 230, cls: 'backend',  shape: 'round', title: 'Receive config msg', sub: 'prompt · voice · tools · KB · ambient' },

  { id: 'to_store', x: 1030, y: 252, w: 230, cls: 'backend', shape: 'round', title: 'Store CALL_CONFIGS[dest #]', sub: 'per-call cfg · 1h TTL' },
  { id: 'to_ctc',   x: 1030, y: 350, w: 230, cls: 'carrier', shape: 'round', title: 'TATA Click-to-Call API', sub: 'rings agent DID + dials customer' },
  { id: 'to_ans',   x: 1030, y: 462, w: 230, cls: 'carrier', shape: 'round', title: 'Customer answers', sub: 'TATA streams to /stream' },

  { id: 'ti_ws',    x: 660, y: 252, w: 210, cls: 'carrier', shape: 'round', title: 'TATA opens WS', sub: '/api/tata/stream' },
  { id: 'ts_start', x: 660, y: 350, w: 240, cls: 'backend', shape: 'round', title: 'Wait for “start” event', sub: 'streamSid·callSid·from·to  (no server key → close)' },
  { id: 'ts_dec',   x: 660, y: 468, w: 240, h: 104, cls: 'decision', shape: 'diamond', title: 'Outbound cfg matched by number?', sub: '' },
  { id: 'ts_out',   x: 470, y: 585, w: 200, cls: 'backend', shape: 'round', title: 'Outbound', sub: 'use CALL_CONFIGS cfg' },
  { id: 'ts_in',    x: 830, y: 585, w: 220, cls: 'backend', shape: 'round', title: 'Inbound', sub: 'get_default_phone_agent (env fallback)' },

  { id: 'm_build',   x: 560, y: 690, w: 240, cls: 'backend', shape: 'round', title: 'build_gemini_tools', sub: '+ detect availability tool' },
  { id: 'm_amb',     x: 560, y: 782, w: 240, cls: 'backend', shape: 'round', title: 'AmbientMixer setup', sub: 'always + tool-call loops' },
  { id: 'm_log',     x: 560, y: 872, w: 240, cls: 'backend', shape: 'round', title: 'start_call', sub: 'create gemini_call_logs row' },
  { id: 'm_session', x: 560, y: 972, w: 260, cls: 'gemini',  shape: 'round', title: 'Open Gemini Live session', sub: 'voice · language · prompt · tools' },

  { id: 'ds_pg', x: 1380, y: 910, w: 180, h: 140, cls: 'datastore', shape: 'cyl', title: 'Postgres + pgvector', sub: 'call logs · agents · tools · KB' },

  { id: 'c_greet', x: 560, y: 1072, w: 280, cls: 'gemini',  shape: 'round', title: 'Greeting / first_message', sub: 'inbound·browser: now  ·  outbound: on 1st caller audio' },
  { id: 'c_pumps', x: 560, y: 1168, w: 300, cls: 'backend', shape: 'round', title: 'Two-way audio streams', sub: 'mic/μ-law → PCM16 16k  ·  24k → mix ambient → out' },
  { id: 'c_trans', x: 560, y: 1262, w: 280, cls: 'backend', shape: 'round', title: 'Transcribe both ways', sub: 'add_transcript · barge-in flush (clear)' },
  { id: 'c_dec',   x: 560, y: 1372, w: 230, h: 100, cls: 'decision', shape: 'diamond', title: 'Gemini fires tool_call?', sub: '' },
  { id: 't_disp',  x: 560, y: 1482, w: 260, cls: 'backend', shape: 'round', title: 'dispatch_tool_call', sub: '+ ambient filler (typing / clicks)' },
  { id: 't_resp',  x: 560, y: 1582, w: 240, cls: 'backend', shape: 'round', title: 'send_tool_response', sub: 'Gemini continues the turn' },

  { id: 't_kb',     x: 1150, y: 1300, w: 250, cls: 'tool',     shape: 'round', title: 'search_knowledge_base', sub: 'pgvector top-k chunks' },
  { id: 't_http',   x: 1150, y: 1392, w: 250, cls: 'tool',     shape: 'round', title: 'DB tool with URL', sub: 'HTTP API call (GET / POST)' },
  { id: 't_builtin',x: 1150, y: 1484, w: 250, cls: 'tool',     shape: 'round', title: 'Builtin tools', sub: 'doctors · book_appointment · book_calendar_event' },
  { id: 't_avail',  x: 1150, y: 1576, w: 250, cls: 'tool',     shape: 'round', title: 'check_agent_availability', sub: 'returns transfer_number / available' },
  { id: 't_cal',    x: 1420, y: 1484, w: 150, cls: 'external', shape: 'round', title: 'Google Calendar', sub: 'create event' },

  { id: 'ra1',     x: 290, y: 1706, w: 200, h: 96, cls: 'decision', shape: 'diamond', title: 'transfer_call', sub: '' },
  { id: 'raB',     x: 92,  y: 1818, w: 170, cls: 'terminal', shape: 'round', title: 'Browser', sub: 'unavailable → offer callback' },
  { id: 'raChk',   x: 290, y: 1818, w: 220, cls: 'backend',  shape: 'round', title: 'Phone: enforce', sub: 'check_agent_availability first' },
  { id: 'raAv',    x: 290, y: 1928, w: 200, h: 96, cls: 'decision', shape: 'diamond', title: 'Human agent free?', sub: '' },
  { id: 'raYes',   x: 210, y: 2042, w: 240, cls: 'carrier',  shape: 'round', title: 'Hand-off line → transfer', sub: 'TATA Call Options API (type 4, intercom)' },
  { id: 'raBridge',x: 210, y: 2146, w: 240, cls: 'carrier',  shape: 'round', title: 'Bridge to human', sub: 'hold WS open until “stop”' },
  { id: 'raNo',    x: 480, y: 2042, w: 210, cls: 'external', shape: 'round', title: 'No agent', sub: 'promise callback → WhatsApp → end' },

  { id: 'rb1',   x: 680, y: 1706, w: 250, cls: 'backend',  shape: 'round', title: 'report_off_topic', sub: 'strike n / threshold (survives reconnect)' },
  { id: 'rbDec', x: 680, y: 1818, w: 210, h: 96, cls: 'decision', shape: 'diamond', title: 'strikes ≥ threshold?', sub: '' },
  { id: 'rbNo',  x: 680, y: 1928, w: 230, cls: 'backend',  shape: 'round', title: 'Redirect to in-scope', sub: '→ continue conversation' },
  { id: 'rbYes', x: 680, y: 2042, w: 250, cls: 'backend',  shape: 'round', title: 'Escalate', sub: 'browser → end · phone → transfer senior rep' },

  { id: 'rc1', x: 1000, y: 1706, w: 200, cls: 'backend',  shape: 'round', title: 'end_call invoked', sub: '' },
  { id: 'rc2', x: 1000, y: 1808, w: 200, cls: 'gemini',   shape: 'round', title: 'Agent speaks', sub: 'closing line' },
  { id: 'rc3', x: 1000, y: 1918, w: 230, cls: 'terminal', shape: 'round', title: 'turn_complete → tear down', sub: 'reason = AGENT_ENDED' },

  { id: 'rk1', x: 1350, y: 1748, w: 250, cls: 'backend',  shape: 'round', title: 'Gemini drop 1006 / 1011', sub: 'silent reconnect · caller stays on' },
  { id: 'rk2', x: 1350, y: 1868, w: 250, cls: 'terminal', shape: 'round', title: '503 streak > 6', sub: 'MODEL_ERROR → end call' },

  { id: 'p_end',    x: 680, y: 2278, w: 320, cls: 'backend',  shape: 'round', title: 'end_call(reason) — finalize log', sub: 'AGENT_ENDED · CLIENT_DISCONNECTED · MODEL_ERROR · COMPLETED' },
  { id: 'p_hangup', x: 320, y: 2278, w: 220, cls: 'carrier',  shape: 'round', title: 'TATA active hangup', sub: 'if we ended & caller still on' },
  { id: 'p_dec',    x: 1040,y: 2278, w: 210, h: 96, cls: 'decision', shape: 'diamond', title: 'Ended cleanly / resolved?', sub: '' },
  { id: 'p_skip',   x: 1040,y: 2418, w: 240, cls: 'good',     shape: 'round', title: 'No message — all done', sub: 'AGENT_ENDED · COMPLETED · resolved drop' },
  { id: 'p_wa',     x: 1360,y: 2278, w: 240, cls: 'external', shape: 'round', title: 'Auto WhatsApp follow-up', sub: 'error (NETWORK / MODEL / INTERNAL) · caller dropped unresolved · no-agent callback' },
  { id: 'p_rec',    x: 680, y: 2382, w: 240, cls: 'backend',  shape: 'round', title: 'Save recording WAV', sub: 'set_recording' },
  { id: 'p_price',  x: 680, y: 2476, w: 260, cls: 'backend',  shape: 'round', title: 'Usage totals', sub: 'tokens + audio seconds → pricing' },
  { id: 'p_done',   x: 680, y: 2580, w: 300, cls: 'good',     shape: 'round', title: 'Call saved', sub: 'Calls page: transcript · recording · cost' },
]

const FLOW_EDGES: FlowEdgeDef[] = [
  ['browser', 'b_ws'], ['b_ws', 'b_key'], ['b_key', 'b_dec'],
  ['b_dec', 'b_term', { label: 'no key', fs: 'left', ts: 'top' }],
  ['b_dec', 'b_cfg', { label: 'key ok' }],

  ['tin', 'ti_ws'], ['ti_ws', 'ts_start'],
  ['tout', 'to_store'], ['to_store', 'to_ctc'], ['to_ctc', 'to_ans'],
  ['to_ans', 'ts_start', { fs: 'bottom', ts: 'right' }],
  ['ts_start', 'ts_dec'],
  ['ts_dec', 'ts_out', { label: 'yes (outbound)', fs: 'left', ts: 'top' }],
  ['ts_dec', 'ts_in', { label: 'no (inbound)', fs: 'right', ts: 'top' }],

  ['b_cfg', 'm_build', { fs: 'bottom', ts: 'left' }],
  ['ts_out', 'm_build', { fs: 'bottom', ts: 'top' }],
  ['ts_in', 'm_build', { fs: 'bottom', ts: 'right' }],
  ['m_build', 'm_amb'], ['m_amb', 'm_log'], ['m_log', 'm_session'],
  ['m_log', 'ds_pg', { dash: true, fs: 'right', ts: 'left', label: 'write' }],

  ['m_session', 'c_greet'], ['c_greet', 'c_pumps'], ['c_pumps', 'c_trans'], ['c_trans', 'c_dec'],
  ['c_trans', 'ds_pg', { dash: true, fs: 'right', ts: 'left', label: 'transcripts' }],
  ['c_dec', 't_disp', { label: 'tool_call' }],
  ['c_dec', 'c_pumps', { dash: true, fs: 'right', ts: 'right', viaX: 1505, label: 'no · keep talking' }],

  ['t_disp', 't_kb', { dash: true, fs: 'right', ts: 'left' }],
  ['t_disp', 't_http', { dash: true, fs: 'right', ts: 'left' }],
  ['t_disp', 't_builtin', { dash: true, fs: 'right', ts: 'left' }],
  ['t_disp', 't_avail', { dash: true, fs: 'right', ts: 'left' }],
  ['t_builtin', 't_cal', { dash: true, fs: 'right', ts: 'left' }],
  ['t_kb', 'ds_pg', { dash: true, fs: 'top', ts: 'bottom', label: 'pgvector' }],
  ['t_disp', 't_resp'],
  ['t_resp', 'c_pumps', { dash: true, fs: 'right', ts: 'right', viaX: 1525, label: 'continue' }],

  ['t_disp', 'ra1', { dash: true, fs: 'left', ts: 'top', label: 'transfer_call' }],
  ['t_disp', 'rb1', { dash: true, fs: 'bottom', ts: 'top', label: 'report_off_topic' }],
  ['t_disp', 'rc1', { dash: true, fs: 'right', ts: 'top', label: 'end_call' }],
  ['c_pumps', 'rk1', { dash: true, fs: 'right', ts: 'top', label: 'on Gemini drop' }],

  ['ra1', 'raB', { label: 'browser', fs: 'left', ts: 'top' }],
  ['ra1', 'raChk', { label: 'phone' }],
  ['raChk', 'raAv'],
  ['raAv', 'raYes', { label: 'yes' }],
  ['raYes', 'raBridge'],
  ['raAv', 'raNo', { label: 'no', fs: 'right', ts: 'top' }],

  ['rb1', 'rbDec'],
  ['rbDec', 'rbNo', { label: 'no', fs: 'left', ts: 'top' }],
  ['rbDec', 'rbYes', { label: 'yes', fs: 'right', ts: 'top' }],
  ['rbNo', 'c_pumps', { dash: true, fs: 'right', ts: 'right', viaX: 1545, label: 'redirect' }],

  ['rc1', 'rc2'], ['rc2', 'rc3'],

  ['rc3', 'p_end', { fs: 'bottom', ts: 'right' }],
  ['raBridge', 'p_end', { fs: 'bottom', ts: 'left' }],
  ['raNo', 'p_end', { fs: 'bottom', ts: 'left' }],
  ['rbYes', 'p_end', { fs: 'bottom', ts: 'top' }],
  ['rk2', 'p_end', { fs: 'bottom', ts: 'right' }],

  ['p_end', 'p_hangup', { fs: 'left', ts: 'top' }],
  ['p_end', 'p_dec', { fs: 'right', ts: 'left' }],
  ['p_dec', 'p_skip', { label: 'yes', fs: 'bottom', ts: 'top' }],
  ['p_dec', 'p_wa', { label: 'no', fs: 'right', ts: 'left' }],
  ['p_end', 'p_rec'],
  ['p_rec', 'p_price'],
  ['p_price', 'p_done'],
]

function FullCallFlowDiagram() {
  const ref = useRef<SVGSVGElement | null>(null)
  const [downloading, setDownloading] = useState(false)

  // Export the live SVG to a hi-res PNG (always in sync with the diagram).
  const downloadPng = useCallback(() => {
    const svg = ref.current
    if (!svg) return
    setDownloading(true)
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const xml = new XMLSerializer().serializeToString(clone)
    const svgUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    img.onload = () => {
      const scale = 2 // 2× for crisp text
      const canvas = document.createElement('canvas')
      canvas.width = FLOW_W * scale
      canvas.height = FLOW_H * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(svgUrl); setDownloading(false); return }
      ctx.scale(scale, scale)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, FLOW_W, FLOW_H)
      ctx.drawImage(img, 0, 0, FLOW_W, FLOW_H)
      URL.revokeObjectURL(svgUrl)
      canvas.toBlob(blob => {
        if (blob) {
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = 'gemini_call_flow.png'
          a.click()
          URL.revokeObjectURL(a.href)
        }
        setDownloading(false)
      }, 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(svgUrl); setDownloading(false) }
    img.src = svgUrl
  }, [])

  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    const NS = 'http://www.w3.org/2000/svg'
    while (svg.firstChild) svg.removeChild(svg.firstChild)

    const el = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
      const e = document.createElementNS(NS, tag)
      for (const k in attrs) e.setAttribute(k, String(attrs[k]))
      ;(parent || svg).appendChild(e)
      return e
    }

    // arrow markers
    const d = el('defs', {})
    const mk = (id: string, fill: string) => {
      const m = el('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, d)
      el('path', { d: 'M0,0 L10,5 L0,10 z', fill }, m)
    }
    mk('flow-arrow', '#5a6b7b'); mk('flow-arrowd', '#9aa7b4')

    // lane bands + labels
    FLOW_LANES.forEach(L => {
      el('rect', { x: 8, y: L.y0, width: FLOW_W - 16, height: L.y1 - L.y0, fill: L.fill, stroke: '#ececec', 'stroke-width': 1, rx: 6 })
      el('rect', { x: 8, y: L.y0, width: 30, height: L.y1 - L.y0, fill: '#ffffff', opacity: 0.45 })
      const cy = (L.y0 + L.y1) / 2
      const t = el('text', { x: 24, y: cy, 'text-anchor': 'middle', 'font-weight': 800, 'letter-spacing': 3, fill: '#b23a3a', 'font-size': 15, transform: `rotate(-90 24 ${cy})` })
      t.textContent = L.label
    })

    // legend
    const lx = 1170, ly = 96, lw = 400, rowH = 20
    const items: [FlowCls, string][] = [
      ['carrier', 'Telephony carrier (TATA)'], ['backend', 'Our backend (FastAPI)'],
      ['gemini', 'Gemini Live agent'], ['tool', 'Agent tool → backend'],
      ['external', 'External service'], ['datastore', 'Data store (Postgres)'],
      ['decision', 'Decision'], ['terminal', 'Terminal / critical'],
    ]
    const rows = Math.ceil(items.length / 2)
    el('rect', { x: lx, y: ly, width: lw, height: rows * rowH + 30, rx: 8, fill: '#ffffff', stroke: '#d7dde3' })
    const lt = el('text', { x: lx + 12, y: ly + 18, 'font-size': 12, 'font-weight': 700, fill: '#333' }); lt.textContent = 'Legend'
    items.forEach((it, i) => {
      const col = i % 2, row = Math.floor(i / 2)
      const x = lx + 12 + col * 195, y = ly + 30 + row * rowH
      const c = FLOW_CLS[it[0]]
      el('rect', { x, y: y - 9, width: 16, height: 12, rx: 3, fill: c.fill, stroke: c.stroke })
      const tx = el('text', { x: x + 22, y, 'font-size': 11.5, fill: '#333' }); tx.textContent = it[1]
    })
    const ny = ly + 30 + rows * rowH
    el('line', { x1: lx + 12, y1: ny - 4, x2: lx + 40, y2: ny - 4, stroke: '#9aa7b4', 'stroke-width': 2, 'stroke-dasharray': '5 4' })
    const dn = el('text', { x: lx + 46, y: ny, 'font-size': 11.5, fill: '#333' }); dn.textContent = 'Dashed = tool / DB / API call · loop-back'

    const byId: Record<string, FlowNodeDef> = {}
    FLOW_NODES.forEach(n => { n.h = n.h || 60; byId[n.id] = n })

    type Pt = { x: number; y: number }
    const anchor = (n: FlowNodeDef, side: string): Pt => {
      const { x, y, w } = n, h = n.h || 60
      if (side === 'top') return { x, y: y - h / 2 }
      if (side === 'bottom') return { x, y: y + h / 2 }
      if (side === 'left') return { x: x - w / 2, y }
      return { x: x + w / 2, y }
    }
    const isV = (s: string) => s === 'top' || s === 'bottom'
    const route = (p0: Pt, p1: Pt, fs: string, ts: string, viaX?: number): Pt[] => {
      if (viaX !== undefined) return [p0, { x: viaX, y: p0.y }, { x: viaX, y: p1.y }, p1]
      if (isV(fs) && isV(ts)) { const my = (p0.y + p1.y) / 2; return [p0, { x: p0.x, y: my }, { x: p1.x, y: my }, p1] }
      if (!isV(fs) && !isV(ts)) { const mx = (p0.x + p1.x) / 2; return [p0, { x: mx, y: p0.y }, { x: mx, y: p1.y }, p1] }
      if (!isV(fs) && isV(ts)) return [p0, { x: p1.x, y: p0.y }, p1]
      return [p0, { x: p0.x, y: p1.y }, p1]
    }

    // edges (under nodes)
    const edgeLayer = el('g', {})
    FLOW_EDGES.forEach(([from, to, opt]) => {
      const o = opt || {}
      const a = byId[from], b = byId[to]
      if (!a || !b) return
      const fs = o.fs || 'bottom', ts = o.ts || 'top'
      const pts = route(anchor(a, fs), anchor(b, ts), fs, ts, o.viaX)
      const path = 'M' + pts.map(p => `${p.x},${p.y}`).join(' L')
      el('path', {
        d: path, fill: 'none', stroke: o.dash ? '#9aa7b4' : '#5a6b7b', 'stroke-width': o.dash ? 1.6 : 1.8,
        'stroke-dasharray': o.dash ? '5 4' : 'none', 'marker-end': o.dash ? 'url(#flow-arrowd)' : 'url(#flow-arrow)',
      }, edgeLayer)
      if (o.label) {
        let best = 0, bx = pts[0].x, by = pts[0].y
        for (let i = 0; i < pts.length - 1; i++) {
          const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
          if (len > best) { best = len; bx = (pts[i].x + pts[i + 1].x) / 2; by = (pts[i].y + pts[i + 1].y) / 2 }
        }
        const tw = o.label.length * 6.0 + 8
        el('rect', { x: bx - tw / 2, y: by - 9, width: tw, height: 16, rx: 3, fill: '#ffffff', opacity: 0.92 }, edgeLayer)
        const t = el('text', { x: bx, y: by + 3, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 600, fill: '#444' }, edgeLayer)
        t.textContent = o.label
      }
    })

    const wrap = (txt: string, maxChars: number): string[] => {
      const words = txt.split(' '), lines: string[] = []; let cur = ''
      words.forEach(w => {
        if ((cur + ' ' + w).trim().length > maxChars) { if (cur) lines.push(cur); cur = w }
        else cur = (cur + ' ' + w).trim()
      })
      if (cur) lines.push(cur)
      return lines
    }

    // nodes
    FLOW_NODES.forEach(n => {
      const c = FLOW_CLS[n.cls], { x, y, w } = n, h = n.h || 60
      const g = el('g', {})
      if (n.shape === 'diamond') {
        el('polygon', { points: `${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}`, fill: c.fill, stroke: c.stroke, 'stroke-width': 1.6 }, g)
      } else if (n.shape === 'cyl') {
        const rx = w / 2, ry = 12, top = y - h / 2, bot = y + h / 2
        el('path', { d: `M ${x - rx},${top + ry} a ${rx},${ry} 0 0 1 ${2 * rx},0 L ${x + rx},${bot - ry} a ${rx},${ry} 0 0 1 ${-2 * rx},0 Z`, fill: c.fill, stroke: c.stroke, 'stroke-width': 1.6 }, g)
        el('path', { d: `M ${x - rx},${top + ry} a ${rx},${ry} 0 0 0 ${2 * rx},0`, fill: 'none', stroke: c.stroke, 'stroke-width': 1.6 }, g)
      } else {
        el('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 9, fill: c.fill, stroke: c.stroke, 'stroke-width': 1.6 }, g)
      }
      const titleLines = wrap(n.title, Math.max(10, Math.floor(w / 7.2)))
      const subLines = n.sub ? wrap(n.sub, Math.floor(w / 5.6)) : []
      const lineH = 14.5
      let cy = y - ((titleLines.length + subLines.length) * lineH) / 2 + 11
      titleLines.forEach(l => { const t = el('text', { x, y: cy, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 700, fill: '#1f2a36' }, g); t.textContent = l; cy += lineH })
      subLines.forEach(l => { const t = el('text', { x, y: cy, 'text-anchor': 'middle', 'font-size': 10.8, fill: '#3c4858' }, g); t.textContent = l; cy += 13 })
    })
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          onClick={downloadPng}
          disabled={downloading}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card text-sm font-medium text-foreground hover:bg-muted/60 transition disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {downloading ? 'Preparing…' : 'Download PNG'}
        </button>
      </div>
      <div className="bg-white rounded-xl border border-border overflow-auto max-h-[80vh]">
        <svg ref={ref} viewBox={`0 0 ${FLOW_W} ${FLOW_H}`} width={FLOW_W} height={FLOW_H} style={{ display: 'block', minWidth: FLOW_W }} />
      </div>
    </div>
  )
}

// ── Client-facing flow (high-level, non-technical) ───────────────────────────

/** Small downward connector with an optional caption — used in the client flow. */
function FlowDown({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-1">
      <div className="w-px h-4 bg-border" />
      {label && (
        <span className="text-[10px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full whitespace-nowrap">
          {label}
        </span>
      )}
      <ChevronDown className="w-4 h-4 text-muted-foreground" />
    </div>
  )
}

/** "What happens if…" card — a single edge-case scenario for the client flow. */
function ScenarioCard({ icon: Icon, color, title, when, then }: {
  icon: ComponentType<{ className?: string }>
  color: NodeColor
  title: string
  when: string
  then: string
}) {
  return (
    <div className="flex flex-col gap-2.5 p-4 rounded-xl border border-border bg-muted/20">
      <div className="flex items-center gap-2.5">
        <div className={`flex-shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center ${NODE_STYLES[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
        <p className="text-sm font-bold text-foreground leading-tight">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground/70">If </span>{when}
      </p>
      <p className="text-xs text-foreground/90 leading-relaxed">
        <span className="font-semibold text-primary">→ </span>{then}
      </p>
    </div>
  )
}

/** A single capability the agent uses live during a call. */
function CapabilityNode({ icon: Icon, label, sub, color }: {
  icon: ComponentType<{ className?: string }>
  label: string
  sub: string
  color: NodeColor
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="w-px h-4 bg-border" />
      <div className={`flex flex-col items-center text-center px-3 py-3 rounded-xl border ${NODE_STYLES[color]} w-[150px] shadow-sm`}>
        <Icon className="w-6 h-6 mb-1.5" />
        <span className="text-[13px] font-bold leading-tight">{label}</span>
        <span className="text-[10px] opacity-70 mt-1 leading-tight">{sub}</span>
      </div>
    </div>
  )
}

function ClientFlowDiagram() {
  return (
    <div className="flex flex-col items-center gap-1 min-w-fit">
      {/* ── 1. Entry points — all converge on the same agent ── */}
      <div className="flex items-stretch justify-center gap-3 flex-wrap">
        <FlowNode icon={Globe}         label="Website Call" sub="Visitor clicks “Talk to us”" color="sky" />
        <FlowNode icon={PhoneIncoming} label="Incoming Call" sub="Customer dials your number" color="sky" />
        <FlowNode icon={PhoneOutgoing} label="We Call Out"   sub="Agent dials the customer" color="sky" />
      </div>
      <FlowDown label="all three reach the same AI agent" />

      {/* ── 2. The agent core ── */}
      <FlowNode icon={Bot} label="AI Voice Agent" sub="Answers instantly · your brand voice & language" color="violet" />

      {/* ── 3. Live capabilities — what the agent draws on during the call ── */}
      <div className="w-px h-4 bg-border" />
      <div className="w-full max-w-[760px] rounded-2xl border-2 border-dashed border-violet-500/30 bg-violet-500/[0.04] px-5 pt-3 pb-5 flex flex-col items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400">
          During the conversation — all in one natural call
        </span>
        <div className="flex items-start justify-center gap-3 flex-wrap">
          <CapabilityNode icon={BookOpen}     label="Knowledge Base"   sub="Answers from your own docs & FAQs" color="emerald" />
          <CapabilityNode icon={Wrench}       label="Tools & Actions"  sub="Books appointments · checks orders · live data" color="amber" />
          <CapabilityNode icon={Music}        label="Ambient Sound"    sub="Natural background masks any thinking pause" color="sky" />
          <CapabilityNode icon={UserCheck}    label="Human Transfer"   sub="Hands off to a live agent when needed" color="rose" />
        </div>
        <p className="text-[10px] text-muted-foreground text-center max-w-md mt-1 leading-relaxed">
          When the agent looks something up or runs a tool, ambient sound keeps the call feeling natural — the
          customer never hears dead air. It also listens while speaking, so it stops the moment they jump in.
        </p>
      </div>

      {/* ── 4. The call ends — branches on HOW it ended ── */}
      <FlowDown label="the call wraps up" />
      <div className="flex flex-col items-center px-3 py-3 rounded-xl border-2 border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300 w-[200px] shadow-sm">
        <PhoneOff className="w-6 h-6 mb-1.5" />
        <span className="text-sm font-bold leading-tight text-center">How did the call end?</span>
      </div>

      {/* split connector */}
      <div className="flex items-stretch justify-center w-full max-w-[640px] pt-1">
        <div className="flex-1 border-t-2 border-l-2 border-border rounded-tl-xl h-4 mr-[1px]" />
        <div className="flex-1 border-t-2 border-r-2 border-border rounded-tr-xl h-4 ml-[1px]" />
      </div>

      <div className="flex items-start justify-center gap-10 sm:gap-20 flex-wrap">
        {/* Clean ending → nothing happens */}
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full whitespace-nowrap">
            ✓ ended normally
          </span>
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
          <FlowNode icon={CheckCircle2} label="All Done" sub="Goal met, agent ended, or caller said bye — no follow-up needed" color="emerald" />
        </div>

        {/* Bad ending → WhatsApp */}
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[10px] font-medium text-rose-600 dark:text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-full whitespace-nowrap">
            ✕ dropped mid-call or errored
          </span>
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
          <FlowNode icon={MessageCircle} label="Auto WhatsApp Follow-up" sub="Caller hung up unresolved, or a network/technical error — message sent automatically" color="rose" />
        </div>
      </div>
    </div>
  )
}

function TechSpecsView() {
  type SpecTab = 'client' | 'detailed' | 'other'
  const [specTab, setSpecTab] = useState<SpecTab>('client')

  const SPEC_TABS: { id: SpecTab; label: string; icon: typeof Bot }[] = [
    { id: 'client',   label: 'Client Flow',   icon: User },
    { id: 'detailed', label: 'Detailed Flow', icon: Network },
    { id: 'other',    label: 'Other Flows',   icon: ListVideo },
  ]

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-6 overflow-y-auto">
      <div>
        <h1 className="text-xl font-bold text-foreground">How It Works</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          From a simple client overview to the full technical architecture of every call.
        </p>
      </div>

      {/* ── Sub-tab switcher ── */}
      <div className="flex items-center gap-1 border-b border-border -mt-1">
        {SPEC_TABS.map(t => {
          const Icon = t.icon
          const active = specTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setSpecTab(t.id)}
              className={`relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* ════════════ CLIENT FLOW ════════════ */}
      {specTab === 'client' && (<>
      <div className="card flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-foreground">The Customer Journey</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Every call — from the web, an incoming call, or one we place — flows through the same simple,
              reliable journey. No jargon, just what your customer experiences.
            </p>
          </div>
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20">
            OVERVIEW
          </span>
        </div>
        <div className="bg-muted/20 border border-border rounded-xl p-6 overflow-x-auto">
          <ClientFlowDiagram />
        </div>
      </div>

      <div className="card flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-bold text-foreground">Smart Handling — what happens if…</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            The agent is built for the messy real world. These edge cases are handled automatically, so no
            customer slips through the cracks.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <ScenarioCard
            icon={Voicemail} color="amber" title="Reaches a voicemail"
            when="an outbound call lands on a voicemail or automated IVR instead of a real person,"
            then="the agent recognises the recorded greeting and hangs up right away — we never talk to or leave a message on a machine."
          />
          <ScenarioCard
            icon={PhoneOff} color="rose" title="Caller drops mid-call"
            when="the customer hangs up before their question is fully resolved,"
            then="we detect the drop and automatically send them a WhatsApp follow-up so they can pick up where they left off."
          />
          <ScenarioCard
            icon={UserCheck} color="sky" title="No human is free"
            when="the caller asks for a person but no human agent is available,"
            then="the agent promises a callback and sends a WhatsApp confirmation — nobody is left waiting on hold."
          />
          <ScenarioCard
            icon={RefreshCw} color="violet" title="Network hiccup"
            when="the connection briefly drops during the conversation,"
            then="the call silently reconnects in about a third of a second — the caller just hears a tiny pause and keeps talking."
          />
          <ScenarioCard
            icon={AlertTriangle} color="rose" title="Something goes wrong"
            when="a technical error means the call can't continue,"
            then="the call ends gracefully and a WhatsApp follow-up goes out so the customer is still looked after."
          />
          <ScenarioCard
            icon={Mic} color="emerald" title="Caller interrupts"
            when="the customer starts talking while the agent is still speaking,"
            then="the agent instantly stops and listens — just like a natural human conversation."
          />
        </div>
      </div>
      </>)}

      {/* ════════════ DETAILED FLOW ════════════ */}
      {specTab === 'detailed' && (
      <div className="card flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-foreground">End-to-End Call Flow</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Every use case in one map — Browser, TATA inbound &amp; outbound converge on a single Gemini Live
              session, then branch through tools, transfer, off-topic, end-call, reconnect, and post-call.
            </p>
          </div>
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20">
            TECHNICAL
          </span>
        </div>
        <FullCallFlowDiagram />
        <p className="text-[11px] text-muted-foreground">
          One Gemini Live session per call · reconnect is transparent to the caller · ambient filler masks the
          tool-call gap · scroll to pan the full diagram.
        </p>
      </div>
      )}

      {/* ════════════ OTHER FLOWS (per-channel deep dives) ════════════ */}
      {specTab === 'other' && (<>
      <div>
        <h2 className="text-lg font-bold text-foreground">Per-Channel Technical Flows</h2>
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

      {/* ── TATA Inbound ── */}
      <SpecSection
        title="TATA Inbound (Smartflo Voice Streaming)"
        subtitle="Caller dials your TATA DID; TATA streams the call (Twilio-style JSON media protocol) to our static WS; we relay to Gemini Live."
        badge="TATA · INBOUND"
        badgeColor="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20"
        diagram={
          <div className="flex flex-col items-center gap-6 min-w-fit">
            <div className="flex items-stretch justify-center flex-nowrap min-w-fit">
              <FlowNode icon={PhoneCall} label="Caller" sub="dials TATA DID" color="sky" />
              <FlowLink forward="→ μ-law 8 kHz (voice)" backward="← μ-law 8 kHz (response)" />
              <FlowNode icon={Cloud} label="TATA Smartflo" sub="Voice Streaming" color="amber" />
              <FlowLink forward="→ WS media (μ-law 8k)" backward="← media frames (160 B μ-law)" />
              <FlowNode icon={Server} label="FastAPI" sub="/api/tata/stream" color="violet" />
              <FlowLink forward="→ PCM16 @ 16 kHz" backward="← PCM16 @ 24 kHz" />
              <FlowNode icon={Cpu} label="Gemini Live" color="emerald" />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground bg-muted/40 border border-dashed border-border rounded-lg px-3 py-2">
              <span className="font-bold uppercase tracking-wide text-foreground/70">Setup</span>
              <span>1. Paste <code className="font-mono">/api/tata/stream</code> in the TATA portal</span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>2. Assign that endpoint to your DID</span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>3. On call, TATA opens the WS &amp; sends <code className="font-mono">start</code></span>
            </div>
            <FlowBranch
              label="default phone agent · tools ↕"
              child={<FlowNode icon={Wrench} label="agent_tools + KB" sub="book / transfer / off-topic" color="rose" />}
            />
          </div>
        }
        steps={[
          { title: 'Caller dials the DID',  body: 'TATA opens the statically-registered WebSocket to /api/tata/stream and sends a start event carrying streamSid, callSid, and the from/to numbers.' },
          { title: 'Resolve the agent',     body: 'No outbound config matches the number, so the bridge uses the default phone agent (get_default_phone_agent), falling back to the PHONE_SYSTEM_PROMPT env prompt.' },
          { title: 'Audio transcoding',     body: 'TATA sends G.711 μ-law 8 kHz. We decode → PCM16 16 kHz for Gemini, and downsample Gemini\'s 24 kHz → μ-law 8 kHz, flushed in fixed 160-byte frames TATA requires.' },
          { title: 'Greeting + barge-in',   body: 'The agent speaks first_message immediately (caller is already on the line). When the caller interrupts, we send a clear event so TATA flushes the queued playback.' },
          { title: 'Tools, transfer, KB',   body: 'Same dispatch as browser: HTTP/builtin tools, search_knowledge_base (pgvector), plus phone-only transfer_call (TATA Call Options API), end_call, and report_off_topic.' },
          { title: 'Logging + recording',   body: 'Logged to gemini_call_logs (type=tata, direction=inbound) with transcript, recording WAV, token + audio-second usage, and the end reason.' },
        ]}
        details={[
          { label: 'Caller audio',  value: 'μ-law 8 kHz' },
          { label: 'Gemini audio',  value: 'PCM16 16/24 kHz' },
          { label: 'Media stream',  value: '/api/tata/stream' },
          { label: 'Config',        value: '/api/tata/config' },
        ]}
      />

      {/* ── TATA Outbound ── */}
      <SpecSection
        title="TATA Outbound (Click-to-Call)"
        subtitle="We dial the customer via TATA Click-to-Call; on answer TATA streams the call to the same WS, matched to its per-call config by number."
        badge="TATA · OUTBOUND"
        badgeColor="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20"
        diagram={
          <div className="flex flex-col items-center gap-6 min-w-fit">
            <div className="flex items-stretch justify-center flex-nowrap min-w-fit">
              <FlowNode icon={Server} label="POST /api/tata/call" sub="store CALL_CONFIGS" color="violet" />
              <FlowLink forward="→ Click-to-Call API" />
              <FlowNode icon={Cloud} label="TATA Smartflo" sub="rings agent + customer" color="amber" />
              <FlowLink forward="→ customer answers" backward="← WS media stream" />
              <FlowNode icon={PhoneCall} label="Customer" sub="Indian mobile" color="sky" />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground bg-muted/40 border border-dashed border-border rounded-lg px-3 py-2">
              <span className="font-bold uppercase tracking-wide text-foreground/70">Flow</span>
              <span>1. POST <code className="font-mono">/api/tata/call</code> with prompt/voice/tools</span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>2. TATA dials; on answer hits <code className="font-mono">/api/tata/stream</code></span>
              <ArrowRight className="w-3.5 h-3.5" />
              <span>3. Matched to config by destination number</span>
            </div>
            <FlowBranch
              label="deferred greeting · tools ↕"
              child={<FlowNode icon={Cpu} label="Gemini Live" sub="per-call prompt/voice" color="emerald" />}
            />
          </div>
        }
        steps={[
          { title: 'Trigger the call',      body: 'POST /api/tata/call with the destination number plus optional system_prompt, first_message, voice, language, tool_ids, KB ids, ambient and transfer_code. The config is stashed in CALL_CONFIGS keyed by the last 10 digits (1h TTL).' },
          { title: 'TATA places the call',  body: 'Smartflo Click-to-Call rings the agent DID (our streaming leg) and dials the customer, bridging them. async=1 means it dials out without waiting for the agent leg to answer.' },
          { title: 'Match the config',      body: 'When the stream connects, the start event\'s from/to numbers are matched against CALL_CONFIGS so the call uses its per-call prompt/voice/tools instead of the default phone agent.' },
          { title: 'Deferred greeting',     body: 'On outbound the stream connects while the customer is still ringing, so the greeting is held until the first inbound audio frame (= customer picked up) — no talking into dead air.' },
          { title: 'Same conversation core',body: 'From here it is identical to inbound: tools, transfer, off-topic, end_call, ambient filler, transparent reconnect, and barge-in all run the same way.' },
          { title: 'Logging + recording',   body: 'Logged to gemini_call_logs (type=tata, direction=outbound) with transcript, recording, usage, and end reason. If we end the call while the customer is on, we actively hang up the TATA leg so it stops billing.' },
        ]}
        details={[
          { label: 'Outbound API', value: '/api/tata/call' },
          { label: 'Media stream', value: '/api/tata/stream' },
          { label: 'Transfer',     value: 'Call Options (type 4)' },
          { label: 'Config TTL',   value: '1 hour' },
        ]}
      />

      {/* ── Shared concepts ── */}
      <div className="card flex flex-col gap-3">
        <h2 className="text-lg font-bold text-foreground">Shared across all channels</h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-muted-foreground">
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">One Gemini Live session</strong> — browser, TATA inbound, and TATA outbound all converge on the same session, tool-dispatch, KB, ambient, and logging machinery.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Agent-driven config</strong> — each call resolves a <code className="text-xs font-mono bg-muted/50 px-1 py-0.5 rounded">gemini_agents</code> row (prompt · voice · language · tools · KB · ambient); inbound uses the default phone agent, outbound passes a per-call override.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Tools + Knowledge Base</strong> — HTTP &amp; builtin tools, calendar booking, <code className="text-xs font-mono bg-muted/50 px-1 py-0.5 rounded">search_knowledge_base</code> (pgvector), plus control tools transfer_call / end_call / report_off_topic.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Warm transfer + callback</strong> — phone calls hand off via the TATA Call Options API after an availability check; if no agent is free, we promise a callback and send a WhatsApp template.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Transparent reconnects</strong> — preview-model 1006/1011 closures auto-recover (~300 ms gap); a sustained 503 streak ends the call as MODEL_ERROR and notifies the customer.</span></li>
          <li className="flex gap-2"><span className="text-primary font-bold">•</span> <span><strong className="text-foreground">Unified logging</strong> — <code className="text-xs font-mono bg-muted/50 px-1 py-0.5 rounded">gemini_call_logs</code> stores call type, direction, transcript, recording, token + audio usage, cost, and end reason for every session.</span></li>
        </ul>
      </div>
      </>)}
    </div>
  )
}

// ── Tools View ───────────────────────────────────────────────────────────────

type ValueType = 'llm_prompt' | 'constant' | 'dynamic_variable'
type ToolParam = {
  name: string; type: string; required: boolean; description: string
  value_type?: ValueType
  constant_value?: string | null
  dynamic_variable?: string | null
  fallback?: string | null
}
type ToolResponseKey = { key: string; type: string; description: string }
type ToolVariable = { name: string; label: string; populated: boolean; description: string }

const VALUE_TYPE_META: Record<ValueType, { label: string; hint: string; icon: typeof Sparkles }> = {
  llm_prompt:       { label: 'LLM Prompt',       hint: 'The agent fills this in — it can ask the caller. Describe what to capture below.', icon: Sparkles },
  constant:         { label: 'Constant Value',   hint: 'A fixed value sent every call. You can embed {{variables}}.', icon: Braces },
  dynamic_variable: { label: 'Dynamic Variable', hint: 'Pulled from call context (e.g. caller_id). The agent never fills this.', icon: Variable },
}

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
  const [variables, setVariables] = useState<ToolVariable[]>([])
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
      const [r, rv] = await Promise.all([
        fetch(`${backendBase()}/api/tools/`),
        fetch(`${backendBase()}/api/tools/variables`).catch(() => null),
      ])
      if (!r.ok) throw new Error(`Failed: ${r.status}`)
      setItems((await r.json()).items || [])
      if (rv && rv.ok) setVariables((await rv.json()).items || [])
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
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-5 overflow-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Tools</h1>
            {!loading && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-primary/10 text-primary text-xs font-bold">{items.length}</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground max-w-2xl">
            HTTP endpoints (or Python built-ins) agents can call mid-conversation. Parameters &amp; response keys are passed to Gemini so it knows when and how to call them.
          </p>
        </div>
        <button
          onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          New Tool
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {[0, 1, 2].map(i => (
            <div key={i} className="rounded-2xl border border-border/70 bg-card p-5 h-48 animate-pulse">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-muted" />
                <div className="flex-1 space-y-2"><div className="h-3.5 w-2/3 rounded bg-muted" /><div className="h-2.5 w-1/3 rounded bg-muted" /></div>
              </div>
              <div className="mt-4 space-y-2"><div className="h-2.5 w-full rounded bg-muted" /><div className="h-2.5 w-5/6 rounded bg-muted" /></div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 rounded-2xl border-2 border-dashed border-border">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4"><Webhook className="w-7 h-7" /></div>
          <h3 className="font-semibold text-foreground">No tools yet</h3>
          <p className="text-sm text-muted-foreground mt-1 mb-5 max-w-xs">Create a tool to let agents call an external API or a built-in function.</p>
          <button onClick={startCreate} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm">
            <Plus className="w-4 h-4" /> New Tool
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {items.map(t => (
            <div
              key={t.id}
              className="group flex flex-col rounded-2xl border border-border/70 bg-card p-5 transition-all duration-200 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.15)] hover:-translate-y-1 hover:border-border"
            >
              {/* Header */}
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                  <Webhook className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-[15px] text-foreground truncate leading-snug">{t.name}</h3>
                  <p className="text-xs text-muted-foreground/60 truncate">{t.slug}</p>
                </div>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold flex-shrink-0 ${
                  t.is_builtin ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                }`}>
                  {t.is_builtin ? <><Lock className="w-2.5 h-2.5" /> Built-in</> : <><Globe className="w-2.5 h-2.5" /> HTTP</>}
                </span>
              </div>

              {/* Description */}
              <p className="text-[13px] leading-relaxed text-muted-foreground line-clamp-2 mt-3.5 min-h-[2.6rem]">
                {t.description || <span className="italic opacity-50">No description.</span>}
              </p>

              {/* Endpoint */}
              {t.url ? (
                <div className="flex items-center gap-2 mt-3 rounded-lg bg-muted/40 border border-border/50 px-2.5 py-1.5 min-w-0">
                  <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 flex-shrink-0 ${
                    t.http_method === 'GET' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : t.http_method === 'DELETE' ? 'bg-destructive/15 text-destructive'
                    : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                  }`}>{t.http_method}</span>
                  <code className="text-[11px] font-mono text-muted-foreground truncate" title={t.url}>{t.url}</code>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 mt-3 text-[11px] text-muted-foreground italic">
                  <Cpu className="w-3.5 h-3.5 opacity-60" /> Python built-in (no HTTP)
                </div>
              )}

              {/* Meta */}
              <div className="flex items-center flex-wrap gap-x-3.5 gap-y-1.5 mt-4 text-[11.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><Braces className="w-3.5 h-3.5 opacity-60" /> {t.parameters.length} param{t.parameters.length === 1 ? '' : 's'}</span>
                <span className="inline-flex items-center gap-1.5"><ArrowRight className="w-3.5 h-3.5 opacity-60" /> {t.response_schema.length} key{t.response_schema.length === 1 ? '' : 's'}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mt-5 pt-4 border-t border-border/50">
                <button onClick={() => startEdit(t)} className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-muted/60 hover:bg-muted text-[13px] font-semibold text-foreground/90 transition-colors">
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                {!t.is_builtin && (
                  <button onClick={() => remove(t)} className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title="Delete tool">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-6xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-bold text-foreground">{editing ? `Edit "${editing.name}"` : 'New Tool'}</h2>
              <button onClick={closeModal} className="w-8 h-8 rounded-lg border border-border hover:bg-muted flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 lg:divide-x divide-border overflow-hidden">
              {/* LEFT — endpoint configuration */}
              <div className="overflow-auto px-5 py-4 space-y-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-foreground">
                  <Webhook className="w-4 h-4 text-primary" /> Endpoint
                </div>
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
              </div>

              {/* RIGHT — request payload */}
              <div className="overflow-auto px-5 py-4 space-y-4 bg-muted/10">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-foreground">
                  <Braces className="w-4 h-4 text-primary" /> Request payload
                </div>

              {/* Parameters */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters <span className="opacity-60 normal-case">(the body the agent sends)</span></label>
                  <button onClick={() => setDraft({ ...draft, parameters: [...draft.parameters, { name: '', type: 'string', required: false, description: '', value_type: 'llm_prompt', constant_value: '', dynamic_variable: '', fallback: '' }] })}
                    className="text-xs text-primary hover:underline">+ Add parameter</button>
                </div>
                {draft.parameters.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No parameters.</p>
                ) : (
                  <div className="space-y-2">
                    {draft.parameters.map((p, i) => {
                      const vt: ValueType = (p.value_type as ValueType) || 'llm_prompt'
                      const meta = VALUE_TYPE_META[vt]
                      const setParam = (patch: Partial<ToolParam>) => {
                        const n = [...draft.parameters]; n[i] = { ...n[i], ...patch }; setDraft({ ...draft, parameters: n })
                      }
                      return (
                        <div key={i} className="border border-border rounded-xl bg-muted/20 p-3 space-y-2.5">
                          {/* Identifier + data type + required + delete */}
                          <div className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground block mb-1">Identifier</label>
                              <input value={p.name} placeholder="param_name" onChange={e => setParam({ name: e.target.value })}
                                className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-primary" />
                            </div>
                            <div className="w-28">
                              <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground block mb-1">Data type</label>
                              <div className="relative">
                                <select value={p.type} onChange={e => setParam({ type: e.target.value })}
                                  className="w-full appearance-none bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs pr-7 focus:outline-none focus:border-primary">
                                  <option>string</option><option>number</option><option>integer</option><option>boolean</option>
                                </select>
                                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                              </div>
                            </div>
                            <label className="inline-flex flex-col items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground pt-0.5">
                              Req
                              <input type="checkbox" checked={p.required} onChange={e => setParam({ required: e.target.checked })} className="w-4 h-4 accent-primary" />
                            </label>
                            <button onClick={() => setDraft({ ...draft, parameters: draft.parameters.filter((_, j) => j !== i) })}
                              className="mt-4 w-8 h-8 rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive flex items-center justify-center flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
                          </div>

                          {/* Value type selector */}
                          <div>
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground block mb-1">Value Type</label>
                            <div className="grid grid-cols-3 gap-1.5">
                              {(Object.keys(VALUE_TYPE_META) as ValueType[]).map(k => {
                                const m = VALUE_TYPE_META[k]; const Icon = m.icon; const active = vt === k
                                return (
                                  <button key={k} type="button" onClick={() => setParam({ value_type: k })}
                                    className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border text-[11px] font-medium transition-all ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted text-muted-foreground'}`}>
                                    <Icon className="w-3.5 h-3.5" /> {m.label}
                                  </button>
                                )
                              })}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1 flex items-start gap-1"><Info className="w-3 h-3 mt-px flex-shrink-0" />{meta.hint}</p>
                          </div>

                          {/* Conditional value input */}
                          {vt === 'llm_prompt' && (
                            <textarea value={p.description} rows={2} placeholder="Describe what the agent should capture, e.g. 'The caller's preferred callback date in YYYY-MM-DD format.'"
                              onChange={e => setParam({ description: e.target.value })}
                              className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs resize-y focus:outline-none focus:border-primary" />
                          )}
                          {vt === 'constant' && (
                            <input value={p.constant_value || ''} placeholder="Fixed value — supports {{caller_id}} etc."
                              onChange={e => setParam({ constant_value: e.target.value })}
                              className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-primary" />
                          )}
                          {vt === 'dynamic_variable' && (
                            <div className="space-y-1.5">
                              <div className="relative">
                                <select value={p.dynamic_variable || ''} onChange={e => setParam({ dynamic_variable: e.target.value })}
                                  className="w-full appearance-none bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs pr-7 font-mono focus:outline-none focus:border-primary">
                                  <option value="">Select a variable…</option>
                                  {variables.map(v => (
                                    <option key={v.name} value={v.name}>{v.name}{v.populated ? '' : ' (not yet populated)'} — {v.label}</option>
                                  ))}
                                </select>
                                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                              </div>
                              <div>
                                <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 block mb-0.5">Fallback value</label>
                                <input value={p.fallback || ''} placeholder="Sent if the variable is empty (e.g. on browser calls)"
                                  onChange={e => setParam({ fallback: e.target.value })}
                                  className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-primary" />
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {/* Dynamic-variable reference */}
                {variables.length > 0 && (
                  <details className="mt-2 border border-border rounded-lg bg-muted/10">
                    <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground flex items-center gap-1.5">
                      <Variable className="w-3.5 h-3.5" /> Available dynamic variables ({variables.length})
                    </summary>
                    <div className="px-2.5 pb-2.5 grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {variables.map(v => (
                        <div key={v.name} className="text-[10px] flex items-baseline gap-1.5">
                          <code className={`font-mono ${v.populated ? 'text-primary' : 'text-muted-foreground/60'}`}>{'{{'}{v.name}{'}}'}</code>
                          <span className="text-muted-foreground truncate">{v.description}</span>
                        </div>
                      ))}
                    </div>
                    <p className="px-2.5 pb-2 text-[10px] text-muted-foreground italic">Use these anywhere — parameters, the URL, header values, or inside a constant.</p>
                  </details>
                )}
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
  first_message: string | null
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
  first_message: string
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
    name: '', description: '', system_prompt: '', first_message: '',
    language: 'en', voice: 'Aoede', tool_ids: [], kb_collection_ids: [],
    ambient_always: null, ambient_tool_call: null, ambient_volume: 0.15,
  }
}

type Ambience = { slug: string; label: string; category: string; description: string }

const AGENT_LANG_LABELS: Record<string, string> = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu',
  mr: 'Marathi', gu: 'Gujarati', es: 'Spanish', fr: 'French', de: 'German',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
}
const langLabel = (code: string) => AGENT_LANG_LABELS[code] || (code || 'en').toUpperCase()

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
      first_message: a.first_message || '',
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
            first_message: draft.first_message,
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

  const phoneAgent = items.find(a => a.is_default_phone) || null

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-5 overflow-auto">
      {/* ── Header ── */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Agents</h1>
            {!loading && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-primary/10 text-primary text-xs font-bold">
                {items.length}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Reusable personas shared across browser voice, Twilio, Vobiz &amp; TATA. The agent marked{' '}
            <span className="inline-flex items-center gap-0.5 font-medium text-amber-600 dark:text-amber-400">
              <Star className="w-3.5 h-3.5 fill-current" />Phone
            </span>{' '}
            answers all inbound calls.
          </p>
        </div>
        <button
          onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          New Agent
        </button>
      </div>

      {/* ── Inbound-phone callout ── */}
      {!loading && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
            <PhoneCall className="w-4.5 h-4.5" />
          </div>
          <div className="text-sm min-w-0">
            <span className="text-muted-foreground">Inbound phone calls are handled by </span>
            {phoneAgent ? (
              <span className="font-semibold text-foreground">{phoneAgent.name}</span>
            ) : (
              <span className="font-semibold text-amber-700 dark:text-amber-400">no agent yet — set one below</span>
            )}
            {phoneAgent && <span className="text-muted-foreground"> · {langLabel(phoneAgent.language)} · {phoneAgent.voice}</span>}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Grid ── */}
      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2].map(i => (
            <div key={i} className="card h-56 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-2/3 rounded bg-muted" />
                  <div className="h-2.5 w-1/3 rounded bg-muted" />
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <div className="h-2.5 w-full rounded bg-muted" />
                <div className="h-2.5 w-5/6 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 rounded-2xl border-2 border-dashed border-border">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4">
            <Bot className="w-7 h-7" />
          </div>
          <h3 className="font-semibold text-foreground">No agents yet</h3>
          <p className="text-sm text-muted-foreground mt-1 mb-5 max-w-xs">
            Create your first agent to define a system prompt, voice, tools and knowledge bases.
          </p>
          <button
            onClick={startCreate}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
          >
            <Plus className="w-4 h-4" /> New Agent
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {items.map(a => (
            <div
              key={a.id}
              className={`group relative flex flex-col rounded-2xl border bg-card p-5 transition-all duration-200 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.15)] hover:-translate-y-1 ${
                a.is_default_phone
                  ? 'border-amber-400/50 bg-gradient-to-b from-amber-50/50 to-transparent dark:from-amber-500/[0.04]'
                  : 'border-border/70 hover:border-border'
              }`}
            >
              {/* Header */}
              <div className="flex items-center gap-3.5">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 ${
                  a.is_default_phone
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    : 'bg-primary/10 text-primary'
                }`}>
                  <Bot className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-[15px] text-foreground truncate leading-snug">{a.name}</h3>
                  <p className="text-xs text-muted-foreground/60 truncate">{a.slug}</p>
                </div>
              </div>

              {/* Badges */}
              {(a.is_default_phone || a.is_builtin) && (
                <div className="flex items-center gap-1.5 mt-3">
                  {a.is_default_phone && (
                    <span title="Answers inbound phone calls" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold bg-amber-500/12 text-amber-700 dark:text-amber-400">
                      <Star className="w-2.5 h-2.5 fill-current" /> Inbound phone
                    </span>
                  )}
                  {a.is_builtin && (
                    <span title="Built-in agent — name locked, cannot be deleted" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold bg-muted text-muted-foreground">
                      <Lock className="w-2.5 h-2.5" /> Built-in
                    </span>
                  )}
                </div>
              )}

              {/* Description */}
              <p className="text-[13px] leading-relaxed text-muted-foreground line-clamp-2 mt-3.5 min-h-[2.6rem]">
                {a.description || a.system_prompt?.trim() || <span className="italic opacity-50">No description.</span>}
              </p>

              {/* Meta — single airy inline row */}
              <div className="flex items-center flex-wrap gap-x-3.5 gap-y-1.5 mt-4 text-[11.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><Volume2 className="w-3.5 h-3.5 opacity-60" /> {a.voice}</span>
                <span className="inline-flex items-center gap-1.5"><Globe className="w-3.5 h-3.5 opacity-60" /> {langLabel(a.language)}</span>
                <span className="inline-flex items-center gap-1.5" title={`${a.tool_ids.length} tool(s)`}><Wrench className="w-3.5 h-3.5 opacity-60" /> {a.tool_ids.length}</span>
                {a.kb_collection_ids.length > 0 && (
                  <span className="inline-flex items-center gap-1.5" title={`${a.kb_collection_ids.length} knowledge base(s)`}><BookOpen className="w-3.5 h-3.5 opacity-60" /> {a.kb_collection_ids.length}</span>
                )}
                {a.first_message && (
                  <span className="inline-flex items-center gap-1.5 text-primary font-medium" title="Speaks a greeting on connect"><Sparkles className="w-3.5 h-3.5" /> Greeting</span>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 mt-5 pt-4 border-t border-border/50">
                <button
                  onClick={() => startEdit(a)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-muted/60 hover:bg-muted text-[13px] font-semibold text-foreground/90 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                {!a.is_default_phone && (
                  <button
                    onClick={() => makeDefault(a)}
                    className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 text-[13px] font-semibold transition-colors"
                    title="Use as default for inbound phone calls"
                  >
                    <Star className="w-3.5 h-3.5" /> Set phone
                  </button>
                )}
                {!a.is_builtin && (
                  <button
                    onClick={() => remove(a)}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title="Delete agent"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
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

type AgentTab = 'agent' | 'tools' | 'kb' | 'ambience'

function AgentEditor({ editing, draft, setDraft, allTools, ambience, kbCollections, toggleTool, toggleKb, saving, error, onCancel, onSave }: AgentEditorProps) {
  const alwaysOptions   = ambience.filter(a => a.category === 'always' || a.category === 'both')
  const toolCallOptions = ambience.filter(a => a.category === 'tool_call' || a.category === 'both')
  const [tab, setTab] = useState<AgentTab>('agent')

  const ambientCount = (draft.ambient_always ? 1 : 0) + (draft.ambient_tool_call ? 1 : 0)
  const TABS: { id: AgentTab; label: string; icon: typeof Bot; count?: number }[] = [
    { id: 'agent',    label: 'Agent',          icon: Bot },
    { id: 'tools',    label: 'Tools',          icon: Wrench,   count: draft.tool_ids.length },
    { id: 'kb',       label: 'Knowledge Base', icon: BookOpen, count: draft.kb_collection_ids.length },
    { id: 'ambience', label: 'Ambience',       icon: Volume2,  count: ambientCount },
  ]

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

      {/* Tab bar */}
      <div className="sticky top-[57px] z-10 bg-card/80 backdrop-blur border-b border-border px-6">
        <div className="max-w-6xl w-full mx-auto flex items-center gap-1">
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none ${active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>{t.count}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="px-6 py-5 max-w-6xl w-full mx-auto flex flex-col gap-5">
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ─── Basics ─── */}
        {tab === 'agent' && (<>
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
              <SearchableSelect
                value={draft.language}
                onChange={v => setDraft({ ...draft, language: v })}
                options={LANGUAGE_OPTIONS}
                searchPlaceholder="Search languages…"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Voice</label>
              <SearchableSelect
                value={draft.voice}
                onChange={v => setDraft({ ...draft, voice: v })}
                options={VOICE_OPTIONS}
                preview
                searchPlaceholder="Search voices by name, gender or style…"
              />
              <p className="text-[11px] text-muted-foreground mt-1">Voices are multilingual — they adapt to the selected language.</p>
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

        {/* ─── First message ─── */}
        <section className="card flex flex-col gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> First Message
          </h2>
          <p className="text-xs text-muted-foreground -mt-1">
            Spoken aloud the moment the call connects, before the caller says anything. Supports <code className="font-mono">{'{{variables}}'}</code> like <code className="font-mono">{'{{caller_name}}'}</code>. Leave blank to let the agent wait for the caller.
          </p>
          <textarea
            value={draft.first_message}
            onChange={e => setDraft({ ...draft, first_message: e.target.value })}
            rows={2}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary resize-y"
            placeholder="Namaskar, main Kanika hu, Rate-per-square-feet se. Aap kis sheher mein property dhund rahe hain?"
          />
        </section>
        </>)}

        {/* ─── Tools ─── */}
        {tab === 'tools' && (
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
        )}

        {/* ─── Knowledge bases ─── */}
        {tab === 'kb' && (
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
        )}

        {/* ─── Background ambience ─── */}
        {tab === 'ambience' && (
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
        )}
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

type Mode = 'browser' | 'inbound' | 'outbound'
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

  // Default 5 hrs/day × 20 working days = 6,000 billable minutes/month.
  const [hoursPerDay, setHoursPerDay] = useState(5)
  const [daysPerMonth, setDaysPerMonth] = useState(20)
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
    <div className="flex-1 flex flex-col min-h-0 p-6 gap-5 overflow-auto">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Knowledge Base</h1>
            {!loading && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-primary/10 text-primary text-xs font-bold">{collections.length}</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Upload PDFs, text, or markdown. Agents linked to a KB can search it during calls via <code className="font-mono text-xs bg-muted/60 px-1 py-0.5 rounded">search_knowledge_base</code>.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all shadow-sm"
        >
          <Plus className="w-4 h-4" />
          New Knowledge Base
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {creating && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-foreground">New Knowledge Base</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Product Manual"
              className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
            />
            <input
              type="text"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="Short description (optional)"
              className="bg-background border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
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
            <button onClick={() => { setCreating(false); setNewName(''); setNewDesc('') }} className="px-4 py-2 rounded-lg hover:bg-muted text-sm font-medium text-muted-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && collections.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {[0, 1, 2].map(i => (
            <div key={i} className="rounded-2xl border border-border/70 bg-card p-5 h-44 animate-pulse">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-muted" />
                <div className="flex-1 space-y-2"><div className="h-3.5 w-2/3 rounded bg-muted" /><div className="h-2.5 w-1/3 rounded bg-muted" /></div>
              </div>
              <div className="mt-4 space-y-2"><div className="h-2.5 w-full rounded bg-muted" /><div className="h-2.5 w-4/6 rounded bg-muted" /></div>
            </div>
          ))}
        </div>
      ) : collections.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 rounded-2xl border-2 border-dashed border-border">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4"><Database className="w-7 h-7" /></div>
          <h3 className="font-semibold text-foreground">No knowledge bases yet</h3>
          <p className="text-sm text-muted-foreground mt-1 mb-5 max-w-xs">Create one and upload documents so your agents can answer from them.</p>
          <button onClick={() => setCreating(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm">
            <Plus className="w-4 h-4" /> New Knowledge Base
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {collections.map(c => (
            <div
              key={c.id}
              onClick={() => setSelected(c)}
              className="group flex flex-col rounded-2xl border border-border/70 bg-card p-5 cursor-pointer transition-all duration-200 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.15)] hover:-translate-y-1 hover:border-border"
            >
              {/* Header */}
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                  <Database className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-[15px] text-foreground truncate leading-snug">{c.name}</h3>
                  <p className="text-xs text-muted-foreground/60 truncate">{c.slug}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); removeCollection(c) }}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex-shrink-0 transition-colors opacity-0 group-hover:opacity-100"
                  title="Delete knowledge base"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Description */}
              <p className="text-[13px] leading-relaxed text-muted-foreground line-clamp-2 mt-3.5 min-h-[2.6rem]">
                {c.description || <span className="italic opacity-50">No description.</span>}
              </p>

              {/* Meta */}
              <div className="flex items-center flex-wrap gap-x-3.5 gap-y-1.5 mt-4 text-[11.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><FileText className="w-3.5 h-3.5 opacity-60" /> {c.document_count} doc{c.document_count === 1 ? '' : 's'}</span>
                <span className="inline-flex items-center gap-1.5"><Braces className="w-3.5 h-3.5 opacity-60" /> {c.chunk_count} chunk{c.chunk_count === 1 ? '' : 's'}</span>
              </div>

              {/* Action */}
              <div className="flex items-center gap-2 mt-5 pt-4 border-t border-border/50">
                <span className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-muted/60 group-hover:bg-muted text-[13px] font-semibold text-foreground/90 transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Manage documents
                  <ArrowRight className="w-3.5 h-3.5 opacity-0 -ml-1 group-hover:opacity-100 group-hover:ml-0 transition-all" />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
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

// ── Calendar view ─────────────────────────────────────────────────────────────

interface CalEvent {
  id: string
  summary: string | null
  description: string | null
  start: string | null
  end: string | null
  doctor_id: string | null
  doctor: string | null
  patient: string | null
  department: string | null
  html_link?: string | null
  status?: string | null
}
interface CalDoctor {
  id: string
  name: string
  department: string
  free_slots?: string[]
  free_count?: number
}

function calStartOfWeek(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - x.getDay()) // back to Sunday
  return x
}
function calAddDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
function calYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function calSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const HOUR_PX = 56

function calHourLabel(h: number): string {
  const ap = h < 12 ? 'am' : 'pm'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:00${ap}`
}
function calHhmm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function CalDetailRow({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
      <span className="text-xs font-semibold text-muted-foreground w-20 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-foreground flex-1">{value}</span>
    </div>
  )
}

function CalendarView() {
  const [calMode, setCalMode] = useState<'week' | 'day'>('week')
  const [anchor, setAnchor] = useState<Date>(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })
  const [events, setEvents] = useState<CalEvent[]>([])
  const [doctors, setDoctors] = useState<CalDoctor[]>([])
  const [openHour, setOpenHour] = useState(9)
  const [closeHour, setCloseHour] = useState(17)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [doctorFilter, setDoctorFilter] = useState('all')
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null)
  const [now, setNow] = useState<Date>(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const days = calMode === 'week'
    ? Array.from({ length: 7 }, (_, i) => calAddDays(calStartOfWeek(anchor), i))
    : [anchor]
  const rangeStart = days[0]
  const rangeEnd = calAddDays(days[days.length - 1], 1)

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.get('/google-calendar/status')
      setConnected(!!r.data.connected)
      if (!r.data.connected) setStatusMsg(r.data.message || 'Not connected')
    } catch (e: any) {
      setConnected(false); setStatusMsg(e?.response?.data?.detail || 'Status check failed')
    }
  }, [])

  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/google-calendar/events', { params: { start: calYmd(rangeStart), end: calYmd(rangeEnd) } })
      setEvents(r.data.events || [])
    } catch { setEvents([]) } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart.getTime(), rangeEnd.getTime()])

  const loadAvailability = useCallback(async () => {
    try {
      const r = await api.get('/google-calendar/availability', { params: { date: calYmd(anchor) } })
      setDoctors(r.data.doctors || [])
      if (typeof r.data.open_hour === 'number') setOpenHour(r.data.open_hour)
      if (typeof r.data.close_hour === 'number') setCloseHour(r.data.close_hour)
    } catch { setDoctors([]) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.getTime()])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadEvents() }, [loadEvents])
  useEffect(() => { loadAvailability() }, [loadAvailability])

  function refresh() { loadStatus(); loadEvents(); loadAvailability() }
  function go(dir: number) { setAnchor(a => calAddDays(a, dir * (calMode === 'week' ? 7 : 1))) }
  function goToday() { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d) }

  const filtered = doctorFilter === 'all' ? events : events.filter(e => e.doctor_id === doctorFilter)
  const totalBooked = filtered.length
  const hours = Array.from({ length: Math.max(1, closeHour - openHour) }, (_, i) => openHour + i)
  const gridHeight = (closeHour - openHour) * HOUR_PX
  const today = new Date()
  const totalFree = doctors.reduce((s, d) => s + (d.free_count || 0), 0)

  function eventsForDay(day: Date): CalEvent[] {
    return filtered.filter(e => e.start && calSameDay(new Date(e.start), day))
  }
  function eventBox(ev: CalEvent): { top: number; height: number } {
    const s = ev.start ? new Date(ev.start) : new Date()
    const e = ev.end ? new Date(ev.end) : new Date(s.getTime() + 3600_000)
    const startMin = (s.getHours() * 60 + s.getMinutes()) - openHour * 60
    const endMin = (e.getHours() * 60 + e.getMinutes()) - openHour * 60
    const top = Math.max(0, (startMin / 60) * HOUR_PX)
    const height = Math.max(22, ((endMin - startMin) / 60) * HOUR_PX - 3)
    return { top, height }
  }
  const nowInView = days.some(d => calSameDay(d, now)) && now.getHours() >= openHour && now.getHours() < closeHour
  const nowTop = (((now.getHours() * 60 + now.getMinutes()) - openHour * 60) / 60) * HOUR_PX

  return (
    <div className="flex-1 px-6 py-6 flex flex-col gap-4 min-w-0 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-primary mb-0.5">Schedule</p>
          <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
          <p className="text-sm text-muted-foreground">Booked appointments and live availability, synced with Google Calendar.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-xs font-bold border border-green-500/20">{totalBooked} BOOKED</span>
          <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${connected ? 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20' : connected === false ? 'bg-destructive/10 text-destructive border-destructive/20' : 'bg-muted text-muted-foreground border-border'}`} title={statusMsg}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : connected === false ? 'bg-destructive' : 'bg-muted-foreground'}`} />
            {connected ? 'Google connected' : connected === false ? 'Disconnected' : 'Checking…'}
          </span>
          <select value={doctorFilter} onChange={e => setDoctorFilter(e.target.value)} className="appearance-none bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary">
            <option value="all">All doctors</option>
            {doctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button onClick={refresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-all">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {connected === false && (
        <div className="bg-destructive/10 border border-destructive/25 rounded-xl px-4 py-3 text-sm text-destructive">
          Google Calendar is not connected: {statusMsg}. Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in the backend environment.
        </div>
      )}

      <div className="flex gap-5 flex-1 min-h-0 flex-wrap xl:flex-nowrap">
        {/* Calendar card */}
        <div className="flex-1 min-w-[32rem] card flex flex-col gap-3 p-4">
          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1">
              <button onClick={() => go(-1)} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:bg-muted"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => go(1)} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:bg-muted"><ChevronRight className="w-4 h-4" /></button>
              <button onClick={goToday} className="ml-1 px-4 h-9 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted">Today</button>
            </div>
            <h2 className="text-base font-bold text-foreground">
              {calMode === 'week'
                ? `${rangeStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
                : anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </h2>
            <div className="flex items-center bg-muted p-1 rounded-lg border border-border gap-0.5">
              {(['week', 'day'] as const).map(m => (
                <button key={m} onClick={() => setCalMode(m)} className={`px-4 py-1.5 text-sm font-bold rounded-md transition-all capitalize ${calMode === m ? 'bg-destructive text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{m}</button>
              ))}
            </div>
          </div>

          {/* Grid */}
          <div className="border border-border rounded-xl overflow-hidden">
            {/* Day header row */}
            <div className="grid border-b border-border bg-muted/30" style={{ gridTemplateColumns: `4rem repeat(${days.length}, minmax(0,1fr))` }}>
              <div className="border-r border-border" />
              {days.map((d, i) => {
                const isToday = calSameDay(d, today)
                return (
                  <div key={i} className={`text-center py-2 border-r border-border last:border-r-0 ${isToday ? 'bg-destructive/5' : ''}`}>
                    <span className={`text-xs font-bold uppercase tracking-wide ${isToday ? 'text-destructive' : 'text-muted-foreground'}`}>{WEEKDAYS[d.getDay()]} {d.getMonth() + 1}/{d.getDate()}</span>
                  </div>
                )
              })}
            </div>
            {/* Time grid body */}
            <div className="grid relative" style={{ gridTemplateColumns: `4rem repeat(${days.length}, minmax(0,1fr))`, height: `${gridHeight}px` }}>
              {/* Time gutter */}
              <div className="relative border-r border-border">
                {hours.map((h, i) => (
                  <div key={h} className="absolute left-0 right-1 text-right pr-2 -translate-y-2 text-[11px] text-muted-foreground" style={{ top: `${i * HOUR_PX}px` }}>{calHourLabel(h)}</div>
                ))}
              </div>
              {/* Day columns */}
              {days.map((day, di) => {
                const isToday = calSameDay(day, today)
                return (
                  <div key={di} className={`relative border-r border-border last:border-r-0 ${isToday ? 'bg-destructive/[0.03]' : ''}`}>
                    {hours.map((h, i) => (
                      <div key={h} className="absolute left-0 right-0 border-b border-border/60" style={{ top: `${(i + 1) * HOUR_PX}px` }} />
                    ))}
                    {eventsForDay(day).map(ev => {
                      const box = eventBox(ev)
                      return (
                        <button key={ev.id} onClick={() => setSelectedEvent(ev)} className="absolute left-1 right-1 rounded-md bg-green-500 hover:bg-green-600 text-white px-2 py-1 text-left shadow-sm overflow-hidden transition-colors" style={{ top: `${box.top}px`, height: `${box.height}px` }}>
                          <p className="text-[11px] font-bold leading-tight truncate">{ev.doctor || ev.summary}</p>
                          {ev.patient && <p className="text-[10px] opacity-90 leading-tight truncate">{ev.patient}</p>}
                          <p className="text-[10px] opacity-80 leading-tight">{calHhmm(ev.start)} – {calHhmm(ev.end)}</p>
                        </button>
                      )
                    })}
                    {isToday && nowInView && (
                      <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: `${nowTop}px` }}>
                        <div className="relative">
                          <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-destructive" />
                          <div className="border-t-2 border-destructive" />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Appointment details modal */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelectedEvent(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-md animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between p-5 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center"><CalendarDays className="w-5 h-5 text-green-600 dark:text-green-400" /></div>
                <div>
                  <h3 className="text-base font-bold text-foreground">{selectedEvent.doctor || selectedEvent.summary}</h3>
                  <p className="text-xs text-muted-foreground">{selectedEvent.department || 'Appointment'}</p>
                </div>
              </div>
              <button onClick={() => setSelectedEvent(null)} className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <CalDetailRow icon={User} label="Patient" value={selectedEvent.patient || '—'} />
              <CalDetailRow icon={Stethoscope} label="Doctor" value={selectedEvent.doctor || '—'} />
              <CalDetailRow icon={Clock} label="When" value={selectedEvent.start ? `${new Date(selectedEvent.start).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}, ${calHhmm(selectedEvent.start)} – ${calHhmm(selectedEvent.end)}` : '—'} />
              {selectedEvent.department && <CalDetailRow icon={Webhook} label="Dept" value={selectedEvent.department} />}
              {selectedEvent.description && (
                <div className="pt-1">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap bg-muted/40 rounded-lg p-2.5 border border-border">{selectedEvent.description}</p>
                </div>
              )}
            </div>
            {selectedEvent.html_link && (
              <div className="p-5 pt-0">
                <a href={selectedEvent.html_link} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all">
                  Open in Google Calendar <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

type View = 'home' | 'calls' | 'analytics' | 'voices' | 'techspecs' | 'agents' | 'tools' | 'costing' | 'kb' | 'calendar'

export default function GeminiPage() {
  const templates = useAgentTemplates(TEMPLATES)
  // Default the agent picker to the Healthcare template (falls back to 0).
  const defaultIdx = Math.max(0, TEMPLATES.findIndex(t => /healthcare/i.test(t.label)))
  const [view, setView] = useState<View>('home')
  const [mode, setMode] = useState<Mode>('browser')
  const [language, setLanguage] = useState('en')
  const [templateIdx, setTemplateIdx] = useState(defaultIdx)
  const [systemPrompt, setSystemPrompt] = useState(templates[defaultIdx]?.prompt || '')
  const [firstMessage, setFirstMessage] = useState(templates[defaultIdx]?.first_message || '')
  const [muted, setMuted] = useState(false)
  const [voice, setVoice] = useState('Aoede')
  const [avatarUrl, setAvatarUrl] = useState<string>(DEFAULT_AVATAR_URL)
  const [cameraView, setCameraView] = useState<CameraView>('upper')
  const [toolIds, setToolIds] = useState<number[]>(templates[defaultIdx]?.tool_ids || [])
  const [kbCollectionIds, setKbCollectionIds] = useState<number[]>(templates[defaultIdx]?.kb_collection_ids || [])
  const [ambientAlways, setAmbientAlways] = useState<string | null>(templates[defaultIdx]?.ambient_always ?? null)
  const [ambientToolCall, setAmbientToolCall] = useState<string | null>(templates[defaultIdx]?.ambient_tool_call ?? null)
  const [ambientVolume, setAmbientVolume] = useState<number>(templates[defaultIdx]?.ambient_volume ?? 0.15)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const userPickedTemplateRef = useRef(false)

  const { openConfigModal } = useUIStore()

  const { status, inCall, isConnected, transcript, errorCode, lastLatencyMs, sentiment, startCall, hangUp, clearTranscript, clearError, audioSinkRef, audioInterruptRef } =
    useGeminiVoice(systemPrompt, language, voice, toolIds, ambientAlways, ambientToolCall, ambientVolume, kbCollectionIds, firstMessage)

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  function applyTemplate(idx: number) {
    setTemplateIdx(idx)
    const t = templates[idx]
    if (t) {
      setSystemPrompt(t.prompt)
      setFirstMessage(t.first_message || '')
      if (t.voice) setVoice(t.voice)
      if (t.language) setLanguage(t.language)
      setToolIds(t.tool_ids || [])
      setKbCollectionIds(t.kb_collection_ids || [])
      setAmbientAlways(t.ambient_always ?? null)
      setAmbientToolCall(t.ambient_tool_call ?? null)
      setAmbientVolume(t.ambient_volume ?? 0.15)
    }
  }

  function handleTemplateChange(idx: number) {
    userPickedTemplateRef.current = true
    applyTemplate(idx)
  }

  // Templates load async from the backend in a different order than the static
  // fallback, so resolve "Healthcare Booking" by label once they arrive — unless
  // the user has already picked an agent themselves.
  useEffect(() => {
    if (userPickedTemplateRef.current) return
    const idx = templates.findIndex(t => /healthcare/i.test(t.label))
    if (idx >= 0 && idx !== templateIdx) applyTemplate(idx)
  }, [templates]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleStart() {
    clearError()
    clearTranscript()
    await startCall()
  }

  // Fall back to 'idle' for any unexpected status so a stray value can never
  // crash the whole page on `sm.color`.
  const sm = STATUS_META[status] ?? STATUS_META.idle
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
            onClick={() => { if (inCall) hangUp(); setView('calendar') }}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              view === 'calendar'
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <CalendarDays className="w-4 h-4" />
            Calendar
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
        {view === 'calls' ? <CallsView /> : view === 'analytics' ? <AnalyticsView /> : view === 'voices' ? <VoicesView /> : view === 'techspecs' ? <TechSpecsView /> : view === 'agents' ? <AgentsView /> : view === 'tools' ? <ToolsView /> : view === 'costing' ? <CostingView /> : view === 'kb' ? <KnowledgeBaseView /> : view === 'calendar' ? <CalendarView /> : (
        <div className="flex-1 px-6 py-6 flex flex-col gap-4 min-w-0">

        {/* Page header + mode switcher */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Gemini Live Voice</h1>
            <p className="text-sm text-muted-foreground">Real-time AI voice calls powered by Google Gemini</p>
          </div>
          <div className="flex items-center bg-muted p-1 rounded-lg border border-border gap-0.5">
            {(['browser', 'inbound', 'outbound'] as const).map(m => (
              <button
                key={m}
                onClick={() => { if (inCall) hangUp(); setMode(m) }}
                className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-all ${
                  mode === m
                    ? 'bg-card text-foreground shadow-sm border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'browser' ? 'Browser Voice' : m === 'inbound' ? 'Inbound Call' : 'Outbound Call'}
              </button>
            ))}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex gap-6 min-h-0">

          {/* LEFT — config panel (only in browser mode) */}
          {mode === 'browser' && (
            <div className="w-[28rem] flex-shrink-0 flex flex-col gap-4">
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
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Agent</label>
                    <SearchableSelect
                      value={String(templateIdx)}
                      onChange={v => handleTemplateChange(Number(v))}
                      options={templates.map((t, i) => ({ value: String(i), label: t.label }))}
                      disabled={isActive}
                      searchPlaceholder="Search agents…"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Language</label>
                    <SearchableSelect
                      value={language}
                      onChange={setLanguage}
                      options={LANGUAGE_OPTIONS}
                      disabled={isActive}
                      searchPlaceholder="Search languages…"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Voice</label>
                    <SearchableSelect
                      value={voice}
                      onChange={setVoice}
                      options={VOICE_OPTIONS}
                      disabled={isActive}
                      preview
                      searchPlaceholder="Search voices by name, gender or style…"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Voices are multilingual — they speak the selected language.</p>
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
                <div className="relative flex-1 w-full flex items-center justify-center min-h-0 overflow-hidden">
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

                  <GeminiAvatar inCall={inCall} status={status} audioSinkRef={audioSinkRef} audioInterruptRef={audioInterruptRef} avatarUrl={avatarUrl} cameraView={cameraView} width={560} height={520} mood={inCall ? (sentiment?.label ?? null) : null} />

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
                        <ToolChip key={entry.id} name={entry.toolName} args={entry.toolArgs} status={entry.toolStatus} result={entry.toolResult} request={entry.toolRequest} />
                      ) : (
                        <ChatBubble key={entry.id} role={entry.role as 'user' | 'model'} text={entry.text} />
                      )
                    ))}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </>
            ) : mode === 'inbound' ? (
              <div className="w-full flex-1 overflow-y-auto">
                <InboundCard />
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
