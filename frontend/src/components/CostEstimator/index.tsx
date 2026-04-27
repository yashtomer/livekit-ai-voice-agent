import { useState, useEffect, useRef } from 'react'
import { DollarSign, TrendingUp, Users, Clock, Server, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { useModelStore } from '../../store/modelStore'

type CloudProvider = 'aws' | 'gcp'

interface CostEstimatorProps { fxRate: number }

interface ServerTier {
  grade: 'BEST' | 'GOOD' | 'OK' | 'N/A'
  gradeClass: 'best' | 'good' | 'ok' | 'cloud'
  instance: string
  specs: string
  perHour: number
  latency: string
  icon: string
  tip: string
  /** How many concurrent voice-agent sessions one of these can host. Used by
   *  the cost estimator to compute servers_needed = ceil(agents / concurrent),
   *  which is how cloud bills actually work — one g5.xlarge does ~5 simultaneous
   *  small-LLM streams, not just one. */
  concurrentAgents: number
}

interface ServerScenario {
  scenario: string
  description: string
  options: ServerTier[]
}

// ── AWS instance data ────────────────────────────────────────────────────────

const AWS_SCENARIOS: Record<string, ServerScenario> = {
  cloud: {
    scenario: 'Pure Cloud — agent worker only',
    description: 'All AI services run via cloud APIs — only a small server is needed to host the LiveKit agent worker.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 't3.medium', specs: '2 vCPU · 4 GB RAM · burstable', perHour: 0.0416, latency: '~0.4s', icon: '🖥️', tip: 'Minimal worker host for the LiveKit agent process.', concurrentAgents: 8 },
      { grade: 'GOOD', gradeClass: 'good', instance: 't3.small', specs: '2 vCPU · 2 GB RAM · burstable', perHour: 0.0208, latency: '~0.5s', icon: '🖥️', tip: 'Tighter RAM but cheaper — works for low concurrency.', concurrentAgents: 4 },
      { grade: 'OK', gradeClass: 'ok', instance: 't4g.small', specs: 'ARM · 2 vCPU · 2 GB RAM', perHour: 0.0168, latency: '~0.5s', icon: '🖥️', tip: 'Cheapest option — Graviton ARM, ensure your image is multi-arch.', concurrentAgents: 4 },
    ],
  },
  fully_local: {
    scenario: 'Local models — production GPU',
    description: 'Local LLM, STT or TTS picked. Production traffic needs a GPU host — pick a tier below.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g5.xlarge', specs: 'NVIDIA A10G · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 1.006, latency: '<0.4s', icon: '⚡⚡', tip: 'A10G — flagship realtime, best end-to-end latency.', concurrentAgents: 5 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'g6.xlarge', specs: 'NVIDIA L4 · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.8048, latency: '<0.6s', icon: '⚡', tip: 'L4 GPU — newer Ada arch, ~20% cheaper than A10G with similar realtime latency.', concurrentAgents: 4 },
      { grade: 'OK', gradeClass: 'ok', instance: 'g4dn.xlarge', specs: 'NVIDIA T4 · 16 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.526, latency: '<0.8s', icon: '⚡', tip: 'T4 GPU — cheapest GPU option, fine for ≤8B models on low concurrency.', concurrentAgents: 3 },
    ],
  },
  stt_tts_only: {
    scenario: 'Local STT/TTS only',
    description: 'No local LLM — a CPU instance is enough to run Whisper + Piper in real time.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'c5.xlarge', specs: '4 vCPU · 8 GB RAM · compute-optimized', perHour: 0.17, latency: '<1.5s', icon: '🖥️', tip: 'Fast CPU keeps STT/TTS latency low. Recommended for production.', concurrentAgents: 4 },
      { grade: 'GOOD', gradeClass: 'good', instance: 't3.large', specs: '2 vCPU · 8 GB RAM · general-purpose', perHour: 0.0832, latency: '<2s', icon: '🖥️', tip: 'Solid balance — adequate for most STT/TTS workloads.', concurrentAgents: 2 },
      { grade: 'OK', gradeClass: 'ok', instance: 't3.medium', specs: '2 vCPU · 4 GB RAM', perHour: 0.0416, latency: '~2–3s', icon: '🖥️', tip: 'Bare minimum. Whisper base + Piper fit tightly in 4 GB RAM.', concurrentAgents: 1 },
    ],
  },
  llm_small: {
    scenario: 'Small–Mid LLM (≤ 10B)',
    description: 'GPU required for real-time voice. CPU falls back to 4–6s latency.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g5.xlarge', specs: 'NVIDIA A10G · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 1.006, latency: '<0.4s', icon: '⚡⚡', tip: 'A10G — flagship real-time.', concurrentAgents: 5 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'g6.xlarge', specs: 'NVIDIA L4 · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.8048, latency: '<0.6s', icon: '⚡', tip: 'L4 GPU — newer than T4, ~20% cheaper than A10G.', concurrentAgents: 4 },
      { grade: 'OK', gradeClass: 'ok', instance: 'g4dn.xlarge', specs: 'NVIDIA T4 · 16 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.526, latency: '<0.8s', icon: '⚡', tip: 'T4 GPU — cheapest GPU, good for ≤8B models on low concurrency.', concurrentAgents: 3 },
    ],
  },
  llm_mid: {
    scenario: 'Mid LLM (13B–32B)',
    description: 'A10G/L4 GPU needed to keep inference real-time. 24 GB VRAM minimum.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g5.2xlarge', specs: 'NVIDIA A10G · 24 GB VRAM · 8 vCPU · 32 GB RAM', perHour: 1.212, latency: '<0.7s', icon: '⚡⚡', tip: 'A10G + extra RAM — highest quality at real-time speed.', concurrentAgents: 3 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'g6.2xlarge', specs: 'NVIDIA L4 · 24 GB VRAM · 8 vCPU · 32 GB RAM', perHour: 0.9776, latency: '<1s', icon: '⚡', tip: 'L4 — newer Ada arch, ~20% cheaper than A10G with similar latency.', concurrentAgents: 2 },
      { grade: 'OK', gradeClass: 'ok', instance: 'g4dn.2xlarge', specs: 'NVIDIA T4 · 16 GB VRAM · 8 vCPU · 32 GB RAM', perHour: 0.752, latency: '1–2s', icon: '⚡', tip: 'T4 — works with Q4-quantized 13B.', concurrentAgents: 1 },
    ],
  },
  llm_large: {
    scenario: 'Large LLM (70B+)',
    description: 'Flagship hardware needed — 40 GB+ VRAM for 70B models (quantized).',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g6e.xlarge', specs: 'NVIDIA L40S · 48 GB VRAM · 4 vCPU · 32 GB RAM', perHour: 1.86, latency: '<1s', icon: '⚡⚡⚡', tip: 'L40S fits 70B-Q4 comfortably.', concurrentAgents: 2 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'g5.2xlarge', specs: 'NVIDIA A10G · 24 GB VRAM · 8 vCPU · 32 GB RAM', perHour: 1.212, latency: '1–1.5s', icon: '⚡⚡', tip: 'A10G with extra RAM — 70B-Q4 fits tightly.', concurrentAgents: 1 },
      { grade: 'OK', gradeClass: 'ok', instance: 'g5.xlarge', specs: 'NVIDIA A10G · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 1.006, latency: '1.5–3s', icon: '⚡', tip: 'Bare minimum for 70B-Q4.', concurrentAgents: 1 },
    ],
  },
}

