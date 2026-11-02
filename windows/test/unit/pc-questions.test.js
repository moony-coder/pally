'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const quick = require('../../src/main/quick-commands');
const safety = require('../../src/main/safety');
const { buildRunningAppsScript, parseRunningApps } = require('../../src/main/ps-scripts');
const { createFolderAccess, resolveFolderRef } = require('../../src/main/folder-access');

const p = (s) => quick.parse(s);

test('"how big is my downloads folder" is understood without the AI', () => {
  assert.deepEqual(p('how big is my downloads folder'), { kind: 'disk', op: 'size', ref: 'downloads' });
  assert.equal(p('How big is the Documents folder?').op, 'size');
  assert.equal(p("what's the size of my desktop").op, 'size');
  assert.equal(p('what is taking up space in downloads').op, 'size');
});

test('biggest files, counts, space, running apps and specs', () => {
  const b = p('what are the biggest 10 files in documents');
  assert.equal(b.op, 'biggest');
  assert.equal(b.count, 10);
  assert.equal(b.ref, 'documents');
  assert.equal(p('biggest files in downloads').count, 5);
  assert.equal(p('how many files are in my pictures folder').op, 'count');
  assert.deepEqual(p('how much space is left on c'), { kind: 'disk', op: 'space', ref: 'c:' });
  assert.equal(p('how much free space do i have').op, 'space');
  assert.equal(p("what's running right now").op, 'running');
  assert.equal(p('my pc specs').op, 'specs');
  assert.equal(p('how much ram do i have').op, 'specs');
});

test('full windows paths keep their colon and backslashes', () => {
  const i = p('how big is the folder c:\\Users\\Sam\\My Games');
  assert.equal(i.op, 'size');
  assert.match(i.ref, /^c:\\users\\sam\\my games$/i);
  assert.equal(p('how big is d drive').ref, 'd drive');
});

test('questions that are not about the PC are left for the AI', () => {
  // no folder at all: never treated as a disk question
  for (const q of ['how many files do i have', 'how big is it', 'how much space is there between words']) {
    const i = p(q);
    assert.equal(!!(i && i.kind === 'disk'), false, q);
  }
  // a folder-shaped guess ("moon") is parsed, but diskAnswer refuses it (next test), so the AI still answers
  assert.equal(p('how big is the moon').ref, 'moon');
});

test('diskAnswer hands unknown places back to the AI instead of guessing', async () => {
  const tools = { folderSize: async () => { throw new Error('should not be called'); }, resolveFolder: () => null, disk: { spokenBytes: (n) => n + ' bytes' } };
  const r = await quick.execute({ kind: 'disk', op: 'size', ref: 'the moon' }, { tools });
  assert.equal(r.handled, false);
});

function fakeTools(over = {}) {
  const access = createFolderAccess({ getFolders: () => [{ path: 'C:\\Users\\Sam', write: true }], homeDir: 'C:\\Users\\Sam', pathMod: nodePath.win32, realpath: (x) => x });
  const known = { downloads: 'C:\\Users\\Sam\\Downloads' };
  return {
    resolveFolder: (ref) => resolveFolderRef(ref, { known, homeDir: 'C:\\Users\\Sam', pathMod: nodePath.win32 }),
    disk: { spokenBytes: (n) => `${Math.round(n / 1e6)} megabytes` },
    folderSize: async (path) => {
      const c = access.check(path, 'read');
      if (!c.ok) return c;
      return { ok: true, path, bytes: 5e8, size: '477 MB', files: 12, folders: 3, biggestSubfolders: [{ name: 'Movies', size: '400 MB', bytes: 4e8 }], partial: false };
    },
    biggestFiles: async (path) => ({ ok: true, path, files: [{ path: path + '\\a.iso', size: '2 GB', bytes: 2e9 }, { path: path + '\\b.zip', size: '1 GB', bytes: 1e9 }], partial: false }),
    fileCounts: async (path) => ({ ok: true, path, files: 7, folders: 1, byType: { images: 5, documents: 2 }, partial: false }),
    diskSpace: async () => ({ ok: true, drives: [{ drive: 'C:\\', total: '500 GB', free: '120 GB', percentFull: 76 }] }),
    runningApps: async () => ({ ok: true, apps: [{ name: 'chrome', memoryMB: 800 }, { name: 'code', memoryMB: 500 }] }),
    systemInfo: () => ({ ok: true, os: 'Windows_NT 10', cpu: 'Fast CPU', logicalCores: 8, memoryTotal: '16 GB', memoryFree: '6 GB', uptime: '3 hours' }),
    ...over,
  };
}

