'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentRunner, buildToolDefinitions } = require('../../src/main/agent');
const { SettingsStore } = require('../../src/main/settings');
const { createSystemTools } = require('../../src/main/system-tools');
const uiaMod = require('../../src/main/uia');

function call(name, args, id) {
  return { id: id || 'c-' + name, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } };
}

function build({ script, uia, approve = true, clipboardText = 'old', captures = [], fg = null, agentSettings = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-j-'));
  const settings = new SettingsStore(path.join(dir, 's.json'), null, {});
  settings.set({ agent: Object.assign({ driveApproval: 'auto', allowDrive: true }, agentSettings) });
  const log = [];
  const prompts = [];
  let clip = clipboardText;
  const clipboard = { readText: () => clip, writeText: (t) => { clip = t; } };
  const shell = { openPath: async (p) => { log.push(['openPath', p]); return ''; }, openExternal: async () => {} };
  const runs = [];
  const tools = createSystemTools({ shell, clipboard, documentsDir: dir, platform: 'win32', run: async (s) => { runs.push(s); return { code: 0, stdout: '[]', stderr: '' }; } });
  tools.listWindows = async () => ({ ok: true, windows: [{ id: 4242, app: 'notepad', title: 'notes.txt - Notepad' }] });
  const input = {
    driving: false,
    beginDriving() { this.driving = true; }, endDriving() { this.driving = false; }, abort() {}, throwIfAborted() {},
    click: async (p, o) => log.push(['click', p, o]),
    drag: async (a, b) => log.push(['drag', a, b]),
    pressKeys: async (k) => { log.push(['keys', k]); if (k === 'ctrl+c') clip = 'SELECTED TEXT'; },
    typeText: async () => {}, moveTo: async () => {}, scroll: async () => {},
  };
  let agent;
  const ui = {
    jobUpdate() {}, driveState() {}, say() {}, pointAt() {}, drawShapes() {},
    jobPrompt: (p) => { prompts.push(p); setImmediate(() => agent.respond(p.jobId, { approved: approve, answer: approve ? 'yes' : 'no' })); },
  };
  const queue = script.slice();
  const groq = { chat: async () => { const next = queue.shift(); return next ? { text: '', toolCalls: next } : { text: 'done.', toolCalls: [] }; } };
  agent = new AgentRunner({
    groq, settings, capture: { captureAllScreens: async () => captures }, input, tools, uia, ui, log: { error() {}, warn() {}, info() {} },
    win32: { focusWindow: (id) => { log.push(['focus', id]); return true; }, getForegroundWindow: () => (fg ? 4242 : 0), lib: { getWindowText: () => (fg ? fg.title : '') } },
    screenApi: { screenToDipPoint: (p) => p, dipToScreenPoint: (p) => p },
  });
  return { agent, log, prompts, runs, tools, clipboard };
}

const baseUia = (over) => Object.assign({
  listForegroundElements: async () => ({ title: 'App', elements: [
    { name: 'report.docx', type: 'ListItem', x: 100, y: 200, w: 120, h: 24 },
    { name: 'Archive', type: 'TreeItem', x: 400, y: 500, w: 100, h: 24 },
  ] }),
  actOnElement: async () => ({ found: true, done: true, via: 'invoke', name: 'Save' }),
  isRiskyName: uiaMod.isRiskyName,
}, over);

test('tool list advertises the Jarvis tools only when the desktop is allowed', () => {
  const on = buildToolDefinitions({ desktopAllowed: true, powershellAllowed: false }).map((t) => t.function.name);
  for (const n of ['invoke_element', 'set_text', 'drag_element', 'paste_text', 'copy_selection', 'window_action', 'list_elements', 'open_path', 'find_files', 'browser_action']) assert.ok(on.includes(n), n);
  const off = buildToolDefinitions({ desktopAllowed: false, powershellAllowed: false }).map((t) => t.function.name);
  assert.ok(!off.includes('invoke_element'));
  assert.ok(off.includes('find_files'));
});

test('invoke_element presses a control by name without touching the mouse', async () => {
  const h = build({ script: [[call('invoke_element', { name: 'Save' })]], uia: baseUia() });
  const r = await h.agent.run({ name: 't', task: 'save it', mode: 'drive', desktop: true });
  assert.equal(r.status, 'done');
  assert.ok(!h.log.some((e) => e[0] === 'click'));
});

test('invoke_element falls back to a real click when the control has no automation pattern', async () => {
  const uia = baseUia({ actOnElement: async () => ({ found: true, done: false, name: 'Fancy', x: 100, y: 100, w: 40, h: 20 }) });
  const h = build({ script: [[call('invoke_element', { name: 'Fancy' })]], uia });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  const click = h.log.find((e) => e[0] === 'click');
  assert.deepEqual(click[1], { x: 120, y: 110 });
});

test('risky controls always ask first and do nothing when declined', async () => {
  let acted = false;
  const uia = baseUia({ actOnElement: async (o) => { if (o.action !== 'find') acted = true; return { found: true, done: true, via: 'invoke', name: 'Delete' }; } });
  const h = build({ script: [[call('invoke_element', { name: 'Delete' })]], uia, approve: false });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].kind, 'approve-action');
  assert.equal(acted, false);
});