// ── GCP instance data (us-central1, on-demand) ───────────────────────────────

const GCP_SCENARIOS: Record<string, ServerScenario> = {
  cloud: {
    scenario: 'Pure Cloud — agent worker only',
    description: 'All AI services run via cloud APIs — only a small VM is needed to host the LiveKit agent worker.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'e2-small', specs: '2 vCPU · 2 GB RAM · cost-optimised', perHour: 0.0167, latency: '~0.4s', icon: '🖥️', tip: 'Minimal worker host for the LiveKit agent process.', concurrentAgents: 8 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'e2-micro', specs: '2 vCPU · 1 GB RAM', perHour: 0.0084, latency: '~0.5s', icon: '🖥️', tip: 'Cheapest still-reliable option for low concurrency.', concurrentAgents: 4 },
      { grade: 'OK', gradeClass: 'ok', instance: 'f1-micro (legacy)', specs: '0.2 vCPU · 0.6 GB RAM', perHour: 0.0076, latency: '~0.6s', icon: '🖥️', tip: 'Bottom-of-stack — only acceptable for prototypes.', concurrentAgents: 2 },
    ],
  },
  fully_local: {
    scenario: 'Local models — production GPU',
    description: 'Local LLM, STT or TTS picked. Production traffic needs a GPU host — pick a tier below.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g2-standard-4', specs: 'NVIDIA L4 · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.71, latency: '<0.4s', icon: '⚡⚡', tip: 'L4 GPU — GCP flagship for ≤8B realtime inference.', concurrentAgents: 5 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'n1-standard-4 + T4', specs: 'NVIDIA T4 · 16 GB VRAM · 4 vCPU · 15 GB RAM', perHour: 0.54, latency: '<0.8s', icon: '⚡', tip: 'N1 + T4 — great price/performance on GCP.', concurrentAgents: 3 },
      { grade: 'OK', gradeClass: 'ok', instance: 'n1-standard-2 + T4', specs: 'NVIDIA T4 · 16 GB VRAM · 2 vCPU · 7.5 GB RAM', perHour: 0.45, latency: '~1.2s', icon: '⚡', tip: 'Cheapest T4 option — fine for single concurrent stream.', concurrentAgents: 2 },
    ],
  },
  stt_tts_only: {
    scenario: 'Local STT/TTS only',
    description: 'No local LLM — CPU instance handles Whisper + Piper.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'c2-standard-4', specs: '4 vCPU · 16 GB RAM · compute-optimized', perHour: 0.209, latency: '<1.5s', icon: '🖥️', tip: 'Compute-optimized C2 — keeps STT/TTS latency low.', concurrentAgents: 4 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'n2-standard-2', specs: '2 vCPU · 8 GB RAM · general-purpose', perHour: 0.097, latency: '<2s', icon: '🖥️', tip: 'N2 — solid balance for most STT/TTS workloads.', concurrentAgents: 2 },
      { grade: 'OK', gradeClass: 'ok', instance: 'e2-medium', specs: '2 vCPU · 4 GB RAM · cost-optimized', perHour: 0.034, latency: '~2–3s', icon: '🖥️', tip: 'Bare minimum. Whisper base + Piper fit tightly in 4 GB RAM.', concurrentAgents: 1 },
    ],
  },
  llm_small: {
    scenario: 'Small–Mid LLM (≤ 10B)',
    description: 'GPU required for real-time voice. CPU falls back to 4–6s latency — not viable for live calls.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g2-standard-4', specs: 'NVIDIA L4 · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.71, latency: '<0.4s', icon: '⚡⚡', tip: 'L4 GPU — flagship real-time inference on GCP.', concurrentAgents: 5 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'n1-standard-4 + T4', specs: 'NVIDIA T4 · 16 GB VRAM · 4 vCPU · 15 GB RAM', perHour: 0.54, latency: '<0.8s', icon: '⚡', tip: 'N1 + T4 — excellent price/latency on GCP.', concurrentAgents: 3 },
      { grade: 'OK', gradeClass: 'ok', instance: 'n1-standard-2 + T4', specs: 'NVIDIA T4 · 16 GB VRAM · 2 vCPU · 7.5 GB RAM', perHour: 0.45, latency: '~1.2s', icon: '⚡', tip: 'Cheapest T4 — fine for low concurrency.', concurrentAgents: 2 },
    ],
  },
  llm_mid: {
    scenario: 'Mid LLM (13B–32B)',
    description: 'L4 GPU needed for real-time inference. 24 GB VRAM minimum.',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'g2-standard-8', specs: 'NVIDIA L4 · 24 GB VRAM · 8 vCPU · 32 GB RAM', perHour: 1.05, latency: '<0.7s', icon: '⚡⚡', tip: 'L4 + extra RAM — highest quality at real-time speed.', concurrentAgents: 3 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'g2-standard-4', specs: 'NVIDIA L4 · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.71, latency: '<1s', icon: '⚡', tip: 'L4 — solid real-time for 13B models.', concurrentAgents: 2 },
      { grade: 'OK', gradeClass: 'ok', instance: 'n1-standard-8 + T4', specs: 'NVIDIA T4 · 16 GB VRAM · 8 vCPU · 30 GB RAM', perHour: 0.73, latency: '1–2s', icon: '⚡', tip: 'T4 — works with Q4-quantized 13B models.', concurrentAgents: 1 },
    ],
  },
  llm_large: {
    scenario: 'Large LLM (70B+)',
    description: 'Flagship hardware — 40 GB+ VRAM for 70B models (quantized).',
    options: [
      { grade: 'BEST', gradeClass: 'best', instance: 'a2-highgpu-1g', specs: 'NVIDIA A100 · 40 GB VRAM · 12 vCPU · 85 GB RAM', perHour: 3.67, latency: '<0.6s', icon: '⚡⚡⚡', tip: 'A100 — comfortably runs 70B-Q4 with headroom.', concurrentAgents: 3 },
      { grade: 'GOOD', gradeClass: 'good', instance: 'g2-standard-8', specs: 'NVIDIA L4 · 24 GB VRAM · 8 vCPU · 32 GB RAM', perHour: 1.05, latency: '1–1.5s', icon: '⚡⚡', tip: 'L4 + 32 GB RAM — 70B-Q4 fits with quantization.', concurrentAgents: 1 },
      { grade: 'OK', gradeClass: 'ok', instance: 'g2-standard-4', specs: 'NVIDIA L4 · 24 GB VRAM · 4 vCPU · 16 GB RAM', perHour: 0.71, latency: '1.5–3s', icon: '⚡', tip: 'Bare minimum for 70B-Q4 on GCP.', concurrentAgents: 1 },
    ],
  },
}