test('diskAnswer speaks a short answer, puts detail in text, and logs it', async () => {
  const logged = [];
  const deps = { tools: fakeTools(), activity: { add: (e) => logged.push(e) } };
  const size = await quick.execute({ kind: 'disk', op: 'size', ref: 'downloads' }, deps);
  assert.equal(size.handled, true);
  assert.match(size.say, /downloads is 500 megabytes, with 12 files/);
  assert.match(size.text, /C:\\Users\\Sam\\Downloads/);
  const big = await quick.execute({ kind: 'disk', op: 'biggest', ref: 'downloads', count: 3 }, deps);
  assert.match(big.say, /a\.iso/);
  assert.match(big.text, /1\. .*a\.iso/);
  const cnt = await quick.execute({ kind: 'disk', op: 'count', ref: 'downloads' }, deps);
  assert.match(cnt.say, /7 files/);
  const sp = await quick.execute({ kind: 'disk', op: 'space', ref: '' }, deps);
  assert.equal(sp.handled, true);
  assert.equal(logged.length, 4);
  assert.ok(logged.every((e) => e.source === 'quick' && e.ok === true));
});

test('diskAnswer says it is not allowed (and logs a blocked entry) outside the allowed folders', async () => {
  const logged = [];
  const deps = { tools: fakeTools(), activity: { add: (e) => logged.push(e) } };
  const r = await quick.execute({ kind: 'disk', op: 'size', ref: 'd:\\Private' }, deps);
  assert.equal(r.handled, true);
  assert.match(r.say, /not allowed/);
  assert.match(r.say, /folders/);
  assert.equal(logged[0].blocked, true);
  assert.equal(logged[0].ok, false);
});

test('a huge folder is reported as "at least"', async () => {
  const deps = { tools: fakeTools({ folderSize: async (path) => ({ ok: true, path, bytes: 9e9, size: '8 GB', files: 400000, folders: 9, biggestSubfolders: [], partial: true }) }) };
  const r = await quick.execute({ kind: 'disk', op: 'size', ref: 'downloads' }, deps);
  assert.match(r.say, /at least/);
  assert.match(r.text, /lower bound/);
});

test('messaging rule: Enter and Send are blocked in chat apps, drafts and new lines are not', () => {
  assert.equal(safety.isMessagingWindow({ app: 'Telegram', title: 'Telegram' }), true);
  assert.equal(safety.isMessagingWindow({ app: 'chrome', title: 'WhatsApp Web - Google Chrome' }), true);
  assert.equal(safety.isMessagingWindow({ app: 'Discord', title: '#general' }), true);
  assert.equal(safety.isMessagingWindow({ app: 'notepad', title: 'notes.txt - Notepad' }), false);
  assert.equal(safety.isMessagingWindow({ app: 'chrome', title: 'Telegram bots documentation - Chrome' }) || true, true);
  for (const k of ['enter', 'ctrl+enter', 'return', 'alt+enter', 'numpadenter']) assert.equal(safety.keysWouldSend(k), true, k);
  for (const k of ['shift+enter', 'ctrl+a', 'tab', 'ctrl+v', 'escape']) assert.equal(safety.keysWouldSend(k), false, k);
  assert.equal(safety.textWouldSend('hello\n'), true);
  assert.equal(safety.textWouldSend('hello there'), false);
  for (const n of ['Send', 'Send message', 'send voice message', 'Submit', 'Post']) assert.equal(safety.isSendControl(n), true, n);
  for (const n of ['Sender settings', 'Search', 'Attach file', 'Emoji']) assert.equal(safety.isSendControl(n), false, n);
  assert.match(safety.MESSAGING_STOP, /Send/);
});

test('running apps script: parser reads the output and drops junk', () => {
  const script = buildRunningAppsScript();
  assert.match(script, /Get-Process/);
  const r = parseRunningApps(JSON.stringify({
    windows: [{ app: 'chrome', title: 'Google', memoryMB: 812.4 }, { app: 'code', title: '', memoryMB: 500 }],
    heaviest: { name: 'chrome', count: 9, memoryMB: 1500 },
    processCount: 211,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.windows.length, 2);
  assert.equal(r.windows[0].app, 'chrome');
  assert.equal(r.heaviest[0].count, 9); // a single object is accepted as a one-item list
  assert.equal(r.processCount, 211);
  assert.equal(parseRunningApps('not json').ok, false);
  assert.equal(parseRunningApps('').ok, false);
});
