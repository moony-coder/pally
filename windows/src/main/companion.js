'use strict';
/*
 * CompanionManager: the central state machine (port of CompanionManager.swift).
 *
 *   idle -> listening (hotkey down) -> processing (hotkey up: STT + vision)
 *        -> responding (speech playing) -> idle
 *
 * All collaborators are injected so the whole flow is unit-testable.
 *
 * deps = {
 *   settings, groq, capture, audio, speech, agent, ui, log, screenApi,
 *   now?, setTimeoutImpl?
 * }
 *  audio:  { start(), stop() -> Promise<{wav:Buffer, durationMs:number}|null>, cancel() }
 *  speech: SpeechQueue (enqueue/finish/stop/whenIdle/isSpeaking)
 *  ui:     see main/windows.js (setVoiceState, audioLevel, pointAt, drawShapes, showCards,
 *          showModel3D, caption, notify, showOverlay, hideOverlay, fadeOutOverlay, dismissPanel,
 *          startOnboardingOverlay, hasOverlay)
 */
const { parseResponseTags, SpokenSentenceStream, stripThinking } = require('./tags');
const { buildTalkSystemPrompt, buildOnboardingDemoPrompt } = require('./prompts');
const { withSpeedRules, FAST_MAX_TOKENS } = require('./speed-prompt');
const { imagePart, GroqError } = require('./groq');
const { SHORTCUT_OPTIONS } = require('./keys');
const { mapModelPointToGlobal, pickTargetCapture, mapDrawToGlobal } = require('./screen-math');
const grounding = require('./grounding');
const wake = require('./wake');

const MAX_HISTORY = 10;
const MAX_IMAGES = 3; // Groq vision limit per request
const MIN_RECORDING_MS = 250;
const GROUNDING_TIMEOUT_MS = 2500; // never let the control list slow a reply by more than this

class CompanionManager {
  constructor(deps) {
    this.d = deps;
    this.log = deps.log || { info() {}, warn() {}, error() {} };
    this.voiceState = 'idle';
    this.history = [];
    this.responseAbort = null;
    this.responseSeq = 0;
    this.transientTimer = null;
    this.pointingActive = false;
    this.onboardingVideoActive = false;
    this.lastTranscript = '';
    this.lastError = '';
    this.pendingPressedAt = 0;
    this.recording = false;
    this.wakeFollowUpTimer = null;
    this.lastTurnEndedAt = 0; // for the hands-free follow-up window
    this.permissions = { microphone: false, groqKey: false, screen: true, input: true };
  }

  // ---------------------------------------------------------------- state
  get settings() {
    return this.d.settings;
  }

  get cursorEnabled() {
    return this.settings.get('cursorEnabled');
  }

  _setState(state) {
    if (this.voiceState === state) return;
    this.voiceState = state;
    this.d.ui.setVoiceState(state);
    if (typeof this.onStateChange === 'function') { try { this.onStateChange(state); } catch (_) { /* cosmetic */ } }
    this._publishStatus();
  }

  statusText() {
    if (!this.allPermissionsGranted()) return 'Setup';
    switch (this.voiceState) {
      case 'listening': return 'Listening';
      case 'processing': return 'Processing';
      case 'responding': return 'Responding';
      default: return this.d.ui.hasOverlay() ? 'Active' : 'Ready';
    }
  }

  // name of the AI service in plain words, for messages
  _ai() {
    const g = this.d.groq;
    const label = g && g.label ? g.label() : 'the AI';
    return /local/i.test(label) ? 'the local ai' : label;
  }

  inConversation(windowSec) {
    return windowSec > 0 && this.lastTurnEndedAt > 0 && Date.now() - this.lastTurnEndedAt < windowSec * 1000;
  }

  allPermissionsGranted() {
    const p = this.permissions;
    return !!(p.microphone && p.groqKey && p.screen && p.input);
  }