// ── Scenario recommendation ───────────────────────────────────────────────────

type Profile = 'none' | 'cpu_light' | 'cpu_heavy' | 'gpu_small' | 'gpu_mid' | 'gpu_large'

const PROFILE_RANK: Record<Profile, number> = {
  none: 0, cpu_light: 1, cpu_heavy: 2, gpu_small: 3, gpu_mid: 4, gpu_large: 5,
}

function profileFromModel(m: { compute_profile?: string; provider?: string; model?: string } | null): Profile {
  if (!m) return 'none'
  if (m.compute_profile && m.compute_profile in PROFILE_RANK) return m.compute_profile as Profile
  // Fallback for older payloads: infer from provider / param count.
  if (m.provider === 'ollama') {
    const match = (m.model ?? '').match(/(\d+(?:\.\d+)?)\s*b\b/i)
    const b = match ? parseFloat(match[1]) : null
    if (b !== null && b >= 65) return 'gpu_large'
    if (b !== null && b >= 11) return 'gpu_mid'
    return 'gpu_small'
  }
  if (m.provider === 'voicebox') return 'gpu_small'
  if (m.provider === 'whisper_local') return 'cpu_light'
  if (m.provider === 'piper_local') return 'cpu_light'
  return 'none'
}

function recommendScenarioKey(
  stt: { compute_profile?: string; provider?: string; model?: string } | null,
  llm: { compute_profile?: string; provider?: string; model?: string } | null,
  tts: { compute_profile?: string; provider?: string; model?: string } | null,
): { key: string; max: Profile; profiles: { stt: Profile; llm: Profile; tts: Profile } } {
  const profiles = {
    stt: profileFromModel(stt),
    llm: profileFromModel(llm),
    tts: profileFromModel(tts),
  }
  const max: Profile = (Object.values(profiles) as Profile[]).reduce(
    (a, b) => (PROFILE_RANK[b] > PROFILE_RANK[a] ? b : a),
    'none',
  )
  const sttHeavy = PROFILE_RANK[profiles.stt] > 0
  const ttsHeavy = PROFILE_RANK[profiles.tts] > 0
  const llmHeavy = PROFILE_RANK[profiles.llm] > 0

  let key: string
  if (max === 'none') key = 'cloud'
  else if (!llmHeavy && (sttHeavy || ttsHeavy) && PROFILE_RANK[max] <= 2) key = 'stt_tts_only'
  else if (!llmHeavy && PROFILE_RANK[max] >= 3) key = 'fully_local' // GPU TTS like voicebox without local LLM
  else if (max === 'gpu_large') key = 'llm_large'
  else if (max === 'gpu_mid') key = 'llm_mid'
  else if (max === 'gpu_small') key = sttHeavy && ttsHeavy ? 'fully_local' : 'llm_small'
  else key = 'fully_local'

  return { key, max, profiles }
}

