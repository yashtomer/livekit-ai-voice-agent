import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/+esm';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const callBtn = $('call-btn');
const transcriptEl = $('transcript');
const infoEl = $('info-text');
const errorBanner = $('error-banner');
const errorText = errorBanner.querySelector('.error-text');

let room = null;
let watchdogTimer = null;
let localWasSpeaking = false;
const interimByParticipant = new Map();

// ─── Metrics display ───
const MAX_BAR_MS = 10000; // 10s = 100% bar width

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function speedClass(ms) {
  if (ms < 500) return 'fast';
  if (ms < 2000) return 'ok';
  return 'slow';
}

function updateMetric(id, ms) {
  const valueEl = $(id);
  if (!valueEl) return;
  valueEl.textContent = formatMs(ms);
  valueEl.className = `metric-value ${speedClass(ms)} pulsing`;
  setTimeout(() => valueEl.classList.remove('pulsing'), 600);

  // Update bar width
  const barId = id.replace('m-', 'bar-');
  const barEl = $(barId);
  if (barEl) {
    const pct = Math.min(100, (ms / MAX_BAR_MS) * 100);
    barEl.style.width = `${pct}%`;
  }
}

function resetMetrics() {
  for (const id of ['m-stt', 'm-llm', 'm-tts', 'm-total']) {
    const el = $(id);
    if (el) { el.textContent = '—'; el.className = 'metric-value'; }
  }
  for (const id of ['bar-stt', 'bar-llm', 'bar-tts']) {
    const el = $(id);
    if (el) el.style.width = '0%';
  }
  setStageActive(null);
}

// Mark which pipeline stage is currently running so the user can see where
// the delay is. The agent only emits metrics when each stage *finishes*, so
// we infer the "running" stage from state transitions:
//   user starts transcribing → STT active
//   STT metric arrives        → LLM active (LLM just started)
//   LLM metric arrives        → TTS active (TTS just started)
//   TTS metric arrives        → none (turn complete)
function setStageActive(stage) {
  for (const s of ['stt', 'llm', 'tts']) {
    const row = $(`m-${s}`)?.closest('.metric');
    if (!row) continue;
    if (s === stage) {
      row.classList.add('active');
      // Replace the stale value with a "running" placeholder so the user
      // gets a clear visual cue that this stage is in progress.
      const valueEl = $(`m-${s}`);
      if (valueEl) {
        valueEl.textContent = '…';
        valueEl.className = 'metric-value running';
      }
    } else {
      row.classList.remove('active');
    }
  }
}

let turnTotalMs = 0;

function handleMetrics(data) {
  if (data.stage === 'stt') {
    turnTotalMs = 0; // new turn
    updateMetric('m-stt', data.duration_ms);
    turnTotalMs += data.duration_ms;
    updateMetric('m-total', turnTotalMs);
    setStageActive('llm'); // LLM is now running
  } else if (data.stage === 'llm') {
    updateMetric('m-llm', data.duration_ms);
    turnTotalMs += data.duration_ms;
    updateMetric('m-total', turnTotalMs);
    setStageActive('tts'); // TTS is now running
  } else if (data.stage === 'tts') {
    updateMetric('m-tts', data.duration_ms);
    turnTotalMs += data.duration_ms;
    updateMetric('m-total', turnTotalMs);
    setStageActive(null); // turn complete
  }
}

function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = text;
}

function setInfo(text) {
  infoEl.textContent = text;
}

function showError(message) {
  console.error('[voice-agent]', message);
  errorText.textContent = message;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.hidden = true;
  errorText.textContent = '';
}

function cleanup() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  setStatus('disconnected', 'Disconnected');
  callBtn.textContent = 'Start Call';
  callBtn.classList.remove('active');
  callBtn.disabled = false;
  setStageActive(null);
  localWasSpeaking = false;
  if (room) {
    room.disconnect().catch(() => {});
    room = null;
  }
}

errorBanner.querySelector('.error-close').addEventListener('click', clearError);