  snapshot() {
    return {
      voiceState: this.voiceState,
      statusText: this.statusText(),
      permissions: this.permissions,
      allPermissionsGranted: this.allPermissionsGranted(),
      overlayVisible: this.d.ui.hasOverlay(),
      lastError: this.lastError,
      shortcut: (() => {
        const o = SHORTCUT_OPTIONS[this.settings.get('pushToTalkShortcut')] || SHORTCUT_OPTIONS['ctrl+alt'];
        return { id: o.id, displayText: o.displayText, keyCapsuleLabels: o.keyCapsuleLabels };
      })(),
      jobs: this.d.agent ? this.d.agent.listJobs() : [],
    };
  }

  _publishStatus() {
    if (!this.d.ui.status) return;
    const snapshot = this.snapshot();
    // main.js refreshes permissions every 1.5s. Only push when something actually changed,
    // otherwise the panel and Home re-render constantly and typing in their inputs glitches.
    let signature;
    try { signature = JSON.stringify(snapshot); } catch (_) { signature = null; }
    if (signature !== null && signature === this._lastStatusSignature) return;
    this._lastStatusSignature = signature;
    this.d.ui.status(snapshot);
  }

  setPermission(name, value) {
    if (this.permissions[name] === value) return;
    this.permissions[name] = value;
    this._publishStatus();
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.permissions.groqKey = this.settings.hasApiKey();
    this.settings.onChange(() => {
      this.permissions.groqKey = this.settings.hasApiKey();
      this._publishStatus();
    });
    const s = this.settings.all();
    if (s.hasCompletedOnboarding && this.allPermissionsGranted() && s.cursorEnabled) {
      this.d.ui.showOverlay({ firstAppearance: false });
    }
    this._publishStatus();
  }

  // Called by main whenever permissions may have changed.
  refreshPermissions(partial) {
    for (const [k, v] of Object.entries(partial)) this.permissions[k] = !!v;
    if (this.allPermissionsGranted() && this.settings.get('hasCompletedOnboarding') && this.cursorEnabled && !this.d.ui.hasOverlay()) {
      this.d.ui.showOverlay({ firstAppearance: false });
    }
    this._publishStatus();
  }

  stop() {
    this.cancelResponse();
    clearTimeout(this.wakeFollowUpTimer);
    this.wakeFollowUpTimer = null;
    this.d.audio.cancel();
    this.d.ui.hideOverlay();
    clearTimeout(this.transientTimer);
  }

  // ---------------------------------------------------------------- settings actions
  setCursorEnabled(enabled) {
    this.settings.set({ cursorEnabled: !!enabled });
    clearTimeout(this.transientTimer);
    if (enabled) this.d.ui.showOverlay({ firstAppearance: false });
    else this.d.ui.hideOverlay();
    this._publishStatus();
  }

  triggerOnboarding() {
    this.d.ui.dismissPanel();
    this.settings.set({ hasCompletedOnboarding: true });
    this.d.ui.startOnboardingOverlay({ replay: false });
    this._publishStatus();
  }

  replayOnboarding() {
    this.d.ui.dismissPanel();
    this.d.ui.startOnboardingOverlay({ replay: true });
    this._publishStatus();
  }

  submitEmail(email) {
    const trimmed = String(email || '').trim();
    if (!trimmed) return;
    this.settings.set({ hasSubmittedEmail: true, email: trimmed });
    this._publishStatus();
  }

  // ---------------------------------------------------------------- push to talk
  handleShortcutEvent(event) {
    switch (event.type) {
      case 'pressed':
        this.onPressed();
        break;
      case 'released':
        this.onReleased();
        break;
      case 'escape':
        this.onEscape();
        break;
      case 'double-ctrl':
        if (this.d.ui.openHome) this.d.ui.openHome();
        break;
      default:
    }
  }

  onEscape() {
    if (this.d.agent && this.d.agent.listJobs().some((j) => j.status === 'running' || j.status === 'waiting')) {
      this.d.agent.stopAll('stopped with escape');
      return;
    }
    if (this.voiceState === 'responding' || this.voiceState === 'processing') this.cancelResponse();
  }

