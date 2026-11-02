'use strict';
/* Collects every PowerShell script the app can generate, so tests can parse-check them all. */
const uia = require('../../src/main/uia');
const { createSystemTools } = require('../../src/main/system-tools');
const { sapiScript } = require('../../src/main/tts');

async function collectAllScripts() {
  const out = [];
  const add = (name, script) => out.push({ name, script });
  add('uia-list', uia.buildListScript(''));
  add('uia-list-title', uia.buildListScript("Notepad - it's here"));
  add('uia-prelude', uia.UIA_PRELUDE);
  for (const action of ['invoke', 'set_value', 'focus']) add('uia-act-' + action, uia.buildActScript({ name: "Save As…", action, value: "it's a value", windowTitle: 'Doc' }));
  add('sapi', sapiScript("It's fine"));
  const grabbed = [];
  const tools = createSystemTools({
    shell: { openExternal: async () => {}, openPath: async () => '' },
    clipboard: { readText: () => '', writeText: () => {} },
    documentsDir: require('os').tmpdir(),
    run: async (script) => { grabbed.push(script); return { code: 0, stdout: 'ok', stderr: '' }; },
    platform: 'win32',
  });
  await tools.openApp('Notepad');
  await tools.listWindows();
  for (const a of ['minimize', 'maximize', 'restore', 'close']) await tools.windowAction(123456, a);
  grabbed.forEach((g, i) => add('system-tools-' + i, g));
  // other modules add their scripts here via optional hooks
  for (const mod of ['../../src/main/ps-scripts']) {
    try { const m = require(mod); if (m.allExampleScripts) m.allExampleScripts().forEach((x) => out.push(x)); } catch (_) { /* module not present */ }
  }
  return out;
}

module.exports = { collectAllScripts };