// Catch any uncaught JS errors / rejections
window.addEventListener('error', (e) => showError(`JS error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  showError(`Error: ${msg}`);
});

function fillSelect(selectEl, items, makeValue, makeLabel) {
  selectEl.innerHTML = '';
  if (items.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No options available';
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = makeValue(item);
    opt.textContent = makeLabel(item);
    opt.dataset.item = JSON.stringify(item);
    selectEl.appendChild(opt);
  }
}

async function populateDropdowns() {
  // Loading state: visible spinner + "Loading…" placeholder on each select
  // so the user sees progress while /api/models resolves (1-5s on cold Ollama).
  const selectIds = ['llm', 'stt', 'tts'];
  selectIds.forEach(id => {
    $(id).closest('.field')?.classList.add('loading');
    $(id).innerHTML = '<option disabled selected>Loading…</option>';
  });

  try {
    const res = await fetch('/api/models');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    fillSelect($('llm'), data.llm, (i) => `${i.provider}:${i.model}`, (i) => i.label);
    fillSelect($('stt'), data.stt, (i) => `${i.provider}:${i.size || i.model}`, (i) => i.label);
    fillSelect($('tts'), data.tts, (i) => `${i.provider}:${i.voice}`, (i) => i.label);

    if (data.ollama_error) showError(`Ollama unreachable: ${data.ollama_error}`);
    if (data.llm.length === 0) {
      showError('No LLM models found. Install Ollama models or set GROQ_API_KEY/ANTHROPIC_API_KEY in .env.');
    } else {
      setInfo(`${data.llm.length} LLM · ${data.stt.length} STT · ${data.tts.length} TTS options`);
    }
  } catch (e) {
    showError(`Failed to load models from token server: ${e.message}`);
  } finally {
    selectIds.forEach(id => $(id).closest('.field')?.classList.remove('loading'));
  }
}

function readConfig() {
  const getSelected = (selectEl) => {
    const opt = selectEl.selectedOptions[0];
    return opt ? JSON.parse(opt.dataset.item) : null;
  };
  return {
    llm: getSelected($('llm')),
    stt: getSelected($('stt')),
    tts: getSelected($('tts')),
  };
}

function appendLine(who, text, interim = false) {
  if (interim) {
    let el = interimByParticipant.get(who);
    if (!el) {
      el = document.createElement('div');
      el.className = `line ${who === 'user' ? 'user' : 'agent'} interim`;
      el.innerHTML = `<div class="who">${who}</div><div class="text"></div>`;
      // Prepend: newest line goes to the top of the transcript
      transcriptEl.insertBefore(el, transcriptEl.firstChild);
      interimByParticipant.set(who, el);
    }
    el.querySelector('.text').textContent = text;
  } else {
    const interimEl = interimByParticipant.get(who);
    if (interimEl) {
      interimEl.classList.remove('interim');
      interimEl.querySelector('.text').textContent = text;
      interimByParticipant.delete(who);
    } else {
      const el = document.createElement('div');
      el.className = `line ${who === 'user' ? 'user' : 'agent'}`;
      el.innerHTML = `<div class="who">${who}</div><div class="text"></div>`;
      el.querySelector('.text').textContent = text;
      // Prepend: newest line goes to the top of the transcript
      transcriptEl.insertBefore(el, transcriptEl.firstChild);
    }
  }
  // Latest-on-top: pin scroll to the top so the newest entry is always visible
  transcriptEl.scrollTop = 0;
}

async function connect() {
  clearError();
  resetMetrics();
  const cfg = readConfig();
  if (!cfg.llm || !cfg.stt || !cfg.tts) {
    showError('Please select an LLM, STT, and TTS option.');
    return;
  }

  setStatus('connecting', 'Requesting token...');
  callBtn.disabled = true;

  let connected = false;
  let agentJoined = false;
  let livekitUrl = '';

  // Kill-switch: if no Connected event fires within 20s, force-show an error.
  // (20s is generous — the Connected event is the websocket handshake with
  // LiveKit, usually <1s. A timeout here means LiveKit itself is unreachable.)
  watchdogTimer = setTimeout(() => {
    if (connected) return;
    showError(
      `Connection to LiveKit timed out after 20 seconds (server at ${livekitUrl || 'ws://localhost:7880'}). ` +
      `Check: 1) \`docker compose ps\` shows livekit-server up; 2) port 7880 is reachable; 3) your browser can access it.`
    );
    cleanup();
  }, 20000);

  try {
    const tokenRes = await fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!tokenRes.ok) {
      throw new Error(`Token server returned ${tokenRes.status}: ${await tokenRes.text().catch(() => tokenRes.statusText)}`);
    }
    const { token, url, room: roomName } = await tokenRes.json();
    livekitUrl = url;

    setStatus('connecting', `Connecting to ${url}...`);

    room = new Room({ adaptiveStream: true, dynacast: true });

    room
      .on(RoomEvent.Connected, () => {
        connected = true;
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
        setStatus('connected', `Connected · ${roomName}`);
        callBtn.textContent = 'End Call';
        callBtn.classList.add('active');
        callBtn.disabled = false;

        // Warn (but don't disconnect) if the agent hasn't joined yet.
        // Cold-start on Intel Mac can take 20-30s: process fork (~8s) +
        // Ollama model load (~3s) + Piper/Voicebox warmup (~6-15s).
        setTimeout(() => {
          if (room && !agentJoined) {
            showError('Agent is taking longer than expected to join (>45s). Is the voice agent worker running? Try: `uv run python src/agent.py dev`');
          }
        }, 45000);
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
        if (reason === DisconnectReason.CLIENT_INITIATED) {
          // Explicit user action — no error
        } else if (!connected) {
          showError(`Connection refused by LiveKit server (reason: ${reason ?? 'unknown'}). Check server logs.`);
        } else {
          showError(`Disconnected from room (reason: ${reason ?? 'unknown'}).`);
        }
        setStatus('disconnected', 'Disconnected');
        callBtn.textContent = 'Start Call';
        callBtn.classList.remove('active');
        callBtn.disabled = false;
        room = null;
      })
      .on(RoomEvent.Reconnecting, () => {
        setStatus('connecting', 'Reconnecting...');
      })
      .on(RoomEvent.Reconnected, () => {
        setStatus('connected', `Connected · ${roomName}`);
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (p.identity !== room?.localParticipant?.identity) agentJoined = true;
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.identity !== room?.localParticipant?.identity && connected) {
          showError(`Agent "${p.identity}" left the room. Check the agent logs.`);
        }
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.style.display = 'none';
          document.body.appendChild(el);
        }
      })
      .on(RoomEvent.TrackSubscriptionFailed, (sid, p) => {
        showError(`Failed to subscribe to audio track from ${p?.identity || 'agent'}.`);
      })
      .on(RoomEvent.MediaDevicesError, (e) => {
        showError(`Media device error: ${e.message}. Check browser microphone permissions.`);
      })
      .on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        const isUser = participant?.identity === room?.localParticipant?.identity;
        const who = isUser ? 'user' : 'agent';
        for (const seg of segments) {
          // User interim → STT is streaming (works for Deepgram etc.).
          // For non-streaming STT like Whisper, the speaker-transition
          // handler below kicks in instead.
          if (isUser && !seg.final) setStageActive('stt');
          appendLine(who, seg.text, !seg.final);
          // Capture the latest finalized agent utterance — used by
          // the voice-comparison panel so samples reflect what was actually said.
          if (!isUser && seg.final && seg.text.trim()) {
            setVoiceCompareText(seg.text);
          }
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        // Detect when the local user stops speaking — that's when
        // non-streaming STT (Whisper) starts processing.
        const localId = room?.localParticipant?.identity;
        const localSpeakingNow = speakers.some(s => s.identity === localId);
        if (localWasSpeaking && !localSpeakingNow) {
          // User just stopped — STT is transcribing now
          setStageActive('stt');
        }
        localWasSpeaking = localSpeakingNow;
      })
      .on(RoomEvent.DataReceived, (payload, participant) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg.type === 'metrics') {
            handleMetrics(msg);
          } else if (msg.type === 'error') {
            showError(msg.message || 'Unknown agent error');
          }
        } catch {}
      });

    await room.connect(url, token);

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (micErr) {
      showError(`Microphone access denied: ${micErr.message}. Grant mic permission and try again.`);
      throw micErr;
    }

    setInfo(`LLM: ${cfg.llm.label} · STT: ${cfg.stt.label} · TTS: ${cfg.tts.label}`);
  } catch (e) {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    if (errorBanner.hidden) {
      showError(`Connection failed: ${e.message}`);
    }
    cleanup();
  }
}