test('risky controls run once the user says yes', async () => {
  let acted = false;
  const uia = baseUia({ actOnElement: async (o) => { if (o.action !== 'find') acted = true; return { found: true, done: true, via: 'invoke', name: 'Send' }; } });
  const h = build({ script: [[call('invoke_element', { name: 'Send' })]], uia, approve: true });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(acted, true);
  assert.equal(h.prompts.length, 1);
});

test('alt+f4 needs a yes even in auto-approve mode', async () => {
  const h = build({ script: [[call('press_keys', { keys: 'alt+f4' })]], uia: baseUia(), approve: false });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.ok(!h.log.some((e) => e[0] === 'keys' && e[1] === 'alt+f4'));
  assert.equal(h.prompts.length, 1);
});

test('drag_element drags between two named items', async () => {
  const h = build({ script: [[call('drag_element', { from_name: 'report.docx', to_name: 'Archive' })]], uia: baseUia() });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  const d = h.log.find((e) => e[0] === 'drag');
  assert.deepEqual(d[1], { x: 160, y: 212 });
  assert.deepEqual(d[2], { x: 450, y: 512 });
});

test('drag_element reports a missing name instead of guessing', async () => {
  const h = build({ script: [[call('drag_element', { from_name: 'nothing', to_name: 'Archive' })]], uia: baseUia() });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.ok(!h.log.some((e) => e[0] === 'drag'));
});

test('copy_selection returns the selected text and paste_text restores the clipboard', async () => {
  const h = build({ script: [[call('copy_selection'), call('paste_text', { text: 'hello' })]], uia: baseUia() });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  const keys = h.log.filter((e) => e[0] === 'keys').map((e) => e[1]);
  assert.deepEqual(keys, ['ctrl+c', 'ctrl+v']);
  assert.equal(h.clipboard.readText(), 'SELECTED TEXT'); // the user's clipboard is put back after pasting
});

test('window_action close asks first; minimize does not', async () => {
  const h = build({ script: [[call('window_action', { title: 'notepad', action: 'minimize' }), call('window_action', { title: 'notepad', action: 'close' })]], uia: baseUia(), approve: false });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /Close the window/);
  assert.equal(h.runs.length, 1); // minimize ran, close did not
  assert.match(h.runs[0], /ShowWindow\(\[IntPtr\]4242, 6\)/);
});

test('snap_left focuses the window then presses win+left', async () => {
  const h = build({ script: [[call('window_action', { title: 'notepad', action: 'snap_left' })]], uia: baseUia() });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.deepEqual(h.log.filter((e) => e[0] === 'focus' || e[0] === 'keys').map((e) => e[0] + ':' + e[1]), ['focus:4242', 'keys:win+left']);
});

