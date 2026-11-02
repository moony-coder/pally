'use strict';
/*
 * Non-mouse tools the agent can use: open urls/apps, search, fetch pages,
 * clipboard, files, windows, and (approved) PowerShell.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runPowerShell, psQuote } = require('./powershell');
const { isBlockedLaunch } = require('./safety');
const { createFolderAccess, resolveFolderRef } = require('./folder-access');
const { createDiskTools } = require('./disk-tools');
const { buildRunningAppsScript, parseRunningApps } = require('./ps-scripts');

function isSafeHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function htmlToText(html, max = 6000) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseDuckDuckGo(html, limit = 6) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = m[1];
    const u = /uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]);
    out.push({ url: href, title: htmlToText(m[2], 140), snippet: htmlToText(m[3] || '', 240) });
  }
  return out;
}

function safeAppName(name) {
  return /^[\w .\-+()]{1,60}$/.test(name);
}

// Files that run code when opened. The agent may show the user a folder or a document, never launch a program this way.
const BLOCKED_OPEN_EXT = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|reg|hta|jar|dll|cpl)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'appdata', '$recycle.bin', 'windows', 'program files', 'program files (x86)']);

function windowCommand(action) {
  // SW_MINIMIZE 6, SW_MAXIMIZE 3, SW_RESTORE 9
  return { minimize: 6, maximize: 3, restore: 9 }[action] || null;
}

// `run` serves the app's own fixed scripts (may be the shared worker). `runOnce` runs arbitrary, user-approved
// scripts in a throwaway process so they can never change the worker's state.
// `access` decides which folders may be read and which may be changed (folder-access.js). Without one, the user
// folder is readable and changeable, as in earlier versions. `knownFolders` maps words like "downloads" to paths.
function createSystemTools({ shell, clipboard, fetchImpl = (...a) => fetch(...a), documentsDir, run = runPowerShell, runOnce = null, platform = process.platform, apps = null, access = null, knownFolders = null, protectedPaths = () => [] }) {
  const runArbitrary = runOnce || run;
  const workDir = path.join(documentsDir || path.join(os.homedir(), 'Documents'), 'Sidekick');
  const homeDir = os.homedir();
  const journalFile = path.join(workDir, 'move-journal.json');
  const folderAccess = access || createFolderAccess({ getFolders: () => null, homeDir, protectedPaths });
  // Sidekick's own output folder (notes, move journal) is always usable, even when you only share another drive.
  folderAccess.addImplicit({ path: workDir, write: true });
  const known = knownFolders || {
    downloads: path.join(homeDir, 'Downloads'), documents: path.join(homeDir, 'Documents'), desktop: path.join(homeDir, 'Desktop'),
    pictures: path.join(homeDir, 'Pictures'), videos: path.join(homeDir, 'Videos'), music: path.join(homeDir, 'Music'),
  };
  const disk = createDiskTools({ access: folderAccess, platform });
  const readOk = (p) => folderAccess.check(p, 'read');
  const writeOk = (p) => folderAccess.check(p, 'write');
  // "downloads", "D drive", "~\\Projects" or a full path -> a full path (or the text unchanged)
  const resolveDir = (ref) => resolveFolderRef(ref, { known, homeDir }) || String(ref == null ? '' : ref);

  // A small, capped journal so a move can be undone after a restart. It lives next to saved files,
  // not in the registry or a hidden global folder.
  function readMoves() {
    try {
      const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch (_) {
      return [];
    }
  }
  function writeMoves(list) {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(journalFile, JSON.stringify(list.slice(-100), null, 2));
  }
  function movePath(from, to) {
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
      } else throw e;
    }
  }

  return {
    workDir,
    async openUrl(url) {
      if (!isSafeHttpUrl(url)) return { ok: false, error: 'Only http and https links can be opened.' };
      await shell.openExternal(url);
      return { ok: true, opened: url };
    },
    async openApp(name) {
      if (!safeAppName(name)) return { ok: false, error: 'That app name looks unsafe.' };
      if (isBlockedLaunch(name)) return { ok: false, error: 'I never start shells, installers or admin tools by name. Ask the user to open it themselves.' };
      if (platform !== 'win32') return { ok: false, error: 'Opening apps is only supported on Windows.' };
      // 1) the Start menu index: finds Store apps, apps whose name differs from their .exe, and fixes speech slips
      if (apps) {
        try {
          const r = await apps.open(name);
          if (r.ok) return r;
        } catch (_) {
          /* fall through to Start-Process */
        }
      }
      // 2) programs on PATH / App Paths and URI handlers (calc, notepad, ms-settings:)
      const script = `try { Start-Process ${psQuote(name)} -ErrorAction Stop; 'ok' } catch { 'ERR: ' + $_.Exception.Message }`;
      const r = await run(script, { timeoutMs: 10000 });
      if (/^ERR/.test(r.stdout)) {
        return { ok: false, error: r.stdout.slice(5) };
      }
      return { ok: true, opened: name };
    },
    async webSearch(query) {
      const res = await fetchImpl('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sidekick' },
      });
      const html = await res.text();
      const results = parseDuckDuckGo(html);
      return { ok: true, results };
    },
    async fetchPage(url) {
      if (!isSafeHttpUrl(url)) return { ok: false, error: 'Only http and https pages can be read.' };
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sidekick' } });
      const text = await res.text();
      return { ok: true, status: res.status, text: htmlToText(text) };
    },
    readClipboard() {
      return { ok: true, text: clipboard.readText().slice(0, 4000) };
    },
    writeClipboard(text) {
      clipboard.writeText(String(text));
      return { ok: true };
    },
    saveFile(name, content) {
      const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'note.txt';
      fs.mkdirSync(workDir, { recursive: true });
      const full = path.join(workDir, safe);
      fs.writeFileSync(full, String(content), 'utf8');
      return { ok: true, path: full };
    },
    listFiles(dir) {
      const target = dir ? resolveDir(dir) : workDir;
      const okRead = readOk(target);
      if (!okRead.ok) return okRead;
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 100);
        return { ok: true, dir: okRead.path, entries: entries.filter((e) => !folderAccess.isSecretPath(path.join(okRead.path, e.name))).map((e) => (e.isDirectory() ? e.name + '/' : e.name)) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    readFile(file) {
      const okRead = readOk(String(file || ''));
      if (!okRead.ok) return okRead;
      const target = okRead.path;
      try {
        const stat = fs.statSync(target);
        if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'File is too large to read.' };
        return { ok: true, text: fs.readFileSync(target, 'utf8').slice(0, 8000) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    // Moves a file or folder inside the user folder and records it in a journal. Never overwrites.
    moveFile(from, to) {
      try {
        if (!String(from || '').trim() || !String(to || '').trim()) return { ok: false, error: 'Give both a source and a destination.' };
        const srcOk = writeOk(resolveDir(from));
        if (!srcOk.ok) return srcOk;
        const dstOk = writeOk(resolveDir(to));
        if (!dstOk.ok) return dstOk;
        const src = srcOk.path;
        let dst = dstOk.path;
        if (!fs.existsSync(src)) return { ok: false, error: 'The source does not exist.' };
        if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) dst = path.join(dst, path.basename(src));
        if (src === dst) return { ok: false, error: 'The source and destination are the same.' };
        const insideSource = path.relative(src, dst);
        if (insideSource && !insideSource.startsWith('..') && !path.isAbsolute(insideSource)) {
          return { ok: false, error: 'I cannot move a folder inside itself.' };
        }
        if (fs.existsSync(dst)) return { ok: false, error: 'Something already exists at the destination. I never overwrite; pick another name.' };
        if (!fs.existsSync(path.dirname(dst))) return { ok: false, error: 'The destination folder does not exist.' };
        movePath(src, dst);
        const id = 'mv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const moves = readMoves();
        moves.push({ id, from: src, to: dst, at: Date.now() });
        writeMoves(moves);
        return { ok: true, from: src, to: dst, undoId: id, message: 'Moved. Use undo_move with this id to put it back.' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    listMoves() {
      const moves = readMoves().filter((m) => !m.undoneAt).slice(-20).reverse();
      return { ok: true, moves };
    },
    undoMove(id) {
      try {
        const moves = readMoves();
        const wanted = String(id || 'last');
        const entry = wanted === 'last' ? moves.slice().reverse().find((m) => !m.undoneAt) : moves.find((m) => m.id === wanted && !m.undoneAt);
        if (!entry) return { ok: false, error: 'There is no move to undo.' };
        if (!fs.existsSync(entry.to)) return { ok: false, error: 'The moved file is no longer at its new location.' };
        if (fs.existsSync(entry.from)) return { ok: false, error: 'Something already exists at the old location, so I will not overwrite it.' };
        fs.mkdirSync(path.dirname(entry.from), { recursive: true });
        movePath(entry.to, entry.from);
        entry.undoneAt = Date.now();
        writeMoves(moves);
        return { ok: true, id: entry.id, from: entry.to, to: entry.from, message: 'Move undone.' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    // ---- read-only "how big / how full / what is running" tools (no clicking, never change anything)
    folderAccess,
    resolveFolder: (ref) => resolveFolderRef(ref, { known, homeDir }),
    allowedFolders: () => ({ ok: true, folders: folderAccess.describe(), note: folderAccess.protectedNote }),
    folderSize: (dir, opts) => disk.folderSize(resolveDir(dir), opts),
    biggestFiles: (dir, opts) => disk.biggestFiles(resolveDir(dir), opts),
    fileCounts: (dir, opts) => disk.fileCounts(resolveDir(dir), opts),
    diskSpace: (p) => disk.diskSpace(p ? String(p) : ''),
    listDrives: () => disk.listDrives(),
    systemInfo: () => disk.systemInfo(),
    disk,
    async runningApps() {
      if (platform !== 'win32') return { ok: false, error: 'Listing running apps is only supported on Windows.' };
      const r = await run(buildRunningAppsScript(), { timeoutMs: 12000 });
      if (r.code !== 0) return { ok: false, error: (r.stderr || 'Could not list the running apps.').slice(0, 200) };
      return parseRunningApps(r.stdout);
    },
    async listWindows() {
      if (platform !== 'win32') return { ok: true, windows: [] };
      const r = await run(
        "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 40 Id,ProcessName,MainWindowTitle,@{n='Handle';e={[int64]$_.MainWindowHandle}} | ConvertTo-Json -Compress",
        { timeoutMs: 8000 }
      );
      try {
        let j = JSON.parse(r.stdout || '[]');
        if (!Array.isArray(j)) j = [j];
        return {
          ok: true,
          windows: j.map((w) => ({ id: w.Handle, app: w.ProcessName, title: w.MainWindowTitle })),
        };
      } catch (_) {
        return { ok: true, windows: [] };
      }
    },
    // Opens a file or folder in the user's folder with its normal app (never programs or scripts).
    async openPath(target) {
      const okRead = readOk(resolveDir(target));
      if (!okRead.ok) return okRead;
      const full = okRead.path;
      if (BLOCKED_OPEN_EXT.test(full)) return { ok: false, error: 'I do not launch programs or scripts this way.' };
      if (!fs.existsSync(full)) return { ok: false, error: 'That path does not exist.' };
      const err = await shell.openPath(full);
      return err ? { ok: false, error: err } : { ok: true, opened: full };
    },
    // Looks for files by name (case-insensitive, all words must match). Shallow and capped so it stays fast.
    findFiles(query, dir, { maxDepth = 5, maxResults = 15, maxVisited = 20000 } = {}) {
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { ok: false, error: 'Say what to look for.' };
      const rootOk = dir ? readOk(resolveDir(dir)) : null;
      if (rootOk && !rootOk.ok) return rootOk;
      // no folder given: search the folders you shared (the first one is the main one)
      const roots = rootOk ? [rootOk.path] : folderAccess.chosen().map((r) => r.path);
      const root = roots[0] || homeDir;
      const found = [];
      let visited = 0;
      const walk = (d, depth) => {
        if (found.length >= maxResults || visited >= maxVisited || depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        const subdirs = [];
        for (const e of entries) {
          if (++visited >= maxVisited || found.length >= maxResults) break;
          const lower = e.name.toLowerCase();
          if (folderAccess.isSecretPath(path.join(d, e.name))) continue;
          if (words.every((w) => lower.includes(w))) found.push((e.isDirectory() ? '[folder] ' : '') + path.join(d, e.name));
          if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(lower) && !e.name.startsWith('.')) subdirs.push(path.join(d, e.name));
        }
        for (const sd of subdirs) walk(sd, depth + 1);
      };
      for (const r of roots) walk(r, 0);
      return { ok: true, searched: roots.join(', '), results: found, truncated: visited >= maxVisited };
    },
    // minimize | maximize | restore | close for the window with this handle (from listWindows).
    async windowAction(handle, action) {
      if (platform !== 'win32') return { ok: false, error: 'Window control is only supported on Windows.' };
      const h = Number(handle);
      if (!Number.isFinite(h) || h <= 0) return { ok: false, error: 'Unknown window.' };
      const sig = "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);";
      let body;
      if (action === 'close') body = `[sidekick_win.A]::PostMessage([IntPtr]${h}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`;
      else if (windowCommand(action)) body = `[sidekick_win.A]::ShowWindow([IntPtr]${h}, ${windowCommand(action)}) | Out-Null`;
      else return { ok: false, error: 'Unknown window action.' };
      const r = await run(`if (-not ('sidekick_win.A' -as [type])) { Add-Type -MemberDefinition '${sig.replace(/'/g, "''")}' -Name A -Namespace sidekick_win }; ${body}; 'ok'`, { timeoutMs: 8000 });
      return r.code === 0 ? { ok: true, action } : { ok: false, error: (r.stderr || 'could not change the window').slice(0, 200) };
    },
    // Copies whatever is selected in the foreground app: sends Ctrl+C through `press`, then reads the clipboard.
    async copySelection(press, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
      const before = clipboard.readText();
      const marker = '__sidekick_copy_marker_' + Date.now() + '__';
      clipboard.writeText(marker);
      await press('ctrl+c');
      await sleep(180);
      const text = clipboard.readText();
      if (text === marker) {
        clipboard.writeText(before);
        return { ok: false, error: 'Nothing was selected to copy.' };
      }
      return { ok: true, text: text.slice(0, 4000), length: text.length };
    },
    // Reads text through Windows UI Automation TextPattern, without touching the clipboard.
    // mode = 'selection' reads only the selected range; 'window' reads the foreground document.
    async readText({ windowTitle = '', controlName = '', mode = 'window' } = {}) {
      if (platform !== 'win32') return { ok: false, error: 'Reading UI text is only supported on Windows.' };
      const { buildReadTextScript, parseTextResult } = require('./ps-scripts');
      const r = await run(buildReadTextScript({ windowTitle: String(windowTitle || ''), controlName: String(controlName || ''), mode: mode === 'selection' ? 'selection' : 'window' }), { timeoutMs: 12000 });
      if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'UI Automation failed').slice(0, 300) };
      const res = parseTextResult(r.stdout);
      if (!res.found) return { ok: false, error: res.error || 'No text could be read from that window.' };
      return { ok: true, text: res.text.slice(0, 8000), source: res.source, control: res.name, type: res.type, truncated: res.text.length > 8000 };
    },
    // Pastes text into the focused control through the clipboard (reliable for long or unicode text).
    async pasteText(text, press, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
      const before = clipboard.readText();
      clipboard.writeText(String(text));
      await press('ctrl+v');
      await sleep(250);
      clipboard.writeText(before);
      return { ok: true, pasted: String(text).length };
    },
    async runPowerShell(script) {
      const r = await runArbitrary(String(script), { timeoutMs: 30000 });
      return { ok: r.code === 0, code: r.code, stdout: r.stdout.slice(0, 4000), stderr: r.stderr.slice(0, 1500) };
    },
  };
}

module.exports = { createSystemTools, isSafeHttpUrl, htmlToText, parseDuckDuckGo, safeAppName, BLOCKED_OPEN_EXT };
