import { useEffect, useRef, useState } from 'react'
import { Download, AlertCircle, Loader, CheckCircle, X } from 'lucide-react'
import api from '../../api/client'

type SetupStatus = {
  state: 'idle' | 'downloading' | 'ready' | 'error'
  message: string
  detail: string
  last_log: string
  ready: boolean
}

type Props = {
  open: boolean
  onClose: () => void
  onReady: () => void
}

export default function SetupReadyModal({ open, onClose, onReady }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [triggering, setTriggering] = useState(false)
  const [pollErr, setPollErr] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await api.get<SetupStatus>('/setup/turn-detector/status')
        if (cancelled) return
        setStatus(res.data)
        setPollErr(null)
        if (res.data.ready && res.data.state !== 'downloading') {
          onReady()
        }
      } catch (e: unknown) {
        const msg = (e as { message?: string })?.message ?? 'Status check failed'
        if (!cancelled) setPollErr(msg)
      }
    }
    poll()
    pollRef.current = window.setInterval(poll, 1500)
    return () => {
      cancelled = true
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [open, onReady])

  const triggerDownload = async () => {
    setTriggering(true)
    try {
      const res = await api.post<SetupStatus>('/setup/turn-detector/download')
      setStatus(res.data)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } }; message?: string })
        ?.response?.data?.detail ?? (e as { message?: string })?.message ?? 'Failed to start download'
      setPollErr(msg)
    } finally {
      setTriggering(false)
    }
  }

  if (!open) return null

  const state = status?.state ?? 'idle'
  const isDownloading = state === 'downloading'
  const isError = state === 'error'
  const isReady = !!status?.ready

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Download className="w-5 h-5 text-primary" />
              Voice model setup
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              The turn-detector model is required for natural conversations.
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {!status && !pollErr && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader className="w-4 h-4 animate-spin" /> Checking status…
          </div>
        )}

        {pollErr && (
          <div className="flex items-start gap-2 bg-destructive/8 border border-destructive/20 rounded-lg px-3 py-2.5 text-destructive text-sm mb-3">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{pollErr}</span>
          </div>
        )}

        {status && !isReady && !isDownloading && !isError && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-700 rounded-lg px-3 py-2.5 text-yellow-700 dark:text-yellow-400 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Model files are missing. Click below to download them (~50 MB, takes ~30 seconds).</span>
            </div>
            <button
              onClick={triggerDownload}
              disabled={triggering}
              className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
            >
              {triggering ? <Loader className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {triggering ? 'Starting…' : 'Download model'}
            </button>
          </div>
        )}

        {isDownloading && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Loader className="w-4 h-4 animate-spin text-primary" />
              <span>{status?.message || 'Downloading…'}</span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary animate-pulse w-1/2" />
            </div>
            {status?.last_log && (
              <pre className="text-xs text-muted-foreground/70 bg-muted/50 rounded-lg p-2.5 max-h-24 overflow-auto whitespace-pre-wrap break-all">
                {status.last_log}
              </pre>
            )}
          </div>
        )}

        {isError && status && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 bg-destructive/8 border border-destructive/20 rounded-lg px-3 py-2.5 text-destructive text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="font-medium">{status.message}</div>
                {status.detail && (
                  <pre className="text-xs mt-2 opacity-80 whitespace-pre-wrap break-all">{status.detail}</pre>
                )}
              </div>
            </div>
            <button
              onClick={triggerDownload}
              disabled={triggering}
              className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" /> Retry download
            </button>
          </div>
        )}

        {isReady && (
          <div className="flex items-center gap-2 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2.5 text-green-700 dark:text-green-400 text-sm">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            <span>Model ready. Starting your call…</span>
          </div>
        )}
      </div>
    </div>
  )
}
