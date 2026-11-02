'use strict';
/*
 * Agent loop: Groq tool-calling that can see the screen and drive the PC.
 *
 * Groq has no native "computer use" API, so grounding is done here:
 *   - the model sees a labeled screenshot and answers in a 0..1000 grid
 *   - optional Windows UI Automation gives exact, named click targets
 *   - every desktop action goes through InputController (abortable by Escape /
 *     mouse movement / stop button) and the first one needs the user's approval.
 */
const { buildAgentSystemPrompt, AGENT_TOOL_NAMES } = require('./prompts');
const { imagePart } = require('./groq');
const { InputAbortedError } = require('./input');
const { mapModelPointToGlobal, globalToModelPoint, mapDrawToGlobal } = require('./screen-math');
const { findElement, describeElements } = require('./uia');
const browser = require('./browser');
const safety = require('./safety');

const READ_ONLY_DESKTOP = new Set(['screenshot', 'list_windows', 'wait', 'list_elements', 'read_text']);
const MAX_IMAGES_IN_CONTEXT = 2; // Groq allows 3 per request; keep one spare

// Tools that only READ and never touch shared state (no mouse, no keyboard, no job.elements / captures). When the
// model asks for several of these in one turn they run at the same time instead of one after another.
const PARALLEL_SAFE = new Set([
  'folder_size', 'biggest_files', 'file_counts', 'disk_space', 'system_info', 'running_apps', 'allowed_folders',
  'find_files', 'list_files', 'read_file', 'list_moves', 'web_search', 'fetch_page', 'read_clipboard', 'list_windows',
]);
const PARALLEL_LIMIT = 4; // disk walks are I/O heavy: a handful at a time keeps the PC responsive
// Not worth a line in the activity log (they change nothing and say nothing about what was done).
const NOT_LOGGED = new Set(['set_plan', 'wait']);

function fn(name, description, properties = {}, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}
const num = (d) => ({ type: 'number', description: d });
const str = (d) => ({ type: 'string', description: d });

