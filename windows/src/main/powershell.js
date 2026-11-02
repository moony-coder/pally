'use strict';
const { spawn } = require('child_process');

const isWindows = () => process.platform === 'win32';

function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// Runs a PowerShell script; resolves {code, stdout, stderr}. Never rejects.
function runPowerShell(script, { timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve({ code: -1, stdout: '', stderr: 'PowerShell is only available on Windows.' });
    const wrapped = '$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(wrapped)],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      stderr += '\n(timed out)';
      finish(-2);
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { try { child.kill(); } catch (_) { /* ignore */ } finish(-3); });
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      stderr += String(e.message);
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

// single-quote escape for embedding in a PowerShell string literal
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------------------------
// Persistent session. Starting powershell.exe and compiling C# (Add-Type) costs 1-3 s on a laptop, which is
// longer than the control-list timeout. One long-lived worker pays that once; it is stopped again after
// `idleMs` without use so it does not sit on RAM (about 60 MB) while you are not talking to the app.
//
// Protocol (stdin -> worker): "<id>:<base64 utf8 script>\n"
//          (worker -> stdout): "@@<id>:<0|1>:<base64 utf8 output>@@"  (and "@@READY@@" once warmed up)
// Scripts must not call `exit` (it would end the worker): use if/else.
const BOOTSTRAP_LOOP = `
Write-Output '@@READY@@'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $i = $line.IndexOf(':')
  if ($i -lt 1) { continue }
  $id = $line.Substring(0, $i)
  $ok = 1
  $text = ''
  try {
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($i + 1)))
    $text = (& ([scriptblock]::Create($code)) | Out-String).Trim()
  } catch { $ok = 0; $text = $_.Exception.Message }
  [Console]::Out.WriteLine('@@' + $id + ':' + $ok + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) + '@@')
  [Console]::Out.Flush()
}
`;

class PsSession {
  constructor({ exe = 'powershell.exe', args, prelude = '', idleMs = 90000, readyTimeoutMs = 20000, spawnImpl = spawn, log } = {}) {
    this.exe = exe;
    this.args = args || ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    this.prelude = prelude;
    this.idleMs = idleMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.log = log || { info() {}, warn() {} };
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.chain = Promise.resolve();
    this.idleTimer = null;
    this.startedCount = 0;
  }

  get alive() { return !!this.child; }

  _start() {
    if (this.child) return this.ready;
    const script = '$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n' + this.prelude + '\n' + BOOTSTRAP_LOOP;
    const child = this.spawnImpl(this.exe, [...this.args, '-EncodedCommand', encode(script)], { windowsHide: true });
    this.child = child;
    this.startedCount++;
    let buf = '';
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    this.ready = ready;
    const readyTimer = setTimeout(() => resolveReady(false), this.readyTimeoutMs);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === '@@READY@@') { clearTimeout(readyTimer); resolveReady(true); continue; }
        const m = /^@@(\d+):([01]):([A-Za-z0-9+/=]*)@@$/.exec(line);
        if (!m) continue;
        const p = this.pending.get(m[1]);
        if (!p) continue;
        this.pending.delete(m[1]);
        clearTimeout(p.timer);
        p.resolve({ code: m[2] === '1' ? 0 : 1, stdout: Buffer.from(m[3], 'base64').toString('utf8'), stderr: '' });
      }
    });
    child.stderr.on('data', () => {});
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      clearTimeout(readyTimer);
      resolveReady(false);
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ code: -1, stdout: '', stderr: 'PowerShell session ended' }); this.pending.delete(id); }
    };
    child.on('error', gone);
    child.on('close', gone);
    return ready;
  }

  _kill() {
    const c = this.child;
    this.child = null;
    this.ready = null;
    clearTimeout(this.idleTimer);
    if (c) { try { c.kill(); } catch (_) { /* ignore */ } }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ code: -2, stdout: '', stderr: '(timed out)' }); this.pending.delete(id); }
  }

  // Warms the worker up in the background (call this when the user starts talking).
  warm() {
    clearTimeout(this.idleTimer);
    this._start();
    this._armIdle();
  }

  _armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.pending.size) this._kill(); else this._armIdle(); }, this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  run(script, { timeoutMs = 20000 } = {}) {
    const job = this.chain.then(() => this._runOne(script, timeoutMs));
    this.chain = job.catch(() => {});
    return job;
  }

  async _runOne(script, timeoutMs) {
    const started = Date.now();
    const ready = await Promise.race([this._start(), new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
    if (!ready) { this._kill(); return { code: -2, stdout: '', stderr: '(session did not start in time)' }; }
    const left = Math.max(500, timeoutMs - (Date.now() - started));
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // a hung UI Automation call cannot be cancelled: drop the worker, the next call starts a fresh one
        this.log.warn('PowerShell session call timed out, restarting it');
        this._kill();
      }, left);
      this.pending.set(id, { resolve, timer });
      try { this.child.stdin.write(id + ':' + Buffer.from(script, 'utf8').toString('base64') + '\n'); } catch (e) { this.pending.delete(id); clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e.message) }); }
      this._armIdle();
    });
  }

  dispose() { this._kill(); }
}

// Shared worker for UI Automation. Falls back to a one-shot process if the worker cannot start.
let shared = null;
function getSharedSession(prelude, opts) {
  if (!shared) shared = new PsSession(Object.assign({ prelude }, opts));
  return shared;
}
async function runPowerShellFast(script, { timeoutMs = 20000, prelude = '' } = {}) {
  if (!isWindows()) return runPowerShell(script, { timeoutMs });
  const s = getSharedSession(prelude);
  const r = await s.run(script, { timeoutMs });
  if (r.code === -1 && /did not start|session ended/.test(r.stderr)) return runPowerShell(script, { timeoutMs });
  return r;
}
function warmSharedSession(prelude) {
  if (!isWindows()) return;
  getSharedSession(prelude).warm();
}
function disposeSharedSession() { if (shared) { shared.dispose(); shared = null; } }

module.exports = { runPowerShell, psQuote, encode, isWindows, PsSession, runPowerShellFast, warmSharedSession, disposeSharedSession };
