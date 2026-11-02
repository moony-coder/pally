'use strict';
/*
 * Runs against a REAL PowerShell (pwsh on Linux/macOS, powershell.exe on Windows). Skipped when none is found.
 * What this proves: every generated script is valid PowerShell syntax, and the persistent worker protocol works.
 * What it cannot prove off Windows: that UI Automation / user32 calls behave (scripts/windows-verify does that).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { findPowerShell, parseScripts } = require('../helpers/ps');
const { PsSession } = require('../../src/main/powershell');
const uia = require('../../src/main/uia');
const { createSystemTools } = require('../../src/main/system-tools');
const { sapiScript } = require('../../src/main/tts');
const { collectAllScripts } = require('../helpers/collect-scripts');

const ps = findPowerShell();
const opts = { skip: ps ? false : 'no PowerShell found (set PWSH_PATH)' };

test('every PowerShell script the app generates parses cleanly', opts, async () => {
  const scripts = await collectAllScripts();
  assert.ok(scripts.length >= 12, 'collected ' + scripts.length);
  const results = parseScripts(ps, scripts);
  const bad = results.filter((r) => r.errors.length);
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
});

test('hostile names are quoted, not executed (apostrophes, $(), backticks)', opts, () => {
  const nasty = `O'Brien $(calc) \`n "x"`;
  const scripts = [
    { name: 'act-nasty', script: uia.buildActScript({ name: nasty, action: 'set_value', value: nasty, windowTitle: nasty }) },
    { name: 'list-nasty', script: uia.buildListScript(nasty) },
    { name: 'sapi-nasty', script: sapiScript(nasty) },
  ];
  assert.deepEqual(parseScripts(ps, scripts).filter((r) => r.errors.length), []);
});

function session(extra = {}) {
  return new PsSession(Object.assign({ exe: ps.exe, args: ['-NoProfile', '-NonInteractive'], idleMs: 60000, readyTimeoutMs: 30000 }, extra));
}

test('persistent session: runs scripts in order, keeps state warm, returns unicode intact', opts, async () => {
  const s = session({ prelude: '$global:warm = 41' });
  try {
    const [a, b, c] = await Promise.all([
      s.run('$global:warm + 1'),
      s.run('"héllo ✓ 日本"'),
      s.run('@{ ok = $true; n = 3 } | ConvertTo-Json -Compress'),
    ]);
    assert.equal(a.stdout, '42');
    assert.equal(b.stdout, 'héllo ✓ 日本');
    assert.deepEqual(JSON.parse(c.stdout), { ok: true, n: 3 });
    assert.equal(s.startedCount, 1, 'one worker served all three calls');
  } finally { s.dispose(); }
});

test('persistent session: a failing script returns code 1 and the worker survives', opts, async () => {
  const s = session();
  try {
    const bad = await s.run('throw "boom"');
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /boom/);
    const good = await s.run('"still alive"');
    assert.equal(good.stdout, 'still alive');
    assert.equal(s.startedCount, 1);
  } finally { s.dispose(); }
});

test('persistent session: a hung call times out, then a fresh worker answers', opts, async () => {
  const s = session();
  try {
    await s.run('"warm"');
    const t0 = Date.now();
    const hung = await s.run('Start-Sleep -Seconds 30', { timeoutMs: 1500 });
    assert.equal(hung.code, -2);
    assert.ok(Date.now() - t0 < 6000, 'gave up quickly');
    const next = await s.run('"recovered"', { timeoutMs: 20000 });
    assert.equal(next.stdout, 'recovered');
    assert.equal(s.startedCount, 2);
  } finally { s.dispose(); }
});

test('persistent session: idle worker is stopped to free RAM and restarts on demand', opts, async () => {
  const s = session({ idleMs: 700 });
  try {
    await s.run('"x"');
    assert.ok(s.alive);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(s.alive, false, 'worker stopped after idle');
    assert.equal((await s.run('"again"')).stdout, 'again');
    assert.equal(s.startedCount, 2);
  } finally { s.dispose(); }
});

test('negative control: the parser really reports broken scripts', opts, () => {
  const r = parseScripts(ps, [{ name: 'broken', script: "if ($x { 'unclosed' " }, { name: 'fine', script: "'ok'" }]);
  assert.ok(r.find((x) => x.name === 'broken').errors.length > 0);
  assert.equal(r.find((x) => x.name === 'fine').errors.length, 0);
});
