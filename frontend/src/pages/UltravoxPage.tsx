import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { UltravoxSession, UltravoxSessionStatus } from 'ultravox-client'
import {
  Phone, PhoneOff, Mic, MicOff, Loader2, Signal, Trash2, IndianRupee,
  AlertCircle, Volume2, PhoneCall, Calculator,
} from 'lucide-react'
import Layout from '../components/Layout'
import api from '../api/client'
import { useCallStore } from '../store/callStore'

/**
 * Standalone Ultravox page (replaces the old floating modal). Two tabs:
 *  - Voice Call: starts an Ultravox Realtime web call (POST /ultravox/create-web-call
 *    → join via ultravox-client) with live transcript, mute and hang-up.
 *  - Cost Calculator: monthly cost estimate, same model as the Gemini costing tab but
 *    using the Ultravox per-minute rate.
 */

// Ultravox published pricing (Pay-as-you-go / Pro). Adjustable in the calculator.
//  • Voice: $0.05 / min   • SIP (telephony): $0.005 / min (0.5¢)
//  • 30 free minutes included   • Pro plan: $100 / month flat
const ULTRAVOX_USD_PER_MIN = 0.05
const ULTRAVOX_SIP_USD_PER_MIN = 0.005
const ULTRAVOX_FREE_MINUTES = 30
const ULTRAVOX_PRO_FEE_USD = 100

type Tab = 'call' | 'costing'

