'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ActivityLog, summarizeTool, summarizeQuick } = require('../../src/main/activity-log');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-act-')), 'activity.jsonl');

test('typed, pasted and filled text is never stored, only its length', () => {
  const secret = 'my-password-hunter2';
  for (const [tool, args] of [['type_text', { text: secret }], ['paste_text', { text: secret }], ['set_text', { name: 'Password', text: secret }], ['write_clipboard', { text: secret }]]) {
    const s = summarizeTool(tool, args);
    assert.ok(!s.includes('hunter2'), tool + ': ' + s);
    assert.match(s, /\d+ characters/);
  }
  const file = tmp();
  const log = new ActivityLog({ file });
  log.add({ tool: 'type_text', args: { text: secret } });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hunter2'));
});

test('quick voice commands are summarised without the typed text', () => {
  const q = summarizeQuick({ kind: 'type', text: 'dear bob, here is my pin 1234' });
  assert.ok(!q.summary.includes('1234'));
  assert.equal(q.source, 'quick');
  assert.match(summarizeQuick({ kind: 'volume', op: 'set', percent: 30 }).summary, /30%/);
  assert.match(summarizeQuick({ kind: 'folder', name: 'downloads' }).summary, /downloads/);
});

test('entries are stored newest first and carry kind, source, blocked and ok', () => {
  const log = new ActivityLog({ file: tmp() });
  log.add({ tool: 'folder_size', args: { path: 'C:\\Users\\Sam\\Downloads' }, source: 'quick' });
  log.add({ tool: 'move_file', args: { from: 'C:\\a\\b.txt', to: 'C:\\c' } });
  log.add({ tool: 'read_file', args: { path: 'D:\\x' }, ok: false, blocked: true });
  const all = log.recent();
  assert.equal(all.length, 3);
  assert.equal(all[0].tool, 'read_file');
  assert.equal(all[0].blocked, true);
  assert.equal(all[0].ok, false);
  assert.equal(all[2].source, 'quick');
  assert.equal(all[2].kind, 'read');
  assert.equal(all[1].kind, 'change');
});

test('filters: changes, blocked and reads', () => {
  const log = new ActivityLog({ file: tmp() });
  log.add({ tool: 'folder_size', args: { path: 'C:\\x' } });
  log.add({ tool: 'web_search', args: { query: 'cats' } });
  log.add({ tool: 'move_file', args: { from: 'C:\\a', to: 'C:\\b' } });
  log.add({ tool: 'click', args: { x: 1, y: 2 } });
  log.add({ tool: 'read_file', args: { path: 'D:\\no' }, ok: false, blocked: true });
  assert.deepEqual(log.recent({ filter: 'reads' }).map((e) => e.tool).sort(), ['folder_size', 'read_file', 'web_search']);
  assert.deepEqual(log.recent({ filter: 'blocked' }).map((e) => e.tool), ['read_file']);
  assert.ok(log.recent({ filter: 'changes' }).some((e) => e.tool === 'move_file'));
  assert.ok(!log.recent({ filter: 'changes' }).some((e) => e.tool === 'folder_size'));
});

test('the file is trimmed so it never grows without bound', () => {
  const file = tmp();
  const log = new ActivityLog({ file, max: 20, keep: 10 });
  for (let i = 0; i < 25; i++) log.add({ summary: 'item ' + i, kind: 'other' });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= 20, String(lines.length));
  assert.equal(log.recent({ limit: 1 })[0].summary, 'item 24');
});

test('limit, clear and a corrupt line do not break reading', () => {
  const file = tmp();
  const log = new ActivityLog({ file });
  for (let i = 0; i < 5; i++) log.add({ summary: 's' + i });
  fs.appendFileSync(file, 'not json\n');
  assert.equal(log.recent({ limit: 3 }).length, 3);
  log.clear();
  assert.deepEqual(log.recent(), []);
});

test('onAdd is called, and a failing disk or listener never throws', () => {
  const seen = [];
  const log = new ActivityLog({ file: tmp(), onAdd: (e) => seen.push(e.summary) });
  log.add({ summary: 'hello' });
  assert.deepEqual(seen, ['hello']);
  const bad = new ActivityLog({ file: path.join(os.tmpdir(), 'x'), fsImpl: { mkdirSync() { throw new Error('disk'); }, readFileSync() { throw new Error('disk'); } }, onAdd() { throw new Error('ui'); } });
  assert.doesNotThrow(() => bad.add({ summary: 'ok' }));
  assert.deepEqual(bad.recent(), []);
});

test('control characters and very long text are cleaned up', () => {
  const log = new ActivityLog({ file: tmp() });
  const e = log.add({ summary: 'line1\nline2\u0007' + 'x'.repeat(1000) });
  assert.ok(!/[\n\u0007]/.test(e.summary));
  assert.ok(e.summary.length <= 220);
});
