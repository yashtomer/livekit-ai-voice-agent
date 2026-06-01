import { useState, useEffect, useRef } from 'react'
import { Mic, MicOff, PhoneOff, Phone, Minimize2, Maximize2, X, ChevronDown } from 'lucide-react'
import useGeminiVoice, { type GeminiStatus } from '../../hooks/useGeminiVoice'
import GeminiAvatar from '../GeminiAvatar'

interface GeminiCallProps {
  onClose: () => void
}

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
    prompt: 'You are a helpful, friendly voice assistant named Gemini. Be concise and conversational — this is a real-time voice call. Keep every reply to 1–2 sentences unless more is asked.',
  },
  {
    label: 'Healthcare Booking',
    prompt: `You are a professional medical appointment booking assistant. Be concise and conversational like a real phone operator.
Workflow: 1) Greet and get patient name. 2) Ask which doctor or department. 3) Ask for date and time (9am-5pm only). 4) Confirm availability. 5) Ask for remarks. 6) Confirm all details. 7) End call.`,
  },
  {
    label: 'Customer Support',
    prompt: 'You are a friendly customer support agent. Listen carefully to the customer\'s issue, empathize, and provide clear solutions. Be concise. Ask one question at a time. Escalate if you cannot resolve.',
  },
  {
    label: 'Sales Agent',
    prompt: 'You are a professional sales agent. Understand the prospect\'s needs, highlight relevant product benefits, handle objections gracefully, and guide towards a decision. Be consultative, not pushy. Keep responses short.',
  },
]

const STATUS_CONFIG: Record<GeminiStatus, { label: string; color: string; dot: string }> = {
  idle:       { label: 'Ready',       color: 'bg-muted text-muted-foreground',               dot: 'bg-muted-foreground/40' },
  connecting: { label: 'Connecting…', color: 'bg-yellow-500/10 text-yellow-600',             dot: 'bg-yellow-500 animate-ping' },
  listening:  { label: 'Listening',   color: 'bg-green-500/10 text-green-600 dark:text-green-400',  dot: 'bg-green-500 animate-pulse' },
  processing: { label: 'Processing',  color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',     dot: 'bg-blue-500 animate-pulse' },
  speaking:   { label: 'Speaking',    color: 'bg-primary/10 text-primary',                   dot: 'bg-primary animate-pulse' },
  error:      { label: 'Error',       color: 'bg-destructive/10 text-destructive',            dot: 'bg-destructive' },
}

export default function GeminiCall({ onClose }: GeminiCallProps) {
  const [language, setLanguage] = useState('en')
  const [templateIdx, setTemplateIdx] = useState(0)
  const [systemPrompt, setSystemPrompt] = useState(TEMPLATES[0].prompt)
  const [isMuted, setIsMuted] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const { status, inCall, transcript, sentiment, startCall, hangUp, clearTranscript, playAnalyserRef } = useGeminiVoice(systemPrompt, language)

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  const handleTemplateChange = (idx: number) => {
    setTemplateIdx(idx)
    setSystemPrompt(TEMPLATES[idx].prompt)
  }

  const handleStart = async () => {
    clearTranscript()
    await startCall()
  }

  const handleEnd = () => hangUp()

  const handleClose = () => {
    if (inCall) hangUp()
    onClose()
  }

  const sc = STATUS_CONFIG[status]

  const isActive = inCall || status === 'connecting'

  return (
    <div className={`fixed z-[100] transition-all duration-300 ease-in-out ${
      isMinimized
        ? 'bottom-6 right-6 w-16 h-16 rounded-full overflow-hidden'
        : 'bottom-6 right-6 w-[22rem]'
    }`}>
      {isMinimized ? (
        <button
          onClick={() => setIsMinimized(false)}
          className="w-full h-full bg-primary flex items-center justify-center text-white shadow-2xl"
        >
          <Maximize2 className="w-6 h-6" />
        </button>
      ) : (
        <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px] font-black text-white">G</span>
              </div>
              <div>
                <p className="text-sm font-bold text-foreground leading-none">Gemini AI</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Live voice call</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setIsMinimized(true)} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted">
                <Minimize2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleClose} className="p-1.5 text-muted-foreground hover:text-destructive transition-colors rounded-md hover:bg-muted">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Config (disabled during call) */}
          <div className="px-4 pt-3 pb-2 flex gap-2">
            <div className="relative flex-1">
              <select
                value={language}
                onChange={e => setLanguage(e.target.value)}
                disabled={isActive}
                className="w-full appearance-none bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground pr-6 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-primary"
              >
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
            <div className="relative flex-1">
              <select
                value={templateIdx}
                onChange={e => handleTemplateChange(Number(e.target.value))}
                disabled={isActive}
                className="w-full appearance-none bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground pr-6 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-primary"
              >
                {TEMPLATES.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
          </div>

          {/* Status bar */}
          <div className="px-4 pb-2">
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold w-fit ${sc.color}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
              {sc.label}
            </div>
          </div>

          {/* Avatar */}
          <div className="flex items-center justify-center py-1">
            <GeminiAvatar inCall={inCall} status={status} analyserRef={playAnalyserRef} width={220} height={200} mood={inCall ? (sentiment?.label ?? null) : null} />
          </div>

          {/* Transcript */}
          {transcript.length > 0 && (
            <div className="mx-4 mb-2 bg-muted/30 border border-border rounded-xl p-2.5 max-h-36 overflow-y-auto space-y-1.5">
              {transcript.map(entry => (
                entry.role === 'tool' ? (
                  <div key={entry.id} className="flex justify-center">
                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[10px] text-amber-700 dark:text-amber-300 font-mono">
                      🔧 {entry.toolName}
                    </div>
                  </div>
                ) : (
                <div key={entry.id} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-2.5 py-1.5 rounded-xl text-[11px] leading-relaxed ${
                    entry.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : 'bg-card border border-border text-foreground rounded-bl-sm'
                  }`}>
                    {entry.text}
                  </div>
                </div>
                )
              ))}
              <div ref={transcriptEndRef} />
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center justify-center gap-4 px-4 py-3 border-t border-border">
            {inCall && (
              <button
                onClick={() => setIsMuted(m => !m)}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all border ${
                  isMuted
                    ? 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20'
                    : 'bg-muted text-foreground border-border hover:bg-muted/80'
                }`}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            )}

            {!inCall ? (
              <button
                onClick={handleStart}
                disabled={status === 'connecting'}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg active:scale-95"
              >
                <Phone className="w-4 h-4" />
                Start Call
              </button>
            ) : (
              <button
                onClick={handleEnd}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-destructive text-white text-sm font-semibold hover:bg-destructive/90 transition-all shadow-md active:scale-95"
              >
                <PhoneOff className="w-4 h-4" />
                End Call
              </button>
            )}
          </div>

          <div className="text-[9px] text-muted-foreground/30 font-bold uppercase tracking-widest text-center pb-2">
            Gemini Live — Google AI
          </div>
        </div>
      )}
    </div>
  )
}
