'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRoot, normalizeModels, normalizeCapabilities, listModels, modelInfo, testConnection } = require('../../src/main/ollama');

test('normalizeRoot accepts the server root, /v1 or /api and rejects non-http URLs', () => {
  assert.equal(normalizeRoot('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(normalizeRoot('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeRoot('http://localhost:11434/v1/'), 'http://localhost:11434');
  assert.equal(normalizeRoot('https://ollama.example.com/api'), 'https://ollama.example.com');
  assert.equal(normalizeRoot('  '), 'http://127.0.0.1:11434');
  assert.throws(() => normalizeRoot('file:///etc/passwd'), /http/);
});

test('normalizeModels maps Ollama tags and ignores blanks', () => {
  const models = normalizeModels({ models: [
    { name: 'qwen2.5vl:7b', size: 5, details: { family: 'qwen', parameter_size: '7B', quantization_level: 'Q4' } },
    { model: 'llama3.2:3b', size: 2, details: { family: 'llama' } },
    { name: '' },
  ] });
  assert.deepEqual(models.map((m) => m.name), ['llama3.2:3b', 'qwen2.5vl:7b']);
  assert.equal(models[1].parameterSize, '7B');
});

test('normalizeCapabilities uses /api/show capabilities and falls back to model_info', () => {
  assert.deepEqual(normalizeCapabilities({ capabilities: ['completion', 'tools', 'vision'] }), ['completion', 'tools', 'vision']);
  assert.deepEqual(normalizeCapabilities({ model_info: { 'vision.patch_size': 14, 'general.parameter_count': 8 } }), ['completion', 'vision']);
  assert.deepEqual(normalizeCapabilities({ capabilities: ['completion'], model_info: { 'clip.has_vision_encoder': true } }), ['completion', 'vision']);
});

test('listModels, modelInfo and testConnection call the right Ollama endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5vl:7b' }] }));
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['completion', 'tools', 'vision'], details: { family: 'qwen' } }));
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }));
    return new Response('{}', { status: 404 });
  };
  const tags = await listModels('http://127.0.0.1:11434/v1', { fetchImpl });
  assert.equal(tags.root, 'http://127.0.0.1:11434');
  assert.deepEqual(tags.models.map((m) => m.name), ['qwen2.5vl:7b']);
  const info = await modelInfo('http://127.0.0.1:11434', 'qwen2.5vl:7b', { fetchImpl });
  assert.ok(info.capabilities.includes('vision'));
  assert.equal(JSON.parse(calls.find((c) => c.url.endsWith('/api/show')).body).model, 'qwen2.5vl:7b');
  const conn = await testConnection('http://127.0.0.1:11434', { fetchImpl });
  assert.deepEqual(conn.models, ['qwen2.5vl:7b']);
});
