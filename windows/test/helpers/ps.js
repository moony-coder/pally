'use strict';
/* Finds a real PowerShell for tests: PWSH_PATH, then pwsh, then powershell(.exe). Returns null when none exists. */
const { spawnSync } = require('child_process');

function findPowerShell() {
  const candidates = [process.env.PWSH_PATH, 'pwsh', process.platform === 'win32' ? 'powershell.exe' : 'powershell'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', env: Object.assign({}, process.env, { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }) });
    if (r.status === 0) return { exe: c, version: r.stdout.trim() };
  }
  return null;
}

// Parses scripts with the real PowerShell parser. Returns [{ name, errors: [string] }].
//
// The scripts go through a temporary file instead of -EncodedCommand: Windows powershell.exe
// has a 32,767 character command line, and the complete UIA script set is larger than that
// (the Linux run passed only because pwsh has no such limit).
function parseScripts(ps, scripts) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const base = process.env.SIDEKICK_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'sidekick-psparse-'));
  const payloadFile = path.join(dir, 'payload.b64');
  const runnerFile = path.join(dir, 'parse.ps1');
  try {
    fs.writeFileSync(payloadFile, Buffer.from(JSON.stringify(scripts), 'utf8').toString('base64'));
    // ASCII only: powershell.exe -File decodes scripts using the system code page unless there is a BOM.
    fs.writeFileSync(
      runnerFile,
      "$ErrorActionPreference = 'Stop'\n" +
        "$payload = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'payload.b64') -Raw\n" +
        '$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.Trim())) | ConvertFrom-Json\n' +
        '$res = @(); foreach ($s in $j) { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($s.script, [ref]$t, [ref]$e); $res += [pscustomobject]@{ name = $s.name; errors = @($e | ForEach-Object { $_.Message + \' (line \' + $_.Extent.StartLineNumber + \')\' }) } }\n' +
        'ConvertTo-Json -InputObject @($res) -Compress -Depth 4\n',
      'ascii'
    );
    const r = spawnSync(ps.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerFile], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: Object.assign({}, process.env, { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }),
    });
    if (r.status !== 0) throw new Error('PowerShell parse run failed: ' + (r.stderr || r.stdout || 'exit ' + r.status));
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { findPowerShell, parseScripts };
