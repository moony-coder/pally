'use strict';
/*
 * Read-only "how big / how full / what is here" tools. They never change anything and need no clicking.
 *
 *   folderSize     total size of a folder, plus which sub-folders are biggest
 *   biggestFiles   the N largest files under a folder
 *   fileCounts     how many files and folders, split by type
 *   diskSpace      free / total space per drive (metadata only, no folder permission needed)
 *   systemInfo     Windows version, CPU, memory, uptime
 *
 * Walks are bounded (time and entry caps), never follow links or junctions, skip secret locations, and report
 * `partial: true` when a cap was hit so the answer is never presented as exact when it is not.
 */
const fs = require('fs');
const nodePath = require('path');
const os = require('os');

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const SPOKEN = ['bytes', 'kilobytes', 'megabytes', 'gigabytes', 'terabytes', 'petabytes'];

function scale(n) {
  let v = Math.max(0, Number(n) || 0);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return { v, i };
}
function humanBytes(n) {
  const { v, i } = scale(n);
  if (i === 0) return `${Math.round(v)} B`;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}
function spokenBytes(n) {
  const { v, i } = scale(n);
  if (i === 0) return `${Math.round(v)} bytes`;
  const num = v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
  return `${num} ${SPOKEN[i]}`;
}

const CATEGORIES = {
  images: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'tif', 'tiff', 'svg', 'raw', 'ico'],
  videos: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'webm', 'flv', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'csv', 'md', 'epub'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  programs: ['exe', 'msi', 'dll', 'apk', 'appx', 'msix', 'bat', 'cmd'],
  code: ['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'html', 'css', 'json', 'xml', 'sh', 'ps1', 'php', 'rb'],
};
const EXT_TO_CATEGORY = new Map();
for (const [cat, list] of Object.entries(CATEGORIES)) for (const e of list) EXT_TO_CATEGORY.set(e, cat);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createDiskTools({
  access,
  fsImpl = fs,
  pathMod = nodePath,
  osImpl = os,
  now = () => Date.now(),
  platform = process.platform,
  defaultMaxMs = 20000,
  defaultMaxEntries = 400000,
} = {}) {
  const fsp = fsImpl.promises;

  function allowed(p) {
    if (!p || typeof p !== 'string' || !p.trim()) return { ok: false, error: 'Give the folder to look at (a full path, or a name like Downloads).' };
    const c = access.check(p, 'read');
    if (!c.ok) return c;
    return { ok: true, path: c.path };
  }

  // Bounded, link-safe walk. Calls onFile({ full, size, mtime, ext, top }) for files and onDir(full) for folders.
  async function walk(root, { maxMs = defaultMaxMs, maxEntries = defaultMaxEntries, concurrency = 8, onFile, onDir } = {}) {
    const started = now();
    const stats = { entries: 0, skippedLinks: 0, unreadable: 0, skippedSecret: 0, partial: false, reason: '' };
    const stack = [root];
    let active = 0;
    let stop = false;
    const over = () => {
      if (stop) return true;
      if (stats.entries >= maxEntries) { stop = true; stats.partial = true; stats.reason = 'entry limit'; }
      else if (now() - started > maxMs) { stop = true; stats.partial = true; stats.reason = 'time limit'; }
      return stop;
    };

    async function scan(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        stats.unreadable++;
        return;
      }
      const files = [];
      for (const e of entries) {
        if (over()) return;
        stats.entries++;
        const full = pathMod.join(dir, e.name);
        if (e.isSymbolicLink()) { stats.skippedLinks++; continue; }
        if (access.isSecretPath(full)) { stats.skippedSecret++; continue; }
        if (e.isDirectory()) {
          if (onDir) onDir(full);
          stack.push(full);
        } else if (e.isFile()) {
          files.push({ full, name: e.name });
        }
      }
      for (let i = 0; i < files.length; i += 64) {
        if (over()) return;
        const batch = files.slice(i, i + 64);
        const sts = await Promise.all(batch.map((f) => fsp.lstat(f.full).catch(() => null)));
        sts.forEach((st, k) => {
          if (!st) { stats.unreadable++; return; }
          const f = batch[k];
          const dot = f.name.lastIndexOf('.');
          const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : '';
          onFile({ full: f.full, size: st.size, mtime: st.mtimeMs, ext, dir });
        });
      }
    }

    async function worker() {
      while (!stop) {
        const d = stack.pop();
        if (!d) {
          if (active === 0) return;
          await sleep(2);
          continue;
        }
        active++;
        try { await scan(d); } finally { active--; }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    stats.tookMs = now() - started;
    return stats;
  }

  async function preflight(p) {
    const a = allowed(p);
    if (!a.ok) return a;
    try {
      const st = await fsp.stat(a.path);
      if (!st.isDirectory()) return { ok: false, error: 'That is a file, not a folder.' };
    } catch (_) {
      return { ok: false, error: 'That folder does not exist or cannot be opened.' };
    }
    return a;
  }

  function limits(o = {}) {
    return { maxMs: Math.min(60000, Math.max(1000, Number(o.maxMs) || defaultMaxMs)), maxEntries: Math.min(2000000, Math.max(1000, Number(o.maxEntries) || defaultMaxEntries)) };
  }

  const tidy = (stats) => ({ partial: stats.partial, ...(stats.partial ? { stoppedBy: stats.reason } : {}), skippedLinks: stats.skippedLinks, unreadableItems: stats.unreadable, tookMs: stats.tookMs });

  return {
    humanBytes,
    spokenBytes,

    async folderSize(p, opts = {}) {
      const a = await preflight(p);
      if (!a.ok) return a;
      let bytes = 0;
      let files = 0;
      let folders = 0;
      const byChild = new Map();
      const stats = await walk(a.path, {
        ...limits(opts),
        onDir: () => { folders++; },
        onFile: (f) => {
          bytes += f.size;
          files++;
          const rel = pathMod.relative(a.path, f.dir);
          const top = rel ? rel.split(/[\\/]/)[0] : '(files directly in this folder)';
          byChild.set(top, (byChild.get(top) || 0) + f.size);
        },
      });
      const breakdown = Array.from(byChild.entries()).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([name, size]) => ({ name, size: humanBytes(size), bytes: size }));
      return { ok: true, path: a.path, bytes, size: humanBytes(bytes), files, folders, biggestSubfolders: breakdown, ...tidy(stats) };
    },

    async biggestFiles(p, opts = {}) {
      const a = await preflight(p);
      if (!a.ok) return a;
      const count = Math.min(50, Math.max(1, Math.floor(Number(opts.count) || 10)));
      const top = [];
      let seen = 0;
      const stats = await walk(a.path, {
        ...limits(opts),
        onFile: (f) => {
          seen++;
          if (top.length < count || f.size > top[top.length - 1].bytes) {
            top.push({ path: f.full, bytes: f.size, mtime: f.mtime });
            top.sort((x, y) => y.bytes - x.bytes);
            if (top.length > count) top.pop();
          }
        },
      });
      return {
        ok: true,
        path: a.path,
        scannedFiles: seen,
        files: top.map((t) => ({ path: t.path, size: humanBytes(t.bytes), bytes: t.bytes, modified: new Date(t.mtime).toISOString().slice(0, 10) })),
        ...tidy(stats),
      };
    },

    async fileCounts(p, opts = {}) {
      const a = await preflight(p);
      if (!a.ok) return a;
      let files = 0;
      let folders = 0;
      const byCat = {};
      const byExt = new Map();
      const stats = await walk(a.path, {
        ...limits(opts),
        onDir: () => { folders++; },
        onFile: (f) => {
          files++;
          const cat = EXT_TO_CATEGORY.get(f.ext) || 'other';
          byCat[cat] = (byCat[cat] || 0) + 1;
          if (f.ext) byExt.set(f.ext, (byExt.get(f.ext) || 0) + 1);
        },
      });
      const topExtensions = Array.from(byExt.entries()).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([ext, n]) => `.${ext}: ${n}`);
      return { ok: true, path: a.path, files, folders, byType: byCat, topExtensions, ...tidy(stats) };
    },

    // Free and total space. With no path: every drive that answers within a moment.
    async diskSpace(p) {
      const one = async (root) => {
        try {
          const s = await Promise.race([fsp.statfs(root), sleep(1500).then(() => { throw new Error('timeout'); })]);
          const total = s.blocks * s.bsize;
          const free = s.bavail * s.bsize;
          if (!total) return null;
          return { drive: root, total: humanBytes(total), free: humanBytes(free), used: humanBytes(total - free), percentFull: Math.round(((total - free) / total) * 100), freeBytes: free, totalBytes: total };
        } catch (_) {
          return null;
        }
      };
      if (p) {
        const text = String(p).trim();
        const target = pathMod.isAbsolute(text) ? text : (/^[a-z]:?$/i.test(text) ? text[0].toUpperCase() + ':\\' : '');
        if (!target) return { ok: false, error: 'Give a drive such as C: or a full path.' };
        const r = await one(pathMod.parse(pathMod.resolve(target)).root || target);
        return r ? { ok: true, drives: [r] } : { ok: false, error: 'I could not read that drive.' };
      }
      const roots = platform === 'win32'
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map((l) => l + ':\\')
        : ['/'];
      const found = (await Promise.all(roots.map(one))).filter(Boolean);
      return { ok: true, drives: found };
    },

    // Lists the drives for the folder picker (same data, short).
    async listDrives() {
      const r = await this.diskSpace();
      return (r.drives || []).map((d) => ({ root: d.drive, free: d.free, total: d.total }));
    },

    systemInfo() {
      const cpus = osImpl.cpus() || [];
      const total = osImpl.totalmem();
      const free = osImpl.freemem();
      const upH = Math.floor(osImpl.uptime() / 3600);
      return {
        ok: true,
        os: `${osImpl.type()} ${osImpl.release()}`,
        version: typeof osImpl.version === 'function' ? osImpl.version() : '',
        architecture: osImpl.arch(),
        computerName: osImpl.hostname(),
        cpu: cpus[0] ? String(cpus[0].model).replace(/\s+/g, ' ').trim() : 'unknown',
        logicalCores: cpus.length,
        memoryTotal: humanBytes(total),
        memoryFree: humanBytes(free),
        memoryUsedPercent: total ? Math.round(((total - free) / total) * 100) : 0,
        uptime: upH >= 24 ? `${Math.floor(upH / 24)} days ${upH % 24} hours` : `${upH} hours ${Math.floor((osImpl.uptime() % 3600) / 60)} minutes`,
      };
    },
  };
}

module.exports = { createDiskTools, humanBytes, spokenBytes, CATEGORIES };
