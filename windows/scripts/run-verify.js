'use strict';
/*
 * Runs the real-Windows self-check with a throwaway profile, so it never touches the settings,
 * Groq key or chat history of the installed app.
 *
 *   npm run verify:windows
 *
 * The equivalent manual command (uses your normal profile) is:
 *   electron . --selfcheck --e2e-script=test/windows/verify.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'test', 'windows', 'out');
const userData = path.join(out, 'userdata');
const tmp = path.join(out, 'tmp');
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });

const electron = require(path.join(root, 'node_modules', 'electron'));
// --no-sandbox is only for this automated self-check: some remote/CI Windows sessions cannot start
// Chromium's sandbox. The normal app is launched without it.
const args = [root, '--no-sandbox', '--selfcheck', '--e2e-script=' + path.join(root, 'test', 'windows', 'verify.js')];
const env = Object.assign({}, process.env, {
  SIDEKICK_USER_DATA: userData,
  SIDEKICK_SELFCHECK_OUT: out,
  SIDEKICK_TEST_TMP: tmp,
  // PowerShell's Add-Type writes a temporary assembly to TEMP. Some locked-down sessions deny the
  // real user TEMP but allow the workspace, so point child PowerShell processes at our own folder.
  TEMP: tmp,
  TMP: tmp,
});
// If a previous shell exported ELECTRON_RUN_AS_NODE, Electron would start as plain Node and `app` is undefined.
delete env.ELECTRON_RUN_AS_NODE;

console.log('Running Windows self-check with an isolated profile:', userData);
console.log('Reports will be written to:', out);

const child = spawn(electron, args, { cwd: root, env, stdio: 'inherit', windowsHide: false });
const timer = setTimeout(() => {
  console.error('\nSelf-check timed out after 8 minutes.');
  try { child.kill(); } catch (_) { /* ignore */ }
  process.exitCode = 124;
}, 8 * 60 * 1000);
child.on('error', (e) => {
  clearTimeout(timer);
  console.error('Could not start Electron:', e.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  clearTimeout(timer);
  const report = path.join(out, 'report.md');
  if (fs.existsSync(report)) {
    console.log('\n' + fs.readFileSync(report, 'utf8'));
  }
  console.log('Exit code:', code);
  process.exitCode = code == null ? 1 : code;
});
