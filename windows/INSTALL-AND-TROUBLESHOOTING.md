# Sidekick for Windows: install and troubleshooting

## What you need
- Windows 10 or 11 (64-bit), a microphone, internet.
- Node.js 22 (LTS) from nodejs.org, to run it from source.
- A DeepSeek API key (platform.deepseek.com/api_keys). Thinking is paid by DeepSeek; Microsoft's voice and Whisper hearing are free.

## Install (from source)
1. Put the `windows/` folder somewhere (for example `C:\Sidekick\windows`).
2. In that folder run: `npm install`
3. Run: `npm start`
4. The **Sidekick Settings** window opens when no key is saved. Paste your DeepSeek key and press **Save** (it checks the key first).
5. In the same window, card **Hearing & local voice**: press **Download** once (several hundred MB). This is what lets Sidekick hear you and gives the offline backup voice.
6. Windows asks for microphone access the first time: allow it. If you said no earlier: Windows Settings > Privacy & security > Microphone > allow desktop apps.

Optional installer: `npm run dist` builds `dist\Sidekick-Setup-1.0.0.exe`. Try `npm start` first.

## Using it
- **Hold Ctrl + Alt** (default), talk, let go. Or say **"hey sidekick"** (wake word, on by default).
- After an answer you have a few seconds to keep talking without the wake word (set the length in Settings).
- Instant commands, no AI wait: "open chrome", "open downloads", "go to youtube", "volume up / down / set volume to 30", "mute",
  "pause", "next song", "google ...", "play ... on youtube", "what time is it", "what's the date", "show desktop", "stop".
- Say **"open your settings"** any time to open Sidekick's own settings window.
- Anything else goes to the AI, which can look at your screen, point at things, and (with your approval) click and type.
- The little **eyes** in the corner follow your mouse: wide when listening, looking up when thinking, bouncing when talking.
  Turn them off or move them in Settings > Speed & display. They ignore clicks and never show up in the screenshots Sidekick takes.

## Fixing things
Open **Settings > Trouble? > Show log file** first. It shows what happened and never contains your key.

| Problem | What to do |
|---|---|
| "I need your api key" / "did not accept your api key" | Settings > key card > paste the key again. No extra spaces. Create a new key if needed. |
| "account is out of balance" | Top up your DeepSeek balance; it works again right away. |
| "busy for a moment" / cannot reach DeepSeek | Wait a few seconds / check your internet. A request with no answer gives up after 30 seconds. |
| "I need the local voice installed to hear you" | Settings > Hearing & local voice > Download. Hearing is Whisper, which runs on your PC. |
| It does not hear me | Check the microphone permission (step 6). Check Windows picks the right microphone as default input. |
| Wake word does not trigger | It needs the local voice installed. Say it clearly ("hey sidekick"). Try hearing model **small** (Remove, then Download). Or use Ctrl + Alt. |
| It answers itself or loops | Use headphones, or lower speaker volume. It ignores its own voice, but a loud speaker next to the mic can still leak. |
| Voice sounds robotic or foreign | Settings shows a warning if you have the old Kokoro 1.1: press **Remove**, then **Download**. Also make sure the engine is "Natural voice". |
| Natural voice is silent or falls back | It needs internet and Microsoft's free service. If that is down, the offline voice and then the Windows voice speak instead. Run `npm install` if the log says the package is missing. |
| "open X" opens the wrong thing or nothing | Sidekick reads your Start menu. Say the name as it appears there. If an app you just installed is not found, restart Sidekick. |
| Eyes not visible | Settings > Speed & display > turn the eyes on, pick a corner. They sit above the taskbar, on your main screen. |
| Slow answers | Keep the model mode on fast (default). Short commands are instant; long requests with a screenshot take longer. |
| `npm install` fails | Check Node 22 with `node -v`, and that you are inside the `windows/` folder. |
| Settings window did not appear | Start Sidekick again (it opens the panel), or say "open your settings". |

## Starting over
Remove the local voice and re-download it from Settings. To wipe everything, delete Sidekick's settings file (the folder the log file sits in). That clears your saved settings, including the key.
