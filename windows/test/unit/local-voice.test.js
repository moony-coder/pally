'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LocalVoice,
  parseReleaseAssets,
  parseReleaseTag,
  pickEngineAsset,
  pickWhisperAsset,
  pickKokoroAsset,
  buildWhisperArgs,
  buildKokoroArgs,
  parseWhisperOutput,
  looksLikeWhisperHallucination,
  cleanForSpeech,
} = require('../../src/main/local-voice');

const asset = (name) => ({ name, browser_download_url: 'https://example.test/' + name });

test('release tag comes from the /releases/latest redirect, including encoded tags', () => {
  assert.strictEqual(parseReleaseTag('https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.1'), 'v2.0.1');
  assert.strictEqual(parseReleaseTag('https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.12.9?x=1'), 'v1.12.9');
  assert.strictEqual(parseReleaseTag('https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr%2Dmodels'), 'asr-models');
  assert.strictEqual(parseReleaseTag('https://github.com/k2-fsa/sherpa-onnx/releases'), '');
});

test('release page parser reads expanded_assets links without the GitHub API', () => {
  const page = `
    <a href="/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-static-MT-Release.tar.bz2">x</a>
    <a href="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2">x</a>
    <a href="/k2-fsa/sherpa-onnx/releases/tag/v2.0.1">not an asset</a>
    <a href="/k2-fsa/sherpa-onnx/releases/download/v2.0.1/a.tar.bz2?download=1">query</a>`;
  const a = parseReleaseAssets(page, 'https://github.com/k2-fsa/sherpa-onnx/releases/expanded_assets/v2.0.1');
  assert.deepStrictEqual(a.map((x) => x.name), ['sherpa-onnx-v2.0.1-win-x64-static-MT-Release.tar.bz2', 'sherpa-onnx-whisper-base.en.tar.bz2', 'a.tar.bz2']);
  assert.strictEqual(a[1].browser_download_url, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2');
});

test('engine asset: Release wins over Debug, static over shared, MT over MD', () => {
  const names = [
    'sherpa-onnx-v2.0.1-win-x64-shared-MD-Debug.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-static-MD-Debug.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-static-MT-RelWithDebInfo.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-static-MT-Release-no-tts.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-static-MT-Release-lib.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-static-MD-Release.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-static-MT-Release.tar.bz2',
    'sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2',
    'sherpa-onnx-v2.0.1-win-x64-jni.tar.bz2',
  ].map(asset);
  assert.strictEqual(pickEngineAsset(names).name, 'sherpa-onnx-v2.0.1-win-x64-static-MT-Release.tar.bz2');
});

test('engine asset: older release names still work, and nothing matches without win-x64', () => {
  const list = [
    'sherpa-onnx-v1.12.9-win-x64-shared-MD-Release-no-tts.tar.bz2',
    'sherpa-onnx-v1.12.9-win-x64-shared.tar.bz2',
    'sherpa-onnx-v1.12.9-win-x64-static.tar.bz2',
    'sherpa-onnx-v1.12.9-win-x64-cuda.tar.bz2',
    'sherpa-onnx-v1.12.9-win-x86-shared.tar.bz2',
    'sherpa-onnx-v1.12.9-linux-x64-shared.tar.bz2',
  ].map(asset);
  assert.strictEqual(pickEngineAsset(list).name, 'sherpa-onnx-v1.12.9-win-x64-static.tar.bz2');
  assert.strictEqual(pickEngineAsset([asset('readme.md')]), null);
});

test('whisper asset: exact model name only', () => {
  const list = ['sherpa-onnx-whisper-base.tar.bz2', 'sherpa-onnx-whisper-base.en.tar.bz2', 'sherpa-onnx-whisper-tiny.en.tar.bz2'].map(asset);
  assert.strictEqual(pickWhisperAsset(list, 'base.en').name, 'sherpa-onnx-whisper-base.en.tar.bz2');
  assert.strictEqual(pickWhisperAsset(list, 'small.en'), null);
});

test('kokoro asset: smallest preferred model wins, falls back to any kokoro', () => {
  const list = ['kokoro-multi-lang-v1_0.tar.bz2', 'kokoro-int8-multi-lang-v1_1.tar.bz2', 'other.tar.bz2'].map(asset);
  assert.strictEqual(pickKokoroAsset(list).name, 'kokoro-multi-lang-v1_0.tar.bz2'); // v1.0: correct English speaker numbers
  assert.strictEqual(pickKokoroAsset([asset('kokoro-weird-9.tar.bz2')]).name, 'kokoro-weird-9.tar.bz2');
  assert.strictEqual(pickKokoroAsset([asset('vits.tar.bz2')]), null);
});

test('installer lists assets from release pages and downloads all three pieces (no api.github.com)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-voice-'));
  const fetched = [];
  const logs = [];
  const engine = 'sherpa-onnx-v2.0.1-win-x64-static-MT-Release.tar.bz2';
  const whisper = 'sherpa-onnx-whisper-base.en.tar.bz2';
  const kokoro = 'kokoro-int8-multi-lang-v1_1.tar.bz2';
  const page = (names) => names.map((n) => `<a href="/k2-fsa/sherpa-onnx/releases/download/TAG/${n}">${n}</a>`).join('\n');
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    if (url === 'https://github.com/k2-fsa/sherpa-onnx/releases/latest') {
      return new Response('', { status: 302, headers: { location: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.1' } });
    }
    if (url.includes('/releases/expanded_assets/')) {
      const tag = url.split('/').pop();
      const names = tag === 'asr-models' ? [whisper] : tag === 'tts-models' ? [kokoro] : ['debug.tar.bz2', engine];
      return new Response(page(names).replaceAll('TAG', tag), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.endsWith(engine) || url.endsWith(whisper) || url.endsWith(kokoro)) {
      const body = Buffer.from('fake archive ' + path.basename(url));
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    throw new Error('unexpected URL ' + url);
  };
  const execFileImpl = (cmd, args, opts, cb) => {
    assert.strictEqual(cmd, 'tar');
    const dest = args[args.indexOf('-C') + 1];
    fs.mkdirSync(dest, { recursive: true });
    const archive = path.basename(args[args.indexOf('-xjf') + 1]);
    if (archive === engine) {
      fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'bin', 'sherpa-onnx-offline.exe'), 'x');
      fs.writeFileSync(path.join(dest, 'bin', 'sherpa-onnx-offline-tts.exe'), 'x');
    } else {
      fs.mkdirSync(path.join(dest, 'model'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'model', 'tokens.txt'), 'x');
      fs.writeFileSync(path.join(dest, 'model', 'model.onnx'), 'x');
    }
    cb(null, '', '');
  };
  try {
    const lv = new LocalVoice({ dir, log: { info: (...a) => logs.push(a.join(' ')), warn() {}, error() {} }, fetchImpl, execFileImpl });
    const st = await lv.install({ whisperModel: 'base.en' });
    assert.strictEqual(st.stt, true);
    assert.strictEqual(st.tts, true);
    assert.strictEqual(st.installing, false);
    assert.strictEqual(st.progress.percent, 100);
    assert.ok(!fetched.some((u) => /api\.github\.com/.test(u)), 'never calls the rate-limited API');
    assert.ok(fetched.includes('https://github.com/k2-fsa/sherpa-onnx/releases/expanded_assets/v2.0.1'));
    assert.ok(fetched.includes('https://github.com/k2-fsa/sherpa-onnx/releases/expanded_assets/asr-models'));
    assert.ok(fetched.some((u) => u.endsWith('/' + engine)));
    assert.ok(logs.some((l) => /engine chosen/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('whisper args use int8 files when present', () => {
  const files = ['base.en-encoder.onnx', 'base.en-encoder.int8.onnx', 'base.en-decoder.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'];
  const args = buildWhisperArgs('M', files, 'in.wav', { threads: 3 });
  assert.ok(args.includes(`--whisper-encoder=${path.join('M', 'base.en-encoder.int8.onnx')}`));
  assert.ok(args.includes(`--whisper-decoder=${path.join('M', 'base.en-decoder.int8.onnx')}`));
  assert.ok(args.includes('--num-threads=3'));
  assert.strictEqual(args[args.length - 1], 'in.wav');
  assert.strictEqual(buildWhisperArgs('M', ['x.txt'], 'in.wav'), null);
});

test('kokoro args adapt to the files and folders in the model', () => {
  const files = ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt'];
  const args = buildKokoroArgs('K', files, ['espeak-ng-data', 'dict'], { speaker: 5, speed: 1, outFile: 'o.wav', text: 'hello there' });
  assert.ok(args.includes(`--kokoro-model=${path.join('K', 'model.int8.onnx')}`));
  assert.ok(args.includes(`--kokoro-data-dir=${path.join('K', 'espeak-ng-data')}`));
  assert.ok(args.includes(`--kokoro-dict-dir=${path.join('K', 'dict')}`));
  assert.ok(args.some((a) => a.startsWith('--kokoro-lexicon=') && a.includes('lexicon-zh.txt')));
  assert.ok(args.includes('--sid=5'));
  assert.ok(args.includes('--output-filename=o.wav'));
  assert.strictEqual(args[args.length - 1], 'hello there');
  const small = buildKokoroArgs('K', ['model.onnx', 'voices.bin', 'tokens.txt'], [], { outFile: 'o.wav', text: 'x' });
  assert.ok(!small.some((a) => a.startsWith('--kokoro-data-dir') || a.startsWith('--kokoro-lexicon')));
  assert.strictEqual(buildKokoroArgs('K', ['model.onnx'], [], { outFile: 'o.wav', text: 'x' }), null);
});

test('whisper output parsing finds the last text field on either stream', () => {
  assert.strictEqual(parseWhisperOutput('x\n{"lang":"","text":" hello \\"world\\"","tokens":[]}\n', ''), 'hello "world"');
  assert.strictEqual(parseWhisperOutput('', 'Elapsed 1s\n{"text": "from stderr"}'), 'from stderr');
  assert.strictEqual(parseWhisperOutput('{"text":"a"}', '{"text":"b"}'), 'b');
  assert.strictEqual(parseWhisperOutput('nothing', 'here'), '');
});

test('hallucinated whisper text is dropped', () => {
  for (const t of ['', ' ', 'Thank you.', 'thanks for watching!', '[BLANK_AUDIO]', '(music)']) assert.ok(looksLikeWhisperHallucination(t), t);
  assert.ok(!looksLikeWhisperHallucination('open the settings menu'));
});

test('speech text is cleaned of tags, markdown and links', () => {
  assert.strictEqual(cleanForSpeech('see **this** [POINT:10,20:button] now https://x.com/a'), 'see this now link');
});

test('pruneExtras keeps only the two tools and int8 Whisper weights', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clicky-voice-prune-'));
  try {
    const bin = path.join(dir, 'engine', 'release', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const n of ['sherpa-onnx-offline.exe', 'sherpa-onnx-offline-tts.exe', 'sherpa-onnx-vad.exe', 'sherpa-onnx-version.exe']) {
      fs.writeFileSync(path.join(bin, n), 'x');
    }
    fs.mkdirSync(path.join(dir, 'engine', 'release', 'lib'));
    fs.writeFileSync(path.join(dir, 'engine', 'release', 'lib', 'onnxruntime.lib'), 'x');
    fs.mkdirSync(path.join(dir, 'engine', 'release', 'include'));
    const whisper = path.join(dir, 'whisper', 'model');
    fs.mkdirSync(path.join(whisper, 'test_wavs'), { recursive: true });
    fs.writeFileSync(path.join(whisper, 'tokens.txt'), 'x');
    fs.writeFileSync(path.join(whisper, 'base-encoder.onnx'), 'full');
    fs.writeFileSync(path.join(whisper, 'base-encoder.int8.onnx'), 'int8');
    fs.writeFileSync(path.join(whisper, 'base-decoder.onnx'), 'full');
    fs.writeFileSync(path.join(whisper, 'base-decoder.int8.onnx'), 'int8');
    fs.mkdirSync(path.join(dir, 'kokoro', 'model'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'kokoro', 'model', 'tokens.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'kokoro', 'model', 'model.int8.onnx'), 'x');
    const lv = new LocalVoice({ dir });
    lv.pruneExtras();
    assert.ok(fs.existsSync(path.join(bin, 'sherpa-onnx-offline.exe')));
    assert.ok(fs.existsSync(path.join(bin, 'sherpa-onnx-offline-tts.exe')));
    assert.equal(fs.existsSync(path.join(bin, 'sherpa-onnx-vad.exe')), false);
    assert.equal(fs.existsSync(path.join(dir, 'engine', 'release', 'lib')), false);
    assert.equal(fs.existsSync(path.join(dir, 'engine', 'release', 'include')), false);
    assert.ok(fs.existsSync(path.join(whisper, 'base-encoder.int8.onnx')));
    assert.equal(fs.existsSync(path.join(whisper, 'base-encoder.onnx')), false);
    assert.equal(fs.existsSync(path.join(whisper, 'base-decoder.onnx')), false);
    assert.equal(fs.existsSync(path.join(whisper, 'test_wavs')), false);
    assert.ok(fs.existsSync(path.join(dir, 'kokoro', 'model', 'model.int8.onnx')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kokoro v1.1 installs never use a Chinese speaker number for English', () => {
  const { fixSpeakerForVariant } = require('../../src/main/local-voice');
  assert.equal(fixSpeakerForVariant(3, 'v1_1'), 0);
  assert.equal(fixSpeakerForVariant(2, 'v1_1'), 2);
  assert.equal(fixSpeakerForVariant(16, 'v1_1'), 0);
  assert.equal(fixSpeakerForVariant(3, 'v1_0'), 3);
  assert.equal(fixSpeakerForVariant('x', 'v1_0'), 0);
});
