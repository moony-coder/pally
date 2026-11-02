'use strict';
/*
 * Always-on wake word matching. The audio host does the cheap part: it only sends an utterance
 * after a VAD gate opens. Local Whisper transcribes that utterance, then this pure helper decides
 * whether it actually started with the wake phrase.
 */

const DEFAULT_ALIASES = ['hey sidekick', 'hey sidekick', 'hey jarvis', 'okay jarvis'];

function normalizeWakeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wakePhrases(phrase) {
  const all = [phrase, ...DEFAULT_ALIASES].map(normalizeWakeText).filter(Boolean);
  return Array.from(new Set(all)).sort((a, b) => b.length - a.length);
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - editDistance(a, b) / max : 1;
}

// Returns { matched, phrase, command } or null.
// Whisper rarely writes the phrase exactly: "hey side kick", "hi sidekick", "hey sidekicks". So after the exact
// check, compare the first 1-4 spoken words (joined, spaces ignored) with the phrase and accept a close match.
function extractWakeCommand(transcript, phrase = 'hey sidekick', { minSimilarity = 0.8 } = {}) {
  const norm = normalizeWakeText(transcript);
  if (!norm) return null;
  const phrases = wakePhrases(phrase);
  for (const p of phrases) {
    if (norm === p) return { matched: true, phrase: p, command: '' };
    if (norm.startsWith(p + ' ')) return { matched: true, phrase: p, command: norm.slice(p.length + 1).trim() };
  }
  const words = norm.split(' ');
  let best = null;
  for (const p of phrases) {
    const target = p.replace(/ /g, '');
    if (target.length < 6) continue; // too short to match loosely: only exact
    const pw = p.split(' ').length;
    for (let n = Math.max(1, pw - 1); n <= Math.min(words.length, pw + 2); n++) {
      const heard = words.slice(0, n).join('');
      const sim = similarity(heard, target);
      if (sim >= minSimilarity && (!best || sim > best.sim || (sim === best.sim && n < best.n))) best = { sim, n, phrase: p };
    }
  }
  if (!best) return null;
  return { matched: true, phrase: best.phrase, command: words.slice(best.n).join(' ').trim(), fuzzy: true };
}

// True when `heard` is (most of) what Sidekick itself just said, i.e. the microphone picked up the speakers.
function looksLikeEcho(heard, lastAnswer) {
  const h = normalizeWakeText(heard).split(' ').filter(Boolean);
  const a = new Set(normalizeWakeText(lastAnswer).split(' ').filter(Boolean));
  if (h.length < 3 || !a.size) return false;
  const inAnswer = h.filter((w) => a.has(w)).length;
  return inAnswer / h.length >= 0.75;
}

function shouldListen(settings, localVoiceStatus, micGranted) {
  const s = settings || {};
  return !!(s.wakeWordEnabled && s.sttProvider === 'local' && localVoiceStatus && localVoiceStatus.stt && micGranted);
}

module.exports = { normalizeWakeText, wakePhrases, extractWakeCommand, shouldListen, looksLikeEcho, similarity, DEFAULT_ALIASES };
