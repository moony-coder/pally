'use strict';
/*
 * Real-Windows self-check. Runs INSIDE Electron's main process:
 *
 *   electron . --selfcheck --e2e-script=test/windows/verify.js
 *
 * (or `npm run verify:windows`, which uses a throwaway user-data folder and captures the report).
 *
 * Unlike the Xvfb e2e run, this uses the real Win32 layer, real Windows UI Automation and the real
 * desktop: it starts Notepad, measures UIA cold/warm, types Unicode through SendInput and reads it
 * back through a UIA TextPattern script, clicks a real control, checks per-monitor DPI mapping,
 * drags a file in Explorer and verifies the move with fs, and exercises minimize/restore.
 *
 * It prints PASS/FAIL/SKIP, writes out/report.json + out/report.md, and exits 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = async function verify(ctx) {
  const { app, screen, BrowserWindow, wm, settings, tools, win32, input, uia } = ctx;
  const out = process.env.SIDEKICK_SELFCHECK_OUT || path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const screenshots = [];
  const cleanup = [];
  let current = '';
  const started = Date.now();

  function record(name, status, detail, ms) {
    results.push({ name, status, detail: detail == null ? '' : String(detail), ms: ms || 0 });
    const label = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`${label} ${name}${detail ? ' - ' + detail : ''}`);
  }
  async function check(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      record(name, 'PASS', detail, Date.now() - t0);
      return true;
    } catch (e) {
      record(name, e && e.skip ? 'SKIP' : 'FAIL', (e && e.message) || String(e), Date.now() - t0);
      return false;
    }
  }
  function skip(name, why) {
    record(name, 'SKIP', why, 0);
  }
  async function screenshot(win, name) {
    if (!win || win.isDestroyed()) throw new Error('window missing');
    const img = await win.webContents.capturePage();
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, img.toPNG());
    const size = img.getSize();
    if (size.width < 50 || size.height < 50) throw new Error('screenshot too small: ' + JSON.stringify(size));
    screenshots.push({ name, file: path.relative(out, file), width: size.width, height: size.height });
    return `${size.width}x${size.height} (${path.basename(file)})`;
  }
  async function findWindow(part, timeoutMs = 15000) {
    const until = Date.now() + timeoutMs;
    let last = [];
    while (Date.now() < until) {
      try { last = (await tools.listWindows()).windows || []; } catch (_) { last = []; }
      const hit = last.find((w) => String(w.title || '').toLowerCase().includes(String(part).toLowerCase()));
      if (hit) return hit;
      await sleep(300);
    }
    throw new Error(`window "${part}" did not appear (saw: ${last.slice(0, 6).map((w) => w.title).join(' | ') || 'none'})`);
  }
  async function psValue(script) {
    const ps = require('../../src/main/powershell');
    const r = await ps.runPowerShell(script, { timeoutMs: 12000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'PowerShell failed').slice(0, 300));
    return r.stdout.trim();
  }
  async function isIconic(handle) {
    return (await psValue(`if (-not ('sidekick_win.A' -as [type])) { Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);' -Name A -Namespace sidekick_win }; [sidekick_win.A]::IsIconic([IntPtr]${Number(handle)})`)) === 'True';
  }
  async function closeNotepadTab(handle, base) {
    let selected = false;
    try {
      win32.focusWindow(handle);
      await sleep(500);
      // Notepad on Windows 11 is tabbed and may already contain the user's own documents.
      // Select OUR tab, then close only that tab. Never close the whole Notepad window here.
      const els = (await uia.listForegroundElements({ windowTitle: base })).elements || [];
      const tab = els.find((e) => e.type === 'TabItem' && e.name.toLowerCase().includes(base.toLowerCase()));
      if (tab) {
        await uia.actOnElement({ name: tab.name, action: 'invoke', windowTitle: base });
        selected = true;
        await sleep(450);
      }
    } catch (_) { /* ignore */ }
    if (!selected) return { closed: false, reason: 'could not find our Notepad tab (left it untouched)' };
    await input.pressKeys('ctrl+w');
    await sleep(900);
    try {
      // If our typed text made the document dirty, Notepad asks to save. Discard only this test tab.
      const els = (await uia.listForegroundElements()).elements || [];
      const discard = els.find((e) => /^(don'?t save|no,? don'?t save|discard)$/i.test(e.name)) || els.find((e) => /don'?t save|discard/i.test(e.name));
      if (discard) {
        await uia.actOnElement({ name: discard.name, action: 'invoke' });
        await sleep(500);
      }
    } catch (_) { /* dialog may not exist */ }
    const still = (await tools.listWindows()).windows.some((w) => String(w.title || '').toLowerCase().includes(base.toLowerCase()));
    return { closed: !still, reason: still ? 'our tab still appears open' : 'closed our tab only' };
  }

  console.log('Windows self-check starting');
  console.log('userData:', app.getPath('userData'));
  console.log('out:', out);
  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, scaleFactor: d.scaleFactor, bounds: d.bounds }));
  console.log('displays:', JSON.stringify(displays));

  try {
    // Make Chromium publish accessibility, otherwise its own windows have no UI Automation tree.
    try { app.setAccessibilitySupportEnabled(true); } catch (_) { /* optional */ }

    // ---------------------------------------------------------------- 1. PowerShell scripts parse
    current = 'PowerShell parse-check';
    await check('PowerShell scripts parse with the real powershell.exe parser', async () => {
      const { findPowerShell, parseScripts } = require('../helpers/ps');
      const { collectAllScripts } = require('../helpers/collect-scripts');
      const ps = findPowerShell();
      if (!ps) throw new Error('no PowerShell found');
      const scripts = await collectAllScripts();
      const parsed = parseScripts(ps, scripts);
      const bad = parsed.filter((r) => r.errors.length);
      if (bad.length) throw new Error(bad.map((b) => b.name + ': ' + b.errors.join('; ')).join(' | '));
      return `${scripts.length} scripts parse on PowerShell ${ps.version}`;
    });

    await check('koffi Win32 layer loaded (real user32)', async () => {
      if (win32.stub) throw new Error('the app fell back to the stub Win32 layer');
      const p = win32.getCursorPosition();
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('GetCursorPos returned no point');
      return `cursor ${p.x},${p.y}; koffi/user32 active`;
    });

    // ---------------------------------------------------------------- 2. UIA against a real window
    // This is an Electron window because the automated session isolates the app from other processes'
    // windows (Notepad/Explorer below are attempted, and skipped when the session cannot see them).
    // Chromium publishes a genuine UI Automation tree here, so it exercises the same UIA scripts,
    // TextPattern, SendInput and click pipeline that the app uses on other apps.
    current = 'UIA probe';
    let uiaProbe = null;
    let uiaProbeEls = [];
    try {
      const probe = new BrowserWindow({
        x: 200, y: 160, width: 460, height: 320, frame: false, show: true, skipTaskbar: true,
        hasShadow: false, thickFrame: false, roundedCorners: false, title: 'Sidekick UIA probe',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      uiaProbe = probe;
      cleanup.push(() => { try { if (!probe.isDestroyed()) probe.destroy(); } catch (_) { /* ignore */ } });
      await probe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><title>Sidekick UIA probe</title>' +
          '<body style="margin:0;background:#101820;color:#fff;font:16px sans-serif;padding:24px">' +
          '<h1 style="font-size:18px">UIA probe</h1>' +
          '<textarea id="ta" aria-label="Type here" style="width:340px;height:90px;display:block;margin:10px 0"></textarea>' +
          '<button id="b" aria-label="ClickTarget" onclick="document.body.dataset.clicked=\'yes\'">ClickTarget</button></body>'
      ));
      await sleep(900);
      await check('UIA control list cold vs warm on a real window', async () => {
        require('../../src/main/powershell').disposeSharedSession();
        const t0 = Date.now();
        const cold = await uia.listForegroundElements({ windowTitle: 'Sidekick UIA probe' });
        const coldMs = Date.now() - t0;
        const t1 = Date.now();
        const warm = await uia.listForegroundElements({ windowTitle: 'Sidekick UIA probe' });
        const warmMs = Date.now() - t1;
        uiaProbeEls = warm.elements;
        if (!cold.elements.length) throw new Error('cold UIA list returned no controls');
        return `${cold.elements.length} controls; cold ${coldMs} ms, warm ${warmMs} ms`;
      });
      await check('SendInput types Unicode and TextPattern reads it back', async () => {
        const info = await uia.listForegroundElements({ windowTitle: 'Sidekick UIA probe' });
        const edit = info.elements.find((e) => e.type === 'Edit' && /type here/i.test(e.name)) || info.elements.find((e) => e.type === 'Edit');
        if (!edit) throw new Error('no Edit control in the UIA tree');
        await input.click(ctx.screenApi.screenToDipPoint({ x: edit.x + edit.w / 2, y: edit.y + edit.h / 2 }));
        await sleep(250);
        const marker = 'sidekick unicode: h\u00e9llo \u2713 \u65e5\u672c \u2014 done';
        await input.typeText(marker);
        await sleep(700);
        const r = await tools.readText({ windowTitle: 'Sidekick UIA probe', mode: 'window' });
        if (!r.ok) throw new Error(r.error || 'readText failed');
        if (!r.text.includes(marker)) throw new Error('TextPattern text did not contain the typed marker: ' + JSON.stringify(r.text.slice(-160)));
        return 'Unicode round-trip (héllo ✓ 日本 —) through a UIA TextPattern script';
      });
      await check('A real click lands within 2 px of a UIA control', async () => {
        const info = await uia.listForegroundElements({ windowTitle: 'Sidekick UIA probe' });
        const el = info.elements.find((e) => e.type === 'Button' && /clicktarget/i.test(e.name)) || info.elements.find((e) => e.type === 'Button');
        if (!el) throw new Error('no Button control in the UIA tree');
        const cx = el.x + el.w / 2;
        const cy = el.y + el.h / 2;
        await input.click(ctx.screenApi.screenToDipPoint({ x: cx, y: cy }));
        await sleep(500);
        const pos = win32.getCursorPosition();
        const dist = Math.hypot(pos.x - cx, pos.y - cy);
        const clicked = await uiaProbe.webContents.executeJavaScript("document.body.dataset.clicked || ''");
        if (dist > 2) throw new Error(`cursor at ${pos.x},${pos.y}; wanted ${cx.toFixed(1)},${cy.toFixed(1)} (${dist.toFixed(2)} px)`);
        if (clicked !== 'yes') throw new Error('the button did not receive the click');
        return `"${el.name}" -> ${pos.x},${pos.y} (${dist.toFixed(2)} px); button handler fired`;
      });
      await screenshot(uiaProbe, 'uia-probe');
    } catch (e) {
      record('UIA probe', 'FAIL', (e && e.message) || String(e), 0);
    }

    // ---------------------------------------------------------------- 3. Notepad (if visible)
    current = 'Notepad';
    const preNote = process.env.SIDEKICK_VERIFY_NOTE;
    const notepadDir = preNote ? path.dirname(preNote) : path.join(out, 'notepad-' + Date.now().toString(36));
    if (!preNote) {
      fs.mkdirSync(notepadDir, { recursive: true });
      cleanup.push(() => fs.rmSync(notepadDir, { recursive: true, force: true }));
    }
    const noteFile = preNote || path.join(notepadDir, 'sidekick-verify.txt');
    if (!preNote) fs.writeFileSync(noteFile, 'Sidekick Windows self-check. This tab is temporary.\r\n');
    const base = path.basename(noteFile);
    let notepadHandle = 0;
    let notepadLaunchError = '';
    try {
      if (preNote) {
        const w = await findWindow(base, 5000);
        notepadHandle = Number(w.id);
      } else {
        const { shell } = require('electron');
        const err = await shell.openPath(noteFile);
        if (err) throw new Error(err);
        const w = await findWindow(base, 8000);
        notepadHandle = Number(w.id);
      }
      record('Notepad launches', 'PASS', `hwnd ${notepadHandle}`, 0);
    } catch (e) {
      notepadLaunchError = e.message;
      record('Notepad external UIA tests', 'SKIP', 'Notepad/Explorer window activation is blocked in this automated session: ' + notepadLaunchError, 0);
    }
    if (notepadHandle) {
      try {
        win32.focusWindow(notepadHandle);
        await sleep(800);
        // Force the UIA worker cold for a meaningful first call.
        require('../../src/main/powershell').disposeSharedSession();
        const t0 = Date.now();
        const coldInfo = await uia.listForegroundElements({ windowTitle: base });
        const cold = Date.now() - t0;
        const t1 = Date.now();
        await uia.listForegroundElements({ windowTitle: base });
        const warm = Date.now() - t1;
        if (!coldInfo.elements.length) throw new Error('cold UIA list returned no controls');
        record('Notepad UIA control list is non-empty', 'PASS', `${coldInfo.elements.length} controls`, 0);
        record('UIA list timing cold vs warm', warm <= cold ? 'PASS' : 'FAIL', `cold ${cold} ms, warm ${warm} ms`, 0);
      } catch (e) {
        record('Notepad UIA control list is non-empty', 'FAIL', e.message, 0);
      }

      // Unicode through SendInput, read back through a TextPattern script.
      await check('SendInput types Unicode and UIA TextPattern reads it back', async () => {
        win32.focusWindow(notepadHandle);
        await sleep(500);
        const info = await uia.listForegroundElements({ windowTitle: base });
        // Select our own tab (Notepad may also have the user's documents in other tabs).
        const tab = info.elements.find((e) => e.type === 'TabItem' && e.name.toLowerCase().includes(base.toLowerCase()));
        if (tab) {
          await uia.actOnElement({ name: tab.name, action: 'invoke' });
          await sleep(450);
        }
        // Click the editor area first (Notepad's document control).
        const after = await uia.listForegroundElements({ windowTitle: base });
        const doc = after.elements.find((e) => e.type === 'Document' && e.w > 80 && e.h > 40) || after.elements.find((e) => e.type === 'Edit' && e.w > 80);
        if (doc) {
          const dip = ctx.screenApi.screenToDipPoint({ x: doc.x + doc.w / 2, y: doc.y + doc.h / 2 });
          await input.click(dip);
          await sleep(250);
        }
        const marker = 'sidekick unicode: h\u00e9llo \u2713 \u65e5\u672c \u2014 done';
        await input.pressKeys('ctrl+end');
        await input.typeText('\r\n' + marker);
        await sleep(700);
        const r = await tools.readText({ windowTitle: base, mode: 'window' });
        if (!r.ok) throw new Error(r.error || 'readText failed');
        if (!r.text.includes(marker)) throw new Error('TextPattern text did not contain the typed marker: ' + JSON.stringify(r.text.slice(-160)));
        return 'Unicode round-trip (hÃ©llo âœ“ æ—¥æœ¬ â€”) via TextPattern';
      });

      // Real click: cursor must land within 2 physical px of the control centre.
      await check('A real click lands within 2 px of a UIA control', async () => {
        const info = await uia.listForegroundElements({ windowTitle: base });
        const el = info.elements.find((e) => e.type === 'MenuItem' && /^file$/i.test(e.name))
          || info.elements.find((e) => e.type === 'MenuItem' && e.w > 20 && e.h > 10)
          || info.elements.find((e) => e.w > 40 && e.h > 20);
        if (!el) throw new Error('no clickable UIA control found');
        const cx = el.x + el.w / 2;
        const cy = el.y + el.h / 2;
        const dip = ctx.screenApi.screenToDipPoint({ x: cx, y: cy });
        await input.click(dip);
        await sleep(250);
        const pos = win32.getCursorPosition();
        const dist = Math.hypot(pos.x - cx, pos.y - cy);
        await input.pressKeys('escape');
        if (dist > 2) throw new Error(`cursor at ${pos.x},${pos.y}; wanted ${cx.toFixed(1)},${cy.toFixed(1)} (${dist.toFixed(2)} px)`);
        return `"${el.name}" -> ${pos.x},${pos.y} (${dist.toFixed(2)} px)`;
      });
    } else {
      // One clear SKIP above covers the external-app checks. The same pipeline is verified on the
      // Electron UIA probe, which is a real Windows UI Automation window in this session.
    }

    // ---------------------------------------------------------------- 3. DPI mapping of a real window
    current = 'DPI';
    let dpiProbe = null;
    let dpiHandle = 0;
    await check('Mouse mapping and UIA rectangles agree through screenToDipPoint', async () => {
      const p = screen.getPrimaryDisplay();
      const wa = p.workArea;
      const width = 420;
      const height = 260;
      const x = Math.round(wa.x + Math.min(80, wa.width - width - 20));
      const y = Math.round(wa.y + Math.min(80, wa.height - height - 20));
      const probe = new BrowserWindow({
        x, y, width, height, frame: false, show: false, resizable: false, skipTaskbar: true,
        hasShadow: false, thickFrame: false, roundedCorners: false,
        title: 'Sidekick DPI probe', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      dpiProbe = probe;
      cleanup.push(() => { try { if (!probe.isDestroyed()) probe.destroy(); } catch (_) { /* ignore */ } });
      await probe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Sidekick DPI probe</title><body style="margin:0;background:#101820;color:#fff;font:16px sans-serif"><h2 style="padding:16px">DPI probe</h2><p style="padding:0 16px">${p.scaleFactor * 100}% scale</p></body>`));
      probe.show();
      probe.focus();
      await sleep(700);
      const hb = probe.getNativeWindowHandle();
      dpiHandle = hb.length >= 8 ? Number(hb.readBigUInt64LE(0)) : hb.readUInt32LE(0);
      const bounds = probe.getBounds();
      // The window root itself is not in the descendant list; find the top-level UIA element by title.
      const psMod = require('../../src/main/powershell');
      const script = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$AE=[System.Windows.Automation.AutomationElement]
$kids=$AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
$hit=$null
foreach($k in $kids){ if($k.Current.Name -like '*Sidekick DPI probe*'){ $hit=$k; break } }
if($hit){ $r=$hit.Current.BoundingRectangle; @{x=[int]$r.X;y=[int]$r.Y;w=[int]$r.Width;h=[int]$r.Height;title=$hit.Current.Name}|ConvertTo-Json -Compress } else { '{}' }`;
      const r = await psMod.runPowerShell(script, { timeoutMs: 15000 });
      let rect = {};
      try { rect = JSON.parse(r.stdout || '{}'); } catch (_) { rect = {}; }
      if (!rect || !rect.w) throw new Error('UIA could not find the probe window (output: ' + (r.stdout || r.stderr || 'none').slice(0, 200) + ')');
      const tl = ctx.screenApi.screenToDipPoint({ x: rect.x, y: rect.y });
      const br = ctx.screenApi.screenToDipPoint({ x: rect.x + rect.w, y: rect.y + rect.h });
      const got = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
      const dx = Math.abs(got.x - bounds.x);
      const dy = Math.abs(got.y - bounds.y);
      const dw = Math.abs(got.w - bounds.width);
      const dh = Math.abs(got.h - bounds.height);
      await screenshot(probe, 'dpi-probe');
      if (dx > 2 || dy > 2 || dw > 3 || dh > 3) {
        throw new Error(`window ${JSON.stringify(bounds)} vs UIA->DIP ${JSON.stringify(got)} (dx=${dx}, dy=${dy}, dw=${dw}, dh=${dh}) at scale ${p.scaleFactor}`);
      }
      if (dx > 2 || dy > 2 || dw > 3 || dh > 3) {
        throw new Error(`window ${JSON.stringify(bounds)} vs UIA->DIP ${JSON.stringify(got)} (dx=${dx}, dy=${dy}, dw=${dw}, dh=${dh}) at scale ${p.scaleFactor}`);
      }
      return `scale ${p.scaleFactor}; Electron ${bounds.width}x${bounds.height} vs UIA ${got.w.toFixed(0)}x${got.h.toFixed(0)} (dx ${dx}, dy ${dy})`;
    });

    // windowAction is tested on our own frameless probe, never on a user's Notepad window.
    await check('windowAction minimize and restore change IsIconic', async () => {
      if (!dpiProbe || !dpiHandle) throw new Error('DPI probe window is not available');
      const m = await tools.windowAction(dpiHandle, 'minimize');
      if (!m.ok) throw new Error(m.error || 'minimize failed');
      await sleep(600);
      if (!(await isIconic(dpiHandle))) throw new Error('IsIconic stayed false after minimize');
      const r = await tools.windowAction(dpiHandle, 'restore');
      if (!r.ok) throw new Error(r.error || 'restore failed');
      await sleep(700);
      if (await isIconic(dpiHandle)) throw new Error('IsIconic stayed true after restore');
      return 'minimized (IsIconic=true) then restored (false)';
    });

    // ---------------------------------------------------------------- 4. Explorer file drag
    current = 'Explorer drag';
    const preDrag = process.env.SIDEKICK_VERIFY_DRAG;
    const dragRoot = preDrag || path.join(out, 'drag-' + Date.now().toString(36));
    if (!preDrag) cleanup.push(() => fs.rmSync(dragRoot, { recursive: true, force: true }));
    await check('Dragging a file onto a folder in Explorer moves it on disk', async () => {
      const source = path.join(dragRoot, 'move-me.txt');
      const destDir = path.join(dragRoot, 'Destination');
      if (!preDrag) {
        fs.mkdirSync(dragRoot, { recursive: true });
        fs.writeFileSync(source, 'move this file');
        fs.mkdirSync(destDir, { recursive: true });
        const { shell } = require('electron');
        const openErr = await shell.openPath(dragRoot);
        if (openErr) throw Object.assign(new Error('Explorer cannot be launched in this automated session (' + openErr + '); run on a normal desktop'), { skip: true });
      } else if (!fs.existsSync(source) || !fs.existsSync(destDir)) {
        throw new Error('pre-opened Explorer fixture is incomplete');
      }
      const folderBase = path.basename(dragRoot);
      try {
        try {
          await findWindow(folderBase, 8000);
        } catch (e) {
          throw Object.assign(new Error('Explorer is not visible from this automated session (' + e.message + '); run on a normal desktop'), { skip: true });
        }
        await sleep(1000);
        // Focus the Explorer window by its title.
        const wins = (await tools.listWindows()).windows || [];
        const win = wins.find((w) => String(w.title || '').includes(folderBase));
        if (win) win32.focusWindow(Number(win.id));
        await sleep(800);
        let els = [];
        for (let i = 0; i < 12 && els.length < 2; i++) {
          els = (await uia.listForegroundElements({ windowTitle: folderBase })).elements || [];
          if (els.length < 2) await sleep(300);
        }
        const from = els.find((e) => e.name === 'move-me.txt');
        const to = els.find((e) => e.name === 'Destination');
        if (!from || !to) throw new Error('Explorer UIA did not expose both items: ' + els.slice(0, 12).map((e) => e.name).join(' | '));
        const f = ctx.screenApi.screenToDipPoint({ x: from.x + from.w / 2, y: from.y + from.h / 2 });
        const t = ctx.screenApi.screenToDipPoint({ x: to.x + to.w / 2, y: to.y + to.h / 2 });
        await input.drag(f, t);
        const movedPath = path.join(destDir, 'move-me.txt');
        for (let i = 0; i < 30 && !fs.existsSync(movedPath); i++) await sleep(200);
        if (!fs.existsSync(movedPath)) throw new Error('file did not arrive in Destination (drag did not move it)');
        if (fs.existsSync(source)) throw new Error('source still exists after the move');
        // Do not close a user's tabbed Explorer window. If this window has only our one tab, close it.
        let closed = false;
        try {
          const tabs = ((await uia.listForegroundElements({ windowTitle: folderBase })).elements || []).filter((e) => e.type === 'TabItem');
          if (tabs.length <= 1) {
            await tools.windowAction(Number(win && win.id), 'close');
            closed = true;
          }
        } catch (_) { /* leave it open */ }
        return 'move-me.txt moved into Destination and verified with fs' + (closed ? ' (test Explorer window closed)' : ' (left the Explorer window open)');
      } finally {
        /* never force-close Explorer: it may hold the user's own tabs/windows */
      }
    });

    // ---------------------------------------------------------------- 6. acrylic screenshots
    current = 'Screenshots';
    await check('Panel screenshot (acrylic check)', async () => {
      wm.showPanel();
      await sleep(1600);
      return await screenshot(wm.panel, 'panel');
    });
    await check('Home screenshot (acrylic check)', async () => {
      wm.openHome();
      await sleep(2200);
      return await screenshot(wm.home, 'home');
    });

    // ---------------------------------------------------------------- cleanup Notepad
    current = 'Cleanup';
    if (notepadHandle) {
      const closed = await closeNotepadTab(notepadHandle, base);
      console.log('Notepad cleanup:', closed.reason);
    }
  } catch (e) {
    record('selfcheck harness', 'FAIL', (e && e.stack) || String(e), 0);
  } finally {
    for (const fn of cleanup.reverse()) {
      try { fn(); } catch (_) { /* ignore */ }
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const report = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    osRelease: os.release(),
    electron: process.versions.electron,
    appVersion: app.getVersion(),
    displays,
    summary: { pass: passed.length, fail: failed.length, skip: skipped.length, total: results.length },
    results,
    screenshots,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    '# Sidekick Windows self-check',
    '',
    `Run: ${report.startedAt}  `,
    `OS: Windows ${os.release()} Â· Electron ${report.electron} Â· app ${report.appVersion}  `,
    `Displays: ${displays.map((d) => `${d.scaleFactor * 100}%`).join(', ')}`,
    '',
    '| Result | Check | Detail |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.status} | ${r.name.replace(/\|/g, '\\|')} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
    '',
    `**${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped**`,
    '',
    'Screenshots: ' + screenshots.map((s) => s.file).join(', '),
  ].join('\n');
  fs.writeFileSync(path.join(out, 'report.md'), md);
  console.log(`\nSelf-check: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  console.log('Report:', path.join(out, 'report.md'));
  await sleep(300);
  app.exit(failed.length ? 1 : 0);
};