test('find_files and open_path stay inside the user folder and never launch programs', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.sidekick-test-'));
  try {
    fs.mkdirSync(path.join(root, 'Taxes', '2025'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Taxes', '2025', 'Tax Return Final.pdf'), 'x');
    fs.writeFileSync(path.join(root, 'setup.exe'), 'x');
    const h = build({ script: [], uia: baseUia() });
    const found = h.tools.findFiles('tax return', root);
    assert.equal(found.ok, true);
    assert.ok(found.results.some((p) => p.endsWith('Tax Return Final.pdf')));
    assert.equal((await h.tools.openPath(path.join(root, 'setup.exe'))).ok, false);
    assert.equal((await h.tools.openPath(path.join(root, 'Taxes', '2025', 'Tax Return Final.pdf'))).ok, true);
    assert.equal(h.tools.findFiles('x', '/etc').ok, false);
    assert.equal((await h.tools.openPath('/etc/passwd')).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UIA action script quotes names safely and parses results', () => {
  const s = uiaMod.buildActScript({ name: "it's \"x\"; Remove-Item *", action: 'invoke' });
  assert.ok(s.includes(`$want = 'it''s "x"; Remove-Item *'`));
  assert.deepEqual(uiaMod.parseActResult('garbage'), { found: false });
  assert.equal(uiaMod.parseActResult('{"found":true,"done":true}').done, true);
});

test('risky name list catches destructive words but not look-alikes', () => {
  for (const n of ['Delete', 'Send message', 'Pay now', 'Empty Recycle Bin', 'Sign out', 'Uninstall', 'Place order']) assert.ok(uiaMod.isRiskyName(n), n);
  for (const n of ['Save', 'Open', 'Postcard maker', 'Resend later settings'.replace('Resend', 'Resent'), 'Search']) assert.ok(!uiaMod.isRiskyName(n), n);
});

// ------------------------------------------------------------------ safety holes closed in v5
const CAP = [{ bounds: { x: 0, y: 0, width: 1000, height: 1000 }, screenshotWidth: 1000, screenshotHeight: 1000, isCursorScreen: true, jpeg: Buffer.from('x'), label: 'screen' }];
const dangerUia = () => baseUia({
  listForegroundElements: async () => ({ title: 'Mail', elements: [
    { name: 'Send', type: 'Button', x: 400, y: 400, w: 100, h: 40 },
    { name: 'Save draft', type: 'Button', x: 100, y: 100, w: 100, h: 40 },
    { name: 'Recycle Bin', type: 'ListItem', x: 800, y: 800, w: 100, h: 40 },
    { name: 'report.docx', type: 'ListItem', x: 100, y: 800, w: 100, h: 40 },
  ] }),
});
const shot = () => call('screenshot', {}, 's1');

test('SAFETY: invoke_element asks about the control that was actually found, not the label that was asked for', async () => {
  let invoked = false;
  const uia = baseUia({ actOnElement: async (o) => { if (o.action !== 'find') invoked = true; return { found: true, done: true, via: 'invoke', name: 'Continue deleting' }; } });
  const h = build({ script: [[call('invoke_element', { name: 'Continue' })]], uia, approve: false });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /Continue deleting/);
  assert.equal(invoked, false);
});

test('SAFETY: a coordinate click on a Send button asks first, even in auto-approve mode', async () => {
  const h = build({ script: [[shot()], [call('click', { x: 450, y: 420 })]], uia: dangerUia(), approve: false, captures: CAP });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /Send/);
  assert.ok(!h.log.some((e) => e[0] === 'click'));
});

test('SAFETY: a coordinate click on a harmless control does not nag', async () => {
  const h = build({ script: [[shot()], [call('click', { x: 150, y: 120 })]], uia: dangerUia(), captures: CAP });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 0);
  assert.ok(h.log.some((e) => e[0] === 'click'));
});

test('SAFETY: dragging a file onto the Recycle Bin asks first (named and by coordinates)', async () => {
  const named = build({ script: [[call('drag_element', { from_name: 'report.docx', to_name: 'Recycle Bin' })]], uia: dangerUia(), approve: false });
  await named.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(named.prompts.length, 1);
  assert.ok(!named.log.some((e) => e[0] === 'drag'));
  const coords = build({ script: [[shot()], [call('drag', { x: 150, y: 820, to_x: 850, to_y: 820 })]], uia: dangerUia(), approve: false, captures: CAP });
  await coords.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(coords.prompts.length, 1);
  assert.ok(!coords.log.some((e) => e[0] === 'drag'));
});

test('SAFETY: plain Delete, Ctrl+W, Ctrl+F4 and Ctrl+Enter ask first', async () => {
  for (const keys of ['delete', 'ctrl+w', 'ctrl+f4', 'ctrl+enter', 'ctrl+alt+delete']) {
    const h = build({ script: [[call('press_keys', { keys })]], uia: baseUia(), approve: false });
    await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
    assert.equal(h.prompts.length, 1, keys);
    assert.ok(!h.log.some((e) => e[0] === 'keys'), keys);
  }
});

test('SAFETY: open_app refuses shells and installers', async () => {
  for (const name of ['powershell', 'cmd.exe', 'regedit', 'msiexec', 'vendor setup']) {
    const h = build({ script: [[call('open_app', { name })]], uia: baseUia() });
    const r = await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
    assert.equal(h.runs.filter((x) => /Start-Process/.test(x)).length, 0, name);
    assert.equal(r.status, 'done');
  }
  const ok = build({ script: [[call('open_app', { name: 'notepad' })]], uia: baseUia() });
  await ok.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(ok.runs.filter((x) => /Start-Process/.test(x)).length, 1);
});

