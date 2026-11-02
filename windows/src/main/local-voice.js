'use strict';
/*
 * Local, offline, free voice for the sidekick (no Groq calls, so no rate limits):
 *   - speech to text: Whisper (ONNX) run by the sherpa-onnx command line tools
 *   - text to speech: Kokoro (ONNX) run by the sherpa-onnx command line tools
 *
 * Everything is downloaded once from the official k2-fsa/sherpa-onnx GitHub releases into the
 * app's user-data folder.
 *
 * Why this does not use api.github.com: anonymous GitHub API calls are limited to 60 per hour
 * per IP, and shared Wi-Fi / VPN egress often has already spent that budget (HTTP 403). The
 * public release pages below are normal web pages and stay available without a token:
 *   - https://github.com/k2-fsa/sherpa-onnx/releases/latest  -> redirects to /releases/tag/<tag>
 *   - https://github.com/k2-fsa/sherpa-onnx/releases/expanded_assets/<tag>
 *
 * The tools are spawned one at a time per kind (never in parallel) to stay light on small laptops.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const GITHUB = 'https://github.com/k2-fsa/sherpa-onnx';
const LATEST_URL = `${GITHUB}/releases/latest`;
const TAG_PAGE_URL = (tag) => `${GITHUB}/releases/tag/${encodeURIComponent(tag)}`;
const EXPANDED_ASSETS_URL = (tag) => `${GITHUB}/releases/expanded_assets/${encodeURIComponent(tag)}`;
const USER_AGENT = 'Sidekick-Windows-local-voice';

const WHISPER_MODELS = ['tiny.en', 'base.en', 'small.en'];
// v1.0 first: it is the model the voice picker's numbers are for (3 = Heart, 2 = Bella, 11 = Adam ...) and it
// speaks natural English. v1.1 reorders the speakers: its number 3 is a CHINESE voice (zf_001), which is what made
// English sound robotic and foreign. Full-precision (not int8) sounds noticeably clearer.
const KOKORO_PREFERENCE = [
  /^kokoro-multi-lang-v1_0\.tar\.bz2$/,
  /^kokoro-int8-multi-lang-v1_0\.tar\.bz2$/,
  /^kokoro-en-v0_19\.tar\.bz2$/,
  /^kokoro-int8-en-v0_19\.tar\.bz2$/,
  /^kokoro-multi-lang-v1_1\.tar\.bz2$/,
  /^kokoro-int8-multi-lang-v1_1\.tar\.bz2$/,
  /^kokoro.*\.tar\.bz2$/,
];

// ------------------------------------------------------------------ pure helpers (unit tested)

// Turn a release page into the assets it links. No JSON API involved.
function parseReleaseAssets(html, pageUrl) {
  const found = new Map();
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1].replace(/&amp;/g, '&').trim();
    if (!href.includes('/releases/download/') || /^#/.test(href)) continue;
    let url;
    try {
      url = new URL(href, pageUrl);
    } catch (_) {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    let name;
    try {
      name = decodeURIComponent(url.pathname.split('/').pop() || '');
    } catch (_) {
      name = url.pathname.split('/').pop() || '';
    }
    if (!name) continue;
    found.set(name, { name, url: url.href, browser_download_url: url.href });
  }
  return Array.from(found.values());
}

// The tag from a /releases/latest redirect. Accepts a Location header or a final URL.
function parseReleaseTag(location) {
  const m = /\/releases\/tag\/([^/?#]+)/.exec(String(location || ''));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (_) {
    return m[1];
  }
}

// Pick the Windows x64 command line tools archive from a release's assets.
// Prefer the self-contained static build, then the Release configuration, then MT (static C runtime,
// no Visual C++ redistributable needed). Never CUDA / DirectML / no-tts / -lib / JNI builds.
//
// The v2.0.1 release has roughly 70 Windows x64 variants, including Debug and no-tts builds.
// Ranking explicitly prevents a shorter debug filename from winning.
function pickEngineAsset(assets) {
  const bad = /cuda|directml|no-tts|jni|native-lib|\.jar$|-lib\.tar|arm|ia32|x86(?!_64)|win32|gpu|android|ios|wasm|dotnet|csharp/i;
  const candidates = (assets || []).filter(
    (a) => a && a.name && /win-x64/i.test(a.name) && /\.tar\.bz2$/i.test(a.name) && !bad.test(a.name)
  );
  const rank = (a) => {
    const n = a.name;
    const linkage = /static/i.test(n) ? 0 : /shared/i.test(n) ? 1 : 2;
    const config = /(^|-)Debug/i.test(n) ? 4 : /RelWithDebInfo/i.test(n) ? 3 : /MinSizeRel/i.test(n) ? 2 : /Release/i.test(n) ? 0 : 1;
    const runtime = /(^|-)MT(-|$)/i.test(n) ? 0 : /(^|-)MD(-|$)/i.test(n) ? 1 : 2;
    return [linkage, config, runtime];
  };
  candidates.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.name.length - b.name.length;
  });
  return candidates[0] || null;
}

function pickWhisperAsset(assets, modelName) {
  const wanted = `sherpa-onnx-whisper-${modelName}.tar.bz2`;
  return (assets || []).find((a) => a && a.name === wanted) || null;
}

// Kokoro v1.1 only has three English voices (0 af_maple, 1 af_sol, 2 bf_vale); every other number is Chinese.
// Older installs picked v1.1 and speaker 3 by default, so map any non-English number to an English voice.
function fixSpeakerForVariant(speaker, variant) {
  const sid = Number.isFinite(Number(speaker)) ? Number(speaker) : 0;
  if (variant === 'v1_1') return sid >= 0 && sid <= 2 ? sid : 0;
  return sid;
}

function pickKokoroAsset(assets) {
  const list = assets || [];
  for (const re of KOKORO_PREFERENCE) {
    const hit = list.find((a) => a && re.test(a.name));
    if (hit) return hit;
  }
  return null;
}

// Find a file in a list by regex, preferring int8 variants (smaller, faster on CPU).
function pickFile(files, re) {
  const matches = files.filter((f) => re.test(f));
  return matches.find((f) => /int8/i.test(f)) || matches[0] || null;
}

function buildWhisperArgs(modelDir, files, wavPath, { threads = 4 } = {}) {
  const encoder = pickFile(files, /encoder.*\.onnx$/i);
  const decoder = pickFile(files, /decoder.*\.onnx$/i);
  const tokens = pickFile(files, /tokens\.txt$/i);
  if (!encoder || !decoder || !tokens) return null;
  return [
    '--model-type=whisper',
    `--whisper-encoder=${path.join(modelDir, encoder)}`,
    `--whisper-decoder=${path.join(modelDir, decoder)}`,
    `--tokens=${path.join(modelDir, tokens)}`,
    `--num-threads=${threads}`,
    '--whisper-language=en',
    '--whisper-task=transcribe',
    wavPath,
  ];
}

function buildKokoroArgs(modelDir, files, dirs, { speaker = 3, speed = 1.0, threads = 2, outFile, text } = {}) {
  const model = pickFile(files, /^model.*\.onnx$/i);
  const voices = pickFile(files, /^voices.*\.bin$/i);
  const tokens = pickFile(files, /^tokens\.txt$/i);
  if (!model || !voices || !tokens) return null;
  const args = [
    `--kokoro-model=${path.join(modelDir, model)}`,
    `--kokoro-voices=${path.join(modelDir, voices)}`,
    `--kokoro-tokens=${path.join(modelDir, tokens)}`,
  ];
  if (dirs.includes('espeak-ng-data')) args.push(`--kokoro-data-dir=${path.join(modelDir, 'espeak-ng-data')}`);
  if (dirs.includes('dict')) args.push(`--kokoro-dict-dir=${path.join(modelDir, 'dict')}`);
  const lexicons = files.filter((f) => /^lexicon.*\.txt$/i.test(f));
  if (lexicons.length) args.push(`--kokoro-lexicon=${lexicons.map((f) => path.join(modelDir, f)).join(',')}`);
  args.push(`--num-threads=${threads}`, `--sid=${speaker}`, `--kokoro-length-scale=${(1 / Math.max(0.5, speed)).toFixed(2)}`);
  args.push(`--output-filename=${outFile}`);
  // sherpa-onnx-offline-tts takes the sentence as its final positional argument.
  args.push(String(text));
  return args;
}

// sherpa-onnx prints the recognition result as a JSON object containing "text": "...".
// It may be on stdout or stderr depending on the build, so both are searched, last match wins.
function parseWhisperOutput(stdout, stderr) {
  const all = `${stdout || ''}\n${stderr || ''}`;
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let last = null;
  let m;
  while ((m = re.exec(all))) last = m[1];
  if (last === null) return '';
  try {
    return JSON.parse(`"${last}"`).trim();
  } catch (_) {
    return last.trim();
  }
}

// Whisper invents text on near-silence. These are its well known fake outputs.
function looksLikeWhisperHallucination(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?,\s]+$/g, '');
  if (!t) return true;
  return /^(thanks for watching|thank you for watching|thank you|you|bye|\[blank_audio\]|\(.*\)|\[.*\])$/.test(t);
}

function cleanForSpeech(text) {
  return String(text || '')
    .replace(/\[[A-Z0-9_]+:[^\]]*\]/g, ' ')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------ class

class LocalVoice {
  constructor({ dir, log, fetchImpl, spawnImpl, execFileImpl } = {}) {
    this.dir = dir;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.spawn = spawnImpl || spawn;
    this.execFile = execFileImpl || execFile;
    this.listeners = new Set();
    this.installing = false;
    this.progress = { stage: '', percent: 0, error: '' };
    this.sttQueue = Promise.resolve();
    this.ttsQueue = Promise.resolve();
    this._assetCache = new Map();
  }

  // ---- paths
  get engineDir() { return path.join(this.dir, 'engine'); }
  get whisperDir() { return path.join(this.dir, 'whisper'); }
  get kokoroDir() { return path.join(this.dir, 'kokoro'); }
  get tmpDir() { return path.join(this.dir, 'tmp'); }

  _exe(name) {
    const found = this._findFile(this.engineDir, `${name}.exe`) || this._findFile(this.engineDir, name);
    return found;
  }

  _findFile(root, fileName, depth = 0) {
    if (depth > 4 || !fs.existsSync(root)) return null;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return path.join(root, entry.name);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const hit = this._findFile(path.join(root, entry.name), fileName, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Model archives extract into one subfolder; return the folder that holds the model files.
  _modelRoot(base) {
    if (!fs.existsSync(base)) return null;
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    if (files.some((f) => /tokens\.txt$/i.test(f.name))) return base;
    const sub = entries.find((e) => e.isDirectory());
    return sub ? this._modelRoot(path.join(base, sub.name)) : null;
  }

  // The sherpa-onnx archive ships headers, static .libs and ~20 tools we never run. Keeping only
  // the two executables and the int8 Whisper weights cuts a ~2 GB install to ~400 MB, which matters
  // on an 8 GB laptop. Only our own downloaded files are touched.
  pruneExtras({ log = false } = {}) {
    let freed = 0;
    const sizeOf = (p) => {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
        let n = 0;
        for (const e of fs.readdirSync(p, { withFileTypes: true })) n += sizeOf(path.join(p, e.name));
        return n;
      } catch (_) { return 0; }
    };
    const remove = (p) => {
      try {
        const size = sizeOf(p);
        fs.rmSync(p, { recursive: true, force: true });
        freed += size;
      } catch (_) { /* best effort */ }
    };
    try {
      const sttExe = this._exe('sherpa-onnx-offline');
      const ttsExe = this._exe('sherpa-onnx-offline-tts');
      if (sttExe && ttsExe) {
        const bin = path.dirname(sttExe);
        for (const entry of fs.readdirSync(bin, { withFileTypes: true })) {
          if (entry.isFile() && /\.exe$/i.test(entry.name) && !/^sherpa-onnx-offline(-tts)?\.exe$/i.test(entry.name)) remove(path.join(bin, entry.name));
        }
        const root = path.dirname(bin);
        for (const dir of ['include', 'lib']) remove(path.join(root, dir));
      }
      const whisper = this._modelRoot(this.whisperDir);
      if (whisper) {
        const files = fs.readdirSync(whisper, { withFileTypes: true });
        for (const entry of files) {
          if (!entry.isFile() || !/\.onnx$/i.test(entry.name) || /int8/i.test(entry.name)) continue;
          const int8 = path.join(whisper, entry.name.replace(/\.onnx$/i, '.int8.onnx'));
          if (fs.existsSync(int8)) remove(path.join(whisper, entry.name));
        }
        for (const entry of files) {
          if (entry.isDirectory() && /^test_wavs$/i.test(entry.name)) remove(path.join(whisper, entry.name));
        }
      }
      const kokoro = this._modelRoot(this.kokoroDir);
      if (kokoro) {
        for (const entry of fs.readdirSync(kokoro, { withFileTypes: true })) {
          if (entry.isDirectory() && /^test_wavs$/i.test(entry.name)) remove(path.join(kokoro, entry.name));
        }
      }
      if (log) this.log.info('local voice pruned', { freedMB: Math.round(freed / (1024 * 1024)) });
    } catch (e) {
      if (log) this.log.warn('local voice prune skipped', e && e.message);
    }
    return { freed };
  }

  _listDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return { files: entries.filter((e) => e.isFile()).map((e) => e.name), dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name) };
  }

  _engineReady() {
    return !!(this._exe('sherpa-onnx-offline') && this._exe('sherpa-onnx-offline-tts'));
  }

  // Which Kokoro build is installed: 'v1_0', 'v1_1', 'v0_19' or ''. The speaker numbers differ between them.
  kokoroVariant() {
    const root = this._modelRoot(this.kokoroDir);
    if (!root) return '';
    const m = /(v1_1|v1_0|v0_19)/.exec(path.basename(root));
    return m ? m[1] : '';
  }

  status() {
    const stt = !!(this._exe('sherpa-onnx-offline') && this._modelRoot(this.whisperDir));
    const tts = !!(this._exe('sherpa-onnx-offline-tts') && this._modelRoot(this.kokoroDir));
    return { stt, tts, ttsVariant: tts ? this.kokoroVariant() : '', installing: this.installing, progress: this.progress };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(patch) {
    this.progress = Object.assign({}, this.progress, patch);
    for (const fn of this.listeners) {
      try { fn(this.status()); } catch (_) { /* ignore */ }
    }
  }

  // ---- install (public GitHub pages only, never api.github.com)

  // Follow the /releases/latest redirect. GitHub answers 302; reading only the Location header
  // avoids downloading the release page at all.
  async resolveLatestTag() {
    const res = await this.fetch(LATEST_URL, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
    let tag = parseReleaseTag(res.headers && res.headers.get && res.headers.get('location'));
    if (!tag) tag = parseReleaseTag(res.url);
    if (!tag) {
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking up the latest voice engine release.`);
      // A proxy or a test double may have followed the redirect: look for a tag link in the body.
      const body = await res.text().catch(() => '');
      const m = /\/releases\/tag\/(v?[0-9][^"'?#/]*)/.exec(body);
      if (m) tag = parseReleaseTag(m[0]);
    }
    if (!tag) throw new Error('Could not find the latest sherpa-onnx release (GitHub did not redirect to a tag).');
    this.log.info('local voice: latest sherpa-onnx tag', tag);
    return tag;
  }

  async _assets(tag) {
    if (this._assetCache.has(tag)) return this._assetCache.get(tag);
    const url = EXPANDED_ASSETS_URL(tag);
    const res = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Could not read the release page for ${tag} (HTTP ${res.status}).`);
    const html = await res.text();
    const assets = parseReleaseAssets(html, url);
    if (!assets.length) throw new Error(`The release page for ${tag} did not list any downloadable files.`);
    this._assetCache.set(tag, assets);
    this.log.info('local voice: release assets', { tag, count: assets.length });
    return assets;
  }

  _assetUrl(asset) {
    return asset.browser_download_url || asset.url;
  }

  async _download(url, file, label, basePercent, spanPercent) {
    const started = Date.now();
    this.log.info('local voice: download start', { label, url });
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${label}`);
        const total = Number(res.headers.get('content-length')) || 0;
        let received = 0;
        let lastEmit = 0;
        const source = Readable.fromWeb(res.body);
        source.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            const frac = total ? received / total : 0;
            this._emit({ stage: `Downloading ${label}`, percent: Math.round(basePercent + frac * spanPercent) });
          }
        });
        await pipeline(source, fs.createWriteStream(file));
        if (total && fs.statSync(file).size !== total) {
          throw new Error(`The ${label} download was interrupted (${fs.statSync(file).size} of ${total} bytes).`);
        }
        this.log.info('local voice: download done', { label, bytes: fs.statSync(file).size, ms: Date.now() - started });
        return;
      } catch (e) {
        lastError = e;
        fs.rmSync(file, { force: true });
        if (attempt === 0) {
          this.log.warn('local voice: download retry', { label, error: e.message });
          await new Promise((r) => setTimeout(r, 900));
        }
      }
    }
    throw new Error(`Could not download ${label}. ${(lastError && lastError.message) || ''}`.trim());
  }

  _extract(archive, destination) {
    fs.mkdirSync(destination, { recursive: true });
    return new Promise((resolve, reject) => {
      // tar.exe ships with Windows 10 (1803+) and 11 and reads .tar.bz2.
      this.execFile('tar', ['-xjf', archive, '-C', destination], { windowsHide: true, timeout: 8 * 60 * 1000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`Could not extract ${path.basename(archive)}: ${(stderr || err.message || '').toString().slice(0, 300)}`));
        else resolve();
      });
    });
  }

  async install({ whisperModel = 'base.en', want = { stt: true, tts: true } } = {}) {
    if (this.installing) return this.status();
    const model = WHISPER_MODELS.includes(whisperModel) ? whisperModel : 'base.en';
    this.installing = true;
    this._emit({ stage: 'Starting', percent: 1, error: '' });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    try {
      if (!this._engineReady()) {
        this._emit({ stage: 'Finding the voice engine', percent: 2 });
        const tag = await this.resolveLatestTag();
        const assets = await this._assets(tag);
        const asset = pickEngineAsset(assets);
        if (!asset) throw new Error('The latest sherpa-onnx release has no self-contained Windows x64 build.');
        this.log.info('local voice: engine chosen', { tag, asset: asset.name });
        const file = path.join(this.tmpDir, asset.name);
        await this._download(this._assetUrl(asset), file, 'voice engine', 3, 18);
        this._emit({ stage: 'Unpacking the voice engine', percent: 22 });
        fs.rmSync(this.engineDir, { recursive: true, force: true });
        await this._extract(file, this.engineDir);
        fs.rmSync(file, { force: true });
        if (!this._engineReady()) throw new Error('The voice engine archive did not contain both sherpa-onnx-offline.exe and sherpa-onnx-offline-tts.exe.');
      }
      if (want.stt && !this._modelRoot(this.whisperDir)) {
        this._emit({ stage: 'Finding the Whisper model', percent: 26 });
        const assets = await this._assets('asr-models');
        const asset = pickWhisperAsset(assets, model);
        if (!asset) throw new Error(`The asr-models release has no Whisper ${model} archive.`);
        this.log.info('local voice: whisper chosen', { asset: asset.name });
        const file = path.join(this.tmpDir, asset.name);
        await this._download(this._assetUrl(asset), file, `Whisper ${model}`, 27, 31);
        this._emit({ stage: 'Unpacking Whisper', percent: 59 });
        fs.rmSync(this.whisperDir, { recursive: true, force: true });
        await this._extract(file, this.whisperDir);
        fs.rmSync(file, { force: true });
        if (!this._modelRoot(this.whisperDir)) throw new Error('The Whisper archive did not contain a tokens.txt model folder.');
      }
      if (want.tts && !this._modelRoot(this.kokoroDir)) {
        this._emit({ stage: 'Finding the Kokoro voice', percent: 61 });
        const assets = await this._assets('tts-models');
        const asset = pickKokoroAsset(assets);
        if (!asset) throw new Error('The tts-models release has no Kokoro archive.');
        this.log.info('local voice: kokoro chosen', { asset: asset.name });
        const file = path.join(this.tmpDir, asset.name);
        await this._download(this._assetUrl(asset), file, 'Kokoro voice', 62, 34);
        this._emit({ stage: 'Unpacking Kokoro', percent: 97 });
        fs.rmSync(this.kokoroDir, { recursive: true, force: true });
        await this._extract(file, this.kokoroDir);
        fs.rmSync(file, { force: true });
        if (!this._modelRoot(this.kokoroDir)) throw new Error('The Kokoro archive did not contain a tokens.txt model folder.');
      }
      this.pruneExtras({ log: true });
      this._emit({ stage: 'Done', percent: 100, error: '' });
      this.log.info('local voice installed', this.status());
    } catch (e) {
      this.log.error('local voice install failed', e);
      this._emit({ stage: '', percent: 0, error: (e && e.message) || String(e) });
    } finally {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
      this.installing = false;
      this._emit({});
    }
    return this.status();
  }

  remove() {
    for (const d of [this.engineDir, this.whisperDir, this.kokoroDir, this.tmpDir]) fs.rmSync(d, { recursive: true, force: true });
    this._emit({ stage: '', percent: 0, error: '' });
    return this.status();
  }

  // ---- running the tools
  _run(exe, args, { signal, timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { aborted: true }));
      const child = this.spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) { /* ignore */ }
        reject(new Error('Local voice timed out.'));
      }, timeoutMs);
      const onAbort = () => { try { child.kill(); } catch (_) { /* ignore */ } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.stdout && child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr && child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { aborted: true }));
        if (code !== 0 && !stdout && !stderr) return reject(new Error(`voice tool exited with ${code}`));
        return resolve({ code, stdout, stderr });
      });
    });
  }

  _chain(key, fn) {
    const next = this[key].then(fn, fn);
    this[key] = next.catch(() => {});
    return next;
  }

  // wavBuffer: 16 kHz mono PCM16 WAV. Returns the transcript ('' if nothing was heard).
  transcribe(wavBuffer, { signal, threads } = {}) {
    return this._chain('sttQueue', async () => {
      const exe = this._exe('sherpa-onnx-offline');
      const root = this._modelRoot(this.whisperDir);
      if (!exe || !root) throw new Error('Local Whisper is not installed yet.');
      fs.mkdirSync(this.tmpDir, { recursive: true });
      const wavPath = path.join(this.tmpDir, `in-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
      fs.writeFileSync(wavPath, wavBuffer);
      try {
        const { files } = this._listDir(root);
        const args = buildWhisperArgs(root, files, wavPath, { threads: threads || 4 });
        if (!args) throw new Error('The Whisper model files look incomplete. Remove and download again.');
        const started = Date.now();
        const { stdout, stderr } = await this._run(exe, args, { signal, timeoutMs: 60000 });
        const text = parseWhisperOutput(stdout, stderr);
        this.log.info('local whisper', { ms: Date.now() - started, chars: text.length });
        return looksLikeWhisperHallucination(text) ? '' : text;
      } finally {
        fs.rmSync(wavPath, { force: true });
      }
    });
  }

  // Returns a WAV Buffer. One synthesis at a time so a long answer never starts many processes.
  synthesize(text, { signal, speaker = 3, speed = 1.0 } = {}) {
    return this._chain('ttsQueue', async () => {
      const exe = this._exe('sherpa-onnx-offline-tts');
      const root = this._modelRoot(this.kokoroDir);
      if (!exe || !root) throw new Error('Local Kokoro is not installed yet.');
      const clean = cleanForSpeech(text);
      if (!clean) return null;
      speaker = fixSpeakerForVariant(speaker, this.kokoroVariant());
      fs.mkdirSync(this.tmpDir, { recursive: true });
      const outFile = path.join(this.tmpDir, `out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
      try {
        const { files, dirs } = this._listDir(root);
        const args = buildKokoroArgs(root, files, dirs, { speaker, speed, outFile, text: clean });
        if (!args) throw new Error('The Kokoro model files look incomplete. Remove and download again.');
        const started = Date.now();
        await this._run(exe, args, { signal, timeoutMs: 90000 });
        if (!fs.existsSync(outFile)) throw new Error('Kokoro did not produce audio.');
        const wav = fs.readFileSync(outFile);
        this.log.info('local kokoro', { ms: Date.now() - started, chars: clean.length, bytes: wav.length });
        return wav;
      } finally {
        fs.rmSync(outFile, { force: true });
      }
    });
  }
}

module.exports = {
  LocalVoice,
  WHISPER_MODELS,
  LATEST_URL,
  EXPANDED_ASSETS_URL,
  parseReleaseAssets,
  parseReleaseTag,
  pickEngineAsset,
  pickWhisperAsset,
  pickKokoroAsset,
  fixSpeakerForVariant,
  buildWhisperArgs,
  buildKokoroArgs,
  parseWhisperOutput,
  looksLikeWhisperHallucination,
  cleanForSpeech,
};
