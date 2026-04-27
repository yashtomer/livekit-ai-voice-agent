import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Shield, RefreshCw, ToggleLeft, ToggleRight, Trash2,
  Loader, Check, UserPlus, X,
  Terminal, Pencil, ChevronDown, ChevronUp, Search, RotateCcw, AlertTriangle,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../api/client'

const COMPUTE_PROFILES = [
  'none', 'cpu_light', 'cpu_heavy', 'gpu_small', 'gpu_mid', 'gpu_large',
] as const
type ComputeProfile = typeof COMPUTE_PROFILES[number]

interface ModelEntry {
  id: number; model_type: string; provider: string; model_id: string
  label: string; price_per_hour: number; enabled: boolean
  compute_profile?: ComputeProfile
  min_vram_gb?: number | null
  is_seed?: boolean
}

interface UserEntry {
  id: number; email: string; role: string; is_active: boolean
}

interface LogLine {
  ts: string; level: 'debug' | 'info' | 'warning' | 'error' | 'critical'; logger: string; msg: string
}

function parseLatencyMs(label: string): number {
  const ms = label.match(/~(\d+(?:\.\d+)?)\s*ms/)
  if (ms) return parseFloat(ms[1])
  const s = label.match(/~(\d+(?:\.\d+)?)\s*s/)
  if (s) return parseFloat(s[1]) * 1000
  return 9999
}

