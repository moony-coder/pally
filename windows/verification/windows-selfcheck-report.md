# Sidekick Windows self-check

Run: 2026-11-01T07:20:24.923Z  
OS: Windows 10.0.26200 Â· Electron 45.2.1 Â· app 1.0.0  
Displays: 150%

| Result | Check | Detail |
| --- | --- | --- |
| PASS | PowerShell scripts parse with the real powershell.exe parser | 16 scripts parse on PowerShell 5.1.26100.9711 |
| PASS | koffi Win32 layer loaded (real user32) | cursor 1158,634; koffi/user32 active |
| PASS | UIA control list cold vs warm on a real window | 3 controls; cold 2499 ms, warm 29 ms |
| PASS | SendInput types Unicode and TextPattern reads it back | Unicode round-trip (héllo ✓ 日本 —) through a UIA TextPattern script |
| PASS | A real click lands within 2 px of a UIA control | "ClickTarget" -> 398,518 (0.71 px); button handler fired |
| SKIP | Notepad external UIA tests | Notepad/Explorer window activation is blocked in this automated session: Failed to open path |
| PASS | Mouse mapping and UIA rectangles agree through screenToDipPoint | scale 1.5; Electron 420x260 vs UIA 420x260 (dx 0, dy 0) |
| PASS | windowAction minimize and restore change IsIconic | minimized (IsIconic=true) then restored (false) |
| SKIP | Dragging a file onto a folder in Explorer moves it on disk | Explorer is not visible from this automated session (window "drag-mvxi84gx" did not appear (saw: Sidekick DPI probe)); run on a normal desktop |
| PASS | Panel screenshot (acrylic check) | 522x795 (panel.png) |
| PASS | Home screenshot (acrylic check) | 1560x1053 (home.png) |

**9 passed, 0 failed, 2 skipped**

Screenshots: uia-probe.png, dpi-probe.png, panel.png, home.png