  onPressed() {
    if (this.recording) return;
    if (!this.allPermissionsGranted()) {
      this.d.ui.notify(this.permissions.groqKey ? 'Allow the microphone first.' : `Add your ${this._ai()} API key in the Sidekick panel first.`, 'warn');
      this.d.ui.openPanel();
      return;
    }
    if (this.onboardingVideoActive) return;
    clearTimeout(this.transientTimer);
    this.transientTimer = null;
    if (!this.cursorEnabled && !this.d.ui.hasOverlay()) this.d.ui.showOverlay({ firstAppearance: false });
    this.d.ui.dismissPanel();
    this.cancelResponse();
    this.d.ui.clearPointing();
    this.d.ui.dismissOnboardingPrompt();
    this.lastError = '';
    this.recording = true;
    this.pendingPressedAt = Date.now();
    // Start the UI Automation worker now: by the time you finish the sentence it is warm and the control list is instant.
    try { if (this.d.uia && this.d.uia.prewarm && this.settings.get('useAccessibilityGrounding')) this.d.uia.prewarm(); } catch (_) { /* optional */ }
    this._setState('listening');
    Promise.resolve(this.d.audio.start()).catch((e) => {
      this.log.error('mic start failed', e);
      this.recording = false;
      this._fail(new Error('I could not open the microphone.'));
    });
  }

  async onReleased() {
    clearTimeout(this.wakeFollowUpTimer);
    this.wakeFollowUpTimer = null;
    if (!this.recording) return;
    this.recording = false;
    this._setState('processing');
    let rec = null;
    try {
      rec = await this.d.audio.stop();
    } catch (e) {
      this.log.error('mic stop failed', e);
    }
    if (!rec || !rec.wav || rec.durationMs < MIN_RECORDING_MS) {
      this._setState('idle');
      this._scheduleTransientHide();
      return;
    }
    const seq = ++this.responseSeq;
    const abort = new AbortController();
    this.responseAbort = abort;
    try {
      const transcript = await this._transcribe(rec.wav, abort.signal);
      if (seq !== this.responseSeq) return;
      if (!transcript) {
        this._setState('idle');
        this._scheduleTransientHide();
        return;
      }
      this.lastTranscript = transcript;
      this.d.ui.userSaid && this.d.ui.userSaid(transcript);
      // A running job is waiting for an answer: the spoken words are the answer.
      const waiting = this.d.agent && this.d.agent.pendingJob && this.d.agent.pendingJob();
      if (waiting) {
        const yes = /\b(yes|yeah|yep|sure|go ahead|do it|okay|ok|allow|approve)\b/i.test(transcript);
        const no = /\b(no|nope|stop|don't|do not|cancel|deny)\b/i.test(transcript);
        this.d.agent.respond(waiting.id, { approved: yes && !no, answer: transcript });
        this._setState('idle');
        return;
      }
      await this._respond(transcript, seq, abort);
    } catch (e) {
      if (seq !== this.responseSeq) return;
      this._fail(e);
    }
  }

  // Speech to text: local Whisper when chosen and installed (no rate limits), otherwise Groq.
  // If the local engine fails for any reason the user is never stuck: fall back to Groq.
  async _transcribe(wavBuffer, signal) {
    const useLocal = this.settings.get('sttProvider') === 'local' && this.d.localVoice && this.d.localVoice.status().stt;
    if (useLocal) {
      try {
        return await this.d.localVoice.transcribe(wavBuffer, { signal });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        this.log.warn('local Whisper failed, using Groq:', e && e.message);
      }
    }
    if (this.d.groq.isDeepSeek && this.d.groq.isDeepSeek()) {
      throw new GroqError('bad_request', 'I need the local voice (Whisper) to hear you. Open Sidekick Home, Settings, Local voice, Download.');
    }
    return this.d.groq.transcribe({
      wavBuffer,
      model: this.settings.get('sttModel'),
      language: 'en',
      signal,
    });
  }

  // Called by main after local Whisper transcribed a VAD-gated wake utterance.
  // Returns true when the wake phrase matched.
  onWakeTranscript(text) {
    const match = wake.extractWakeCommand(text, this.settings.get('wakePhrase'));
    if (!match) return false;
    this.log.info('wake word matched', { phrase: match.phrase, commandChars: match.command.length });
    if (!this.allPermissionsGranted()) return true;
    if (match.command) {
      this.sendText(match.command.slice(0, 500));
      return true;
    }
    this.startWakeFollowUp();
    return true;
  }

  // The user said only "hey sidekick". Open the mic for a few seconds so they can add the request.
  startWakeFollowUp() {
    if (this.recording || this.onboardingVideoActive) return;
    this.d.ui.caption('listening');
    this.onPressed();
    if (!this.recording) return;
    clearTimeout(this.wakeFollowUpTimer);
    this.wakeFollowUpTimer = setTimeout(() => {
      this.wakeFollowUpTimer = null;
      this.onReleased();
    }, 6000);
  }

  // typed message (Home chat or quick input)
  async sendText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (!this.permissions.groqKey) {
      this._fail(new GroqError('no_key', `Add your ${this._ai()} API key in Sidekick settings first.`));
      return;
    }
    clearTimeout(this.transientTimer);
    this.cancelResponse();
    const seq = ++this.responseSeq;
    const abort = new AbortController();
    this.responseAbort = abort;
    this.lastTranscript = trimmed;
    this._setState('processing');
    try {
      await this._respond(trimmed, seq, abort);
    } catch (e) {
      if (seq === this.responseSeq) this._fail(e);
    }
  }

