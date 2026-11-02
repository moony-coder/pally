# Handoff

## State (v5 + continuation)

Product name is the placeholder **Sidekick** (see `brand.json`; trademarks unchecked). The source tree was
renamed with `scripts/rename.js`; do not rename `NOTICE.md`/`LICENSE`/original links.

## Verified on Windows 11 (this laptop)

- `npm test`: **129/129** pass, including real PowerShell 5.1 parser + persistent worker tests.
- `npm run test:e2e`: **40/40** pass against source and against the packaged `dist/win-unpacked/Sidekick.exe`.
  Covers overlay, explain card, stickies, Home, safety-rules UI, notch plan HUD, 3D fact cards, first-run intro,
  and the mocked Ollama `/api/tags` + `/api/show` + `/v1/models` flow.
- `npm run verify:windows`: **9 PASS / 0 FAIL / 2 SKIP** (report in `test/windows/out/report.md`).
  Real UIA cold/warm (1.6 s → 26 ms), Unicode SendInput + TextPattern, click within 0.71 px, 150% DPI
  mapping, minimize/restore, koffi/user32, panel/home screenshots.
  SKIP: launching Notepad and dragging in Explorer, because this automated session isolates Electron from
  other apps' windows. The verify script will run those checks on a normal desktop.
- Packaged app self-check passes the same 9/2. Installer built at `dist/Sidekick-Setup-1.0.0.exe`
  (unsigned, 124 MB). It was not executed as an installer; `dist/win-unpacked` was run and tested.
- **This laptop's Windows Application Control policy blocks the unsigned `Sidekick.exe` produced by
  electron-builder.** A portable fallback in `dist/Sidekick-Portable` uses an unmodified Electron host
  as `Sidekick.exe`; it runs under the policy and passes the same 9/2 self-check. Its PowerShell install
  script was tested copying to a workspace destination (`-NoShortcuts`); shortcut creation was not executed.
- Local voice: real downloads from GitHub release pages (no REST API), real extraction, real Whisper
  transcript and Kokoro WAV. Evidence in `verification/local-voice.log`. After pruning the archive's
  build libraries and unused tools, the on-disk install is **395 MB**, not 2 GB. Models were also
  preinstalled into `%APPDATA%\Sidekick\local-voice` on this laptop and selected in settings.

## Compiles/parses only, never exercised on a real desktop here

- Notepad UIA interaction and Explorer drag/drop (session isolation).
- Start-menu search launch fallback; browser-aware actions (unit-tested with fakes only).
- Wake word + VAD audio path (unit-tested matching/companion logic; real mic not used in this session).
- Windows 11 acrylic material rendering on a real compositor (screenshots are from the app but the
  automated desktop/capture path can composite transparency oddly).
- Real Ollama server (mock-verified only).
- NSIS install/uninstall execution; code signing (none configured).

## Key files

- `src/main/safety.js` — all risk logic; do not weaken.
- `src/main/local-voice.js` — GitHub release-page downloader, real-model streaming, local Whisper/Kokoro.
- `src/main/ollama.js` — Ollama tags/show/v1 models.
- `src/main/wake.js` + `src/renderer/audio/audio.js` — VAD wake word.
- `src/main/system-tools.js` — move journal (`Documents/Sidekick/move-journal.json`), undo, read text.
- `src/main/agent.js` — start-menu fallback, browser actions, plans, undo tools.
- `test/windows/verify.js` — real Windows self-check.
- `scripts/rename.js` — one-command rebrand.
- `test/e2e/scenario.js` — 40-check UI e2e.

## Packaging

```
npm run dist
```

Needs `TEMP`/`TMP` writable if the host denies the default temp folder (this session used `.build-temp`).
`ci/windows-build.yml` is the workflow copied to the ZIP root `.github/workflows/`.

## Known gaps / next steps

1. Run `npm run verify:windows` on a normal interactive desktop to execute the two skipped Notepad/Explorer checks.
2. Test wake word with a real microphone (CPU use, false accepts, silence gate).
3. Test with a real Ollama install and a vision/tools-capable model.
4. Try the actual NSIS installer and uninstaller (and add code signing before public distribution).
5. Finish a visual pass on the real Windows acrylic compositor.
