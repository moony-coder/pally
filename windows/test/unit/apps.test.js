'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppIndex, resolveApp, parseStartApps, scoreName, normalize, stripFiller, launchScript, isBlockedApp } = require('../../src/main/apps');

const START_APPS = [
  'Google Chrome\t{6D809377-6AF0-444B-8957-A3773F02200E}\\Google\\Chrome\\Application\\chrome.exe',
  'Chrome Remote Desktop\t{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Google\\Chrome Remote Desktop\\crd.exe',
  'Microsoft Edge\tMSEdge',
  'Calculator\tMicrosoft.WindowsCalculator_8wekyb3d8bbwe!App',
  'Settings\twindows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel',
  'Spotify\tSpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
  'WhatsApp\t5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
  'Telegram Desktop\t{6D809377-6AF0-444B-8957-A3773F02200E}\\Telegram Desktop\\Telegram.exe',
  'Visual Studio Code\t{6D809377-6AF0-444B-8957-A3773F02200E}\\Microsoft VS Code\\Code.exe',
  'Notepad\tMicrosoft.WindowsNotepad_8wekyb3d8bbwe!App',
  'File Explorer\tMicrosoft.Windows.Explorer',
  'Word\t{6D809377-6AF0-444B-8957-A3773F02200E}\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
  'Windows PowerShell\t{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
  'Command Prompt\t{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe',
  'Registry Editor\t{F38BF404-1D43-42F2-9305-67DE0B28FC23}\\regedit.exe',
  'Uninstall Spotify\tspotify-uninstall',
  'Discord\t{6D809377-6AF0-444B-8957-A3773F02200E}\\Discord\\Update.exe',
  'Task Manager\tMicrosoft.Windows.TaskManager',
].join('\r\n');

const apps = parseStartApps(START_APPS);
const open = (q) => { const r = resolveApp(q, apps); return r && r.app.name; };

test('parse: blocked shells and installers never enter the index', () => {
  const names = apps.map((a) => a.name);
  for (const bad of ['Windows PowerShell', 'Command Prompt', 'Registry Editor']) assert.ok(!names.includes(bad), bad);
  assert.ok(names.includes('Google Chrome') && names.includes('WhatsApp'));
  assert.equal(isBlockedApp('Windows Terminal'), true);
  assert.equal(isBlockedApp('Spotify'), false);
});

test('resolve: everyday spoken names find the right app', () => {
  assert.equal(open('chrome'), 'Google Chrome');
  assert.equal(open('google chrome'), 'Google Chrome');
  assert.equal(open('the chrome browser'), 'Google Chrome');
  assert.equal(open('edge'), 'Microsoft Edge');
  assert.equal(open('calculator'), 'Calculator');
  assert.equal(open('calc'), 'Calculator');
  assert.equal(open('settings'), 'Settings');
  assert.equal(open('spotify'), 'Spotify');
  assert.equal(open('whatsapp'), 'WhatsApp');
  assert.equal(open('telegram'), 'Telegram Desktop');
  assert.equal(open('vs code'), 'Visual Studio Code');
  assert.equal(open('vscode'), 'Visual Studio Code');
  assert.equal(open('notepad'), 'Notepad');
  assert.equal(open('file explorer'), 'File Explorer');
  assert.equal(open('explorer'), 'File Explorer');
  assert.equal(open('word'), 'Word');
  assert.equal(open('microsoft word'), 'Word');
  assert.equal(open('task manager'), 'Task Manager');
  assert.equal(open('my discord app'), 'Discord');
});

test('resolve: plain "chrome" beats "Chrome Remote Desktop"; "Spotify" beats "Uninstall Spotify"', () => {
  assert.equal(open('chrome'), 'Google Chrome');
  assert.equal(open('spotify'), 'Spotify');
});

test('resolve: speech-to-text slips still match', () => {
  assert.equal(open('spotifi'), 'Spotify');
  assert.equal(open('telegrem'), 'Telegram Desktop');
  assert.equal(open('calculater'), 'Calculator');
  assert.equal(open('node path'), 'Notepad');
  assert.equal(open('from browser'), 'Google Chrome');
  assert.equal(open('front browser'), 'Google Chrome');
});

test('resolve: things that are not apps, or are blocked, do not match', () => {
  assert.equal(open('the pod bay doors'), null);
  assert.equal(open('a new tab'), null);
  assert.equal(open('powershell'), null);
  assert.equal(open('command prompt'), null);
  assert.equal(open('cmd'), null);
  assert.equal(open('regedit'), null);
  assert.equal(open(''), null);
});

test('scoreName basics', () => {
  assert.equal(scoreName('word', 'word'), 100);
  assert.ok(scoreName('chrome', 'google chrome') > scoreName('chrome', 'google chrome remote desktop'));
  assert.equal(scoreName('xyz', 'google chrome'), 0);
  assert.equal(normalize('  Café & Co. '), 'cafe and co');
  assert.equal(stripFiller('Please open the Spotify app'), 'open the spotify');
});

test('launch script quotes the AppID and goes through explorer shell:AppsFolder', () => {
  const s = launchScript("My'App!x");
  assert.match(s, /explorer\.exe/);
  assert.match(s, /shell:AppsFolder/);
  assert.ok(s.includes("'My''App!x'"));
});

test('AppIndex: indexes once, caches to disk, opens by AppID', async () => {
  const calls = [];
  const run = async (script) => {
    calls.push(script);
    if (/Get-StartApps/.test(script)) return { code: 0, stdout: START_APPS };
    return { code: 0, stdout: 'ok' };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  const cacheFile = path.join(dir, 'apps.json');
  const idx = new AppIndex({ run, cacheFile });
  const r = await idx.open('spotify');
  assert.deepEqual({ ok: r.ok, opened: r.opened }, { ok: true, opened: 'Spotify' });
  assert.ok(calls.some((c) => c.includes('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')));
  await idx.open('whatsapp');
  assert.equal(calls.filter((c) => /Get-StartApps/.test(c)).length, 1); // list fetched once
  assert.ok(fs.existsSync(cacheFile));
  // a second run starts from the disk cache without calling PowerShell for the list
  const calls2 = [];
  const idx2 = new AppIndex({ run: async (s) => { calls2.push(s); return { code: 0, stdout: 'ok' }; }, cacheFile });
  const r2 = await idx2.open('chrome');
  assert.equal(r2.ok, true);
  assert.equal(calls2.filter((c) => /Get-StartApps/.test(c)).length, 0);
});

test('AppIndex: unknown app reports notFound; failed launch reports an error', async () => {
  const idx = new AppIndex({ run: async (s) => (/Get-StartApps/.test(s) ? { code: 0, stdout: START_APPS } : { code: 1, stdout: '' }) });
  const nf = await idx.open('flux capacitor');
  assert.equal(nf.ok, false);
  assert.equal(nf.notFound, true);
  const bad = await idx.open('notepad');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /would not start/i);
});

test('AppIndex: an empty Start menu list does not crash', async () => {
  const idx = new AppIndex({ run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
  const r = await idx.open('chrome');
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
});
