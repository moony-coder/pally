'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { EdgeVoice, cleanForEdge, xmlEscape, sniffAudioMime, VOICES } = require('../../src/main/edge-tts');

// A stand-in for the msedge-tts package, so no network is needed.
function fakeLib({ payload = Buffer.from('ID3fakeaudio'), delay = 0, failSetMetadata = 0, hang = false, emptyAudio = false } = {}) {
  const log = { created: 0, metadata: [], texts: [], closed: 0 };
  class MsEdgeTTS {
    constructor() { log.created++; this.n = 0; }
    async setMetadata(voice, fmt) {
      if (failSetMetadata-- > 0) throw new Error('format not supported');
      log.metadata.push([voice, fmt]);
    }
    toStream(text) {
      log.texts.push(text);
      const s = new EventEmitter();
      s.destroy = () => { s.destroyed = true; };
      if (!hang) setTimeout(() => { if (!emptyAudio) s.emit('data', payload); s.emit('end'); s.emit('close'); }, delay);
      return Promise.resolve({ audioStream: s });
    }
    close() { log.closed++; }
  }
  return { lib: { MsEdgeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3fmt', WEBM_24KHZ_16BIT_MONO_OPUS: 'opusfmt' } }, log };
}

test('cleanForEdge strips markdown, emoji and control characters; xmlEscape protects SSML', () => {
  assert.equal(cleanForEdge('**hello** `world` \u{1F600}\n\tgood   day'), 'hello world good day');
  assert.equal(xmlEscape(`a & b <c> "d" 'e'`), 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
  assert.ok(VOICES.some(([id]) => id === 'en-US-AvaMultilingualNeural'));
});

test('sniffAudioMime recognises mp3, wav, ogg and webm', () => {
  assert.equal(sniffAudioMime(Buffer.from('RIFF....WAVEfmt ')), 'audio/wav');
  assert.equal(sniffAudioMime(Buffer.from('ID3\x04\x00')), 'audio/mpeg');
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg');
  assert.equal(sniffAudioMime(Buffer.from('OggS\x00')), 'audio/ogg');
  assert.equal(sniffAudioMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])), 'audio/webm');
});

test('synthesize returns audio, escapes the text, and reuses the connection', async () => {
  const { lib, log } = fakeLib();
  const v = new EdgeVoice({ loader: () => lib });
  const a = await v.synthesize('hello & welcome <friend>', { voice: 'en-US-AndrewNeural' });
  assert.equal(a.toString(), 'ID3fakeaudio');
  assert.equal(log.texts[0], 'hello &amp; welcome friend'); // < > are dropped for speech, & is escaped for SSML
  assert.deepEqual(log.metadata[0], ['en-US-AndrewNeural', 'mp3fmt']);
  await v.synthesize('second sentence', { voice: 'en-US-AndrewNeural' });
  assert.equal(log.created, 1); // pooled, no second handshake
  await v.synthesize('another voice', { voice: 'en-US-AriaNeural' });
  assert.equal(log.created, 2);
  v.dispose();
  assert.ok(log.closed >= 2);
});

test('parallel sentences each get their own connection', async () => {
  const { lib, log } = fakeLib({ delay: 20 });
  const v = new EdgeVoice({ loader: () => lib });
  const out = await Promise.all(['one', 'two', 'three'].map((t) => v.synthesize(t, {})));
  assert.equal(out.length, 3);
  assert.equal(log.created, 3);
  v.dispose();
});

test('falls back to the Opus format if MP3 is refused', async () => {
  const { lib, log } = fakeLib({ failSetMetadata: 1 });
  const v = new EdgeVoice({ loader: () => lib });
  await v.synthesize('hi', {});
  assert.equal(log.metadata[0][1], 'opusfmt');
  v.dispose();
});

test('a stalled connection times out instead of freezing speech', async () => {
  const { lib, log } = fakeLib({ hang: true });
  const v = new EdgeVoice({ loader: () => lib, timeoutMs: 60 });
  await assert.rejects(() => v.synthesize('hi', {}), /took too long/);
  assert.equal(log.closed, 1); // the broken connection is discarded, not reused
  assert.equal(v.failures, 1);
});

test('abort returns null quickly and empty audio is an error', async () => {
  const { lib } = fakeLib({ hang: true });
  const v = new EdgeVoice({ loader: () => lib, timeoutMs: 5000 });
  const ac = new AbortController();
  const p = v.synthesize('hi', { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.equal(await p, null);
  const { lib: lib2 } = fakeLib({ emptyAudio: true });
  const v2 = new EdgeVoice({ loader: () => lib2 });
  await assert.rejects(() => v2.synthesize('hi', {}), /no audio/);
});

test('missing package gives a clear, fixable message (and the app can fall back)', async () => {
  const v = new EdgeVoice({ loader: () => { throw new Error('Cannot find module'); } });
  assert.equal(v.available(), false);
  await assert.rejects(() => v.synthesize('hi', {}), /npm install/);
});

test('empty or symbol-only text produces no audio request', async () => {
  const { lib, log } = fakeLib();
  const v = new EdgeVoice({ loader: () => lib });
  assert.equal(await v.synthesize('  **  ', {}), null);
  assert.equal(log.created, 0);
});
