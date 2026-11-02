'use strict';
/*
 * Exact pointing. Asking a vision model for x,y numbers is unreliable, so instead:
 *   1. Windows UI Automation lists the real controls of the foreground window (name + exact rectangle).
 *   2. The model gets a short numbered list and answers [POINT:#12:save button].
 *   3. We resolve #12 to the true rectangle, so the cursor lands on the real center of the control.
 * If the model still answers with x,y, we snap that point to the control it meant (by name or by containment).
 *
 * All rectangles here are global DIP (the same space Electron windows use), top-left origin.
 */

const MAX_LISTED = 70;
const MIN_SIZE = 4;

function rectCenter(r) {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

function area(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function containsPoint(r, p) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function shortType(type) {
  const t = String(type || '').toLowerCase();
  return { menuitem: 'menu item', tabitem: 'tab', listitem: 'list item', treeitem: 'tree item', splitbutton: 'button', combobox: 'dropdown', edit: 'text box', checkbox: 'checkbox', radiobutton: 'radio', hyperlink: 'link' }[t] || t;
}

/**
 * raw: [{ name, type, x, y, w, h }] in physical pixels (UIA output)
 * screenToDip: ({x,y}) => ({x,y})  (Electron screen.screenToDipPoint on Windows)
 * Returns the index used for prompts and resolving: [{ id, name, type, rect }]
 */
function buildElementIndex(raw, screenToDip, { maxListed = MAX_LISTED } = {}) {
  const seen = new Set();
  const out = [];
  for (const e of raw || []) {
    if (!e || !e.name || e.type === 'Document') continue;
    const tl = screenToDip({ x: e.x, y: e.y });
    const br = screenToDip({ x: e.x + e.w, y: e.y + e.h });
    const rect = { x: Math.round(tl.x), y: Math.round(tl.y), width: Math.round(br.x - tl.x), height: Math.round(br.y - tl.y) };
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;
    const key = `${e.name}|${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: String(e.name).replace(/\s+/g, ' ').trim(), type: e.type, rect });
  }
  // reading order: rows of ~24 DIP, then left to right
  out.sort((a, b) => Math.round(a.rect.y / 24) - Math.round(b.rect.y / 24) || a.rect.x - b.rect.x);
  return out.slice(0, maxListed).map((e, i) => Object.assign({ id: i + 1 }, e));
}

function describeIndex(index) {
  return index.map((e) => `#${e.id} ${shortType(e.type)} "${e.name.slice(0, 50)}"`).join('\n');
}

function byId(index, id) {
  return (index || []).find((e) => e.id === Number(id)) || null;
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Best control whose name matches the label the model gave (exact, then starts with, then contains).
function findByLabel(index, label) {
  const q = normalizeName(label);
  if (!q || q.length < 2) return null;
  const named = index.map((e) => ({ e, n: normalizeName(e.name) })).filter((x) => x.n);
  const exact = named.find((x) => x.n === q);
  if (exact) return exact.e;
  const starts = named.find((x) => x.n.startsWith(q) || q.startsWith(x.n));
  if (starts) return starts.e;
  const has = named.filter((x) => x.n.includes(q) || (x.n.length >= 4 && q.includes(x.n)));
  if (has.length) return has.sort((a, b) => area(a.e.rect) - area(b.e.rect))[0].e;
  return null;
}

/**
 * The model gave x,y (already converted to global DIP). Return the control it most likely meant, or null.
 * - a control whose name matches the label AND is reasonably near the point wins
 * - otherwise the smallest control that contains the point
 */
function snapToElement(point, label, index, { maxNameDistance = 420 } = {}) {
  if (!index || !index.length) return null;
  const byName = findByLabel(index, label);
  if (byName) {
    const c = rectCenter(byName.rect);
    if (!point || Math.hypot(c.x - point.x, c.y - point.y) <= maxNameDistance) return byName;
  }
  if (!point) return null;
  const inside = index.filter((e) => containsPoint(e.rect, point) && area(e.rect) < 160000);
  if (inside.length) return inside.sort((a, b) => area(a.rect) - area(b.rect))[0];
  return null;
}

// Where the cursor tip should land on a control: its center, but for wide strips (menus, text lines) a bit in from the left.
function pointForElement(el) {
  const r = el.rect;
  if (r.width > 360 && r.height < 60) return { x: Math.round(r.x + Math.min(r.width / 2, 120)), y: Math.round(r.y + r.height / 2) };
  return rectCenter(r);
}

// [DRAW:kind:#N:label] -> shape in the same format mapDrawToGlobal produces.
function elementDrawToGlobal(draw, index, captures) {
  const el = byId(index, draw.element);
  if (!el) return null;
  const r = el.rect;
  const c = rectCenter(r);
  const cap = (captures || []).find((k) => containsPoint(k.bounds, c)) || (captures || [])[0];
  if (!cap) return null;
  const pad = 5;
  const out = { kind: draw.kind, label: draw.label, points: [], r: 0, bounds: cap.bounds };
  switch (draw.kind) {
    case 'circle':
      out.points = [c];
      out.r = Math.max(14, Math.max(r.width, r.height) * 0.62);
      break;
    case 'underline':
      out.points = [{ x: r.x, y: r.y + r.height + 2 }, { x: r.x + r.width, y: r.y + r.height + 2 }];
      break;
    default: // rect, highlight
      out.points = [{ x: r.x - pad, y: r.y - pad }, { x: r.x + r.width + pad, y: r.y + r.height + pad }];
  }
  return out;
}

// Cheap rule to decide whether the screenshot is needed. Navigating questions ("where is X") can be
// answered from the control list alone, saving about 2,000 tokens of Groq's tight per-minute budget.
const NEEDS_PICTURE = /\b(this|that|these|those|here)\s+(code|image|picture|photo|chart|graph|diagram|page|text|error|screen|paragraph|slide|video|design|result|output|message)\b|\b(read|explain|summar|translate|describe|look at|what('?s| is| does) (on|in|this|that)|why (is|does|did)|fix|debug|review|proofread)\b/i;
const NAVIGATES = /\b(where|find|locate|click|press|tap|open|go to|show me|point|button|menu|icon|tab|toolbar|setting|settings|option|link|search bar|how do i (open|find|get to|turn|enable|disable|change|set))\b/i;

function shouldAttachScreenshot(transcript, elementCount, { enabled = true } = {}) {
  if (!enabled) return true;
  if (elementCount < 8) return true;
  const t = String(transcript || '');
  if (NEEDS_PICTURE.test(t)) return true;
  return !NAVIGATES.test(t);
}

module.exports = {
  buildElementIndex,
  describeIndex,
  byId,
  findByLabel,
  snapToElement,
  pointForElement,
  elementDrawToGlobal,
  shouldAttachScreenshot,
  rectCenter,
  containsPoint,
};