function buildToolDefinitions({ desktopAllowed, powershellAllowed }) {
  const screenArg = { screen: num('screen number from the last screenshot, default is the cursor screen') };
  const xy = { x: num('x in the 0..1000 grid'), y: num('y in the 0..1000 grid'), ...screenArg };
  const tools = [];
  if (desktopAllowed) {
    tools.push(
      fn('screenshot', 'Look at the screen now. Always do this before acting and after actions that change the screen.', screenArg),
      fn('click', 'Left click at a point.', xy, ['x', 'y']),
      fn('double_click', 'Double click at a point.', xy, ['x', 'y']),
      fn('right_click', 'Right click at a point.', xy, ['x', 'y']),
      fn('move_mouse', 'Move the mouse to a point without clicking.', xy, ['x', 'y']),
      fn('drag', 'Drag from one point to another.', {
        x: num('start x'), y: num('start y'), to_x: num('end x'), to_y: num('end y'), ...screenArg,
      }, ['x', 'y', 'to_x', 'to_y']),
      fn('scroll', 'Scroll the mouse wheel at the current position. Positive = up, negative = down. Units are notches (3 is a small page).', {
        amount: num('notches, negative scrolls down'),
      }, ['amount']),
      fn('type_text', 'Type text into the focused control.', { text: str('text to type') }, ['text']),
      fn('press_keys', 'Press keys or shortcuts, for example "ctrl+l", "enter", "win", "alt+tab", "ctrl+shift+t". Several combos separated by comma are pressed in order.', {
        keys: str('key combos'),
      }, ['keys']),
      fn('click_element', 'Click a named control in the foreground window (exact, via UI Automation). Prefer this when a visible label exists.', {
        name: str('visible name of the control'),
      }, ['name']),
      fn('focus_window', 'Bring a window to the front by (part of) its title.', { title: str('window title or app name') }, ['title']),
      fn('list_windows', 'List open windows.'),
      fn('list_elements', 'List the named controls (buttons, menus, boxes, links) of the foreground window or of a window by title. Cheap: no image.', { window: str('optional window title') }),
      fn('invoke_element', 'Press a button, link, menu item, tab or checkbox by its visible name, without moving the mouse. Falls back to a real click.', { name: str('visible name of the control'), window: str('optional window title') }, ['name']),
      fn('set_text', 'Replace the text of a named text box (search bar, address bar, form field).', { name: str('visible name of the text box'), text: str('new text'), window: str('optional window title') }, ['name', 'text']),
      fn('drag_element', 'Drag one named control or item onto another named control (drag and drop), for example a file onto a folder. Or give coordinates.', {
        from_name: str('name of the thing to drag'), to_name: str('name of the drop target'), x: num('start x (grid), if no names'), y: num('start y'), to_x: num('end x'), to_y: num('end y'), ...screenArg,
      }),
      fn('paste_text', 'Paste text into the focused control through the clipboard. Better than type_text for long or unusual text.', { text: str('text to paste') }, ['text']),
      fn('copy_selection', 'Copy whatever the user has selected in the foreground app and return that text.'),
      fn('read_text', 'Read the text the user has selected, or the whole document, through Windows UI Automation TextPattern. Does not use the clipboard. Use mode "selection" for selected text and "window" for the visible document.', {
        mode: str('selection or window (default window)'), window: str('optional window title'), control: str('optional control name'),
      }),
      fn('browser_action', 'Browser-aware action in Chrome, Edge, Firefox, Brave, Opera or Vivaldi: list_tabs, switch_tab (value = tab name), new_tab, close_tab, address (value = http/https url), find (value = text), list_fields, fill (value = text, field = form field name), reload, back, forward.', {
        action: str('list_tabs|switch_tab|new_tab|close_tab|address|find|list_fields|fill|reload|back|forward'),
        value: str('tab name, URL, search text or value to type'),
        field: str('form field name for fill'),
      }, ['action']),
      fn('window_action', 'Minimize, maximize, restore or close a window found by (part of) its title, or snap it to the left or right half.', { title: str('window title or app name'), action: str('minimize|maximize|restore|close|snap_left|snap_right') }, ['title', 'action']),
      fn('wait', 'Wait for something to load.', { seconds: num('1 to 10') }, ['seconds'])
    );
  }
  tools.push(
    fn('open_url', 'Open a web page in the default browser.', { url: str('http or https url') }, ['url']),
    fn('open_app', 'Launch an installed application by name (for example notepad, calc, chrome).', { name: str('app name') }, ['name']),
    fn('open_path', 'Open a file or folder from an allowed folder with its normal app (documents, pictures, folders; never programs).', { path: str('full path') }, ['path']),
    fn('find_files', 'Find files or folders by name in the folders you may read. All words must match.', { query: str('words in the file name'), dir: str('optional folder to search in') }, ['query']),
    fn('folder_size', 'How big a folder is: total size, number of files and folders, and which sub-folders are biggest. Read-only, no clicking, never open Explorer for this. path = a full path or a name such as downloads, documents, desktop, pictures, or "D drive".', { path: str('folder path or name') }, ['path']),
    fn('biggest_files', 'The largest files inside a folder (and its sub-folders), biggest first. Read-only, no clicking.', { path: str('folder path or name'), count: num('how many, default 10, max 50') }, ['path']),
    fn('file_counts', 'How many files and folders are inside a folder, split by type (images, videos, documents, archives, programs ...). Read-only.', { path: str('folder path or name') }, ['path']),
    fn('disk_space', 'Free and total space on every drive, or on one drive. Read-only.', { drive: str('optional drive such as C: or D:') }),
    fn('system_info', 'This PC: Windows version, processor, memory, uptime. Read-only.'),
    fn('running_apps', 'What is running right now: open windows with their app and title, and the programs using the most memory. Read-only, never closes anything.'),
    fn('allowed_folders', 'Which folders you may read, and which of them you may also change (the user decides this in Home > Folders).'),
    fn('web_search', 'Search the web and get result titles, links and snippets.', { query: str('search query') }, ['query']),
    fn('fetch_page', 'Fetch a web page as plain text.', { url: str('http or https url') }, ['url']),
    fn('read_clipboard', 'Read the clipboard text.'),
    fn('write_clipboard', 'Put text on the clipboard.', { text: str('text') }, ['text']),
    fn('save_file', 'Save a text file into the Sidekick folder in Documents.', { name: str('file name'), content: str('file content') }, ['name', 'content']),
    fn('list_files', 'List files in a folder you may read (default: the Sidekick folder).', { dir: str('folder path') }),
    fn('read_file', 'Read a text file inside a folder you may read.', { path: str('file path') }, ['path']),
    fn('move_file', 'Move a file or folder to another folder. Both places must be folders you may change. It never overwrites and returns an undo id.', { from: str('source path'), to: str('destination folder or path') }, ['from', 'to']),
    fn('undo_move', 'Undo one of my file moves by id, or the most recent move.', { id: str('undo id, or last') }),
    fn('list_moves', 'List file moves that can still be undone.'),
    fn('set_plan', 'Show the user a short live plan in the notch HUD. Call once at the start of a multi-step job, then call again with an updated done count as steps finish. steps = 2-8 very short phrases.', {
      steps: { type: 'array', items: { type: 'string' }, description: 'short step labels' },
      done: num('how many steps are already finished (0 at the start)'),
    }, ['steps']),
    fn('point_at', 'Fly the blue cursor to a point on screen and show a short label, to show the user something.', {
      ...xy, label: str('1-3 word label'),
    }, ['x', 'y']),
    fn('draw', 'Draw on the screen with the glowing marker: circle, rect, arrow, line, underline, highlight, path, text, step.', {
      kind: str('circle|rect|arrow|line|underline|highlight|path|text|step'),
      numbers: str('comma separated numbers in the 0..1000 grid, like the DRAW tag'),
      label: str('optional label'),
      ...screenArg,
    }, ['kind', 'numbers']),
    fn('say', 'Say one short sentence out loud to the user (progress note).', { text: str('lowercase casual sentence') }, ['text']),
    fn('ask_user', 'Ask the user a question or for permission and wait for the answer. Use before anything risky.', { question: str('the question') }, ['question']),
    fn('remember', 'Remember a fact about the user for later.', { fact: str('short fact') }, ['fact']),
    fn('finish', 'Finish the job with a short spoken summary.', { summary: str('one or two lowercase sentences') }, ['summary'])
  );
  if (powershellAllowed) {
    tools.push(fn('run_powershell', 'Run a PowerShell command. The user must approve each command. Use only when nothing else works.', { script: str('powershell script') }, ['script']));
  }
  return tools;
}

function safeParse(json) {
  try {
    return JSON.parse(json || '{}');
  } catch (_) {
    return {};
  }
}

class AgentRunner {
  constructor(deps) {
    this.d = deps; // { groq, settings, capture, input, tools, uia, screenApi, ui, log }
    this.running = new Map();
  }

  listJobs() {
    return Array.from(this.running.values()).map((j) => this._publicJob(j));
  }

  _publicJob(j) {
    return {
      id: j.id, name: j.name, task: j.task, mode: j.mode, status: j.status, step: j.step, note: j.note,
      startedAt: j.startedAt, log: j.log.slice(-30),
      plan: Array.isArray(j.plan) ? j.plan.slice(0, 8) : [],
      planDone: Number(j.planDone) || 0,
    };
  }

  _update(job, patch) {
    Object.assign(job, patch);
    this.d.ui.jobUpdate(this._publicJob(job));
  }

