import { create } from 'zustand'

export type ComputeProfile =
  | 'none'
  | 'cpu_light'
  | 'cpu_heavy'
  | 'gpu_small'
  | 'gpu_mid'
  | 'gpu_large'

export interface ModelOption {
  provider: string
  model?: string
  label: string
  price_per_hour: number
  voice?: string
  language?: string
  size?: string
  compute_profile?: ComputeProfile
  min_vram_gb?: number | null
  requires_api_key?: boolean
  [key: string]: unknown
}

export interface ModelLists {
  stt: ModelOption[]
  llm: ModelOption[]
  tts: ModelOption[]
}

export interface LLMParams {
  temperature: number   // 0.0 – 2.0
  top_p: number         // 0.0 – 1.0
  max_tokens: number    // 50 – 2000
}

export interface TTSParams {
  stability: number           // 0.0 – 1.0  (ElevenLabs)
  clarity: number             // 0.0 – 1.0  (ElevenLabs similarity_boost)
  style_exaggeration: number  // 0.0 – 1.0  (ElevenLabs)
  speed: number               // 0.25 – 4.0 (OpenAI / Piper)
}

export const DEFAULT_LLM_PARAMS: LLMParams = {
  temperature: 0.6,
  top_p: 1.0,
  max_tokens: 150,
}

export const DEFAULT_TTS_PARAMS: TTSParams = {
  stability: 0.5,
  clarity: 0.75,
  style_exaggeration: 0.0,
  speed: 1.0,
}

interface ModelState {
  models: ModelLists | null
  selectedStt: ModelOption | null
  selectedLlm: ModelOption | null
  selectedTts: ModelOption | null
  llmParams: LLMParams
  ttsParams: TTSParams
  setModels: (models: ModelLists) => void
  setSelectedStt: (m: ModelOption) => void
  setSelectedLlm: (m: ModelOption) => void
  setSelectedTts: (m: ModelOption) => void
  setLlmParams: (p: Partial<LLMParams>) => void
  setTtsParams: (p: Partial<TTSParams>) => void
  getSelectedConfig: () => { stt: object; llm: object; tts: object } | null
}

export const useModelStore = create<ModelState>((set, get) => ({
  models: null,
  selectedStt: null,
  selectedLlm: null,
  selectedTts: null,
  llmParams: { ...DEFAULT_LLM_PARAMS },
  ttsParams: { ...DEFAULT_TTS_PARAMS },

  setModels: (models) => {
    set((s) => ({
      models,
      selectedStt: s.selectedStt ?? models.stt[0] ?? null,
      selectedLlm: s.selectedLlm ?? models.llm[0] ?? null,
      selectedTts: s.selectedTts ?? models.tts[0] ?? null,
    }))
  },

  setSelectedStt: (m) => set({ selectedStt: m }),
  setSelectedLlm: (m) => set({ selectedLlm: m }),
  setSelectedTts: (m) => set({ selectedTts: m }),
  setLlmParams: (p) => set((s) => ({ llmParams: { ...s.llmParams, ...p } })),
  setTtsParams: (p) => set((s) => ({ ttsParams: { ...s.ttsParams, ...p } })),

  getSelectedConfig: () => {
    const { selectedStt, selectedLlm, selectedTts, llmParams, ttsParams } = get()
    if (!selectedStt || !selectedLlm || !selectedTts) return null

    const clean = (m: ModelOption) => {
      // Strip UI-only metadata before sending to backend.
      const { label, price_per_hour, compute_profile, min_vram_gb, requires_api_key, ...rest } = m
      void label; void price_per_hour; void compute_profile; void min_vram_gb; void requires_api_key
      return rest
    }

    return {
      stt: clean(selectedStt),
      llm: { ...clean(selectedLlm), ...llmParams },
      tts: { ...clean(selectedTts), ...ttsParams },
    }
  },
}))