async function disconnect() {
  if (room) {
    await room.disconnect();
    room = null;
  }
}

callBtn.addEventListener('click', () => {
  if (room) disconnect();
  else connect();
});

// ─── Cost Calculator ───

// Pricing per provider/model (monthly estimates based on usage assumptions)
// STT: charged per audio hour processed
// LLM: charged per 1M tokens (we estimate ~17M input + 6M output per 240hrs)
// TTS: charged per 1K characters (we estimate ~300 chars/min of agent speech)
// All prices here are USD/hr assuming ~71K tokens/hr LLM load and
// ~18K chars/hr TTS (avg for a busy voice agent — 300 chars/min).
const PRICING = {
  stt: {
    'whisper_local': { perHour: 0, freeLabel: 'Local (free)' },
    'groq:whisper-large-v3-turbo': { perHour: 0.04 },
    'groq:whisper-large-v3': { perHour: 0.111 },
    'openai:whisper-1': { perHour: 0.36 },              // $0.006/min × 60
    'deepgram:nova-3-general': { perHour: 0.258 },      // $0.0043/min × 60
    'deepgram:nova-2-general': { perHour: 0.258 },
  },
  llm: {
    'ollama': { perHour: 0, freeLabel: 'Local (free)' },
    // Groq
    'groq:llama-3.1-8b-instant': { perHour: 0.014 },
    'groq:llama-3.3-70b-versatile': { perHour: 0.17 },
    'groq:qwen/qwen3-32b': { perHour: 0.12 },
    // OpenAI (blended input/output for voice agent)
    'openai:gpt-4o-mini': { perHour: 0.03 },
    'openai:gpt-4o': { perHour: 0.45 },
    // Google
    'google:gemini-2.0-flash': { perHour: 0.02 },
    'google:gemini-1.5-flash': { perHour: 0.015 },
    // Anthropic
    'anthropic:claude-haiku-4-5': { perHour: 0.21 },
    'anthropic:claude-sonnet-4-5': { perHour: 3.10 },
    // DeepSeek
    'deepseek:deepseek-chat': { perHour: 0.04 },
  },
  tts: {
    'piper_local': { perHour: 0, freeLabel: 'Local (free)' },
    'voicebox':    { perHour: 0, freeLabel: 'Voicebox (local, free)' },
    'edge': { perHour: 0, freeLabel: 'Edge TTS (free)' },
    'groq:canopylabs/orpheus-v1-english': { perHour: 0.90 },
    // ElevenLabs: $0.15/1K chars (Flash), $0.30/1K chars (Multilingual v2)
    'elevenlabs:eleven_flash_v2_5': { perHour: 2.70 },
    'elevenlabs:eleven_multilingual_v2': { perHour: 5.40 },
    'elevenlabs:eleven_turbo_v2_5': { perHour: 3.60 },
    // OpenAI TTS: $15/1M chars tts-1, $30/1M tts-1-hd
    'openai:tts-1': { perHour: 0.27 },
    'openai:tts-1-hd': { perHour: 0.54 },
  },
};

