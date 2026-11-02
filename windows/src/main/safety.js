'use strict';
/*
 * One place for "may the agent do this?" decisions.
 *
 *  - Risky controls and key combos ALWAYS ask the user, even in auto-approve mode. The user can only ADD
 *    words to the list (agent.alwaysAsk); nothing here can be turned off by a setting.
 *  - Shells, installers and admin tools are never launched by name (open_app).
 *  - Optional app rules from Settings: a blocklist (never touch these windows) or an allowlist (only these).
 */

// Delete, Send, Pay, Install, Sign out, closing things, plus the usual "cannot be undone" verbs.
// Stems with endings, so "Delete", "Deleting" and "Deleted" all count.
const RISKY_NAME = new RegExp('\\b(' + [
  'delet(e|es|ed|ing)', 'remov(e|es|ed|ing|al)', 'eras(e|es|ed|ing)', 'format (this |the )?(disk|drive|volume|usb|partition)',
  'uninstall(s|ed|ing)?', 'install(s|ed|ing|er)?', 'empty (the )?recycle', 'recycle bin', 'trash',
  'send(s|ing)?', 'submit(s|ted|ting)?', 'post(s|ing)?', 'publish(es|ed|ing)?',
  'pay(s|ing|ment|ments)?', 'buy(s|ing)?', 'purchas(e|es|ed|ing)', 'check ?out', 'place order', 'confirm order',
  'transfer(s|red|ring)?', 'withdraw(s|n|ing|al)?',
  'sign[\\s-]?(out|off)', 'log[\\s-]?(out|off)', 'shut ?down', 'restart(s|ing)?', 'reset(s|ting)?',
  'clear (all|history|data)', 'discard(s|ed|ing)?', 'overwrit(e|es|ing)',
  'clos(e|es|ing)', 'exit(s|ing)?', 'quit(s|ting)?', 'terminat(e|es|ing)', 'end task', 'force quit',
].join('|') + ')\\b', 'i');

const ALIAS = {
  control: 'ctrl', lctrl: 'ctrl', rctrl: 'ctrl', return: 'enter', windows: 'win', super: 'win', meta: 'win', cmd: 'win',
  lwin: 'win', rwin: 'win', menu: 'alt', lalt: 'alt', ralt: 'alt', lshift: 'shift', rshift: 'shift', del: 'delete', esc: 'escape',
};

function comboSets(keys) {
  return String(keys || '')
    .toLowerCase()
    .split(/\s*(?:,|\bthen\b|\s)\s*/)
    .filter(Boolean)
    .map((combo) => new Set(combo.split('+').map((k) => k.trim()).filter(Boolean).map((k) => ALIAS[k] || k)));
}

function isRiskyCombo(set) {
  const has = (k) => set.has(k);
  if (has('delete')) return true; // Delete, Shift+Delete, Ctrl+Alt+Delete ...
  if (has('alt') && has('f4')) return true; // close window / quit app
  if (has('ctrl') && (has('w') || has('f4'))) return true; // close tab / window
  if (has('ctrl') && has('shift') && (has('w') || has('q'))) return true;
  if (has('ctrl') && has('enter')) return true; // "send" in mail and chat apps
  if (has('win') && has('l')) return true; // lock
  return false;
}

function isRiskyName(name, extraWords = []) {
  const n = String(name || '');
  if (RISKY_NAME.test(n)) return true;
  const lower = n.toLowerCase();
  return (extraWords || []).some((w) => w && lower.includes(String(w).toLowerCase()));
}

function isRiskyKeys(keys) {
  return comboSets(keys).some(isRiskyCombo);
}

// Programs the agent must not start by name, whatever the user says: shells, scripting hosts, installers, admin tools.
const BLOCKED_LAUNCH = new Set([
  'cmd', 'powershell', 'pwsh', 'powershell_ise', 'wt', 'windowsterminal', 'terminal', 'windows terminal', 'command prompt',
  'conhost', 'bash', 'wsl', 'regedit', 'reg', 'mshta',
  'wscript', 'cscript', 'msiexec', 'diskpart', 'bcdedit', 'taskkill', 'shutdown', 'schtasks', 'netsh', 'sc', 'net', 'mmc',
  'gpedit', 'secpol', 'eventvwr', 'rundll32', 'regsvr32', 'certutil', 'bitsadmin', 'winget', 'choco', 'scoop',
]);

