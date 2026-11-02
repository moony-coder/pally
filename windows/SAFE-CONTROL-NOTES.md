# Safe control and speed (roadmap Part 1)

This round adds folder permissions you control, read-only PC tools, parallel tool calls, a local fast path,
an activity log with a Home screen, and a hard stop before Send in chat apps.
(The older PART1/2/3-NOTES.md files describe earlier releases and are unrelated to this roadmap numbering.)

## Folder permissions (Home > Folders)
- `src/main/folder-access.js`. Setting `folders`: `null` = default (your user folder, read and change), or a list of `{ path, write }`.
- Each folder is **read only** (list, read, measure) or **read and change** (also move, save). Other drives work: add `D:\` and so on.
- Always off limits, whatever you choose: `.ssh`, `.aws`, `.gnupg`, Windows credential stores, Sidekick's own settings.
  Never changed: Windows, Program Files, ProgramData.
- Paths are resolved through real paths, so a link inside an allowed folder cannot lead out of it.
- Sidekick's own `Documents\Sidekick` output folder is always usable (notes, move journal).
- IPC: `folders:get`, `folders:set` (null resets), `folders:pick`.

## New read-only tools (`src/main/disk-tools.js`)
`folder_size`, `biggest_files`, `file_counts`, `disk_space`, `system_info`, `running_apps`, `allowed_folders`.
- Directory walks are bounded (time and entry caps), skip links and secret folders, and report `partial` when they stop early.
  Answers then say "at least".
- Available even when desktop control is off.

## Parallel tools
`agent.js` runs a run of read-only tools from one model turn together (up to 4 at a time). Results go back in the order the
model asked. Anything that acts on the PC (mouse, keys, files) runs alone and in order.

## Local fast path
`quick-commands.parsePcQuestion` + `diskAnswer`: "how big is my Downloads folder", "biggest 10 files in Documents",
"how many files in Pictures", "how much space is left on C", "what's running", "my PC specs" are answered locally, with no AI call.
The short answer is spoken; the detail goes to the Home chat. If the folder is not a real place ("how big is the moon"),
or the path is not allowed, it says so (and points to Home > Folders) or hands the question to the AI.

## Activity log (Home > Activity)
- `src/main/activity-log.js`, file `activity.jsonl` in the app data folder, capped at 1500 lines (trimmed to 1000).
- Every agent tool call, quick command and settings change adds a line: what, which source (agent, quick, user), ok, blocked.
- Typed, pasted and filled text is never stored, only its length.
- Filters: Everything, Changes, Blocked, Looked only. Live updates through `activity:new`. IPC: `activity:list`, `activity:clear`, `activity:open`.

## Messaging rule
In Telegram, WhatsApp, Discord, Slack, Messenger, Signal (app or browser tab) Sidekick may open the app, find the person and type or
paste a draft, but it stops before Send. This is a hard block, not a question, so even auto-approve cannot send:
Enter, Ctrl+Enter, Alt+Enter, a line break inside typed text, and clicking or invoking a control named Send / Submit / Post.
Shift+Enter and `paste_text` are allowed. See `safety.js` (`isMessagingWindow`, `keysWouldSend`, `textWouldSend`, `isSendControl`).

## Tests
`folder-access`, `disk-tools`, `activity-log`, `pc-questions` (parser, diskAnswer, messaging helpers, running-apps parser),
`agent-part1` (parallel execution, ordering, limits, activity log, messaging guards) and a read-only `move_file` test in `file-moves`.
Run: `node --test "test/unit/*.test.js"`. Last run here: 248 tests, 241 pass, 0 fail, 7 skipped (Windows-only).

## Not verified here
This sandbox is Linux: Electron and the Windows UI could not be launched, so the new Home screens were only syntax-checked
and the PowerShell scripts parse-checked. Try Home > Folders and Home > Activity on a Windows PC.

## Next (roadmap)
Part 2: Ctrl+Alt+drag drawing the AI can see, spotlight and guided tours. Part 3: Dynamic-Island notch, Apple-style motion,
taskbar gray fix. Part 4: sleepy eyes, 3D viewer redesign, drawing lessons.
