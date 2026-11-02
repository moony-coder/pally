'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cornerBounds, lookVector, normalizeState, EyesWindow, SIZE } = require('../../src/main/eyes');
const vs = require('../../src/main/voice-settings');

test('corner placement stays inside the work area (taskbar excluded)', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 }; // 1080 screen minus 40px taskbar
  assert.deepEqual(cornerBounds(wa, 'bottom-right'), { x: 1920 - SIZE.width - 14, y: 1040 - SIZE.height - 14, ...SIZE });
  assert.deepEqual(cornerBounds(wa, 'top-left'), { x: 14, y: 14, ...SIZE });
  assert.equal(cornerBounds(wa, 'bottom-left').x, 14);
  assert.equal(cornerBounds(wa, 'top-right').y, 14);
  assert.deepEqual(cornerBounds(wa, 'nonsense'), cornerBounds(wa, 'bottom-right'));
  // taskbar on left edge (x offset)
  const waLeftTaskbar = { x: 60, y: 0, width: 1860, height: 1080 };
  assert.equal(cornerBounds(waLeftTaskbar, 'bottom-left').x, 60 + 14);
  assert.equal(cornerBounds(waLeftTaskbar, 'bottom-right').x, 60 + 1860 - SIZE.width - 14);
  // taskbar on top edge (y offset)
  const waTopTaskbar = { x: 0, y: 60, width: 1920, height: 1020 };
  assert.equal(cornerBounds(waTopTaskbar, 'top-left').y, 60 + 14);
  assert.equal(cornerBounds(waTopTaskbar, 'top-right').y, 60 + 14);
  // second monitor to the right (positive x offset)
  assert.equal(cornerBounds({ x: 1920, y: 0, width: 2560, height: 1400 }, 'bottom-right').x, 1920 + 2560 - SIZE.width - 14);
  // second monitor to the left of the primary (negative x)
  assert.equal(cornerBounds({ x: -1280, y: 0, width: 1280, height: 720 }, 'top-left').x, -1280 + 14);
  // second monitor above primary (negative y)
  assert.equal(cornerBounds({ x: 0, y: -1080, width: 1920, height: 1040 }, 'top-left').y, -1080 + 14);
});

test('look vector points at the mouse, scales with distance, never exceeds 1', () => {
  const c = { x: 100, y: 100 };
  assert.deepEqual(lookVector({ x: 100, y: 100 }, c), { x: 0, y: 0 });
  assert.deepEqual(lookVector({ x: 2000, y: 100 }, c), { x: 1, y: 0 });
  assert.deepEqual(lookVector({ x: 100, y: -2000 }, c), { x: 0, y: -1 });
  const near = lookVector({ x: 150, y: 100 }, c);
  assert.ok(near.x > 0 && near.x < 0.2 && near.y === 0);
  const diag = lookVector({ x: 5000, y: 5000 }, c);
  assert.ok(Math.hypot(diag.x, diag.y) <= 1.001);
  assert.deepEqual(lookVector(null, c), lookVector({ x: 0, y: 0 }, c)); // bad input never throws or gives NaN
});

test('unknown states fall back to idle', () => {
  assert.equal(normalizeState('listening'), 'listening');
  assert.equal(normalizeState('banana'), 'idle');
});

function fakes(settings) {
  const sent = [];
  const wins = [];
  class FakeWin {
    constructor(opts) {
      this.opts = opts; this.destroyed = false; this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }; this.handlers = {};
      this.webContents = { send: (ch, d) => sent.push([ch, d]), isDestroyed: () => false, setWindowOpenHandler() {}, on: (e, f) => { this.handlers[e] = f; } };
      this.flags = {}; wins.push(this);
    }
    setAlwaysOnTop(v, l) { this.flags.top = [v, l]; }
    setIgnoreMouseEvents(v) { this.flags.ignore = v; }
    setMenuBarVisibility() {}
    setContentProtection(v) { this.flags.protect = v; }
    once(e, f) { this.handlers['once-' + e] = f; }
    on(e, f) { this.handlers[e] = f; }
    loadFile(f) { this.file = f; }
    setBounds(b) { this.bounds = b; }
    getBounds() { return this.bounds; }
    showInactive() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  const listeners = {};
  const cursor = { x: 10, y: 10 };
  const screen = {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => cursor,
    on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
  };
  const eyes = new EyesWindow({ BrowserWindow: FakeWin, screen, preloadPath: 'p.js', htmlPath: 'i.html', getSettings: () => settings, pollMs: 5 });
  return { eyes, sent, wins, cursor, listeners, settings };
}

test('eyes window: click-through, always on top, hidden from screenshots, placed in the corner', () => {
  const f = fakes({ eyesEnabled: true, eyesCorner: 'top-right', hideFromCapture: true });
  f.eyes.sync();
  const w = f.wins[0];
  assert.equal(w.flags.ignore, true);
  assert.deepEqual(w.flags.top, [true, 'screen-saver']);
  assert.equal(w.flags.protect, true);
  assert.equal(w.opts.focusable, false);
  assert.equal(w.opts.skipTaskbar, true);
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.deepEqual(w.bounds, cornerBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 'top-right'));
  f.eyes.close();
});

test('eyes window: only sends when the mouse moved, forwards state, and toggles off/on', async () => {
  const f = fakes({ eyesEnabled: true, eyesCorner: 'bottom-right' });
  f.eyes.sync();
  f.eyes.sync(); // a second sync must not open a second window
  assert.equal(f.wins.length, 1);
  await new Promise((r) => setTimeout(r, 40));
  const looks1 = f.sent.filter((s) => s[0] === 'eyes:look').length;
  assert.equal(looks1, 1, 'identical positions are sent once');
  f.cursor.x = 900;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.sent.filter((s) => s[0] === 'eyes:look').length, 2);
  f.eyes.setState('processing');
  assert.deepEqual(f.sent[f.sent.length - 1], ['eyes:state', 'processing']);
  f.settings.eyesEnabled = false;
  f.eyes.sync();
  assert.equal(f.wins[0].destroyed, true);
  assert.equal(f.eyes.timer, null);
  f.settings.eyesEnabled = true;
  f.eyes.sync();
  assert.equal(f.wins.length, 2);
  f.eyes.close();
  assert.equal((f.listeners['display-metrics-changed'] || []).length, 0, 'no leaked display listeners');
});

test('eyes window: if the window cannot be created the app keeps running', () => {
  const f = fakes({ eyesEnabled: true });
  f.eyes.BrowserWindow = class { constructor() { throw new Error('boom'); } };
  f.eyes.log = { info() {}, error() {}, warn() {} };
  assert.doesNotThrow(() => f.eyes.sync());
  assert.equal(f.eyes.open, false);
});

test('eyes settings are validated', () => {
  assert.deepEqual(vs.sanitizeVoicePatch({ eyesEnabled: 0, eyesCorner: 'top-left' }).patch, { eyesEnabled: false, eyesCorner: 'top-left' });
  assert.equal(vs.sanitizeVoicePatch({ eyesCorner: 'middle' }).errors.length, 1);
});
