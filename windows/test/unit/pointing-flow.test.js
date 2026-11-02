'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CompanionManager } = require('../../src/main/companion');
const { SettingsStore } = require('../../src/main/settings');
const { SpeechQueue } = require('../../src/main/tts');

// Physical pixels == DIP here (scale 1) so the numbers stay readable.
const ELEMENTS = [
  { name: 'File', type: 'MenuItem', x: 20, y: 10, w: 40, h: 24 },
  { name: 'Save', type: 'Button', x: 400, y: 300, w: 80, h: 30 },
  { name: 'Share', type: 'Button', x: 900, y: 12, w: 70, h: 28 },
  { name: 'Undo', type: 'Button', x: 100, y: 60, w: 30, h: 30 },
  { name: 'Redo', type: 'Button', x: 140, y: 60, w: 30, h: 30 },
  { name: 'Bold', type: 'Button', x: 180, y: 60, w: 30, h: 30 },
  { name: 'Italic', type: 'Button', x: 220, y: 60, w: 30, h: 30 },
  { name: 'Underline', type: 'Button', x: 260, y: 60, w: 30, h: 30 },
];

function harness({ text, uia, transcript = 'where is the save button' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-p-'));
  const settings = new SettingsStore(path.join(dir, 's.json'), null, {});
  settings.setApiKey('k');
  settings.set({ hasCompletedOnboarding: true });
  const events = [];
  const speech = new SpeechQueue({ synthesize: async (t) => Buffer.from(t), playWav: async () => {} });
  const ui = {
    hasOverlay: () => true, setVoiceState() {}, status() {}, notify() {}, caption() {},
    showOverlay() {}, hideOverlay() {}, fadeOutOverlay() {}, dismissPanel() {}, openPanel() {},
    clearPointing() {}, dismissOnboardingPrompt() {},
    pointAt: (target, label, bounds, t, rect) => events.push(['point', target, label, rect]),
    drawShapes: (shapes) => events.push(['draw', shapes]),
    showCards() {}, showModel3D() {},
    showExplain: (card) => events.push(['explain', card]),
  };
  const capture = { captureAllScreens: async () => [{ jpeg: Buffer.from('x'), label: 'screen 1', isCursorScreen: true, bounds: { x: 0, y: 0, width: 1000, height: 600 }, screenshotWidth: 1000, screenshotHeight: 600 }] };
  const requests = [];
  const groq = { transcribe: async () => transcript, chat: async (o) => { requests.push(o); o.onTextDelta(text); return { text, toolCalls: [] }; } };
  const audio = { start: async () => {}, stop: async () => ({ wav: Buffer.from('w'), durationMs: 900 }), cancel() {} };
  const agent = { listJobs: () => [], run: async () => ({ status: 'done', summary: 'ok' }), stopAll() {} };
  const screenApi = { screenToDipPoint: (p) => p, dipToScreenPoint: (p) => p };
  const c = new CompanionManager({ settings, groq, capture, audio, speech, agent, ui, screenApi, uia });
  c.refreshPermissions({ microphone: true, screen: true, input: true });
  c.start();
  return { c, events, requests, settings };
}

const uiaOk = { listForegroundElements: async () => ({ title: 'Doc', elements: ELEMENTS }) };

test('numbered POINT lands on the exact center of the control and passes its rectangle', async () => {
  // reading order: File(#1) Share(#2) Undo(#3) Redo(#4) Bold(#5) Italic(#6) Underline(#7) Save(#8)
  const h = harness({ text: 'it is right there. [POINT:#8:save button]', uia: uiaOk });
  await h.c.sendText('where is the save button');
  const point = h.events.find((e) => e[0] === 'point');
  assert.deepEqual(point[1], { x: 440, y: 315 });
  assert.equal(point[2], 'save button');
  assert.deepEqual(point[3], { x: 400, y: 300, width: 80, height: 30 });
  const sys = h.requests[0].messages[0].content;
  assert.match(sys, /#8 button "Save"/);
});

test('a simple "where is" question skips the screenshot to save tokens', async () => {
  const h = harness({ text: 'there. [POINT:#8:save]', uia: uiaOk });
  await h.c.sendText('where is the save button');
  const user = h.requests[0].messages.at(-1).content;
  assert.ok(!user.some((p) => p.type === 'image_url'), 'no image expected');
});

test('questions about what is on screen still attach the screenshot', async () => {
  const h = harness({ text: 'it is a chart. [POINT:none]', uia: uiaOk, transcript: 'explain this chart' });
  await h.c.sendText('explain this chart');
  const user = h.requests[0].messages.at(-1).content;
  assert.ok(user.some((p) => p.type === 'image_url'));
});

test('guessed x,y is snapped to the control the label names', async () => {
  // model says 450,520 on a 1000 grid -> (450, 312) which is inside Save
  const h = harness({ text: 'here. [POINT:470,540:save]', uia: uiaOk });
  await h.c.sendText('where is save');
  const point = h.events.find((e) => e[0] === 'point');
  assert.deepEqual(point[1], { x: 440, y: 315 });
  assert.ok(point[3]);
});

test('an unknown control number is ignored instead of guessed', async () => {
  const h = harness({ text: 'hm. [POINT:#99:thing]', uia: uiaOk });
  await h.c.sendText('where is the thing');
  assert.equal(h.events.find((e) => e[0] === 'point'), undefined);
});

test('DRAW on a numbered control becomes an exact rectangle', async () => {
  const h = harness({ text: 'this one. [DRAW:rect:#8:save]', uia: uiaOk });
  await h.c.sendText('show me save');
  const draw = h.events.find((e) => e[0] === 'draw');
  assert.equal(draw[1][0].kind, 'rect');
  assert.deepEqual(draw[1][0].points[0], { x: 395, y: 295 });
});

test('a slow or broken control list never blocks the answer', async () => {
  const uia = { listForegroundElements: async () => { throw new Error('powershell died'); } };
  const h = harness({ text: 'ok. [POINT:500,500:middle]', uia });
  await h.c.sendText('where is the middle');
  assert.ok(h.events.find((e) => e[0] === 'point'));
  assert.ok(h.requests[0].messages.at(-1).content.some((p) => p.type === 'image_url'), 'falls back to the screenshot');
});

test('EXPLAIN tag reaches the overlay', async () => {
  const h = harness({ text: 'let me show you. [EXPLAIN:How it learns|guess -> compare -> adjust|note: repeat]', uia: uiaOk, transcript: 'explain how it learns' });
  await h.c.sendText('explain how it learns');
  const ex = h.events.find((e) => e[0] === 'explain');
  assert.equal(ex[1].title, 'How it learns');
  assert.equal(ex[1].rows[0].type, 'flow');
});
