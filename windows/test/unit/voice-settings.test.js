'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vs = require('../../src/main/voice-settings');
const { withSpeedRules, FAST_ACT_RULES, FAST_MAX_TOKENS } = require('../../src/main/speed-prompt');
const quick = require('../../src/main/quick-commands');
const { SettingsStore, DEFAULT_SETTINGS } = require('../../src/main/settings');

test('voice patch: valid values pass, junk is rejected', () => {
  const ok = vs.sanitizeVoicePatch({ ttsProvider: 'edge', edgeVoice: 'en-GB-RyanNeural', kokoroSpeaker: 11, kokoroSpeed: 5, whisperModel: 'small.en' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.patch, { ttsProvider: 'edge', edgeVoice: 'en-GB-RyanNeural', kokoroSpeaker: 11, kokoroSpeed: 1.4, whisperModel: 'small.en' });
  assert.equal(vs.sanitizeVoicePatch({ ttsProvider: 'groq' }).errors.length, 1);
  assert.equal(vs.sanitizeVoicePatch({ edgeVoice: '<script>' }).errors.length, 1);
  assert.equal(vs.sanitizeVoicePatch({ whisperModel: 'huge' }).errors.length, 1);
  assert.equal(vs.sanitizeVoicePatch({ kokoroSpeaker: -3 }).errors.length, 1);
  // a valid Edge voice that is not in the picker still works
  assert.deepEqual(vs.sanitizeVoicePatch({ edgeVoice: 'de-DE-KatjaNeural' }).patch, { edgeVoice: 'de-DE-KatjaNeural' });
});

test('voice patch ignores unrelated keys (the panel cannot write raw settings)', () => {
  const { patch } = vs.sanitizeVoicePatch({ wakeWordEnabled: 1, agent: { allowDrive: true }, provider: 'groq', hasCompletedOnboarding: true });
  assert.deepEqual(patch, { wakeWordEnabled: true });
});

test('wake phrase must be 2 to 4 plain words', () => {
  assert.equal(vs.cleanWakePhrase('  Hey,  SIDEKICK! '), 'hey sidekick');
  assert.equal(vs.cleanWakePhrase('sidekick'), null);
  assert.equal(vs.cleanWakePhrase('one two three four five'), null);
  assert.match(vs.cleanWakePhrase('rm -rf /; <b>'), /^[a-z ]+$/); // symbols are stripped, never kept
  assert.equal(vs.sanitizeVoicePatch({ wakePhrase: 'x' }).errors.length, 1);
});

test('follow-up toggle maps to the window length (0 = off)', () => {
  assert.equal(vs.sanitizeVoicePatch({ followUpEnabled: false }).patch.conversationWindowSec, 0);
  assert.equal(vs.sanitizeVoicePatch({ followUpEnabled: true }).patch.conversationWindowSec, 10);
  assert.equal(vs.sanitizeVoicePatch({ followUpEnabled: true, conversationWindowSec: 999 }).patch.conversationWindowSec, 60);
  assert.equal(vs.sanitizeVoicePatch({ followUpEnabled: true, conversationWindowSec: 1 }).patch.conversationWindowSec, 3);
});

test('old Kokoro 1.1 installs get the remove-then-download note', () => {
  assert.equal(vs.kokoroNote({ stt: true, tts: true, ttsVariant: 'v1_1' }).level, 'warn');
  assert.match(vs.kokoroNote({ stt: true, tts: true, ttsVariant: 'v1_1' }).text, /Remove, then Download/);
  assert.equal(vs.kokoroNote({ stt: true, tts: true, ttsVariant: 'v1_0' }).level, 'ok');
  assert.equal(vs.kokoroNote({ stt: false, tts: false }).level, 'warn');
  assert.equal(vs.kokoroNote({ stt: false, tts: true }).level, 'warn');
  assert.equal(vs.kokoroNote({ stt: true, tts: false }).level, 'info');
  assert.equal(vs.kokoroNote({ installing: true }).level, 'info');
});

test('key card follows the provider (no more "Groq" label for DeepSeek)', () => {
  assert.equal(vs.keyHint({ provider: 'deepseek' }).label, 'DeepSeek');
  assert.equal(vs.keyHint({ provider: 'groq' }).label, 'Groq');
  assert.equal(vs.keyHint({ provider: 'local' }).needsKey, false);
});

test('catalog keeps a custom saved voice selectable', () => {
  const c = vs.buildCatalog({ settings: { provider: 'deepseek', edgeVoice: 'fr-FR-DeniseNeural' }, local: { stt: true, tts: true, ttsVariant: 'v1_0' }, edge: { available: true } });
  assert.equal(c.edgeVoices[0].id, 'fr-FR-DeniseNeural');
  assert.ok(c.edgeVoices.length > 5);
  assert.equal(c.edge.available, true);
});

test('speed rules are appended once and keep the original prompt', () => {
  const out = withSpeedRules('BASE PROMPT');
  assert.ok(out.startsWith('BASE PROMPT'));
  assert.ok(out.includes(FAST_ACT_RULES));
  assert.equal(withSpeedRules(out), out);
  assert.match(FAST_ACT_RULES, /do it/i);
  assert.ok(FAST_MAX_TOKENS >= 400 && FAST_MAX_TOKENS < 900);
});

test('"open your settings" opens Sidekick, not Windows Settings', async () => {
  for (const phrase of ['open your settings', 'open sidekick settings', 'show your settings', "sidekick's settings", 'open your api key']) {
    assert.deepEqual(quick.parse(phrase), { kind: 'panel' }, phrase);
  }
  assert.notEqual((quick.parse('open settings') || {}).kind, 'panel');
  let opened = 0;
  const r = await quick.execute({ kind: 'panel' }, { openPanel: () => { opened++; } });
  assert.equal(r.handled, true);
  assert.equal(opened, 1);
  assert.equal((await quick.execute({ kind: 'panel' }, {})).handled, false);
});

test('settings defaults match what the panel shows', () => {
  assert.equal(DEFAULT_SETTINGS.wakeWordEnabled, true);
  assert.equal(DEFAULT_SETTINGS.conversationWindowSec, 10);
  assert.equal(DEFAULT_SETTINGS.ttsProvider, 'edge');
  assert.ok(SettingsStore);
});
