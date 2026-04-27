import { useEffect, useState } from 'react'
import { X, Key, Check, Trash2, Eye, EyeOff, AlertCircle, Loader, Shield } from 'lucide-react'
import api from '../../api/client'

interface APIKeyInfo { provider: string; configured: boolean }

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  groq: 'Groq',
  anthropic: 'Anthropic',
  google: 'Google (Gemini)',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  deepseek: 'DeepSeek',
  azure: 'Azure Speech',
}

const PROVIDER_HINTS: Record<string, string> = {
  openai: 'sk-…',
  groq: 'gsk_…',
  anthropic: 'sk-ant-…',
  google: 'AIza…',
  deepgram: 'Token …',
  elevenlabs: 'API key',
  deepseek: 'sk-…',
  azure: 'Speech service key',
}

interface ConfigModalProps { onClose: () => void }

export default function ConfigModal({ onClose }: ConfigModalProps) {
  const [keys, setKeys] = useState<APIKeyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [showValues, setShowValues] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Record<string, string>>({})

  useEffect(() => {
    api.get('/config/keys').then((r) => setKeys(r.data)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const handleSave = async (provider: string) => {
    const key = inputValues[provider]?.trim()
    if (!key) return
    setSaving(provider)
    try {
      await api.put(`/config/keys/${provider}`, { api_key: key })
      setKeys((ks) => ks.map((k) => k.provider === provider ? { ...k, configured: true } : k))
      setEditing(null)
      setInputValues((v) => { const n = { ...v }; delete n[provider]; return n })
      setFeedback((f) => ({ ...f, [provider]: 'saved' }))
      setTimeout(() => setFeedback((f) => { const n = { ...f }; delete n[provider]; return n }), 2000)
    } catch {
      setFeedback((f) => ({ ...f, [provider]: 'error' }))
      setTimeout(() => setFeedback((f) => { const n = { ...f }; delete n[provider]; return n }), 3000)
    } finally { setSaving(null) }
  }

  const handleDelete = async (provider: string) => {
    setDeleting(provider)
    try {
      await api.delete(`/config/keys/${provider}`)
      setKeys((ks) => ks.map((k) => k.provider === provider ? { ...k, configured: false } : k))
    } catch {} finally { setDeleting(null) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20 dark:bg-background/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border w-full max-w-lg shadow-xl dark:shadow-none max-h-[90vh] flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Key className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">API Keys & Configuration</h2>
              <p className="text-xs text-muted-foreground">Encrypted with AES-256</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5">
          <div className="flex items-start gap-2 bg-muted border border-border rounded-lg px-3 py-2.5 mb-4 text-xs text-muted-foreground">
            <Shield className="w-3.5 h-3.5 mt-0.5 text-primary flex-shrink-0" />
            Keys are stored encrypted and only used when initiating cloud provider calls.
          </div>

          {!loading && keys.every((k) => !k.configured) && (
            <div className="flex items-start gap-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2.5 mb-4 text-xs text-yellow-800 dark:text-yellow-300">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
              <span>
                <strong>No API keys configured yet.</strong> Add at least one to unlock cloud-provider models, or use the
                FREE local options (Whisper, Piper, Edge TTS, Voicebox, Ollama) right out of the box.
              </span>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-8">
              <Loader className="w-6 h-6 text-primary animate-spin" />
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map(({ provider, configured }) => (
                <div key={provider} className="bg-muted rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{PROVIDER_LABELS[provider] ?? provider}</span>
                      {configured && feedback[provider] !== 'error' && (
                        <span className={`flex items-center gap-1 text-xs font-medium ${
                          feedback[provider] === 'saved' ? 'text-green-600 dark:text-green-400' : 'text-green-600 dark:text-green-400'
                        }`}>
                          <Check className="w-3 h-3" />
                          {feedback[provider] === 'saved' ? 'Saved!' : 'Configured'}
                        </span>
                      )}
                      {feedback[provider] === 'error' && (
                        <span className="flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="w-3 h-3" /> Failed
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {configured && (
                        <button
                          onClick={() => handleDelete(provider)}
                          disabled={deleting === provider}
                          className="p-1.5 text-muted-foreground/60 hover:text-destructive transition-colors"
                          title="Remove key"
                        >
                          {deleting === provider ? <Loader className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        </button>
                      )}
                      <button
                        onClick={() => setEditing(editing === provider ? null : provider)}
                        className="text-xs font-medium text-primary hover:text-primary/80 transition-colors px-2 py-1 rounded-md hover:bg-primary/8"
                      >
                        {editing === provider ? 'Cancel' : configured ? 'Update' : 'Add key'}
                      </button>
                    </div>
                  </div>

                  {editing === provider && (
                    <div className="flex gap-2 mt-2.5">
                      <div className="relative flex-1">
                        <input
                          type={showValues[provider] ? 'text' : 'password'}
                          value={inputValues[provider] ?? ''}
                          onChange={(e) => setInputValues((v) => ({ ...v, [provider]: e.target.value }))}
                          onKeyDown={(e) => e.key === 'Enter' && handleSave(provider)}
                          className="input-field pr-8"
                          placeholder={PROVIDER_HINTS[provider] ?? 'API key'}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => setShowValues((v) => ({ ...v, [provider]: !v[provider] }))}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showValues[provider] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <button
                        onClick={() => handleSave(provider)}
                        disabled={saving === provider || !inputValues[provider]?.trim()}
                        className="btn-primary px-3 py-2 text-xs"
                      >
                        {saving === provider ? <Loader className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex-shrink-0">
          <button onClick={onClose} className="btn-secondary w-full">Done</button>
        </div>
      </div>
    </div>
  )
}
