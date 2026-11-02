'use strict';
/*
 * Rename the product in one command.
 *
 *   1. Edit brand.json with the new name/slug/appId/artifact/shortcut.
 *   2. node scripts/rename.js
 *
 * It reads the CURRENT product name/slug/app id from package.json and replaces them everywhere
 * in source, tests, scripts and packaging metadata. It deliberately does NOT touch NOTICE.md,
 * LICENSE, README.md, brand.json or generated folders, so upstream attribution and links stay
 * intact. The user-data folder follows the product name via APP_NAME in main.js.
 *
 * Run with --dry-run to see the files that would change.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand.json'), 'utf8'));
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const dryRun = process.argv.includes('--dry-run');

if (!brand.name || !brand.slug || !brand.appId) {
  console.error('brand.json needs at least name, slug and appId.');
  process.exit(1);
}

const fromName = pkg.productName || pkg.build && pkg.build.productName || pkg.name;
const fromSlug = String(pkg.name || '').replace(/-windows$/, '');
const fromUpper = fromSlug.toUpperCase();
const fromAppId = (pkg.build && pkg.build.appId) || '';
const toName = brand.name;
const toSlug = brand.slug;
const toUpper = brand.slug.toUpperCase();
const toAppId = brand.appId;

const replacements = [
  [fromAppId, toAppId],
  [fromName, toName],
  [fromSlug, toSlug],
  [fromUpper, toUpper],
].filter(([a, b]) => a && b && a !== b);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.voice-test', 'out', 'release']);
const EXCLUDE_FILES = new Set(['rename.js', 'package-lock.json', 'README.md', 'NOTICE.md', 'LICENSE.md', 'LICENSE', 'brand.json']);
const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.txt', '.ps1']);
const SPECIAL = new Set(['package.json']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(full, out);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase()) && !EXCLUDE_FILES.has(entry.name)) {
      out.push(full);
    }
  }
}

const files = [];
walk(path.join(root, 'src'), files);
walk(path.join(root, 'test'), files);
walk(path.join(root, 'scripts'), files);
walk(path.join(root, 'ci'), files);
const github = path.join(root, '.github');
if (fs.existsSync(github)) walk(github, files);
for (const name of ['package.json', 'package-lock.json']) {
  const f = path.join(root, name);
  if (fs.existsSync(f)) files.push(f);
}

let changed = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  if (rel.startsWith('test' + path.sep + 'windows' + path.sep + 'out') || rel.startsWith('test' + path.sep + 'e2e' + path.sep + 'out')) continue;
  let text = fs.readFileSync(file, 'utf8');
  let next = text;
  for (const [from, to] of replacements) next = next.split(from).join(to);

  if (path.basename(file) === 'package.json') {
    const p = JSON.parse(next);
    p.name = toSlug + '-windows';
    p.productName = toName;
    if (p.build) {
      p.build.appId = toAppId;
      p.build.productName = toName;
      p.build.win = Object.assign({}, p.build.win, { artifactName: brand.artifactName || `${toName}-Setup-\${version}.\${ext}` });
      p.build.nsis = Object.assign({}, p.build.nsis, { shortcutName: brand.shortcutName || toName });
    }
    next = JSON.stringify(p, null, 2) + '\n';
  }
  if (path.basename(file) === 'package-lock.json') {
    try {
      const p = JSON.parse(next);
      p.name = toSlug + '-windows';
      if (p.packages && p.packages['']) p.packages[''].name = toSlug + '-windows';
      next = JSON.stringify(p, null, 2) + '\n';
    } catch (_) { /* leave invalid lock untouched */ }
  }

  if (next !== text) {
    changed++;
    console.log((dryRun ? 'would update ' : 'updated ') + rel);
    if (!dryRun) fs.writeFileSync(file, next);
  }
}

console.log('\n' + (dryRun ? 'Dry run: ' : '') + `renamed ${fromName} -> ${toName} (${fromSlug} -> ${toSlug}) in ${changed} file(s).`);
console.log('brand.json trademark note:', brand.trademarkNote || '(none)');
if (dryRun) console.log('Run without --dry-run to apply.');