function isBlockedLaunch(name) {
  const base = String(name || '').trim().toLowerCase().replace(/\.(exe|com|bat|cmd|msc|ps1)$/, '');
  if (BLOCKED_LAUNCH.has(base)) return true;
  return /(^|[\s_-])(setup|installer|install)([\s_-]|$)/.test(base);
}

// --- app rules chosen in Settings -> Agent ("what may it touch") ---
const DEFAULT_BLOCKED_APPS = ['1password', 'bitwarden', 'keepass', 'lastpass', 'dashlane', 'windows security', 'credential manager', 'registry editor'];

function norm(s) {
  return String(s || '').toLowerCase();
}

// info = { title, app }. Returns { allowed, reason }
function checkAccess(rules, info) {
  const r = rules || {};
  const hay = norm((info && info.title) || '') + ' | ' + norm((info && info.app) || '');
  const hit = (list) => (list || []).map(norm).filter(Boolean).find((w) => hay.includes(w));
  const blocked = hit(r.blockedApps);
  if (blocked) return { allowed: false, reason: `You blocked "${blocked}" in the access rules, so I will not touch it.` };
  if (r.accessMode === 'allowlist') {
    const known = (info && (info.title || info.app));
    if (!known) return { allowed: false, reason: 'Allowlist mode is on and I cannot tell which app is in front, so I will not act.' };
    if (!hit(r.allowedApps)) return { allowed: false, reason: `Allowlist mode is on and "${(info.app || info.title).slice(0, 40)}" is not on your allowed list.` };
  }
  return { allowed: true, reason: '' };
}

// --- messaging rule: Sidekick may open a chat app and TYPE a draft, but it always stops before Send ---
// Process names / window titles of chat apps (desktop and web versions). Matched on the app name, or on a title
// that starts or ends with the app name, so "Telegram bot tutorial - Chrome" is not mistaken for a chat window.
const MESSENGERS = 'telegram|whatsapp|messenger|discord|slack|signal|viber|wechat|line|skype|imessage|teams|microsoft teams|element|zalo|kakaotalk|threema';
const MESSENGER_APP = new RegExp('^(' + MESSENGERS + ')(\\.exe|desktop|beta)?$', 'i');
const MESSENGER_TITLE = new RegExp('^(\\(\\d+\\)\\s*|\\[\\d+\\]\\s*)?(' + MESSENGERS + ')( web| desktop)?(\\s*[-|:\\u2013\\u2014]|$)|[-|\\u2013\\u2014]\\s*(' + MESSENGERS + ')( web| desktop)?\\s*$', 'i');

function isMessagingWindow(info) {
  const app = String((info && info.app) || '').trim();
  const title = String((info && info.title) || '').trim();
  if (app && MESSENGER_APP.test(app)) return true;
  return !!title && MESSENGER_TITLE.test(title);
}

// A control whose job is to send. "Send", "Send message", "Send voice message" ... but not "Sender settings" or "Resend".
const SEND_CONTROL = /\b(send(s|ing)?|submit|post|publish)\b(?!\s*(settings|options|as|to list))/i;
function isSendControl(name) {
  return SEND_CONTROL.test(String(name || ''));
}

// Any key combo that would send in a chat box: Enter, Ctrl+Enter, numpad Enter, Alt+Enter.
// Shift+Enter alone is a new line in every mainstream chat app, so it is allowed.
function keysWouldSend(keys) {
  return comboSets(keys).some((set) => {
    const hasEnter = Array.from(set).some((k) => /^(enter|return|numpadenter|numenter)$/.test(k));
    if (!hasEnter) return false;
    const onlyShift = set.has('shift') && !set.has('ctrl') && !set.has('alt') && !set.has('win');
    return !onlyShift;
  });
}

// Typed text that contains a line break presses Enter, which sends the message in a chat box.
function textWouldSend(text) {
  return /[\r\n]/.test(String(text || ''));
}

const MESSAGING_STOP = 'This is a chat app, so I stop before Send. The draft is ready; tell the user to read it and press Send themselves.';

module.exports = { isMessagingWindow, isSendControl, keysWouldSend, textWouldSend, MESSAGING_STOP, MESSENGERS, RISKY_NAME, isRiskyName, isRiskyKeys, comboSets, isBlockedLaunch, BLOCKED_LAUNCH, DEFAULT_BLOCKED_APPS, checkAccess };
