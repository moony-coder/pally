'use strict';
/*
 * Natural-sounding speech from Microsoft's neural voices (the "Read aloud" engine behind Edge).
 *
 *   - free, no key, no account, about 300-600 ms to the first audio on a normal connection
 *   - sounds like a person (Ava, Andrew, Emma, Brian, ...), unlike the small offline Kokoro model
 *   - it is an UNOFFICIAL endpoint (Microsoft can change it). That is why this file never throws past its
 *     caller in a way that stops the app: main.js falls back to Kokoro, then to the Windows voice.
 *
 * Uses the maintained `msedge-tts` package (npm install msedge-tts). It is loaded lazily, so the app still starts
 * if the package is missing; synthesize() then rejects with a clear message and the fallback voice speaks.
 */

const FORMAT_MP3 = 'audio-24khz-48kbitrate-mono-mp3';
const FORMAT_OPUS = 'webm-24khz-16bit-mono-opus';

// Voices worth offering. Any valid Edge voice name also works if typed into settings.json (edgeVoice).
const VOICES = [
  ['en-US-AvaMultilingualNeural', 'Ava (female, very natural)'],
  ['en-US-AndrewMultilingualNeural', 'Andrew (male, warm)'],
  ['en-US-EmmaMultilingualNeural', 'Emma (female, friendly)'],
  ['en-US-BrianMultilingualNeural', 'Brian (male, calm)'],
  ['en-US-AriaNeural', 'Aria (female, expressive)'],
  ['en-US-JennyNeural', 'Jenny (female, assistant)'],
  ['en-US-GuyNeural', 'Guy (male)'],
  ['en-GB-SoniaNeural', 'Sonia (British female)'],
  ['en-GB-RyanNeural', 'Ryan (British male)'],
  ['ru-RU-SvetlanaNeural', 'Svetlana (Russian female)'],
  ['uz-UZ-MadinaNeural', 'Madina (Uzbek female)'],
];

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Keep it speakable: no markdown/emoji/control characters, one line.
function cleanForEdge(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[*_`#~^|<>[\]{}]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sniffAudioMime(buf) {
  const b = Buffer.from(buf.subarray ? buf.subarray(0, 12) : buf);
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'RIFF') return 'audio/wav';
  if (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  return 'audio/wav';
}

class EdgeVoice {
  constructor({ log, loader, timeoutMs = 12000, maxIdle = 2, idleMs = 45000 } = {}) {
    this.log = log || { info() {}, warn() {}, error() {} };
    this.loader = loader || (() => require('msedge-tts'));
    this.timeoutMs = timeoutMs;
    this.maxIdle = maxIdle;
    this.idleMs = idleMs;
    this.lib = null;
    this.pool = []; // idle, ready-to-use connections: { tts, voice, timer }
    this.failures = 0;
    this.lastError = '';
  }

  _lib() {
    if (!this.lib) {
      try {
        this.lib = this.loader();
      } catch (e) {
        throw new Error('The natural voice needs one more install step: run "npm install" in the Sidekick folder (package msedge-tts).');
      }
    }
    return this.lib;
  }

  available() {
    try {
      this._lib();
      return true;
    } catch (_) {
      return false;
    }
  }

  async _connect(voice) {
    const lib = this._lib();
    const tts = new lib.MsEdgeTTS();
    const formats = lib.OUTPUT_FORMAT || {};
    try {
      await tts.setMetadata(voice, formats.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || FORMAT_MP3);
    } catch (e) {
      // Some builds only offer the Opus/WebM output. Chromium plays it as well.
      await tts.setMetadata(voice, formats.WEBM_24KHZ_16BIT_MONO_OPUS || FORMAT_OPUS);
    }
    return tts;
  }

  async _acquire(voice) {
    const i = this.pool.findIndex((p) => p.voice === voice);
    if (i >= 0) {
      const [p] = this.pool.splice(i, 1);
      clearTimeout(p.timer);
      return p.tts;
    }
    return this._connect(voice);
  }

  _release(voice, tts) {
    if (this.pool.length >= this.maxIdle) return this._close(tts);
    const entry = { tts, voice, timer: null };
    entry.timer = setTimeout(() => {
      this.pool = this.pool.filter((p) => p !== entry);
      this._close(tts);
    }, this.idleMs);
    if (entry.timer.unref) entry.timer.unref();
    this.pool.push(entry);
    return undefined;
  }

  _close(tts) {
    try {
      if (tts && typeof tts.close === 'function') tts.close();
    } catch (_) {
      /* ignore */
    }
  }

  dispose() {
    for (const p of this.pool) {
      clearTimeout(p.timer);
      this._close(p.tts);
    }
    this.pool = [];
  }

  // -> Buffer with MP3 (or WebM/Opus) audio
  async synthesize(text, { voice = 'en-US-AvaMultilingualNeural', signal } = {}) {
    const clean = cleanForEdge(text);
    if (!clean) return null;
    if (signal && signal.aborted) return null;
    let tts = null;
    let ok = false;
    try {
      tts = await this._acquire(voice);
      if (signal && signal.aborted) return null;
      const res = await tts.toStream(xmlEscape(clean));
      const stream = res && res.audioStream ? res.audioStream : res;
      const buf = await new Promise((resolve, reject) => {
        const chunks = [];
        let done = false;
        const finish = (err, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve(value);
        };
        const timer = setTimeout(() => {
          try { if (stream && stream.destroy) stream.destroy(); } catch (_) { /* ignore */ }
          finish(new Error('The natural voice took too long to answer.'));
        }, this.timeoutMs);
        const onAbort = () => {
          try { if (stream && stream.destroy) stream.destroy(); } catch (_) { /* ignore */ }
          finish(null, null);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        stream.on('data', (c) => chunks.push(Buffer.from(c)));
        stream.on('error', (e) => finish(e));
        stream.on('end', () => finish(null, Buffer.concat(chunks)));
        stream.on('close', () => finish(null, Buffer.concat(chunks)));
      });
      if (!buf) return null; // aborted
      if (!buf.length) throw new Error('The natural voice returned no audio.');
      ok = true;
      this.failures = 0;
      return buf;
    } catch (e) {
      this.failures++;
      this.lastError = (e && e.message) || String(e);
      throw e;
    } finally {
      if (tts) {
        if (ok) this._release(voice, tts);
        else this._close(tts);
      }
    }
  }
}

module.exports = { EdgeVoice, VOICES, cleanForEdge, xmlEscape, sniffAudioMime, FORMAT_MP3, FORMAT_OPUS };
