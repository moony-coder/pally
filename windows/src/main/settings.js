'use strict';
const fs = require('fs');
const path = require('path');
const { DEFAULT_BLOCKED_APPS } = require('./safety');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const DEFAULT_SETTINGS = {
  provider: 'deepseek', // deepseek | groq | local (Ollama, OpenAI-compatible /v1)
  groqBaseUrl: DEEPSEEK_BASE_URL, // the active OpenAI-compatible base URL (name kept for compatibility)
  ollamaRoot: 'http://127.0.0.1:11434',
  groqApiKeyEncrypted: '',
  deepseekApiKeyEncrypted: '',
  modelMode: 'fast', // fast = thinking off (quick), deep = thinking on (slower, smarter)
  visionModel: 'deepseek-flash',
  agentModel: 'deepseek-flash',
  sttModel: 'whisper-large-v3-turbo', // Groq only
  sttProvider: 'local', // local (Whisper on this PC) | groq. DeepSeek has no speech-to-text.
  whisperModel: 'base.en', // tiny.en | base.en | small.en (local Whisper). small.en hears accents better, a bit slower.
  ttsProvider: 'edge', // edge (Microsoft neural voices, free) | local (Kokoro on this PC) | groq | windows
  edgeVoice: 'en-US-AvaMultilingualNeural',
  kokoroSpeaker: 3, // Kokoro voice number (3 = af_heart on the v1.0 model)
  kokoroSpeed: 1.0,
  ttsModel: 'canopylabs/orpheus-v1-english',
  ttsVoice: 'autumn',
  captions: true,
  wakeWordEnabled: true,
  wakePhrase: 'hey sidekick',
  conversationWindowSec: 10, // after an answer, keep listening this long without needing the wake word again (0 = off)
  quickCommands: true, // "open chrome", "volume up", "search for ..." run instantly without asking the AI
  eyesEnabled: true, // little eyes in the corner that follow your mouse
  eyesCorner: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
  pushToTalkShortcut: 'ctrl+alt',
  cursorEnabled: false, // the blue cursor only appears when Sidekick points at something
  hasCompletedOnboarding: false,
  hasSubmittedEmail: false,
  email: '',
  launchAtLogin: true,
  coordinateSpace: 'normalized',
  useAccessibilityGrounding: true,
  skipScreenshotWhenPossible: true, // 'where is X' questions are answered from the control list (saves Groq tokens)
  hideFromCapture: true,
  playOnboardingMusic: false, // unused: no music file ships with this build
  micGranted: false,
  userName: '',
  agent: {
    allowDrive: true,
    driveApproval: 'ask', // ask | auto
    commandApproval: 'ask', // ask | never
    maxSteps: 60,
    accessMode: 'blocklist', // blocklist | allowlist (safety.js)
    blockedApps: DEFAULT_BLOCKED_APPS.slice(),
    allowedApps: [],
    alwaysAsk: [],
  },
  // Folder permissions: null = your user folder (read and change). Otherwise [{ path, write }]. See folder-access.js.
  folders: null,
  routines: [],
  memory: [],
  jobs: [],
  chat: [],
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(patch || {})) {
    const v = patch[key];
    if (isPlainObject(v) && isPlainObject(out[key])) out[key] = deepMerge(out[key], v);
    else out[key] = v;
  }
  return out;
}

class SettingsStore {
  constructor(file, safeStorage, env = process.env) {
    this.file = file;
    this.safeStorage = safeStorage || null;
    this.env = env;
    this.data = deepMerge(DEFAULT_SETTINGS, {});
    this.listeners = new Set();
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = deepMerge(DEFAULT_SETTINGS, parsed);
      // One-time move from the old Groq-first build: Groq keys, models and voices do not work on DeepSeek.
      if (!parsed.migratedDeepseek) {
        if (parsed.provider === 'groq' || !parsed.provider) {
          Object.assign(this.data, {
            provider: 'deepseek',
            groqBaseUrl: DEEPSEEK_BASE_URL,
            visionModel: DEFAULT_SETTINGS.visionModel,
            agentModel: DEFAULT_SETTINGS.agentModel,
            sttProvider: 'local',
            ttsProvider: parsed.ttsProvider === 'windows' ? 'windows' : 'edge',
            kokoroSpeaker: 3,
            cursorEnabled: false,
            wakeWordEnabled: true,
          });
        }
        this.data.migratedDeepseek = true;
      }
    } catch (_) {
      this.data = deepMerge(DEFAULT_SETTINGS, {});
      this.data.migratedDeepseek = true;
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.getPublic());
      } catch (_) {
        /* ignore */
      }
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return this.data;
  }

  set(patch) {
    this.data = deepMerge(this.data, patch);
    this._save();
    this._emit();
    return this.getPublic();
  }

  // Which stored field belongs to the active provider.
  _keyField() {
    return this.data.provider === 'groq' ? 'groqApiKeyEncrypted' : 'deepseekApiKeyEncrypted';
  }

  _envKey() {
    if (!this.env) return '';
    const v = this.data.provider === 'groq' ? this.env.GROQ_API_KEY : this.env.DEEPSEEK_API_KEY;
    return v ? String(v).trim() : '';
  }

  getApiKey() {
    const fromEnv = this._envKey();
    if (fromEnv) return fromEnv;
    const enc = this.data[this._keyField()];
    if (!enc) return '';
    try {
      if (enc.startsWith('plain:')) return Buffer.from(enc.slice(6), 'base64').toString('utf8');
      if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
        return this.safeStorage.decryptString(Buffer.from(enc, 'base64'));
      }
    } catch (_) {
      /* fallthrough */
    }
    return '';
  }

  setApiKey(key) {
    const trimmed = String(key || '').trim();
    const field = this._keyField();
    if (!trimmed) {
      this.data[field] = '';
    } else if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      this.data[field] = this.safeStorage.encryptString(trimmed).toString('base64');
    } else {
      this.data[field] = 'plain:' + Buffer.from(trimmed, 'utf8').toString('base64');
    }
    this._save();
    this._emit();
  }

  hasApiKey() {
    // Ollama runs on this PC with no key. Companion permissions.groqKey gates all AI work,
    // so the local preset must count as ready or every reply would be blocked.
    if (this.data.provider === 'local') return true;
    return !!this.getApiKey();
  }

  isLocalProvider() {
    return this.data.provider === 'local';
  }

  getPublic() {
    const copy = JSON.parse(JSON.stringify(this.data));
    delete copy.groqApiKeyEncrypted;
    delete copy.deepseekApiKeyEncrypted;
    delete copy.chat;
    copy.hasApiKey = this.hasApiKey();
    copy.isLocalProvider = this.isLocalProvider();
    copy.apiKeyFromEnv = !!this._envKey();
    copy.safetyDefaults = { blockedApps: DEFAULT_BLOCKED_APPS.slice() };
    return copy;
  }

  reset() {
    this.data = deepMerge(DEFAULT_SETTINGS, {});
    this._save();
    this._emit();
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS, deepMerge, DEEPSEEK_BASE_URL, GROQ_BASE_URL };
