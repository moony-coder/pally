'use strict';
/*
 * Minimal Groq client (OpenAI-compatible REST). No SDK, so it is easy to mock.
 */

const SPEECH_INPUT_CHARACTER_LIMIT = 200;

function isGroqBaseUrl(base) {
  try {
    const host = new URL(String(base || '')).hostname.toLowerCase();
    return host === 'groq.com' || host.endsWith('.groq.com');
  } catch (_) {
    return false;
  }
}

function isDeepSeekBaseUrl(base) {
  try {
    const host = new URL(String(base || '')).hostname.toLowerCase();
    return host === 'deepseek.com' || host.endsWith('.deepseek.com');
  } catch (_) {
    return false;
  }
}

function providerLabel(base) {
  if (isGroqBaseUrl(base)) return 'Groq';
  if (isDeepSeekBaseUrl(base)) return 'DeepSeek';
  return 'The local AI server';
}

class GroqError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'GroqError';
    this.kind = kind; // no_key|bad_key|no_balance|rate_limited|terms_required|too_large|server|network|aborted|bad_request
    this.status = status || 0;
  }
}

function errorFromResponse(status, bodyText, label = 'Groq') {
  let message = bodyText || '';
  let code = '';
  try {
    const j = JSON.parse(bodyText);
    message = (j.error && j.error.message) || message;
    code = (j.error && j.error.code) || '';
  } catch (_) {
    /* not json */
  }
  if (status === 402) {
    return new GroqError('no_balance', `${label} says the account has no balance left. Top up at platform.deepseek.com.`, status);
  }
  if (status === 401) return new GroqError('bad_key', `${label} rejected the API key. Check it in settings.`, status);
  if (status === 429) return new GroqError('rate_limited', `${label} is rate limiting requests. Try again in a moment.`, status);
  if (status === 413) return new GroqError('too_large', `The request was too large for ${label}.`, status);
  if (code === 'model_terms_required' || /terms acceptance/i.test(message)) {
    return new GroqError(
      'terms_required',
      'This Groq model needs terms acceptance. Accept them once at console.groq.com/playground, then try again.',
      status
    );
  }
  if (status >= 500) return new GroqError('server', `${label} had a server problem (${status}).`, status);
  return new GroqError('bad_request', message || `${label} request failed (${status}).`, status);
}

function buildMultipartBody(fields, file) {
  const boundary = '----sidekick' + Math.random().toString(16).slice(2);
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s, 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
  );
  chunks.push(file.data);
  push(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}

function imagePart(jpegBuffer) {
  return { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(jpegBuffer).toString('base64') } };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readChatStream(response, onTextDelta, label = 'Groq') {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const toolCalls = [];
  let finishReason = null;
  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch (_) {
      return;
    }
    if (json.error) throw errorFromResponse(500, JSON.stringify(json), label);
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) {
      text += delta.content;
      if (onTextDelta) onTextDelta(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index || 0;
      if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) toolCalls[i].id = tc.id;
      if (tc.function && tc.function.name) toolCalls[i].function.name += tc.function.name;
      if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
    }
  };
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
  } else {
    for await (const value of body) {
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
  }
  if (buffer) handleLine(buffer);
  return { text, toolCalls: toolCalls.filter(Boolean), finishReason };
}

class GroqClient {
  constructor({ getApiKey, getBaseUrl, fetchImpl, log } = {}) {
    this.getApiKey = getApiKey || (() => '');
    this.getBaseUrl = getBaseUrl || (() => 'https://api.groq.com/openai/v1');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.log = log || { info() {}, warn() {}, error() {} };
  }

  isGroq() {
    return isGroqBaseUrl(this.getBaseUrl());
  }

  isDeepSeek() {
    return isDeepSeekBaseUrl(this.getBaseUrl());
  }

  label() {
    return providerLabel(this.getBaseUrl());
  }

  async request(pathname, init = {}, attempt = 0) {
    const base = this.getBaseUrl();
    const groq = isGroqBaseUrl(base);
    const cloud = groq || isDeepSeekBaseUrl(base);
    const label = providerLabel(base);
    const key = this.getApiKey();
    // Ollama (and other local OpenAI-compatible servers) do not need a key. Still send a bearer
    // header because some clients/proxies expect one.
    if (!key && cloud) throw new GroqError('no_key', `Add your ${label} API key in settings first.`);
    const url = base.replace(/\/$/, '') + pathname;
    const headers = Object.assign({ Authorization: 'Bearer ' + (key || 'local') }, init.headers || {});
    // A request that never answers must not freeze the assistant: give up on the response headers
    // after a while (streaming answers send headers right away), then retry once.
    const headerTimeoutMs = cloud ? (init.headerTimeoutMs || 30000) : 0;
    const tc = new AbortController();
    const timer = headerTimeoutMs ? setTimeout(() => tc.abort(), headerTimeoutMs) : null;
    const userSignal = init.signal;
    let signal = userSignal;
    if (headerTimeoutMs) signal = userSignal && typeof AbortSignal.any === 'function' ? AbortSignal.any([userSignal, tc.signal]) : tc.signal;
    const fetchInit = Object.assign({}, init, { headers });
    delete fetchInit.headerTimeoutMs;
    if (signal) fetchInit.signal = signal;
    let res;
    try {
      res = await this.fetch(url, fetchInit);
    } catch (e) {
      if (userSignal && userSignal.aborted) throw new GroqError('aborted', 'Request cancelled.');
      if (attempt < 1) {
        await sleep(300);
        return this.request(pathname, init, attempt + 1);
      }
      throw new GroqError('network', cloud ? `Could not reach ${label}. Check your internet connection.` : 'Could not reach the local AI server. Is Ollama running?');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1200;
      if (wait <= 3000) {
        await sleep(wait);
        return this.request(pathname, init, attempt + 1);
      }
    }
    if (res.status >= 500 && attempt < 1) {
      await sleep(400);
      return this.request(pathname, init, attempt + 1);
    }
    throw errorFromResponse(res.status, text, providerLabel(base));
  }

