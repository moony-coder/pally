'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GroqClient, GroqError, buildMultipartBody } = require('../../src/main/groq');
const { SettingsStore } = require('../../src/main/settings');
const P = require('../../src/main/prompts');

function sseResponse(lines) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (o) => 'data: ' + JSON.stringify({ choices: [{ delta: o }] }) + '\n\n';

test('chat streams text deltas and tool calls', async () => {
  const calls = [];
  const client = new GroqClient({
    getApiKey: () => 'k',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return sseResponse([
        chunk({ content: 'hel' }), chunk({ content: 'lo' }),
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'click', arguments: '{"x"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
        'data: [DONE]\n\n',
      ]);
    },
  });
  const deltas = [];
  const r = await client.chat({ model: 'm', messages: [], onTextDelta: (d) => deltas.push(d), reasoningEffort: 'none' });
  assert.equal(r.text, 'hello');
  assert.deepEqual(deltas, ['hel', 'lo']);
  assert.equal(r.toolCalls[0].function.name, 'click');
  assert.equal(r.toolCalls[0].function.arguments, '{"x":1}');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
});

test('chat retries without reasoning params when rejected', async () => {
  let n = 0;
  const client = new GroqClient({
    getApiKey: () => 'k',
    fetchImpl: async (url, init) => {
      n++;
      if (JSON.parse(init.body).reasoning_effort) return new Response('{"error":{"message":"bad param"}}', { status: 400 });
      return sseResponse([chunk({ content: 'ok' }), 'data: [DONE]\n\n']);
    },
  });
  const r = await client.chat({ model: 'm', messages: [], reasoningEffort: 'none' });
  assert.equal(r.text, 'ok');
  assert.equal(n, 2);
});

test('errors are classified', async () => {
  const mk = (status, body) => new GroqClient({ getApiKey: () => 'k', fetchImpl: async () => new Response(body, { status, headers: { 'retry-after': '99' } }) });
  await assert.rejects(mk(401, '{}').chat({ model: 'm', messages: [], stream: false }), (e) => e.kind === 'bad_key');
  await assert.rejects(mk(429, '{}').chat({ model: 'm', messages: [], stream: false }), (e) => e.kind === 'rate_limited');
  await assert.rejects(mk(400, '{"error":{"code":"model_terms_required","message":"x"}}').chat({ model: 'm', messages: [], stream: false }), (e) => e.kind === 'terms_required');
  await assert.rejects(new GroqClient({ getApiKey: () => '' }).chat({ model: 'm', messages: [] }), (e) => e instanceof GroqError && e.kind === 'no_key');
});

test('transcribe sends multipart wav and tts truncates to 200 chars', async () => {
  let seen;
  const client = new GroqClient({
    getApiKey: () => 'k',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      if (url.endsWith('/audio/transcriptions')) return new Response('{"text":" hi there "}');
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  assert.equal(await client.transcribe({ wavBuffer: Buffer.from('RIFF') }), 'hi there');
  assert.match(seen.init.headers['Content-Type'], /multipart\/form-data; boundary=/);
  assert.ok(Buffer.from(seen.init.body).toString().includes('whisper-large-v3-turbo'));
  const wav = await client.synthesizeSpeech({ text: 'a'.repeat(500) });
  assert.equal(wav.length, 3);
  assert.equal(JSON.parse(seen.init.body).input.length, 200);
});

test('multipart builder', () => {
  const { body } = buildMultipartBody({ a: '1' }, { field: 'file', filename: 'x.wav', contentType: 'audio/wav', data: Buffer.from('DATA') });
  assert.ok(body.toString().includes('name="a"'));
  assert.ok(body.toString().includes('DATA'));
});

test('settings: persist, merge, key never leaks, env override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-'));
  const file = path.join(dir, 's.json');
  const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) };
  const s = new SettingsStore(file, fake, {});
  s.setApiKey('gsk_secret');
  s.set({ agent: { maxSteps: 12 } });
  assert.equal(s.getApiKey(), 'gsk_secret');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('gsk_secret'));
  const pub = s.getPublic();
  assert.equal(pub.groqApiKeyEncrypted, undefined);
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.agent.maxSteps, 12);
  assert.equal(pub.agent.allowDrive, true);
  assert.equal(pub.agent.accessMode, 'blocklist');
  assert.ok(pub.agent.blockedApps.includes('1password'));
  assert.ok(Array.isArray(pub.agent.allowedApps));
  assert.ok(Array.isArray(pub.agent.alwaysAsk));
  assert.deepEqual(pub.safetyDefaults.blockedApps, pub.agent.blockedApps);
  // default provider is DeepSeek, so DEEPSEEK_API_KEY is the env override (GROQ_API_KEY is ignored)
  const s2 = new SettingsStore(file, fake, { DEEPSEEK_API_KEY: 'envkey', GROQ_API_KEY: 'wrong' });
  assert.equal(s2.getApiKey(), 'envkey');
  assert.equal(s2.get('agent').maxSteps, 12);
  const s3 = new SettingsStore(file, fake, { GROQ_API_KEY: 'only-groq' });
  assert.equal(s3.getApiKey(), 'gsk_secret'); // stored key wins when there is no DeepSeek env var
});