const PROFILE_LABEL: Record<Profile, string> = {
  none: 'Cloud (no server)',
  cpu_light: 'CPU · light',
  cpu_heavy: 'CPU · heavy',
  gpu_small: 'GPU · small (~12 GB)',
  gpu_mid: 'GPU · mid (~24 GB)',
  gpu_large: 'GPU · large (~48 GB+)',
}

const PROFILE_BADGE: Record<Profile, string> = {
  none: 'bg-muted text-muted-foreground border-border',
  cpu_light: 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  cpu_heavy: 'bg-yellow-50 dark:bg-yellow-950/25 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800',
  gpu_small: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  gpu_mid: 'bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400 border-violet-200 dark:border-violet-800',
  gpu_large: 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800',
}

// ── Styles ────────────────────────────────────────────────────────────────────

const GRADE_STYLES: Record<string, { outer: string; badge: string }> = {
  best: {
    outer: 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800',
    badge: 'text-green-700 dark:text-green-400',
  },
  good: {
    outer: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800',
    badge: 'text-blue-700 dark:text-blue-400',
  },
  ok: {
    outer: 'bg-yellow-50 dark:bg-yellow-950/25 border-yellow-200 dark:border-yellow-800',
    badge: 'text-yellow-700 dark:text-yellow-400',
  },
  cloud: {
    outer: 'bg-muted border-border',
    badge: 'text-muted-foreground',
  },
}

