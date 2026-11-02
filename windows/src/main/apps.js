'use strict';
/*
 * Reliable "open <app>" for Windows.
 *
 * The old approach was `Start-Process <name>`. That only works for programs on PATH or registered in
 * "App Paths" (notepad, calc). It fails for most things people actually say: "WhatsApp", "Spotify",
 * "Settings", "Photos", "Telegram", "VS Code", "Word"...
 *
 * The Start menu already knows every installed app, Win32 and Store alike. `Get-StartApps` returns
 * Name + AppID, and `explorer.exe shell:AppsFolder\<AppID>` launches either kind. So:
 *
 *   1. build (and cache) an index of Start-menu apps,
 *   2. fuzzy-match what the user said against it ("chrome" -> "Google Chrome", "vs code" -> "Visual Studio Code"),
 *   3. launch by AppID.
 *
 * Shells, installers and admin tools are removed from the index, so they can never be launched by name.
 */
const fs = require('fs');
const path = require('path');
const { psQuote } = require('./powershell');
const { isBlockedLaunch } = require('./safety');

const BLOCKED_WORDS = /\b(powershell|pwsh|command prompt|cmd|terminal|registry editor|regedit|wsl|ubuntu|bash|windows security|uninstall|installer|setup)\b/i;
const NOISE_WORDS = /\b(uninstall|readme|release notes|documentation|help|license|manual|website|web site|support|changelog|what'?s new)\b/i;

// What people say -> what the Start menu calls it. Only needed where the two differ a lot.
const ALIASES = {
  chrome: 'google chrome',
  'google chrome browser': 'google chrome',
  edge: 'microsoft edge',
  explorer: 'file explorer',
  'windows explorer': 'file explorer',
  files: 'file explorer',
  folders: 'file explorer',
  'my computer': 'this pc',
  computer: 'this pc',
  calc: 'calculator',
  'vs code': 'visual studio code',
  vscode: 'visual studio code',
  code: 'visual studio code',
  word: 'word',
  'ms word': 'word',
  'microsoft word': 'word',
  excel: 'excel',
  'ms excel': 'excel',
  powerpoint: 'powerpoint',
  'power point': 'powerpoint',
  teams: 'microsoft teams',
  outlook: 'outlook',
  mail: 'mail',
  store: 'microsoft store',
  'app store': 'microsoft store',
  snip: 'snipping tool',
  screenshot: 'snipping tool',
  'screen snip': 'snipping tool',
  settings: 'settings',
  'task manager': 'task manager',
  tg: 'telegram',
  whatsapp: 'whatsapp',
  'what s app': 'whatsapp',
  'wats app': 'whatsapp',
  insta: 'instagram',
  music: 'media player',
  'media player': 'media player',
  camera: 'camera',
  clock: 'clock',
  alarms: 'clock',
  notes: 'sticky notes',
  paint: 'paint',
  mspaint: 'paint',
  notepad: 'notepad',
  'note pad': 'notepad',
  'node path': 'notepad',
  'notepath': 'notepad',
  from: 'google chrome',
  front: 'google chrome',
  'from browser': 'google chrome',
  'front browser': 'google chrome',
};

function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFiller(q) {
  return normalize(q)
    .replace(/^(please |can you |could you |hey |ok |okay )+/, '')
    .replace(/^(the |my |a |an )+/, '')
    .replace(/ (app|application|program|software|please|for me|now)$/g, '')
    .replace(/ (app|application|program|software|please|for me|now)$/g, '')
    .replace(/^(\S+(?: \S+)*?) browser$/, '$1') // "chrome browser" -> "chrome" (but a bare "browser" stays)
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
}

// 0..100. Higher is a better match for what the user said.
function scoreName(query, name) {
  if (!query || !name) return 0;
  if (query === name) return 100;
  const qTokens = query.split(' ');
  const nTokens = name.split(' ');
  let score = 0;
  if (name.startsWith(query + ' ')) score = 92;
  else if (query.startsWith(name + ' ')) score = 86;
  else if ((' ' + name + ' ').includes(' ' + query + ' ')) score = 78;
  else if (qTokens.every((qt) => nTokens.some((nt) => nt === qt || (qt.length >= 3 && nt.startsWith(qt))))) score = 72;
  else if (name.includes(query) && query.length >= 4) score = 64;
  else {
    // speech-to-text slips: "spotifi", "telegrem", "calculater"
    const whole = similarity(query, name);
    const best = nTokens.reduce((m, nt) => Math.max(m, similarity(query, nt)), 0);
    const sim = Math.max(whole, best);
    if (sim >= 0.8 && query.length >= 4) score = Math.round(40 + sim * 25); // 61..65
  }
  if (!score) return 0;
  // Prefer the shorter, plainer name ("Chrome" over "Chrome Remote Desktop").
  score -= Math.min(10, Math.max(0, nTokens.length - qTokens.length) * 2);
  if (NOISE_WORDS.test(name)) score -= 30;
  return Math.max(0, score);
}

function isBlockedApp(name) {
  return isBlockedLaunch(name) || BLOCKED_WORDS.test(String(name || ''));
}

// `apps` = [{ name, id }]. Returns { app, score, runnerUp } or null when nothing is good enough.
function resolveApp(query, apps, { minScore = 60 } = {}) {
  const normQ = normalize(query);
  const cleaned = stripFiller(query);
  const aliasHit = ALIASES[normQ] || ALIASES[cleaned];
  if (!cleaned && !aliasHit) return null;
  const wanted = aliasHit || cleaned;
  let best = null;
  let second = null;
  for (const app of apps || []) {
    const n = app.norm || normalize(app.name);
    let score = Math.max(scoreName(wanted, n), wanted !== cleaned ? scoreName(cleaned, n) : 0);
    if (!score) continue;
    const cand = { app, score };
    if (!best || score > best.score) { second = best; best = cand; } else if (!second || score > second.score) second = cand;
  }
  if (!best || best.score < minScore) return null;
  return { app: best.app, score: best.score, runnerUp: second && second.score >= minScore ? second.app : null };
}

// Output of: Get-StartApps | % { $_.Name + "`t" + $_.AppID }
function parseStartApps(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('\t');
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    const id = line.slice(i + 1).trim();
    if (!name || !id || isBlockedApp(name)) continue;
    const key = normalize(name) + '|' + id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, id, norm: normalize(name) });
  }
  return out;
}