test('non-Groq server: max_tokens, dummy bearer, no reasoning_effort, provider-aware errors', async () => {
  const calls = [];
  const client = new GroqClient({
    getApiKey: () => '',
    getBaseUrl: () => 'http://127.0.0.1:11434/v1',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return sseResponse([chunk({ content: 'local ok' }), 'data: [DONE]\n\n']);
    },
  });
  const r = await client.chat({ model: 'qwen2.5vl:7b', messages: [], reasoningEffort: 'none', maxTokens: 321 });
  assert.equal(r.text, 'local ok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 321);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer local');

  const bad = new GroqClient({
    getApiKey: () => '',
    getBaseUrl: () => 'http://127.0.0.1:11434/v1',
    fetchImpl: async () => new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
  });
  await assert.rejects(bad.chat({ model: 'm', messages: [], stream: false }), (e) => e.kind === 'bad_key' && /local AI server/i.test(e.message));
});

test('Groq uses max_completion_tokens while a custom server uses max_tokens', async () => {
  const bodies = [];
  const mk = (base, key) => new GroqClient({
    getApiKey: () => key,
    getBaseUrl: () => base,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([chunk({ content: 'ok' }), 'data: [DONE]\n\n']);
    },
  });
  await mk('https://api.groq.com/openai/v1', 'k').chat({ model: 'm', messages: [], maxTokens: 99, reasoningEffort: 'none' });
  await mk('http://127.0.0.1:11434/v1', '').chat({ model: 'm', messages: [], maxTokens: 99, reasoningEffort: 'none' });
  assert.equal(bodies[0].max_completion_tokens, 99);
  assert.equal(bodies[0].max_tokens, undefined);
  assert.equal(bodies[0].reasoning_effort, 'none');
  assert.equal(bodies[1].max_tokens, 99);
  assert.equal(bodies[1].reasoning_effort, undefined);
});

test('local Ollama preset counts as ready without an API key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-local-'));
  const s = new SettingsStore(path.join(dir, 's.json'), null, {});
  s.set({ provider: 'local' });
  assert.equal(s.hasApiKey(), true);
  assert.equal(s.getPublic().isLocalProvider, true);
  assert.equal(s.getPublic().hasApiKey, true);
  s.set({ provider: 'groq' });
  assert.equal(s.hasApiKey(), false);
});

test('prompts contain the key pieces', () => {
  const p = P.buildTalkSystemPrompt({ memoryFacts: ['likes tea'], shortcutText: 'control+alt' });
  assert.match(p, /\[POINT:x,y:label\]/);
  assert.match(p, /1000 by 1000 grid/);
  assert.match(p, /likes tea/);
  assert.match(p, /\[DRIVE:/);
  assert.ok(!/\[DRIVE:/.test(P.buildTalkSystemPrompt({ allowDrive: false })));
  assert.match(P.buildTalkSystemPrompt({ coordinateSpace: 'pixels' }), /pixel dimensions/);
  assert.match(P.buildModel3DPrompt('engine'), /engine/);
  assert.match(P.buildAgentSystemPrompt({ jobName: 'x' }), /click_element/);
  assert.match(p, /SPEED RULES/);
  assert.match(p, /carry out what you last offered/);
  assert.ok(P.FAST_ACT_RULES);
  assert.ok(P.FAST_MAX_TOKENS);
  assert.equal(P.withSpeedRules(p), p);
});


// ---------------------------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------------------------
const { SettingsStore: SS2, DEFAULT_SETTINGS: DEF2 } = require('../../src/main/settings');
const { GroqClient: GC2, isDeepSeekBaseUrl, providerLabel } = require('../../src/main/groq');

function okChat() {
  return sseResponse([chunk({ content: 'hi there' }), 'data: [DONE]\n\n']);
}

test('deepseek: base url detection and label', () => {
  assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com'), true);
  assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com/v1'), true);
  assert.equal(isDeepSeekBaseUrl('https://api.groq.com/openai/v1'), false);
  assert.equal(providerLabel('https://api.deepseek.com'), 'DeepSeek');
  assert.equal(providerLabel('http://127.0.0.1:11434/v1'), 'The local AI server');
});

test('deepseek: defaults use deepseek-flash and local speech', () => {
  assert.equal(DEF2.provider, 'deepseek');
  assert.equal(DEF2.visionModel, 'deepseek-flash');
  assert.equal(DEF2.groqBaseUrl, 'https://api.deepseek.com');
  assert.equal(DEF2.sttProvider, 'local');
  assert.equal(DEF2.ttsProvider, 'edge');
});

test('deepseek: fast mode sends thinking disabled, max_tokens, no reasoning_effort, bearer key', async () => {
  const calls = [];
  const client = new GC2({
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.deepseek.com',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return okChat(); },
  });
  const r = await client.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'none', maxTokens: 300 });
  assert.equal(r.text, 'hi there');
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 300);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.model, 'deepseek-flash');
});

