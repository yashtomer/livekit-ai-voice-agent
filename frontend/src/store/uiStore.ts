import { create } from 'zustand'

interface UIState {
  configModalOpen: boolean
  configModalHighlightProvider: string | null
  openConfigModal: (highlightProvider?: string) => void
  closeConfigModal: () => void
}

export const useUIStore = create<UIState>((set) => ({
  configModalOpen: false,
  configModalHighlightProvider: null,
  openConfigModal: (highlightProvider) =>
    set({
      configModalOpen: true,
      configModalHighlightProvider: highlightProvider ?? null,
    }),
  closeConfigModal: () =>
    set({ configModalOpen: false, configModalHighlightProvider: null }),
}))
