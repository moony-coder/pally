'use strict';
/*
 * Extra UI Automation scripts that are used by the agent and by the Windows self-check.
 *
 * They follow the same rules as the scripts in uia.js:
 *   - PER-MONITOR DPI v2 (physical pixel rectangles),
 *   - no `exit`, so they can run inside the persistent PowerShell worker,
 *   - every example is exported through allExampleScripts() so test/helpers/collect-scripts.js
 *     parse-checks it with the real PowerShell parser.
 */
const { UIA_PRELUDE } = require('./uia');
const { psQuote } = require('./powershell');

// Finds the target window: by title when given, else the foreground window.
// (Kept local instead of importing uia.js internals so this module stays small.)
const FIND_WINDOW = `
$AE = [System.Windows.Automation.AutomationElement]
$win = $null
if ($winTitle) {
  $kids = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) { if ($k.Current.Name -and $k.Current.Name.ToLower().Contains($winTitle.ToLower())) { $win = $k; break } }
}
if (-not $win) {
  $fg = [sidekick_uia.Native]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) { $win = $AE::FromHandle($fg) }
}
`;

// mode = 'window' (all text) | 'selection' (only the selected text).
// controlName is optional: with it we read one named text box; without it we search the
// window's Document/Edit controls, largest text first (works in Notepad, Word, browsers).
function buildReadTextScript({ windowTitle = '', controlName = '', mode = 'window' } = {}) {
  return `${UIA_PRELUDE}
$winTitle = ${psQuote(windowTitle)}
$controlName = ${psQuote(controlName)}
$mode = ${psQuote(mode)}
${FIND_WINDOW}
function Read-UiaText([System.Windows.Automation.AutomationElement]$el) {
  $p = $null
  if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) { return $null }
  try {
    if ($mode -eq 'selection') {
      $ranges = $p.GetSelection()
      $parts = @()
      foreach ($r in $ranges) { if ($r) { $parts += $r.GetText(-1) } }
      return ($parts -join '')
    }
    return $p.DocumentRange.GetText(-1)
  } catch { return $null }
}
if (-not $win) {
  @{ found = $false; text = ''; error = 'no window' } | ConvertTo-Json -Compress
} elseif ($mode -eq 'selection') {
  $focus = $AE::FocusedElement
  $text = $null
  if ($focus) { $text = Read-UiaText $focus }
  if (-not $text -and $controlName) {
    $hit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $controlName, [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)))
    if ($hit) { $text = Read-UiaText $hit }
  }
  if (-not $text) {
    @{ found = $false; text = ''; error = 'no selection or the focused control does not support TextPattern' } | ConvertTo-Json -Compress
  } else {
    @{ found = $true; text = [string]$text; source = 'selection' } | ConvertTo-Json -Compress
  }
} else {
  $el = $null
  if ($controlName) {
    $el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $controlName, [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)))
  }
  if (-not $el) {
    $types = 'Document','Edit'
    $cond = New-Object System.Windows.Automation.OrCondition(@($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$_ ) }))
    $candidates = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $best = $null; $bestLen = -1; $bestName = ''; $bestType = ''
    $n = 0
    foreach ($c in $candidates) {
      if (++$n -gt 80) { break }
      try {
        $t = Read-UiaText $c
        if ($null -ne $t -and $t.Length -gt $bestLen) { $best = $c; $bestLen = $t.Length; $bestName = $c.Current.Name; $bestType = $c.Current.ControlType.ProgrammaticName.Replace('ControlType.','') }
      } catch {}
    }
    if ($best) { $winText = Read-UiaText $best } else { $winText = $null }
    if ($null -eq $winText) {
      @{ found = $false; text = ''; error = 'no control with TextPattern' } | ConvertTo-Json -Compress
    } else {
      @{ found = $true; text = [string]$winText; source = 'window'; name = $bestName; type = $bestType } | ConvertTo-Json -Compress
    }
  } else {
    $t = Read-UiaText $el
    if ($null -eq $t) {
      @{ found = $false; text = ''; error = 'the control does not support TextPattern' } | ConvertTo-Json -Compress
    } else {
      @{ found = $true; text = [string]$t; source = 'control'; name = $el.Current.Name; type = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','') } | ConvertTo-Json -Compress
    }
  }
}
`;
}

// `text` is the current document text (Notepad adds no newline at the end).
function parseTextResult(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return { found: !!j.found, text: String(j.text || ''), source: j.source || '', name: j.name || '', type: j.type || '', error: j.error || '' };
  } catch (_) {
    /* fall through */
  }
  return { found: false, text: '', source: '', name: '', type: '', error: 'invalid UIA text result' };
}

// What is running: windows with titles (what the user can see) and the heaviest programs by memory.
// No admin rights, no command lines (they can hold secrets), no kill / stop.
function buildRunningAppsScript() {
  return `$ErrorActionPreference = 'SilentlyContinue'
$all = @(Get-Process)
$wins = @($all | Where-Object { $_.MainWindowTitle } | Sort-Object WorkingSet64 -Descending | Select-Object -First 40 | ForEach-Object { @{ app = $_.ProcessName; title = [string]$_.MainWindowTitle; memoryMB = [int][math]::Round($_.WorkingSet64 / 1MB) } })
$top = @($all | Group-Object ProcessName | ForEach-Object { @{ name = $_.Name; count = $_.Count; memoryMB = [int][math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) } } | Sort-Object { $_.memoryMB } -Descending | Select-Object -First 10)
@{ windows = $wins; heaviest = $top; processCount = $all.Count } | ConvertTo-Json -Compress -Depth 4
`;
}

function parseRunningApps(text) {
  try {
    const j = JSON.parse(text);
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    return {
      ok: true,
      windows: arr(j.windows).map((w) => ({ app: String(w.app || ''), title: String(w.title || '').slice(0, 120), memoryMB: Number(w.memoryMB) || 0 })),
      heaviest: arr(j.heaviest).map((w) => ({ name: String(w.name || ''), count: Number(w.count) || 1, memoryMB: Number(w.memoryMB) || 0 })),
      processCount: Number(j.processCount) || 0,
    };
  } catch (_) {
    return { ok: false, error: 'Could not read the process list.' };
  }
}

function allExampleScripts() {
  return [
    { name: 'running-apps', script: buildRunningAppsScript() },
    { name: 'read-text-window', script: buildReadTextScript({ windowTitle: 'Notepad', mode: 'window' }) },
    { name: 'read-text-selection', script: buildReadTextScript({ mode: 'selection' }) },
    { name: 'read-text-control', script: buildReadTextScript({ windowTitle: "Doc's window", controlName: "Type here...", mode: 'window' }) },
  ];
}

module.exports = { buildReadTextScript, parseTextResult, buildRunningAppsScript, parseRunningApps, allExampleScripts };
