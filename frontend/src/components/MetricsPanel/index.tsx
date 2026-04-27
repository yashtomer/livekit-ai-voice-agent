import { Activity, Zap, MessageSquare, Volume2, Mic, ChevronRight } from 'lucide-react'
import { useCallStore, PipelineStage } from '../../store/callStore'

// ── Pipeline stage config ────────────────────────────────────────────────────

interface StageConfig {
  key: 'listening' | 'stt' | 'llm' | 'tts'
  label: string
  shortLabel: string
  icon: React.ComponentType<{ className?: string }>
  color: string          // text / ring
  bg: string             // background when active
  activeBg: string       // pulse ring color
}

const STAGES: StageConfig[] = [
  {
    key: 'listening',
    label: 'Listening',
    shortLabel: 'MIC',
    icon: Mic,
    color: 'text-sky-500 dark:text-sky-400',
    bg: 'bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-800',
    activeBg: 'ring-sky-400/40',
  },
  {
    key: 'stt',
    label: 'Speech-to-Text',
    shortLabel: 'STT',
    icon: Zap,
    color: 'text-blue-500 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800',
    activeBg: 'ring-blue-400/40',
  },
  {
    key: 'llm',
    label: 'Language Model',
    shortLabel: 'LLM',
    icon: MessageSquare,
    color: 'text-amber-500 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800',
    activeBg: 'ring-amber-400/40',
  },
  {
    key: 'tts',
    label: 'Text-to-Speech',
    shortLabel: 'TTS',
    icon: Volume2,
    color: 'text-green-500 dark:text-green-400',
    bg: 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800',
    activeBg: 'ring-green-400/40',
  },
]

// Which stages are "done" given the current pipeline stage
function getStageStatus(stageKey: StageConfig['key'], pipelineStage: PipelineStage): 'inactive' | 'active' | 'done' {
  const order: PipelineStage[] = ['listening', 'stt', 'llm', 'tts']
  const currentIdx = order.indexOf(pipelineStage)
  const stageIdx = order.indexOf(stageKey)

  if (pipelineStage === 'idle') return 'inactive'
  if (stageKey === pipelineStage) return 'active'
  if (stageIdx < currentIdx) return 'done'
  return 'inactive'
}

// ── Pipeline indicator ───────────────────────────────────────────────────────

function PipelineIndicator({ pipelineStage }: { pipelineStage: PipelineStage }) {
  const metrics = useCallStore((s) => s.metrics)

  const latencyMap: Record<StageConfig['key'], number | null> = {
    listening: null,
    stt: metrics.stt_ms,
    llm: metrics.llm_ms,
    tts: metrics.tts_ms,
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-muted/50 p-3">
      <div className="flex items-center justify-between gap-1">
        {STAGES.map((stage, i) => {
          const status = getStageStatus(stage.key, pipelineStage)
          const Icon = stage.icon
          const latency = latencyMap[stage.key]

          return (
            <div key={stage.key} className="flex items-center gap-1 min-w-0 flex-1">
              {/* Stage node */}
              <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div
                  className={`
                    relative flex items-center justify-center w-9 h-9 rounded-xl border-2 transition-all duration-300
                    ${status === 'active'
                      ? `${stage.bg} ring-4 ${stage.activeBg} shadow-sm`
                      : status === 'done'
                      ? 'bg-muted border-border/60 opacity-70'
                      : 'bg-muted border-border/40 opacity-40'}
                  `}
                >
                  <Icon
                    className={`w-4 h-4 transition-colors duration-300 ${
                      status === 'active' ? stage.color
                      : status === 'done' ? 'text-muted-foreground'
                      : 'text-muted-foreground/40'
                    }`}
                  />
                  {/* Pulsing dot when active */}
                  {status === 'active' && (
                    <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full animate-pulse ${
                      stage.key === 'listening' ? 'bg-sky-500'
                      : stage.key === 'stt' ? 'bg-blue-500'
                      : stage.key === 'llm' ? 'bg-amber-500'
                      : 'bg-green-500'
                    }`} />
                  )}
                </div>

                {/* Label + latency */}
                <div className="text-center">
                  <div className={`text-[10px] font-semibold leading-none tracking-wide transition-colors duration-300 ${
                    status === 'active' ? stage.color
                    : status === 'done' ? 'text-muted-foreground'
                    : 'text-muted-foreground/40'
                  }`}>
                    {stage.shortLabel}
                  </div>
                  {latency !== null && status === 'done' && (
                    <div className="text-[9px] text-muted-foreground/60 mt-0.5 font-mono">
                      {latency}ms
                    </div>
                  )}
                  {status === 'active' && (
                    <div className={`text-[9px] font-medium mt-0.5 ${stage.color}`}>
                      active
                    </div>
                  )}
                </div>
              </div>

              {/* Arrow connector (not after last item) */}
              {i < STAGES.length - 1 && (
                <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-colors duration-300 ${
                  getStageStatus(STAGES[i + 1].key, pipelineStage) !== 'inactive' || pipelineStage === 'idle'
                    ? 'text-muted-foreground/30'
                    : 'text-muted-foreground/15'
                }`} />
              )}
            </div>
          )
        })}
      </div>

      {/* Stage description text */}
      <div className="mt-2.5 text-center text-xs text-muted-foreground/70">
        {pipelineStage === 'idle' && 'Start a call to see live pipeline activity'}
        {pipelineStage === 'listening' && 'Waiting for speech input…'}
        {pipelineStage === 'stt' && 'Transcribing speech…'}
        {pipelineStage === 'llm' && 'Generating response…'}
        {pipelineStage === 'tts' && 'Synthesizing audio…'}
      </div>
    </div>
  )
}