  cancelResponse() {
    this.responseSeq++;
    if (this.responseAbort) this.responseAbort.abort();
    this.responseAbort = null;
    this.d.speech.stop();
    if (this.voiceState !== 'listening') this._setState('idle');
  }

  say(text) {
    const t = String(text || '').trim();
    if (!t) return;
    this.d.ui.caption(t);
    this.d.speech.enqueue(t);
    this.d.speech.finish();
  }

  _fail(e) {
    const message = e && e.message ? e.message : String(e);
    this.log.warn('companion error:', message);
    this.lastError = message;
    this.d.speech.stop();
    this._setState('idle');
    this.d.ui.notify(message, 'error');
    this._publishStatus();
    const ai = this._ai().toLowerCase();
    const spoken = e && e.kind === 'no_key' ? `i need your ${ai} api key first. open my panel to add it.`
      : e && e.kind === 'bad_key' ? `${ai} did not accept your api key. check it in my panel.`
      : e && e.kind === 'no_balance' ? `${ai} says the account is out of balance. top it up and i will work again.`
      : e && e.kind === 'rate_limited' ? `${ai} is busy for a moment. try again in a few seconds.`
      : e && e.kind === 'network' ? `i cannot reach ${ai} right now. check your connection.`
      : e && e.kind === 'bad_request' && /local voice/i.test(message) ? 'i need the local voice installed to hear you. open my home, settings, and download it.'
      : 'something went wrong on my side.';
    if (this.d.speech.speakFallbackNow) this.d.speech.speakFallbackNow(spoken);
    this._scheduleTransientHide();
  }