const LIST_SCRIPT = 'Get-StartApps | Sort-Object Name | ForEach-Object { $_.Name + "`t" + $_.AppID }';

function launchScript(appId) {
  // explorer.exe resolves shell:AppsFolder\<AppID> for both classic and Store apps.
  return `$id = ${psQuote(appId)}; Start-Process -FilePath 'explorer.exe' -ArgumentList ('"shell:AppsFolder\\' + $id + '"'); 'ok'`;
}

class AppIndex {
  // run(script, {timeoutMs}) -> Promise<{ stdout, code }>
  constructor({ run, cacheFile, log, now = () => Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
    this.run = run;
    this.cacheFile = cacheFile || '';
    this.log = log || { info() {}, warn() {}, error() {} };
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.apps = [];
    this.loadedAt = 0;
    this.refreshing = null;
    this._loadCache();
  }

  _loadCache() {
    if (!this.cacheFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (Array.isArray(j.apps) && j.apps.length) {
        this.apps = j.apps.map((a) => ({ name: a.name, id: a.id, norm: normalize(a.name) }));
        this.loadedAt = Number(j.at) || 0;
      }
    } catch (_) {
      /* no cache yet */
    }
  }

  _saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ at: this.loadedAt, apps: this.apps.map(({ name, id }) => ({ name, id })) }));
    } catch (_) {
      /* cache is optional */
    }
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const r = await this.run(LIST_SCRIPT, { timeoutMs: 20000 });
        const apps = parseStartApps(r && r.stdout);
        if (apps.length) {
          this.apps = apps;
          this.loadedAt = this.now();
          this._saveCache();
          this.log.info('start menu apps indexed', { count: apps.length });
        } else {
          this.log.warn('start menu index came back empty', { code: r && r.code, stderr: r && String(r.stderr || '').slice(0, 120) });
        }
      } catch (e) {
        this.log.warn('start menu index failed', e && e.message);
      } finally {
        this.refreshing = null;
      }
      return this.apps;
    })();
    return this.refreshing;
  }

  // Cheap to call often: uses the cache and refreshes in the background when it is old.
  async ensure() {
    if (!this.apps.length) await this.refresh();
    else if (this.now() - this.loadedAt > this.maxAgeMs) this.refresh();
    return this.apps;
  }

  async resolve(query) {
    await this.ensure();
    let hit = resolveApp(query, this.apps);
    if (!hit && this.now() - this.loadedAt > 60 * 1000) {
      // Maybe it was installed a minute ago: look once more with a fresh list.
      await this.refresh();
      hit = resolveApp(query, this.apps);
    }
    return hit;
  }

  // -> { ok, opened, via } | { ok:false, error, notFound? }
  async open(query) {
    const hit = await this.resolve(query);
    if (!hit) return { ok: false, notFound: true, error: `I could not find an app called "${String(query).slice(0, 40)}" in the Start menu.` };
    if (isBlockedApp(hit.app.name)) return { ok: false, error: 'I never start shells, installers or admin tools by name.' };
    const r = await this.run(launchScript(hit.app.id), { timeoutMs: 15000 });
    if (r && /ok/.test(String(r.stdout)) && (r.code === 0 || r.code === undefined)) {
      this.log.info('open app', { said: String(query).slice(0, 40), opened: hit.app.name, score: hit.score });
      return { ok: true, opened: hit.app.name, via: 'start menu' };
    }
    return { ok: false, error: `Windows would not start ${hit.app.name}.` };
  }
}

module.exports = { AppIndex, resolveApp, parseStartApps, scoreName, normalize, stripFiller, isBlockedApp, launchScript, LIST_SCRIPT, ALIASES };
