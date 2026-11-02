'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWakeText, extractWakeCommand, shouldListen, looksLikeEcho } = require('../../src/main/wake');

test('wake phrase matching handles punctuation, case and the built-in aliases', () => {
  assert.deepEqual(extractWakeCommand('Hey, Sidekick! What is this?', 'hey sidekick'), { matched: true, phrase: 'hey sidekick', command: 'what is this' });
  assert.deepEqual(extractWakeCommand('hey sidekick open settings', 'hey sidekick'), { matched: true, phrase: 'hey sidekick', command: 'open settings' });
  assert.deepEqual(extractWakeCommand('OKAY JARVIS', 'hey sidekick'), { matched: true, phrase: 'okay jarvis', command: '' });
  assert.equal(normalizeWakeText('  Héllo,   WORLD!  '), 'héllo world');
});

test('wake matching requires the phrase to be at the start', () => {
  assert.equal(extractWakeCommand('please open settings', 'hey sidekick'), null);
  assert.equal(extractWakeCommand('hey there, sidekick', 'hey sidekick'), null);
  assert.equal(extractWakeCommand('', 'hey sidekick'), null);
  assert.deepEqual(extractWakeCommand('hey custom wake word do it', 'hey custom wake word'), { matched: true, phrase: 'hey custom wake word', command: 'do it' });
});

test('shouldListen requires the setting, local STT and microphone permission', () => {
  const base = { wakeWordEnabled: true, sttProvider: 'local' };
  assert.equal(shouldListen(base, { stt: true }, true), true);
  assert.equal(shouldListen({ ...base, wakeWordEnabled: false }, { stt: true }, true), false);
  assert.equal(shouldListen(base, { stt: false }, true), false);
  assert.equal(shouldListen(base, { stt: true }, false), false);
  assert.equal(shouldListen({ ...base, sttProvider: 'groq' }, { stt: true }, true), false);
});

test('fuzzy wake: how Whisper really writes it', () => {
  assert.deepEqual(extractWakeCommand('Hey side kick, open chrome', 'hey sidekick'), { matched: true, phrase: 'hey sidekick', command: 'open chrome', fuzzy: true });
  assert.equal(extractWakeCommand('hi sidekick what time is it', 'hey sidekick').command, 'what time is it');
  assert.equal(extractWakeCommand('hey sidekicks', 'hey sidekick').command, '');
  assert.equal(extractWakeCommand('okay so open the settings', 'hey sidekick'), null);
  assert.equal(extractWakeCommand('the weather is nice today', 'hey sidekick'), null);
  assert.equal(extractWakeCommand('hey there how are you', 'hey sidekick'), null);
});

test('echo guard: Sidekick must not answer its own voice', () => {
  const said = 'opening google chrome for you right now';
  assert.equal(looksLikeEcho('opening google chrome for you', said), true);
  assert.equal(looksLikeEcho('open spotify', said), false);
  assert.equal(looksLikeEcho('what time is it', said), false);
  assert.equal(looksLikeEcho('', said), false);
});
