'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSystemTools } = require('../../src/main/system-tools');
const { buildToolDefinitions } = require('../../src/main/agent');

function withHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.sidekick-move-test-'));
  const tools = createSystemTools({
    shell: { openExternal: async () => {}, openPath: async () => '' },
    clipboard: { readText: () => '', writeText: () => {} },
    documentsDir: dir,
    platform: 'win32',
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  return { dir, tools, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('move_file moves inside the user folder, writes a journal, and undo_move puts it back', () => {
  const h = withHomeDir();
  try {
    const src = path.join(h.dir, 'report.txt');
    const dest = path.join(h.dir, 'Archive');
    fs.writeFileSync(src, 'hello');
    fs.mkdirSync(dest);
    const r = h.tools.moveFile(src, dest);
    assert.equal(r.ok, true);
    assert.ok(r.undoId);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(path.join(dest, 'report.txt'), 'utf8'), 'hello');
    assert.ok(fs.existsSync(path.join(h.dir, 'Sidekick', 'move-journal.json')));
    assert.equal(h.tools.listMoves().moves.length, 1);
    const u = h.tools.undoMove(r.undoId);
    assert.equal(u.ok, true);
    assert.equal(fs.readFileSync(src, 'utf8'), 'hello');
    assert.equal(fs.existsSync(path.join(dest, 'report.txt')), false);
    assert.equal(h.tools.undoMove(r.undoId).ok, false);
  } finally { h.cleanup(); }
});

test('move_file never overwrites and refuses paths outside the user folder', () => {
  const h = withHomeDir();
  try {
    const src = path.join(h.dir, 'a.txt');
    const dest = path.join(h.dir, 'Archive');
    fs.writeFileSync(src, 'a');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'a.txt'), 'existing');
    const r = h.tools.moveFile(src, dest);
    assert.equal(r.ok, false);
    assert.match(r.error, /never overwrite/i);
    assert.equal(fs.readFileSync(src, 'utf8'), 'a');

    const outside = h.tools.moveFile(src, path.join(os.homedir() + '2', 'a.txt'));
    assert.equal(outside.ok, false);
    assert.match(outside.error, /outside the folders you allowed/i);
  } finally { h.cleanup(); }
});

test('undo_move(last) restores the newest move', () => {
  const h = withHomeDir();
  try {
    const dest = path.join(h.dir, 'Archive');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(h.dir, 'one.txt'), '1');
    fs.writeFileSync(path.join(h.dir, 'two.txt'), '2');
    assert.equal(h.tools.moveFile(path.join(h.dir, 'one.txt'), dest).ok, true);
    assert.equal(h.tools.moveFile(path.join(h.dir, 'two.txt'), dest).ok, true);
    assert.equal(h.tools.undoMove('last').ok, true);
    assert.equal(fs.existsSync(path.join(h.dir, 'two.txt')), true);
    assert.equal(fs.existsSync(path.join(h.dir, 'one.txt')), false);
  } finally { h.cleanup(); }
});

test('agent tool list advertises move_file, undo_move and list_moves', () => {
  const names = buildToolDefinitions({ desktopAllowed: false, powershellAllowed: false }).map((t) => t.function.name);
  for (const n of ['move_file', 'undo_move', 'list_moves']) assert.ok(names.includes(n), n);
});

test('move_file respects read-only folders: moving out of or into one is refused with a helpful message', () => {
  const { createFolderAccess } = require('../../src/main/folder-access');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ro-'));
  const ro = path.join(dir, 'readonly');
  const rw = path.join(dir, 'readwrite');
  fs.mkdirSync(ro);
  fs.mkdirSync(rw);
  fs.writeFileSync(path.join(ro, 'a.txt'), 'x');
  fs.writeFileSync(path.join(rw, 'b.txt'), 'y');
  const access = createFolderAccess({ getFolders: () => [{ path: ro, write: false }, { path: rw, write: true }], homeDir: dir });
  const tools = createSystemTools({
    shell: { openExternal: async () => {}, openPath: async () => '' }, clipboard: { readText: () => '', writeText: () => {} },
    documentsDir: rw, platform: process.platform, run: async () => ({ code: 0, stdout: '', stderr: '' }), access,
  });
  const out = tools.moveFile(path.join(ro, 'a.txt'), rw);
  assert.equal(out.ok, false);
  assert.match(out.error, /only read|not change/i);
  assert.ok(fs.existsSync(path.join(ro, 'a.txt')), 'the file must still be there');
  const into = tools.moveFile(path.join(rw, 'b.txt'), ro);
  assert.equal(into.ok, false);
  assert.match(into.error, /Home > Folders/);
  assert.ok(fs.existsSync(path.join(rw, 'b.txt')));
  assert.equal(tools.listFiles(ro).ok, true, 'reading a read-only folder still works');
  fs.rmSync(dir, { recursive: true, force: true });
});
