'use strict';
/*
 * Browser-aware helpers. Everything acts through the same Windows UI Automation + InputController
 * pipeline as the rest of the agent; this module only classifies the browser and its controls.
 */

const BROWSER_PATTERNS = [
  /-\s*google chrome\b/i,
  /-\s*microsoft(\u200b|​)? edge\b/i,
  /-\s*mozilla firefox\b/i,
  /-\s*brave\b/i,
  /-\s*opera\b/i,
  /-\s*vivaldi\b/i,
  /-\s*arc\b/i,
];

const BROWSER_ACTIONS = new Set([
  'list_tabs', 'switch_tab', 'new_tab', 'close_tab', 'address', 'find', 'list_fields', 'fill', 'reload', 'back', 'forward',
]);

function isBrowserTitle(title) {
  const t = String(title || '');
  return BROWSER_PATTERNS.some((re) => re.test(t));
}

function tabsFrom(elements) {
  return (elements || []).filter((e) => e && e.type === 'TabItem' && e.name).map((e) => ({ name: e.name, x: e.x, y: e.y, w: e.w, h: e.h }));
}

function formFieldsFrom(elements) {
  const types = new Set(['Edit', 'ComboBox', 'CheckBox', 'RadioButton']);
  return (elements || [])
    .filter((e) => e && types.has(e.type) && e.name)
    .map((e) => ({ name: e.name, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h }));
}

function safeAddress(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch (_) {
    return null;
  }
}

function normalizeAction(action) {
  return String(action || '').trim().toLowerCase().replace(/\s+/g, '_');
}

module.exports = { isBrowserTitle, tabsFrom, formFieldsFrom, safeAddress, normalizeAction, BROWSER_ACTIONS };
