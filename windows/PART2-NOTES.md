# Part 2 of 3: Settings window, DeepSeek key card, voice picker, hands-free toggles, faster "do it"

## How to apply (after Part 1 is already in place)
1. Unzip this over your `windows/` folder (same paths).
2. No new `npm install` needed.
3. `npm start`. If no key is saved yet, the new **Sidekick Settings** window opens by itself.
   Any time later: say **"open your settings"** (or "open Sidekick settings"), or start Sidekick again.

## What is in the new Settings window
- **DeepSeek key card**: paste, Save (it checks the key first), "Get a key" link, "Remove saved key". Says "Key saved" / "No key yet".
- **Voice**: engine (natural Microsoft voice / offline Kokoro / Windows voice), a voice picker with a **Play** preview for each.
- **Hearing & local voice**: Download / Remove with a progress bar, hearing-model picker (tiny / base / small),
  and a warning when your install is the old Kokoro 1.1 ("press Remove, then Download").
- **Hands-free**: wake word on/off, wake phrase, "keep listening after an answer" with a 3 to 30 second slider.
- **Speed & display**: instant commands on/off, captions on/off.
- Everything saves as you change it. The window only writes voice / wake / follow-up settings, validated.

## Faster "do it" requests
- A short rule block is added to the end of the AI prompt: act first, at most five words before acting,
  no "should I?" for safe steps, "yes / do it / go ahead" means carry out what was just offered.
- Fast-mode answers are capped at 600 tokens (was 900), so spoken replies end sooner.

## Not changed on purpose
The old Home -> Settings screen (and its "Groq" label) lives in renderer files that were not in the Part 1 zip,
so it is untouched. The new window replaces it for everything above.

## Not tested here: see the chat message.
