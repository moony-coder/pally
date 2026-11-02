'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, execute, timeSentence, dateSentence, psSendKeys } = require('../../src/main/quick-commands');
const { AppIndex } = require('../../src/main/apps');

const kinds = (s) => { const r = parse(s); return r && r.kind; };

test('parse: instant answers and stop', () => {
  assert.equal(kinds('What time is it?'), 'time');
  assert.equal(kinds("what's the time"), 'time');
  assert.equal(kinds('What day is it today?'), 'date');
  assert.equal(kinds("What's the date?"), 'date');
  assert.equal(kinds('Stop.'), 'stop');
  assert.equal(kinds('never mind'), 'stop');
});

test('parse: open apps, folders, domains, sites', () => {
  assert.deepEqual(parse('Open Chrome.'), { kind: 'open', target: 'chrome', webOnly: false });
  assert.deepEqual(parse('can you please launch Spotify for me'), { kind: 'open', target: 'spotify', webOnly: false });
  assert.deepEqual(parse('open the calculator app'), { kind: 'open', target: 'calculator app', webOnly: false });
  assert.equal(parse('open downloads').kind, 'folder');
  assert.equal(parse('open my documents folder').shell, 'shell:Personal');
  assert.equal(parse('open the desktop folder').shell, 'shell:Desktop');
  assert.equal(parse('open music').kind, 'open'); // "music" alone means the player
  assert.equal(parse('open music folder').kind, 'folder');
  assert.equal(parse('open github.com').url, 'https://github.com');
  assert.equal(parse('open example dot com').url, 'https://example.com');
  assert.deepEqual(parse('go to youtube'), { kind: 'open', target: 'youtube', webOnly: true });
  assert.deepEqual(parse('open a youtube'), { kind: 'open', target: 'youtube', webOnly: false });
});

test('parse: volume and media', () => {
  assert.deepEqual(parse('volume up'), { kind: 'volume', op: 'up', amount: 5 });
  assert.deepEqual(parse('turn the volume down a bit'), { kind: 'volume', op: 'down', amount: 2 });
  assert.deepEqual(parse('turn the sound up a lot'), { kind: 'volume', op: 'up', amount: 10 });
  assert.equal(parse('louder').op, 'up');
  assert.equal(parse('mute').op, 'mute');
  assert.equal(parse('unmute').op, 'mute');
  assert.deepEqual(parse('set the volume to 30 percent'), { kind: 'volume', op: 'set', percent: 30 });
  assert.equal(parse('set volume to 400').percent, 100);
  assert.deepEqual(parse('pause the music'), { kind: 'media', op: 'playpause' });
  assert.deepEqual(parse('next song'), { kind: 'media', op: 'next' });
  assert.deepEqual(parse('skip'), { kind: 'media', op: 'next' });
  assert.deepEqual(parse('previous track'), { kind: 'media', op: 'prev' });
});

test('parse: web searches', () => {
  assert.match(parse('google best pizza near me').url, /google\.com\/search\?q=best%20pizza%20near%20me/);
  assert.match(parse('play lofi beats on youtube').url, /youtube\.com\/results\?search_query=lofi%20beats/);
  assert.match(parse('open youtube and search for ronaldo short').url, /youtube\.com\/results\?search_query=ronaldo%20short/);
  assert.match(parse('go to youtube and play lofi').url, /youtube\.com\/results\?search_query=lofi/);
  assert.equal(kinds('show desktop'), 'desktop');
  assert.equal(kinds('minimize all windows'), 'desktop');
});

