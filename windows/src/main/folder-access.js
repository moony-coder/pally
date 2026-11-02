'use strict';
/*
 * Folder permissions: which folders Sidekick may READ, and which it may also CHANGE.
 *
 * Settings key `folders`:
 *   null                         -> default: your user folder, read and change (what earlier versions did)
 *   [{ path, write }, ...]       -> exactly the folders you chose. Any drive is allowed ("D:\\", "E:\\Projects").
 *                                   write:true means "read and change", write:false means "read only".
 *
 * Rules that cannot be switched off, whatever the list says:
 *   - secrets: .ssh, .aws, .gnupg, .azure, .kube, Windows credential / DPAPI / vault folders, Sidekick's own settings
 *   - system folders are never CHANGED: Windows, Program Files, ProgramData, the recycle bin, System Volume Information
 *   - symlinks and junctions are resolved first, so a link inside an allowed folder cannot lead out of it
 *   - paths must be absolute (no "..\\" tricks, no NUL bytes)
 */
const nodePath = require('path');
const fs = require('fs');
const os = require('os');

const MAX_FOLDERS = 40;

// Matched against the path with forward slashes and lower case.
const SECRET_RE = [
  /(^|\/)\.(ssh|aws|gnupg|azure|kube)(\/|$)/,
  /\/appdata\/(roaming|local)\/microsoft\/(credentials|protect|vault|crypto)(\/|$)/,
  /\/appdata\/local\/microsoft\/(credentials|vault)(\/|$)/,
  // key and password files, wherever they sit
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /\.(pem|pfx|p12|kdbx|ppk)$/,
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /(^|\/)(login data|web data|cookies)(-journal)?$/,
  // browser profiles hold saved passwords, cookies and sessions
  /\/appdata\/(local|roaming)\/(google\/chrome|microsoft\/edge|bravesoftware|mozilla\/firefox|opera software|vivaldi)(\/|$)/,
];
const SYSTEM_WRITE_DENY_WIN = /^([a-z]:)?\/(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information|recovery|boot)(\/|$)/;
const SYSTEM_WRITE_DENY_POSIX = /^\/(etc|usr|bin|sbin|lib|lib64|boot|sys|proc|dev|var|system|library|private|opt)(\/|$)/;

const KNOWN_FOLDER_WORDS = ['downloads', 'documents', 'desktop', 'pictures', 'videos', 'music'];

