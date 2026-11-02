# Verification evidence

Collected on the Windows 11 build laptop, 2026-11-01. The app was launched from source, the packaged
`Sidekick.exe`, and the portable Electron-host build. All three loaded the same `app.asar` code.

- `unit-tests.txt` — `npm test`: **129 passed, 0 failed**.
- `e2e-results.json` / `e2e-log.txt` — `npm run test:e2e` against the portable final build:
  **40/40 passed**. Covers overlay/explain/stickies, Home, access-rules UI, notch plans, 3D fact cards,
  first-run intro, and mocked Ollama `/api/tags`, `/api/show`, `/v1/models`.
- `windows-selfcheck-report.md` / `.json` — real Windows self-check: **9 passed, 0 failed, 2 skipped**.
  - PASS: PowerShell script parsing, koffi/user32, UIA cold/warm, Unicode SendInput + TextPattern,
    click within 0.71 px, 150% DPI mapping, IsIconic minimize/restore, panel/home captures.
  - SKIP: Notepad launch/UIA and Explorer drag, because the automated session isolates Electron from
    other applications' windows. These checks remain in `test/windows/verify.js` for a normal desktop.
- `local-voice.log` — real sherpa-onnx release-page downloads (engine, Whisper base.en, Kokoro int8),
  extraction, a real Whisper transcript (1.8 s) and a real Kokoro WAV (8.8 s).
- `local-voice-prune.txt` — after removing build libraries and unused tools, local voice shrank from
  1991 MB to 395 MB and still transcribed/synthesized.
- `screenshots/` — selected app, 3D, notch, intro, Ollama settings, access rules and self-check captures.

A later opportunistic run found Notepad and launched it successfully; click timing passed but Unicode
characters injected into Notepad came back garbled, and a subsequent run hit a GPU `UnknownVizError`.
Because the desktop was in active use, this is recorded as **not verified** rather than a pass: cross-app
notepad typing remains a test to repeat on a quiet physical desktop.

Not verified here: real microphone wake-word/VAD behavior, real Ollama server, real Notepad/Explorer
automation, NSIS install/uninstall execution, code signing. The NSIS installer is built but unsigned;
this laptop's Application Control policy blocks electron-builder's unsigned executable, which is why the
portable fallback exists and was tested.

