'use strict';
/*
 * Part 2: what the Settings screen is allowed to change, and what it should tell the user.
 * Pure functions (no electron) so they are unit tested.
 */
const { VOICES: EDGE_VOICES } = require('./edge-tts');

const WHISPER_MODELS = [
  ['tiny.en', 'Tiny (fastest, mishears more)'],
  ['base.en', 'Base (balanced, default)'],
  ['small.en', 'Small (hears accents better, slower)'],
];

// Kokoro v1.0 speaker numbers. The offline backup voice only; v1.1 installs are mapped to an English voice.
const KOKORO_VOICES = [
  [3, 'Heart (female, warm)'],
  [2, 'Bella (female)'],
  [4, 'Jessica (female)'],
  [7, 'Nova (female)'],
  [11, 'Adam (male)'],
  [16, 'Michael (male)'],
  [21, 'Emma (British female)'],
  [26, 'George (British male)'],
];

const TTS_PROVIDERS = ['edge', 'local', 'windows'];
const EYE_CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const EDGE_NAME = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Lower-case words only, 2 to 4 of them: "hey sidekick", "okay jarvis". Anything else is rejected.
function cleanWakePhrase(raw) {
  const t = String(raw || '').toLowerCase().replace(/[^a-z\u00c0-\u024f\u0400-\u04ff' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4 || t.length > 40) return null;
  return t;
}

/*
 * patch: what the panel wants to change. Returns { patch, errors } where patch only holds safe, normalised
 * values for the voice / wake / follow-up keys; everything else is dropped.
 */
function sanitizeVoicePatch(input) {
  const src = input || {};
  const patch = {};
  const errors = [];
  if ('ttsProvider' in src) {
    if (TTS_PROVIDERS.includes(src.ttsProvider)) patch.ttsProvider = src.ttsProvider;
    else errors.push('Unknown voice engine.');
  }
  if ('edgeVoice' in src) {
    const v = String(src.edgeVoice || '').trim();
    if (EDGE_VOICES.some((x) => x[0] === v) || EDGE_NAME.test(v)) patch.edgeVoice = v;
    else errors.push('That voice name is not valid.');
  }
  if ('kokoroSpeaker' in src) {
    const n = Math.round(Number(src.kokoroSpeaker));
    if (Number.isFinite(n) && n >= 0 && n <= 52) patch.kokoroSpeaker = n;
    else errors.push('Unknown backup voice.');
  }
  if ('kokoroSpeed' in src) patch.kokoroSpeed = clampNum(src.kokoroSpeed, 0.7, 1.4, 1);
  if ('whisperModel' in src) {
    if (WHISPER_MODELS.some((m) => m[0] === src.whisperModel)) patch.whisperModel = src.whisperModel;
    else errors.push('Unknown hearing model.');
  }
  if ('wakeWordEnabled' in src) patch.wakeWordEnabled = !!src.wakeWordEnabled;
  if ('wakePhrase' in src) {
    const p = cleanWakePhrase(src.wakePhrase);
    if (p) patch.wakePhrase = p;
    else errors.push('The wake phrase should be 2 to 4 words, like "hey sidekick".');
  }
  if ('followUpEnabled' in src) {
    // The toggle is stored as the length of the hands-free window; 0 means off.
    patch.conversationWindowSec = src.followUpEnabled ? clampNum(src.conversationWindowSec, 3, 60, 10) : 0;
  } else if ('conversationWindowSec' in src) {
    patch.conversationWindowSec = clampNum(src.conversationWindowSec, 0, 60, 10);
  }
  if ('quickCommands' in src) patch.quickCommands = !!src.quickCommands;
  if ('captions' in src) patch.captions = !!src.captions;
  if ('eyesEnabled' in src) patch.eyesEnabled = !!src.eyesEnabled;
  if ('eyesCorner' in src) {
    if (EYE_CORNERS.includes(src.eyesCorner)) patch.eyesCorner = src.eyesCorner;
    else errors.push('Unknown corner.');
  }
  return { patch, errors };
}

/*
 * The note shown for installs made before Part 1. Kokoro v1.1 reads English with a Chinese voice, which is what
 * made the old voice sound robotic, so the fix is to remove and download again (that fetches v1.0).
 */
function kokoroNote(local) {
  const st = local || {};
  if (st.installing) return { level: 'info', text: 'Downloading the local voice... this can take a few minutes.' };
  if (!st.stt && !st.tts) return { level: 'warn', text: 'The local voice is not installed. Sidekick cannot hear you until you download it once.' };
  if (!st.stt) return { level: 'warn', text: 'Hearing (Whisper) is missing. Press Remove, then Download.' };
  if (st.tts && st.ttsVariant === 'v1_1') {
    return { level: 'warn', text: 'Your backup voice is the old Kokoro 1.1, which sounds robotic. Press Remove, then Download to get the corrected one.' };
  }
  if (!st.tts) return { level: 'info', text: 'Hearing is installed. The offline backup voice is not (optional).' };
  return { level: 'ok', text: 'Local voice is installed (hearing + offline backup voice).' };
}

function keyHint(settings) {
  const s = settings || {};
  if (s.provider === 'local') return { label: 'Ollama (on this PC)', needsKey: false, url: '' };
  if (s.provider === 'groq') return { label: 'Groq', needsKey: true, url: 'https://console.groq.com/keys' };
  return { label: 'DeepSeek', needsKey: true, url: 'https://platform.deepseek.com/api_keys' };
}

// Everything the panel needs in one object.
function buildCatalog({ settings, local, edge }) {
  const s = settings || {};
  const known = EDGE_VOICES.some((x) => x[0] === s.edgeVoice);
  const edgeVoices = EDGE_VOICES.map(([id, label]) => ({ id, label }));
  if (s.edgeVoice && !known) edgeVoices.unshift({ id: s.edgeVoice, label: s.edgeVoice + ' (custom)' });
  return {
    edgeVoices,
    kokoroVoices: KOKORO_VOICES.map(([id, label]) => ({ id, label })),
    whisperModels: WHISPER_MODELS.map(([id, label]) => ({ id, label })),
    kokoroNote: kokoroNote(local),
    key: keyHint(s),
    edge: { available: !!(edge && edge.available), lastError: (edge && edge.lastError) || '' },
  };
}

module.exports = { sanitizeVoicePatch, cleanWakePhrase, kokoroNote, keyHint, buildCatalog, KOKORO_VOICES, WHISPER_MODELS, TTS_PROVIDERS, EYE_CORNERS };