function formatLatency(label: string): string {
  const m = parseLatencyMs(label)
  if (m === 9999) return '—'
  if (m >= 1000) return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)}s`
  return `${m}ms`
}

function latencyTone(label: string): string {
  const m = parseLatencyMs(label)
  if (m === 9999) return 'text-muted-foreground/40'
  if (m < 800) return 'text-green-600 dark:text-green-400'
  if (m < 2000) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-red-600 dark:text-red-400'
}

type SortKey = 'latency' | 'type' | 'label' | 'provider' | 'price'
type SortDir = 'asc' | 'desc'

function SortHeader({ label, sortKey, sortConfig, onSort }: {
  label: string; sortKey: SortKey
  sortConfig: { key: SortKey; dir: SortDir }
  onSort: (key: SortKey) => void
}) {
  const active = sortConfig.key === sortKey
  return (
    <th
      className="px-3 py-2.5 text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap uppercase tracking-wide"
      onClick={() => onSort(sortKey)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active
          ? sortConfig.dir === 'asc'
            ? <ChevronUp className="w-3 h-3 text-primary" />
            : <ChevronDown className="w-3 h-3 text-primary" />
          : <span className="w-3 inline-block" />}
      </span>
    </th>
  )
}

const LEVEL_COLOR: Record<string, string> = {
  debug:    'text-muted-foreground/50',
  info:     'text-foreground',
  warning:  'text-yellow-600 dark:text-yellow-400',
  error:    'text-red-600 dark:text-red-400',
  critical: 'text-red-700 dark:text-red-300 font-bold',
}

const TYPE_COLOR: Record<string, string> = {
  stt: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800',
  llm: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800',
  tts: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800',
}

function ModelRow({ model, onToggle, onDelete, onLabelSave, onPatch, onResetToSeed }: {
  model: ModelEntry
  onToggle: (id: number, enabled: boolean) => void
  onDelete: (id: number) => void
  onLabelSave: (id: number, label: string) => void
  onPatch: (id: number, patch: Partial<Pick<ModelEntry, 'price_per_hour' | 'compute_profile' | 'min_vram_gb'>>) => void
  onResetToSeed: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(model.label)
  const [priceDraft, setPriceDraft] = useState(model.price_per_hour.toFixed(3))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  useEffect(() => { setPriceDraft(model.price_per_hour.toFixed(3)) }, [model.price_per_hour])

  const save = () => {
    if (draft.trim() && draft.trim() !== model.label) onLabelSave(model.id, draft.trim())
    setEditing(false)
  }
  const cancel = () => { setDraft(model.label); setEditing(false) }

  const savePrice = () => {
    const next = parseFloat(priceDraft)
    if (!Number.isNaN(next) && next >= 0 && Math.abs(next - model.price_per_hour) > 1e-9) {
      onPatch(model.id, { price_per_hour: next })
    } else {
      setPriceDraft(model.price_per_hour.toFixed(3))
    }
  }

  const profile: ComputeProfile = (model.compute_profile as ComputeProfile) || 'none'
  const profileMisflag = profile === 'gpu_large' && model.provider !== 'ollama'
  const typeStyle = TYPE_COLOR[model.model_type] ?? 'text-muted-foreground bg-muted border border-border'

  return (
    <tr className="border-b border-border hover:bg-muted/50 transition-colors group">
      <td className="px-3 py-2.5">
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-md ${typeStyle}`}>
          {model.model_type}
        </span>
      </td>
      <td className="px-3 py-2.5 max-w-[260px]">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
            className="w-full bg-background border border-primary rounded-md px-2 py-0.5 text-sm text-foreground outline-none ring-1 ring-primary/20"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-foreground truncate">{model.label}</span>
            <button
              onClick={() => setEditing(true)}
              className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-muted-foreground hover:text-primary"
              title="Edit label"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm text-muted-foreground">{model.provider}</td>
      <td
        className={`px-3 py-2.5 text-xs font-mono whitespace-nowrap ${latencyTone(model.label)}`}
        title="Parsed from the model label. Edit the label to change."
      >
        {formatLatency(model.label)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <input
          type="number"
          min={0}
          step={0.001}
          value={priceDraft}
          onChange={(e) => setPriceDraft(e.target.value)}
          onBlur={savePrice}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="w-20 bg-background border border-border rounded px-1.5 py-0.5 text-xs text-foreground hover:border-primary focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none"
          title="Per-hour cost in USD ($/hr)"
        />
        <span className="text-[10px] text-muted-foreground/60 ml-1">/hr</span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <div className="flex items-center gap-1">
          <select
            value={profile}
            onChange={(e) => onPatch(model.id, { compute_profile: e.target.value as ComputeProfile })}
            className="bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground hover:border-primary focus:border-primary outline-none"
            title="Hardware footprint that drives the server-tier recommendation"
          >
            {COMPUTE_PROFILES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {profileMisflag && (
            <span title="gpu_large is unusual for non-Ollama providers — double-check this profile.">
              <AlertTriangle className="w-3 h-3 text-yellow-600 dark:text-yellow-400" />
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <button
          onClick={() => onToggle(model.id, !model.enabled)}
          className={`transition-colors ${model.enabled ? 'text-green-600 dark:text-green-400 hover:text-green-700' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}
        >
          {model.enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
        </button>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          {model.is_seed === false && (
            <button
              onClick={() => onResetToSeed(model.id)}
              className="text-muted-foreground/60 hover:text-primary transition-colors"
              title="Restore seed defaults for this row"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onDelete(model.id)} className="text-muted-foreground/40 hover:text-destructive transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  )
}

const EMPTY_USER_FORM = { email: '', password: '', role: 'customer' as 'admin' | 'customer' }
const TAIL_OPTIONS = [50, 100, 200, 500]

export default function AdminPanel() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'models' | 'users' | 'settings' | 'logs'>('models')
  const [modelSearch, setModelSearch] = useState('')
  const [modelTypeFilter, setModelTypeFilter] = useState<'all' | 'stt' | 'llm' | 'tts'>('all')
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; dir: SortDir }>({ key: 'type', dir: 'asc' })
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null)
  const [syncDetails, setSyncDetails] = useState<{ added: string[]; updated: string[]; disabled: string[]; errors: string[] } | null>(null)
  const [ollamaPullName, setOllamaPullName] = useState('')
  const [ollamaPullStatus, setOllamaPullStatus] = useState<{ state: 'idle' | 'pulling' | 'done' | 'error'; message?: string }>({ state: 'idle' })
  const [voiceboxOpen, setVoiceboxOpen] = useState(false)
  const [voiceboxStatus, setVoiceboxStatus] = useState<{ state: 'idle' | 'busy' | 'error'; message?: string }>({ state: 'idle' })
  const [voiceboxEngine, setVoiceboxEngine] = useState<string>('kokoro')
  const [voiceboxPreset, setVoiceboxPreset] = useState<string>('')
  const [callLimit, setCallLimit] = useState<string>('')
  const [maxConcurrent, setMaxConcurrent] = useState<string>('')
  const [maxPerDay, setMaxPerDay] = useState<string>('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [showAddUser, setShowAddUser] = useState(false)
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM)
  const [userFormError, setUserFormError] = useState<string | null>(null)
  const [logTail, setLogTail] = useState(200)
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [logAutoScroll, setLogAutoScroll] = useState(true)
  const [logPolling, setLogPolling] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const logIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: models = [], isLoading: loadingModels } = useQuery<ModelEntry[]>({
    queryKey: ['admin-models'],
    queryFn: () => api.get('/admin/models').then((r) => r.data),
  })

  const { data: users = [], isLoading: loadingUsers } = useQuery<UserEntry[]>({
    queryKey: ['admin-users'],
    queryFn: () => api.get('/admin/users').then((r) => r.data),
  })

  useQuery<Record<string, string>>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get('/admin/settings').then((r) => {
      setCallLimit(r.data.call_limit_seconds ?? '60')
      setMaxConcurrent(r.data.max_concurrent_calls_per_user ?? '2')
      setMaxPerDay(r.data.max_calls_per_day_per_user ?? '50')
      return r.data
    }),
  })

  const filteredModels = useMemo(() => {
    let list = [...models]
    if (modelTypeFilter !== 'all') list = list.filter((m) => m.model_type === modelTypeFilter)
    if (modelSearch.trim()) {
      const q = modelSearch.toLowerCase()
      list = list.filter((m) =>
        m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.model_id.toLowerCase().includes(q)
      )
    }
    list.sort((a, b) => {
      let aVal: string | number
      let bVal: string | number
      if (sortConfig.key === 'latency') { aVal = parseLatencyMs(a.label); bVal = parseLatencyMs(b.label) }
      else if (sortConfig.key === 'type') { aVal = a.model_type; bVal = b.model_type }
      else if (sortConfig.key === 'label') { aVal = a.label; bVal = b.label }
      else if (sortConfig.key === 'provider') { aVal = a.provider; bVal = b.provider }
      else { aVal = a.price_per_hour; bVal = b.price_per_hour }
      if (aVal < bVal) return sortConfig.dir === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.dir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [models, modelSearch, modelTypeFilter, sortConfig])

  const handleSort = (key: SortKey) =>
    setSortConfig((prev) => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })

  const fetchLogs = useCallback(async () => {
    try {
      const r = await api.get(`/admin/logs?tail=${logTail}`)
      setLogLines(r.data.lines)
    } catch {}
  }, [logTail])

  useEffect(() => {
    if (activeTab !== 'logs') {
      if (logIntervalRef.current) clearInterval(logIntervalRef.current)
      setLogPolling(false)
      return
    }
    fetchLogs()
    setLogPolling(true)
    logIntervalRef.current = setInterval(fetchLogs, 3000)
    return () => { if (logIntervalRef.current) clearInterval(logIntervalRef.current) }
  }, [activeTab, fetchLogs])

  useEffect(() => {
    if (logAutoScroll && activeTab === 'logs') {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logLines, logAutoScroll, activeTab])

  const toggleModel = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.patch(`/admin/models/${id}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-models'] }),
  })
  const deleteModel = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/models/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-models'] }),
  })
  const updateModelLabel = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) => api.patch(`/admin/models/${id}`, { label }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-models'] }),
  })
  const patchModel = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<ModelEntry> }) => api.patch(`/admin/models/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-models'] }),
  })
  const resetToSeed = useMutation({
    mutationFn: (id: number) => api.post(`/admin/models/${id}/reset_to_seed`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-models'] }),
  })
  const toggleUser = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => api.patch(`/admin/users/${id}`, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  })
  const createUser = useMutation({
    mutationFn: (data: typeof EMPTY_USER_FORM) => api.post('/admin/users', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-users'] }); setShowAddUser(false); setUserForm(EMPTY_USER_FORM); setUserFormError(null) },
    onError: (err: unknown) => {
      setUserFormError((err as { response?: { data?: { detail?: string } } }).response?.data?.detail ?? 'Failed to create user')
    },
  })

  const handleSync = async () => {
    setSyncFeedback('syncing')
    setSyncDetails(null)
    try {
      const r = await api.post('/admin/sync')
      const { added = [], updated = [], disabled = [], errors = [] } = r.data
      setSyncFeedback(
        `✓ ${added.length} added · ${updated.length} updated · ${disabled.length} disabled` +
        (errors.length ? ` · ${errors.length} error(s)` : '')
      )
      setSyncDetails({ added, updated, disabled, errors })
      queryClient.invalidateQueries({ queryKey: ['admin-models'] })
    } catch { setSyncFeedback('Sync failed') }
  }

  const { data: voiceboxProfiles = [], refetch: refetchVoiceboxProfiles, isFetching: vbProfilesLoading } = useQuery<Array<{ id: string; name: string; language: string; voice_type?: string; preset_engine?: string; default_engine?: string }>>({
    queryKey: ['voicebox-profiles'],
    queryFn: () => api.get('/admin/voicebox/profiles').then((r) => r.data ?? []).catch(() => []),
    enabled: voiceboxOpen,
  })

  const { data: voiceboxPresets, isFetching: vbPresetsLoading } = useQuery<{ engines: Record<string, { engine: string; voices: Array<{ voice_id: string; name: string; gender?: string; language: string }>; error?: string }> }>({
    queryKey: ['voicebox-presets'],
    queryFn: () => api.get('/admin/voicebox/presets').then((r) => r.data),
    enabled: voiceboxOpen,
  })

  const voiceboxAddPreset = async () => {
    if (!voiceboxPreset) return
    setVoiceboxStatus({ state: 'busy', message: 'Adding voice…' })
    try {
      const engineVoices = voiceboxPresets?.engines?.[voiceboxEngine]?.voices ?? []
      const meta = engineVoices.find((v) => v.voice_id === voiceboxPreset)
      await api.post('/admin/voicebox/profiles', {
        engine: voiceboxEngine,
        voice_id: voiceboxPreset,
        name: meta?.name ?? voiceboxPreset,
        language: meta?.language ?? 'en',
      })
      setVoiceboxStatus({ state: 'idle' })
      setVoiceboxPreset('')
      refetchVoiceboxProfiles()
      queryClient.invalidateQueries({ queryKey: ['models'] })
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setVoiceboxStatus({ state: 'error', message: detail ?? 'Failed to add voice' })
    }
  }

  const voiceboxDelete = async (id: string) => {
    setVoiceboxStatus({ state: 'busy', message: 'Removing voice…' })
    try {
      await api.delete(`/admin/voicebox/profiles/${id}`)
      setVoiceboxStatus({ state: 'idle' })
      refetchVoiceboxProfiles()
      queryClient.invalidateQueries({ queryKey: ['models'] })
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setVoiceboxStatus({ state: 'error', message: detail ?? 'Failed to delete voice' })
    }
  }

  const handleOllamaPull = async () => {
    const name = ollamaPullName.trim()
    if (!name) return
    setOllamaPullStatus({ state: 'pulling', message: `Pulling ${name}…` })
    try {
      const r = await api.post('/admin/ollama/pull', { model: name })
      setOllamaPullStatus({ state: 'done', message: r.data?.message ?? `Pulled ${name}.` })
      setOllamaPullName('')
      queryClient.invalidateQueries({ queryKey: ['admin-models'] })
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setOllamaPullStatus({ state: 'error', message: detail ?? 'Pull failed' })
    }
  }

  const saveCallLimit = async () => {
    await api.patch('/admin/settings/call_limit_seconds', { value: callLimit })
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
    queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
  }

  const saveQuota = async (key: string, value: string) => {
    await api.patch(`/admin/settings/${key}`, { value })
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
    queryClient.invalidateQueries({ queryKey: ['admin-settings'] })
  }

  const handleAddUserSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setUserFormError(null)
    if (!userForm.email || !userForm.password) { setUserFormError('Email and password are required'); return }
    createUser.mutate(userForm)
  }

  const clearLogs = async () => { await api.delete('/admin/logs'); setLogLines([]) }

  const tabs = [
    { id: 'models' as const, label: 'Models' },
    { id: 'users' as const, label: 'Users' },
    { id: 'settings' as const, label: 'Settings' },
    { id: 'logs' as const, label: 'Logs' },
  ]

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-5">
        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Shield className="w-4 h-4 text-primary" />
        </div>
        <h3 className="font-bold text-foreground text-base">Admin Panel</h3>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-5 bg-muted p-1 rounded-lg border border-border">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 py-1.5 text-sm font-semibold rounded-md transition-all ${
              activeTab === id
                ? 'bg-card text-foreground shadow-sm dark:shadow-none border border-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Models Tab ── */}
      {activeTab === 'models' && (
        <div>
          <div className="flex flex-col gap-2.5 mb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {(['all', 'stt', 'llm', 'tts'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setModelTypeFilter(t)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                      modelTypeFilter === t
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'bg-muted text-muted-foreground hover:text-foreground border border-border'
                    }`}
                  >
                    {t === 'all' ? 'All' : t.toUpperCase()}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground ml-1">
                  {filteredModels.length !== models.length ? `${filteredModels.length} / ${models.length}` : `${models.length} total`}
                </span>
              </div>
              <button onClick={handleSync} className="btn-secondary text-xs py-1.5 px-3">
                <RefreshCw className="w-3 h-3" /> Sync
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text" value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder="Search by label, provider, or model ID…"
                className="input-field pl-8 py-1.5"
              />
              {modelSearch && (
                <button onClick={() => setModelSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {syncFeedback && (
            <div className="text-xs mb-2 bg-muted px-3 py-2 rounded-lg border border-border space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-foreground font-medium">{syncFeedback}</span>
                {syncDetails && (
                  <button
                    onClick={() => { setSyncFeedback(null); setSyncDetails(null) }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {syncDetails && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                  {(['added', 'updated', 'disabled'] as const).map((k) => (
                    <div key={k} className="bg-background border border-border rounded-md p-2 max-h-40 overflow-y-auto">
                      <div className="font-semibold text-foreground capitalize mb-1">
                        {k} ({syncDetails[k].length})
                      </div>
                      {syncDetails[k].length === 0 ? (
                        <div className="text-muted-foreground/60">—</div>
                      ) : (
                        <ul className="space-y-0.5 font-mono text-muted-foreground">
                          {syncDetails[k].map((s) => <li key={s}>{s}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                  {syncDetails.errors.length > 0 && (
                    <div className="sm:col-span-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-md p-2 text-red-700 dark:text-red-300">
                      <div className="font-semibold mb-1">Errors</div>
                      <ul className="space-y-0.5 font-mono">
                        {syncDetails.errors.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Local-model management: how each provider's models are pulled / refreshed. */}
          <div className="text-[11px] mb-3 bg-muted/30 px-3 py-2 rounded-lg border border-border space-y-1.5">
            <div className="font-medium text-foreground">Managing local models</div>
            <ul className="text-muted-foreground space-y-0.5 list-disc pl-4">
              <li><b>Ollama</b> (LLM): pull dynamically below, then click <b>Sync</b>.</li>
              <li><b>Voicebox</b> (TTS): add / remove preset voices below; <b>Sync</b> refreshes the catalog.</li>
              <li><b>Whisper</b> (STT) sizes are baked into the deployed faster-whisper containers — adding a new size requires editing <code className="text-[10px]">docker-compose.yml</code> and restarting.</li>
              <li><b>Piper</b> (TTS) voices are seeded from <code className="text-[10px]">backend/app/seed_data.py</code>; voice files auto-download on first use.</li>
            </ul>
          </div>

          {/* Voicebox manager (collapsible) */}
          <div className="text-xs mb-3 bg-muted/40 px-3 py-2 rounded-lg border border-border">
            <button
              onClick={() => setVoiceboxOpen((v) => !v)}
              className="w-full flex items-center justify-between text-left"
            >
              <span className="font-medium text-foreground">Voicebox voices</span>
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground/60 text-[10px]">
                  {voiceboxOpen ? `${voiceboxProfiles.length} installed` : 'expand to manage'}
                </span>
                {voiceboxOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </span>
            </button>

            {voiceboxOpen && (
              <div className="mt-2 space-y-2.5">
                {/* Add a preset voice */}
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground">Engine</label>
                    <select
                      value={voiceboxEngine}
                      onChange={(e) => { setVoiceboxEngine(e.target.value); setVoiceboxPreset('') }}
                      className="bg-background border border-border rounded px-2 py-1 text-xs"
                      disabled={vbPresetsLoading}
                    >
                      {Object.keys(voiceboxPresets?.engines ?? { kokoro: null, qwen_custom_voice: null }).map((eng) => (
                        <option key={eng} value={eng}>{eng}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
                    <label className="text-[10px] text-muted-foreground">Preset voice</label>
                    <select
                      value={voiceboxPreset}
                      onChange={(e) => setVoiceboxPreset(e.target.value)}
                      className="bg-background border border-border rounded px-2 py-1 text-xs"
                      disabled={vbPresetsLoading}
                    >
                      <option value="">— select voice —</option>
                      {(voiceboxPresets?.engines?.[voiceboxEngine]?.voices ?? []).map((v) => (
                        <option key={v.voice_id} value={v.voice_id}>
                          {v.name} {v.gender ? `(${v.gender})` : ''} · {v.language}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={voiceboxAddPreset}
                    disabled={!voiceboxPreset || voiceboxStatus.state === 'busy'}
                    className="btn-secondary text-xs py-1 px-3"
                  >
                    {voiceboxStatus.state === 'busy' ? <Loader className="w-3 h-3 animate-spin" /> : 'Add voice'}
                  </button>
                </div>

                {voiceboxStatus.message && (
                  <div className={`text-[11px] ${voiceboxStatus.state === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {voiceboxStatus.message}
                  </div>
                )}

                {/* Installed voices list */}
                <div className="bg-background border border-border rounded-md max-h-48 overflow-y-auto">
                  {vbProfilesLoading && voiceboxProfiles.length === 0 ? (
                    <div className="px-2 py-3 text-center text-muted-foreground"><Loader className="w-3 h-3 animate-spin inline" /></div>
                  ) : voiceboxProfiles.length === 0 ? (
                    <div className="px-2 py-3 text-center text-muted-foreground/60 text-[11px]">No voices installed yet.</div>
                  ) : (
                    <ul className="divide-y divide-border">
                      {voiceboxProfiles.map((p) => (
                        <li key={p.id} className="px-2 py-1.5 flex items-center justify-between text-[11px]">
                          <div className="min-w-0">
                            <div className="text-foreground font-medium truncate">{p.name}</div>
                            <div className="text-muted-foreground/70 font-mono text-[10px] truncate">
                              {p.default_engine ?? p.preset_engine ?? '—'} · {p.language} · {p.voice_type ?? 'preset'}
                            </div>
                          </div>
                          <button
                            onClick={() => voiceboxDelete(p.id)}
                            className="text-muted-foreground/60 hover:text-destructive transition-colors flex-shrink-0 ml-2"
                            title="Remove voice"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Ollama pull form */}
          <div className="text-xs mb-3 bg-muted/40 px-3 py-2 rounded-lg border border-border">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="font-medium text-foreground">Pull a local Ollama model</span>
              <span className="text-muted-foreground/60 text-[10px]">e.g. llama3.2:3b, qwen3:8b, gemma3:4b</span>
            </div>
            <div className="flex gap-2">
              <input
                value={ollamaPullName}
                onChange={(e) => setOllamaPullName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && ollamaPullStatus.state !== 'pulling') handleOllamaPull() }}
                placeholder="model:tag"
                className="input-field py-1 text-xs flex-1 font-mono"
                disabled={ollamaPullStatus.state === 'pulling'}
              />
              <button
                onClick={handleOllamaPull}
                disabled={!ollamaPullName.trim() || ollamaPullStatus.state === 'pulling'}
                className="btn-secondary text-xs py-1 px-3"
              >
                {ollamaPullStatus.state === 'pulling' ? <Loader className="w-3 h-3 animate-spin" /> : 'Pull'}
              </button>
            </div>
            {ollamaPullStatus.message && (
              <div
                className={`mt-1.5 text-[11px] ${
                  ollamaPullStatus.state === 'error' ? 'text-destructive'
                  : ollamaPullStatus.state === 'done' ? 'text-green-600 dark:text-green-400'
                  : 'text-muted-foreground'
                }`}
              >
                {ollamaPullStatus.message}
              </div>
            )}
          </div>

          {loadingModels ? (
            <div className="flex justify-center py-6"><Loader className="w-5 h-5 animate-spin text-primary" /></div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <SortHeader label="Type" sortKey="type" sortConfig={sortConfig} onSort={handleSort} />
                    <SortHeader label="Label" sortKey="label" sortConfig={sortConfig} onSort={handleSort} />
                    <SortHeader label="Provider" sortKey="provider" sortConfig={sortConfig} onSort={handleSort} />
                    <SortHeader label="Latency" sortKey="latency" sortConfig={sortConfig} onSort={handleSort} />
                    <SortHeader label="Price" sortKey="price" sortConfig={sortConfig} onSort={handleSort} />
                    <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Profile</th>
                    <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Active</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-10 text-center text-sm text-muted-foreground">No models match your search</td>
                    </tr>
                  ) : (
                    filteredModels.map((m) => (
                      <ModelRow
                        key={m.id} model={m}
                        onToggle={(id, enabled) => toggleModel.mutate({ id, enabled })}
                        onDelete={(id) => deleteModel.mutate(id)}
                        onLabelSave={(id, label) => updateModelLabel.mutate({ id, label })}
                        onPatch={(id, patch) => patchModel.mutate({ id, patch })}
                        onResetToSeed={(id) => resetToSeed.mutate(id)}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Users Tab ── */}
      {activeTab === 'users' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">{users.length} user{users.length !== 1 ? 's' : ''}</span>
            <button
              onClick={() => { setShowAddUser((v) => !v); setUserFormError(null); setUserForm(EMPTY_USER_FORM) }}
              className="btn-secondary text-xs py-1.5 px-3"
            >
              {showAddUser ? <X className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
              {showAddUser ? 'Cancel' : 'Add User'}
            </button>
          </div>

          {showAddUser && (
            <form onSubmit={handleAddUserSubmit} className="bg-muted border border-border rounded-xl p-4 mb-4 space-y-3">
              <h4 className="text-sm font-semibold text-foreground">New User</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="label">Email</label>
                  <input type="email" required value={userForm.email}
                    onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))}
                    className="input-field" placeholder="user@example.com" />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input type="password" required value={userForm.password}
                    onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
                    className="input-field" placeholder="Min 8 characters" />
                </div>
                <div>
                  <label className="label">Role</label>
                  <select value={userForm.role}
                    onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value as 'admin' | 'customer' }))}
                    className="input-field">
                    <option value="customer">Customer</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              {userFormError && <p className="text-xs text-destructive">{userFormError}</p>}
              <button type="submit" disabled={createUser.isPending} className="btn-primary text-xs py-2 px-4">
                {createUser.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                Create User
              </button>
            </form>
          )}

          {loadingUsers ? (
            <div className="flex justify-center py-6"><Loader className="w-5 h-5 animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-2">
              {users.map((u) => {
                const activeAdminCount = users.filter((x) => x.role === 'admin' && x.is_active).length
                const isLastActiveAdmin = u.role === 'admin' && u.is_active && activeAdminCount <= 1
                return (
                  <div key={u.id} className="flex items-center justify-between bg-muted rounded-xl px-3 py-3 border border-border">
                    <div>
                      <p className="text-sm font-medium text-foreground">{u.email}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={u.role === 'admin' ? 'badge-admin' : 'badge-customer'}>{u.role}</span>
                        {isLastActiveAdmin && <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">last active admin</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => !isLastActiveAdmin && toggleUser.mutate({ id: u.id, is_active: !u.is_active })}
                      disabled={isLastActiveAdmin}
                      className={`transition-colors ${
                        isLastActiveAdmin ? 'text-green-500 opacity-30 cursor-not-allowed'
                        : u.is_active ? 'text-green-600 dark:text-green-400 hover:text-destructive'
                        : 'text-muted-foreground/40 hover:text-green-600 dark:hover:text-green-400'
                      }`}
                      title={isLastActiveAdmin ? 'Cannot disable last active admin' : u.is_active ? 'Deactivate' : 'Activate'}
                    >
                      {u.is_active ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Settings Tab ── */}
      {activeTab === 'settings' && (
        <div className="space-y-5">
          <div>
            <label className="label">Call duration limit (seconds)</label>
            <div className="flex gap-2">
              <input type="number" min={10} max={3600} value={callLimit}
                onChange={(e) => setCallLimit(e.target.value)} className="input-field" placeholder="60" />
              <button onClick={saveCallLimit} className="btn-primary px-4">
                {settingsSaved ? <Check className="w-4 h-4" /> : 'Save'}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">Default: 60s. Token TTL = this + 30s buffer.</p>
          </div>

          <div>
            <label className="label">Max concurrent calls per user</label>
            <div className="flex gap-2">
              <input type="number" min={1} max={50} value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)} className="input-field" placeholder="2" />
              <button onClick={() => saveQuota('max_concurrent_calls_per_user', maxConcurrent)} className="btn-primary px-4">
                {settingsSaved ? <Check className="w-4 h-4" /> : 'Save'}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">Customers hitting this get HTTP 429. Admins are exempt.</p>
          </div>

          <div>
            <label className="label">Max calls per user per day</label>
            <div className="flex gap-2">
              <input type="number" min={1} max={10000} value={maxPerDay}
                onChange={(e) => setMaxPerDay(e.target.value)} className="input-field" placeholder="50" />
              <button onClick={() => saveQuota('max_calls_per_day_per_user', maxPerDay)} className="btn-primary px-4">
                {settingsSaved ? <Check className="w-4 h-4" /> : 'Save'}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">Resets at UTC midnight. Cap a customer&apos;s daily vendor cost.</p>
          </div>
        </div>
      )}

      {/* ── Logs Tab ── */}
      {activeTab === 'logs' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">Backend logs</span>
              {logPolling && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> live
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={logTail}
                onChange={(e) => setLogTail(Number(e.target.value))}
                className="bg-muted border border-border rounded-md px-2 py-1 text-xs text-foreground"
              >
                {TAIL_OPTIONS.map((n) => <option key={n} value={n}>Last {n}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={logAutoScroll}
                  onChange={(e) => setLogAutoScroll(e.target.checked)}
                  className="accent-primary w-3 h-3" />
                Auto-scroll
              </label>
              <button onClick={fetchLogs} className="btn-secondary text-xs py-1 px-2">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
              <button onClick={clearLogs} className="text-xs text-muted-foreground/60 hover:text-destructive transition-colors">
                Clear
              </button>
            </div>
          </div>

          <div className="bg-background border border-border rounded-xl overflow-y-auto h-96 font-mono text-xs p-3 space-y-0.5">
            {logLines.length === 0 ? (
              <p className="text-muted-foreground text-center mt-16">No logs yet — activity will appear here.</p>
            ) : (
              logLines.map((line, i) => (
                <div key={i} className="flex gap-2 leading-5">
                  <span className="text-muted-foreground/50 flex-shrink-0 w-20 truncate">
                    {line.ts ? new Date(line.ts).toLocaleTimeString() : ''}
                  </span>
                  <span className={`uppercase w-14 flex-shrink-0 font-bold ${LEVEL_COLOR[line.level] ?? 'text-muted-foreground'}`}>
                    {line.level}
                  </span>
                  <span className="text-muted-foreground/60 flex-shrink-0 w-24 truncate">{line.logger}</span>
                  <span className={`flex-1 break-all ${LEVEL_COLOR[line.level] ?? 'text-foreground'}`}>{line.msg}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}
