'use strict';
(function () {
  const sk = window.sidekick;
  const $ = (id) => document.getElementById(id);
  let state = { settings: null, catalog: null, local: null };

  function say(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function fill(select, items, value) {
    select.textContent = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = String(it.id);
      o.textContent = it.label;
      select.appendChild(o);
    }
    select.value = String(value);
  }
  async function call(channel, payload) {
    try { return await sk.invoke(channel, payload); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  function render() {
    const s = state.settings;
    const c = state.catalog;
    if (!s || !c) return;
    const label = c.key.label;
    $('sub').textContent = s.hasApiKey ? 'Everything saves as you change it.' : 'Paste your ' + label + ' key to get started.';

    // key card
    $('keyTitle').textContent = label + ' key';
    $('keyHint').textContent = !c.key.needsKey
      ? 'This mode runs on your PC (Ollama) and needs no key.'
      : s.apiKeyFromEnv
        ? 'A key is set through the environment variable on this PC, and it takes priority over a pasted key.'
        : 'Sidekick uses ' + label + ' for thinking. The key is stored encrypted on this PC and only ever sent to ' + label + '.';
    const chip = $('keyChip');
    chip.textContent = s.hasApiKey ? 'Key saved' : 'No key yet';
    chip.className = 'chip ' + (s.hasApiKey ? 'ok' : 'bad');
    $('keyInput').placeholder = 'Paste your ' + label + ' key here';
    $('keyGet').hidden = !c.key.url;
    $('keyClear').hidden = !s.hasApiKey || !!s.apiKeyFromEnv;

    // voice
    $('engine').value = ['edge', 'local', 'windows'].includes(s.ttsProvider) ? s.ttsProvider : 'edge';
    fill($('edgeVoice'), c.edgeVoices, s.edgeVoice);
    fill($('kokoroSpeaker'), c.kokoroVoices, s.kokoroSpeaker);
    if (!c.kokoroVoices.some((v) => String(v.id) === String(s.kokoroSpeaker))) $('kokoroSpeaker').selectedIndex = 0;
    $('edgeField').hidden = $('engine').value !== 'edge';
    $('kokoroField').hidden = $('engine').value !== 'local';
    $('edgeNote').textContent = $('engine').value === 'edge'
      ? (c.edge.available ? 'If the internet or Microsoft\u2019s service is down, the offline voice and then the Windows voice take over automatically.' : 'The natural voice package is missing: run "npm install" in the Sidekick folder. Until then the offline or Windows voice speaks.')
      : $('engine').value === 'local' ? 'Needs the local voice download below.' : 'The basic Windows voice. Always works, sounds robotic.';

    // hearing + local voice
    const note = $('kokoroNote');
    note.textContent = c.kokoroNote.text;
    note.className = 'note ' + c.kokoroNote.level;
    fill($('whisperModel'), c.whisperModels, s.whisperModel);
    $('whisperHint').textContent = 'Changing the hearing model takes effect after Remove, then Download.';
    renderInstall();

    // hands-free
    $('wakeOn').checked = !!s.wakeWordEnabled;
    $('wakePhrase').value = s.wakePhrase || 'hey sidekick';
    $('wakePhraseField').hidden = !s.wakeWordEnabled;
    const sec = Number(s.conversationWindowSec) || 0;
    $('followOn').checked = sec > 0;
    $('followField').hidden = sec <= 0;
    if (sec > 0) { $('followSec').value = String(sec); $('followLabel').textContent = sec + ' s'; }
    $('quickOn').checked = s.quickCommands !== false;
    $('capOn').checked = s.captions !== false;
    $('eyesOn').checked = s.eyesEnabled !== false;
    $('eyesCornerField').hidden = s.eyesEnabled === false;
    $('eyesCorner').value = s.eyesCorner || 'bottom-right';
  }

  function renderInstall() {
    const l = state.local || {};
    const p = l.progress || {};
    $('bar').hidden = !l.installing;
    $('barFill').style.width = (p.percent || 0) + '%';
    $('installStage').textContent = l.installing ? (p.stage || 'Working...') : (p.error ? 'Problem: ' + p.error : '');
    $('lvInstall').disabled = !!l.installing;
    $('lvRemove').disabled = !!l.installing || (!l.stt && !l.tts);
    $('lvInstall').textContent = l.stt && l.tts ? 'Download again' : 'Download';
  }

  async function load() {
    const r = await call('voice:catalog');
    if (!r || !r.ok) { $('sub').textContent = 'Could not load settings: ' + ((r && r.error) || 'unknown error'); return; }
    state.settings = r.settings;
    state.catalog = r.catalog;
    const ls = await call('localvoice:status');
    state.local = ls && !ls.error ? ls : state.local;
    render();
  }

  async function saveVoice(patch, msgEl) {
    const r = await call('settings:voice', patch);
    if (!r || !r.ok) { say(msgEl || $('voiceMsg'), (r && r.error) || 'Could not save.', 'err'); await load(); return false; }
    state.settings = r.settings;
    say(msgEl || $('voiceMsg'), 'Saved.', 'ok');
    // note + hands-free fields depend on fresh status
    const cat = await call('voice:catalog');
    if (cat && cat.ok) state.catalog = cat.catalog;
    render();
    return true;
  }

  async function preview(btn, payload) {
    btn.disabled = true;
    say($('voiceMsg'), 'Playing...');
    const r = await call('voice:preview', payload);
    btn.disabled = false;
    say($('voiceMsg'), r && r.ok ? '' : (r && r.error) || 'Could not play that.', r && r.ok ? '' : 'err');
  }

  // events
  $('keySave').addEventListener('click', async () => {
    const key = $('keyInput').value.trim();
    if (!key) { say($('keyMsg'), 'Paste a key first.', 'err'); return; }
    $('keySave').disabled = true;
    say($('keyMsg'), 'Checking the key...');
    const r = await call('settings:setApiKey', { key });
    $('keySave').disabled = false;
    if (r && r.ok) { $('keyInput').value = ''; say($('keyMsg'), 'Key saved and working.', 'ok'); await load(); }
    else say($('keyMsg'), (r && r.error) || 'That key did not work.', 'err');
  });
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('keySave').click(); });
  $('keyGet').addEventListener('click', (e) => { e.preventDefault(); call('panel:open', { action: 'keypage' }); });
  $('keyClear').addEventListener('click', async (e) => {
    e.preventDefault();
    const r = await call('settings:setApiKey', { key: '' });
    say($('keyMsg'), r && r.ok ? 'Key removed.' : (r && r.error) || 'Could not remove it.', r && r.ok ? 'ok' : 'err');
    await load();
  });

  $('engine').addEventListener('change', () => saveVoice({ ttsProvider: $('engine').value }));
  $('edgeVoice').addEventListener('change', () => saveVoice({ edgeVoice: $('edgeVoice').value }));
  $('kokoroSpeaker').addEventListener('change', () => saveVoice({ kokoroSpeaker: Number($('kokoroSpeaker').value) }));
  $('edgePreview').addEventListener('click', () => preview($('edgePreview'), { engine: 'edge', voice: $('edgeVoice').value }));
  $('kokoroPreview').addEventListener('click', () => preview($('kokoroPreview'), { engine: 'local', speaker: Number($('kokoroSpeaker').value) }));

  $('whisperModel').addEventListener('change', () => saveVoice({ whisperModel: $('whisperModel').value }, $('wakeMsg')));
  $('lvInstall').addEventListener('click', async () => { await call('localvoice:install'); });
  $('lvRemove').addEventListener('click', async () => {
    const r = await call('localvoice:remove');
    if (r && r.status) state.local = r.status;
    await load();
  });

  $('wakeOn').addEventListener('change', () => saveVoice({ wakeWordEnabled: $('wakeOn').checked }, $('wakeMsg')));
  let phraseTimer = null;
  $('wakePhrase').addEventListener('input', () => {
    clearTimeout(phraseTimer);
    phraseTimer = setTimeout(() => saveVoice({ wakePhrase: $('wakePhrase').value }, $('wakeMsg')), 700);
  });
  $('followOn').addEventListener('change', () => saveVoice({ followUpEnabled: $('followOn').checked, conversationWindowSec: Number($('followSec').value) || 10 }, $('wakeMsg')));
  $('followSec').addEventListener('input', () => { $('followLabel').textContent = $('followSec').value + ' s'; });
  $('followSec').addEventListener('change', () => saveVoice({ followUpEnabled: true, conversationWindowSec: Number($('followSec').value) }, $('wakeMsg')));
  $('quickOn').addEventListener('change', () => saveVoice({ quickCommands: $('quickOn').checked }, $('wakeMsg')));
  $('capOn').addEventListener('change', () => saveVoice({ captions: $('capOn').checked }, $('wakeMsg')));

  $('eyesOn').addEventListener('change', () => saveVoice({ eyesEnabled: $('eyesOn').checked }, $('wakeMsg')));
  $('eyesCorner').addEventListener('change', () => saveVoice({ eyesCorner: $('eyesCorner').value }, $('wakeMsg')));
  $('logOpen').addEventListener('click', () => call('logs:open'));

  // live updates: install progress, and settings changed elsewhere
  try {
    sk.on('localvoice', (st) => { state.local = st; renderInstall(); if (!st.installing) load(); });
    sk.on('settings', (pub) => { if (pub) { state.settings = pub; } });
  } catch (_) { /* channel missing: the panel still works, just without live progress */ }

  load();
})();
