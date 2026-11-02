# Part 1 of 3: it runs end to end (DeepSeek + fast commands + natural voice + hands-free)

## How to apply
1. Unzip this over your `windows/` folder (same paths; it replaces the changed files and adds new ones).
2. In `windows/`:  `npm install`   (adds `msedge-tts`, the natural voice)
3. `npm test`  (expect 165 pass, 7 skipped, 0 fail)  then  `npm start`
4. Tray icon -> Home -> Settings -> paste your DeepSeek key (platform.deepseek.com/api_keys) into the key box.
   (The box still says "Groq" until Part 2; it saves your DeepSeek key correctly.)
   Or set the environment variable DEEPSEEK_API_KEY.
5. Settings -> Local voice -> Download (needed once, for Whisper = hearing you).
   If you already had it: press Remove, then Download, to get the correct Kokoro v1.0 backup voice.

## What changed
- DeepSeek `deepseek-flash` replaces Groq: thinking off for speed, 30 s no-answer timeout, clear "out of balance" error.
- Old Groq settings migrate once automatically (Groq key is NOT reused).
- "open X" now uses the Start menu (Store apps, renamed exes, speech slips), not Start-Process guessing.
- Instant commands, no AI: open app/folder/site, volume, mute, media keys, google/youtube search, time, date, show desktop, stop.
- Natural voice: Microsoft Edge neural voices (Ava by default), then Kokoro, then Windows voice.
- Kokoro root cause fixed: your install used Kokoro v1.1 where speaker 3 is a Chinese voice. Now v1.0 is preferred, and v1.1 installs map to an English voice.
- Wake word: fuzzy match ("hey side kick"), on by default, 10 s hands-free follow-up window, echo guard so it never answers its own voice.
- Blue triangle cursor is off by default; it appears only when pointing.

## Not tested here (I had no Windows machine or internet): see the chat message.
