import { useEffect, useRef, useState, useCallback } from 'react'
import { Mic, MicOff, PhoneOff, Phone, AlertCircle, Loader, Clock, ChevronDown, ChevronUp } from 'lucide-react'
import { Room, RoomEvent, Track } from 'livekit-client'
import api from '../../api/client'
import { useCallStore } from '../../store/callStore'
import { useModelStore } from '../../store/modelStore'
import { useAuthStore } from '../../store/authStore'
import { useUIStore } from '../../store/uiStore'
import SetupReadyModal from './SetupReadyModal'

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  groq: 'Groq',
  anthropic: 'Anthropic',
  google: 'Google (Gemini)',
  deepseek: 'DeepSeek',
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function CallInterface() {
  const {
    status, error, setStatus, setError, addMessage, updateMetrics, setPipelineStage,
    startCall, endCall, callStartedAt, callLimitSeconds,
  } = useCallStore()
  const { getSelectedConfig, selectedLlm } = useModelStore()
  const { isAdmin } = useAuthStore()
  const openConfigModal = useUIStore((s) => s.openConfigModal)

  const roomRef = useRef<Room | null>(null)
  const audioElementsRef = useRef<HTMLAudioElement[]>([])
  const [muted, setMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [showWarning, setShowWarning] = useState(false)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [showErrorDetail, setShowErrorDetail] = useState(false)
  const [showSetupModal, setShowSetupModal] = useState(false)
  const prevLlmRef = useRef(selectedLlm?.model)

  useEffect(() => {
    if (prevLlmRef.current && prevLlmRef.current !== selectedLlm?.model) {
      useCallStore.getState().clearConversation()
    }
    prevLlmRef.current = selectedLlm?.model
  }, [selectedLlm?.model])

  useEffect(() => {
    if (!callStartedAt || status !== 'connected') {
      setElapsed(0)
      setShowWarning(false)
      return
    }
    const interval = setInterval(() => {
      const e = Math.floor((Date.now() - callStartedAt) / 1000)
      setElapsed(e)
      const remaining = callLimitSeconds - e
      if (remaining <= 10 && remaining > 0) setShowWarning(true)
      if (remaining <= 0) { handleEndCall(); clearInterval(interval) }
    }, 1000)
    return () => clearInterval(interval)
  }, [callStartedAt, status, callLimitSeconds])

  const handleDataReceived = useCallback(
    (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload))
        if (msg.type === 'metrics') {
          const { stage, duration_ms, ttft_ms, tokens_per_second, total_tokens } = msg
          if (stage === 'stt') { updateMetrics({ stt_ms: duration_ms }); setPipelineStage('llm') }
          if (stage === 'llm') { updateMetrics({ llm_ms: duration_ms, ttft_ms, tokens_per_second, total_tokens }); setPipelineStage('tts') }
          if (stage === 'tts') { updateMetrics({ tts_ms: duration_ms }); setPipelineStage('listening') }
        } else if (msg.type === 'transcript') {
          addMessage({ role: msg.role === 'agent' ? 'agent' : 'user', text: msg.text })
          if (msg.role === 'user') setPipelineStage('llm')
        } else if (msg.type === 'error') {
          setError(msg.message)
        } else if (msg.type === 'model_missing') {
          setError(msg.message)
          setErrorDetail(msg.detail || msg.message)
          setShowSetupModal(true)
        }
      } catch {}
    },
    [updateMetrics, addMessage, setError, setPipelineStage],
  )

  const cleanupAudio = () => {
    audioElementsRef.current.forEach((el) => { el.pause(); el.remove() })
    audioElementsRef.current = []
  }

  const handleStartCall = async () => {
    const cfg = getSelectedConfig()
    if (!cfg) return
    setError(null)
    setErrorDetail(null)
    setShowErrorDetail(false)

    // Pre-flight: paid LLM picked but no API key on file → open the config modal
    // focused on the right provider instead of letting the backend reject /token.
    if (selectedLlm?.requires_api_key) {
      const provider = selectedLlm.provider
      const label = PROVIDER_LABELS[provider] ?? provider
      setError(`Add an API key for ${label} to use this model.`)
      openConfigModal(provider)
      return
    }

    // Pre-flight: make sure the turn-detector model is ready. If not, show the
    // setup modal and bail — the modal calls back into handleStartCall once ready.
    try {
      const probe = await api.get<{ ready: boolean; state: string }>('/setup/turn-detector/status')
      if (!probe.data.ready) {
        setShowSetupModal(true)
        return
      }
    } catch {
      // Status endpoint failure shouldn't block the call — fall through.
    }

    setStatus('connecting')

    try {
      const res = await api.post('/token', cfg)
      const { token, url, room, call_limit_seconds } = res.data

      const lkRoom = new Room({ adaptiveStream: true, dynacast: true })
      lkRoom.on(RoomEvent.DataReceived, (payload: Uint8Array) => handleDataReceived(payload))
      lkRoom.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const audioEl = track.attach() as HTMLAudioElement
          audioEl.autoplay = true
          document.body.appendChild(audioEl)
          audioElementsRef.current.push(audioEl)
          audioEl.play().catch(() => {})
        }
      })
      lkRoom.on(RoomEvent.TrackUnsubscribed, (track) => { track.detach() })
      lkRoom.on(RoomEvent.Disconnected, () => { cleanupAudio(); endCall() })

      await lkRoom.connect(url, token)
      await lkRoom.localParticipant.setMicrophoneEnabled(true)
      roomRef.current = lkRoom
      startCall(room, call_limit_seconds)
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { detail?: string }; status?: number }; message?: string }
      const apiDetail = axiosErr.response?.data?.detail
      const status = axiosErr.response?.status
      const rawMessage = axiosErr.message ?? String(err)
      const fullDetail = apiDetail
        ? `${apiDetail}${status ? ` (HTTP ${status})` : ''}`
        : rawMessage

      setErrorDetail(fullDetail)
      setShowErrorDetail(false)
      // 429 (quota) gets a user-facing message even for non-admins — they need
      // to know it's a quota, not a bad config.
      if (status === 429 && apiDetail) {
        setError(apiDetail)
      } else {
        setError(isAdmin() ? fullDetail : 'Failed to start call. Check your configuration.')
      }
      setStatus('error')
    }
  }

  const handleEndCall = async () => {
    setStatus('disconnecting')
    try {
      if (roomRef.current) { await roomRef.current.disconnect(); roomRef.current = null }
    } catch {}
    cleanupAudio()
    endCall()
    setMuted(false)
  }

  const toggleMute = async () => {
    if (!roomRef.current) return
    const nextMuted = !muted
    // Optimistic UI — flip the icon immediately, then sync the room state.
    setMuted(nextMuted)
    try {
      await roomRef.current.localParticipant.setMicrophoneEnabled(!nextMuted)
    } catch (e) {
      // Revert if LiveKit refused the toggle (e.g., permission revoked).
      setMuted(!nextMuted)
      console.error('Failed to toggle microphone:', e)
    }
  }

  const remaining = callLimitSeconds - elapsed
  const isActive = status === 'connected'
  const isLoading = status === 'connecting' || status === 'disconnecting'

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="section-title">
          <Phone className="w-4 h-4 text-primary" />
          Voice Call
        </h3>

        {/* Status pill */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
          isActive
            ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
            : isLoading
            ? 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-400'
            : status === 'error'
            ? 'bg-destructive/8 border-destructive/20 text-destructive'
            : 'bg-muted border-border text-muted-foreground'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${
            isActive ? 'bg-green-500 animate-pulse'
            : isLoading ? 'bg-yellow-500 animate-pulse'
            : status === 'error' ? 'bg-destructive'
            : 'bg-muted-foreground/40'
          }`} />
          {isActive ? `${formatTime(elapsed)}`
            : isLoading ? (status === 'connecting' ? 'Connecting…' : 'Ending…')
            : status === 'error' ? 'Error'
            : 'Ready'}
        </div>
      </div>

      {/* Timer countdown */}
      {isActive && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
          <Clock className="w-3 h-3" />
          <span>{formatTime(Math.max(0, remaining))} remaining</span>
        </div>
      )}

      {/* Mute indicator */}
      {isActive && muted && (
        <div className="flex items-center gap-2 bg-destructive/8 border border-destructive/20 rounded-lg px-3 py-2 mb-3 text-destructive text-xs font-medium">
          <MicOff className="w-3.5 h-3.5" /> Microphone muted
        </div>
      )}

      {/* Warning */}
      {showWarning && isActive && (
        <div className="flex items-center gap-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-700 rounded-lg px-3 py-2 mb-3 text-yellow-700 dark:text-yellow-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Call ending in {remaining}s
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-destructive/8 border border-destructive/20 rounded-lg px-3 py-2.5 mb-3">
          <div className="flex items-start gap-2 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
          {isAdmin() && errorDetail && errorDetail !== error && (
            <button
              onClick={() => setShowErrorDetail((v) => !v)}
              className="mt-1.5 flex items-center gap-1 text-xs text-destructive/70 hover:text-destructive transition-colors"
            >
              {showErrorDetail ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showErrorDetail ? 'Hide' : 'Show'} raw error
            </button>
          )}
          {isAdmin() && showErrorDetail && errorDetail && (
            <pre className="mt-2 text-xs text-destructive/80 bg-destructive/5 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
              {errorDetail}
            </pre>
          )}
        </div>
      )}

      {/* Mic permission heads-up — only shown before the first call so we
          don't surprise the user with the browser permission prompt. */}
      {!isActive && !isLoading && !error && (
        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
          <Mic className="w-3 h-3" />
          Your browser will ask for microphone access on click.
        </p>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2.5">
        {!isActive && !isLoading ? (
          <button
            onClick={handleStartCall}
            className="flex-1 flex items-center justify-center gap-2 btn-primary py-2.5 text-base"
          >
            <Phone className="w-4 h-4" /> Start Call
          </button>
        ) : isLoading ? (
          <button disabled className="flex-1 flex items-center justify-center gap-2 bg-muted text-muted-foreground font-medium py-2.5 rounded-lg cursor-not-allowed text-sm border border-border">
            <Loader className="w-4 h-4 animate-spin" />
            {status === 'connecting' ? 'Connecting…' : 'Ending…'}
          </button>
        ) : (
          <>
            <button
              onClick={toggleMute}
              className={`flex items-center justify-center w-11 h-11 rounded-xl transition-all border ${
                muted
                  ? 'bg-destructive/10 border-destructive/30 text-destructive hover:bg-destructive/15'
                  : 'bg-muted border-border text-muted-foreground hover:border-primary hover:text-primary'
              }`}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <button
              onClick={handleEndCall}
              className="flex-1 flex items-center justify-center gap-2 btn-danger py-2.5"
            >
              <PhoneOff className="w-4 h-4" /> End Call
            </button>
          </>
        )}
      </div>

      <SetupReadyModal
        open={showSetupModal}
        onClose={() => setShowSetupModal(false)}
        onReady={() => {
          if (showSetupModal) {
            setShowSetupModal(false)
            // Auto-resume only if we were trying to start a call (not connected).
            if (status !== 'connected' && status !== 'connecting') {
              handleStartCall()
            }
          }
        }}
      />
    </div>
  )
}
