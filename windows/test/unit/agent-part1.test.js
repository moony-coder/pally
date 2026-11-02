'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentRunner, buildToolDefinitions } = require('../../src/main/agent');
const { SettingsStore } = require('../../src/main/settings');
const { createSystemTools } = require('../../src/main/system-tools');
const { ActivityLog } = require('../../src/main/activity-log');

const call = (name, args, id) => ({ id: id || 'c-' + name + '-' + Math.random().toString(36).slice(2, 6), type: 'function', function: { name, arguments: JSON.stringify(args || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function build({ script, fg = null, approve = true, uia = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-p1-'));
  const settings = new SettingsStore(path.join(dir, 's.json'), null, {});
  settings.set({ agent: { driveApproval: 'auto', allowDrive: true } });
  const events = [];
  const prompts = [];
  const tools = createSystemTools({ shell: { openPath: async () => '', openExternal: async () => {} }, clipboard: { readText: () => '', writeText: () => {} }, documentsDir: dir, platform: 'win32', run: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
  tools.listWindows = async () => ({ ok: true, windows: fg ? [{ id: 4242, app: fg.app, title: fg.title }] : [] });
  tools.pasteText = async (t) => { events.push(['paste', t]); return { ok: true }; };
  const input = {
    driving: false, beginDriving() {}, endDriving() {}, abort() {}, throwIfAborted() {},
    click: async (p) => events.push(['click', p]),
    drag: async () => {}, moveTo: async () => {}, scroll: async () => {},
    pressKeys: async (k) => events.push(['keys', k]),
    typeText: async (t) => events.push(['type', t]),
  };
  let agent;
  const ui = {
    jobUpdate() {}, driveState() {}, say() {}, pointAt() {}, drawShapes() {},
    jobPrompt: (p) => { prompts.push(p); setImmediate(() => agent.respond(p.jobId, { approved: approve, answer: approve ? 'yes' : 'no' })); },
  };
  const queue = script.slice();
  const groq = { chat: async () => { const next = queue.shift(); return next ? { text: '', toolCalls: next } : { text: 'done.', toolCalls: [] }; } };
  const activity = new ActivityLog({ file: path.join(dir, 'activity.jsonl') });
  agent = new AgentRunner({
    groq, settings, capture: { captureAllScreens: async () => [] }, input, tools, uia, ui, activity,
    log: { error() {}, warn() {}, info() {} },
    win32: { focusWindow: () => true, getForegroundWindow: () => (fg ? 4242 : 0), lib: { getWindowText: () => (fg ? fg.title : '') } },
    screenApi: { screenToDipPoint: (p) => p, dipToScreenPoint: (p) => p },
  });
  return { agent, events, prompts, tools, activity };
}

const run = (h, task = 't') => h.agent.run({ name: 't', task, mode: 'drive', desktop: true });

test('the new read-only tools are advertised even when the desktop is off', () => {
  const names = buildToolDefinitions({ desktopAllowed: false, powershellAllowed: false }).map((t) => t.function.name);
  for (const n of ['folder_size', 'biggest_files', 'file_counts', 'disk_space', 'system_info', 'running_apps', 'allowed_folders']) assert.ok(names.includes(n), n);
});

test('read-only tools asked for in one turn run at the same time, and results keep their order', async () => {
  const h = build({ script: [[call('folder_size', { path: 'C:\\a' }, 'k1'), call('disk_space', {}, 'k2'), call('system_info', {}, 'k3')]] });
  let active = 0;
  let peak = 0;
  const slow = (value, ms) => async () => { active++; peak = Math.max(peak, active); await sleep(ms); active--; return value; };
  h.tools.folderSize = slow({ ok: true, tag: 'size' }, 60);
  h.tools.diskSpace = slow({ ok: true, tag: 'space' }, 20);
  h.tools.systemInfo = slow({ ok: true, tag: 'info' }, 40);
  const r = await run(h);
  assert.equal(r.status, 'done');
  assert.equal(peak, 3, 'all three should overlap');
});

test('tool results are sent back in the order the model asked, even if a later one finishes first', async () => {
  const seen = [];
  const h = build({ script: [[call('folder_size', { path: 'C:\\a' }, 'k1'), call('disk_space', {}, 'k2')]] });
  h.tools.folderSize = async () => { await sleep(50); return { ok: true, tag: 'size' }; };
  h.tools.diskSpace = async () => ({ ok: true, tag: 'space' });
  // wrap groq to capture the messages of the second turn
  const orig = h.agent.d.groq.chat;
  let turn = 0;
  h.agent.d.groq.chat = async (opts) => { turn++; if (turn === 2) seen.push(...opts.messages.filter((m) => m.role === 'tool')); return orig(opts); };
  await run(h);
  assert.deepEqual(seen.map((m) => m.tool_call_id), ['k1', 'k2']);
  assert.match(seen[0].content, /size/);
  assert.match(seen[1].content, /space/);
});

test('no more than four read-only tools run at once', async () => {
  const calls = Array.from({ length: 7 }, (_, i) => call('folder_size', { path: 'C:\\x' + i }, 'k' + i));
  const h = build({ script: [calls] });
  let active = 0;
  let peak = 0;
  h.tools.folderSize = async () => { active++; peak = Math.max(peak, active); await sleep(15); active--; return { ok: true }; };
  await run(h);
  assert.ok(peak <= 4 && peak >= 2, 'peak was ' + peak);
});

test('a read-only tool that fails does not stop the others', async () => {
  const h = build({ script: [[call('folder_size', { path: 'C:\\a' }), call('disk_space', {})]] });
  h.tools.folderSize = async () => { throw new Error('boom'); };
  h.tools.diskSpace = async () => ({ ok: true });
  const r = await run(h);
  assert.equal(r.status, 'done');
  assert.ok(h.activity.recent().some((e) => e.tool === 'disk_space' && e.ok));
  assert.ok(h.activity.recent().some((e) => e.tool === 'folder_size' && !e.ok));
});

test('tools that act on the PC stay in order and never overlap', async () => {
  const h = build({ script: [[call('press_keys', { keys: 'ctrl+l' }), call('folder_size', { path: 'C:\\a' }), call('press_keys', { keys: 'ctrl+t' })]] });
  h.tools.folderSize = async () => { h.events.push(['size']); return { ok: true }; };
  await run(h);
  assert.deepEqual(h.events.map((e) => e[0] + (e[1] || '')), ['keysctrl+l', 'size', 'keysctrl+t']);
});

test('every action lands in the activity log, typed text only as a length', async () => {
  const h = build({ script: [[call('type_text', { text: 'secret-pin-4821' }), call('folder_size', { path: 'C:\\a' })]] , fg: { app: 'notepad', title: 'Untitled - Notepad' } });
  h.tools.folderSize = async () => ({ ok: true });
  await run(h);
  const log = h.activity.recent();
  assert.ok(log.some((e) => e.tool === 'type_text' && /15 characters/.test(e.summary)));
  assert.ok(!JSON.stringify(log).includes('4821'));
  assert.ok(log.some((e) => e.tool === 'folder_size'));
});

// ---- messaging rule
const TG = { app: 'Telegram', title: 'Telegram' };

test('in Telegram: typing a draft is allowed, pressing Enter is not', async () => {
  const h = build({ fg: TG, script: [[call('type_text', { text: 'hi, running late' }), call('press_keys', { keys: 'enter' })]] });
  await run(h);
  assert.deepEqual(h.events, [['type', 'hi, running late']]);
  const blocked = h.activity.recent({ filter: 'blocked' });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].tool, 'press_keys');
});

test('in Telegram: Ctrl+Enter, a trailing line break and a Send click are all stopped, even with auto approval', async () => {
  const uia = {
    listForegroundElements: async () => ({ title: 'Telegram', elements: [{ name: 'Send', type: 'Button', x: 100, y: 100, w: 40, h: 20 }] }),
    actOnElement: async (o) => { if (o.action !== 'find') h.events.push(['invoked']); return { found: true, done: true, via: 'invoke', name: 'Send' }; },
    isRiskyName: () => false,
  };
  const h = build({ fg: TG, uia, script: [[
    call('press_keys', { keys: 'ctrl+enter' }), call('type_text', { text: 'hello\n' }), call('click_element', { name: 'Send' }), call('invoke_element', { name: 'Send message' }),
  ]] });
  await run(h);
  assert.equal(h.events.length, 0, JSON.stringify(h.events));
  assert.equal(h.activity.recent({ filter: 'blocked' }).length, 4);
  assert.equal(h.prompts.length, 0, 'it is a hard stop, not a question');
});

test('in Telegram: pasting a draft and a new line with Shift+Enter are fine', async () => {
  const h = build({ fg: TG, script: [[call('paste_text', { text: 'line one\nline two' }), call('press_keys', { keys: 'shift+enter' })]] });
  await run(h);
  assert.deepEqual(h.events.map((e) => e[0]), ['paste', 'keys']);
  assert.equal(h.activity.recent({ filter: 'blocked' }).length, 0);
});

test('outside chat apps Enter still works as before', async () => {
  const h = build({ fg: { app: 'notepad', title: 'notes.txt - Notepad' }, script: [[call('press_keys', { keys: 'enter' }), call('type_text', { text: 'a\nb' })]] });
  await run(h);
  assert.deepEqual(h.events.map((e) => e[0]), ['keys', 'type']);
});

test('a chat app opened in a browser tab is protected too', async () => {
  const h = build({ fg: { app: 'chrome', title: 'WhatsApp Web - Google Chrome' }, script: [[call('press_keys', { keys: 'enter' })]] });
  await run(h);
  assert.equal(h.events.length, 0);
});
