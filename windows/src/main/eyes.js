'use strict';
/*
 * Part 3: the little cartoon eyes in a screen corner that follow your mouse and react to what Sidekick is doing.
 * The maths is pure (unit tested). EyesWindow is the thin Electron part.
 */
const path = require('path');

const SIZE = { width: 150, height: 90 };
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const STATES = ['idle', 'listening', 'processing', 'responding'];

// Where the eyes window goes inside a display's work area (DIP). Anything unknown falls back to bottom-right.
function cornerBounds(workArea, corner, size = SIZE, margin = 14) {
  const wa = workArea || { x: 0, y: 0, width: 1280, height: 720 };
  const c = CORNERS.includes(corner) ? corner : 'bottom-right';
  const x = c.endsWith('left') ? wa.x + margin : wa.x + wa.width - size.width - margin;
  const y = c.startsWith('top') ? wa.y + margin : wa.y + wa.height - size.height - margin;
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

// Direction from the eyes to the mouse as x,y in [-1, 1]. Far away = full look, right on top = looks straight ahead.
function lookVector(cursor, center, reach = 500) {
  const dx = (cursor && Number.isFinite(cursor.x) ? cursor.x : 0) - center.x;
  const dy = (cursor && Number.isFinite(cursor.y) ? cursor.y : 0) - center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: 0, y: 0 };
  const strength = Math.min(1, dist / reach);
  return { x: +((dx / dist) * strength).toFixed(3), y: +((dy / dist) * strength).toFixed(3) };
}

function normalizeState(s) {
  return STATES.includes(s) ? s : 'idle';
}

class EyesWindow {
  constructor({ BrowserWindow, screen, preloadPath, htmlPath, log, getSettings, pollMs = 40 }) {
    this.BrowserWindow = BrowserWindow;
    this.screen = screen;
    this.preloadPath = preloadPath;
    this.htmlPath = htmlPath;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.getSettings = getSettings;
    this.pollMs = pollMs;
    this.win = null;
    this.timer = null;
    this.state = 'idle';
    this.lastLook = '';
    this._onMetrics = () => this._place();
  }

  get open() {
    return !!(this.win && !this.win.isDestroyed());
  }

  _create() {
    const win = new this.BrowserWindow({
      ...SIZE, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      hasShadow: false, show: false, alwaysOnTop: true, fullscreenable: false, title: 'Sidekick eyes',
      webPreferences: { preload: this.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true); // clicks pass straight through to whatever is underneath
    win.setMenuBarVisibility(false);
    try { win.setContentProtection(this.getSettings().hideFromCapture !== false); } catch (_) { /* not supported */ }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('did-finish-load', () => this._send('eyes:state', this.state));
    win.once('ready-to-show', () => { if (this.open) win.showInactive(); });
    win.on('closed', () => { this.win = null; this._stopPolling(); });
    win.loadFile(this.htmlPath);
    this.win = win;
    this.screen.on('display-metrics-changed', this._onMetrics);
    this.screen.on('display-removed', this._onMetrics);
  }

  _place() {
    if (!this.open) return;
    const display = this.screen.getPrimaryDisplay();
    this.win.setBounds(cornerBounds(display.workArea, this.getSettings().eyesCorner));
  }

  _send(channel, data) {
    if (this.open && !this.win.webContents.isDestroyed()) this.win.webContents.send(channel, data);
  }

  _startPolling() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.open) return;
      const b = this.win.getBounds();
      const look = lookVector(this.screen.getCursorScreenPoint(), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const key = look.x + ',' + look.y;
      if (key === this.lastLook) return; // mouse did not move: send nothing
      this.lastLook = key;
      this._send('eyes:look', look);
    }, this.pollMs);
  }

  _stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Called whenever settings change (and once at startup): show, hide or move the eyes.
  sync() {
    const s = this.getSettings();
    if (s.eyesEnabled === false) return this.close();
    if (!this.open) {
      try { this._create(); } catch (e) { this.log.warn('eyes window failed', e && e.message); return undefined; }
    }
    this._place();
    this._startPolling();
    return undefined;
  }

  setState(state) {
    this.state = normalizeState(state);
    this._send('eyes:state', this.state);
  }

  close() {
    this._stopPolling();
    try { this.screen.removeListener('display-metrics-changed', this._onMetrics); this.screen.removeListener('display-removed', this._onMetrics); } catch (_) { /* ignore */ }
    if (this.open) this.win.close();
    this.win = null;
  }
}

module.exports = { EyesWindow, cornerBounds, lookVector, normalizeState, CORNERS, STATES, SIZE, htmlPath: path.join(__dirname, '..', 'renderer', 'eyes', 'index.html') };