// ── Provider logo SVGs (inline, no external dep) ──────────────────────────────

function AwsLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 60 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.2 13.9c0 .6.1 1.1.2 1.4.2.3.4.7.7 1-.1.1-.3.3-.5.4-.2.1-.4.2-.6.2-.3 0-.6-.1-.8-.4-.2-.2-.4-.6-.5-1-.5.5-1 .8-1.5 1-.5.2-1.1.3-1.7.3-.8 0-1.4-.2-1.9-.7-.5-.5-.7-1.1-.7-1.9 0-.9.3-1.6.9-2.1.6-.5 1.5-.8 2.7-.8h1.5v-.7c0-.6-.1-1-.4-1.3-.3-.3-.7-.4-1.3-.4-.4 0-.8.1-1.3.2-.5.1-.9.3-1.4.5l-.5-1.3c.5-.3 1.1-.5 1.7-.6.6-.2 1.2-.2 1.8-.2 1.1 0 1.9.3 2.5.8.6.5.9 1.3.9 2.3v3.3zm-1.8-.5h-1.3c-.7 0-1.2.1-1.5.4-.3.3-.5.7-.5 1.2 0 .4.1.8.4 1 .2.2.6.3 1 .3.5 0 1-.1 1.4-.4.4-.3.6-.6.6-1v-1.5h-.1zM26 16.9l-2.1-7.5h1.9l1.2 5.1.2.9.2-.9 1.3-5.1h1.7l1.3 5.1.2.9.2-.9 1.2-5.1h1.8l-2.1 7.5h-1.9l-1.3-5.2-.2-.9-.2.9-1.3 5.2H26zM38.8 17c-.7 0-1.4-.1-2-.4-.6-.3-1.1-.7-1.5-1.2-.4-.5-.7-1.1-.9-1.8-.2-.7-.3-1.4-.3-2.2 0-.8.1-1.5.3-2.1.2-.6.5-1.2.9-1.6.4-.5.9-.8 1.4-1.1.6-.3 1.2-.4 1.9-.4.7 0 1.4.1 2 .4.6.3 1 .7 1.4 1.2l-1.1 1.1c-.3-.4-.6-.6-1-.8-.4-.2-.8-.3-1.2-.3-.9 0-1.5.3-2 1-.5.7-.7 1.6-.7 2.7 0 1.1.2 2 .7 2.7.5.7 1.1 1 2 1 .5 0 .9-.1 1.3-.3.4-.2.7-.5 1-.9l1.1 1.1c-.4.5-.9.9-1.5 1.2-.6.2-1.2.4-1.8.4z" fill="currentColor"/>
      <path d="M30 28.5c-8.3 0-15.5-3-18.8-7.4-.3.6-.5 1.2-.5 1.9C10.7 28 19.4 33 30 33s19.3-5 19.3-10c0-.7-.2-1.3-.5-1.9C45.5 25.5 38.3 28.5 30 28.5z" fill="#FF9900"/>
      <path d="M47.6 19.8c-.8-.4-1.7.2-2 1.2-.2.7-.2 1.4 0 2 .5 1.4 2 1.8 2.9.9.9-.9.8-2.5-.1-3.5l-.8-.6z" fill="#FF9900"/>
      <path d="M12.4 19.8c.8-.4 1.7.2 2 1.2.2.7.2 1.4 0 2-.5 1.4-2 1.8-2.9.9-.9-.9-.8-2.5.1-3.5l.8-.6z" fill="#FF9900"/>
    </svg>
  )
}

function GcpLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 60 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M30 4.5l5.2 3v6l-5.2 3-5.2-3v-6L30 4.5z" fill="#4285F4"/>
      <path d="M35.2 7.5v6l-5.2 3V10.5l5.2-3z" fill="#1967D2"/>
      <path d="M24.8 7.5l5.2 3v6l-5.2-3v-6z" fill="#EA4335"/>
      <text x="8" y="20" fontSize="8" fontFamily="sans-serif" fill="#4285F4" fontWeight="bold">G</text>
      <text x="14" y="20" fontSize="8" fontFamily="sans-serif" fill="#EA4335" fontWeight="bold">C</text>
      <text x="20" y="20" fontSize="8" fontFamily="sans-serif" fill="#FBBC05" fontWeight="bold">P</text>
    </svg>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CostEstimator({ fxRate }: CostEstimatorProps) {
  const { selectedStt, selectedLlm, selectedTts } = useModelStore()

  const [agents, setAgents] = useState(1)
  const [hoursPerDay, setHoursPerDay] = useState(8)
  const [daysPerMonth, setDaysPerMonth] = useState(22)
  const [serverTierIdx, setServerTierIdx] = useState(0)
  const [showServerDetail, setShowServerDetail] = useState(true)
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('aws')

  // Traffic intensity assumptions — visible & tunable. Default values match
  // the seed_data.py docstring (LLM 30K tok/hr, TTS 50K char/hr).
  const LLM_TOKENS_BASELINE = 30_000
  const TTS_CHARS_BASELINE = 50_000
  const [llmTokensPerHour, setLlmTokensPerHour] = useState(LLM_TOKENS_BASELINE)
  const [ttsCharsPerHour, setTtsCharsPerHour] = useState(TTS_CHARS_BASELINE)
  const [showAssumptions, setShowAssumptions] = useState(false)

  const llmMultiplier = llmTokensPerHour / LLM_TOKENS_BASELINE
  const ttsMultiplier = ttsCharsPerHour / TTS_CHARS_BASELINE

  const totalHours = agents * hoursPerDay * daysPerMonth
  const sttCost = (selectedStt?.price_per_hour ?? 0) * totalHours
  const llmCost = (selectedLlm?.price_per_hour ?? 0) * totalHours * llmMultiplier
  const ttsCost = (selectedTts?.price_per_hour ?? 0) * totalHours * ttsMultiplier

  const recommendation = recommendScenarioKey(selectedStt, selectedLlm, selectedTts)
  const scenarioKey = recommendation.key
  const providerScenarios = cloudProvider === 'aws' ? AWS_SCENARIOS : GCP_SCENARIOS
  const scenario = providerScenarios[scenarioKey]

  // Reset tier to 0 when scenario or cloud provider changes to avoid stale
  // index picking a paid option in a free scenario (e.g. fully_local).
  const prevKeyRef = useRef(`${cloudProvider}:${scenarioKey}`)
  useEffect(() => {
    const key = `${cloudProvider}:${scenarioKey}`
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key
      setServerTierIdx(0)
    }
  }, [cloudProvider, scenarioKey])

  const tierIdx = Math.min(serverTierIdx, scenario.options.length - 1)
  const selectedTier = scenario.options[tierIdx]
  // One server hosts `concurrentAgents` simultaneous voice sessions, so the
  // bill scales with the number of *servers needed*, not with the agent count.
  const serversNeeded = Math.max(1, Math.ceil(agents / Math.max(1, selectedTier.concurrentAgents)))
  const serverHours = serversNeeded * hoursPerDay * daysPerMonth
  const serverCost = serverHours * selectedTier.perHour
  const total = sttCost + llmCost + ttsCost + serverCost

  const fmt = (n: number) => n.toFixed(2)
  const inr = (n: number) => Math.round(n * fxRate).toLocaleString('en-IN')

  const serverLabel = serversNeeded > 1
    ? `${serversNeeded}× ${selectedTier.instance}`
    : selectedTier.instance

  const formulaSttHourly = (selectedStt?.price_per_hour ?? 0).toFixed(3)
  const formulaLlmHourly = (selectedLlm?.price_per_hour ?? 0).toFixed(3)
  const formulaTtsHourly = (selectedTts?.price_per_hour ?? 0).toFixed(3)

  const rows = [
    {
      label: 'STT',
      model: selectedStt?.label?.split(' — ')[0] ?? '—',
      cost: sttCost,
      formula: `$${formulaSttHourly}/hr × ${totalHours.toLocaleString()}h`,
    },
    {
      label: 'LLM',
      model: selectedLlm?.label?.split(' — ')[0] ?? '—',
      cost: llmCost,
      formula: `$${formulaLlmHourly}/hr × ${totalHours.toLocaleString()}h × ${llmMultiplier.toFixed(2)}× (${Math.round(llmTokensPerHour / 1000)}K tok/hr)`,
    },
    {
      label: 'TTS',
      model: selectedTts?.label?.split(' — ')[0] ?? '—',
      cost: ttsCost,
      formula: `$${formulaTtsHourly}/hr × ${totalHours.toLocaleString()}h × ${ttsMultiplier.toFixed(2)}× (${Math.round(ttsCharsPerHour / 1000)}K char/hr)`,
    },
    {
      label: 'Server',
      model: serverLabel,
      cost: serverCost,
      formula: `${serversNeeded}× $${selectedTier.perHour.toFixed(3)}/hr × ${(hoursPerDay * daysPerMonth).toLocaleString()}h`,
    },
  ]

  return (
    <div className="card">
      <h3 className="section-title mb-4">
        <DollarSign className="w-4 h-4 text-primary" />
        Cost Estimator
      </h3>

      {/* Usage inputs */}
      <div className="grid grid-cols-3 gap-2.5 mb-4">
        <div>
          <label className="label flex items-center gap-1"><Users className="w-3 h-3" />Agents</label>
          <input type="number" min={1} max={1000} value={agents}
            onChange={(e) => setAgents(Math.max(1, +e.target.value))} className="input-field" />
        </div>
        <div>
          <label className="label flex items-center gap-1"><Clock className="w-3 h-3" />Hrs/day</label>
          <input type="number" min={1} max={24} value={hoursPerDay}
            onChange={(e) => setHoursPerDay(Math.max(1, Math.min(24, +e.target.value)))} className="input-field" />
        </div>
        <div>
          <label className="label">Days/mo</label>
          <input type="number" min={1} max={31} value={daysPerMonth}
            onChange={(e) => setDaysPerMonth(Math.max(1, Math.min(31, +e.target.value)))} className="input-field" />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        {agents} agent{agents !== 1 ? 's' : ''} × {hoursPerDay}h × {daysPerMonth}d ={' '}
        <span className="text-foreground font-semibold">{totalHours.toLocaleString()} hrs/mo</span>
      </p>

      {/* Traffic assumptions — collapsible. Surfaces the implicit
          tokens/chars/hr baseline so customers can sanity-check estimates. */}
      <div className="mb-3 rounded-lg border border-border bg-muted/30">
        <button
          onClick={() => setShowAssumptions((v) => !v)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="flex items-center gap-1.5">
            {showAssumptions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <span className="font-medium">Traffic assumptions</span>
            <span className="text-muted-foreground/60">
              · LLM {Math.round(llmTokensPerHour / 1000)}K tok/hr · TTS {Math.round(ttsCharsPerHour / 1000)}K char/hr
            </span>
          </span>
        </button>
        {showAssumptions && (
          <div className="px-2.5 pb-2.5 pt-0.5 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Default assumes ~3 user/agent exchanges per minute and the agent speaks ~50% of the time.
              Bump these up for verbose / multi-turn agents.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase font-semibold text-muted-foreground">LLM tokens/hr</label>
                <input
                  type="number"
                  min={1000}
                  max={1_000_000}
                  step={1000}
                  value={llmTokensPerHour}
                  onChange={(e) => setLlmTokensPerHour(Math.max(1000, +e.target.value || LLM_TOKENS_BASELINE))}
                  className="input-field text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-semibold text-muted-foreground">TTS chars/hr</label>
                <input
                  type="number"
                  min={1000}
                  max={1_000_000}
                  step={1000}
                  value={ttsCharsPerHour}
                  onChange={(e) => setTtsCharsPerHour(Math.max(1000, +e.target.value || TTS_CHARS_BASELINE))}
                  className="input-field text-xs"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Cost rows */}
      <div className="space-y-2 mb-3 bg-muted rounded-lg p-3 border border-border">
        {rows.map(({ label, model, cost, formula }) => (
          <div key={label} className="flex items-start justify-between text-sm gap-2">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <span className="text-[10px] font-bold text-muted-foreground uppercase w-9 mt-0.5 flex-shrink-0">{label}</span>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground truncate">{model}</div>
                <div className="text-[10px] text-muted-foreground/60 truncate" title={formula}>{formula}</div>
              </div>
            </div>
            <span className={`font-semibold flex-shrink-0 text-xs ${cost > 0 ? 'text-foreground' : 'text-green-600 dark:text-green-400'}`}>
              {cost > 0 ? `$${fmt(cost)}` : 'FREE'}
            </span>
          </div>
        ))}
      </div>

      {/* Infrastructure toggle section */}
      <div className="border-t border-border pt-3 mb-3">
        {/* Header row: title + provider tabs + expand toggle */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setShowServerDetail((v) => !v)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium min-w-0"
          >
            <Server className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span className="truncate">
              Cloud Infrastructure
              <span className="text-xs text-muted-foreground/60 font-normal ml-1">· {scenario.scenario}</span>
            </span>
          </button>

          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
            {/* AWS / GCP toggle */}
            <div className="flex items-center bg-muted border border-border rounded-lg p-0.5">
              <button
                onClick={() => setCloudProvider('aws')}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-all ${
                  cloudProvider === 'aws'
                    ? 'bg-[#FF9900]/15 text-[#FF9900] border border-[#FF9900]/30 shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>AWS</span>
              </button>
              <button
                onClick={() => setCloudProvider('gcp')}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-all ${
                  cloudProvider === 'gcp'
                    ? 'bg-[#4285F4]/15 text-[#4285F4] border border-[#4285F4]/30 shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>GCP</span>
              </button>
            </div>

            <button
              onClick={() => setShowServerDetail((v) => !v)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {showServerDetail ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {showServerDetail && (
          <div className="space-y-1.5">
            {/* Provider badge */}
            <div className="flex items-center gap-2 mb-2">
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                cloudProvider === 'aws'
                  ? 'bg-[#FF9900]/10 border-[#FF9900]/30 text-[#FF9900]'
                  : 'bg-[#4285F4]/10 border-[#4285F4]/30 text-[#4285F4]'
              }`}>
                {cloudProvider === 'aws' ? '🟠 Amazon Web Services' : '🔵 Google Cloud Platform'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">{scenario.description}</p>

            {/* Profile breakdown — explains *why* this scenario was picked. */}
            <div className="mb-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                {recommendation.max === 'none' ? 'Compute footprint' : 'Why this server?'}
              </p>
              <div className="space-y-1">
                {(['stt', 'llm', 'tts'] as const).map((stage) => {
                  const p = recommendation.profiles[stage]
                  const isMax = recommendation.max !== 'none' && p === recommendation.max
                  const m =
                    stage === 'stt' ? selectedStt :
                    stage === 'llm' ? selectedLlm : selectedTts
                  const name = m?.label?.split(' — ')[0] ?? '—'
                  return (
                    <div key={stage} className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-bold text-muted-foreground uppercase w-7">{stage}</span>
                        <span className="truncate text-foreground/80">{name}</span>
                      </div>
                      <span className={`shrink-0 ml-2 px-1.5 py-0.5 rounded border text-[10px] font-medium ${PROFILE_BADGE[p]} ${isMax ? 'ring-1 ring-current/40' : ''}`}>
                        {PROFILE_LABEL[p]}{isMax ? ' · driver' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {scenario.options.map((opt, i) => {
              const styles = GRADE_STYLES[opt.gradeClass]
              const isRecommended = i === 0 && opt.gradeClass !== 'cloud'
              return (
                <button
                  key={i}
                  onClick={() => setServerTierIdx(i)}
                  className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all text-sm ${
                    i === tierIdx
                      ? `${styles.outer} ring-1 ring-inset ring-current/40`
                      : 'bg-muted border-border hover:border-border/60'
                  }`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-base">{opt.icon}</span>
                      <span className={`font-semibold ${i === tierIdx ? styles.badge : 'text-foreground'}`}>
                        {opt.instance}
                      </span>
                      {opt.grade !== 'N/A' && (
                        <span className={`text-[10px] font-bold uppercase ${i === tierIdx ? styles.badge : 'text-muted-foreground'} opacity-70`}>
                          {opt.grade}
                        </span>
                      )}
                      {isRecommended && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded-full">
                          <Sparkles className="w-2.5 h-2.5" /> Auto
                        </span>
                      )}
                    </div>
                    <span className={`font-semibold text-xs ${i === tierIdx ? styles.badge : 'text-foreground'} flex-shrink-0 ml-2`}>
                      {opt.perHour === 0 ? 'FREE' : `$${opt.perHour}/hr`}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {opt.specs} · {opt.latency} · ~{opt.concurrentAgents} concurrent {opt.concurrentAgents === 1 ? 'call' : 'calls'}
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Total */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-foreground flex items-center gap-1.5 text-sm">
            <TrendingUp className="w-4 h-4 text-primary" />
            Monthly total
          </span>
          <div className="text-right">
            <div className="text-xl font-bold text-primary">${fmt(total)}</div>
            {fxRate > 0 && (
              <div className="text-xs text-muted-foreground">≈ ₹{inr(total)}</div>
            )}
          </div>
        </div>
        {total === 0 && (
          <p className="text-green-600 dark:text-green-400 text-xs mt-1.5 font-medium">
            🎉 Running entirely on free local models!
          </p>
        )}
      </div>
    </div>
  )
}
