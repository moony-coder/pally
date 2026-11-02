'use strict';
/*
 * Minimal Ollama helper (no SDK, no local dependency).
 *
 *   GET  <root>/api/tags   -> installed models
 *   POST <root>/api/show   -> model capabilities (vision, tools, ...)
 *   GET  <root>/v1/models  -> OpenAI-compatible connection test
 *
 * <root> is always the server root (http://127.0.0.1:11434), never the /v1 URL.
 */

function normalizeRoot(input) {
  const raw = String(input || '').trim() || 'http://127.0.0.1:11434';
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new Error('The local AI address is not a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses are supported.');
  let pathname = u.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/v1$/i, '').replace(/\/api$/i, '');
  u.pathname = pathname || '/';
  u.search = '';
  u.hash = '';
  return u.origin + (u.pathname === '/' ? '' : u.pathname);
}

function modelName(m) {
  return String((m && (m.name || m.model)) || '').trim();
}

function normalizeModels(json) {
  const list = json && Array.isArray(json.models) ? json.models : [];
  return list
    .map((m) => ({
      name: modelName(m),
      size: Number(m.size) || 0,
      family: (m.details && m.details.family) || '',
      parameterSize: (m.details && m.details.parameter_size) || '',
      quantization: (m.details && m.details.quantization_level) || '',
    }))
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// /api/show answers differ between Ollama versions. Prefer the capabilities array; fall back to
// model_info keys (vision.* families) so older servers still show useful badges.
function normalizeCapabilities(json) {
  const j = json || {};
  let caps = Array.isArray(j.capabilities) ? j.capabilities.map((c) => String(c).toLowerCase()) : [];
  const info = j.model_info || {};
  const keys = Object.keys(info).map((k) => k.toLowerCase());
  if (!caps.length) {
    caps = ['completion'];
    if (keys.some((k) => /vision|clip|image|mm\.|visual/.test(k))) caps.push('vision');
    if (/tools|function/i.test(JSON.stringify(j.template || '')) || (j.details && /qwen|llama3\.|mistral|devstral/i.test(j.details.family || ''))) caps.push('tools');
  }
  if (keys.some((k) => /vision|clip|image|mm\.|visual/.test(k)) && !caps.includes('vision')) caps.push('vision');
  return Array.from(new Set(caps));
}

async function fetchJson(fetchImpl, url, init = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, Object.assign({}, init, { signal: ctrl.signal }));
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}${text ? ': ' + text.slice(0, 180) : ''}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`${url} did not return JSON. Is this an Ollama server?`);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`The local AI server did not answer within ${Math.round(timeoutMs / 1000)} seconds. Is Ollama running?`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(root, { fetchImpl = fetch, timeoutMs } = {}) {
  const base = normalizeRoot(root);
  const json = await fetchJson(fetchImpl, base + '/api/tags', { headers: { Accept: 'application/json' } }, timeoutMs);
  return { root: base, models: normalizeModels(json) };
}

async function modelInfo(root, name, { fetchImpl = fetch, timeoutMs } = {}) {
  const base = normalizeRoot(root);
  if (!String(name || '').trim()) throw new Error('Pick a model first.');
  const json = await fetchJson(
    fetchImpl,
    base + '/api/show',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ model: String(name) }) },
    timeoutMs
  );
  return { name: String(name), capabilities: normalizeCapabilities(json), details: json.details || {} };
}

async function testConnection(root, { fetchImpl = fetch, timeoutMs } = {}) {
  const base = normalizeRoot(root);
  const json = await fetchJson(fetchImpl, base + '/v1/models', { headers: { Accept: 'application/json' } }, timeoutMs);
  const models = (json && Array.isArray(json.data) ? json.data : []).map((m) => String(m.id || '')).filter(Boolean);
  return { root: base, models };
}

module.exports = { normalizeRoot, normalizeModels, normalizeCapabilities, listModels, modelInfo, testConnection };
