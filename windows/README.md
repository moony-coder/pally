# Sidekick for Windows

A tray-resident Windows sidekick: hold a shortcut, talk, and it looks at your screen, answers out loud,
points at the exact control, draws on your desktop, explains with a blueprint-grid card, builds clickable
3D models, and can drive the mouse and keyboard when you approve it.

**Sidekick** is a placeholder product name. Check trademarks before distributing. `brand.json` +
`npm run rename` can rename the product in one command. This is a community Windows port of the
MIT-licensed Mac app [farzaa/clicky](https://github.com/farzaa/clicky), not the official HeyClicky app.
Keep the original [`LICENSE`](./LICENSE) (Copyright (c) 2026 Farza) with the source and with any build.

## Install

**Recommended:** run `Sidekick-Setup-1.0.0.exe` from `dist/`. It is a per-user NSIS installer; no admin
rights are required. It installs to `%LOCALAPPDATA%\Programs\Sidekick`, adds a Start-menu/desktop shortcut,
and starts in the system tray. The installer is unsigned, so Windows SmartScreen may warn.

**If Windows Application Control blocks the installer** (this happened on the build laptop, whose WDAC /
Smart App Control policy rejects newly built unsigned executables), use the portable fallback in
`dist/Sidekick-Portable/`:

1. Run `Sidekick.exe` directly, or
2. run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\Install Sidekick.ps1"` to copy it to
   `%LOCALAPPDATA%\Programs\Sidekick` and create Start-menu/desktop shortcuts (`-NoShortcuts` to skip).

The portable build uses an unmodified copy of the Electron host as `Sidekick.exe`, so it inherits the
host's existing allow-listing on managed PCs. The NSIS installer remains the normal option on machines
without that policy.

Then:

1. Click the tray icon.
2. Choose **Groq** and paste your own Groq key (free at <https://console.groq.com/keys>), or choose
   **Local (Ollama)** and point it at a running Ollama server.
3. Grant the microphone when asked.
4. Press **Start**, then hold **Ctrl+Alt** and talk.

### Local voice (optional, no rate limits)

Home → Settings → **Local voice** → **Download**. It downloads the official sherpa-onnx engine plus
Whisper `base.en` and Kokoro int8 (about 600 MB download, ~400 MB on disk after pruning the unused
sherpa tools and full-size weights) from GitHub release pages, not the rate-limited
GitHub REST API. After it finishes, the app switches speech recognition and speech output to local by
default.

- Local Whisper avoids the Groq speech quota. Groq still has the ~100 voice replies/day and ~8,000
  tokens/minute vision-model limits when used as the backend.
- 8 GB RAM is enough; the models are loaded only while transcribing/speaking.
- Ollama has no `/audio` endpoints, so the local preset forces local Whisper + Kokoro (or the Windows SAPI
  voice fallback).
- If a local model fails, speech falls back: local Kokoro → Groq voice → Windows SAPI. Recognition
  falls back from local Whisper to Groq when a Groq key exists.

### Local AI (Ollama)

Settings → **Local (Ollama)**:

- Models are listed from `GET <root>/api/tags`.
- Vision/tools badges come from `POST <root>/api/show`.
- **Test** checks `GET <root>/v1/models`.
- The OpenAI-compatible client sends `max_tokens` (not Groq's `max_completion_tokens`), never sends
  `reasoning_effort`, and sends a dummy bearer token when no key is set.
- Ollama's default context is small. Start it with `OLLAMA_CONTEXT_LENGTH=8192`
  (on Windows: `setx OLLAMA_CONTEXT_LENGTH 8192`, then restart Ollama) so screenshots and control lists fit.

A real Ollama server was not available in the build sandbox. The preset is **mock-verified only** against
the e2e mock that implements `/api/tags`, `/api/show`, and `/v1/models`.

## Features

| Say / do | What Sidekick does |
| --- | --- |
| Hold **Ctrl+Alt** and talk | Push-to-talk. It sees the screen only for that turn, answers aloud, points at the exact control. |
| "How do I save this?" | Points at the File menu/Save control using Windows UI Automation, with screenshot fallback. |
| "Explain how a cell works" | Draws a dark-glass, blueprint-grid explainer card with flow boxes, numbered steps and notes. |
| "Draw a note here" | Coral marker drawings and dark-glass sticky notes; notes avoid overlapping the explain card. |
| "Show me a plant cell in 3D" | Interactive Three.js model with name labels and clickable fact-note cards. |
| "Open Downloads and find the biggest file" | Background agent: files, web, clipboard, summaries. |
| "Do X for me" | Desktop agent: clicks, types, drags. Risky actions always ask. |
| "Move report.pdf into Archive" | Journaled file move; "undo that" / `undo_move` puts it back. Moves never overwrite. |
| "Read what I selected" | UI Automation TextPattern read; no clipboard copy required. |
| "Switch to the next browser tab / fill this form" | Browser-aware actions for Chrome/Edge/Firefox/Brave/Opera/Vivaldi. Closing a tab always asks. |
| "Launch Figma" | `open_app` first tries the executable, then Start-menu search. Shells/installers/admin tools are refused. |
| "Every weekday at 9 summarize tech news" | Routines managed in Home → Routines. |
| "Hey Sidekick..." (optional) | Always-on wake word with a VAD gate; only speech (never silence) is sent to local Whisper. Off by default. |

The notch HUD shows live multi-step plans, approvals, and a Stop button. Press **Esc** or move the mouse to
stop a desktop task.

## Safety

- **Delete, Send, Pay, Install, Sign out, Alt+F4, Ctrl+W/F4, Ctrl+Enter and closing windows ALWAYS ask**,
  even in auto-approve. The user can only add restrictions; the UI cannot turn this off.
- `src/main/safety.js` is the single source of risk decisions. It also checks the control actually under a
  coordinate click/drag, rejects drops onto Recycle Bin/risky targets, blocks launching shells/installers/admin
  tools, and enforces the access rules.
- Home → Settings → **Access rules** exposes:
  - mode: blocklist or allowlist,
  - blocked windows/apps (safe defaults include password managers),
  - allowed apps (allowlist mode),
  - extra words that always ask.
- PowerShell commands are approved one at a time and can be disabled.
- The local AI backend needs no API key; the Groq backend uses only your own key.

## Develop and test

```
cd windows
npm install
npm start
npm test               # 129 unit tests
npm run test:e2e       # Electron e2e with mock Groq/Ollama (40 checks)
npm run verify:windows # real Windows UIA/DIP/click/window tests + screenshots
npm run dist           # NSIS installer in dist/
```

`npm run verify:windows` uses a throwaway profile and writes `test/windows/out/report.md` plus screenshots.
On a normal desktop it also launches Notepad and Explorer (the automated build session used here isolates
Electron from other apps' windows, so those two checks show SKIP rather than false failures). The UIA,
Unicode TextPattern, click accuracy, DPI mapping, minimize/restore and koffi/Win32 checks still run for real.

The e2e can also run against the packaged app:

```
$env:SIDEKICK_E2E_EXE = (Resolve-Path dist\win-unpacked\Sidekick.exe).Path
npm run test:e2e
```

## Rename the product

Edit `brand.json`, then:

```
npm run rename
```

It updates the product name, slug, app ID, artifact/shortcut names, window/UI/tray text, prompt text, log
name, environment prefix, the user-data folder (through `APP_NAME` in `src/main/main.js`), and the
`sidekick_uia` / `sidekick_win` PowerShell helper namespaces. It deliberately does not touch `NOTICE.md`,
`LICENSE`, `README.md` or the original project links.

Use **Sidekick** only as a placeholder until you have checked trademarks.

## License

MIT. The original Mac project's copyright notice is preserved verbatim in [`LICENSE`](./LICENSE).
Keep that LICENSE file when you publish or redistribute. See [`NOTICE.md`](./NOTICE.md) for attribution,
the visual-design statement, and the trademark note.
