'use strict';
/*
 * Headless end-to-end run: starts the mock Groq server, launches the real Electron app under
 * Xvfb with a scenario script, and collects screenshots in test/e2e/out.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const mock = require('./mock-groq');

(async () => {
  const root = path.join(__dirname, '..', '..');
  const out = path.join(__dirname, 'out');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // Keep every Electron cache/user-data write inside the workspace. Some locked-down Windows
  // sessions deny the user's real %TEMP% to Electron's child processes.
  const userData = path.join(out, 'userdata');
  const tmp = path.join(out, 'tmp');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const SAVE = 'sure thing, open the file menu at the top left and hit save. [DRAW:circle:300,250,60:save here] [DRAW:arrow:600,600,330,270:start here] [DRAW:step:300,250:1] [CARD:Saving files|Press ctrl and s in almost any app to save quickly.|floppy disk] [POINT:300,250:file menu:screen1]';
  const EXPLAIN = 'think of it as a tiny factory. [EXPLAIN:How a cell works|sunlight -> chloroplast -> sugar|1. light hits the leaf|2. sugar feeds the cell|note: plants make their own food] [DRAW:note:700,300:Nucleus holds the DNA] [DRAW:note:900,420:Vacuole stores water] [POINT:none]';
  const lastUser = (body) => {
    const m = (body.messages || []).filter((x) => x.role === 'user').pop();
    if (!m) return '';
    return typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(' ');
  };
  const reply = (body) => (/explain/i.test(lastUser(body)) ? EXPLAIN : SAVE);
const { server, port, calls } = await mock.start({ reply });
  const packagedExe = process.env.SIDEKICK_E2E_EXE ? path.resolve(process.env.SIDEKICK_E2E_EXE) : '';
  const electron = packagedExe || require(path.join(root, 'node_modules', 'electron'));
  const env = Object.assign({}, process.env, {
    SIDEKICK_GROQ_BASE_URL: `http://127.0.0.1:${port}`,
    SIDEKICK_USER_DATA: userData,
    SIDEKICK_E2E_OUT: out,
    SIDEKICK_E2E_MIC: '1',
    GROQ_API_KEY: 'gsk_e2e_test_key',
    TEMP: tmp,
    TMP: tmp,
    SIDEKICK_TEST_TMP: tmp,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(packagedExe ? [] : [root]), '--e2e', '--e2e-script=' + path.join(__dirname, 'scenario.js')];
  const useXvfb = !packagedExe && !process.env.DISPLAY && process.platform === 'linux';
  const cmd = useXvfb ? 'xvfb-run' : electron;
  const full = useXvfb ? ['-a', '-s', '-screen 0 1920x1080x24', electron, ...args] : args;
  const child = spawn(cmd, full, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => { log += d; });
  const timer = setTimeout(() => { console.error('E2E timeout'); child.kill('SIGKILL'); }, 150000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    server.close();
    fs.writeFileSync(path.join(out, 'log.txt'), log);
    fs.writeFileSync(path.join(out, 'groq-calls.json'), JSON.stringify(calls, null, 2));
    console.log('e2e exit code', code, '| groq calls:', calls.length);
    process.exit(code || 0);
  });
})();
