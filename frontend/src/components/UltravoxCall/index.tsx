import React, { useState, useEffect, useRef } from 'react';
import { UltravoxSession, UltravoxSessionStatus } from 'ultravox-client';
import { PhoneOff, Mic, MicOff, Loader2, Signal, Volume2, Maximize2, Minimize2, AlertCircle } from 'lucide-react';
import api from '../../api/client';
import { useCallStore } from '../../store/callStore';

interface UltravoxCallProps {
  onClose: () => void;
}

export default function UltravoxCall({ onClose }: UltravoxCallProps) {
  const [status, setStatus] = useState<UltravoxSessionStatus>(UltravoxSessionStatus.IDLE);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const sessionRef = useRef<UltravoxSession | null>(null);
  const hasStarted = useRef(false);
  const statusRef = useRef<UltravoxSessionStatus>(UltravoxSessionStatus.IDLE);

  const { startCall, endCall, addMessage, setStatus: setStoreStatus, clearConversation } = useCallStore();

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    console.log('[Ultravox] Starting session initialization...');
    clearConversation();
    startUltravoxSession();

    // Fallback status polling using ref to avoid stale closure
    const interval = setInterval(() => {
      if (sessionRef.current && sessionRef.current.status !== statusRef.current) {
        console.log('[Ultravox] Polling detected status change:', sessionRef.current.status);
        syncStatus(sessionRef.current.status);
      }
    }, 500);

    return () => {
      console.log('[Ultravox] Cleaning up session...');
      clearInterval(interval);
      if (sessionRef.current) {
        sessionRef.current.leaveCall();
      }
      endCall();
    };
  }, []);

  const syncStatus = (newStatus: UltravoxSessionStatus) => {
    statusRef.current = newStatus;
    setStatus(newStatus);
    if (newStatus === UltravoxSessionStatus.IDLE) {
      console.log('[Ultravox] Sync: Call is now connected (IDLE = ready)');
      startCall('ultravox-session', 300);
      setStoreStatus('connected');
    } else if (newStatus === UltravoxSessionStatus.DISCONNECTED) {
      setStoreStatus('idle');
    }
  };

  const startUltravoxSession = async () => {
    try {
      statusRef.current = UltravoxSessionStatus.CONNECTING;
      setStatus(UltravoxSessionStatus.CONNECTING);
      const { data } = await api.post('/ultravox/create-web-call');

      if (!data.joinUrl) throw new Error('No join URL received from server');
      console.log('[Ultravox] Received joinUrl. Joining...');

      const session = new UltravoxSession();
      sessionRef.current = session;

      // SDK fires 'status' (UltravoxSessionStatusChangedEvent)
      const onStatus = () => {
        console.log('[Ultravox] Event: Status changed to', session.status);
        syncStatus(session.status);
      };
      session.addEventListener('status', onStatus);

      // SDK fires 'transcripts' (UltravoxTranscriptsChangedEvent); read from session.transcripts
      const seenFinals = new Set<string>();
      const onTranscripts = () => {
        for (const t of session.transcripts) {
          if (!t.isFinal) continue;
          const key = `${t.speaker}:${t.text}`;
          if (seenFinals.has(key)) continue;
          seenFinals.add(key);
          const role = t.speaker === 'agent' ? 'agent' : 'user';
          console.log(`[Ultravox] Final transcript [${role}]: ${t.text}`);
          addMessage({ role, text: t.text });
        }
      };
      session.addEventListener('transcripts', onTranscripts);

      session.addEventListener('error', (event: any) => {
        console.error('[Ultravox] Session Error:', event);
        setError(`Connection Error: ${event.message || 'Check your internet or Ultravox balance.'}`);
      });

      console.log('[Ultravox] Calling session.joinCall...');
      await session.joinCall(data.joinUrl);
      console.log('[Ultravox] session.joinCall completed.');
      
      // If joinCall completed but status is still CONNECTING, wait for statuschanged event
      if (session.status === UltravoxSessionStatus.CONNECTING) {
        console.log('[Ultravox] joinCall finished but status still CONNECTING. Waiting for IDLE...');
      }
      
    } catch (err: any) {
      console.error('[Ultravox] Fatal error:', err);
      const msg = err.response?.data?.error || err.message || 'Failed to start call';
      setError(msg.includes('402') ? 'Ultravox balance empty. Please top up.' : msg);
      setStatus(UltravoxSessionStatus.IDLE);
      setStoreStatus('error');
    }
  };

  const handleHangup = () => {
    if (sessionRef.current) {
      sessionRef.current.leaveCall();
    }
    onClose();
  };

  const toggleMute = () => {
    if (sessionRef.current) {
      const newMuted = !isMuted;
      setIsMuted(newMuted);
    }
  };

  const isConnecting = status === UltravoxSessionStatus.CONNECTING;
  const isLive = status === UltravoxSessionStatus.IDLE
    || status === UltravoxSessionStatus.LISTENING
    || status === UltravoxSessionStatus.THINKING
    || status === UltravoxSessionStatus.SPEAKING;

  const liveStatusLabel =
    status === UltravoxSessionStatus.SPEAKING ? 'Speaking' :
    status === UltravoxSessionStatus.THINKING ? 'Thinking' :
    status === UltravoxSessionStatus.LISTENING ? 'Listening' : 'Live';

  return (
    <div className={`fixed z-[100] transition-all duration-500 ease-in-out ${
      isMinimized 
        ? 'bottom-6 right-6 w-16 h-16 rounded-full overflow-hidden' 
        : 'bottom-6 left-6 w-full max-w-sm'
    }`}>
      {isMinimized ? (
        <button 
          onClick={() => setIsMinimized(false)}
          className="w-full h-full bg-primary flex items-center justify-center text-white shadow-2xl animate-pulse"
        >
          <Maximize2 className="w-6 h-6" />
        </button>
      ) : (
        <div className="bg-card/95 border border-border/50 rounded-[2.5rem] shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md overflow-hidden p-8 flex flex-col items-center gap-6 relative animate-in slide-in-from-bottom-10">
          
          <div className="absolute top-6 right-8 flex gap-2">
            <button 
              onClick={() => setIsMinimized(true)}
              className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
              title="Minimize"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </div>

          <div className="absolute top-0 left-0 w-full h-24 bg-gradient-to-b from-primary/10 to-transparent pointer-events-none" />

          <div className="relative mt-2">
            <div className={`w-24 h-24 rounded-full bg-primary/5 flex items-center justify-center border-2 border-primary/20 ${isLive ? 'ring-4 ring-primary/10 animate-pulse' : ''}`}>
              <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-primary to-primary-foreground/20 flex items-center justify-center text-primary-foreground shadow-2xl relative overflow-hidden">
                <span className="text-2xl font-black tracking-tighter text-white">UV</span>
              </div>
            </div>
            {isLive && (
              <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-4 border-card flex items-center justify-center shadow-lg">
                <div className="w-1.5 h-1.5 bg-white rounded-full animate-ping" />
              </div>
            )}
          </div>

          <div className="text-center space-y-1 z-10">
            <h2 className="text-xl font-bold tracking-tight text-foreground">Ultravox AI</h2>
            <div className="flex items-center justify-center gap-2">
              <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md ${isLive ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}>
                {isConnecting ? 'Connecting…' : isLive ? liveStatusLabel : 'Disconnected'}
              </span>
              {isLive && <span className="text-[10px] text-muted-foreground font-medium flex items-center gap-1"><Signal className="w-3 h-3" /> Encrypted</span>}
            </div>
          </div>

          <div className="h-16 flex items-center justify-center gap-1.5 w-full px-4">
            {isLive ? (
              [...Array(10)].map((_, i) => (
                <div 
                  key={i}
                  className="w-1 bg-primary/80 rounded-full animate-voice-wave"
                  style={{ 
                    height: `${20 + Math.random() * 60}%`, 
                    animationDelay: `${i * 0.08}s`,
                    opacity: 0.3 + (i / 10) * 0.7
                  }}
                />
              ))
            ) : isConnecting && !error ? (
              <div className="flex flex-col items-center gap-1">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                <span className="text-[8px] text-muted-foreground font-bold uppercase tracking-tighter">Connecting</span>
              </div>
            ) : error ? (
              <AlertCircle className="w-8 h-8 text-destructive animate-bounce" />
            ) : (
              <Volume2 className="w-6 h-6 text-muted-foreground/20" />
            )}
          </div>

          {error && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2 max-w-xs animate-in slide-in-from-bottom-2">
              <p className="text-[11px] text-destructive text-center font-medium leading-tight">
                {error}
              </p>
            </div>
          )}

          <div className="flex items-center gap-6 z-10">
            <button
              onClick={toggleMute}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-lg active:scale-90 ${
                isMuted 
                  ? 'bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20' 
                  : 'bg-muted text-foreground border border-border/50 hover:bg-muted/80'
              }`}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            <button
              onClick={handleHangup}
              className="w-16 h-16 rounded-3xl bg-destructive flex items-center justify-center text-white shadow-[0_10px_20px_-5px_rgba(239,68,68,0.4)] hover:bg-destructive/90 transition-all hover:scale-105 active:scale-95 group"
            >
              <PhoneOff className="w-6 h-6 group-hover:rotate-12 transition-transform" />
            </button>
          </div>

          <div className="text-[9px] text-muted-foreground/40 font-bold uppercase tracking-[0.2em]">
            Ultravox Realtime Protocol
          </div>
        </div>
      )}
    </div>
  );
}
