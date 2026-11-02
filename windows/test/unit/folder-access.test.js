'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const { createFolderAccess, sanitizeFolderList, resolveFolderRef } = require('../../src/main/folder-access');

const win = nodePath.win32;
const make = (folders, extra = {}) => createFolderAccess({ getFolders: () => folders, homeDir: 'C:\\Users\\Sam', pathMod: win, realpath: (p) => p, ...extra });

test('default (no choice made) is the user folder, read and change', () => {
  const a = make(null);
  assert.equal(a.isDefault(), true);
  assert.equal(a.check('C:\\Users\\Sam\\Downloads', 'read').ok, true);
  assert.equal(a.check('C:\\Users\\Sam\\Downloads\\x.txt', 'write').ok, true);
  assert.equal(a.check('D:\\Games', 'read').ok, false);
});

test('read-only folders can be read but not changed, with a helpful message', () => {
  const a = make([{ path: 'D:\\Media', write: false }, { path: 'E:\\Work', write: true }]);
  assert.equal(a.check('D:\\Media\\a\\b.mp4', 'read').ok, true);
  const w = a.check('D:\\Media\\a.mp4', 'write');
  assert.equal(w.ok, false);
  assert.equal(w.needs, 'write');
  assert.match(w.error, /only read/i);
  assert.equal(a.check('E:\\Work\\notes.txt', 'write').ok, true);
});

test('other drives are blocked until the user adds them', () => {
  const a = make([{ path: 'C:\\Users\\Sam', write: true }]);
  const r = a.check('D:\\Anything', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.error, /outside the folders you allowed/i);
});

test('prefix tricks and .. do not escape a folder', () => {
  const a = make([{ path: 'C:\\Users\\Sam\\Docs', write: true }]);
  assert.equal(a.check('C:\\Users\\Sam\\Docs-secret\\x', 'read').ok, false);
  assert.equal(a.check('C:\\Users\\Sam\\Docs\\..\\Pictures', 'read').ok, false);
  assert.equal(a.check('C:\\Users\\Sam\\Docs\\sub\\..\\ok.txt', 'read').ok, true);
});

test('windows paths are case-insensitive', () => {
  const a = make([{ path: 'D:\\Media', write: false }]);
  assert.equal(a.check('d:\\media\\x.mp4', 'read').ok, true);
});

test('relative, empty and NUL paths are refused', () => {
  const a = make(null);
  for (const p of ['', '   ', 'docs\\x', '..\\x', 'C:\\a\\0b'.replace('0', '\0'), null, 12]) assert.equal(a.check(p, 'read').ok, false, String(p));
});

test('secrets are always off limits, even inside an allowed folder or drive', () => {
  const a = make([{ path: 'C:\\', write: true }]);
  for (const p of ['C:\\Users\\Sam\\.ssh\\id_rsa', 'C:\\Users\\Sam\\.aws\\credentials', 'C:\\Users\\Sam\\AppData\\Roaming\\Microsoft\\Credentials\\x']) {
    const r = a.check(p, 'read');
    assert.equal(r.ok, false, p);
    assert.equal(r.blocked, true);
  }
});

test('system folders are never changed, even on a read-and-change drive', () => {
  const a = make([{ path: 'C:\\', write: true }]);
  assert.equal(a.check('C:\\Windows\\System32', 'read').ok, true);
  for (const p of ['C:\\Windows\\notepad.exe', 'C:\\Program Files\\App\\a.dll', 'C:\\ProgramData\\x']) assert.equal(a.check(p, 'write').ok, false, p);
});

test("Sidekick's own settings folder is protected", () => {
  const a = make([{ path: 'C:\\Users\\Sam', write: true }], { protectedPaths: () => ['C:\\Users\\Sam\\AppData\\Roaming\\Sidekick'] });
  assert.equal(a.check('C:\\Users\\Sam\\AppData\\Roaming\\Sidekick\\settings.json', 'read').ok, false);
  assert.equal(a.isSecretPath('C:\\Users\\Sam\\AppData\\Roaming\\Sidekick'), true);
});

test('a link that leads out of an allowed folder is refused (realpath is checked)', () => {
  const real = (p) => (/\\link$/i.test(p) ? 'D:\\Private' : p);
  const a = make([{ path: 'C:\\Users\\Sam', write: true }], { realpath: real });
  assert.equal(a.check('C:\\Users\\Sam\\link', 'read').ok, false);
  assert.equal(a.check('C:\\Users\\Sam\\fine', 'read').ok, true);
});

test('addImplicit adds an always-usable folder that is not in the chosen list', () => {
  const a = make([{ path: 'D:\\Media', write: false }]);
  a.addImplicit({ path: 'C:\\Users\\Sam\\Documents\\Sidekick', write: true });
  assert.equal(a.check('C:\\Users\\Sam\\Documents\\Sidekick\\a.txt', 'write').ok, true);
  assert.equal(a.chosen().length, 1);
});

test('sanitizeFolderList keeps full paths, merges duplicates (stronger permission wins) and drops junk', () => {
  const out = sanitizeFolderList([
    { path: 'D:\\Media\\', write: false }, { path: 'd:\\media', write: true }, 'E:\\Work', { path: 'relative\\x' }, { path: '' }, null, 5, { write: true },
  ], { pathMod: win });
  assert.deepEqual(out, [{ path: 'D:\\Media', write: true }, { path: 'E:\\Work', write: false }]);
  assert.equal(sanitizeFolderList(null), null);
  assert.equal(sanitizeFolderList('nope'), null);
});

test('resolveFolderRef understands names, drives and paths but not a bare letter', () => {
  const known = { downloads: 'C:\\Users\\Sam\\Downloads', documents: 'C:\\Users\\Sam\\Documents', pictures: 'C:\\Users\\Sam\\Pictures' };
  const r = (x) => resolveFolderRef(x, { known, homeDir: 'C:\\Users\\Sam', pathMod: win });
  assert.equal(r('downloads'), 'C:\\Users\\Sam\\Downloads');
  assert.equal(r('my downloads folder'), 'C:\\Users\\Sam\\Downloads');
  assert.equal(r('photos'), 'C:\\Users\\Sam\\Pictures');
  assert.equal(r('d drive'), 'D:\\');
  assert.equal(r('d:'), 'D:\\');
  assert.equal(r('e:\\Games\\Saves').toLowerCase(), 'e:\\games\\saves');
  assert.equal(r('~\\Music'), 'C:\\Users\\Sam\\Music');
  assert.equal(r('%USERPROFILE%\\Desktop'), 'C:\\Users\\Sam\\Desktop');
  assert.equal(r('home'), 'C:\\Users\\Sam');
  assert.equal(r('x'), null);
  assert.equal(r('the moon'), null);
  assert.equal(r(''), null);
});
