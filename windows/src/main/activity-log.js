'use strict';
/*
 * Activity log: one line for every action Sidekick takes (or is stopped from taking), shown on the Home screen.
 *
 *  - Stored as JSON lines in the app data folder (activity.jsonl), capped so it never grows without bound.
 *  - Summaries are written for humans and are REDACTED: typed / pasted / filled text is recorded as a length,
 *    never as the text itself (it could be a message or a password).
 */
const fs = require('fs');
const path = require('path');

const MAX_SUMMARY = 220;

// How each tool is shown and filtered. change = alters something, control = drives mouse / keyboard.
const TOOL_KIND = {
  folder_size: 'read', biggest_files: 'read', disk_space: 'read', file_counts: 'read', system_info: 'read', running_apps: 'read',
  find_files: 'read', list_files: 'read', read_file: 'read', list_moves: 'read', list_windows: 'read', list_elements: 'read', read_text: 'read',
  read_clipboard: 'read', screenshot: 'read', web_search: 'web', fetch_page: 'web', open_url: 'open', open_app: 'open', open_path: 'open',
  move_file: 'change', undo_move: 'change', save_file: 'change', write_clipboard: 'change', run_powershell: 'command', remember: 'change',
  click: 'control', double_click: 'control', right_click: 'control', move_mouse: 'control', drag: 'control', scroll: 'control',
  type_text: 'control', press_keys: 'control', click_element: 'control', focus_window: 'control', invoke_element: 'control', set_text: 'control',
  drag_element: 'control', paste_text: 'control', copy_selection: 'control', browser_action: 'control', window_action: 'control',
  point_at: 'show', draw: 'show', say: 'show', set_plan: 'show', finish: 'show', ask_user: 'ask', wait: 'show',
};

function oneLine(s, max = MAX_SUMMARY) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

// A readable, redacted sentence for a tool call.
function summarizeTool(name, a = {}) {
  const len = (v) => String(v == null ? '' : v).length;
  switch (name) {
    case 'type_text': return `typed ${len(a.text)} characters`;
    case 'paste_text': return `pasted ${len(a.text)} characters`;
    case 'set_text': return `filled the box "${oneLine(a.name, 50)}" (${len(a.text)} characters)`;
    case 'write_clipboard': return `put ${len(a.text)} characters on the clipboard`;
    case 'read_clipboard': return 'read the clipboard';
    case 'save_file': return `saved the file ${oneLine(a.name, 80)}`;
    case 'move_file': return `moved ${oneLine(baseName(a.from), 60)} to ${oneLine(a.to, 90)}`;
    case 'undo_move': return 'undid a file move';
    case 'read_file': return `read the file ${oneLine(a.path, 120)}`;
    case 'list_files': return `listed the folder ${oneLine(a.dir || 'Sidekick folder', 120)}`;
    case 'find_files': return `searched for files named "${oneLine(a.query, 60)}"`;
    case 'folder_size': return `measured the size of ${oneLine(a.path, 120)}`;
    case 'biggest_files': return `looked for the biggest files in ${oneLine(a.path, 120)}`;
    case 'file_counts': return `counted the files in ${oneLine(a.path, 120)}`;
    case 'disk_space': return a.path ? `checked free disk space on ${oneLine(a.path, 60)}` : 'checked free disk space';
    case 'system_info': return 'read the PC specs';
    case 'running_apps': return 'listed the running apps';
    case 'open_path': return `opened ${oneLine(a.path, 120)}`;
    case 'open_url': return `opened ${oneLine(a.url, 140)}`;
    case 'open_app': return `opened the app ${oneLine(a.name, 60)}`;
    case 'web_search': return `searched the web for "${oneLine(a.query, 80)}"`;
    case 'fetch_page': return `read the page ${oneLine(a.url, 140)}`;
    case 'run_powershell': return `ran a PowerShell command: ${oneLine(a.script, 120)}`;
    case 'press_keys': return `pressed ${oneLine(a.keys, 40)}`;
    case 'click': return `clicked at ${a.x},${a.y}`;
    case 'double_click': return `double-clicked at ${a.x},${a.y}`;
    case 'right_click': return `right-clicked at ${a.x},${a.y}`;
    case 'click_element': return `clicked "${oneLine(a.name, 60)}"`;
    case 'invoke_element': return `pressed "${oneLine(a.name, 60)}"`;
    case 'focus_window': return `switched to the window "${oneLine(a.title, 60)}"`;
    case 'window_action': return `${oneLine(a.action, 20)} the window "${oneLine(a.title, 60)}"`;
    case 'drag_element': return a.from_name ? `dragged "${oneLine(a.from_name, 40)}" onto "${oneLine(a.to_name, 40)}"` : 'dragged something';
    case 'browser_action': return `browser: ${oneLine(a.action, 20)}${a.action === 'fill' ? ' a form field' : a.value ? ' ' + oneLine(a.value, 80) : ''}`;
    case 'ask_user': return `asked you: ${oneLine(a.question, 140)}`;
    case 'remember': return 'saved something to memory';
    case 'finish': return `finished: ${oneLine(a.summary, 160)}`;
    case 'say': return 'said something out loud';
    case 'screenshot': return 'looked at the screen';
    default: return oneLine(String(name || 'action').replace(/_/g, ' '), 80);
  }
}