// ─── AWS Server Scenarios — 3-tier BEST/GOOD/OK recommendations ───
// When the user picks a pipeline, we surface three options sorted by
// performance. They pick one (default: GOOD). Cost adjusts to the
// selected tier. Every tier is a real AWS SKU with real pricing.
const SERVER_SCENARIOS = {
  cloud: {
    scenario: 'Pure Cloud',
    description: 'All components run on cloud APIs — no AWS instance required.',
    options: [
      {
        grade: 'N/A', gradeClass: 'cloud',
        instance: 'No server needed',
        specs: 'Runs on your laptop',
        perHour: 0,
        latency: '~0.5s',
        icon: '☁️',
        tip: 'Pure cloud pipeline — the agent process runs on your own machine.',
      },
    ],
  },

  stt_tts_only: {
    scenario: 'Local STT/TTS only',
    description: 'No local LLM — CPU instance handles Whisper + Piper.',
    options: [
      {
        grade: 'BEST', gradeClass: 'best',
        instance: 'c5.xlarge',
        specs: '4 vCPU · 8 GB RAM · compute-optimized',
        perHour: 0.17, latency: '<1.5s', icon: '🖥️',
        tip: 'Fast CPU keeps STT/TTS latency low. Recommended for production.',
      },
      {
        grade: 'GOOD', gradeClass: 'good',
        instance: 't3.large',
        specs: '2 vCPU · 8 GB RAM · general-purpose',
        perHour: 0.0832, latency: '<2s', icon: '🖥️',
        tip: 'Solid balance — adequate for most STT/TTS workloads.',
      },
      {
        grade: 'OK', gradeClass: 'ok',
        instance: 't3.medium',
        specs: '2 vCPU · 4 GB RAM',
        perHour: 0.0416, latency: '~2–3s', icon: '🖥️',
        tip: 'Bare minimum. Whisper base + Piper fit tightly in 4 GB RAM.',
      },
    ],
  },

  llm_small: {
    scenario: 'Small–Mid LLM (≤ 10B)',
    description: 'GPU required for real-time voice. CPU falls back to 4–6s latency.',
    options: [
      {
        grade: 'BEST', gradeClass: 'best',
        instance: 'g5.xlarge',
        specs: 'NVIDIA A10G · 24 GB VRAM · 4 vCPU · 16 GB RAM',
        perHour: 1.006, latency: '<0.4s', icon: '⚡⚡',
        tip: 'A10G — flagship real-time. The model responds before the user finishes their thought.',
      },
      {
        grade: 'GOOD', gradeClass: 'good',
        instance: 'g4dn.xlarge',
        specs: 'NVIDIA T4 · 16 GB VRAM · 4 vCPU · 16 GB RAM',
        perHour: 0.526, latency: '<0.8s', icon: '⚡',
        tip: 'T4 GPU — excellent price/latency. Still feels human in conversation.',
      },
      {
        grade: 'OK', gradeClass: 'ok',
        instance: 'c5.2xlarge',
        specs: '8 vCPU · 16 GB RAM · no GPU',
        perHour: 0.34, latency: '~4–6s', icon: '🖥️',
        tip: 'CPU only. Functional but noticeably slow — pauses break conversational flow.',
      },
    ],
  },

  llm_mid: {
    scenario: 'Mid LLM (13B–32B)',
    description: 'A10G GPU needed to keep inference real-time. 24 GB VRAM minimum.',
    options: [
      {
        grade: 'BEST', gradeClass: 'best',
        instance: 'g5.2xlarge',
        specs: 'NVIDIA A10G · 24 GB VRAM · 8 vCPU · 32 GB RAM',
        perHour: 1.212, latency: '<0.7s', icon: '⚡⚡',
        tip: 'A10G + extra RAM — highest quality conversation at real-time speed.',
      },
      {
        grade: 'GOOD', gradeClass: 'good',
        instance: 'g5.xlarge',
        specs: 'NVIDIA A10G · 24 GB VRAM · 4 vCPU · 16 GB RAM',
        perHour: 1.006, latency: '<1s', icon: '⚡',
        tip: 'Solid A10G — real-time for 13B. Edge of viable for 32B without quantization.',
      },
      {
        grade: 'OK', gradeClass: 'ok',
        instance: 'g4dn.2xlarge',
        specs: 'NVIDIA T4 · 16 GB VRAM · 8 vCPU · 32 GB RAM',
        perHour: 0.752, latency: '1–2s', icon: '⚡',
        tip: 'Cheaper T4 — works with Q4-quantized 13B. Tight on VRAM for 32B.',
      },
    ],
  },

  llm_large: {
    scenario: 'Large LLM (70B+)',
    description: 'Flagship hardware needed — 40 GB+ VRAM for 70B models (quantized).',
    options: [
      {
        grade: 'BEST', gradeClass: 'best',
        instance: 'g6e.xlarge',
        specs: 'NVIDIA L40S · 48 GB VRAM · 4 vCPU · 32 GB RAM',
        perHour: 1.86, latency: '<1s', icon: '⚡⚡⚡',
        tip: 'L40S fits 70B-Q4 comfortably. Flagship voice quality with real-time speed.',
      },
      {
        grade: 'GOOD', gradeClass: 'good',
        instance: 'g5.2xlarge',
        specs: 'NVIDIA A10G · 24 GB VRAM · 8 vCPU · 32 GB RAM',
        perHour: 1.212, latency: '1–1.5s', icon: '⚡⚡',
        tip: 'A10G with extra RAM — 70B-Q4 fits tightly, may swap occasionally.',
      },
      {
        grade: 'OK', gradeClass: 'ok',
        instance: 'g5.xlarge',
        specs: 'NVIDIA A10G · 24 GB VRAM · 4 vCPU · 16 GB RAM',
        perHour: 1.006, latency: '1.5–3s', icon: '⚡',
        tip: 'Bare minimum for 70B-Q4. Expect VRAM pressure and occasional slowdowns.',
      },
    ],
  },
};

