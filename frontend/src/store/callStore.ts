import { create } from 'zustand'

export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error'

export type PipelineStage = 'idle' | 'listening' | 'stt' | 'llm' | 'tts'

export interface Message {
  id: string
  role: 'user' | 'agent'
  text: string
  timestamp: number
}

export interface Metrics {
  stt_ms: number | null
  llm_ms: number | null
  tts_ms: number | null
  ttft_ms: number | null
  tokens_per_second: number | null
  total_tokens: number | null
}

interface CallState {
  status: CallStatus
  error: string | null
  messages: Message[]
  metrics: Metrics
  pipelineStage: PipelineStage
  callStartedAt: number | null
  callLimitSeconds: number
  roomName: string | null

  setStatus: (status: CallStatus) => void
  setError: (error: string | null) => void
  addMessage: (msg: Omit<Message, 'id' | 'timestamp'>) => void
  updateMetrics: (partial: Partial<Metrics>) => void
  setPipelineStage: (stage: PipelineStage) => void
  clearConversation: () => void
  startCall: (roomName: string, limitSeconds: number) => void
  endCall: () => void
}

const defaultMetrics: Metrics = {
  stt_ms: null,
  llm_ms: null,
  tts_ms: null,
  ttft_ms: null,
  tokens_per_second: null,
  total_tokens: null,
}

export const useCallStore = create<CallState>((set) => ({
  status: 'idle',
  error: null,
  messages: [],
  metrics: { ...defaultMetrics },
  pipelineStage: 'idle',
  callStartedAt: null,
  callLimitSeconds: 60,
  roomName: null,

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setPipelineStage: (pipelineStage) => set({ pipelineStage }),

  addMessage: (msg) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { ...msg, id: crypto.randomUUID(), timestamp: Date.now() },
      ],
    })),

  updateMetrics: (partial) =>
    set((s) => ({ metrics: { ...s.metrics, ...partial } })),

  clearConversation: () =>
    set({ messages: [], metrics: { ...defaultMetrics }, error: null }),

  startCall: (roomName, limitSeconds) =>
    set({
      status: 'connected',
      callStartedAt: Date.now(),
      callLimitSeconds: limitSeconds,
      roomName,
      messages: [],
      metrics: { ...defaultMetrics },
      pipelineStage: 'listening',
      error: null,
    }),

  endCall: () =>
    set({
      status: 'idle',
      callStartedAt: null,
      roomName: null,
      pipelineStage: 'idle',
    }),
}))