// ── Metric card ──────────────────────────────────────────────────────────────

// Latency-quality thresholds (ms). Anything below `good` is fast, between
// `good` and `ok` is acceptable, above `ok` is too slow for natural voice.
const QUALITY_THRESHOLDS: Record<string, { good: number; ok: number }> = {
  stt: { good: 800, ok: 2000 },
  llm: { good: 1500, ok: 4000 },
  tts: { good: 800, ok: 2000 },
  ttft: { good: 500, ok: 1500 },
}

function qualityForValue(key: string, ms: number | null): 'good' | 'ok' | 'poor' | null {
  if (ms === null) return null
  const t = QUALITY_THRESHOLDS[key]
  if (!t) return null
  if (ms < t.good) return 'good'
  if (ms < t.ok) return 'ok'
  return 'poor'
}

const QUALITY_DOT: Record<'good' | 'ok' | 'poor', string> = {
  good: 'bg-green-500',
  ok: 'bg-yellow-500',
  poor: 'bg-red-500',
}

function MetricCard({
  label,
  qualityKey,
  tooltip,
  value,
  unit,
  icon: Icon,
  iconClass,
  valueClass,
}: {
  label: string
  qualityKey: string
  tooltip: string
  value: number | null
  unit: string
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
  valueClass: string
}) {
  const quality = qualityForValue(qualityKey, value)
  return (
    <div
      className="bg-muted rounded-xl p-3 border border-border hover:border-border/80 transition-colors"
      title={tooltip}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className={`w-3.5 h-3.5 ${iconClass}`} />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {quality && (
          <span className={`ml-auto w-1.5 h-1.5 rounded-full ${QUALITY_DOT[quality]}`}
                title={quality === 'good' ? 'Fast' : quality === 'ok' ? 'Acceptable' : 'Too slow for natural voice'} />
        )}
      </div>
      <div className={`text-xl font-bold tracking-tight ${value !== null ? valueClass : 'text-muted-foreground/30'}`}>
        {value !== null ? value.toLocaleString() : '—'}
        {value !== null && <span className="text-xs font-normal text-muted-foreground ml-1">{unit}</span>}
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function MetricsPanel() {
  const { metrics, pipelineStage } = useCallStore()

  return (
    <div className="card">
      <h3 className="section-title mb-3">
        <Activity className="w-4 h-4 text-primary" />
        Live Metrics
      </h3>

      <PipelineIndicator pipelineStage={pipelineStage} />

      <div className="grid grid-cols-2 gap-2.5">
        <MetricCard
          label="STT latency"
          qualityKey="stt"
          tooltip="Speech-to-Text — how long Whisper / Deepgram took to transcribe the user's last utterance. Under 800 ms feels natural."
          value={metrics.stt_ms}
          unit="ms"
          icon={Zap}
          iconClass="text-blue-500 dark:text-blue-400"
          valueClass="text-blue-600 dark:text-blue-400"
        />
        <MetricCard
          label="LLM latency"
          qualityKey="llm"
          tooltip="Total LLM response time end-to-end (TTFT + token generation). Under 1.5 s is comfortable for live voice."
          value={metrics.llm_ms}
          unit="ms"
          icon={MessageSquare}
          iconClass="text-amber-500 dark:text-amber-400"
          valueClass="text-amber-600 dark:text-amber-400"
        />
        <MetricCard
          label="TTS latency"
          qualityKey="tts"
          tooltip="Text-to-Speech — how long synthesis of the agent's reply took. Under 800 ms is good."
          value={metrics.tts_ms}
          unit="ms"
          icon={Volume2}
          iconClass="text-green-500 dark:text-green-400"
          valueClass="text-green-600 dark:text-green-400"
        />
        <MetricCard
          label="TTFT"
          qualityKey="ttft"
          tooltip="Time-To-First-Token — how long the LLM waits before starting to stream a response. Under 500 ms is the gold standard for voice."
          value={metrics.ttft_ms}
          unit="ms"
          icon={Zap}
          iconClass="text-purple-500 dark:text-purple-400"
          valueClass="text-purple-600 dark:text-purple-400"
        />
      </div>
      {(metrics.tokens_per_second !== null || metrics.total_tokens !== null) && (
        <div className="mt-2.5 bg-muted rounded-lg px-3 py-2 border border-border space-y-1.5">
          {metrics.tokens_per_second !== null && (
            <div className="flex items-center justify-between text-xs">
              <div>
                <span className="text-muted-foreground font-medium">Output tok/s</span>
                <span className="text-muted-foreground/50 ml-1 text-[10px]">generation speed</span>
              </div>
              <span className="text-amber-600 dark:text-amber-400 font-bold">
                {metrics.tokens_per_second} <span className="text-muted-foreground font-normal">tok/s</span>
              </span>
            </div>
          )}
          {metrics.total_tokens !== null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">Total tokens</span>
              <span className="text-foreground font-semibold">{metrics.total_tokens.toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
