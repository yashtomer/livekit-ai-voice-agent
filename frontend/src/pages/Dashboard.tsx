import { useEffect, useState, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader, AlertCircle, TrendingUp, ChevronRight, ChevronDown, Check, Lock } from 'lucide-react'
import Layout from '../components/Layout'
import CostEstimator from '../components/CostEstimator'
import CallInterface from '../components/CallInterface'
import TranscriptPanel from '../components/TranscriptPanel'
import MetricsPanel from '../components/MetricsPanel'
import { useModelStore, ModelOption } from '../store/modelStore'
import api from '../api/client'

function parseLatencyMs(label: string): number {
  const ms = label.match(/~(\d+(?:\.\d+)?)\s*ms/)
  if (ms) return parseFloat(ms[1])
  const s = label.match(/~(\d+(?:\.\d+)?)\s*s/)
  if (s) return parseFloat(s[1]) * 1000
  return 9999
}

function sortByLatency<T extends ModelOption>(list: T[]): T[] {
  return [...list].sort((a, b) => parseLatencyMs(a.label) - parseLatencyMs(b.label))
}

// Split "Name — FREE | detail1 | detail2" or "Name | detail1 | detail2"
// into a short display name + detail string.
function parseModelLabel(label: string): { name: string; details: string } {
  const dashIdx = label.indexOf(' — ')
  if (dashIdx !== -1) {
    return {
      name: label.slice(0, dashIdx).trim(),
      details: label.slice(dashIdx + 3).trim(),
    }
  }
  const pipeIdx = label.indexOf(' | ')
  if (pipeIdx === -1) return { name: label, details: '' }
  return {
    name: label.slice(0, pipeIdx).trim(),
    details: label.slice(pipeIdx + 3).trim(),
  }
}

