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

interface ModelState {
  models: ModelLists | null
  selectedStt: ModelOption | null
  selectedLlm: ModelOption | null
  selectedTts: ModelOption | null
  setModels: (models: ModelLists) => void
  setSelectedStt: (m: ModelOption) => void
  setSelectedLlm: (m: ModelOption) => void
  setSelectedTts: (m: ModelOption) => void
  getSelectedConfig: () => { stt: object; llm: object; tts: object } | null
}

export const useModelStore = create<ModelState>((set, get) => ({
  models: null,
  selectedStt: null,
  selectedLlm: null,
  selectedTts: null,

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

  getSelectedConfig: () => {
    const { selectedStt, selectedLlm, selectedTts } = get()
    if (!selectedStt || !selectedLlm || !selectedTts) return null

    const clean = (m: ModelOption) => {
      // Strip UI-only metadata before sending to backend.
      const { label, price_per_hour, compute_profile, min_vram_gb, requires_api_key, ...rest } = m
      void label; void price_per_hour; void compute_profile; void min_vram_gb; void requires_api_key
      return rest
    }

    return {
      stt: clean(selectedStt),
      llm: clean(selectedLlm),
      tts: clean(selectedTts),
    }
  },
}))