  stopAll(reason = 'stopped by user') {
    for (const job of this.running.values()) this.stop(job.id, reason);
  }

  stop(id, reason = 'stopped by user') {
    const job = this.running.get(id);
    if (!job) return false;
    job.controller.abort();
    this.d.input.abort(reason);
    if (job.pending) {
      job.pending.resolve({ approved: false, answer: '' });
      job.pending = null;
    }
    return true;
  }

  // The job (if any) currently waiting for the user's answer.
  pendingJob() {
    for (const j of this.running.values()) if (j.pending) return j;
    return null;
  }

  // Resolve a pending approval / question from the UI.
  respond(id, payload) {
    const job = this.running.get(id);
    if (job && job.pending) {
      job.pending.resolve(payload);
      job.pending = null;
    }
  }

  _ask(job, kind, text) {
    return new Promise((resolve) => {
      job.pending = { resolve };
      this._update(job, { status: 'waiting', note: text, prompt: { kind, text } });
      this.d.ui.jobPrompt({ jobId: job.id, kind, text, name: job.name });
    }).then((r) => {
      this._update(job, { status: 'running', prompt: null });
      return r;
    });
  }

  async run({ name, task, mode = 'drive', desktop = true }) {
    const settings = this.d.settings.all();
    const job = {
      id: 'job-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name || task.slice(0, 40),
      task,
      mode,
      desktop: desktop && settings.agent.allowDrive,
      status: 'running',
      step: 0,
      note: 'starting',
      startedAt: Date.now(),
      log: [],
      plan: [],
      planDone: 0,
      controller: new AbortController(),
      pending: null,
      approvedDesktop: settings.agent.driveApproval === 'auto',
      captures: [],
      elements: [],
    };
    this.running.set(job.id, job);
    this._update(job, {});
    let summary = '';
    try {
      summary = await this._loop(job);
      this._update(job, { status: 'done', note: summary });
    } catch (e) {
      if (e instanceof InputAbortedError || job.controller.signal.aborted || (e && e.kind === 'aborted')) {
        this._update(job, { status: 'stopped', note: (e && e.reason) || 'stopped' });
        summary = 'okay, i stopped.';
      } else {
        this.d.log.error('agent failed', e);
        this._update(job, { status: 'failed', note: e.message || String(e) });
        summary = 'i got stuck: ' + (e.message || 'something went wrong');
      }
    } finally {
      if (this.d.input.driving) this.d.input.endDriving();
      this.d.ui.driveState(false);
      setTimeout(() => this.running.delete(job.id), 15000);
    }
    return { jobId: job.id, status: job.status, summary };
  }

