'use strict';
/* Sidekick Home: chat, agent jobs, routines, memory, settings. */
(function () {
  const api = window.sidekick;
  const nav = document.getElementById('nav');
  const main = document.getElementById('main');
  let section = 'chat';
  let settings = null;
  let status = null;
  let chat = [];
  const jobs = new Map();
  let draft = '';
  let keyDraft = '';
  let keyMsg = '';
  let voiceMsg = '';
  let wakeMsg = '';
  let catalog = null;
  const routineDraft = { days: [1, 2, 3, 4, 5], time: '09:00', task: '' };
  let appInfo = {};
  let localVoice = { stt: false, tts: false, installing: false, progress: { stage: '', percent: 0, error: '' } };
  const ollama = { models: [], caps: {}, loading: false, loaded: false, error: '', tested: '', root: '' };
  const safetyDraft = { blocked: null, allowed: null, always: null };
  const foldersState = { loaded: false, isDefault: true, folders: [], drives: [], home: '', note: '', msg: '', msgKind: 'info' };
  const activityState = { items: [], filter: 'all', loaded: false };

  const I = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const SECTIONS = [
    { id: 'chat', label: 'Chat', icon: I('<path d="M4 5h16v11H9l-5 4z"/>') },
    { id: 'agent', label: 'Agent jobs', icon: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>') },
    { id: 'routines', label: 'Routines', icon: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
    { id: 'memory', label: 'Memory', icon: I('<path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3 3 3 0 0 0 2 3v1a3 3 0 0 0 3 3h1V4zM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-2 3v1a3 3 0 0 1-3 3h-1V4z"/>') },
    { id: 'folders', label: 'Folders', icon: I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>') },
    { id: 'activity', label: 'Activity', icon: I('<path d="M3 12h4l3-8 4 16 3-8h4"/>') },
    { id: 'visuals', label: 'Visuals and 3D', icon: I('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>') },
    { id: 'settings', label: 'Settings', icon: I('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>') },
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  const parseList = (text) => Array.from(new Set(String(text || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))).slice(0, 120);
  const listText = (list) => (Array.isArray(list) ? list.join('\n') : '');
  const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const shortcutText = () => (status && status.shortcut ? status.shortcut.displayText : 'Ctrl+Alt');

  function renderNav() {
    const live = Array.from(jobs.values()).filter((j) => j.status === 'running' || j.status === 'waiting').length;
    nav.innerHTML =
      SECTIONS.map((s) => `<button data-sec="${s.id}" class="${s.id === section ? 'sel' : ''}">${s.icon}<span>${s.label}</span>${s.id === 'agent' && live ? `<span class="badge">${live}</span>` : ''}</button>`).join('') +
      '<div class="grow"></div>' +
      `<div class="muted" style="font-size:11px;padding:8px 12px;line-height:1.5">${status ? `<span class="dot ${status.voiceState === 'idle' ? 'green' : 'blue'}" style="display:inline-block;margin-right:6px"></span>${esc(status.statusText)}` : ''}<br>Hold ${esc(shortcutText())} to talk</div>`;
  }

  // ------------------------------------------------------------ chat
  function chatView() {
    const msgs = chat.length
      ? chat.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('')
      : `<div class="empty"><div class="big">Ask Sidekick anything</div>Type here, or hold ${esc(shortcutText())} anywhere to talk. Sidekick looks at your screen, points at things, draws on it, and can drive your computer when you ask it to.</div>`;
    const chips = ['How do I make a new folder?', 'Open YouTube and search for lo-fi music', 'Explain what is on my screen', 'Show me a 3D model of a plant cell'];
    return `<div class="page chat" style="padding:0"><div class="msgs" id="msgs">${msgs}</div>
      ${chat.length ? '' : `<div class="chips">${chips.map((c) => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>`}
      <div class="composer"><textarea id="draft" class="field" placeholder="Message Sidekick..." rows="1">${esc(draft)}</textarea>
      <button class="btn btn-primary" style="animation:none" data-act="send">Send</button></div></div>`;
  }

  function scrollChat() {
    const m = document.getElementById('msgs');
    if (m) m.scrollTop = m.scrollHeight;
  }

  // ------------------------------------------------------------ jobs
  function jobsView() {
    const list = Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
    const body = list.length
      ? list.map((j) => `<div class="card"><div class="job"><div style="flex:1;min-width:0"><div style="display:flex;gap:10px;align-items:center"><b>${esc(j.name)}</b><span class="jstatus ${j.status}">${j.status}</span></div>
          <div class="muted" style="margin-top:4px">${esc(j.note || '')}</div>
          ${j.log && j.log.length ? `<div class="joblog">${esc(j.log.join('\n'))}</div>` : ''}</div>
          ${j.status === 'running' || j.status === 'waiting' ? `<button class="btn btn-destructive" data-act="stop-job" data-id="${j.id}">Stop</button>` : ''}</div></div>`).join('')
      : '<div class="card muted">No jobs yet. Ask Sidekick to "open my downloads folder and tell me what is big" or to "do X for me" and it will show up here.</div>';
    const s = settings.agent;
    return `<div class="page"><h1>Agent jobs</h1><p class="lead">Sidekick can work in the background (web search, files, summaries) or take over the mouse and keyboard when you approve it. Press Esc or move the mouse to stop at any time.</p>
      ${body}
      <div class="card"><h3>Run a task</h3><div class="kv"><input id="jobtask" class="field" placeholder="e.g. open Notepad and write a shopping list"><button class="btn btn-secondary" data-act="run-bg">Background</button><button class="btn btn-primary" style="animation:none" data-act="run-drive" ${s.allowDrive ? '' : 'disabled'}>Drive my PC</button></div></div></div>`;
  }

  // ------------------------------------------------------------ routines
  function routinesView() {
    const rs = settings.routines || [];
    const list = rs.length
      ? rs.map((r) => `<div class="card"><div class="row" style="padding:0"><div><div class="t">${esc(r.task)}</div><div class="d">${esc(r.scheduleText || '')}</div></div>
          <div style="display:flex;gap:12px;align-items:center"><div class="switch ${r.enabled === false ? '' : 'on'}" data-act="toggle-routine" data-id="${r.id}"></div><button class="btn btn-tertiary" data-act="del-routine" data-id="${r.id}">Delete</button></div></div></div>`).join('')
      : '<div class="card muted">No routines. Say something like "every weekday at 9 give me the top tech headlines" and Sidekick will save it here.</div>';
    return `<div class="page"><h1>Routines</h1><p class="lead">Recurring tasks run in the background while Sidekick is open in the tray. They never take over your mouse unless you set that up with approval.</p>${list}
      <div class="card"><h3>New routine</h3><div class="days" style="margin-bottom:10px">${DAYS.map((d, i) => `<button data-day="${i}" class="${routineDraft.days.includes(i) ? 'on' : ''}">${d}</button>`).join('')}</div>
      <div class="kv"><input id="rtime" class="field" style="width:100px;flex:none" type="time" value="${routineDraft.time}"><input id="rtask" class="field" placeholder="What should Sidekick do?" value="${esc(routineDraft.task)}"><button class="btn btn-primary" style="animation:none" data-act="add-routine">Add</button></div></div></div>`;
  }

  // ------------------------------------------------------------ memory
  function memoryView() {
    const mem = settings.memory || [];
    return `<div class="page"><h1>Memory</h1><p class="lead">Short facts Sidekick remembers about you so answers feel personal. Stored only on this PC and sent to Groq as context with your questions.</p>
      <div class="card">${mem.length ? mem.map((m, i) => `<span class="pill">${esc(m)}<button data-act="del-mem" data-i="${i}" aria-label="Forget">&#x2715;</button></span>`).join('') : '<span class="muted">Nothing yet. Tell Sidekick "remember that I use VS Code".</span>'}</div>
      <div class="card"><h3>Add a memory</h3><div class="kv"><input id="memnew" class="field" placeholder="e.g. I prefer dark mode"><button class="btn btn-secondary" data-act="add-mem">Remember</button></div></div></div>`;
  }

  // ------------------------------------------------------------ folders
  function fmtBytes(n) {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
  }
  const samePath = (a, b) => String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();

  function foldersView() {
    const f = foldersState;
    const rows = f.folders.length
      ? f.folders.map((r, i) => `<div class="row"><div style="min-width:0"><div class="t folder-path">${esc(r.path)}</div><div class="d">${r.write ? 'Sidekick can read this folder and change files in it (move, save).' : 'Sidekick can only look: list, read and measure.'}</div></div>
          <div style="display:flex;gap:10px;align-items:center;flex:none"><div class="segmented"><button class="${r.write ? '' : 'sel'}" data-act="folder-ro" data-i="${i}">Read only</button><button class="${r.write ? 'sel' : ''}" data-act="folder-rw" data-i="${i}">Read and change</button></div>
          <button class="btn btn-tertiary" data-act="folder-remove" data-i="${i}" aria-label="Remove folder">Remove</button></div></div>`).join('')
      : '<div class="muted" style="padding:6px 0">No folders allowed. Sidekick cannot look at any files until you add one.</div>';
    const drives = f.drives.length
      ? f.drives.map((d) => {
          const added = f.folders.some((r) => samePath(r.path, d.root));
          const used = d.total ? Math.max(0, Math.min(100, Math.round(((d.total - d.free) / d.total) * 100))) : 0;
          return `<div class="row"><div style="flex:1;min-width:0"><div class="t">${esc(d.root)}</div><div class="d">${fmtBytes(d.free)} free of ${fmtBytes(d.total)}</div><div class="bar"><i style="width:${used}%"></i></div></div>
            ${added ? '<span class="chip ok">Allowed</span>' : `<button class="btn btn-secondary" data-act="drive-add" data-root="${esc(d.root)}">Allow read only</button>`}</div>`;
        }).join('')
      : '<div class="muted">No drives found.</div>';
    return `<div class="page"><h1>Folders</h1><p class="lead">Choose which folders Sidekick may look at, and which it may also change. Anything outside this list is off limits, on any drive. By default it only has your user folder.</p>
      ${f.msg ? `<div class="note ${f.msgKind}">${esc(f.msg)}</div>` : ''}
      <div class="card"><h3>Allowed folders${f.isDefault ? ' (default)' : ''}</h3>${rows}
        <div class="kv" style="margin-top:10px;justify-content:flex-start"><button class="btn btn-primary" style="animation:none" data-act="folder-add">Add folder...</button>${f.isDefault ? '' : '<button class="btn btn-tertiary" data-act="folder-reset">Reset to default</button>'}</div></div>
      <div class="card"><h3>Drives</h3>${drives}</div>
      <div class="card"><h3>Always protected</h3><div class="secondary" style="line-height:1.6">${esc(f.note || '')}</div></div></div>`;
  }

  async function loadFolders() {
    const r = await api.invoke('folders:get');
    if (r && r.ok) Object.assign(foldersState, { loaded: true, isDefault: r.isDefault, folders: r.folders || [], drives: r.drives || [], home: r.home || '', note: r.note || '' });
    if (section === 'folders') renderUnlessTyping();
  }
  async function saveFolders(list, okMsg) {
    const r = await api.invoke('folders:set', { folders: list });
    if (r && r.ok) {
      Object.assign(foldersState, { isDefault: r.isDefault, folders: r.folders || [], drives: r.drives || foldersState.drives, note: r.note || foldersState.note });
      foldersState.msg = r.warning || okMsg || '';
      foldersState.msgKind = r.warning ? 'warn' : 'ok';
    } else {
      foldersState.msg = (r && r.error) || 'Could not save the folders.';
      foldersState.msgKind = 'warn';
    }
    render();
  }
  const folderList = () => foldersState.folders.map((r) => ({ path: r.path, write: !!r.write }));

  // ------------------------------------------------------------ activity
  const ACT_FILTERS = [['all', 'Everything'], ['changes', 'Changes'], ['blocked', 'Blocked'], ['reads', 'Looked only']];
  function timeText(at) {
    const d = new Date(at);
    if (isNaN(d)) return '';
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
  }
  function activityView() {
    const a = activityState;
    const chips = ACT_FILTERS.map(([id, l]) => `<button class="chip ${a.filter === id ? 'ok' : ''}" data-act="act-filter" data-f="${id}">${l}</button>`).join('');
    const list = a.items.length
      ? a.items.map((e) => `<div class="act ${e.blocked ? 'blocked' : (e.ok === false ? 'failed' : '')}"><span class="act-dot k-${esc(e.kind)}"></span><div style="flex:1;min-width:0"><div class="act-sum">${esc(e.summary)}</div><div class="d">${esc(e.source)}${e.job ? ' &middot; ' + esc(e.job) : ''}${e.detail ? ' &middot; ' + esc(e.detail) : ''}</div></div><div class="act-time">${e.blocked ? '<span class="jstatus failed">blocked</span> ' : (e.ok === false ? '<span class="jstatus failed">failed</span> ' : '')}${esc(timeText(e.at))}</div></div>`).join('')
      : `<div class="muted" style="padding:6px 0">${a.loaded ? 'Nothing here yet. Every action Sidekick takes will show up in this list.' : 'Loading...'}</div>`;
    return `<div class="page"><h1>Activity</h1><p class="lead">A record of everything Sidekick looked at or did: files it read, apps it opened, keys it pressed, and anything it was stopped from doing. What you ask it to type is never saved, only how long it was.</p>
      <div class="kv" style="margin-bottom:12px;justify-content:space-between"><div style="display:flex;gap:8px;flex-wrap:wrap">${chips}</div><div style="display:flex;gap:6px"><button class="btn btn-tertiary" data-act="act-open">Open log file</button><button class="btn btn-tertiary" data-act="act-clear">Clear</button></div></div>
      <div class="card acts">${list}</div></div>`;
  }
  async function loadActivity() {
    const r = await api.invoke('activity:list', { filter: activityState.filter, limit: 200 });
    if (r && r.ok) { activityState.items = r.items || []; activityState.loaded = true; }
    if (section === 'activity') renderUnlessTyping();
  }

  // ------------------------------------------------------------ visuals
  function visualsView() {
    const demos = [
      ['Plant cell', 'a plant cell with its organelles'], ['Solar system', 'the solar system'], ['DNA helix', 'a DNA double helix'],
      ['Engine', 'a four-stroke engine piston and crankshaft'], ['Atom', 'a carbon atom with electron shells'], ['Pyramid', 'the great pyramid of giza'],
    ];
    return `<div class="page"><h1>Visuals and 3D</h1><p class="lead">When it helps, Sidekick draws arrows, circles and step numbers right on your screen, shows info cards with photos, and builds interactive 3D models you can rotate and click to ask about.</p>
      <div class="card"><h3>Try a 3D model</h3>${demos.map(([t, q]) => `<div class="tile" data-model="${esc(q)}"><b>${t}</b><span>${esc(q)}</span></div>`).join('')}
      <div class="kv" style="margin-top:8px"><input id="modeltopic" class="field" placeholder="Anything: a bicycle, the heart, a castle..."><button class="btn btn-primary" style="animation:none" data-act="make-model">Generate</button></div></div>
      <div class="card"><h3>Ask by voice</h3><div class="secondary" style="line-height:1.6">"Draw an arrow to the save button", "circle what is wrong in this code", "show me how a heart pumps blood in 3D", "give me a card about the Eiffel tower".</div></div></div>`;
  }

  // ------------------------------------------------------------ settings
  function sel(id, value, options) {
    return `<select class="field" id="${id}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }
  function tog(act, on) {
    return `<div class="switch ${on ? 'on' : ''}" data-act="${act}"></div>`;
  }
  async function loadCatalog() {
    try {
      const r = await api.invoke('voice:catalog');
      if (r && r.ok) catalog = r.catalog;
    } catch (_) {}
  }

  // ------------------------------------------------------------ AI backend (DeepSeek / Groq / Ollama)
  function aiBadges(model, { compact = false } = {}) {
    const caps = ollama.caps[model];
    if (!caps) {
      if (!model) return '<span class="ai-badge missing">no model selected</span>';
      return '<span class="ai-badge">capabilities not checked</span>';
    }
    const wanted = ['completion', 'vision', 'tools', 'thinking'];
    const shown = wanted.filter((c) => caps.includes(c));
    if (!shown.length) return '<span class="ai-badge">text only</span>';
    return shown.map((c) => `<span class="ai-badge ${esc(c)}">${esc(c)}</span>`).join('');
  }
  function modelOptions(selected) {
    const names = ollama.models.map((m) => m.name);
    if (selected && !names.includes(selected)) names.unshift(selected);
    if (!names.length) return `<option value="${esc(selected || '')}">${esc(selected || 'No models found')}</option>`;
    return names.map((n) => `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  function aiBackendCard(s) {
    const local = s.provider === 'local';
    const isGroq = s.provider === 'groq';
    return `<div class="card"><h3>AI backend</h3>
      <p class="d" style="margin:0 0 4px">DeepSeek is the default cloud provider for fast thinking. Local runs an Ollama server on this PC with no key.</p>
      <div class="row"><div><div class="t">Backend</div><div class="d">${local ? 'Ollama on this PC. Speech uses offline Whisper and Kokoro, because Ollama has no audio endpoints.' : isGroq ? 'Groq cloud with your own API key.' : 'DeepSeek cloud with your own API key.'}</div></div>
        <div class="segmented"><button data-act="ai-deepseek" class="${!local && !isGroq ? 'sel' : ''}">DeepSeek</button><button data-act="ai-groq" class="${isGroq ? 'sel' : ''}">Groq</button><button data-act="ai-local" class="${local ? 'sel' : ''}">Local (Ollama)</button></div></div>
      <div class="row"><div><div class="t">Model mode</div><div class="d">Fast gives short answers. Deep gives a longer token budget.</div></div><div class="segmented"><button data-act="mode-fast" class="${s.modelMode !== 'deep' ? 'sel' : ''}">Fast</button><button data-act="mode-deep" class="${s.modelMode === 'deep' ? 'sel' : ''}">Deep</button></div></div>
    </div>`;
  }
  function keyCard(s) {
    const isGroq = s.provider === 'groq';
    const label = isGroq ? 'Groq' : 'DeepSeek';
    const envVar = isGroq ? 'GROQ_API_KEY' : 'DEEPSEEK_API_KEY';
    const keySrc = s.apiKeyFromEnv ? `From ${envVar} environment variable` : s.hasApiKey ? 'Stored encrypted with Windows DPAPI' : 'Not set';
    return `<div class="card">
      <div class="row between">
        <h3>${label} key</h3>
        <span class="chip ${s.hasApiKey ? 'ok' : 'bad'}" style="font-size:11px">${s.hasApiKey ? 'Key saved' : 'No key yet'}</span>
      </div>
      <div class="row"><div><div class="t">API key</div><div class="d">${keySrc}. Sidekick uses ${label} for thinking. The key is stored encrypted on this PC and only ever sent to ${label}.</div></div></div>
      <div class="kv" style="margin:4px 0 6px">
        <input id="keyin" type="password" class="field" placeholder="${s.hasApiKey ? 'Paste a new key to replace it' : (isGroq ? 'gsk_...' : 'sk-...')}" value="${esc(keyDraft)}">
        <button class="btn btn-primary" style="animation:none;padding:7px 16px" data-act="save-key">Save</button>
        ${s.hasApiKey && !s.apiKeyFromEnv ? '<button class="btn btn-tertiary" data-act="clear-key">Remove</button>' : ''}
      </div>
      <div class="row" style="padding:0 0 6px">
        <a href="#" data-act="get-key" style="color:var(--accent-text);font-size:12px">Get a key from ${label}</a>
      </div>
      ${keyMsg ? `<div style="font-size:12px;margin-bottom:8px;color:${keyMsg.startsWith('ok') ? 'var(--success)' : '#ff9a9d'}">${esc(keyMsg.replace(/^ok:|^err:/, ''))}</div>` : ''}
      <div class="row"><div><div class="t">Chat and vision model</div><div class="d">For example ${isGroq ? 'qwen/qwen3.8-27b' : 'deepseek-flash'}.</div></div><input class="field" style="width:240px" id="visionModel" value="${esc(s.visionModel)}"></div>
    </div>`;
  }
  function voiceCard(s) {
    const cat = catalog || {};
    const engine = ['edge', 'local', 'windows'].includes(s.ttsProvider) ? s.ttsProvider : 'edge';
    const edgeVoices = (cat.edgeVoices || [
      { id: 'en-US-AvaMultilingualNeural', label: 'Ava (female, very natural)' },
      { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (male, warm)' },
      { id: 'en-US-EmmaMultilingualNeural', label: 'Emma (female, friendly)' },
      { id: 'en-US-BrianMultilingualNeural', label: 'Brian (male, calm)' },
      { id: 'en-GB-RyanNeural', label: 'Ryan (British male)' },
    ]).map((v) => [v.id, v.label]);
    const kokoroVoices = (cat.kokoroVoices || [
      { id: 3, label: 'Heart (female, warm)' },
      { id: 2, label: 'Bella (female)' },
      { id: 4, label: 'Jessica (female)' },
      { id: 7, label: 'Nova (female)' },
      { id: 11, label: 'Adam (male)' },
      { id: 16, label: 'Michael (male)' },
    ]).map((v) => [String(v.id), v.label]);

    let engineSpecific = '';
    if (engine === 'edge') {
      const edgeAvail = cat.edge ? cat.edge.available : true;
      const note = edgeAvail
        ? 'If the internet or Microsoft service is down, the offline voice and then the Windows voice take over automatically.'
        : 'The natural voice package is missing: run "npm install" in the Sidekick folder. Until then the offline or Windows voice speaks.';
      engineSpecific = `<div class="row"><div class="t">Natural voice</div>
        <div class="kv" style="flex:1;justify-content:flex-end">
          ${sel('edgeVoice', s.edgeVoice, edgeVoices)}
          <button class="btn btn-secondary" data-act="preview-edge">Play</button>
        </div></div>
        <div class="row"><div class="d">${note}</div></div>`;
    } else if (engine === 'local') {
      engineSpecific = `<div class="row"><div class="t">Offline voice</div>
        <div class="kv" style="flex:1;justify-content:flex-end">
          ${sel('kokoroSpeaker', String(s.kokoroSpeaker), kokoroVoices)}
          <button class="btn btn-secondary" data-act="preview-kokoro">Play</button>
        </div></div>
        <div class="row"><div class="d">Needs the local voice download below.</div></div>`;
    } else {
      engineSpecific = `<div class="row"><div class="d">The basic Windows voice. Always works, sounds robotic.</div></div>`;
    }

    return `<div class="card"><h3>Voice</h3>
      <div class="row"><div><div class="t">Voice engine</div><div class="d">Choose how Sidekick speaks to you.</div></div>
        <div class="segmented">
          <button data-act="tts-edge" class="${engine === 'edge' ? 'sel' : ''}">Natural</button>
          <button data-act="tts-local" class="${engine === 'local' ? 'sel' : ''}">Offline</button>
          <button data-act="tts-windows" class="${engine === 'windows' ? 'sel' : ''}">Windows</button>
        </div>
      </div>
      ${engineSpecific}
      ${voiceMsg ? `<div style="font-size:12px;margin:4px 0;color:var(--accent-text)">${esc(voiceMsg)}</div>` : ''}
      <div class="row"><div><div class="t">Push-to-talk shortcut</div></div>${sel('shortcut', s.pushToTalkShortcut, [['ctrl+alt', 'Control + Alt'], ['shift+ctrl', 'Shift + Control'], ['ctrl+space', 'Control + Space'], ['alt+space', 'Alt + Space'], ['double-ctrl', 'Double-tap Control']])}</div>
    </div>`;
  }
  function hearingCard(s) {
    const cat = catalog || {};
    const lv = localVoice;
    const p = lv.progress || {};
    const ready = lv.stt && lv.tts;
    const kn = cat.kokoroNote || {
      level: lv.tts && lv.ttsVariant === 'v1_1' ? 'warn' : ready ? 'ok' : 'info',
      text: lv.tts && lv.ttsVariant === 'v1_1'
        ? 'Your backup voice is the old Kokoro 1.1, which sounds robotic. Press Remove, then Download to get the corrected one.'
        : ready ? 'Local voice is installed (hearing + offline backup voice).' : 'The local voice is needed for hearing (Whisper) and offline backup speech.'
    };
    const whisperModels = (cat.whisperModels || [
      { id: 'tiny.en', label: 'Tiny (fastest, mishears more)' },
      { id: 'base.en', label: 'Base (balanced, default)' },
      { id: 'small.en', label: 'Small (hears accents better, slower)' },
    ]).map((m) => [m.id, m.label]);

    let body;
    if (lv.installing) {
      body = `<div class="row"><div><div class="t">${esc(p.stage || 'Working')}...</div><div class="d">Keep Sidekick open. This is a one-time download of a few hundred MB.</div></div></div>
        <div class="progress"><i style="width:${Math.max(2, p.percent || 0)}%"></i></div>`;
    } else {
      body = `<div class="row"><div><div class="t">${ready ? 'Installed' : (lv.stt || lv.tts) ? 'Partly installed' : 'Not installed'}</div><div class="d">Whisper (you talking): ${lv.stt ? 'ready' : 'missing'}. Kokoro (Sidekick talking): ${lv.tts ? 'ready' : 'missing'}.</div></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" style="animation:none;padding:7px 16px" data-act="lv-install">${ready ? 'Download again' : 'Download'}</button>
          <button class="btn btn-tertiary" data-act="lv-remove" ${(!lv.stt && !lv.tts) ? 'disabled' : ''}>Remove</button>
        </div></div>`;
    }
    const err = p.error ? `<div style="font-size:12px;color:#ff9a9d;margin-top:6px">${esc(p.error)}</div>` : '';

    return `<div class="card"><h3>Hearing &amp; local voice</h3>
      ${kn.text ? `<div class="note ${kn.level}">${esc(kn.text)}</div>` : ''}
      <div class="row"><div class="t">Hearing model</div>${sel('whisperModel', s.whisperModel, whisperModels)}</div>
      <p class="d" style="margin:2px 0 8px">Changing the hearing model takes effect after Remove, then Download.</p>
      ${body}${err}
      <p class="d" style="margin:8px 0 0">If you had an older install, press Remove and then Download once. That fetches the corrected voice and your chosen hearing model.</p>
    </div>`;
  }
  function handsFreeCard(s) {
    const sec = Number(s.conversationWindowSec) || 0;
    const followOn = sec > 0;
    return `<div class="card"><h3>Hands-free</h3>
      <div class="row"><div><div class="t">Wake word</div><div class="d">Always listening for the phrase below.</div></div>${tog('toggle-wake', s.wakeWordEnabled)}</div>
      ${s.wakeWordEnabled ? `<div class="row"><div><div class="t">Wake phrase</div><div class="d">Try "${esc(s.wakePhrase || 'hey sidekick')}, what is this?" or just the phrase, then speak your question.</div></div><div class="kv"><input class="field" id="wakePhrase" style="width:190px" value="${esc(s.wakePhrase || 'hey sidekick')}" spellcheck="false"><button class="btn btn-secondary" data-act="save-wake">Save</button></div></div>` : ''}
      <div class="row"><div><div class="t">Keep listening after an answer</div><div class="d">No wake word needed for follow-up questions.</div></div>${tog('toggle-follow', followOn)}</div>
      ${followOn ? `<div class="row"><div><div class="t">Follow-up window</div></div><div class="kv" style="flex:1;max-width:280px"><input id="followSec" type="range" min="3" max="30" step="1" value="${sec}"><span id="followLabel" class="val">${sec} s</span></div></div>` : ''}
      <p class="d" style="margin:8px 0 0">Wake word and hearing both need the local voice from the card above.</p>
      ${wakeMsg ? `<div style="font-size:12px;margin-top:6px;color:var(--accent-text)">${esc(wakeMsg)}</div>` : ''}
    </div>`;
  }
  function speedAndDisplayCard(s) {
    const corners = [
      ['bottom-right', 'Bottom right'],
      ['bottom-left', 'Bottom left'],
      ['top-right', 'Top right'],
      ['top-left', 'Top left'],
    ];
    return `<div class="card"><h3>Speed &amp; display</h3>
      <div class="row"><div><div class="t">Instant commands without the AI</div><div class="d">Open apps, change volume, check time, and stop run instantly.</div></div>${tog('toggle-quick', s.quickCommands !== false)}</div>
      <div class="row"><div><div class="t">Show captions</div><div class="d">Displays text captions while Sidekick talks.</div></div>${tog('toggle-captions', s.captions)}</div>
      <div class="row"><div><div class="t">Little eyes in the corner</div><div class="d">Cartoon eyes follow your mouse and react to listening, thinking, and talking.</div></div>${tog('toggle-eyes', s.eyesEnabled !== false)}</div>
      ${s.eyesEnabled !== false ? `<div class="row"><div class="t">Eyes corner</div>${sel('eyesCorner', s.eyesCorner || 'bottom-right', corners)}</div>` : ''}
    </div>`;
  }
  function ollamaCard(s) {
    const capsV = ollama.caps[s.visionModel];
    const capsA = ollama.caps[s.agentModel];
    const testClass = ollama.tested.startsWith('ok:') ? 'good' : ollama.tested.startsWith('err:') ? 'bad' : '';
    const testText = ollama.tested ? ollama.tested.replace(/^ok:|^err:/, '') : '';
    return `<div class="card"><h3>Local AI (Ollama)</h3>
      <p class="d" style="margin:0 0 8px">Point this at a running Ollama server. Models come from <code style="font-size:11px">GET /api/tags</code>; vision and tools badges come from <code style="font-size:11px">POST /api/show</code>. Nothing leaves this PC.</p>
      <div class="row"><div class="t">Ollama address</div><div class="kv" style="flex:1;justify-content:flex-end"><input id="ollamaRoot" class="field" style="max-width:280px" value="${esc(ollama.root || s.ollamaRoot)}" spellcheck="false"><button class="btn btn-secondary" data-act="ollama-save-root">Save</button></div></div>
      <div class="row"><div><div class="t">Connection test</div><div class="d">Checks <code style="font-size:11px">GET /v1/models</code> on the same server.</div></div><div style="display:flex;gap:8px;align-items:center"><span class="ai-status ${testClass}">${esc(testText)}</span><button class="btn btn-secondary" data-act="ollama-test">Test</button><button class="btn btn-tertiary" data-act="ollama-refresh">Refresh models</button></div></div>
      ${ollama.loading ? '<div class="ai-status">Looking for models...</div>' : ''}
      ${ollama.error ? `<div class="ai-status bad">${esc(ollama.error)}</div>` : ''}
      ${!ollama.loading && ollama.loaded && !ollama.models.length ? '<div class="ai-warn">Ollama answered, but it has no models yet. Run <code>ollama pull qwen2.5vl:7b</code> in a terminal, then press Refresh models.</div>' : ''}
      <div class="ai-pickers">
        <div class="ai-picker"><div class="t">Vision and chat model</div><select class="field" id="ollamaVision">${modelOptions(s.visionModel)}</select>
          <div class="ai-badges">${aiBadges(s.visionModel)}</div>
          ${capsV && !capsV.includes('vision') ? '<div class="ai-warn">This model does not advertise vision. Screenshots will still be sent; pick a vision model (for example qwen2.5vl or llama3.2-vision) for reliable pointing.</div>' : ''}</div>
        <div class="ai-picker"><div class="t">Agent model (tool calling)</div><select class="field" id="ollamaAgent">${modelOptions(s.agentModel)}</select>
          <div class="ai-badges">${aiBadges(s.agentModel)}</div>
          ${capsA && !capsA.includes('tools') ? '<div class="ai-warn">This model does not advertise tools. Agent jobs need a tools-capable model (for example qwen2.5, llama3.2 or mistral).</div>' : ''}</div>
      </div>
      <div class="ai-note">Ollama's default context window is small. Start it with <code>OLLAMA_CONTEXT_LENGTH=8192</code> (Windows: <code>setx OLLAMA_CONTEXT_LENGTH 8192</code>) so screenshots and control lists fit.</div>
      <div class="ai-note">Ollama has no transcription or speech endpoint. This preset switches voice to local Whisper and Kokoro${localVoice.stt && localVoice.tts ? ' (installed)' : ' (download it below)'}; Windows SAPI remains the final fallback.</div>
      ${!localVoice.stt ? '<div class="ai-warn">Local Whisper is not installed yet, so push-to-talk will have nothing to transcribe with Ollama. Install the local voice below.</div>' : ''}
    </div>`;
  }

  function settingsView() {
    const s = settings;
    return `<div class="page"><h1>Settings</h1><p class="lead">Everything here is stored locally in your user profile.</p>
      ${aiBackendCard(s)}
      ${s.provider === 'local' ? ollamaCard(s) : keyCard(s)}
      ${voiceCard(s)}
      ${hearingCard(s)}
      ${handsFreeCard(s)}
      ${speedAndDisplayCard(s)}
      <div class="card"><h3>Agent</h3>
        <div class="row"><div><div class="t">Allow Sidekick to drive my PC</div><div class="d">Mouse and keyboard control, only after you approve each job.</div></div>${tog('toggle-drive', s.agent.allowDrive)}</div>
        <div class="row"><div><div class="t">Approve each drive job</div><div class="d">Turn off only if you fully trust what you ask for.</div></div>${tog('toggle-approval', s.agent.driveApproval !== 'auto')}</div>
        <div class="row"><div><div class="t">Allow PowerShell commands</div><div class="d">Each command still needs your approval.</div></div>${tog('toggle-ps', s.agent.commandApproval !== 'never')}</div>
        <div class="row"><div><div class="t">Read UI elements for accuracy</div><div class="d">Uses Windows UI Automation to get exact button positions. Names of on-screen controls go to the AI backend.</div></div>${tog('toggle-uia', s.useAccessibilityGrounding)}</div>
        <div class="row"><div><div class="t">Skip the screenshot for simple "where is" questions</div><div class="d">Answers from the control list alone, saving about 2,000 tokens per question. Turn off if pointing ever misses.</div></div>${tog('toggle-skipshot', s.skipScreenshotWhenPossible !== false)}</div>
        <div class="row"><div><div class="t">Pointing coordinate space</div><div class="d">Normalized 0-1000 grid is usually more accurate than pixels.</div></div><div class="segmented"><button data-act="coord-normalized" class="${s.coordinateSpace !== 'pixels' ? 'sel' : ''}">Grid</button><button data-act="coord-pixels" class="${s.coordinateSpace === 'pixels' ? 'sel' : ''}">Pixels</button></div></div></div>
      <div class="card"><h3>Access rules</h3>
        <p class="d" style="margin:0 0 2px">Control which windows the agent may touch. This is enforced in <code style="font-size:11px">safety.js</code> before every desktop action.</p>
        <div class="row"><div><div class="t">Mode</div><div class="d">Blocklist: act everywhere except the blocked windows. Allowlist: act only in your allowed windows.</div></div><div class="segmented"><button data-act="safety-mode-block" class="${s.agent.accessMode !== 'allowlist' ? 'sel' : ''}">Blocklist</button><button data-act="safety-mode-allow" class="${s.agent.accessMode === 'allowlist' ? 'sel' : ''}">Allowlist</button></div></div>
        <div class="ai-picker"><div class="t">Never touch windows containing</div>
          <textarea id="safetyBlocked" class="field" rows="3" spellcheck="false" placeholder="1password, banking&#10;One per line, or comma-separated">${esc(safetyDraft.blocked != null ? safetyDraft.blocked : listText(s.agent.blockedApps || s.safetyDefaults.blockedApps))}</textarea>
          <div class="kv" style="margin-top:7px;justify-content:flex-end"><button class="btn btn-tertiary" data-act="safety-restore-blocked">Restore safe defaults</button><button class="btn btn-secondary" data-act="safety-save-blocked">Save blocked list</button></div></div>
        <div class="ai-picker"><div class="t">Only allow windows containing (allowlist mode)</div>
          <textarea id="safetyAllowed" class="field" rows="2" spellcheck="false" placeholder="code, notepad, chrome">${esc(safetyDraft.allowed !== null ? safetyDraft.allowed : listText(s.agent.allowedApps))}</textarea>
          <div class="kv" style="margin-top:7px;justify-content:flex-end"><button class="btn btn-secondary" data-act="safety-save-allowed">Save allowed list</button></div></div>
        <div class="ai-picker"><div class="t">Extra words that always ask</div>
          <textarea id="safetyAlways" class="field" rows="2" spellcheck="false" placeholder="archive, deploy, rename">${esc(safetyDraft.always != null ? safetyDraft.always : listText(s.agent.alwaysAsk))}</textarea>
          <div class="kv" style="margin-top:7px;justify-content:flex-end"><button class="btn btn-secondary" data-act="safety-save-always">Save extra words</button></div></div>
        <div class="ai-note">Delete, Send, Pay, Install, Sign out, Alt+F4 and closing windows always ask, even in auto-approve. These lists can only add restrictions; they cannot turn that off.</div>
      </div>
      <div class="card"><h3>System</h3>
        <div class="row"><div class="t">Start Sidekick when I sign in</div>${tog('toggle-login', s.launchAtLogin)}</div>
        <div class="row"><div><div class="t">Hide Sidekick from screenshots and screen sharing</div><div class="d">Windows excludes Sidekick windows from capture.</div></div>${tog('toggle-hide', s.hideFromCapture)}</div>
        <div class="row"><div><div class="t">Logs</div><div class="d">Open the folder with sidekick.log to share when something goes wrong.</div></div><button class="btn btn-secondary" data-act="open-logs">Open log folder</button></div>
        <div class="row"><div><div class="t">Reset all settings and data</div><div class="d">Removes your key, memory and routines.</div></div><button class="btn btn-destructive" data-act="reset">Reset</button></div></div>
      <div class="muted" style="font-size:11.5px;margin-top:6px">Sidekick for Windows ${esc(appInfo.version || '')} &middot; Electron ${esc(appInfo.electron || '')}</div></div>`;
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!settings) return;
    renderNav();
    const keepFocus = document.activeElement && document.activeElement.id;
    const keepSel = keepFocus && document.activeElement.selectionStart;
    const views = { chat: chatView, agent: jobsView, routines: routinesView, memory: memoryView, folders: foldersView, activity: activityView, visuals: visualsView, settings: settingsView };
    const oldPage = main.querySelector('.page');
    const scroll = oldPage ? oldPage.scrollTop : 0;
    main.innerHTML = views[section]();
    const page = main.querySelector('.page');
    if (page && section !== 'chat') page.scrollTop = scroll;
    if (section === 'chat') scrollChat();
    if (keepFocus) {
      const el = document.getElementById(keepFocus);
      if (el) { el.focus(); try { el.setSelectionRange(keepSel, keepSel); } catch (_) { /* ignore */ } }
    }
    if (section === 'settings' && settings.provider === 'local' && !ollama.loading && ollama.attemptedRoot !== settings.ollamaRoot) {
      setTimeout(() => refreshOllama(), 0);
    }
  }

  function setSection(id) {
    section = id;
    render();
    if (id === 'folders') loadFolders();
    if (id === 'activity') loadActivity();
  }

  async function setSetting(patch) {
    settings = await api.invoke('settings:set', patch);
    render();
  }

  async function loadOllamaCaps(models) {
    const list = Array.from(new Set((models || []).filter(Boolean)));
    await Promise.all(list.map(async (model) => {
      if (ollama.caps[model]) return;
      try {
        const r = await api.invoke('ai:model', { root: settings.ollamaRoot, model });
        if (r && r.ok) ollama.caps[model] = Array.isArray(r.capabilities) ? r.capabilities : [];
      } catch (_) { /* leave the badge as unchecked */ }
    }));
    if (section === 'settings') render();
  }

  async function refreshOllama(force = false) {
    if (!settings || ollama.loading) return;
    if (!force && ollama.attemptedRoot === settings.ollamaRoot) return;
    ollama.loading = true;
    ollama.error = '';
    ollama.tested = '';
    ollama.root = settings.ollamaRoot;
    ollama.attemptedRoot = settings.ollamaRoot;
    if (section === 'settings') render();
    const r = await api.invoke('ai:models', { root: settings.ollamaRoot });
    ollama.loading = false;
    ollama.loaded = true;
    if (r && r.ok) {
      ollama.root = r.root || settings.ollamaRoot;
      ollama.models = Array.isArray(r.models) ? r.models : [];
      ollama.error = '';
    } else {
      ollama.models = [];
      ollama.error = (r && r.error) || 'Could not reach Ollama.';
    }
    if (section === 'settings') render();
    await loadOllamaCaps([settings.visionModel, settings.agentModel]);
  }

  async function switchToLocal() {
    const root = (val('ollamaRoot') || settings.ollamaRoot || '').trim();
    settings = await api.invoke('settings:set', { provider: 'local', ollamaRoot: root });
    ollama.loaded = false;
    ollama.attemptedRoot = '';
    ollama.caps = {};
    ollama.tested = '';
    render();
    refreshOllama(true);
  }

  async function saveOllamaRoot() {
    const root = (val('ollamaRoot') || settings.ollamaRoot || '').trim();
    settings = await api.invoke('settings:set', { provider: 'local', ollamaRoot: root });
    ollama.models = [];
    ollama.loaded = false;
    ollama.attemptedRoot = '';
    ollama.caps = {};
    ollama.error = '';
    ollama.tested = '';
    render();
    refreshOllama(true);
  }

  async function testOllama() {
    ollama.tested = 'Testing...';
    render();
    const root = (val('ollamaRoot') || settings.ollamaRoot || '').trim();
    const r = await api.invoke('ai:test', { root });
    ollama.tested = r && r.ok ? `ok:Connected. ${r.count} model${r.count === 1 ? '' : 's'} on /v1/models.` : 'err:' + ((r && r.error) || 'Connection failed.');
    render();
  }

  async function sendChat() {
    const text = draft.trim();
    if (!text) return;
    draft = '';
    render();
    await api.invoke('chat:send', { text });
  }

  const val = (id) => (document.getElementById(id) || {}).value || '';

  const actions = {
    send: sendChat,
    'stop-job': (el) => api.invoke('job:stop', { id: el.dataset.id }),
    'run-bg': () => { const t = val('jobtask').trim(); if (t) api.invoke('job:run', { task: t, desktop: false }); },
    'run-drive': () => { const t = val('jobtask').trim(); if (t) api.invoke('job:run', { task: t, desktop: true }); },
    'toggle-routine': (el) => api.invoke('routine:toggle', { id: el.dataset.id }),
    'del-routine': (el) => api.invoke('routine:delete', { id: el.dataset.id }),
    'add-routine': () => {
      const task = val('rtask').trim();
      const time = val('rtime') || routineDraft.time;
      if (!task || !routineDraft.days.length) return;
      api.invoke('routine:add', { task, time, days: routineDraft.days.map((d) => DAY_KEYS[d]) });
      routineDraft.task = '';
    },
    'folder-add': async () => {
      const r = await api.invoke('folders:pick');
      if (!r || !r.ok) return;
      if (foldersState.folders.some((x) => samePath(x.path, r.path))) { foldersState.msg = 'That folder is already in the list.'; foldersState.msgKind = 'info'; return render(); }
      return saveFolders(folderList().concat([{ path: r.path, write: false }]), 'Added. Sidekick can look at it, but not change it, until you switch it to "Read and change".');
    },
    'drive-add': (el) => saveFolders(folderList().concat([{ path: el.dataset.root, write: false }]), 'Drive added as read only.'),
    'folder-ro': (el) => { const l = folderList(); l[Number(el.dataset.i)].write = false; return saveFolders(l, 'Now read only.'); },
    'folder-rw': (el) => {
      const i = Number(el.dataset.i);
      const l = folderList();
      if (!l[i].write && !window.confirm('Let Sidekick move and save files in ' + l[i].path + '? Deleting stays blocked and big changes still ask first.')) return undefined;
      l[i].write = true;
      return saveFolders(l, 'Sidekick can now change files in that folder.');
    },
    'folder-remove': (el) => { const l = folderList(); l.splice(Number(el.dataset.i), 1); return saveFolders(l, 'Removed.'); },
    'folder-reset': async () => {
      const r = await api.invoke('folders:set', { folders: null });
      if (r && r.ok) Object.assign(foldersState, { isDefault: r.isDefault, folders: r.folders || [], drives: r.drives || [], msg: 'Back to the default: your user folder only.', msgKind: 'ok' });
      render();
    },
    'act-filter': (el) => { activityState.filter = el.dataset.f; loadActivity(); },
    'act-open': () => api.invoke('activity:open'),
    'act-clear': async () => { if (window.confirm('Clear the activity log?')) { await api.invoke('activity:clear'); loadActivity(); } },
    'del-mem': (el) => api.invoke('memory:delete', { index: Number(el.dataset.i) }),
    'add-mem': () => { const t = val('memnew').trim(); if (t) setSetting({ memory: settings.memory.concat([t]).slice(-40) }); },
    'make-model': () => { const t = val('modeltopic').trim(); if (t) api.invoke('chat:send', { text: `show me a 3D model of ${t}` }); },
    'save-key': async () => {
      const key = val('keyin').trim();
      if (!key) return;
      keyMsg = '';
      keyDraft = key;
      render();
      const r = await api.invoke('settings:setApiKey', { key });
      keyMsg = r && r.ok ? 'ok:Key verified and saved.' : 'err:' + ((r && r.error) || 'That key did not work.');
      if (r && r.ok) keyDraft = '';
      render();
    },
    'clear-key': async () => { await api.invoke('settings:setApiKey', { key: '' }); keyMsg = 'ok:Key removed.'; render(); },
    'get-key': (el) => api.invoke('panel:open', { action: 'keypage' }),
    'mode-fast': () => setSetting({ modelMode: 'fast' }),
    'mode-deep': () => setSetting({ modelMode: 'deep' }),
    'ai-deepseek': async () => { settings = await api.invoke('settings:set', { provider: 'deepseek', groqBaseUrl: 'https://api.deepseek.com' }); await loadCatalog(); render(); },
    'ai-groq': async () => { settings = await api.invoke('settings:set', { provider: 'groq', groqBaseUrl: 'https://api.groq.com/openai/v1' }); await loadCatalog(); render(); },
    'ai-local': switchToLocal,
    'ollama-save-root': saveOllamaRoot,
    'ollama-test': testOllama,
    'ollama-refresh': () => { ollama.attemptedRoot = ''; ollama.loaded = false; ollama.error = ''; ollama.tested = ''; refreshOllama(true); },
    'tts-edge': () => setSetting({ ttsProvider: 'edge' }),
    'tts-groq': () => setSetting({ ttsProvider: 'groq' }),
    'tts-windows': () => setSetting({ ttsProvider: 'windows' }),
    'tts-local': () => setSetting({ ttsProvider: 'local' }),
    'preview-edge': async (el) => {
      el.disabled = true;
      voiceMsg = 'Playing...';
      render();
      const voice = val('edgeVoice') || (settings && settings.edgeVoice);
      const r = await api.invoke('voice:preview', { engine: 'edge', voice });
      el.disabled = false;
      voiceMsg = r && r.ok ? '' : ((r && r.error) || 'Could not play that.');
      render();
    },
    'preview-kokoro': async (el) => {
      el.disabled = true;
      voiceMsg = 'Playing...';
      render();
      const speaker = Number(val('kokoroSpeaker') || (settings && settings.kokoroSpeaker));
      const r = await api.invoke('voice:preview', { engine: 'local', speaker });
      el.disabled = false;
      voiceMsg = r && r.ok ? '' : ((r && r.error) || 'Could not play that.');
      render();
    },
    'stt-groq': () => setSetting({ sttProvider: 'groq' }),
    'stt-local': () => setSetting({ sttProvider: 'local' }),
    'lv-install': () => api.invoke('localvoice:install'),
    'lv-remove': () => { if (window.confirm('Remove the downloaded local voice files?')) api.invoke('localvoice:remove'); },
    'lv-test': async () => { const r = await api.invoke('localvoice:test'); if (r && r.ok === false) { localVoice.progress = Object.assign({}, localVoice.progress, { error: r.error || 'Test failed.' }); render(); } },
    'open-logs': () => api.invoke('logs:open'),
    'test-voice': () => api.invoke('voice:test'),
    'toggle-captions': () => setSetting({ captions: !settings.captions }),
    'toggle-wake': () => setSetting({ wakeWordEnabled: !settings.wakeWordEnabled }),
    'save-wake': () => { const v = val('wakePhrase').trim(); if (v) setSetting({ wakePhrase: v.slice(0, 40) }); },
    'toggle-follow': () => {
      const cur = Number(settings && settings.conversationWindowSec) || 0;
      setSetting({ conversationWindowSec: cur > 0 ? 0 : 10 });
    },
    'toggle-quick': () => setSetting({ quickCommands: settings.quickCommands === false }),
    'toggle-eyes': () => setSetting({ eyesEnabled: settings.eyesEnabled === false }),
    'toggle-drive': () => setSetting({ agent: { allowDrive: !settings.agent.allowDrive } }),
    'toggle-approval': () => setSetting({ agent: { driveApproval: settings.agent.driveApproval === 'auto' ? 'ask' : 'auto' } }),
    'toggle-ps': () => setSetting({ agent: { commandApproval: settings.agent.commandApproval === 'never' ? 'ask' : 'never' } }),
    'safety-mode-block': () => setSetting({ agent: { accessMode: 'blocklist' } }),
    'safety-mode-allow': () => setSetting({ agent: { accessMode: 'allowlist' } }),
    'safety-save-blocked': async () => { await setSetting({ agent: { blockedApps: parseList(safetyDraft.blocked != null ? safetyDraft.blocked : listText(settings.agent.blockedApps)) } }); safetyDraft.blocked = null; render(); },
    'safety-restore-blocked': async () => { await setSetting({ agent: { blockedApps: (settings.safetyDefaults && settings.safetyDefaults.blockedApps) || [] } }); safetyDraft.blocked = null; render(); },
    'safety-save-allowed': async () => { await setSetting({ agent: { allowedApps: parseList(safetyDraft.allowed != null ? safetyDraft.allowed : listText(settings.agent.allowedApps)) } }); safetyDraft.allowed = null; render(); },
    'safety-save-always': async () => { await setSetting({ agent: { alwaysAsk: parseList(safetyDraft.always != null ? safetyDraft.always : listText(settings.agent.alwaysAsk)) } }); safetyDraft.always = null; render(); },
    'toggle-skipshot': () => setSetting({ skipScreenshotWhenPossible: settings.skipScreenshotWhenPossible === false }),
    'toggle-uia': () => setSetting({ useAccessibilityGrounding: !settings.useAccessibilityGrounding }),
    'coord-normalized': () => setSetting({ coordinateSpace: 'normalized' }),
    'coord-pixels': () => setSetting({ coordinateSpace: 'pixels' }),
    'toggle-login': () => setSetting({ launchAtLogin: !settings.launchAtLogin }),
    'toggle-hide': () => setSetting({ hideFromCapture: !settings.hideFromCapture }),
    reset: async () => { if (window.confirm('Remove your saved key, memory, routines and all settings?')) await api.invoke('settings:resetAll'); },
  };

  document.addEventListener('click', (e) => {
    const win = e.target.closest('[data-win]');
    if (win) return api.invoke('window:control', { action: win.dataset.win });
    const secBtn = e.target.closest('[data-sec]');
    if (secBtn) return setSection(secBtn.dataset.sec);
    const chip = e.target.closest('[data-chip]');
    if (chip) { api.invoke('chat:send', { text: chip.dataset.chip }); return undefined; }
    const tile = e.target.closest('[data-model]');
    if (tile) return api.invoke('chat:send', { text: 'show me a 3D model of ' + tile.dataset.model });
    const day = e.target.closest('[data-day]');
    if (day) {
      const d = Number(day.dataset.day);
      routineDraft.days = routineDraft.days.includes(d) ? routineDraft.days.filter((x) => x !== d) : routineDraft.days.concat([d]);
      return render();
    }
    const el = e.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
    return undefined;
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'draft') {
      draft = e.target.value;
      e.target.style.height = '44px';
      e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
    }
    if (e.target.id === 'keyin') keyDraft = e.target.value;
    if (e.target.id === 'safetyBlocked') safetyDraft.blocked = e.target.value;
    if (e.target.id === 'safetyAllowed') safetyDraft.allowed = e.target.value;
    if (e.target.id === 'safetyAlways') safetyDraft.always = e.target.value;
    if (e.target.id === 'rtask') routineDraft.task = e.target.value;
    if (e.target.id === 'rtime') routineDraft.time = e.target.value;
    if (e.target.id === 'followSec') {
      const lbl = document.getElementById('followLabel');
      if (lbl) lbl.textContent = e.target.value + ' s';
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'edgeVoice') setSetting({ edgeVoice: e.target.value });
    if (e.target.id === 'kokoroSpeaker') setSetting({ kokoroSpeaker: Number(e.target.value) });
    if (e.target.id === 'whisperModel') setSetting({ whisperModel: e.target.value });
    if (e.target.id === 'eyesCorner') setSetting({ eyesCorner: e.target.value });
    if (e.target.id === 'followSec') setSetting({ conversationWindowSec: Number(e.target.value) });
    if (e.target.id === 'ttsVoice') setSetting({ ttsVoice: e.target.value });
    if (e.target.id === 'shortcut') setSetting({ pushToTalkShortcut: e.target.value });
    if (e.target.id === 'visionModel' && e.target.value.trim()) setSetting({ visionModel: e.target.value.trim(), agentModel: e.target.value.trim() });
    if (e.target.id === 'ollamaVision' && e.target.value) {
      const model = e.target.value;
      setSetting({ visionModel: model }).then(() => loadOllamaCaps([model]));
    }
    if (e.target.id === 'ollamaAgent' && e.target.value) {
      const model = e.target.value;
      setSetting({ agentModel: model }).then(() => loadOllamaCaps([model]));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'draft' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    if (e.key === 'Enter' && e.target.id === 'keyin') actions['save-key']();
  });

  // Never rebuild the DOM under the user's caret (settings/status pushes would otherwise
  // reset focus and break typing in the key, routine and chat inputs).
  let homeRenderPending = false;
  function isTypingInHomeField() {
    const el = document.activeElement;
    return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'));
  }
  function renderUnlessTyping() {
    if (isTypingInHomeField()) { homeRenderPending = true; return; }
    homeRenderPending = false;
    render();
  }
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (homeRenderPending && !isTypingInHomeField()) renderUnlessTyping(); }, 0);
  });

  api.on('localvoice', (st) => { localVoice = st; loadCatalog().then(() => { if (section === 'settings') renderUnlessTyping(); }); });
  api.on('settings', (s) => { settings = s; loadCatalog().then(() => renderUnlessTyping()); });
  api.on('status', (s) => { status = s; (s.jobs || []).forEach((j) => jobs.set(j.id, j)); if (section === 'chat') renderNav(); else renderUnlessTyping(); });
  api.on('job-update', (j) => { jobs.set(j.id, j); renderNav(); if (section === 'agent') renderUnlessTyping(); });
  api.on('chat-msg', (m) => { chat.push(m); if (chat.length > 200) chat.shift(); if (section === 'chat') render(); });
  api.on('activity:new', (e) => {
    if (!activityState.loaded) return;
    const f = activityState.filter;
    const kindChange = ['change', 'command', 'control', 'setting'].includes(e.kind);
    const fits = f === 'all' || (f === 'blocked' && e.blocked) || (f === 'changes' && kindChange) || (f === 'reads' && ['read', 'web'].includes(e.kind));
    if (!fits) return;
    activityState.items.unshift(e);
    if (activityState.items.length > 200) activityState.items.pop();
    if (section === 'activity') renderUnlessTyping();
  });
  api.on('home:section', (id) => { if (SECTIONS.some((s) => s.id === id)) setSection(id); });
  api.on('notify', (n) => {
    const t = document.createElement('div');
    t.className = 'toast ' + (n.kind === 'error' ? 'error' : '');
    t.textContent = n.message;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  });

  Promise.all([api.invoke('settings:get'), api.invoke('status:get'), api.invoke('chat:history'), api.invoke('app:info'), api.invoke('job:list'), api.invoke('localvoice:status'), loadCatalog()]).then(([st, s, h, info, js, lv]) => {
    if (lv) localVoice = lv;
    settings = st; status = s; chat = h || []; appInfo = info || {};
    (js || []).forEach((j) => jobs.set(j.id, j));
    render();
  });
})();
