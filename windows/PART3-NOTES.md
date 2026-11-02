# Part 3 of 3: eyes in the corner + install and troubleshooting guide

## How to apply (after Parts 1 and 2)
1. Unzip over your `windows/` folder. No new `npm install`.
2. `npm start`. The eyes appear bottom-right after about a second.
3. Settings window > Speed & display: eyes on/off and corner. Settings > Trouble? > Show log file.
4. Read `INSTALL-AND-TROUBLESHOOTING.md`.

## What changed
- New `src/main/eyes.js` and `src/renderer/eyes/*`: a small transparent, click-through, always-on-top window.
  Pupils follow the mouse (only sends updates when the mouse moves), blink at random,
  and change with Sidekick's state (listening / thinking / talking). Hidden from Sidekick's own screenshots.
- main.js, companion.js, settings.js, preload.js, voice-settings.js and the settings window got small hooks for the eyes.
- Eyes never stop the app from starting: if the window cannot be created, it logs and moves on.

## Packaging
`npm run dist` was NOT run (no Windows here). Checked instead: `msedge-tts` installs cleanly (39 small packages, 5 MB), loads, and
has every method Sidekick calls. Your build config lists only `node_modules/msedge-tts/**/*` by hand; electron-builder normally adds a
package's dependencies on its own, but if the built app logs "natural voice needs one more install step", add `"node_modules/**/*"`-style
entries for its dependencies (axios, ws, buffer, isomorphic-ws, stream-browserify and their dependencies) to `build.files`.