function ModelSelect({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string
  options: ModelOption[]
  selected: ModelOption | null
  onSelect: (opt: ModelOption) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const sorted = sortByLatency(options)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selectedParsed = selected ? parseModelLabel(selected.label) : null
  const isFreeSelected = (selected?.price_per_hour ?? 0) === 0

  return (
    <div ref={containerRef} className="relative">
      <label className="label">{label}</label>

      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input-field w-full flex items-center justify-between gap-2 text-left cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-foreground truncate">
            {selectedParsed?.name ?? 'Select…'}
          </span>
          {selected && (
            <span className={`flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
              isFreeSelected
                ? 'bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400'
                : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
            }`}>
              {isFreeSelected ? 'FREE' : `$${selected.price_per_hour.toFixed(3)}/hr`}
            </span>
          )}
          {selected?.requires_api_key && (
            <span
              className="flex-shrink-0 flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive"
              title="API key required"
            >
              <Lock className="w-2.5 h-2.5" /> Key
            </span>
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown list */}
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-xl dark:shadow-none overflow-hidden max-h-60 overflow-y-auto">
          {sorted.map((opt) => {
            const { name, details } = parseModelLabel(opt.label)
            const isFree = opt.price_per_hour === 0
            const isSelected = opt.label === selected?.label
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => { onSelect(opt); setOpen(false) }}
                className={`w-full text-left px-3 py-2.5 transition-colors border-b border-border/40 last:border-0 ${
                  isSelected ? 'bg-primary/8' : 'hover:bg-muted'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-medium truncate ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                    {name}
                  </span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                      isFree
                        ? 'bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400'
                        : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
                    }`}>
                      {isFree ? 'FREE' : `$${opt.price_per_hour.toFixed(3)}/hr`}
                    </span>
                    {opt.requires_api_key && (
                      <span
                        className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive"
                        title="API key required"
                      >
                        <Lock className="w-2.5 h-2.5" /> Key
                      </span>
                    )}
                    {isSelected && <Check className="w-3 h-3 text-primary flex-shrink-0" />}
                  </div>
                </div>
                {details && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{details}</p>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const { setModels, selectedStt, selectedLlm, selectedTts, setSelectedStt, setSelectedLlm, setSelectedTts, models } =
    useModelStore()

  const { data: fxData } = useQuery({
    queryKey: ['fx-rate'],
    queryFn: () => api.get('/fx-rate').then((r) => r.data),
    staleTime: 3_600_000,
  })

  const { data: modelsData, isLoading, isError, refetch } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get('/models').then((r) => r.data),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (modelsData) setModels(modelsData)
  }, [modelsData, setModels])

  const fxRate = fxData?.rate ?? 0

  return (
    <Layout>
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-6">
        {/* Page header */}
        <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-foreground">AI Voice Cost Calculator</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Compare STT · LLM · TTS providers and estimate monthly costs
            </p>
          </div>
          {fxRate > 0 && (
            <div className="flex items-center gap-1.5 bg-card border border-border rounded-lg px-3 py-1.5 text-sm flex-shrink-0 shadow-sm dark:shadow-none">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              <span className="text-muted-foreground">1 USD</span>
              <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
              <span className="text-foreground font-semibold">₹{fxRate.toFixed(2)}</span>
              {fxData?.date && (
                <span className="text-muted-foreground/60 text-xs ml-0.5">· {fxData.date}</span>
              )}
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="flex flex-col items-center gap-3">
              <Loader className="w-8 h-8 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">Loading models…</p>
            </div>
          </div>
        ) : isError ? (
          <div className="flex items-center gap-3 bg-destructive/8 border border-destructive/25 rounded-xl p-4 text-destructive">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-sm">Failed to load models</p>
              <button onClick={() => refetch()} className="text-xs underline mt-0.5 opacity-70 hover:opacity-100">Retry</button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* ── Left column ── */}
            <div className="space-y-4">
              {/* Model config card */}
              <div className="card">
                <h3 className="section-title mb-4">
                  <span className="w-5 h-5 rounded-md bg-primary/10 flex items-center justify-center">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                  </span>
                  Model Configuration
                </h3>

                {modelsData?.ollama_error && (
                  <div className="flex items-center gap-1.5 text-xs text-yellow-600 dark:text-yellow-400 mb-3 bg-yellow-50 dark:bg-yellow-950/30 px-3 py-2 rounded-lg border border-yellow-200 dark:border-yellow-800">
                    <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    Ollama unreachable — local models unavailable
                  </div>
                )}

                <div className="space-y-3">
                  <ModelSelect
                    label="Speech-to-Text (STT)"
                    options={models?.stt ?? []}
                    selected={selectedStt}
                    onSelect={setSelectedStt}
                  />
                  <ModelSelect
                    label="Language Model (LLM)"
                    options={models?.llm ?? []}
                    selected={selectedLlm}
                    onSelect={setSelectedLlm}
                  />
                  <ModelSelect
                    label="Text-to-Speech (TTS)"
                    options={models?.tts ?? []}
                    selected={selectedTts}
                    onSelect={setSelectedTts}
                  />
                </div>

                {/* Per-model summary */}
                <div className="mt-4 pt-3 border-t border-border grid grid-cols-3 gap-2">
                  {[
                    { label: 'STT', m: selectedStt, color: 'bg-blue-500/10 border-blue-500/20' },
                    { label: 'LLM', m: selectedLlm, color: 'bg-amber-500/10 border-amber-500/20' },
                    { label: 'TTS', m: selectedTts, color: 'bg-green-500/10 border-green-500/20' },
                  ].map(({ label, m, color }) => {
                    const latency = m?.label.match(/~[\d.]+\s*(?:ms|s)/)?.[0]
                    const free = (m?.price_per_hour ?? 0) === 0
                    return (
                      <div key={label} className={`rounded-lg px-2.5 py-2 border ${color}`}>
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{label}</p>
                        <p className={`text-xs font-bold mt-0.5 ${free ? 'text-green-600 dark:text-green-400' : 'text-foreground'}`}>
                          {m ? (free ? 'FREE' : `$${m.price_per_hour.toFixed(3)}/hr`) : '—'}
                        </p>
                        {latency && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{latency}</p>}
                      </div>
                    )
                  })}
                </div>
              </div>

              <CostEstimator fxRate={fxRate} />
            </div>

            {/* ── Middle column ── */}
            <div className="space-y-4">
              <CallInterface />
              <MetricsPanel />
            </div>

            {/* ── Right column ── */}
            <div className="lg:h-[calc(100vh-160px)]">
              <TranscriptPanel />
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