function slashLower(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function isWinMod(pathMod) {
  return pathMod === nodePath.win32;
}

// Turns whatever came in into a clean list of { path, write }. Drops anything that is not an absolute path.
function sanitizeFolderList(input, { pathMod = nodePath, caseInsensitive = pathMod === nodePath.win32 } = {}) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) return null;
  const out = [];
  const seen = new Map();
  for (const raw of input) {
    const item = typeof raw === 'string' ? { path: raw, write: false } : raw;
    if (!item || typeof item.path !== 'string') continue;
    const text = item.path.trim();
    if (!text || text.includes('\0') || !pathMod.isAbsolute(text)) continue;
    let p = pathMod.resolve(text);
    const root = pathMod.parse(p).root;
    if (p.length > root.length) p = p.replace(/[\\/]+$/, '');
    const key = caseInsensitive ? p.toLowerCase() : p;
    if (seen.has(key)) {
      // the same folder listed twice: the stronger permission wins
      const idx = seen.get(key);
      if (item.write) out[idx].write = true;
      continue;
    }
    seen.set(key, out.length);
    out.push({ path: p, write: !!item.write });
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

function createFolderAccess({
  getFolders = () => null,
  homeDir = os.homedir(),
  pathMod = nodePath, // the host's path rules (win32 on Windows)
  realpath = (p) => fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p),
  protectedPaths = () => [],
} = {}) {
  const win = isWinMod(pathMod);
  const ci = win; // case-insensitive file system

  // Folders that are always usable, whatever the user chose (Sidekick's own output folder in Documents).
  const implicit = [];

  function effective() {
    const list = sanitizeFolderList(getFolders(), { pathMod, caseInsensitive: ci });
    const base = list === null ? [{ path: pathMod.resolve(homeDir), write: true }] : list;
    return base.concat(implicit.map((r) => ({ path: r.path, write: r.write, implicit: true })));
  }

  // realpath of the nearest existing ancestor + the part that does not exist yet (move targets, new folders)
  function realish(p) {
    let cur = p;
    const rest = [];
    for (let i = 0; i < 64; i++) {
      try {
        let r = realpath(cur);
        if (win) r = String(r).replace(/^\\\\\?\\(?=[a-zA-Z]:)/, ''); // \\?\C:\x -> C:\x
        return rest.length ? pathMod.join(r, ...rest.slice().reverse()) : r;
      } catch (_) {
        const parent = pathMod.dirname(cur);
        if (parent === cur) return p;
        rest.push(pathMod.basename(cur));
        cur = parent;
      }
    }
    return p;
  }

  function within(root, target) {
    const rel = pathMod.relative(root, target);
    if (rel === '') return true;
    if (rel === '..' || rel.startsWith('..' + pathMod.sep) || rel.startsWith('../')) return false;
    return !pathMod.isAbsolute(rel);
  }

  function isSecret(p) {
    const s = slashLower(p);
    if (SECRET_RE.some((re) => re.test(s))) return true;
    for (const pp of protectedPaths() || []) {
      if (!pp) continue;
      const r = pathMod.resolve(pp);
      if (within(r, pathMod.resolve(p))) return true;
    }
    return false;
  }

  function isSystemForWrite(p) {
    const s = slashLower(p);
    return win ? SYSTEM_WRITE_DENY_WIN.test(s) : SYSTEM_WRITE_DENY_POSIX.test(s);
  }

  const deny = (error, extra) => Object.assign({ ok: false, error }, extra || {});

  // mode: 'read' | 'write'. Returns { ok:true, path } or { ok:false, error }.
  function check(p, mode = 'read') {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return deny('Give a full folder or file path.');
    if (!pathMod.isAbsolute(p.trim())) return deny('Give the full path, starting with a drive letter such as C:\\ (relative paths are not accepted).');
    const resolved = pathMod.resolve(p.trim());
    const real = realish(resolved);
    if (isSecret(resolved) || isSecret(real)) return deny('That location holds secrets or Sidekick\'s own settings, so it is always off limits.', { blocked: true });
    const want = mode === 'write' ? 'write' : 'read';
    if (want === 'write' && (isSystemForWrite(resolved) || isSystemForWrite(real))) return deny('System folders are never changed.', { blocked: true });
    const roots = effective();
    const usable = roots.filter((r) => (want === 'write' ? r.write : true));
    const hit = usable.find((r) => within(pathMod.resolve(r.path), resolved) && within(realish(pathMod.resolve(r.path)), real));
    if (hit) return { ok: true, path: resolved, root: hit.path };
    const readable = roots.find((r) => within(pathMod.resolve(r.path), resolved) && within(realish(pathMod.resolve(r.path)), real));
    if (want === 'write' && readable) {
      return deny(`I can only read "${readable.path}", not change it. You can allow changes in Home > Folders.`, { blocked: true, needs: 'write' });
    }
    return deny('That path is outside the folders you allowed. You can add it in Home > Folders.', { blocked: true, needs: want });
  }

  return {
    effective,
    // Only the folders the user picked (without the implicit Sidekick folder), for the Home screen.
    chosen() {
      const list = sanitizeFolderList(getFolders(), { pathMod, caseInsensitive: ci });
      return list === null ? [{ path: pathMod.resolve(homeDir), write: true }] : list;
    },
    addImplicit(root) {
      if (root && root.path && !implicit.some((r) => r.path === root.path)) implicit.push({ path: pathMod.resolve(root.path), write: root.write !== false });
    },
    // Path-only test (no disk access): is this somewhere that is always off limits? Used while walking folders.
    isSecretPath: (p) => isSecret(pathMod.resolve(String(p))),
    isDefault: () => getFolders() === null || getFolders() === undefined,
    check,
    canRead: (p) => check(p, 'read').ok,
    canWrite: (p) => check(p, 'write').ok,
    // The folders the agent may use, as short lines for a tool result or a prompt.
    describe() {
      return effective().map((r) => `${r.path} (${r.write ? 'read and change' : 'read only'})`);
    },
    protectedNote: 'Never touched: .ssh, .aws, .gnupg, Windows credential stores, Sidekick settings. Never changed: Windows, Program Files, ProgramData.',
  };
}

// "downloads", "my documents", "d drive", "D:", "C:\\Users\\me\\x", "~", "home" -> an absolute path, or null.
function resolveFolderRef(ref, { known = {}, homeDir = os.homedir(), pathMod = nodePath } = {}) {
  let t = String(ref == null ? '' : ref).trim().replace(/^["']|["']$/g, '');
  if (!t) return null;
  const win = isWinMod(pathMod);
  if (/%[A-Za-z_]+%/.test(t)) {
    t = t.replace(/%([A-Za-z_]+)%/g, (m, name) => {
      if (/^(userprofile|homepath)$/i.test(name)) return homeDir;
      return m;
    });
  }
  if (/^~([\\/]|$)/.test(t)) t = pathMod.join(homeDir, t.slice(1));
  if (pathMod.isAbsolute(t)) return pathMod.resolve(t);
  const words = t.toLowerCase().replace(/^(the|my|your)\s+/g, '').replace(/^(the|my)\s+/g, '').replace(/\s+(folder|directory)$/g, '').trim();
  if (/^(home|user|user folder|home folder|my pc|profile)$/.test(words)) return pathMod.resolve(homeDir);
  if (known[words]) return pathMod.resolve(known[words]);
  if (KNOWN_FOLDER_WORDS.includes(words.replace(/s$/, '') + 's') && known[words.replace(/s$/, '') + 's']) {
    return pathMod.resolve(known[words.replace(/s$/, '') + 's']);
  }
  if (words === 'photos' && known.pictures) return pathMod.resolve(known.pictures);
  // a bare letter is not a drive ("how big is x"); it needs the word "drive" or a colon
  const drive = /^([a-z])\s*drive$/.exec(words) || /^drive\s+([a-z])$/.exec(words) || /^([a-z]):[\\/]?$/.exec(words);
  if (drive && win) return drive[1].toUpperCase() + ':\\';
  return null;
}

module.exports = { createFolderAccess, sanitizeFolderList, resolveFolderRef, MAX_FOLDERS, KNOWN_FOLDER_WORDS };
