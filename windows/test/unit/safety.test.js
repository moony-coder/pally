'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/main/safety');

test('risky names: every action you listed asks', () => {
  for (const n of ['Delete', 'Delete forever', 'Send', 'Send message', 'Pay now', 'Install', 'Sign out', 'Log out', 'Sign-out', 'Close', 'Close window', 'Exit', 'Quit', 'Empty Recycle Bin', 'Recycle Bin', 'Uninstall', 'Place order', 'Shut down', 'Restart now', 'Format disk', 'Discard changes']) assert.ok(S.isRiskyName(n), n);
});
test('risky names: harmless names do not nag', () => {
  for (const n of ['Save', 'Open', 'Search', 'Postcard maker', 'Resent items', 'Settings', 'Next', 'File menu', 'Reply']) assert.ok(!S.isRiskyName(n), n);
});
test('risky keys: all the ways to delete, close, send, lock', () => {
  for (const k of ['alt+f4', 'ALT+F4', 'f4+alt', 'delete', 'del', 'shift+delete', 'ctrl+shift+delete', 'ctrl+alt+delete', 'ctrl+w', 'control+w', 'ctrl+f4', 'ctrl+shift+w', 'ctrl+enter', 'win+l', 'windows+l', 'ctrl+c, delete', 'ctrl+l then alt+f4']) assert.ok(S.isRiskyKeys(k), k);
});
test('risky keys: ordinary shortcuts are fine', () => {
  for (const k of ['ctrl+c', 'ctrl+v', 'ctrl+l', 'enter', 'tab', 'alt+tab', 'win', 'ctrl+shift+t', 'backspace', 'ctrl+a', 'f5', 'win+left', 'escape']) assert.ok(!S.isRiskyKeys(k), k);
});
test('launch blocklist', () => {
  for (const n of ['cmd', 'CMD.EXE', 'powershell', 'pwsh', 'wt', 'regedit', 'msiexec', 'winget', 'app setup', 'Vendor-Installer']) assert.ok(S.isBlockedLaunch(n), n);
  for (const n of ['notepad', 'calc', 'chrome', 'spotify', 'Visual Studio Code', 'paint']) assert.ok(!S.isBlockedLaunch(n), n);
});
test('access rules: block list, allow list, unknown window', () => {
  assert.equal(S.checkAccess({ blockedApps: ['bitwarden'] }, { title: 'Bitwarden', app: '' }).allowed, false);
  assert.equal(S.checkAccess({ blockedApps: ['bitwarden'] }, { title: 'Notepad', app: 'notepad' }).allowed, true);
  assert.equal(S.checkAccess({ accessMode: 'allowlist', allowedApps: ['excel'] }, { title: 'Book1 - Excel', app: 'EXCEL' }).allowed, true);
  assert.equal(S.checkAccess({ accessMode: 'allowlist', allowedApps: ['excel'] }, { title: 'Notes', app: 'notepad' }).allowed, false);
  assert.equal(S.checkAccess({ accessMode: 'allowlist', allowedApps: ['excel'] }, { title: '', app: '' }).allowed, false, 'cannot verify -> refuse');
  assert.equal(S.checkAccess({}, { title: '', app: '' }).allowed, true);
});
test('extra always-ask words are additive only', () => {
  assert.ok(S.isRiskyName('Archive project', ['archive']));
  assert.ok(S.isRiskyName('Delete', []), 'built-in words cannot be removed');
  assert.ok(S.isRiskyName('Delete', undefined));
});
