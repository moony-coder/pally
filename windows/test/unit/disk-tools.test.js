'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFolderAccess } = require('../../src/main/folder-access');
const { createDiskTools, humanBytes, spokenBytes } = require('../../src/main/disk-tools');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-disk-')));
  const w = (rel, size) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size, 1));
  };
  w('a.txt', 100);
  w('pics/big.png', 5000);
  w('pics/small.jpg', 300);
  w('movies/film.mp4', 20000);
  w('movies/deep/clip.mkv', 1000);
  w('.ssh/id_rsa', 999);
  return { root, w };
}
const tools = (root, over = {}, access) => {
  const acc = access || createFolderAccess({ getFolders: () => [{ path: root, write: false }], homeDir: root });
  return createDiskTools({ access: acc, ...over });
};

test('humanBytes and spokenBytes read well', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.match(humanBytes(1536), /1\.5 KB/);
  assert.match(humanBytes(5 * 1024 ** 3), /5(\.0)? GB/);
  assert.match(spokenBytes(1536), /kilobyte/i);
  assert.match(spokenBytes(5 * 1024 ** 3), /gigabyte/i);
});

test('folderSize totals files, counts folders and names the biggest part', async () => {
  const { root } = fixture();
  const r = await tools(root).folderSize(root);
  assert.equal(r.ok, true);
  // the secret folder is skipped, so 999 bytes are not counted
  assert.equal(r.bytes, 100 + 5000 + 300 + 20000 + 1000);
  assert.equal(r.files, 5);
  assert.equal(r.partial, false);
  assert.equal(r.biggestSubfolders[0].name, 'movies');
});

test('biggestFiles returns the largest first and honours count', async () => {
  const { root } = fixture();
  const r = await tools(root).biggestFiles(root, { count: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => path.basename(f.path)), ['film.mp4', 'big.png']);
  assert.ok(r.files[0].bytes > r.files[1].bytes);
});

test('fileCounts groups by type', async () => {
  const { root } = fixture();
  const r = await tools(root).fileCounts(root);
  assert.equal(r.files, 5);
  assert.equal(r.byType.images, 2);
  assert.equal(r.byType.videos, 2);
  assert.equal(r.byType.documents, 1);
});

test('secret folders are never read, and a path outside the allowed folders is refused', async () => {
  const { root } = fixture();
  const t = tools(root);
  const big = await t.biggestFiles(root, { count: 50 });
  assert.ok(!big.files.some((f) => /id_rsa/.test(f.path)));
  const out = await t.folderSize(path.dirname(root));
  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  const secret = await t.folderSize(path.join(root, '.ssh'));
  assert.equal(secret.ok, false);
});

test('links are not followed', { skip: process.platform === 'win32' }, async () => {
  const { root } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-out-'));
  fs.writeFileSync(path.join(outside, 'huge.bin'), Buffer.alloc(50000));
  fs.symlinkSync(outside, path.join(root, 'link'));
  const r = await tools(root).folderSize(root);
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 100 + 5000 + 300 + 20000 + 1000);
  assert.ok(r.skippedLinks >= 1);
});

test('a time or entry limit gives a partial answer instead of hanging', async () => {
  const { root, w } = fixture();
  for (let i = 0; i < 30; i++) w('many/f' + i + '.txt', 10);
  const r = await tools(root).folderSize(root, { maxEntries: 1000 });
  assert.equal(r.partial, false);
  // force the entry limit through a tiny cap on the walk
  const t = createDiskTools({ access: createFolderAccess({ getFolders: () => [{ path: root }], homeDir: root }), defaultMaxEntries: 5 });
  const small = await t.fileCounts(root, { maxEntries: 1 });
  assert.ok(small.ok);
  let clock = 0;
  const slow = createDiskTools({ access: createFolderAccess({ getFolders: () => [{ path: root }], homeDir: root }), now: () => (clock += 5000) });
  const p = await slow.folderSize(root, { maxMs: 1000 });
  assert.equal(p.partial, true);
  assert.match(p.stoppedBy, /time/);
});

test('a missing folder or a file gives a clear error', async () => {
  const { root } = fixture();
  const t = tools(root);
  assert.match((await t.folderSize(path.join(root, 'nope'))).error, /does not exist|cannot be opened/i);
  assert.match((await t.folderSize(path.join(root, 'a.txt'))).error, /file, not a folder/i);
  assert.equal((await t.folderSize('')).ok, false);
});

test('diskSpace answers for a path and lists drives', async () => {
  const { root } = fixture();
  const t = tools(root);
  const r = await t.diskSpace(root);
  assert.equal(r.ok, true);
  assert.ok(r.drives[0].totalBytes > 0);
  assert.ok(r.drives[0].percentFull >= 0 && r.drives[0].percentFull <= 100);
  assert.equal((await t.diskSpace('not a path')).ok, false);
  const list = await t.listDrives();
  assert.ok(Array.isArray(list));
});

test('systemInfo summarises the PC', () => {
  const { root } = fixture();
  const s = tools(root).systemInfo();
  assert.equal(s.ok, true);
  assert.ok(s.logicalCores > 0);
  assert.match(s.memoryTotal, /B$/);
});