function recommendServers(cfg) {
  const llmLocal = cfg.llm?.provider === 'ollama';
  const sttLocal = cfg.stt?.provider === 'whisper_local';
  // Piper and Voicebox both run locally on the agent host's CPU/GPU.
  // Voicebox (Qwen3-TTS / Chatterbox) is heavier than Piper — treated the
  // same here but callers should expect more RAM/CPU headroom.
  const ttsLocal = cfg.tts?.provider === 'piper_local'
                || cfg.tts?.provider === 'voicebox';

  if (!llmLocal && !sttLocal && !ttsLocal) return SERVER_SCENARIOS.cloud;
  if (!llmLocal) return SERVER_SCENARIOS.stt_tts_only;

  const m = (cfg.llm?.model || '').toLowerCase();
  const match = m.match(/(\d+(?:\.\d+)?)\s*b\b/);
  const paramsB = match ? parseFloat(match[1]) : null;

  if (paramsB !== null && paramsB >= 65) return SERVER_SCENARIOS.llm_large;
  if (paramsB !== null && paramsB >= 11) return SERVER_SCENARIOS.llm_mid;
  return SERVER_SCENARIOS.llm_small;
}

// Which tier the user has picked (0=best, 1=good, 2=ok). Default to GOOD.
let selectedServerTierIdx = (() => {
  try {
    const v = parseInt(localStorage.getItem('va-server-tier') || '1', 10);
    return [0, 1, 2].includes(v) ? v : 1;
  } catch { return 1; }
})();

function selectServerTier(idx) {
  selectedServerTierIdx = idx;
  try { localStorage.setItem('va-server-tier', String(idx)); } catch {}
  calculateCost();
}

function getSttPricingKey(item) {
  if (!item) return 'whisper_local';
  if (item.provider === 'whisper_local') return 'whisper_local';
  return `${item.provider}:${item.model}`;
}

function getLlmPricingKey(item) {
  if (!item) return 'ollama';
  if (item.provider === 'ollama') return 'ollama';
  return `${item.provider}:${item.model}`;
}

function getTtsPricingKey(item) {
  if (!item) return 'piper_local';
  if (item.provider === 'piper_local') return 'piper_local';
  if (item.provider === 'voicebox') return 'voicebox';
  if (item.provider === 'edge') return 'edge';
  if (item.provider === 'elevenlabs') return `elevenlabs:${item.model}`;
  if (item.provider === 'openai') return `openai:${item.model}`;
  return `groq:${item.model}`;
}

function calculateCost() {
  const agents = parseInt($('num-agents').value) || 1;
  const hoursPerDay = parseInt($('hours-per-day').value) || 8;
  const daysPerMonth = parseInt($('days-per-month').value) || 22;
  const totalHours = agents * hoursPerDay * daysPerMonth;

  $('cost-hours').textContent = totalHours.toLocaleString() + ' hrs';

  const cfg = readConfig();

  // STT cost
  const sttKey = getSttPricingKey(cfg.stt);
  const sttRate = PRICING.stt[sttKey] || PRICING.stt['whisper_local'];
  const sttCost = totalHours * sttRate.perHour;

  // LLM cost
  const llmKey = getLlmPricingKey(cfg.llm);
  const llmRate = PRICING.llm[llmKey] || PRICING.llm['ollama'];
  const llmCost = totalHours * llmRate.perHour;

  // TTS cost
  const ttsKey = getTtsPricingKey(cfg.tts);
  const ttsRate = PRICING.tts[ttsKey] || PRICING.tts['piper_local'];
  const ttsCost = totalHours * ttsRate.perHour;

  // Server cost — based on the user's selected tier from the 3 recommendations
  const scenario = recommendServers(cfg);
  const tierIdx = Math.min(selectedServerTierIdx, scenario.options.length - 1);
  const selectedTier = scenario.options[tierIdx];
  const serverCost = totalHours * selectedTier.perHour;

  const total = sttCost + llmCost + ttsCost + serverCost;

  // Update UI — cost breakdown rows
  $('cost-stt').textContent = fmt(sttCost);
  $('cost-stt-detail').textContent = makeDetailLabel(sttRate);
  $('cost-stt').parentElement.classList.toggle('free', sttCost === 0);

  $('cost-llm').textContent = fmt(llmCost);
  $('cost-llm-detail').textContent = makeDetailLabel(llmRate);
  $('cost-llm').parentElement.classList.toggle('free', llmCost === 0);

  $('cost-tts').textContent = fmt(ttsCost);
  $('cost-tts-detail').textContent = makeDetailLabel(ttsRate);
  $('cost-tts').parentElement.classList.toggle('free', ttsCost === 0);

  $('cost-server').textContent = fmt(serverCost);
  $('cost-server-detail').textContent = serverCost === 0
    ? selectedTier.instance
    : `${selectedTier.instance} · ${fmtAmount(selectedTier.perHour)}/hr`;
  $('cost-server').parentElement.classList.toggle('free', serverCost === 0);

  $('cost-total').textContent = fmt(total);

  // Server card — scenario header + 3 tier cards
  $('server-info-subtitle').textContent = scenario.description;
  renderServerTiers(scenario.options, totalHours, tierIdx);
  $('server-info-monthly').textContent = fmt(serverCost);
  $('server-info').classList.toggle('is-free', selectedTier.perHour === 0);
}