  async _loop(job) {
    const { groq, settings: store } = this.d;
    const settings = store.all();
    const maxSteps = settings.agent.maxSteps || 60;
    const powershellAllowed = settings.agent.commandApproval !== 'never';
    const defs = buildToolDefinitions({ desktopAllowed: job.desktop, powershellAllowed });
    const messages = [
      {
        role: 'system',
        content: buildAgentSystemPrompt({
          jobName: job.name,
          jobMode: job.mode,
          coordinateSpace: settings.coordinateSpace,
          memoryFacts: settings.memory,
          desktopAllowed: job.desktop,
          userName: settings.userName,
        }),
      },
      { role: 'user', content: 'task: ' + job.task },
    ];
    let finished = null;
    for (let step = 1; step <= maxSteps && finished === null; step++) {
      this._throwIfStopped(job);
      this._update(job, { step, note: 'thinking' });
      const res = await groq.chat({
        model: settings.agentModel,
        messages,
        tools: defs,
        toolChoice: 'auto',
        stream: false,
        signal: job.controller.signal,
        reasoningEffort: settings.modelMode === 'deep' ? undefined : 'none',
        temperature: 0.3,
        maxTokens: 1500,
      });
      const calls = res.toolCalls || [];
      messages.push({ role: 'assistant', content: res.text || null, tool_calls: calls.length ? calls : undefined });
      if (!calls.length) {
        // The model answered in text without a tool call: treat as the final summary.
        finished = (res.text || 'done.').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || 'done.';
        break;
      }
      const pendingImages = [];
      const outcomes = await this._runCalls(job, calls, pendingImages);
      for (const o of outcomes) {
        if (o.name === 'finish') finished = String(o.args.summary || 'done.');
        messages.push({ role: 'tool', tool_call_id: o.call.id, content: JSON.stringify(o.result).slice(0, 6000) });
      }
      for (const img of pendingImages) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: img.text }, imagePart(img.jpeg)],
        });
      }
      this._trimImages(messages);
    }
    if (finished === null) finished = 'i hit my step limit before finishing.';
    this.d.ui.say(finished);
    return finished;
  }

  // Runs the calls of one model turn. A run of read-only tools goes in parallel (PARALLEL_LIMIT at a time); anything
  // that acts on the PC runs alone and in order, exactly as the model asked. Results come back in the original order.
  async _runCalls(job, calls, pendingImages) {
    const out = [];
    let i = 0;
    while (i < calls.length) {
      this._throwIfStopped(job);
      if (!PARALLEL_SAFE.has(calls[i].function.name)) {
        out.push(await this._runCall(job, calls[i], pendingImages));
        i++;
        continue;
      }
      let j = i;
      while (j < calls.length && PARALLEL_SAFE.has(calls[j].function.name)) j++;
      const run = calls.slice(i, j);
      for (let k = 0; k < run.length; k += PARALLEL_LIMIT) {
        const chunk = run.slice(k, k + PARALLEL_LIMIT);
        if (chunk.length > 1) this._update(job, { note: `checking ${chunk.length} things at once` });
        const settled = await Promise.allSettled(chunk.map((c) => this._runCall(job, c, pendingImages)));
        for (const s of settled) {
          if (s.status === 'rejected') throw s.reason; // only a stop / abort rejects
          out.push(s.value);
        }
      }
      i = j;
    }
    return out;
  }

  async _runCall(job, call, pendingImages) {
    this._throwIfStopped(job);
    const name = call.function.name;
    const args = safeParse(call.function.arguments);
    const text = this._describe(name, args);
    this._update(job, { note: text });
    job.log.push(text);
    let result;
    try {
      result = await this._exec(job, name, args, pendingImages);
    } catch (e) {
      if (e instanceof InputAbortedError || job.controller.signal.aborted) throw e;
      result = { ok: false, error: e.message || String(e) };
    }
    this._record(job, name, args, result);
    return { call, name, args, result };
  }

  // One line in the activity log for everything done (or refused). Typed text is never stored, only its length.
  _record(job, name, args, result) {
    const log = this.d.activity;
    if (!log || NOT_LOGGED.has(name)) return;
    const r = result || {};
    try {
      log.add({
        source: 'agent', tool: name, args, job: job.name,
        ok: r.ok !== false, blocked: !!r.blocked,
        detail: r.ok === false ? r.error : '',
      });
    } catch (_) { /* the log must never stop a job */ }
  }

  _throwIfStopped(job) {
    if (job.controller.signal.aborted) throw new InputAbortedError('stopped');
    this.d.input.throwIfAborted();
  }

  _trimImages(messages) {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && Array.isArray(m.content)) {
        seen++;
        if (seen > MAX_IMAGES_IN_CONTEXT) messages[i] = { role: 'user', content: '(older screenshot removed to save space)' };
      }
    }
  }

  _describe(name, a) {
    switch (name) {
      case 'click': case 'double_click': case 'right_click': case 'move_mouse': return `${name.replace('_', ' ')} at ${a.x},${a.y}`;
      case 'type_text': return `typing "${String(a.text || '').slice(0, 30)}"`;
      case 'press_keys': return `pressing ${a.keys}`;
      case 'click_element': return `clicking "${a.name}"`;
      case 'invoke_element': return `pressing "${a.name}"`;
      case 'set_text': return `filling "${a.name}"`;
      case 'drag_element': return a.from_name ? `dragging "${a.from_name}" to "${a.to_name}"` : 'dragging';
      case 'paste_text': return 'pasting text';
      case 'copy_selection': return 'copying the selection';
      case 'read_text': return a.mode === 'selection' ? 'reading the selected text' : 'reading the window';
      case 'browser_action': return `browser: ${String(a.action || '')}${a.value ? ' ' + String(a.value).slice(0, 40) : ''}`;
      case 'window_action': return `${a.action} ${a.title}`;
      case 'list_elements': return 'reading the controls';
      case 'read_file': return 'reading a file';
      case 'move_file': return `moving ${String(a.from || '').split(/[\\/]/).pop()} to ${a.to || 'a new place'}`;
      case 'undo_move': return 'undoing a file move';
      case 'list_moves': return 'checking undo history';
      case 'folder_size': return `measuring ${String(a.path || 'a folder').slice(0, 60)}`;
      case 'biggest_files': return `finding the biggest files in ${String(a.path || 'a folder').slice(0, 60)}`;
      case 'file_counts': return `counting files in ${String(a.path || 'a folder').slice(0, 60)}`;
      case 'disk_space': return 'checking disk space';
      case 'system_info': return 'reading the PC specs';
      case 'running_apps': return 'checking what is running';
      case 'allowed_folders': return 'checking which folders I may use';
      case 'set_plan': return 'showing the plan';
      case 'find_files': return `looking for "${a.query}"`;
      case 'open_path': return 'opening a file';
      case 'open_url': return `opening ${a.url}`;
      case 'open_app': return `opening ${a.name}`;
      case 'web_search': return `searching "${a.query}"`;
      case 'fetch_page': return `reading ${a.url}`;
      case 'say': return 'talking';
      case 'ask_user': return 'asking you';
      case 'screenshot': return 'looking at the screen';
      case 'finish': return 'finishing';
      default: return name.replace('_', ' ');
    }
  }

  // ---- safety helpers (see safety.js). Risky things ALWAYS ask, in every approval mode.
  _extraRisky() {
    const a = this.d.settings.get('agent') || {};
    return a.alwaysAsk || [];
  }

  _isRiskyName(name) {
    return safety.isRiskyName(name, this._extraRisky());
  }

  // Asks the user. Returns null when approved, or the error object to give back to the model.
  async _confirmRisk(job, text) {
    const r = await this._ask(job, 'approve-action', text);
    return r.approved ? null : { ok: false, blocked: true, error: 'The user declined this action.' };
  }

  // Title and app of the window in front (for the access rules). Cheap: title from user32, app name from a short cache.
  async _foreground() {
    const w32 = this.d.win32;
    if (!w32 || !w32.lib || typeof w32.getForegroundWindow !== 'function') return { title: '', app: '' };
    const hwnd = w32.getForegroundWindow();
    const title = (w32.lib.getWindowText && hwnd) ? w32.lib.getWindowText(hwnd) : '';
    let app = '';
    try {
      const now = Date.now();
      if (!this._winCache || now - this._winCache.at > 4000) this._winCache = { at: now, list: (await this.d.tools.listWindows()).windows || [] };
      const hit = this._winCache.list.find((x) => Number(x.id) === Number(hwnd)) || this._winCache.list.find((x) => title && x.title === title);
      if (hit) app = hit.app;
    } catch (_) { /* title alone is still checked */ }
    return { title, app };
  }

  // Applies the user's block/allow rules to whatever is in front (or to a named target window).
  async _accessError(job, target) {
    const a = this.d.settings.get('agent') || {};
    if (!(a.blockedApps && a.blockedApps.length) && a.accessMode !== 'allowlist') return null;
    const info = target || await this._foreground();
    const res = safety.checkAccess(a, info);
    return res.allowed ? null : { ok: false, error: res.reason };
  }

  // Name of the control under a global DIP point, from a fresh control list (so a coordinate click on
  // "Delete" is caught just like a named click).
  async _controlNameAt(job, point) {
    if (!this.d.uia || !this.d.settings.get('useAccessibilityGrounding')) return '';
    try {
      const els = (await this.d.uia.listForegroundElements()).elements || [];
      const sp = this.d.screenApi;
      const hits = els.map((e) => {
        const tl = sp.screenToDipPoint({ x: e.x, y: e.y });
        const br = sp.screenToDipPoint({ x: e.x + e.w, y: e.y + e.h });
        return { name: e.name, x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
      }).filter((r) => point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h);
      hits.sort((a, b) => a.w * a.h - b.w * b.h);
      const risky = hits.find((h) => this._isRiskyName(h.name));
      return risky ? risky.name : (hits[0] ? hits[0].name : '');
    } catch (_) {
      return '';
    }
  }

  // For focus_window / window_action: which window will be touched, for the access rules.
  async _targetWindowInfo(a) {
    try {
      const r = await this.d.tools.listWindows();
      const q = String(a.title || '').toLowerCase();
      const w = (r.windows || []).find((x) => (x.title + ' ' + x.app).toLowerCase().includes(q));
      return w ? { title: w.title, app: w.app } : { title: String(a.title || ''), app: '' };
    } catch (_) {
      return { title: String(a.title || ''), app: '' };
    }
  }

  // Messaging rule: in a chat app (Telegram, WhatsApp, Discord, Slack ...) I may open it and type a draft, but I
  // never send. This is a hard stop, not a question: even auto-approve mode cannot send a message for the user.
  // `target` is { title, app } of the window being acted on; without it the window in front is used.
  async _messagingBlock(job, target) {
    let info = target;
    if (!info || (!info.title && !info.app)) info = await this._foreground();
    if (!safety.isMessagingWindow(info)) return null;
    return { info, error: safety.MESSAGING_STOP };
  }

  async _ensureDesktopApproval(job) {
    if (job.approvedDesktop) return true;
    const r = await this._ask(job, 'approve-desktop', `Let Sidekick take over your mouse and keyboard to: ${job.task}? Press Esc or move the mouse any time to stop.`);
    job.approvedDesktop = !!r.approved;
    return job.approvedDesktop;
  }

  _captureFor(job, screenNumber) {
    const caps = job.captures;
    if (!caps.length) return null;
    if (screenNumber && caps[screenNumber - 1]) return caps[screenNumber - 1];
    return caps.find((c) => c.isCursorScreen) || caps[0];
  }

  _toGlobal(job, a) {
    const cap = this._captureFor(job, a.screen);
    if (!cap) throw new Error('Take a screenshot first.');
    return mapModelPointToGlobal({ x: Number(a.x), y: Number(a.y) }, cap, this.d.settings.get('coordinateSpace'));
  }

  async _takeScreenshot(job, a, pendingImages) {
    const captures = await this.d.capture.captureAllScreens();
    job.captures = captures;
    const space = this.d.settings.get('coordinateSpace');
    const cap = this._captureFor(job, a && a.screen);
    let text = `${cap.label}. coordinate space: ${space === 'normalized' ? '0..1000 grid on this image' : 'image pixels'}.`;
    let elements = [];
    if (this.d.settings.get('useAccessibilityGrounding') && this.d.uia) {
      try {
        const info = await this.d.uia.listForegroundElements();
        elements = info.elements;
        job.elements = elements;
        const mapped = (e) => {
          const tl = this.d.screenApi.screenToDipPoint({ x: e.x, y: e.y });
          const br = this.d.screenApi.screenToDipPoint({ x: e.x + e.w, y: e.y + e.h });
          const a1 = globalToModelPoint(tl, cap, space);
          const a2 = globalToModelPoint(br, cap, space);
          return { x: a1.x, y: a1.y, width: a2.x - a1.x, height: a2.y - a1.y };
        };
        if (elements.length) text += `\nforeground window: "${info.title}". named controls (name at center x,y):\n` + describeElements(elements, mapped);
      } catch (_) {
        /* grounding is optional */
      }
    }
    pendingImages.push({ jpeg: cap.jpeg, text });
    return { ok: true, note: 'screenshot attached in the next message', screens: captures.length, controls: elements.length };
  }

  async _startMenuSearch(job, name) {
    const { input, ui } = this.d;
    const started = !input.driving;
    if (started) {
      input.beginDriving();
      ui.driveState(true, 'Opening ' + name);
    }
    try {
      await input.pressKeys('win');
      await new Promise((r) => setTimeout(r, 450));
      await input.typeText(name);
      await new Promise((r) => setTimeout(r, 650));
      await input.pressKeys('enter');
      await new Promise((r) => setTimeout(r, 900));
      this.d.log.info('open_app via Start menu search', name);
      return { ok: true, opened: name, via: 'start-menu search' };
    } finally {
      if (started) {
        input.endDriving();
        ui.driveState(false);
      }
    }
  }

  async _exec(job, name, a, pendingImages) {
    const { input, tools, ui } = this.d;
    const desktopTools = AGENT_TOOL_NAMES.desktop;
    if (desktopTools.includes(name)) {
      if (!job.desktop) return { ok: false, error: 'Desktop control is turned off for this job.' };
      if (!READ_ONLY_DESKTOP.has(name)) {
        if (!(await this._ensureDesktopApproval(job))) throw new InputAbortedError('you declined computer control');
      }
      if (!READ_ONLY_DESKTOP.has(name)) {
        const blocked = await this._accessError(job, name === 'focus_window' || name === 'window_action' ? await this._targetWindowInfo(a) : null);
        if (blocked) return blocked;
      }
      if (!input.driving && !READ_ONLY_DESKTOP.has(name)) {
        input.beginDriving();
        ui.driveState(true, job.name);
      }
    }
    switch (name) {
      case 'screenshot':
        return this._takeScreenshot(job, a, pendingImages);
      case 'click':
      case 'double_click': {
        const at = this._toGlobal(job, a);
        const under = await this._controlNameAt(job, at);
        if (under && safety.isSendControl(under)) {
          const m = await this._messagingBlock(job);
          if (m) return { ok: false, blocked: true, error: m.error + ` (the control under the pointer is "${under}")` };
        }
        if (under && this._isRiskyName(under)) {
          const no = await this._confirmRisk(job, `Click "${under}"? This may send, delete, pay, close or change something that cannot be undone.`);
          if (no) return no;
        }
        await input.click(at, name === 'double_click' ? { count: 2 } : undefined);
        return { ok: true };
      }
      case 'right_click':
        await input.click(this._toGlobal(job, a), { button: 'right' });
        return { ok: true };
      case 'move_mouse':
        await input.moveTo(this._toGlobal(job, a));
        return { ok: true };
      case 'drag': {
        const from = this._toGlobal(job, a);
        const to = this._toGlobal(job, { x: a.to_x, y: a.to_y, screen: a.screen });
        const dropName = await this._controlNameAt(job, to);
        if (dropName && this._isRiskyName(dropName)) {
          const no = await this._confirmRisk(job, `Drop it onto "${dropName}"? That can delete or send it.`);
          if (no) return no;
        }
        await input.drag(from, to);
        return { ok: true };
      }
      case 'scroll':
        await input.scroll(Number(a.amount) || 0);
        return { ok: true };
      case 'type_text': {
        const text = String(a.text || '');
        if (safety.textWouldSend(text)) {
          const m = await this._messagingBlock(job);
          if (m) return { ok: false, blocked: true, error: m.error + ' A line break in the text would press Enter and send it. Type it as one line.' };
        }
        await input.typeText(text);
        return { ok: true };
      }
      case 'press_keys': {
        if (safety.keysWouldSend(a.keys)) {
          const m = await this._messagingBlock(job);
          if (m) return { ok: false, blocked: true, error: m.error };
        }
        if (safety.isRiskyKeys(a.keys)) {
          const no = await this._confirmRisk(job, `Press ${a.keys}? This can delete, close or send things and lose work.`);
          if (no) return no;
        }
        await input.pressKeys(String(a.keys || ''));
        return { ok: true };
      }
      case 'click_element': {
        let els = job.elements;
        if (!els.length && this.d.uia) els = (await this.d.uia.listForegroundElements()).elements;
        const el = findElement(els, a.name);
        if (!el) return { ok: false, error: 'No control with that name. Take a screenshot and use coordinates instead.' };
        if (safety.isSendControl(el.name) || safety.isSendControl(a.name)) {
          const m = await this._messagingBlock(job);
          if (m) return { ok: false, blocked: true, error: m.error + ` (control: "${el.name}")` };
        }
        if (this._isRiskyName(el.name)) {
          const no = await this._confirmRisk(job, `Click "${el.name}"? This may send, delete, pay, close or change something that cannot be undone.`);
          if (no) return no;
        }
        const dip = this.d.screenApi.screenToDipPoint({ x: el.x + el.w / 2, y: el.y + el.h / 2 });
        await input.click(dip);
        return { ok: true, clicked: el.name };
      }
      case 'list_elements': {
        if (!this.d.uia) return { ok: false, error: 'Control listing is not available.' };
        const info = await this.d.uia.listForegroundElements(a.window ? { windowTitle: String(a.window) } : undefined);
        job.elements = info.elements;
        return { ok: true, window: info.title, controls: info.elements.slice(0, 80).map((e) => `${e.type}: ${e.name}`.slice(0, 80)) };
      }
      case 'invoke_element':
      case 'set_text': {
        if (!this.d.uia || !this.d.uia.actOnElement) return { ok: false, error: 'Control actions are not available.' };
        const label = String(a.name || '');
        const windowTitle = a.window ? String(a.window) : '';
        if (windowTitle) {
          const blocked = await this._accessError(job, { title: windowTitle, app: '' });
          if (blocked) return blocked;
        }
        let exactName = label;
        if (name === 'set_text' && safety.textWouldSend(a.text)) {
          const m = await this._messagingBlock(job, windowTitle ? { title: windowTitle, app: '' } : null);
          if (m) return { ok: false, blocked: true, error: m.error + ' Fill the box with a single line.' };
        }
        if (name === 'invoke_element') {
          // Look first, act second. The script matches names loosely ("Continue" can find "Continue deleting"),
          // so the risk check must use the name of the control that was ACTUALLY found, not the label asked for.
          const peek = await this.d.uia.actOnElement({ name: label, action: 'find', windowTitle });
          if (!peek.found) return { ok: false, error: 'No control with that name. Use list_elements or a screenshot.' };
          exactName = peek.name || label;
          if (safety.isSendControl(label) || safety.isSendControl(exactName)) {
            const m = await this._messagingBlock(job, windowTitle ? { title: windowTitle, app: '' } : null);
            if (m) return { ok: false, blocked: true, error: m.error + ` (control: "${exactName}")` };
          }
          if (this._isRiskyName(label) || this._isRiskyName(exactName)) {
            const no = await this._confirmRisk(job, `Press "${exactName}"? This may send, delete, pay, close or change something that cannot be undone.`);
            if (no) return no;
          }
        }
        const res = await this.d.uia.actOnElement({ name: exactName, action: name === 'set_text' ? 'set_value' : 'invoke', value: name === 'set_text' ? String(a.text || '') : '', windowTitle });
        if (!res.found) return { ok: false, error: 'No control with that name. Use list_elements or a screenshot.' };
        if (res.done) return { ok: true, via: res.via, control: res.name };
        // no automation pattern: fall back to the real mouse on the control's rectangle
        const dip = this.d.screenApi.screenToDipPoint({ x: res.x + res.w / 2, y: res.y + res.h / 2 });
        await input.click(dip);
        if (name === 'set_text') {
          await input.pressKeys('ctrl+a');
          await tools.pasteText(String(a.text || ''), (k) => input.pressKeys(k));
        }
        return { ok: true, via: 'mouse', control: res.name };
      }
      case 'drag_element': {
        let from;
        let to;
        let dropName = '';
        if (a.from_name && a.to_name) {
          let els = job.elements;
          if (!els.length && this.d.uia) els = (await this.d.uia.listForegroundElements()).elements;
          const f = findElement(els, a.from_name);
          const t = findElement(els, a.to_name);
          if (!f || !t) return { ok: false, error: `Could not find ${!f ? '"' + a.from_name + '"' : '"' + a.to_name + '"'} in the foreground window.` };
          from = this.d.screenApi.screenToDipPoint({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
          to = this.d.screenApi.screenToDipPoint({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
          dropName = t.name;
        } else {
          from = this._toGlobal(job, a);
          to = this._toGlobal(job, { x: a.to_x, y: a.to_y, screen: a.screen });
          dropName = await this._controlNameAt(job, to);
        }
        if (dropName && this._isRiskyName(dropName)) {
          const no = await this._confirmRisk(job, `Drop it onto "${dropName}"? That can delete or send it.`);
          if (no) return no;
        }
        await input.drag(from, to);
        return { ok: true };
      }
      case 'paste_text': {
        // pasting keeps line breaks inside the box without pressing Enter, so it is safe in a chat app
        return tools.pasteText(String(a.text || ''), (k) => input.pressKeys(k));
      }
      case 'copy_selection':
        return tools.copySelection((k) => input.pressKeys(k));
      case 'read_text': {
        if (!tools.readText) return { ok: false, error: 'Reading UI text is not available.' };
        return tools.readText({ windowTitle: a.window ? String(a.window) : '', controlName: a.control ? String(a.control) : '', mode: a.mode === 'selection' ? 'selection' : 'window' });
      }
      case 'browser_action': {
        const action = browser.normalizeAction(a.action);
        if (!browser.BROWSER_ACTIONS.has(action)) return { ok: false, error: 'Unknown browser action.' };
        if (!this.d.uia) return { ok: false, error: 'Browser automation is not available.' };
        const info = await this.d.uia.listForegroundElements();
        if (!browser.isBrowserTitle(info.title)) return { ok: false, error: 'The window in front is not a supported browser.' };
        const els = info.elements || [];
        const value = a.value == null ? '' : String(a.value);
        const key = async (combo) => { await input.pressKeys(combo); return { ok: true, browser: info.title, action }; };
        switch (action) {
          case 'list_tabs':
            return { ok: true, browser: info.title, tabs: browser.tabsFrom(els) };
          case 'switch_tab': {
            const tab = findElement(browser.tabsFrom(els), value);
            if (!tab) return { ok: false, error: 'No tab with that name.' };
            const r = await this.d.uia.actOnElement({ name: tab.name, action: 'invoke' });
            if (r && r.found) return { ok: true, tab: r.name || tab.name };
            const dip = this.d.screenApi.screenToDipPoint({ x: tab.x + tab.w / 2, y: tab.y + tab.h / 2 });
            await input.click(dip);
            return { ok: true, tab: tab.name, via: 'mouse' };
          }
          case 'new_tab':
            return key('ctrl+t');
          case 'close_tab': {
            const yes = await this._ask(job, 'approve-action', 'Close the current browser tab? Unsaved form text in it may be lost.');
            if (!yes.approved) return { ok: false, error: 'The user declined to close the tab.' };
            return key('ctrl+w');
          }
          case 'address': {
            const url = browser.safeAddress(value);
            if (!url) return { ok: false, error: 'Give an http or https URL.' };
            await input.pressKeys('ctrl+l');
            await input.typeText(url);
            await input.pressKeys('enter');
            return { ok: true, browser: info.title, opened: url };
          }
          case 'find':
            if (!value) return { ok: false, error: 'Give text to find.' };
            await input.pressKeys('ctrl+f');
            await input.typeText(value);
            await input.pressKeys('enter');
            return { ok: true, found: value };
          case 'list_fields':
            return { ok: true, browser: info.title, fields: browser.formFieldsFrom(els) };
          case 'fill': {
            if (safety.textWouldSend(value) && safety.isMessagingWindow({ title: info.title, app: '' })) return { ok: false, blocked: true, error: safety.MESSAGING_STOP + ' Fill the box with a single line.' };
            const field = findElement(browser.formFieldsFrom(els), a.field || value);
            if (!field) return { ok: false, error: 'No form field with that name. Use list_fields first.' };
            const r = await this.d.uia.actOnElement({ name: field.name, action: 'set_value', value });
            if (r && r.found && r.done) return { ok: true, field: field.name, via: r.via || 'value' };
            const dip = this.d.screenApi.screenToDipPoint({ x: field.x + field.w / 2, y: field.y + field.h / 2 });
            await input.click(dip);
            await input.pressKeys('ctrl+a');
            await tools.pasteText(value, (k) => input.pressKeys(k));
            return { ok: true, field: field.name, via: 'mouse' };
          }
          case 'reload': return key('ctrl+r');
          case 'back': return key('alt+left');
          case 'forward': return key('alt+right');
          default: return { ok: false, error: 'Unknown browser action.' };
        }
      }
      case 'window_action': {
        const r = await tools.listWindows();
        const q = String(a.title || '').toLowerCase();
        const w = r.windows.find((x) => (x.title + ' ' + x.app).toLowerCase().includes(q));
        if (!w) return { ok: false, error: 'No window matches.' };
        const act = String(a.action || '');
        if (act === 'close') {
          const ok = await this._ask(job, 'approve-action', `Close the window "${w.title}"? Unsaved work in it may be lost.`);
          if (!ok.approved) return { ok: false, error: 'The user declined this action.' };
        }
        if (act === 'snap_left' || act === 'snap_right') {
          this.d.win32.focusWindow(w.id);
          await new Promise((r2) => setTimeout(r2, 250));
          await input.pressKeys(act === 'snap_left' ? 'win+left' : 'win+right');
          return { ok: true, snapped: w.title };
        }
        return tools.windowAction(w.id, act);
      }
      case 'open_path':
        return tools.openPath(String(a.path || ''));
      case 'find_files':
        return tools.findFiles(String(a.query || ''), a.dir ? String(a.dir) : '');
      case 'folder_size':
        return tools.folderSize(String(a.path || ''));
      case 'biggest_files':
        return tools.biggestFiles(String(a.path || ''), { count: a.count });
      case 'file_counts':
        return tools.fileCounts(String(a.path || ''));
      case 'disk_space':
        return tools.diskSpace(a.drive ? String(a.drive) : '');
      case 'system_info':
        return tools.systemInfo();
      case 'running_apps':
        return tools.runningApps();
      case 'allowed_folders':
        return tools.allowedFolders();
      case 'focus_window': {
        const r = await tools.listWindows();
        const q = String(a.title || '').toLowerCase();
        const w = r.windows.find((x) => (x.title + ' ' + x.app).toLowerCase().includes(q));
        if (!w) return { ok: false, error: 'No window matches.' };
        const ok = this.d.win32.focusWindow(w.id);
        await new Promise((r2) => setTimeout(r2, 300));
        return { ok, focused: w.title };
      }
      case 'list_windows':
        return tools.listWindows();
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.min(10, Math.max(0.5, Number(a.seconds) || 1)) * 1000));
        return { ok: true };
      case 'open_url':
        return tools.openUrl(String(a.url));
      case 'open_app': {
        const appName = String(a.name || '');
        if (safety.isBlockedLaunch(appName)) return { ok: false, error: 'I never start shells, installers or admin tools by name. Ask the user to open it themselves.' };
        if (!/^[\w .\-+()]{1,60}$/.test(appName)) return { ok: false, error: 'That app name looks unsafe.' };
        const blocked = await this._accessError(job, { title: appName, app: appName });
        if (blocked) return blocked;
        const direct = await tools.openApp(appName);
        if (direct.ok || !job.desktop) {
          if (job.desktop) await new Promise((r) => setTimeout(r, 600));
          return direct;
        }
        // Start > type the name > Enter, for apps whose executable name is not on PATH.
        const res = await this._startMenuSearch(job, appName);
        if (job.desktop) await new Promise((r) => setTimeout(r, 600));
        return res;
      }
      case 'web_search':
        return tools.webSearch(String(a.query));
      case 'fetch_page':
        return tools.fetchPage(String(a.url));
      case 'read_clipboard':
        return tools.readClipboard();
      case 'write_clipboard':
        return tools.writeClipboard(a.text);
      case 'save_file':
        return tools.saveFile(a.name, a.content);
      case 'list_files':
        return tools.listFiles(a.dir);
      case 'read_file':
        return tools.readFile(a.path);
      case 'move_file':
        return tools.moveFile(a.from, a.to);
      case 'undo_move':
        return tools.undoMove(a.id);
      case 'list_moves':
        return tools.listMoves();
      case 'set_plan': {
        const steps = (Array.isArray(a.steps) ? a.steps : []).map((s) => String(s || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8);
        if (!steps.length) return { ok: false, error: 'Give the plan as a list of short steps.' };
        const done = Math.max(0, Math.min(steps.length, Number(a.done) || 0));
        this._update(job, { plan: steps, planDone: done });
        return { ok: true, plan: steps, done };
      }
      case 'point_at': {
        if (!job.captures.length) job.captures = await this.d.capture.captureAllScreens();
        const g = this._toGlobal(job, a);
        ui.pointAt(g, a.label || '');
        return { ok: true };
      }
      case 'draw': {
        const nums = String(a.numbers || '').split(',').map(Number).filter(Number.isFinite);
        if (!job.captures.length) job.captures = await this.d.capture.captureAllScreens();
        const shape = mapDrawToGlobal({ kind: String(a.kind), nums, label: a.label || null, screen: a.screen || null }, job.captures, this.d.settings.get('coordinateSpace'));
        if (!shape) return { ok: false, error: 'Could not draw that shape.' };
        ui.drawShapes([shape]);
        return { ok: true };
      }
      case 'say':
        ui.say(String(a.text || ''));
        return { ok: true };
      case 'ask_user': {
        const r = await this._ask(job, 'question', String(a.question || ''));
        return { ok: true, answer: r.answer || (r.approved ? 'yes' : 'no') };
      }
      case 'remember': {
        const memory = this.d.settings.get('memory').slice();
        memory.push(String(a.fact));
        this.d.settings.set({ memory: memory.slice(-40) });
        return { ok: true };
      }
      case 'finish':
        return { ok: true };
      case 'run_powershell': {
        const r = await this._ask(job, 'approve-command', 'Run this PowerShell command?\n\n' + String(a.script).slice(0, 600));
        if (!r.approved) return { ok: false, error: 'The user declined this command.' };
        return tools.runPowerShell(a.script);
      }
      default:
        return { ok: false, error: 'Unknown tool ' + name };
    }
  }
}

module.exports = { AgentRunner, buildToolDefinitions };