test('deepseek: deep mode thinks, but any tool-calling request never does', async () => {
  const bodies = [];
  const client = new GC2({
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.deepseek.com',
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return okChat(); },
  });
  await client.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }] });
  await client.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] });
  assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
  assert.equal(bodies[1].tool_choice, 'auto');
});

test('deepseek: missing key, bad key and empty balance get clear errors', async () => {
  const mk = (key, status) => new GC2({
    getApiKey: () => key,
    getBaseUrl: () => 'https://api.deepseek.com',
    fetchImpl: async () => ({ ok: false, status, headers: { get: () => null }, text: async () => '{"error":{"message":"nope"}}' }),
  });
  await assert.rejects(() => mk('', 200).chat({ model: 'm', messages: [] }), (e) => e.kind === 'no_key' && /DeepSeek/.test(e.message));
  await assert.rejects(() => mk('sk-x', 401).chat({ model: 'm', messages: [] }), (e) => e.kind === 'bad_key' && /DeepSeek/.test(e.message));
  await assert.rejects(() => mk('sk-x', 402).chat({ model: 'm', messages: [] }), (e) => e.kind === 'no_balance' && /balance/i.test(e.message));
});

test('deepseek: no cloud speech endpoints (so nothing silently hits a 404)', async () => {
  const client = new GC2({ getApiKey: () => 'sk', getBaseUrl: () => 'https://api.deepseek.com', fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(() => client.transcribe({ wavBuffer: Buffer.alloc(10) }), /local voice/i);
  await assert.rejects(() => client.synthesizeSpeech({ text: 'hi' }), /no text-to-speech/i);
});

test('deepseek: a request that never answers times out instead of freezing', async () => {
  const client = new GC2({
    getApiKey: () => 'sk',
    getBaseUrl: () => 'https://api.deepseek.com',
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const t = Date.now();
  await assert.rejects(() => client.request('/chat/completions', { method: 'POST', headerTimeoutMs: 80 }), (e) => e.kind === 'network');
  assert.ok(Date.now() - t < 2000);
});

test('settings migration: old Groq install becomes DeepSeek + local Whisper + Edge voice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-mig-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'groq', groqBaseUrl: 'https://api.groq.com/openai/v1', visionModel: 'qwen/x', sttProvider: 'groq', ttsProvider: 'local', groqApiKeyEncrypted: 'plain:Z3NrXw==', cursorEnabled: true, hasCompletedOnboarding: true }));
  const s = new SS2(file, null, {});
  assert.equal(s.get('provider'), 'deepseek');
  assert.equal(s.get('groqBaseUrl'), 'https://api.deepseek.com');
  assert.equal(s.get('visionModel'), 'deepseek-flash');
  assert.equal(s.get('sttProvider'), 'local');
  assert.equal(s.get('ttsProvider'), 'edge');
  assert.equal(s.get('cursorEnabled'), false);
  assert.equal(s.get('hasCompletedOnboarding'), true); // unrelated settings survive
  assert.equal(s.getApiKey(), ''); // the Groq key is NOT reused for DeepSeek
  s.set({});
  const s2 = new SS2(file, null, {});
  assert.equal(s2.get('provider'), 'deepseek');
  s2.set({ provider: 'local' });
  assert.equal(new SS2(file, null, {}).get('provider'), 'local'); // migration runs only once
});

test('settings: DeepSeek and Groq keys are stored separately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-keys-'));
  const s = new SS2(path.join(dir, 's.json'), null, {});
  s.setApiKey('sk-deep');
  s.set({ provider: 'groq' });
  assert.equal(s.getApiKey(), '');
  s.setApiKey('gsk-groq');
  s.set({ provider: 'deepseek' });
  assert.equal(s.getApiKey(), 'sk-deep');
  assert.equal(s.getPublic().deepseekApiKeyEncrypted, undefined);
});
