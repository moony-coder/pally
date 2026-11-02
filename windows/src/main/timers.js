'use strict';
/*
 * In-app countdown timer manager.
 * Spoken alert when complete, optional live note on screen and tray notification.
 */

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (rem === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'} and ${rem} second${rem === 1 ? '' : 's'}`;
}

class TimerManager {
  constructor({ notify, speak, drawNote } = {}) {
    this.notify = notify || (() => {});
    this.speak = speak || (() => {});
    this.drawNote = drawNote || (() => {});
    this.active = new Map();
  }

  setTimer(seconds, label = 'timer') {
    const s = Math.max(1, Math.round(Number(seconds) || 60));
    const id = 'timer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const endsAt = Date.now() + s * 1000;
    const humanDuration = formatDuration(s);

    if (this.drawNote) {
      try {
        this.drawNote(`Timer: ${humanDuration}`, { x: 500, y: 120 });
      } catch (_) {}
    }

    const timer = setTimeout(() => {
      this.active.delete(id);
      this.notify(`Timer for ${humanDuration} is up!`, 'info');
      this.speak(`your ${humanDuration} timer is up.`);
      if (this.drawNote) {
        try {
          this.drawNote(`Timer for ${humanDuration} is up!`, { x: 500, y: 120 });
        } catch (_) {}
      }
    }, s * 1000);
    if (timer.unref) timer.unref();

    this.active.set(id, { id, label, totalSec: s, endsAt, timer, humanDuration });
    return { ok: true, id, seconds: s, humanDuration };
  }

  cancelAll() {
    const count = this.active.size;
    for (const [id, item] of this.active) {
      clearTimeout(item.timer);
    }
    this.active.clear();
    return { count };
  }

  getStatus() {
    if (!this.active.size) return null;
    const items = Array.from(this.active.values());
    const first = items[0];
    const leftSec = Math.max(0, Math.round((first.endsAt - Date.now()) / 1000));
    return { leftSec, humanLeft: formatDuration(leftSec), totalSec: first.totalSec, humanDuration: first.humanDuration };
  }
}

module.exports = { TimerManager, formatDuration };