test('parse: questions, long sentences and compound requests are NOT hijacked', () => {
  const mustGoToAI = [
    'how do I open chrome',
    'how do i turn the volume up',
    'what is the volume of a sphere',
    'can I open a new tab here',
    'open a new tab',
    'open chrome and search for the weather in tashkent tomorrow',
    'explain how to open the settings app on windows please',
    'is the volume too loud',
    'why is my sound so quiet',
    'tell me about spotify',
    'show me where the save button is',
    'open it',
    'what does mute do',
    'play',
    '',
  ];
  for (const q of mustGoToAI) {
    const r = parse(q);
    if (q === 'play') { assert.equal(r.kind, 'media'); continue; } // bare "play" is play/pause, on purpose
    assert.equal(r, null, `should not hijack: "${q}" -> ${JSON.stringify(r)}`);
  }
});

test('parse: window, timers, and typing', () => {
  assert.deepEqual(parse('max the screen'), { kind: 'window', op: 'maximize' });
  assert.deepEqual(parse('maximize window'), { kind: 'window', op: 'maximize' });
  assert.deepEqual(parse('full screen'), { kind: 'window', op: 'maximize' });
  assert.deepEqual(parse('exit full screen'), { kind: 'window', op: 'exit_fullscreen' });
  assert.deepEqual(parse('minimize window'), { kind: 'window', op: 'minimize' });
  assert.deepEqual(parse('restore window'), { kind: 'window', op: 'restore' });

  const t5 = parse('set a timer for 5 minutes');
  assert.equal(t5.kind, 'timer');
  assert.equal(t5.op, 'set');
  assert.equal(t5.seconds, 300);

  const t30s = parse('timer 30 seconds');
  assert.equal(t30s.kind, 'timer');
  assert.equal(t30s.seconds, 30);

  assert.deepEqual(parse('cancel timer'), { kind: 'timer', op: 'cancel' });
  assert.deepEqual(parse('timer status'), { kind: 'timer', op: 'status' });

  assert.deepEqual(parse('type hello world'), { kind: 'type', text: 'hello world' });
  assert.deepEqual(parse('write from 1 to 10'), { kind: 'type', text: '1 2 3 4 5 6 7 8 9 10' });
});

test('time and date sentences read well', () => {
  assert.equal(timeSentence(new Date(2026, 10, 1, 15, 42)), "it's 3:42 pm.");
  assert.equal(timeSentence(new Date(2026, 10, 1, 0, 5)), "it's 12:05 am.");
  assert.equal(dateSentence(new Date(2026, 10, 1)), "it's sunday, november 1.");
});

const START = ['Google Chrome\tCHROME_ID', 'Spotify\tSPOT_ID', 'Calculator\tCALC_ID', 'WhatsApp\tWA_ID'].join('\n');
function deps(extra = {}) {
  const ran = [];
  const opened = [];
  const apps = new AppIndex({ run: async (s) => { ran.push(s); return /Get-StartApps/.test(s) ? { code: 0, stdout: START } : { code: 0, stdout: 'ok' }; } });
  return {
    ran, opened, apps,
    tools: { openUrl: async (u) => { opened.push(u); return { ok: true }; } },
    run: async (s) => { ran.push(s); return { code: 0, stdout: 'ok' }; },
    stop: () => { opened.push('STOP'); },
    ...extra,
  };
}

test('execute: open an installed app by AppID, with a spoken confirmation', async () => {
  const d = deps();
  const r = await execute(parse('open chrome'), d);
  assert.deepEqual(r, { handled: true, say: 'opening google chrome.' });
  assert.ok(d.ran.some((s) => s.includes('CHROME_ID')));
});

test('execute: web-only names open the site; app wins when it is installed', async () => {
  const d = deps();
  const yt = await execute(parse('open youtube'), d);
  assert.deepEqual(yt, { handled: true, say: 'opening youtube.' });
  assert.deepEqual(d.opened, ['https://www.youtube.com']);
  const wa = await execute(parse('open whatsapp'), d);
  assert.equal(wa.say, 'opening whatsapp.');
  assert.ok(d.ran.some((s) => s.includes('WA_ID'))); // installed app, not the web page
  const d2 = deps();
  d2.apps = new AppIndex({ run: async (s) => (/Get-StartApps/.test(s) ? { code: 0, stdout: 'Calculator\tCALC_ID' } : { code: 0, stdout: 'ok' }) });
  const wa2 = await execute(parse('open whatsapp'), d2);
  assert.equal(wa2.handled, true);
  assert.deepEqual(d2.opened, ['https://web.whatsapp.com']); // not installed -> web version
});