  // ---------------------------------------------------------------- the main pipeline
  _buildMessages(captures, transcript, { elementsText = '', attachScreenshot = true } = {}) {
    const s = this.settings.all();
    const shortcut = SHORTCUT_OPTIONS[s.pushToTalkShortcut] || SHORTCUT_OPTIONS['ctrl+alt'];
    const system = withSpeedRules(buildTalkSystemPrompt({
      coordinateSpace: s.coordinateSpace,
      memoryFacts: s.memory,
      shortcutText: shortcut.displayText.toLowerCase().replace('+', ' + '),
      allowDrive: s.agent.allowDrive,
      elementsText,
      hasScreenshot: attachScreenshot,
    }));
    const messages = [{ role: 'system', content: system }];
    for (const h of this.history) {
      messages.push({ role: 'user', content: h.user });
      messages.push({ role: 'assistant', content: h.assistant });
    }
    // Groq accepts at most 3 images: keep the cursor screen plus the nearest others.
    const used = captures.slice(0, MAX_IMAGES);
    const content = [];
    if (attachScreenshot) {
      for (const cap of used) {
        content.push({ type: 'text', text: cap.label });
        content.push(imagePart(cap.jpeg));
      }
    } else {
      content.push({ type: 'text', text: '(no screenshot this time to save tokens: answer from the numbered controls list)' });
    }
    content.push({ type: 'text', text: transcript });
    messages.push({ role: 'user', content });
    return { messages, used };
  }

  // Exact controls of the foreground window (Windows UI Automation), numbered for the model.
  // Always resolves: on any problem the caller simply falls back to screenshot-only pointing.
  async _gatherControls() {
    const d = this.d;
    if (!d.uia || !d.screenApi || typeof d.screenApi.screenToDipPoint !== 'function' || !this.settings.get('useAccessibilityGrounding')) return [];
    try {
      const info = await Promise.race([
        d.uia.listForegroundElements(),
        new Promise((resolve) => setTimeout(() => resolve(null), GROUNDING_TIMEOUT_MS)),
      ]);
      if (!info || !info.elements) return [];
      return grounding.buildElementIndex(info.elements, (p) => d.screenApi.screenToDipPoint(p));
    } catch (e) {
      this.log.warn('control list failed:', e && e.message);
      return [];
    }
  }

  // Short, clear commands ("open chrome", "volume up", "what time is it") run right here, no AI round trip.
  async _tryQuick(transcript, seq) {
    const q = this.d.quick;
    if (!q || this.settings.get('quickCommands') === false) return false;
    const intent = q.parse(transcript);
    if (!intent) return false;
    let result;
    try {
      result = await q.execute(intent, { stop: () => this.onEscape(), now: () => new Date() });
    } catch (e) {
      this.log.warn('quick command failed, asking the AI instead:', e && e.message);
      return false;
    }
    if (seq !== this.responseSeq) return true;
    if (!result || !result.handled) return false;
    this.log.info('quick command', { kind: intent.kind });
    if (intent.kind === 'stop') {
      this.lastTurnEndedAt = 0;
      this._setState('idle');
      return true;
    }
    // Longer answers (a list of big files, every drive) go to the Home chat; the voice says the short version.
    if (result.text && this.d.ui.assistantSaid) this.d.ui.assistantSaid(result.text);
    this.history.push({ user: transcript, assistant: result.say || 'done' });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    const speech = this.d.speech;
    if (result.say) {
      speech.stop();
      speech.onStartHandler = () => { if (seq === this.responseSeq) this._setState('responding'); };
      this.d.ui.caption(result.say);
      speech.enqueue(result.say);
      speech.finish();
      await speech.whenIdle();
      if (seq !== this.responseSeq) return true;
    }
    this._setState('idle');
    this.lastTurnEndedAt = Date.now();
    this._scheduleTransientHide();
    return true;
  }