// Render the 3 selectable tier cards inside the server-info card.
function renderServerTiers(options, totalHours, selectedIdx) {
  const container = $('server-tiers');
  if (!container) return;
  container.innerHTML = '';

  options.forEach((opt, idx) => {
    const monthly = totalHours * opt.perHour;
    const isActive = idx === selectedIdx;
    const isOnlyOption = options.length === 1;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = `server-tier ${isActive ? 'selected' : ''} ${isOnlyOption ? 'only-option' : ''}`;
    card.dataset.idx = idx;

    card.innerHTML = `
      <div class="server-tier-top">
        <span class="server-tier-badge grade-${opt.gradeClass}">${opt.grade}</span>
        <span class="server-tier-latency">${opt.latency}</span>
      </div>
      <div class="server-tier-name">
        <span class="server-tier-icon">${opt.icon}</span>
        <span class="server-tier-instance">${opt.instance}</span>
      </div>
      <div class="server-tier-specs">${opt.specs}</div>
      <div class="server-tier-tip">${opt.tip}</div>
      <div class="server-tier-footer">
        <span class="server-tier-rate">${opt.perHour === 0 ? 'FREE' : fmtAmount(opt.perHour) + '/hr'}</span>
        ${opt.perHour === 0 ? '' : `<span class="server-tier-monthly">${fmt(monthly)}/mo</span>`}
      </div>
    `;
    if (!isOnlyOption) {
      card.addEventListener('click', () => selectServerTier(idx));
    }
    container.appendChild(card);
  });
}

// ─── Pipeline Selection Persistence ───
// Save the user's STT/LLM/TTS choice to localStorage and restore on next visit
const PIPELINE_KINDS = ['llm', 'stt', 'tts'];
const pipelineStorageKey = (kind) => `va-selection-${kind}`;

// Cost-input persistence: number of agents, hours/day, days/month.
// Same pattern as pipeline selection — fails silently if localStorage is blocked.
const COST_INPUTS = ['num-agents', 'hours-per-day', 'days-per-month'];
const costStorageKey = (id) => `va-cost-${id}`;

function saveCostInput(id) {
  try {
    const el = $(id);
    if (el && el.value !== '') {
      localStorage.setItem(costStorageKey(id), el.value);
    }
  } catch (e) {}
}

function restoreCostInputs() {
  COST_INPUTS.forEach(id => {
    try {
      const saved = localStorage.getItem(costStorageKey(id));
      if (saved != null && saved !== '') {
        const el = $(id);
        if (el) el.value = saved;
      }
    } catch (e) {}
  });
}

function savePipelineSelection(kind) {
  try {
    const el = $(kind);
    if (el && el.value) {
      localStorage.setItem(pipelineStorageKey(kind), el.value);
    }
  } catch (e) {
    // localStorage may be blocked (private browsing) — fail silently
  }
}

function restorePipelineSelections() {
  PIPELINE_KINDS.forEach(kind => {
    try {
      const saved = localStorage.getItem(pipelineStorageKey(kind));
      if (!saved) return;
      const el = $(kind);
      if (!el) return;
      // Only restore if the saved option still exists in the current dropdown
      // (e.g. user might have uninstalled an Ollama model since last visit)
      const exists = Array.from(el.options).some(o => o.value === saved);
      if (exists) el.value = saved;
    } catch (e) {}
  });
}

// Recalculate + persist when cost inputs change
COST_INPUTS.forEach(id => {
  $(id).addEventListener('input', () => {
    saveCostInput(id);
    calculateCost();
  });
});

