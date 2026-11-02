'use strict';
/*
 * Sidekick for Windows: main process entry.
 *
 * Wires every module together: settings, Groq client, capture, speech, audio bridge,
 * input driving, agent, companion state machine, windows (tray panel, overlays, notch,
 * Home, 3D viewer), IPC handlers, shortcut polling, onboarding, routines.
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, shell, clipboard, desktopCapturer, safeStorage, session, systemPreferences, dialog } = require('electron');

const log = require('./log');
const { SettingsStore } = require('./settings');
const { GroqClient } = require('./groq');
const { createCapture } = require('./capture');
const { SpeechQueue, speakWithSapi } = require('./tts');
const { LocalVoice } = require('./local-voice');
const { InputController } = require('./input');
const { createSystemTools } = require('./system-tools');
const uia = require('./uia');
const { AgentRunner } = require('./agent');
const { CompanionManager } = require('./companion');
const { RoutineScheduler } = require('./routines');
const { ShortcutDetector } = require('./keys');
const { parseRoutineSchedule } = require('./tags');
const { buildModel3DPrompt } = require('./prompts');
const { WindowManager } = require('./windows');
const ollama = require('./ollama');
const wake = require('./wake');
const { AppIndex } = require('./apps');
const quick = require('./quick-commands');
const { EdgeVoice, sniffAudioMime } = require('./edge-tts');
const motion = require('../shared/motion');
const voiceSettings = require('./voice-settings');
const eyesMod = require('./eyes');
const { ActivityLog, summarizeQuick } = require('./activity-log');
const { createFolderAccess, sanitizeFolderList } = require('./folder-access');

const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const FLAG_E2E = argv.includes('--e2e');
const FLAG_SELFCHECK = argv.includes('--selfcheck'); // real Win32 + real windows, runs a script (npm run verify:windows)
const FLAG_HIDDEN = argv.includes('--hidden');
const E2E_SCRIPT = (argv.find((a) => a.startsWith('--e2e-script=')) || '').slice('--e2e-script='.length);
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const APP_NAME = 'Sidekick';
const APP_ID = 'com.moonycoder.sidekick';

if (process.env.SIDEKICK_USER_DATA) app.setPath('userData', process.env.SIDEKICK_USER_DATA);
else app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

  app.on('window-all-closed', () => { /* tray app: keep running */ });
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (ev) => ev.preventDefault());
  });

  app.whenReady().then(start).catch((e) => {
    log.error('fatal start error', e);
    app.quit();
  });
}

// A do-nothing Win32 layer for non-Windows development and tests.
function stubWin32() {
  const noop = () => {};
  return {
    stub: true,
    readKeySnapshot: () => ({ ctrl: false, alt: false, shift: false, win: false, space: false, escape: false, otherKey: false }),
    getCursorPosition: () => screen.getCursorScreenPoint(),
    setCursorPosition: noop,
    isMouseButtonDown: () => false,
    sendInputs: noop,
    pressCombo: noop,
    typeText: noop,
    mouseButton: noop,
    wheel: noop,
    getForegroundWindow: () => 0,
    focusWindow: () => false,
  };
}

function loadWin32() {
  if (process.platform !== 'win32' || FLAG_E2E) return stubWin32();
  try {
    return require('./win32').loadRealWin32();
  } catch (e) {
    log.error('Could not load the Win32 layer (koffi). Push-to-talk and PC driving are disabled.', e);
    return stubWin32();
  }
}

