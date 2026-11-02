'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TimerManager, formatDuration } = require('../../src/main/timers');

test('formatDuration formats seconds, minutes and hours', () => {
  assert.equal(formatDuration(30), '30 seconds');
  assert.equal(formatDuration(1), '1 second');
  assert.equal(formatDuration(60), '1 minute');
  assert.equal(formatDuration(120), '2 minutes');
  assert.equal(formatDuration(90), '1 minute and 30 seconds');
});

test('TimerManager sets timer and fires callbacks when due', async () => {
  const spoken = [];
  const notes = [];
  const tm = new TimerManager({
    speak: (t) => spoken.push(t),
    notify: () => {},
    drawNote: (t) => notes.push(t),
  });

  const res = tm.setTimer(1, 'quick test');
  assert.equal(res.ok, true);
  assert.equal(res.humanDuration, '1 second');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Timer: 1 second/);

  const status = tm.getStatus();
  assert.ok(status);
  assert.equal(status.totalSec, 1);

  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /your 1 second timer is up/i);
});

test('TimerManager can cancel active timers', () => {
  const tm = new TimerManager();
  tm.setTimer(60);
  tm.setTimer(120);
  assert.equal(tm.getStatus().totalSec, 60);
  const cancelled = tm.cancelAll();
  assert.equal(cancelled.count, 2);
  assert.equal(tm.getStatus(), null);
});
