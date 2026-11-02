'use strict';
/*
 * Windows UI Automation grounding. Lists clickable controls of the foreground
 * window with exact pixel rectangles, so the agent can click by name instead of
 * guessing coordinates from a screenshot. Uses PowerShell + UIAutomationClient.
 *
 * Scripts are idempotent and never call `exit`, so they run unchanged both as a one-shot process and
 * inside the persistent worker (see powershell.js PsSession).
 */
const { runPowerShell, runPowerShellFast, warmSharedSession, psQuote } = require('./powershell');

// Shared by every script. DPI: PER-MONITOR v2 (context -4), so rectangles are true physical pixels and
// match Electron's screen.screenToDipPoint even with mixed-scale monitors. SetProcessDPIAware alone
// (system-aware) reports virtualized values on a second monitor with a different scale.
const UIA_PRELUDE = `
if (-not ('sidekick_uia.Native' -as [type])) {
  Add-Type -Namespace sidekick_uia -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);' | Out-Null
}
if (-not $global:sidekick_uia_dpi_set) {
  $global:sidekick_uia_dpi_set = $true
  try { if (-not [sidekick_uia.Native]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { [sidekick_uia.Native]::SetProcessDPIAware() | Out-Null } } catch { try { [sidekick_uia.Native]::SetProcessDPIAware() | Out-Null } catch {} }
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
`;

// Picks the window: by title when given, else the foreground window.
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

function buildListScript(windowTitle) {
  return `${UIA_PRELUDE}
$winTitle = ${psQuote(windowTitle || '')}
${FIND_WINDOW}
if (-not $win) { @{ title = ''; elements = @() } | ConvertTo-Json -Compress } else {
$types = 'Button','MenuItem','Hyperlink','TabItem','CheckBox','RadioButton','Edit','ComboBox','ListItem','TreeItem','SplitButton','Document'
$cond = New-Object System.Windows.Automation.OrCondition(@($types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$_ ) }))
# cache the properties we read: one round trip per element instead of one per property
$cr = New-Object System.Windows.Automation.CacheRequest
$cr.Add($AE::NameProperty); $cr.Add($AE::AutomationIdProperty); $cr.Add($AE::BoundingRectangleProperty); $cr.Add($AE::ControlTypeProperty); $cr.Add($AE::IsOffscreenProperty)
$act = $cr.Activate()
try { $els = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) } finally { $act.Dispose() }
$out = @()
$n = 0
foreach ($e in $els) {
  if ($n -ge 150) { break }
  try {
    try { $c = $e.Cached } catch { $c = $e.Current }
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.Width -lt 2 -or $r.Height -lt 2 -or [double]::IsInfinity($r.X)) { continue }
    $name = $c.Name
    if (-not $name) { $name = $c.AutomationId }
    if (-not $name) { continue }
    $out += [pscustomobject]@{ name = $name; type = $c.ControlType.ProgrammaticName.Replace('ControlType.',''); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    $n++
  } catch {}
}
@{ title = $win.Current.Name; elements = $out } | ConvertTo-Json -Depth 4 -Compress
}
`;
}

const LIST_SCRIPT = buildListScript('');

function parseElementsJson(text) {
  try {
    const j = JSON.parse(text);
    let els = j.elements || [];
    if (!Array.isArray(els)) els = [els];
    return { title: j.title || '', elements: els.filter((e) => e && e.name) };
  } catch (_) {
    return { title: '', elements: [] };
  }
}

function findElement(elements, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  const exact = elements.find((e) => e.name.toLowerCase() === q);
  if (exact) return exact;
  const starts = elements.find((e) => e.name.toLowerCase().startsWith(q));
  if (starts) return starts;
  return elements.find((e) => e.name.toLowerCase().includes(q)) || null;
}

