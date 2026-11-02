'use strict';
/* Runs inside Electron's main process (see run-e2e.js). Drives the app and screenshots every window. */
const fs = require('fs');
const path = require('path');

module.exports = async function scenario(ctx) {
  const out = process.env.SIDEKICK_E2E_OUT;
  const { wm, companion, settings, app } = ctx;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, extra) => {
    results.push({ name, ok: !!ok, extra });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' - ' + extra : ''));
  };
  async function shot(win, name) {
    if (!win || win.isDestroyed()) return check('screenshot ' + name, false, 'window missing');
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    const size = img.getSize();
    return check('screenshot ' + name, size.width > 50, size.width + 'x' + size.height);
  }
  const js = (win, code) => win.webContents.executeJavaScript(code);

  await sleep(1200);

  // ---- tray panel
  settings.set({ hasSubmittedEmail: true });
  companion.refreshPermissions({ microphone: true, screen: true, input: true, groqKey: settings.hasApiKey() });
  wm.showPanel();
  await sleep(1500);
  await shot(wm.panel, '01-panel-onboarding-ready');
  check('panel shows Start button', await js(wm.panel, "!!document.querySelector('[data-act=start]')"));

  // ---- panel after onboarding
  settings.set({ hasCompletedOnboarding: true });
  await sleep(700);
  await shot(wm.panel, '02-panel-ready');
  check('panel shows model picker', await js(wm.panel, "!!document.querySelector('[data-act=mode-fast]')"));

  // ---- overlay + response with pointing, drawing, card
  wm.hidePanel();
  settings.set({ cursorEnabled: true });
  wm.showOverlay({ firstAppearance: false });
  await sleep(2000);
  check('overlay window created', wm.overlays.size >= 1, 'count ' + wm.overlays.size);

  ctx.settings.set({ ttsProvider: 'groq' });
  const p = companion.sendText('how do i save this file');
  await sleep(1800);
  const overlay = Array.from(wm.overlays.values())[0].win;
  await shot(overlay, '03-overlay-processing');
  await p;
  await sleep(2600);
  await shot(overlay, '04-overlay-pointing');
  await sleep(2500);
  await shot(overlay, '05-overlay-after');
  check('conversation history stored', companion.history.length >= 1, 'len ' + companion.history.length);

  // ---- EXPLAIN card + DRAW:note sticky notes (real overlay DOM, through the real IPC path)
  await js(overlay, "window.__noop = 1");
  const blocked = await js(overlay, "(() => { try { window.sidekick.on('not:a:channel', () => {}); return false; } catch (e) { return /blocked/.test(e.message); } })()");
  check('preload blocks unknown channels', blocked);
  const hasExplainApi = await js(overlay, "typeof window.sidekick.on === 'function'");
  check('preload exposes sidekick.on to the overlay', hasExplainApi);
  await companion.sendText('explain how a cell works');
  let card = false;
  for (let i = 0; i < 24 && !card; i++) { await sleep(250); card = await js(overlay, "!!document.getElementById('explain-card')"); }
  check('overlay:explain reached the overlay (card in DOM)', card);
  await sleep(4500);
  await shot(overlay, '05b-overlay-explain');
  const rows = await js(overlay, "(() => { const c = document.getElementById('explain-card'); return c ? { title: c.querySelector('.ex-title').textContent, flow: c.querySelectorAll('.ex-row.flow .ex-box').length, steps: c.querySelectorAll('.ex-row.step').length, notes: c.querySelectorAll('.ex-row.note').length, arrows: c.querySelectorAll('.sketch-arrow').length } : null; })()");
  check('explain card has title, 3 flow boxes, 2 steps, 1 note', rows && rows.title === 'How a cell works' && rows.flow === 3 && rows.steps === 2 && rows.notes === 1, JSON.stringify(rows));
  const notes = await js(overlay, "Array.from(document.querySelectorAll('.sticky span')).map((n) => n.textContent)");
  check('two [DRAW:note] stickies rendered with their text', notes.length === 2 && notes[0] === 'Nucleus holds the DNA' && notes[1] === 'Vacuole stores water', JSON.stringify(notes));
  const overlap = await js(overlay, "(() => { const c = document.getElementById('explain-card').getBoundingClientRect(); return Array.from(document.querySelectorAll('.sticky')).filter((n) => { const r = n.getBoundingClientRect(); return r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom; }).length; })()");
  check('no sticky note overlaps the explain card', overlap === 0, 'overlapping: ' + overlap);
  const pins = await js(overlay, "document.querySelectorAll('.sticky .pin').length");
  check('stickies have a pin on the exact point', pins === 2);
  wm.broadcast('overlay:clear', {}, { others: false });
  await sleep(500);

  // ---- home window
  wm.openHome();
  await sleep(2000);
  await shot(wm.home, '06-home-chat');
  for (const sec of ['agent', 'routines', 'memory', 'visuals', 'settings']) {
    wm.send(wm.home, 'home:section', sec);
    await sleep(500);
    await shot(wm.home, '07-home-' + sec);
  }
  const rulesUi = await js(wm.home, "(() => { const b = document.getElementById('safetyBlocked'); const a = document.getElementById('safetyAllowed'); const w = document.getElementById('safetyAlways'); return { blocked: !!b, allowed: !!a, always: !!w, modeButtons: document.querySelectorAll('[data-act^=safety-mode-]').length, blockedText: b ? b.value : '' }; })()");
  check('Home -> Agent exposes safety.js access rules', rulesUi.blocked && rulesUi.allowed && rulesUi.always && rulesUi.modeButtons === 2 && /1password/i.test(rulesUi.blockedText), JSON.stringify({ ...rulesUi, blockedText: rulesUi.blockedText.slice(0, 40) }));
  await js(wm.home, "document.getElementById('safetyBlocked').scrollIntoView({ block: 'center' })");
  await sleep(350);
  await shot(wm.home, '07b-home-access-rules');
  check('home chat has messages', ctx.chat.length >= 1, 'chat ' + ctx.chat.length);

  // ---- notch with approval prompt
  const jobs = [{ id: 'j1', name: 'Open Notepad and write a list', task: 'x', mode: 'drive', status: 'waiting', note: 'Waiting for you', log: [], plan: ['Find Notepad', 'Open a new note', 'Write the list'], planDone: 1, startedAt: Date.now() },
    { id: 'j2', name: 'Summarize today\'s tech news', task: 'y', mode: 'background', status: 'running', note: 'searching the web', log: [], startedAt: Date.now() }];
  wm.notchPrompts = [{ jobId: 'j1', kind: 'approve-desktop', text: 'Let Sidekick take over your mouse and keyboard to: open Notepad and write a list? Press Esc or move the mouse any time to stop.', name: jobs[0].name }];
  wm.ensureNotch();
  await sleep(1200);
  wm.send(wm.notch, 'notch:state', { jobs, prompts: wm.notchPrompts });
  await sleep(1200);
  const planUi = await js(wm.notch, "(() => ({ rows: document.querySelectorAll('.pstep').length, done: document.querySelectorAll('.pstep.done').length, now: document.querySelector('.pstep.now .ptxt')?.textContent || '' }))()");
  check('notch HUD shows the live multi-step plan', planUi.rows === 3 && planUi.done === 1 && planUi.now === 'Open a new note', JSON.stringify(planUi));
  await shot(wm.notch, '08-notch');
  wm.send(wm.notch, 'notch:state', { jobs: [], prompts: [] });
  await sleep(300);

  // ---- drive banner on overlay
  wm.broadcast('drive-state', { active: true, name: 'Open Notepad' }, { others: false });
  await sleep(900);
  await shot(overlay, '09-overlay-driving');
  wm.broadcast('drive-state', { active: false }, { others: false });

  // ---- 3D
  await ctx.showModel3D('a plant cell');
  let built = false;
  for (let i = 0; i < 30 && !built; i++) {
    await sleep(500);
    built = await js(wm.model3d, "document.getElementById('loading').classList.contains('hide')");
  }
  await sleep(2500);
  await shot(wm.model3d, '10-model3d');
  const title = await js(wm.model3d, "document.getElementById('title').textContent");
  check('3D model built and loading overlay hidden', built && /Plant cell/i.test(title), title);

  // Dark-glass fact notes, one per part, clickable and wired to the same selection as the mesh.
  const factCount = await js(wm.model3d, "document.querySelectorAll('.fact-card').length");
  const factText = await js(wm.model3d, "document.querySelector('.fact-card .ffact').textContent");
  await js(wm.model3d, "document.querySelector('.fact-card').click()");
  await sleep(250);
  const factSel = await js(wm.model3d, "(() => { const c = document.querySelector('.fact-card.sel'); const b = document.querySelector('#info b'); return { selected: !!c, name: b ? b.textContent : '', fact: c ? c.querySelector('.ffact').textContent : '' }; })()");
  check('3D viewer has one clickable fact card per part', factCount === 5 && /rigid outer layer/i.test(factText), `count ${factCount}, fact ${JSON.stringify(factText)}`);
  check('Clicking a 3D fact card selects that part', factSel.selected && /Cell wall/i.test(factSel.name) && /rigid outer layer/i.test(factSel.fact), JSON.stringify(factSel));
  await shot(wm.model3d, '10b-model3d-facts');

  // ---- onboarding overlay (welcome bubble)
  wm.hideOverlay();
  settings.set({ playOnboardingMusic: false });
  ctx.startOnboarding(false);
  await sleep(4500);
  const ov2 = Array.from(wm.overlays.values())[0].win;
  const introVisible = await js(ov2, "(() => { const c = document.getElementById('intro-card'); return !!c && c.classList.contains('show') && !c.classList.contains('hidden') && c.querySelectorAll('.intro-step').length === 3; })()");
  check('first-run introduction card replaces the deleted video', introVisible);
  await shot(ov2, '11-overlay-welcome');

  // ---- Ollama preset: model pickers + capability badges from the mock /api/tags and /api/show.
  // This is mock-verified only: a real Ollama server is not available in this test environment.
  const mockRoot = process.env.SIDEKICK_GROQ_BASE_URL;
  settings.set({
    provider: 'local', ollamaRoot: mockRoot, groqBaseUrl: mockRoot + '/v1',
    visionModel: 'qwen2.5vl:7b', agentModel: 'llama3.2:3b',
    sttProvider: 'local', ttsProvider: 'windows',
  });
  wm.openHome();
  wm.send(wm.home, 'home:section', 'settings');
  let ollamaReady = false;
  for (let i = 0; i < 24 && !ollamaReady; i++) {
    await sleep(300);
    ollamaReady = await js(wm.home, "(() => { const s = document.getElementById('ollamaVision'); return !!s && s.options.length >= 2 && !!document.querySelector('.ai-badge.vision'); })()");
  }
  const ollamaUi = await js(wm.home, "(() => ({ options: Array.from(document.querySelectorAll('#ollamaVision option')).map(o => o.value), badges: Array.from(document.querySelectorAll('.ai-badge')).map(b => b.textContent) }))()");
  check('Ollama preset lists models from /api/tags', ollamaReady && ollamaUi.options.includes('qwen2.5vl:7b') && ollamaUi.options.includes('llama3.2:3b'), JSON.stringify(ollamaUi.options));
  check('Ollama capability badges come from /api/show', ollamaUi.badges.includes('vision') && ollamaUi.badges.includes('tools'), JSON.stringify(ollamaUi.badges));
  await js(wm.home, "document.querySelector('[data-act=ollama-test]').click()");
  let ollamaTested = false;
  for (let i = 0; i < 20 && !ollamaTested; i++) {
    await sleep(250);
    ollamaTested = await js(wm.home, "!!document.querySelector('.ai-status.good')");
  }
  check('Ollama connection test hits /v1/models', ollamaTested);
  await js(wm.home, "(() => { const p = document.querySelector('.page'); if (p) p.scrollTop = 0; })()");
  await sleep(500);
  await shot(wm.home, '12-home-ollama');
  settings.set({ provider: 'groq', groqBaseUrl: mockRoot + '/v1' });

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`E2E done: ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 2 : 0);
};