// Pipeline dropdowns: save + recalc on change, with a brief loading pulse
// so the user gets visual feedback that something happened (server-tier
// recalc can cause a small render pause, and TTS change refreshes the
// voice-comparison list).
PIPELINE_KINDS.forEach(kind => {
  $(kind).addEventListener('change', () => {
    const field = $(kind).closest('.field');
    field?.classList.add('loading');
    savePipelineSelection(kind);
    calculateCost();
    if (kind === 'tts') {
      populateVoiceCompare(extractDropdownOptions('tts'));
    }
    // Keep the spinner visible for ~250ms minimum so it's perceivable on
    // fast machines; requestAnimationFrame ensures the add() paints first.
    requestAnimationFrame(() => {
      setTimeout(() => field?.classList.remove('loading'), 250);
    });
  });
});

// ─── Theme Toggle ───
const themeToggle = $('theme-toggle');
const savedTheme = localStorage.getItem('va-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('va-theme', next);
});

// ─── Currency Toggle + Live FX Rate ───
let USD_TO_INR = 84.0;           // fallback rate — updated from /api/fx-rate on load
let fxRateDate = null;           // ISO date string from API
let fxRateSource = 'fallback';   // 'frankfurter.app (ECB)' | 'fallback' | cached
let currentCurrency = localStorage.getItem('va-currency') || 'USD';

// Try an instant restore from localStorage so the first calculation isn't
// off by 10–20% while waiting for the network.
try {
  const cached = JSON.parse(localStorage.getItem('va-fx-rate') || 'null');
  if (cached && typeof cached.rate === 'number' && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
    USD_TO_INR = cached.rate;
    fxRateDate = cached.date || null;
    fxRateSource = 'cached';
  }
} catch {}

async function fetchExchangeRate() {
  try {
    const res = await fetch('/api/fx-rate', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    if (typeof data.rate === 'number' && data.rate > 0) {
      USD_TO_INR = data.rate;
      fxRateDate = data.date || null;
      fxRateSource = data.source || 'live';
      try {
        localStorage.setItem('va-fx-rate', JSON.stringify({
          rate: USD_TO_INR, date: fxRateDate, at: Date.now(),
        }));
      } catch {}
      return true;
    }
  } catch (e) {
    console.warn('[voice-agent] FX rate fetch failed:', e.message);
  }
  return false;
}

function updateFxDisplay() {
  const el = $('fx-rate-display');
  if (!el) return;
  const show = currentCurrency === 'INR';
  el.hidden = !show;
  if (!show) return;
  $('fx-rate-value').textContent = '₹' + USD_TO_INR.toFixed(2);
  const label = fxRateSource === 'fallback'
    ? 'offline' :
    fxRateSource === 'cached'
    ? 'cached'
    : (fxRateDate ? fxRateDate : 'live');
  $('fx-rate-source').textContent = label;
}

function fmtAmount(usdAmount) {
  if (currentCurrency === 'INR') {
    const inr = usdAmount * USD_TO_INR;
    if (inr < 1)   return '₹' + inr.toFixed(2);
    if (inr < 100) return '₹' + inr.toFixed(1);
    return '₹' + Math.round(inr).toLocaleString('en-IN');
  }
  return '$' + usdAmount.toFixed(2);
}

function fmt(usdAmount) {
  return usdAmount === 0 ? 'FREE' : fmtAmount(usdAmount);
}

function makeDetailLabel(rate) {
  if (rate.perHour === 0) return rate.freeLabel || 'Free';
  return fmtAmount(rate.perHour) + '/hr';
}

function updateCurrencyButtons() {
  const toggle = document.getElementById('currency-toggle');
  if (toggle) toggle.dataset.currency = currentCurrency;
  document.querySelectorAll('.currency-opt').forEach(btn => {
    btn.setAttribute(
      'aria-pressed',
      btn.dataset.currency === currentCurrency ? 'true' : 'false',
    );
  });
}

function flashCostValues() {
  const ids = [
    'cost-stt', 'cost-llm', 'cost-tts', 'cost-total',
    'cost-stt-detail', 'cost-llm-detail', 'cost-tts-detail',
  ];
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('cost-flip');
    // Force reflow so the animation restarts
    void el.offsetWidth;
    el.classList.add('cost-flip');
  });
}

document.querySelectorAll('.currency-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.currency === currentCurrency) return;
    currentCurrency = btn.dataset.currency;
    localStorage.setItem('va-currency', currentCurrency);
    updateCurrencyButtons();
    updateFxDisplay();
    calculateCost();
    flashCostValues();
  });
});

// ─── Voice Comparison Panel ───
// Lets the user hear the same sentence spoken by every available TTS voice
// without having to disconnect, change TTS, and redial each time.
const DEFAULT_SAMPLE_TEXT = 'Hello! I am your voice assistant. How can I help you today?';
let voiceCompareText = DEFAULT_SAMPLE_TEXT;
const sampleCache = new Map();      // key: provider:model:voice:text -> objectURL
let currentAudio = null;            // stop previous sample when starting a new one
let currentAudioRow = null;

function setVoiceCompareText(text) {
  if (!text) return;
  voiceCompareText = text;
  const el = $('vc-text');
  if (el) el.textContent = text;
  // Clear cache — different text means regenerate
  for (const url of sampleCache.values()) URL.revokeObjectURL(url);
  sampleCache.clear();
}