async function listForegroundElements(opts, run = runPowerShellFast) {
  if (typeof opts === 'function') { run = opts; opts = undefined; }
  const r = await run(buildListScript(opts && opts.windowTitle), { timeoutMs: 12000, prelude: UIA_PRELUDE });
  return parseElementsJson(r.stdout);
}

// Start the worker before it is needed (the app calls this when you start talking).
function prewarm() { warmSharedSession(UIA_PRELUDE); }

// Compact text for the model. Rects are converted to the model's coordinate space by the caller.
function describeElements(elements, mapRect) {
  return elements
    .slice(0, 80)
    .map((e) => {
      const r = mapRect ? mapRect(e) : { x: e.x, y: e.y, width: e.w, height: e.h };
      return `${e.type}: "${e.name.slice(0, 60)}" at ${r.x + Math.round(r.width / 2)},${r.y + Math.round(r.height / 2)}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Acting on a control by name through UI Automation patterns (no mouse movement, works even when the
// control is partly covered). action: 'find' (look only, never act) | 'invoke' | 'set_value' | 'focus'.
// Result JSON: { found, done, via, name, type, x, y, w, h }  (x,y,w,h physical px; done=false means "found it but
// no pattern worked": the caller can click the rectangle instead).
function buildActScript({ name, action = 'invoke', value = '', windowTitle = '' }) {
  return `${UIA_PRELUDE}
$want = ${psQuote(name)}
$action = ${psQuote(action)}
$value = ${psQuote(value)}
$winTitle = ${psQuote(windowTitle)}
${FIND_WINDOW}
$hit = $null
if ($win) {
  $scope = [System.Windows.Automation.TreeScope]::Descendants
  $exact = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $want, [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
  $hit = $win.FindFirst($scope, $exact)
  if (-not $hit) {
    $all = $win.FindAll($scope, [System.Windows.Automation.Condition]::TrueCondition)
    $n = 0; $best = $null
    foreach ($e in $all) {
      if (++$n -gt 1500) { break }
      try {
        $nm = $e.Current.Name
        if ($nm -and -not $e.Current.IsOffscreen -and $nm.ToLower().Contains($want.ToLower())) {
          if (-not $best -or $nm.Length -lt $best.Current.Name.Length) { $best = $e }
        }
      } catch {}
    }
    $hit = $best
  }
}
if (-not $hit) { @{ found = $false } | ConvertTo-Json -Compress } else {
$r = $hit.Current.BoundingRectangle
$res = @{ found = $true; done = $false; via = ''; name = $hit.Current.Name; type = $hit.Current.ControlType.ProgrammaticName.Replace('ControlType.',''); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
try {
  if ($action -eq 'find') {
    $res.via = 'find'
  } elseif ($action -eq 'set_value') {
    $vp = $null
    if ($hit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.SetValue($value); $res.done = $true; $res.via = 'value' }
  } elseif ($action -eq 'focus') {
    $hit.SetFocus(); $res.done = $true; $res.via = 'focus'
  } else {
    $p = $null
    if ($hit.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $res.done = $true; $res.via = 'invoke' }
    elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); $res.done = $true; $res.via = 'toggle' }
    elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $res.done = $true; $res.via = 'select' }
    elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); $res.done = $true; $res.via = 'expand' }
  }
} catch { $res.error = $_.Exception.Message }
$res | ConvertTo-Json -Compress
}
`;
}

function parseActResult(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : { found: false };
  } catch (_) {
    return { found: false };
  }
}

async function actOnElement(opts, run = runPowerShellFast) {
  const r = await run(buildActScript(opts), { timeoutMs: 15000, prelude: UIA_PRELUDE });
  return parseActResult(r.stdout);
}

const { isRiskyName, isRiskyKeys } = require('./safety');

module.exports = { UIA_PRELUDE, prewarm, listForegroundElements, parseElementsJson, findElement, describeElements, LIST_SCRIPT, buildListScript, buildActScript, parseActResult, actOnElement, isRiskyName, isRiskyKeys };