class ActivityLog {
  constructor({ file, max = 1500, keep = 1000, now = () => Date.now(), fsImpl = fs, onAdd = null } = {}) {
    this.file = file;
    this.max = max;
    this.keep = Math.min(keep, max);
    this.now = now;
    this.fs = fsImpl;
    this.onAdd = onAdd;
    this.count = null; // lines on disk, counted lazily
    this.seq = 0;
  }

  _count() {
    if (this.count !== null) return this.count;
    try {
      const txt = this.fs.readFileSync(this.file, 'utf8');
      this.count = txt ? txt.split('\n').filter(Boolean).length : 0;
    } catch (_) {
      this.count = 0;
    }
    return this.count;
  }

  // entry: { kind, source, tool, summary, ok, blocked, job }
  add(entry = {}) {
    const e = {
      id: this.now().toString(36) + '-' + (++this.seq).toString(36),
      at: this.now(),
      kind: String(entry.kind || TOOL_KIND[entry.tool] || 'other'),
      source: String(entry.source || 'agent'), // agent | quick | user | app
      tool: entry.tool ? String(entry.tool) : '',
      summary: oneLine(entry.summary || summarizeTool(entry.tool, entry.args || {})),
      ok: entry.ok !== false,
      blocked: !!entry.blocked,
      job: entry.job ? oneLine(entry.job, 60) : '',
      detail: entry.detail ? oneLine(entry.detail, 200) : '',
    };
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
      this.count = this._count() + 1;
      if (this.count > this.max) this._trim();
    } catch (_) {
      /* logging must never break the app */
    }
    if (this.onAdd) {
      try { this.onAdd(e); } catch (_) { /* ignore */ }
    }
    return e;
  }

  _trim() {
    try {
      const lines = this.fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-this.keep);
      const tmp = this.file + '.tmp';
      this.fs.writeFileSync(tmp, kept.join('\n') + '\n');
      this.fs.renameSync(tmp, this.file);
      this.count = kept.length;
    } catch (_) {
      /* ignore */
    }
  }

  // Newest first. filter: all | changes | blocked | reads
  recent({ limit = 200, filter = 'all' } = {}) {
    let lines = [];
    try {
      lines = this.fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    } catch (_) {
      return [];
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch (_) { continue; }
      if (filter === 'blocked' && !e.blocked) continue;
      if (filter === 'changes' && !['change', 'control', 'command', 'open'].includes(e.kind)) continue;
      if (filter === 'reads' && !['read', 'web'].includes(e.kind)) continue;
      out.push(e);
    }
    return out;
  }

  clear() {
    try { this.fs.writeFileSync(this.file, ''); } catch (_) { /* ignore */ }
    this.count = 0;
    return { ok: true };
  }
}

// One redacted line for a quick (no-AI) voice command. Typed text is only ever a length.
const QUICK_KIND = { time: 'show', date: 'show', stop: 'show', panel: 'open', volume: 'control', media: 'control', desktop: 'control', window: 'control', timer: 'change', type: 'control', url: 'open', open: 'open', folder: 'open' };
function summarizeQuick(intent = {}) {
  const k = intent.kind;
  let summary;
  switch (k) {
    case 'type': summary = `typed ${String(intent.text || '').length} characters`; break;
    case 'url': summary = `opened ${oneLine(intent.url, 80)}`; break;
    case 'open': summary = `opened ${oneLine(intent.target, 60)}`; break;
    case 'folder': summary = `opened the ${oneLine(intent.name, 30)} folder`; break;
    case 'volume': summary = intent.op === 'set' ? `set the volume to ${intent.percent}%` : `volume ${intent.op}`; break;
    case 'media': summary = `media key: ${intent.op}`; break;
    case 'window': summary = `window: ${String(intent.op || '').replace('_', ' ')}`; break;
    case 'timer': summary = intent.op === 'set' ? `started a timer for ${oneLine(intent.raw, 30)}` : `timer: ${intent.op}`; break;
    case 'desktop': summary = 'showed the desktop'; break;
    case 'panel': summary = 'opened the settings panel'; break;
    default: summary = `voice command: ${oneLine(k, 30)}`;
  }
  return { source: 'quick', kind: QUICK_KIND[k] || 'other', summary };
}

module.exports = { ActivityLog, summarizeTool, summarizeQuick, TOOL_KIND, oneLine };