  async validateKey() {
    const res = await this.request('/models', { method: 'GET' });
    const j = await res.json();
    return { ok: true, models: (j.data || []).map((m) => m.id) };
  }

  async chat(opts) {
    const {
      model,
      messages,
      tools,
      toolChoice,
      stream = true,
      onTextDelta,
      signal,
      maxTokens,
      temperature,
      topP,
      reasoningEffort,
      jsonMode,
    } = opts;
    const groq = this.isGroq();
    const deepseek = this.isDeepSeek();
    const buildBody = (withReasoning) => {
      const b = { model, messages, stream };
      if (tools && tools.length) {
        b.tools = tools;
        b.tool_choice = toolChoice || 'auto';
      }
      // Groq's current API takes max_completion_tokens; OpenAI-compatible local servers
      // (Ollama) expect max_tokens. Ollama also rejects reasoning_effort outright.
      if (maxTokens) b[groq ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
      if (temperature !== undefined) b.temperature = temperature;
      if (topP !== undefined) b.top_p = topP;
      if (groq && withReasoning && reasoningEffort) b.reasoning_effort = reasoningEffort;
      // DeepSeek V4 thinks by default, which adds seconds before the first word. Turn it off for
      // quick mode and for every tool-calling request (tool loops in thinking mode would also need
      // reasoning_content passed back). 'Deep' mode leaves thinking on.
      if (deepseek) b.thinking = { type: reasoningEffort === 'none' || (tools && tools.length) ? 'disabled' : 'enabled' };
      if (jsonMode) b.response_format = { type: 'json_object' };
      return b;
    };
    const send = (withReasoning) =>
      this.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(withReasoning)),
        signal,
      });
    let res;
    try {
      res = await send(true);
    } catch (e) {
      if (groq && e instanceof GroqError && e.kind === 'bad_request' && reasoningEffort) {
        this.log.warn('The AI server rejected reasoning params, retrying without them');
        res = await send(false);
      } else throw e;
    }
    if (!stream) {
      const j = await res.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      return {
        text: msg.content || '',
        toolCalls: msg.tool_calls || [],
        finishReason: j.choices && j.choices[0] && j.choices[0].finish_reason,
      };
    }
    try {
      return await readChatStream(res, onTextDelta, this.label());
    } catch (e) {
      if (signal && signal.aborted) throw new GroqError('aborted', 'Request cancelled.');
      if (e instanceof GroqError) throw e;
      throw new GroqError('network', this.isGroq() || this.isDeepSeek() ? `The connection to ${this.label()} dropped mid-answer.` : 'The connection to the local AI server dropped mid-answer.');
    }
  }

  async transcribe({ wavBuffer, model, language, prompt, signal }) {
    if (this.isDeepSeek()) throw new GroqError('bad_request', 'DeepSeek has no speech-to-text. Install the local voice (Whisper) in Settings.');
    const { body, contentType } = buildMultipartBody(
      { model: model || 'whisper-large-v3-turbo', language, prompt, response_format: 'json', temperature: 0 },
      { field: 'file', filename: 'speech.wav', contentType: 'audio/wav', data: wavBuffer }
    );
    const res = await this.request('/audio/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal,
    });
    const j = await res.json();
    return String(j.text || '').trim();
  }

  async synthesizeSpeech({ model, voice, text, signal }) {
    if (this.isDeepSeek()) throw new GroqError('bad_request', 'DeepSeek has no text-to-speech.');
    let input = String(text || '').trim();
    if (input.length > SPEECH_INPUT_CHARACTER_LIMIT) input = input.slice(0, SPEECH_INPUT_CHARACTER_LIMIT);
    const res = await this.request('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'canopylabs/orpheus-v1-english',
        voice: voice || 'autumn',
        input,
        response_format: 'wav',
      }),
      signal,
    });
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = {
  GroqClient,
  GroqError,
  errorFromResponse,
  buildMultipartBody,
  imagePart,
  readChatStream,
  isGroqBaseUrl,
  isDeepSeekBaseUrl,
  providerLabel,
  SPEECH_INPUT_CHARACTER_LIMIT,
};