test('execute: unknown app, shells and "go to <unknown>" fall through to the AI', async () => {
  const d = deps();
  assert.deepEqual(await execute(parse('open flux capacitor'), d), { handled: false });
  assert.deepEqual(await execute(parse('open powershell'), d), { handled: false });
  assert.deepEqual(await execute(parse('open command prompt'), d), { handled: false });
  assert.deepEqual(await execute(parse('go to the moon'), d), { handled: false });
  assert.equal(d.opened.length, 0);
});

test('execute: volume, media keys and desktop send the right key codes', async () => {
  const d = deps();
  await execute(parse('volume up'), d);
  await execute(parse('mute'), d);
  await execute(parse('next song'), d);
  await execute(parse('pause'), d);
  const all = d.ran.join('\n');
  assert.match(all, /1\.\.5 .*\[char\]175/);
  assert.match(all, /\[char\]173/);
  assert.match(all, /\[char\]176/);
  assert.match(all, /\[char\]179/);
  const d2 = deps();
  const set = await execute(parse('set volume to 30'), d2);
  assert.equal(set.say, 'volume 30 percent.');
  assert.match(d2.ran[0], /1\.\.50 .*\[char\]174/);
  assert.match(d2.ran[1], /1\.\.15 .*\[char\]175/);
  const d3 = deps();
  await execute(parse('show desktop'), d3);
  assert.match(d3.ran[0], /ToggleDesktop/);
});

test('execute: folders and stop', async () => {
  const d = deps();
  const f = await execute(parse('open downloads'), d);
  assert.equal(f.say, 'opening downloads.');
  assert.match(d.ran[0], /shell:Downloads/);
  const s = await execute(parse('stop'), d);
  assert.deepEqual(s, { handled: true, say: '' });
  assert.ok(d.opened.includes('STOP'));
});

test('execute: window, timer, and typing', async () => {
  const winCalls = [];
  const typed = [];
  const timers = {
    setTimer: (sec, raw) => ({ ok: true, humanDuration: `${sec} seconds` }),
    cancelAll: () => ({ count: 1 }),
    getStatus: () => ({ humanLeft: '4 minutes' }),
  };
  const win32 = {
    getForegroundWindow: () => 1234,
    showWindow: (h, cmd) => winCalls.push([h, cmd]),
    pressCombo: (c) => winCalls.push(['press', c]),
    typeText: (t) => typed.push(t),
  };
  const d = deps({ win32, timers });

  const rMax = await execute(parse('max the screen'), d);
  assert.equal(rMax.say, 'maximizing.');
  assert.deepEqual(winCalls[0], [1234, 3]);

  const rMin = await execute(parse('minimize window'), d);
  assert.equal(rMin.say, 'minimizing.');
  assert.deepEqual(winCalls[1], [1234, 6]);

  const rFull = await execute(parse('exit full screen'), d);
  assert.equal(rFull.say, 'exiting full screen.');
  assert.deepEqual(winCalls[2], ['press', 'escape']);

  const rTimer = await execute(parse('set a timer for 5 minutes'), d);
  assert.equal(rTimer.say, 'timer set for 300 seconds.');

  const rTimerCancel = await execute(parse('cancel timer'), d);
  assert.equal(rTimerCancel.say, 'timer cancelled.');

  const rType = await execute(parse('type hello from test'), d);
  assert.equal(rType.say, 'typed.');
  assert.deepEqual(typed, ['hello from test']);
});

test('psSendKeys is bounded', () => {
  assert.match(psSendKeys(175, 9999), /1\.\.60 /);
  assert.match(psSendKeys(175, 0), /1\.\.1 /);
});