function providerBadgeClass(provider) {
  if (provider === 'piper_local') return 'free';
  if (provider === 'voicebox')    return 'free';
  if (provider === 'edge')        return 'cloud';
  if (provider === 'groq')        return 'paid';
  return 'cloud';
}

function providerBadgeLabel(provider) {
  if (provider === 'piper_local') return 'LOCAL';
  if (provider === 'voicebox')    return 'VOICEBOX';
  if (provider === 'edge')        return 'FREE';
  if (provider === 'groq')        return 'PAID';
  return provider.toUpperCase();
}

// Split the combined "Provider · Voice — $x/hr | meta" label into a short title
function parseVoiceLabel(opt) {
  const full = opt.label || '';
  const [head, ...rest] = full.split(' · ');
  const tail = rest.join(' · ');
  const [main, meta] = tail.split(' — ');
  return {
    title: main?.trim() || opt.voice || 'Voice',
    meta:  (meta?.trim()) || head || '',
  };
}

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (currentAudioRow) {
    currentAudioRow.classList.remove('playing');
    const btn = currentAudioRow.querySelector('.vc-play-btn');
    if (btn) btn.textContent = '▶';
    currentAudioRow = null;
  }
}

async function playSample(rowEl, opt) {
  // Toggle: if clicking the same row that's playing, stop it
  if (currentAudioRow === rowEl) {
    stopCurrentAudio();
    return;
  }
  stopCurrentAudio();

  const text = voiceCompareText || DEFAULT_SAMPLE_TEXT;
  const key = `${opt.provider}:${opt.model || ''}:${opt.voice || ''}:${text}`;
  const playBtn = rowEl.querySelector('.vc-play-btn');

  let audioUrl = sampleCache.get(key);
  if (!audioUrl) {
    rowEl.classList.add('loading');
    if (playBtn) playBtn.textContent = '';
    try {
      const res = await fetch('/api/tts-sample', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          provider: opt.provider,
          voice: opt.voice,
          model: opt.model,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${errText}`);
      }
      const blob = await res.blob();
      audioUrl = URL.createObjectURL(blob);
      sampleCache.set(key, audioUrl);
    } catch (e) {
      rowEl.classList.remove('loading');
      if (playBtn) playBtn.textContent = '▶';
      showError(`Sample failed (${opt.label}): ${e.message}`);
      return;
    }
    rowEl.classList.remove('loading');
  }

  const audio = new Audio(audioUrl);
  currentAudio = audio;
  currentAudioRow = rowEl;
  rowEl.classList.add('playing');
  if (playBtn) playBtn.textContent = '■';

  audio.addEventListener('ended', () => {
    if (currentAudio === audio) stopCurrentAudio();
  });
  audio.addEventListener('error', () => {
    stopCurrentAudio();
    showError(`Playback failed for ${opt.label}`);
  });

  try {
    await audio.play();
  } catch (e) {
    stopCurrentAudio();
    showError(`Playback blocked: ${e.message}`);
  }
}

function populateVoiceCompare(ttsOptions) {
  const listEl = $('vc-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!ttsOptions || ttsOptions.length === 0) {
    listEl.innerHTML = '<div class="vc-empty">No TTS voices available</div>';
    return;
  }
  for (const opt of ttsOptions) {
    const { title, meta } = parseVoiceLabel(opt);
    const badgeClass = providerBadgeClass(opt.provider);
    const badgeLabel = providerBadgeLabel(opt.provider);

    const row = document.createElement('div');
    row.className = 'vc-item';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <button class="vc-play-btn" type="button" aria-label="Play ${title}">▶</button>
      <div class="vc-item-body">
        <div class="vc-item-label">${title}</div>
        <div class="vc-item-meta">${meta}</div>
      </div>
      <span class="vc-item-badge ${badgeClass}">${badgeLabel}</span>
    `;
    row.querySelector('.vc-play-btn').addEventListener('click', () => playSample(row, opt));
    listEl.appendChild(row);
  }
}

// Refresh button: stop any playback, clear cache so fresh samples are fetched
$('vc-refresh')?.addEventListener('click', () => {
  stopCurrentAudio();
  for (const url of sampleCache.values()) URL.revokeObjectURL(url);
  sampleCache.clear();
});

function extractDropdownOptions(selectId) {
  return Array.from($(selectId).options)
    .map(o => {
      try { return JSON.parse(o.dataset.item || 'null'); }
      catch { return null; }
    })
    .filter(Boolean);
}

// ─── Initialization ───
// Set toggle visual state immediately — don't wait for the /api/models fetch.
// Otherwise the slider can appear to "snap" into position after the page loads.
updateCurrencyButtons();
updateFxDisplay();

// Fire the live FX fetch in parallel with dropdown population
fetchExchangeRate().then(ok => {
  if (ok) {
    updateFxDisplay();
    calculateCost();   // re-apply with fresh rate
  }
});

populateDropdowns().then(() => {
  restorePipelineSelections();
  restoreCostInputs();
  populateVoiceCompare(extractDropdownOptions('tts'));
  calculateCost();
});