export default function UltravoxPage() {
  const [tab, setTab] = useState<Tab>('call')
  return (
    <Layout>
      <div className="max-w-screen-xl mx-auto w-full px-4 sm:px-6 py-6 flex flex-col gap-5">
        {/* Header + tab switch */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Ultravox Realtime Voice</h1>
            <p className="text-sm text-muted-foreground">Low-latency AI voice calls powered by Ultravox</p>
          </div>
          <div className="flex items-center gap-1 bg-muted/50 border border-border rounded-xl p-1">
            <button
              onClick={() => setTab('call')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                tab === 'call' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <PhoneCall className="w-4 h-4" /> Voice Call
            </button>
            <button
              onClick={() => setTab('costing')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                tab === 'costing' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Calculator className="w-4 h-4" /> Cost Calculator
            </button>
          </div>
        </div>

        {tab === 'call' ? <UltravoxCallPanel /> : <UltravoxCosting />}
      </div>
    </Layout>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice Call
// ─────────────────────────────────────────────────────────────────────────────
function UltravoxCallPanel() {
  const [status, setStatus] = useState<UltravoxSessionStatus>(UltravoxSessionStatus.DISCONNECTED)
  const [isMuted, setIsMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<UltravoxSession | null>(null)
  const statusRef = useRef<UltravoxSessionStatus>(UltravoxSessionStatus.DISCONNECTED)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const { startCall, endCall, addMessage, setStatus: setStoreStatus, clearConversation } = useCallStore()
  const messages = useCallStore(s => s.messages)

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Always leave the call if the user navigates away.
  useEffect(() => {
    return () => {
      try { sessionRef.current?.leaveCall() } catch { /* noop */ }
      sessionRef.current = null
      endCall()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const syncStatus = (s: UltravoxSessionStatus) => {
    statusRef.current = s
    setStatus(s)
    if (s === UltravoxSessionStatus.IDLE) {
      startCall('ultravox-session', 300)
      setStoreStatus('connected')
    } else if (s === UltravoxSessionStatus.DISCONNECTED) {
      setStoreStatus('idle')
    }
  }

  const handleStart = async () => {
    if (sessionRef.current) return
    setError(null)
    clearConversation()
    try {
      statusRef.current = UltravoxSessionStatus.CONNECTING
      setStatus(UltravoxSessionStatus.CONNECTING)
      const { data } = await api.post('/ultravox/create-web-call')
      if (!data.joinUrl) throw new Error('No join URL received from server')

      const session = new UltravoxSession()
      sessionRef.current = session

      session.addEventListener('status', () => syncStatus(session.status))

      const seenFinals = new Set<string>()
      session.addEventListener('transcripts', () => {
        for (const t of session.transcripts) {
          if (!t.isFinal) continue
          const key = `${t.speaker}:${t.text}`
          if (seenFinals.has(key)) continue
          seenFinals.add(key)
          addMessage({ role: t.speaker === 'agent' ? 'agent' : 'user', text: t.text })
        }
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.addEventListener('error', (event: any) => {
        setError(`Connection Error: ${event?.message || 'Check your internet or Ultravox balance.'}`)
      })

      await session.joinCall(data.joinUrl)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to start call'
      setError(String(msg).includes('402') ? 'Ultravox balance empty. Please top up.' : msg)
      setStatus(UltravoxSessionStatus.DISCONNECTED)
      setStoreStatus('error')
      try { sessionRef.current?.leaveCall() } catch { /* noop */ }
      sessionRef.current = null
    }
  }

  const handleHangup = () => {
    try { sessionRef.current?.leaveCall() } catch { /* noop */ }
    sessionRef.current = null
    setStatus(UltravoxSessionStatus.DISCONNECTED)
    setStoreStatus('idle')
    endCall()
  }

  const toggleMute = () => {
    const session = sessionRef.current
    if (!session) return
    const next = !isMuted
    setIsMuted(next)
    // ultravox-client exposes muteMic/unmuteMic; guard in case of SDK version drift.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    try { next ? s.muteMic?.() : s.unmuteMic?.() } catch { /* noop */ }
  }

  const isConnecting = status === UltravoxSessionStatus.CONNECTING
  const isLive =
    status === UltravoxSessionStatus.IDLE ||
    status === UltravoxSessionStatus.LISTENING ||
    status === UltravoxSessionStatus.THINKING ||
    status === UltravoxSessionStatus.SPEAKING
  const liveLabel =
    status === UltravoxSessionStatus.SPEAKING ? 'Speaking' :
    status === UltravoxSessionStatus.THINKING ? 'Thinking' :
    status === UltravoxSessionStatus.LISTENING ? 'Listening' : 'Live'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
      {/* Call stage */}
      <div className="card flex flex-col items-center gap-6 py-10 min-h-[460px] justify-center relative">
        {/* status row */}
        <div className="absolute top-4 left-5 flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-green-500' : isConnecting ? 'bg-yellow-500 animate-ping' : 'bg-muted-foreground/30'}`} />
          <span className="text-muted-foreground">{isConnecting ? 'Connecting…' : isLive ? 'Connected' : 'Disconnected'}</span>
        </div>

        {/* orb */}
        <div className="relative">
          <div className={`w-28 h-28 rounded-full bg-primary/5 flex items-center justify-center border-2 border-primary/20 ${isLive ? 'ring-4 ring-primary/10 animate-pulse' : ''}`}>
            <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-primary to-primary/40 flex items-center justify-center shadow-2xl">
              <span className="text-2xl font-black tracking-tighter text-white">UV</span>
            </div>
          </div>
          {isLive && (
            <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-4 border-card flex items-center justify-center shadow-lg">
              <div className="w-1.5 h-1.5 bg-white rounded-full animate-ping" />
            </div>
          )}
        </div>

        <div className="text-center space-y-1">
          <h2 className="text-lg font-bold text-foreground">Ultravox AI</h2>
          <div className="flex items-center justify-center gap-2">
            <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md ${isLive ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}>
              {isConnecting ? 'Connecting…' : isLive ? liveLabel : 'Ready'}
            </span>
            {isLive && <span className="text-[10px] text-muted-foreground font-medium flex items-center gap-1"><Signal className="w-3 h-3" /> Encrypted</span>}
          </div>
        </div>

        {/* waveform / state */}
        <div className="h-16 flex items-center justify-center gap-1.5 w-full px-4">
          {isLive ? (
            [...Array(12)].map((_, i) => (
              <div
                key={i}
                className="w-1 bg-primary/80 rounded-full animate-voice-wave"
                style={{ height: `${20 + Math.random() * 60}%`, animationDelay: `${i * 0.08}s`, opacity: 0.3 + (i / 12) * 0.7 }}
              />
            ))
          ) : isConnecting && !error ? (
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          ) : error ? (
            <AlertCircle className="w-8 h-8 text-destructive" />
          ) : (
            <Volume2 className="w-6 h-6 text-muted-foreground/20" />
          )}
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2 max-w-sm">
            <p className="text-[11px] text-destructive text-center font-medium leading-tight">{error}</p>
          </div>
        )}

        {/* controls */}
        <div className="flex items-center gap-5">
          {isLive && (
            <button
              onClick={toggleMute}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all border ${
                isMuted
                  ? 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20'
                  : 'bg-muted text-foreground border-border hover:bg-muted/80'
              }`}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
          )}

          {!isLive && !isConnecting ? (
            <button
              onClick={handleStart}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-md active:scale-95"
            >
              <Phone className="w-4 h-4" /> Start Call
            </button>
          ) : (
            <button
              onClick={handleHangup}
              disabled={isConnecting}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-destructive text-white text-sm font-semibold hover:bg-destructive/90 transition-all shadow-md active:scale-95 disabled:opacity-60"
            >
              <PhoneOff className="w-4 h-4" /> End Call
            </button>
          )}
        </div>

        <div className="text-[9px] text-muted-foreground/40 font-bold uppercase tracking-[0.2em]">
          Ultravox Realtime Protocol
        </div>
      </div>

      {/* Transcript */}
      <div className="card flex flex-col gap-3 min-h-[460px]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Transcript</h2>
          {messages.length > 0 && (
            <button
              onClick={clearConversation}
              className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto space-y-2 -mr-1 pr-1">
          {messages.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 text-center py-8">
              {isLive ? 'Listening… start speaking' : 'Start a call to see the live transcript.'}
            </p>
          ) : (
            messages.map(m => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-card border border-border text-foreground rounded-bl-sm'
                }`}>
                  <span className="block text-[10px] font-bold opacity-60 mb-0.5">{m.role === 'user' ? 'You' : 'Ultravox'}</span>
                  {m.text}
                </div>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost Calculator (mirrors the Gemini costing tab, with the Ultravox rate)
// ─────────────────────────────────────────────────────────────────────────────
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

function UltravoxCosting() {
  const { data: fxData } = useQuery({
    queryKey: ['fx-rate'],
    queryFn: () => api.get('/fx-rate').then(r => r.data),
    staleTime: 3_600_000,
  })

  const [hoursPerDay, setHoursPerDay] = useState(2)
  const [daysPerMonth, setDaysPerMonth] = useState(30)
  const [uvUsdPerMin, setUvUsdPerMin] = useState(ULTRAVOX_USD_PER_MIN)
  const [freeMinutes, setFreeMinutes] = useState(ULTRAVOX_FREE_MINUTES)
  const [includeSip, setIncludeSip] = useState(false)
  const [sipUsdPerMin, setSipUsdPerMin] = useState(ULTRAVOX_SIP_USD_PER_MIN)
  const [proPlan, setProPlan] = useState(false)
  const [usdToInr, setUsdToInr] = useState(83)
  const [fxOverridden, setFxOverridden] = useState(false)

  useEffect(() => {
    if (!fxOverridden && fxData?.rate > 0) setUsdToInr(fxData.rate)
  }, [fxData, fxOverridden])

  const minutesPerMonth = hoursPerDay * 60 * daysPerMonth
  const billableMinutes = Math.max(0, minutesPerMonth - freeMinutes)
  const planFeeUsd = proPlan ? ULTRAVOX_PRO_FEE_USD : 0
  const perMinUsd = uvUsdPerMin + (includeSip ? sipUsdPerMin : 0)
  const perMinInr = perMinUsd * usdToInr
  const monthlyUsd = billableMinutes * perMinUsd + planFeeUsd
  const monthlyInr = monthlyUsd * usdToInr
  const dailyInr = perMinInr * hoursPerDay * 60 // gross per-day usage (excludes free tier)

  const fmtInr = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Inputs */}
      <div className="card flex flex-col gap-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Usage</h2>
        <div className="grid grid-cols-2 gap-3">
          <CostingField label="Hours / day" value={hoursPerDay} onChange={setHoursPerDay} step={0.5} suffix="hrs" />
          <CostingField label="Days / month" value={daysPerMonth} onChange={setDaysPerMonth} step={1} suffix="days" />
          <CostingField label="Free minutes" value={freeMinutes} onChange={setFreeMinutes} step={5} suffix="free" />
        </div>

        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground mt-2">Rates</h2>
        <div className="grid grid-cols-2 gap-3">
          <CostingField label="Ultravox voice" value={uvUsdPerMin} onChange={setUvUsdPerMin} step={0.01} suffix="$ / min" />
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
            checked={includeSip}
            onChange={e => setIncludeSip(e.target.checked)}
            className="w-4 h-4 accent-primary"
          />
          Include SIP / telephony (phone calls)
        </label>
        {includeSip && (
          <CostingField label="SIP" value={sipUsdPerMin} onChange={setSipUsdPerMin} step={0.001} suffix="$ / min" />
        )}

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={proPlan}
            onChange={e => setProPlan(e.target.checked)}
            className="w-4 h-4 accent-primary"
          />
          Pro plan (+${ULTRAVOX_PRO_FEE_USD}/mo — no concurrency caps)
        </label>

        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          Ultravox pricing: <strong>$0.05 / min</strong> voice, <strong>30 free min</strong> included, SIP/telephony
          <strong> $0.005 / min</strong> (0.5¢), <strong>Pro</strong> $100/mo (removes the 5-concurrent-call cap).
          Browser web calls have no SIP charge. Enterprise = custom — adjust rates to match your contract.
        </p>
      </div>

      {/* Estimate */}
      <div className="card flex flex-col gap-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Estimate</h2>

        <div className="bg-primary/10 border border-primary/20 rounded-xl p-5 flex flex-col items-center gap-1">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Monthly cost</span>
          <span className="text-4xl font-bold text-primary flex items-center">
            <IndianRupee className="w-7 h-7" />
            {fmtInr(monthlyInr)}
          </span>
          <span className="text-xs text-muted-foreground">
            per month · ≈ ${monthlyUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            {proPlan && <> (incl. ${ULTRAVOX_PRO_FEE_USD} plan)</>}
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
            <div className="text-[11px] font-medium text-muted-foreground/70">≈ ${perMinUsd.toFixed(3)}{includeSip ? ' (voice+SIP)' : ''}</div>
          </div>
          <div className="bg-muted/40 border border-border rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Billable min / mo</div>
            <div className="text-lg font-bold text-foreground">{billableMinutes.toLocaleString('en-IN')}</div>
            <div className="text-[11px] font-medium text-muted-foreground/70">{minutesPerMonth.toLocaleString('en-IN')} − {freeMinutes} free</div>
          </div>
          <div className="bg-muted/40 border border-border rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Voice rate</div>
            <div className="text-lg font-bold text-foreground">₹{(uvUsdPerMin * usdToInr).toFixed(2)} / min</div>
            <div className="text-[11px] font-medium text-muted-foreground/70">≈ ${uvUsdPerMin.toFixed(3)} / min</div>
          </div>
        </div>

        <div className="text-[11px] text-muted-foreground border-t border-border pt-3 leading-relaxed">
          Formula: <code className="font-mono">max(0, mins/mo − free) × (voice{includeSip ? ' + SIP' : ''} $/min){proPlan ? ' + $100 plan' : ''}</code>.
          Adjust rates above to match your actual contract.
        </div>
      </div>
    </div>
  )
}