  async _respond(transcript, seq, abort) {
    if (await this._tryQuick(transcript, seq)) return;
    const [captures, index] = await Promise.all([this.d.capture.captureAllScreens(), this._gatherControls()]);
    if (seq !== this.responseSeq) return;
    const s = this.settings.all();
    const attachScreenshot = grounding.shouldAttachScreenshot(transcript, index.length, { enabled: s.skipScreenshotWhenPossible !== false });
    const elementsText = index.length ? grounding.describeIndex(index) : '';
    const { messages, used } = this._buildMessages(captures, transcript, { elementsText, attachScreenshot });
    this.log.info('turn', { controls: index.length, screenshot: attachScreenshot });
    const speech = this.d.speech;
    speech.stop();
    speech.onStartHandler = () => {
      if (seq === this.responseSeq) this._setState('responding');
    };
    speech.onPieceStart = (text) => {
      if (seq === this.responseSeq) this.d.ui.caption(text);
    };
    const stream = new SpokenSentenceStream();
    let enqueuedAny = false;
    const enqueue = (chunks) => {
      for (const c of chunks) {
        enqueuedAny = true;
        speech.enqueue(c);
      }
    };
    const res = await this.d.groq.chat({
      model: s.visionModel,
      messages,
      stream: true,
      signal: abort.signal,
      reasoningEffort: s.modelMode === 'deep' ? undefined : 'none',
      temperature: 0.6,
      maxTokens: s.modelMode === 'deep' ? (this.d.groq.isDeepSeek && this.d.groq.isDeepSeek() ? 12000 : 4000) : FAST_MAX_TOKENS,
      onTextDelta: (delta) => {
        if (seq !== this.responseSeq) return;
        enqueue(stream.push(delta));
      },
    });
    if (seq !== this.responseSeq) return;
    enqueue(stream.finish());
    speech.finish();

    const full = stripThinking(res.text);
    const tags = parseResponseTags(full);
    // remember the exchange (only spoken part, like the Mac app keeps plain text)
    this.history.push({ user: transcript, assistant: full });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    if (this.d.ui.assistantSaid) this.d.ui.assistantSaid(tags.spokenText);

    await this._applyTags(tags, used, s, seq, index);

    if (!enqueuedAny) this._setState('idle');
    // Back to idle once the speech finished.
    await speech.whenIdle();
    if (seq !== this.responseSeq) return;
    this._setState('idle');
    this.lastTurnEndedAt = Date.now();
    this._scheduleTransientHide();
  }

  // Hands-free follow-up (no wake word needed right after an answer).
  onFollowUpTranscript(text) {
    const t = String(text || '').trim();
    if (!t || !this.allPermissionsGranted()) return false;
    this.log.info('follow-up heard', { chars: t.length });
    this.sendText(t.slice(0, 500));
    return true;
  }

  async _applyTags(tags, captures, s, seq, index = []) {
    const space = s.coordinateSpace;
    // memory + routines
    if (tags.memories.length) {
      const mem = Array.from(new Set(s.memory.concat(tags.memories))).slice(-40);
      this.settings.set({ memory: mem });
    }
    if (tags.routines.length) {
      const routines = s.routines.slice();
      for (const r of tags.routines) {
        routines.push({
          id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
          schedule: r.schedule,
          scheduleText: r.scheduleText,
          task: r.task,
          enabled: true,
        });
      }
      this.settings.set({ routines });
      this.d.ui.notify('Routine saved: ' + tags.routines.map((r) => r.scheduleText).join(', '), 'info');
    }
    // pointing: a numbered control is exact; x,y is snapped to the real control it most likely meant
    const spot = this._resolvePointing(tags, captures, space, index);
    if (spot) this.d.ui.pointAt(spot.target, spot.label, spot.bounds, undefined, spot.rect);
    // drawings
    if (tags.draws.length) {
      const shapes = tags.draws
        .map((d) => (d.element != null ? grounding.elementDrawToGlobal(d, index, captures) : mapDrawToGlobal(d, captures, space)))
        .filter(Boolean);
      if (shapes.length) this.d.ui.drawShapes(shapes);
    }
    if (tags.explains && tags.explains.length && this.d.ui.showExplain) this.d.ui.showExplain(tags.explains[0]);
    if (tags.cards.length) this.d.ui.showCards(tags.cards);
    if (tags.modelTopic) this.d.ui.showModel3D(tags.modelTopic);
    if (seq !== this.responseSeq) return;
    if (tags.driveTask && s.agent.allowDrive && this.d.agent) {
      this._runAgent(tags.driveTask, 'drive', true);
    } else if (tags.agentTask && this.d.agent) {
      this._runAgent(tags.agentTask, 'background', false);
    }
  }