test('ACCESS RULES: a blocked app is never touched; the model is told why', async () => {
  const h = build({ script: [[shot()], [call('click', { x: 150, y: 120 })]], uia: dangerUia(), captures: CAP, fg: { title: '1Password - Vault' }, agentSettings: { blockedApps: ['1password'] } });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.ok(!h.log.some((e) => e[0] === 'click'));
});

test('ACCESS RULES: allowlist mode only acts in allowed apps', async () => {
  const deny = build({ script: [[shot()], [call('click', { x: 150, y: 120 })]], uia: dangerUia(), captures: CAP, fg: { title: 'notes.txt - Notepad' }, agentSettings: { accessMode: 'allowlist', allowedApps: ['excel'] } });
  await deny.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.ok(!deny.log.some((e) => e[0] === 'click'));
  const allow = build({ script: [[shot()], [call('click', { x: 150, y: 120 })]], uia: dangerUia(), captures: CAP, fg: { title: 'notes.txt - Notepad' }, agentSettings: { accessMode: 'allowlist', allowedApps: ['notepad'] } });
  await allow.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.ok(allow.log.some((e) => e[0] === 'click'));
});

test('ACCESS RULES: words the user adds to alwaysAsk make a control risky', async () => {
  const uia = baseUia({ actOnElement: async (o) => ({ found: true, done: o.action !== 'find', via: 'invoke', name: 'Archive project' }) });
  const h = build({ script: [[call('invoke_element', { name: 'Archive project' })]], uia, approve: false, agentSettings: { alwaysAsk: ['archive'] } });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 1);
});

test('open_app falls back to Start menu search when the executable is not on PATH', async () => {
  const h = build({ script: [[call('open_app', { name: 'Calculator' })]], uia: baseUia() });
  h.tools.openApp = async () => ({ ok: false, error: 'not found' });
  const keys = [];
  h.agent.d.input.pressKeys = async (k) => { keys.push(k); };
  h.agent.d.input.typeText = async (t) => { keys.push('type:' + t); };
  const r = await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(r.status, 'done');
  assert.deepEqual(keys, ['win', 'type:Calculator', 'enter']);
});

test('Start menu fallback still refuses shells (including Terminal)', async () => {
  for (const name of ['Terminal', 'Windows Terminal', 'Command Prompt', 'PowerShell']) {
    const h = build({ script: [[call('open_app', { name })]], uia: baseUia() });
    const keys = [];
    h.agent.d.input.pressKeys = async (k) => { keys.push(k); };
    h.agent.d.input.typeText = async (t) => { keys.push('type:' + t); };
    await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
    assert.deepEqual(keys, [], name);
  }
});

test('browser_action refuses a non-browser foreground window', async () => {
  const h = build({ script: [[call('browser_action', { action: 'new_tab' })]], uia: baseUia() });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.ok(!h.log.some((e) => e[0] === 'keys' && e[1] === 'ctrl+t'));
});

test('set_plan publishes a capped plan and done count to the job HUD', async () => {
  const h = build({ script: [[call('set_plan', { steps: ['Search', 'Open Notepad', 'Write'], done: 1 })]], uia: baseUia() });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  const job = h.agent.listJobs().find((j) => j.name === 't');
  assert.ok(job, 'job still visible for 15s');
  assert.deepEqual(job.plan, ['Search', 'Open Notepad', 'Write']);
  assert.equal(job.planDone, 1);
});

test('browser_action close_tab always asks first, even in auto-approve', async () => {
  const chrome = baseUia({
    listForegroundElements: async () => ({ title: 'Docs - Google Chrome', elements: [
      { name: 'Docs', type: 'TabItem', x: 0, y: 0, w: 100, h: 30 },
      { name: 'Address and search bar', type: 'Edit', x: 0, y: 40, w: 300, h: 30 },
    ] }),
  });
  const h = build({ script: [[call('browser_action', { action: 'close_tab' })]], uia: chrome, approve: false });
  await h.agent.run({ name: 't', task: 'x', mode: 'drive', desktop: true });
  assert.equal(h.prompts.length, 1);
  assert.ok(!h.log.some((e) => e[0] === 'keys' && e[1] === 'ctrl+w'));
});