function start() {
  const userData = app.getPath('userData');
  log.init(path.join(userData, 'logs'));
  log.info('Sidekick starting', { version: app.getVersion(), electron: process.versions.electron, e2e: FLAG_E2E });

  const settings = new SettingsStore(path.join(userData, 'settings.json'), safeStorage);
  if (process.env.SIDEKICK_E2E_MIC) settings.set({ micGranted: true });
  const baseUrl = () => process.env.SIDEKICK_GROQ_BASE_URL || settings.get('groqBaseUrl');
  const ollamaRoot = () => process.env.SIDEKICK_OLLAMA_ROOT || settings.get('ollamaRoot');
  const groq = new GroqClient({ getApiKey: () => settings.getApiKey(), getBaseUrl: baseUrl, log });
  const capture = createCapture({ screen, desktopCapturer });
  const win32 = loadWin32();
  const isWin = process.platform === 'win32';

  const screenApi = {
    dipToScreenPoint: (p) => (isWin && screen.dipToScreenPoint ? screen.dipToScreenPoint(p) : p),
    screenToDipPoint: (p) => (isWin && screen.screenToDipPoint ? screen.screenToDipPoint(p) : p),
  };
  const input = new InputController({ win32, screenApi });
  const psMod = require('./powershell');
  // Start-menu index: lets "open whatsapp / spotify / settings / vs code" work for Store apps and renamed exes.
  const apps = new AppIndex({ run: psMod.runPowerShellFast, cacheFile: path.join(userData, 'start-apps.json'), log });
  // Folder permissions (Home > Folders) and the activity log (Home > Activity).
  const folderAccess = createFolderAccess({
    getFolders: () => settings.get('folders'),
    homeDir: app.getPath('home'),
    // Sidekick's own settings, voice models and logs are never readable by the agent
    protectedPaths: () => [userData],
  });
  const activity = new ActivityLog({ file: path.join(userData, 'activity.jsonl'), onAdd: (e) => { try { wm.send(wm.home, 'activity:new', e); } catch (_) { /* window not ready */ } } });
  const knownFolders = {};
  for (const [word, key] of [['downloads', 'downloads'], ['documents', 'documents'], ['desktop', 'desktop'], ['pictures', 'pictures'], ['videos', 'videos'], ['music', 'music']]) {
    try { knownFolders[word] = app.getPath(key); } catch (_) { /* not available on this PC */ }
  }
  const tools = createSystemTools({ shell, clipboard, documentsDir: app.getPath('documents'), run: psMod.runPowerShellFast, runOnce: psMod.runPowerShell, apps, access: folderAccess, knownFolders });
  if (isWin) setTimeout(() => { apps.ensure().catch(() => {}); }, 1500);
  const edge = new EdgeVoice({ log });

  // ------------------------------------------------------------ shared context
  const ctx = {
    settings, groq, capture, win32, input, tools, uia, psMod, log, screenApi, activity, folderAccess,
    companion: null, agent: null, wm: null, speech: null, routines: null, detector: null,
    chat: Array.isArray(settings.get('chat')) ? settings.get('chat').slice(-120) : [],
    modelPayload: null,
    onboarding: null,
  };

  const wm = new WindowManager({
    settings, log, assetsDir: ASSETS, e2e: FLAG_E2E,
    getStatus: () => ctx.companion && ctx.companion.snapshot(),
    getJobs: () => (ctx.agent ? ctx.agent.listJobs() : []),
  });
  ctx.wm = wm;

  // ------------------------------------------------------------ chat log (Home window)
  let chatSaveTimer = null;
  ctx.chatAppend = (m) => {
    const msg = { role: m.role, text: String(m.text || '').slice(0, 4000), at: Date.now() };
    if (!msg.text) return;
    ctx.chat.push(msg);
    if (ctx.chat.length > 120) ctx.chat.shift();
    wm.send(wm.home, 'chat-msg', msg);
    clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(() => {
      try {
        settings.data.chat = ctx.chat;
        settings._save();
      } catch (_) { /* ignore */ }
    }, 1500);
  };

  // ------------------------------------------------------------ audio bridge (hidden window)
  const audioState = { ready: false, readyWaiters: [], recordWaiter: null, probing: null, playWaiters: new Map(), playId: 0, micOkSeen: false };
  const audioWin = () => wm.ensureAudio();
  const whenAudioReady = () => (audioState.ready ? Promise.resolve() : new Promise((r) => audioState.readyWaiters.push(r)));
  audioWin();

  const audio = {
    async start() {
      await whenAudioReady();
      wm.send(audioWin(), 'audio:start', {});
    },
    stop() {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          audioState.recordWaiter = null;
          resolve(null);
        }, 6000);
        audioState.recordWaiter = (rec) => { clearTimeout(timer); resolve(rec); };
        wm.send(audioWin(), 'audio:stop', {});
      });
    },
    cancel() {
      wm.send(audioWin(), 'audio:cancel', {});
      if (audioState.recordWaiter) { audioState.recordWaiter(null); audioState.recordWaiter = null; }
    },
  };

  function playWav(wav, signal) {
    return new Promise((resolve) => {
      const id = ++audioState.playId;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        audioState.playWaiters.delete(id);
        resolve();
      };
      const guard = setTimeout(finish, 90000);
      audioState.playWaiters.set(id, finish);
      if (signal) {
        if (signal.aborted) return finish();
        signal.addEventListener('abort', () => { wm.send(audioWin(), 'audio:stop-playback', {}); finish(); }, { once: true });
      }
      whenAudioReady().then(() => wm.send(audioWin(), 'audio:play', { id, data: wav, mime: sniffAudioMime(Buffer.from(wav)) }));
      return undefined;
    });
  }

  // ------------------------------------------------------------ speech
  const localVoice = new LocalVoice({ dir: path.join(userData, 'local-voice'), log });
  ctx.localVoice = localVoice;
  localVoice.onChange((st) => {
    wm.broadcast('localvoice', st, { overlays: false, others: false });
    try { syncWakeWord(); } catch (_) { /* not ready yet */ }
  });
  // Older installs kept headers, static .libs and every sherpa tool. Trim them after startup.
  setTimeout(() => { try { localVoice.pruneExtras({ log: true }); } catch (_) { /* optional */ } }, 2500);

  const speech = new SpeechQueue({
    synthesize: async (text, signal) => {
      const s = settings.all();
      // Chain: natural Edge voice -> local Kokoro (if installed) -> Groq voice (only when Groq is the AI) -> Windows SAPI.
      if (s.ttsProvider === 'edge') {
        try {
          const audio = await edge.synthesize(text, { voice: s.edgeVoice, signal });
          if (audio) return audio;
          if (signal && signal.aborted) return null;
        } catch (e) {
          if (signal && signal.aborted) return null;
          log.warn('natural voice failed, using the offline voice:', e && e.message);
        }
      }
      if ((s.ttsProvider === 'edge' || s.ttsProvider === 'local') && localVoice.status().tts) {
        try {
          const wav = await localVoice.synthesize(text, { signal, speaker: Number(s.kokoroSpeaker) || 0, speed: Number(s.kokoroSpeed) || 1 });
          if (wav) return wav;
        } catch (e) {
          if (signal && signal.aborted) return null;
          log.warn('local Kokoro failed:', e && e.message);
        }
      }
      if (s.ttsProvider === 'groq' && groq.isGroq() && settings.hasApiKey()) {
        try {
          return await groq.synthesizeSpeech({ model: s.ttsModel, voice: s.ttsVoice, text, signal });
        } catch (e) {
          if (signal && signal.aborted) return null;
          log.warn('Groq voice failed, using the Windows voice:', e && e.message);
        }
      }
      return null; // SpeechQueue falls back to Windows SAPI
    },
    playWav,
    speakFallback: (text, signal) => (isWin ? speakWithSapi(text, signal) : Promise.resolve()),
    log,
  });
  ctx.speech = speech;

  // ------------------------------------------------------------ onboarding (music + welcome + video)
  ctx.startOnboarding = (replay) => {
    clearTimeout(ctx.onboarding && ctx.onboarding.fadeTimer);
    const state = { replay, fadeTimer: null };
    ctx.onboarding = state;
    settings.set({ cursorEnabled: true });
    wm.showOverlay({ firstAppearance: true });
    ctx.companion.onboardingVideoActive = true;
  };

  function onboardingEvent(type) {
    const comp = ctx.companion;
    switch (type) {
      case 'welcome-done':
        wm.broadcast('overlay:onboarding', { action: 'video-start' }, { others: false });
        break;
      case 'demo':
        comp.performOnboardingDemo();
        break;
      case 'video-ended':
        comp.onboardingVideoActive = false;
        break;
      default:
    }
  }

  // ------------------------------------------------------------ photos for info cards
  const photoCache = new Map();
  ctx.resolvePhoto = async (query) => {
    const q = String(query || '').trim();
    if (!q) return null;
    if (photoCache.has(q)) return photoCache.get(q);
    let url = null;
    try {
      const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=640&gsrsearch=' + encodeURIComponent(q);
      const res = await fetch(api, { signal: AbortSignal.timeout(4500), headers: { 'User-Agent': 'SidekickWindows/1.0' } });
      const j = await res.json();
      const pages = j && j.query && j.query.pages ? Object.values(j.query.pages) : [];
      const hit = pages.find((p) => p.thumbnail && p.thumbnail.source);
      url = hit ? hit.thumbnail.source : null;
    } catch (_) {
      url = null;
    }
    photoCache.set(q, url);
    return url;
  };

  // ------------------------------------------------------------ 3D models
  function pushModel(payload) {
    ctx.modelPayload = payload;
    const w = wm.model3d;
    if (!w || w.isDestroyed()) return;
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => wm.send(w, 'model3d:show', ctx.modelPayload));
    else wm.send(w, 'model3d:show', payload);
  }

  function parseModelJson(text) {
    const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The model did not return a 3D model.');
    const model = JSON.parse(cleaned.slice(start, end + 1));
    if (!model || !Array.isArray(model.parts) || !model.parts.length) throw new Error('The 3D model had no parts.');
    return model;
  }

  ctx.showModel3D = async (topic) => {
    wm.openModel3D();
    pushModel({ state: 'loading', topic });
    try {
      const s = settings.all();
      const res = await groq.chat({
        model: s.agentModel,
        messages: [
          { role: 'system', content: buildModel3DPrompt(topic) },
          { role: 'user', content: 'build the model of: ' + topic },
        ],
        stream: false,
        jsonMode: true,
        reasoningEffort: 'none',
        maxTokens: 5000,
        temperature: 0.4,
      });
      pushModel({ model: parseModelJson(res.text) });
    } catch (e) {
      log.warn('3D model failed', e && e.message);
      pushModel({ state: 'error', message: 'Could not build that model. ' + ((e && e.message) || '') });
    }
  };

  ctx.speakShort = (t) => ctx.companion && ctx.companion.say(t);

  // ------------------------------------------------------------ agent + companion
  const ui = wm.buildUi(ctx);
  ctx.ui = ui;

  const { TimerManager } = require('./timers');
  const timerManager = new TimerManager({
    notify: (msg, kind) => ui.notify(msg, kind),
    speak: (text) => {
      speech.stop();
      speech.enqueue(text);
      speech.finish();
    },
    drawNote: (text, pos) => {
      if (ui.drawShapes) {
        ui.drawShapes([{ kind: 'note', label: text, points: [pos], bounds: screenApi && screenApi.getPrimaryBounds && screenApi.getPrimaryBounds() }]);
      }
    },
  });
  ctx.timers = timerManager;

  const agent = new AgentRunner({ groq, settings, capture, input, tools, uia, screenApi, ui, log, win32, activity });
  ctx.agent = agent;
  const companion = new CompanionManager({
    settings, groq, capture, audio, speech, agent, ui, log, screenApi, localVoice, uia,
    quick: {
      parse: quick.parse,
      execute: async (intent, extra) => {
        const r = await quick.execute(intent, Object.assign({ apps, tools, win32, activity, timers: timerManager, run: psMod.runPowerShellFast, openPanel: () => openSettingsPanel() }, extra));
        // Disk questions log themselves (with the real outcome); everything else is recorded here.
        if (r && r.handled && intent.kind !== 'disk') {
          try { activity.add(Object.assign(summarizeQuick(intent), { ok: r.ok !== false })); } catch (_) { /* logging never blocks a command */ }
        }
        return r;
      },
    },
  });
  ctx.companion = companion;

  // Cartoon eyes in a corner: follow the mouse, react to listening / thinking / talking.
  const eyes = new eyesMod.EyesWindow({
    BrowserWindow, screen, log,
    preloadPath: path.join(__dirname, '..', 'preload', 'preload.js'),
    htmlPath: eyesMod.htmlPath,
    getSettings: () => settings.all(),
  });
  ctx.eyes = eyes;
  companion.onStateChange = (st) => eyes.setState(st);

  // ------------------------------------------------------------ permissions
  function micGranted() {
    if (settings.get('micGranted')) return true;
    try {
      if (systemPreferences.getMediaAccessStatus) return systemPreferences.getMediaAccessStatus('microphone') === 'granted' && isWin;
    } catch (_) { /* ignore */ }
    return false;
  }

  function refreshPermissions() {
    companion.refreshPermissions({ microphone: micGranted(), screen: true, input: true, groqKey: settings.hasApiKey() });
  }

  let wakeListening = false;
  function syncWakeWord() {
    if (!audioState.ready) return;
    const on = wake.shouldListen(settings.all(), localVoice.status(), micGranted());
    if (on === wakeListening) return;
    wakeListening = on;
    wm.send(audioWin(), on ? 'audio:wake-start' : 'audio:wake-stop', {});
    log.info('wake word listener', on ? 'on' : 'off');
  }

  async function requestMic() {
    if (micGranted()) return refreshPermissions();
    try {
      if (isWin && systemPreferences.getMediaAccessStatus('microphone') === 'denied') {
        shell.openExternal('ms-settings:privacy-microphone');
        ui.notify('Turn on microphone access for desktop apps, then press Grant again.', 'warn');
        return undefined;
      }
    } catch (_) { /* ignore */ }
    // Probe: open the mic for a moment. Success means Windows let us in.
    await whenAudioReady();
    audioState.micOkSeen = false;
    const ok = await new Promise((resolve) => {
      audioState.probing = resolve;
      wm.send(audioWin(), 'audio:start', {});
      setTimeout(() => resolve(audioState.micOkSeen), 4000);
    });
    audioState.probing = null;
    wm.send(audioWin(), 'audio:cancel', {});
    if (ok) settings.set({ micGranted: true });
    else {
      ui.notify('Sidekick could not open the microphone. Check Windows Settings > Privacy > Microphone.', 'error');
      if (isWin) shell.openExternal('ms-settings:privacy-microphone');
    }
    return refreshPermissions();
  }

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const url = (wc && wc.getURL && wc.getURL()) || '';
    cb(url.startsWith('file://') && (permission === 'media' || permission === 'audioCapture'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'audioCapture');

  // ------------------------------------------------------------ settings side effects
  const detector = new ShortcutDetector(settings.get('pushToTalkShortcut'));
  ctx.detector = detector;

  function applyLoginItem() {
    if (!app.isPackaged || !isWin) return;
    try {
      app.setLoginItemSettings({ openAtLogin: !!settings.get('launchAtLogin'), args: ['--hidden'] });
    } catch (e) {
      log.warn('login item failed', e && e.message);
    }
  }

  let lastProtect = settings.get('hideFromCapture');
  settings.onChange((pub) => {
    wm.broadcast('settings', pub, { overlays: false });
    wm.broadcast('settings', wm._overlaySettings(), { others: false });
    detector.setOption(pub.pushToTalkShortcut);
    applyLoginItem();
    if (pub.hideFromCapture !== lastProtect) {
      lastProtect = pub.hideFromCapture;
      wm.reapplyProtection();
    }
    companion._publishStatus();
    syncWakeWord();
    try { eyes.sync(); } catch (_) { /* cosmetic */ }
  });

  // ------------------------------------------------------------ IPC
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(payload || {}, event);
    } catch (e) {
      log.error('ipc ' + channel + ' failed', e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  handle('settings:get', () => settings.getPublic());
  handle('settings:set', (patch) => {
    const next = Object.assign({}, patch);
    const currentlyLocal = settings.get('provider') === 'local';
    // The local preset is enforced even for follow-up patches (voice pickers, model changes):
    // Ollama has no /audio endpoints, so STT stays local and TTS is local or the Windows voice.
    const isLocal = next.provider === 'local' || (currentlyLocal && next.provider !== 'groq' && next.provider !== 'deepseek');
    if (isLocal) {
      const root = ollama.normalizeRoot(next.ollamaRoot || settings.get('ollamaRoot'));
      next.ollamaRoot = root;
      next.groqBaseUrl = root + '/v1';
      next.sttProvider = 'local';
      const want = next.ttsProvider || settings.get('ttsProvider');
      next.ttsProvider = want === 'windows' || want === 'edge' ? want : 'local';
    } else if (next.provider === 'groq') {
      next.groqBaseUrl = 'https://api.groq.com/openai/v1';
    } else if (next.provider === 'deepseek') {
      next.groqBaseUrl = 'https://api.deepseek.com';
      next.sttProvider = 'local'; // DeepSeek has no speech-to-text
      if (!/^deepseek/i.test(String(next.visionModel || settings.get('visionModel')))) {
        next.visionModel = 'deepseek-flash';
        next.agentModel = 'deepseek-flash';
      }
      if (['groq', undefined].includes(next.ttsProvider || (settings.get('ttsProvider') === 'groq' ? 'groq' : undefined))) next.ttsProvider = 'edge';
    }
    settings.set(next);
    refreshPermissions();
    return settings.getPublic();
  });
  handle('settings:setApiKey', async ({ key }) => {
    const trimmed = String(key || '').trim();
    if (!trimmed) {
      settings.setApiKey('');
      refreshPermissions();
      return { ok: true };
    }
    const probe = new GroqClient({ getApiKey: () => trimmed, getBaseUrl: baseUrl, log });
    try {
      await probe.validateKey();
    } catch (e) {
      return { ok: false, error: e.kind === 'bad_key' ? `${groq.label()} did not accept that key.` : e.message };
    }
    settings.setApiKey(trimmed);
    refreshPermissions();
    return { ok: true };
  });
  handle('settings:validateKey', async () => {
    try {
      const r = await groq.validateKey();
      return { ok: true, models: r.models.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // Ollama preset: list models and read their capabilities (never exposed to the renderer directly,
  // so the renderer's CSP can stay connect-src 'none').
  handle('ai:models', async ({ root } = {}) => {
    try {
      const r = await ollama.listModels(root || ollamaRoot());
      return { ok: true, root: r.root, models: r.models };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  handle('ai:model', async ({ root, model } = {}) => {
    try {
      const r = await ollama.modelInfo(root || ollamaRoot(), model);
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  handle('ai:test', async ({ root } = {}) => {
    try {
      const r = await ollama.testConnection(root || ollamaRoot());
      return { ok: true, root: r.root, count: r.models.length, models: r.models.slice(0, 12) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  handle('settings:resetAll', () => {
    agent.stopAll('reset');
    settings.reset();
    ctx.chat = [];
    refreshPermissions();
    return { ok: true };
  });
  handle('status:get', () => companion.snapshot());
  handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));

  handle('panel:action', (p) => {
    switch (p.type) {
      case 'close': wm.hidePanel(); break;
      case 'quit': quit(); break;
      case 'replay': companion.replayOnboarding(); break;
      case 'start': companion.triggerOnboarding(); break;
      case 'home': wm.hidePanel(); wm.openHome(); break;
      case 'cursor': companion.setCursorEnabled(!!p.enabled); break;
      case 'email': companion.submitEmail(p.email); break;
      case 'open-url':
        if (/^https:\/\//i.test(String(p.url || ''))) shell.openExternal(p.url);
        break;
      default:
    }
    return { ok: true };
  });
  handle('permissions:request', async ({ name }) => {
    if (name === 'microphone') await requestMic();
    return { ok: true };
  });

  handle('chat:send', ({ text }) => {
    const t = String(text || '').trim();
    if (!t) return { ok: false };
    ctx.chatAppend({ role: 'user', text: t });
    companion.sendText(t);
    return { ok: true };
  });
  handle('chat:history', () => ctx.chat);
  handle('chat:clear', () => { ctx.chat = []; return { ok: true }; });

  handle('job:respond', ({ id, approved, answer }) => { agent.respond(id, { approved: !!approved, answer: String(answer || '') }); return { ok: true }; });
  handle('job:stop', ({ id }) => ({ ok: agent.stop(id) }));
  handle('job:run', ({ task, desktop }) => {
    const t = String(task || '').trim();
    if (!t) return { ok: false };
    companion.runJob(t, { mode: desktop ? 'drive' : 'background', desktop: !!desktop }).then((r) => ui.notify(r.summary, r.status === 'failed' ? 'error' : 'info'));
    return { ok: true };
  });
  handle('job:list', () => agent.listJobs());

  handle('routine:delete', ({ id }) => settings.set({ routines: settings.get('routines').filter((r) => r.id !== id) }) && { ok: true });
  handle('routine:toggle', ({ id }) => settings.set({ routines: settings.get('routines').map((r) => (r.id === id ? Object.assign({}, r, { enabled: r.enabled === false }) : r)) }) && { ok: true });
  handle('routine:add', ({ task, time, days }) => {
    const scheduleText = `${(days && days.length ? days : ['*']).join(',')}@${time}`;
    const schedule = parseRoutineSchedule(scheduleText);
    if (!schedule || !String(task || '').trim()) return { ok: false, error: 'Invalid routine.' };
    const routine = { id: 'r' + Date.now().toString(36), schedule, scheduleText, task: String(task).trim(), enabled: true };
    settings.set({ routines: settings.get('routines').concat([routine]) });
    return { ok: true };
  });
  handle('memory:delete', ({ index }) => {
    const mem = settings.get('memory').slice();
    mem.splice(Number(index), 1);
    settings.set({ memory: mem });
    return { ok: true };
  });

  // ------------------------------------------------------------ folders + activity (Home)
  const folderState = async () => {
    const chosen = folderAccess.chosen().map((r) => ({ path: r.path, write: !!r.write }));
    let drives = [];
    try { drives = await tools.listDrives(); } catch (_) { /* drives are only a convenience */ }
    return { ok: true, isDefault: folderAccess.isDefault(), folders: chosen, drives, home: app.getPath('home'), note: folderAccess.protectedNote };
  };
  handle('folders:get', () => folderState());
  handle('folders:set', async ({ folders }) => {
    if (folders === null) {
      settings.set({ folders: null });
      activity.add({ source: 'user', kind: 'setting', summary: 'folder permissions reset to the default (your user folder)' });
      return folderState();
    }
    const clean = sanitizeFolderList(folders);
    if (clean === null) return { ok: false, error: 'Send a list of folders.' };
    const bad = (Array.isArray(folders) ? folders : []).length - clean.length;
    settings.set({ folders: clean });
    activity.add({ source: 'user', kind: 'setting', summary: `folder permissions saved: ${clean.length} folder${clean.length === 1 ? '' : 's'}, ${clean.filter((f) => f.write).length} may be changed` });
    const st = await folderState();
    if (bad > 0) st.warning = `${bad} entr${bad === 1 ? 'y was' : 'ies were'} not a full path and was skipped.`;
    return st;
  });
  handle('folders:pick', async (_p, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for Sidekick', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? { ok: false, canceled: true } : { ok: true, path: r.filePaths[0] };
  });
  handle('activity:list', ({ filter, limit }) => ({ ok: true, items: activity.recent({ filter: ['all', 'changes', 'blocked', 'reads'].includes(filter) ? filter : 'all', limit: Math.min(500, Number(limit) || 200) }) }));
  handle('activity:clear', () => { activity.clear(); activity.add({ source: 'user', kind: 'setting', summary: 'activity log cleared' }); return { ok: true }; });
  handle('activity:open', () => { shell.showItemInFolder(path.join(userData, 'activity.jsonl')); return { ok: true }; });

  handle('overlay:ready', (_p, event) => { wm.overlayReady(event.sender); return { ok: true }; });
  handle('overlay:event', (p) => {
    if (p.type === 'pointing-done') {
      companion.pointingActive = false;
      wm.broadcast('overlay:pointing-state', { active: false }, { others: false });
    } else onboardingEvent(p.type);
    return { ok: true };
  });

  handle('model3d:ready', () => {
    if (ctx.modelPayload) wm.send(wm.model3d, 'model3d:show', ctx.modelPayload);
    return { ok: true };
  });
  handle('model3d:ask', ({ title, part, info }) => {
    const q = `about the 3d model of ${title}: what is the ${part}? ${info || ''}`.trim();
    ctx.chatAppend({ role: 'user', text: q });
    companion.sendText(q);
    return { ok: true };
  });

  handle('notch:resize', (p) => {
    if (p.panelHeight) wm.resizePanel(p.panelHeight);
    else wm.resizeNotch(p.height || 40, p.visible !== false, p.focusable);
    return { ok: true };
  });

  let level = 0;
  handle('audio:levels', ({ rms }) => {
    if (audioState.probing && rms > 0) audioState.micOkSeen = true;
    if (audioState.probing && rms === 0) audioState.micOkSeen = audioState.micOkSeen || false;
    level = motion.smoothAudioLevel(Number(rms) || 0, level);
    wm.broadcast('audio-level', level, { others: false });
    if (audioState.probing && audioState.micOkSeen) audioState.probing(true);
    return { ok: true };
  });
  handle('audio:ready', () => {
    audioState.ready = true;
    wakeListening = false;
    audioState.readyWaiters.splice(0).forEach((r) => r());
    syncWakeWord();
    return { ok: true };
  });
  handle('audio:recorded', ({ wav, durationMs }) => {
    const waiter = audioState.recordWaiter;
    audioState.recordWaiter = null;
    if (waiter) waiter(wav ? { wav: Buffer.from(wav), durationMs } : null);
    return { ok: true };
  });
  handle('audio:ended', ({ id }) => {
    const w = audioState.playWaiters.get(id);
    if (w) w();
    return { ok: true };
  });
  handle('audio:error', ({ message, name }) => {
    log.warn('audio host error', name, message);
    if (audioState.probing) { audioState.probing(false); return { ok: true }; }
    companion.recording = false;
    companion.setPermission('microphone', false);
    if (name === 'NotAllowedError' || name === 'SecurityError') settings.set({ micGranted: false });
    companion._fail(new Error('I could not open the microphone. Check Windows microphone privacy settings.'));
    return { ok: true };
  });

  let wakeBusy = false;
  handle('audio:wake', async ({ wav } = {}) => {
    if (!wav || !settings.get('wakeWordEnabled')) return { ok: true, ignored: 'off' };
    if (!localVoice.status().stt) return { ok: true, ignored: 'no-local-whisper' };
    if (wakeBusy || companion.recording || companion.voiceState !== 'idle' || companion.onboardingVideoActive || speech.isSpeaking) {
      return { ok: true, ignored: 'busy' };
    }
    wakeBusy = true;
    try {
      const text = await localVoice.transcribe(Buffer.from(wav), { threads: 2 });
      if (!text) return { ok: true, heard: false };
      const last = companion.history.length ? companion.history[companion.history.length - 1].assistant : '';
      if (wake.looksLikeEcho(text, last) && companion.inConversation(30)) {
        log.info('ignored my own voice coming back through the mic');
        return { ok: true, heard: true, matched: false, echo: true };
      }
      let matched = companion.onWakeTranscript(text);
      // Right after an answer you can just keep talking: no wake word needed for a few seconds.
      if (!matched && companion.inConversation(Number(settings.get('conversationWindowSec')) || 0) && text.trim().split(/\s+/).length >= 2) {
        matched = companion.onFollowUpTranscript(text);
      }
      if (!matched) log.info('wake utterance ignored', { chars: text.length });
      return { ok: true, heard: true, matched };
    } catch (e) {
      log.warn('wake transcription failed', e && e.message);
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      wakeBusy = false;
    }
  });

  handle('localvoice:status', () => localVoice.status());
  handle('localvoice:install', () => {
    const s = settings.all();
    localVoice
      .install({ whisperModel: s.whisperModel })
      .then((st) => {
        // Installing the local voice is an explicit choice: use it for the next answer.
        if (st.stt) settings.set({ sttProvider: 'local' });
        // Kokoro is the offline backup. Keep the natural Edge voice as the main one.
        if (st.tts && settings.get('ttsProvider') === 'groq') settings.set({ ttsProvider: 'edge' });
        if (st.stt || st.tts) refreshPermissions();
      })
      .catch((e) => log.error('local voice install', e));
    return { ok: true };
  });
  handle('localvoice:remove', () => {
    const st = localVoice.remove();
    // DeepSeek has no speech-to-text, so keep 'local' STT selected; the app then explains what to install.
    if (settings.get('sttProvider') === 'local' && groq.isGroq()) settings.set({ sttProvider: 'groq' });
    if (settings.get('ttsProvider') === 'local') settings.set({ ttsProvider: groq.isGroq() ? 'groq' : 'edge' });
    return { ok: true, status: st };
  });
  handle('localvoice:test', async () => {
    const s = settings.all();
    try {
      const wav = await localVoice.synthesize('hey, this is the local voice running on your own computer.', { speaker: Number(s.kokoroSpeaker) || 0, speed: Number(s.kokoroSpeed) || 1 });
      if (!wav) return { ok: false, error: 'No audio was produced.' };
      await playWav(wav);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  handle('logs:open', () => {
    if (log.file) shell.showItemInFolder(log.file);
    return { ok: !!log.file };
  });

  // ------------------------------------------------------------ Settings window (Part 2)
  let panelWin = null;
  function openSettingsPanel() {
    if (panelWin && !panelWin.isDestroyed()) {
      if (panelWin.isMinimized()) panelWin.restore();
      panelWin.show();
      panelWin.focus();
      return;
    }
    panelWin = new BrowserWindow({
      width: 580, height: 800, minWidth: 460, minHeight: 540,
      title: 'Sidekick Settings', backgroundColor: '#0f1115', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    panelWin.removeMenu();
    panelWin.once('ready-to-show', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.show(); });
    panelWin.on('closed', () => { panelWin = null; });
    panelWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panelWin.webContents.on('will-navigate', (e) => e.preventDefault());
    panelWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings-panel', 'index.html'));
  }
  ctx.openSettingsPanel = openSettingsPanel;
  handle('panel:open', ({ action } = {}) => {
    if (action === 'keypage') {
      const url = voiceSettings.keyHint(settings.all()).url;
      if (url) shell.openExternal(url);
      return { ok: !!url };
    }
    openSettingsPanel();
    return { ok: true };
  });
  handle('voice:catalog', () => ({
    ok: true,
    settings: settings.getPublic(),
    catalog: voiceSettings.buildCatalog({ settings: settings.all(), local: localVoice.status(), edge: { available: edge.available(), lastError: edge.lastError || '' } }),
  }));
  // Only the voice / wake word / follow-up keys, validated. The panel never writes raw settings.
  handle('settings:voice', (input) => {
    const { patch, errors } = voiceSettings.sanitizeVoicePatch(input);
    if (errors.length) return { ok: false, error: errors[0] };
    settings.set(patch);
    refreshPermissions();
    return { ok: true, settings: settings.getPublic() };
  });
  // Hear a voice before choosing it. Nothing is saved.
  handle('voice:preview', async ({ engine, voice, speaker } = {}) => {
    const sample = 'hey, this is how i sound. just say hey sidekick, and tell me what to do.';
    try {
      if (engine === 'edge') {
        const { patch, errors } = voiceSettings.sanitizeVoicePatch({ edgeVoice: voice });
        if (errors.length) return { ok: false, error: errors[0] };
        const audio = await edge.synthesize(sample, { voice: patch.edgeVoice });
        if (!audio) return { ok: false, error: 'No audio was produced.' };
        await playWav(audio);
        return { ok: true };
      }
      if (engine === 'local') {
        if (!localVoice.status().tts) return { ok: false, error: 'The offline voice is not installed yet.' };
        const { patch, errors } = voiceSettings.sanitizeVoicePatch({ kokoroSpeaker: speaker });
        if (errors.length) return { ok: false, error: errors[0] };
        const wav = await localVoice.synthesize(sample, { speaker: patch.kokoroSpeaker, speed: Number(settings.get('kokoroSpeed')) || 1 });
        if (!wav) return { ok: false, error: 'No audio was produced.' };
        await playWav(wav);
        return { ok: true };
      }
      companion.say(sample);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  handle('voice:test', () => { companion.say('hey, this is how i sound. just say hey sidekick, and tell me what to do.'); return { ok: true }; });
  handle('voice:edge-status', () => ({ ok: true, available: edge.available(), lastError: edge.lastError || '' }));
  handle('window:control', ({ action }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
    return { ok: true };
  });

  // ------------------------------------------------------------ tray
  try {
    wm.createTray(() => quit(), () => openSettingsPanel());
  } catch (e) {
    log.warn('tray failed', e && e.message);
  }

  // ------------------------------------------------------------ loops
  const timers = [];
  // push-to-talk: poll the keyboard (no hooks, nothing is recorded or stored)
  timers.push(setInterval(() => {
    if (input.isInjecting() || win32.stub) return;
    try {
      const events = detector.update(win32.readKeySnapshot(), Date.now());
      for (const e of events) companion.handleShortcutEvent(e);
    } catch (e) {
      log.warn('key poll failed', e && e.message);
    }
  }, 16));
  // overlay cursor follower
  timers.push(setInterval(() => {
    if (wm.hasOverlay()) wm.sendCursor(screen.getCursorScreenPoint());
  }, 16));
  // permissions
  timers.push(setInterval(refreshPermissions, 1500));

  const routines = new RoutineScheduler({
    getRoutines: () => settings.get('routines'),
    onDue: (r) => {
      ui.notify('Running routine: ' + r.task, 'info');
      companion.runJob(r.task, { name: 'Routine: ' + r.task.slice(0, 36), mode: 'background', desktop: false })
        .then((res) => ui.notify(res.summary, res.status === 'failed' ? 'error' : 'info'));
    },
  });
  routines.start();
  ctx.routines = routines;

  // ------------------------------------------------------------ startup
  companion.start();
  if (!FLAG_E2E && !FLAG_SELFCHECK) setTimeout(() => { try { eyes.sync(); } catch (e) { log.warn('eyes', e && e.message); } }, 800);
  refreshPermissions();
  applyLoginItem();

  app.on('second-instance', () => wm.showPanel());

  // No AI key yet: open the Settings window so the first thing you see is where to paste it.
  if (!FLAG_E2E && !FLAG_SELFCHECK && !settings.hasApiKey()) setTimeout(() => openSettingsPanel(), 1200);

  const needsSetup = !settings.get('hasCompletedOnboarding') || !companion.allPermissionsGranted();
  if (!FLAG_E2E && !FLAG_SELFCHECK && (!FLAG_HIDDEN || !settings.get('hasCompletedOnboarding')) && needsSetup) {
    setTimeout(() => wm.showPanel(), 600);
  }

  function quit() {
    try {
      try { eyes.close(); } catch (_) { /* ignore */ }
      companion.stop();
      agent.stopAll('quit');
      routines.stop();
      timers.forEach(clearInterval);
      try { require('./powershell').disposeSharedSession(); } catch (_) { /* ignore */ }
      settings.data.chat = ctx.chat;
      settings._save();
      if (wakeListening) wm.send(audioWin(), 'audio:wake-stop', {});
      wakeListening = false;
      wm.hideOverlay();
    } catch (_) { /* ignore */ }
    app.exit(0);
  }
  ctx.quit = quit;

  app.on('before-quit', () => { timers.forEach(clearInterval); try { edge.dispose(); } catch (_) { /* ignore */ } try { require('./powershell').disposeSharedSession(); } catch (_) { /* ignore */ } });

  if ((FLAG_E2E || FLAG_SELFCHECK) && E2E_SCRIPT) {
    // The e2e scenario runs inside the main process and drives the whole app.
    Promise.resolve()
      .then(() => require(path.resolve(E2E_SCRIPT))(Object.assign(ctx, { app, screen, BrowserWindow })))
      .catch((e) => {
        console.error('E2E FAILED', e);
        app.exit(1);
      });
  }
}