  // -> { target, label, bounds, rect|null } or null
  _resolvePointing(tags, captures, space, index) {
    const capAt = (p) => captures.find((c) => grounding.containsPoint(c.bounds, p)) || captures[0] || null;
    if (tags.elementId != null) {
      const el = grounding.byId(index, tags.elementId);
      if (el) {
        const target = grounding.pointForElement(el);
        const cap = capAt(target);
        return { target, label: tags.elementLabel || el.name, bounds: cap && cap.bounds, rect: el.rect };
      }
      return null; // the model named a number that is not in the list: do not guess
    }
    if (!tags.coordinate) return null;
    const cap = pickTargetCapture(captures, tags.screenNumber);
    if (!cap) return null;
    let target = mapModelPointToGlobal(tags.coordinate, cap, space);
    let rect = null;
    const snapped = grounding.snapToElement(target, tags.elementLabel, index);
    if (snapped) {
      target = grounding.pointForElement(snapped);
      rect = snapped.rect;
    }
    return { target, label: tags.elementLabel || null, bounds: cap.bounds, rect };
  }

  _runAgent(task, mode, desktop) {
    // Start after the short spoken intro (or after at most 2.5s) so the user is never kept waiting
    const idlePromise = this.d.speech.whenIdle();
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2500));
    Promise.race([idlePromise, timeoutPromise]).then(() => {
      this.d.agent
        .run({ name: task.slice(0, 48), task, mode, desktop })
        .then((r) => this.d.ui.notify(r.summary || 'Job finished', r.status === 'failed' ? 'error' : 'info'))
        .catch((e) => this.log.error('agent error', e));
    });
  }

  // runs a stored job / routine (no spoken intro)
  runJob(task, { name, mode = 'background', desktop = false } = {}) {
    return this.d.agent.run({ name: name || task.slice(0, 48), task, mode, desktop });
  }

  // ---------------------------------------------------------------- transient mode
  _scheduleTransientHide() {
    if (this.cursorEnabled || !this.d.ui.hasOverlay()) return;
    clearTimeout(this.transientTimer);
    const poll = async () => {
      if (this.d.speech.isSpeaking || this.pointingActive || this.voiceState !== 'idle') {
        this.transientTimer = setTimeout(poll, 200);
        return;
      }
      this.transientTimer = setTimeout(() => {
        if (this.cursorEnabled) return;
        this.d.ui.fadeOutOverlay();
        this._publishStatus();
      }, 1000);
    };
    this.transientTimer = setTimeout(poll, 200);
  }

  // ---------------------------------------------------------------- onboarding demo (40 s into the video)
  async performOnboardingDemo() {
    if (this.voiceState !== 'idle' && this.voiceState !== 'responding') return;
    try {
      const captures = await this.d.capture.captureAllScreens();
      const cap = captures.find((c) => c.isCursorScreen) || captures[0];
      const s = this.settings.all();
      const messages = [
        { role: 'system', content: buildOnboardingDemoPrompt({ coordinateSpace: s.coordinateSpace }) },
        { role: 'user', content: [{ type: 'text', text: cap.label }, imagePart(cap.jpeg), { type: 'text', text: 'look around my screen and find something interesting to point at' }] },
      ];
      const res = await this.d.groq.chat({ model: s.visionModel, messages, stream: false, reasoningEffort: 'none', maxTokens: 200, temperature: 0.8 });
      const tags = parseResponseTags(res.text);
      if (!tags.coordinate) return;
      const target = mapModelPointToGlobal(tags.coordinate, cap, s.coordinateSpace);
      this.d.ui.pointAt(target, tags.elementLabel, cap.bounds, tags.spokenText);
    } catch (e) {
      this.log.warn('onboarding demo failed', e && e.message);
    }
  }
}

module.exports = { CompanionManager, MAX_HISTORY, MAX_IMAGES };
