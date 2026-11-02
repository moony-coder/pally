'use strict';
/*
 * Quick commands: things you say that never need an AI.
 *
 *   "open chrome"  "launch spotify"  "open downloads"  "go to youtube"
 *   "volume up"  "mute"  "set volume to 30"  "pause"  "next song"
 *   "google best pizza near me"  "play lofi on youtube"
 *   "what time is it"  "what's the date"  "show desktop"  "stop"
 *
 * They run locally in a few milliseconds and answer with a short spoken confirmation. Anything that is not a
 * clear, short command (questions, long sentences, "open chrome and then search for ...") returns null from
 * parse() or handled:false from execute(), and the normal AI pipeline takes over. Better to hand a command to
 * the AI than to hijack a question.
 */
const { isBlockedApp, normalize } = require('./apps');

const MAX_WORDS = 9;
const MAX_WORDS_DISK = 13;

const QUESTION_START = /^(how|what|why|where|when|who|which|whose|can i|could i|do i|should i|is |are |does |did |explain|tell me|show me|help me|teach)/;

function clean(text) {
  let t = String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[,!?;"]+/g, ' ')
    .replace(/:(?![\\/])/g, ' ') // a colon is punctuation, except in a drive path such as c:\users
    .replace(/\.+(?=\s|$)/g, ' ') // sentence-ending dots go; the dot inside "github.com" stays
    .replace(/\s+/g, ' ')
    .trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^(hey |ok |okay |yo |please |can you |could you |would you |will you |i want you to |i need you to |go ahead and |just )+/, '');
    t = t.replace(/ (please|for me|now|thanks|thank you|right now)$/, '');
  } while (t !== prev);
  return t.trim();
}

// Where the sites are the thing people mean. Checked after an exact installed-app match.
const SITES = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  google: 'https://www.google.com',
  'google maps': 'https://maps.google.com',
  maps: 'https://maps.google.com',
  'google drive': 'https://drive.google.com',
  drive: 'https://drive.google.com',
  'google docs': 'https://docs.google.com',
  'google sheets': 'https://sheets.google.com',
  'google calendar': 'https://calendar.google.com',
  'google translate': 'https://translate.google.com',
  translate: 'https://translate.google.com',
  github: 'https://github.com',
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  deepseek: 'https://chat.deepseek.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  amazon: 'https://www.amazon.com',
  netflix: 'https://www.netflix.com',
  'whatsapp web': 'https://web.whatsapp.com',
  'telegram web': 'https://web.telegram.org',
};
// Used only when no installed app matched.
const FALLBACK_SITES = { whatsapp: SITES['whatsapp web'], telegram: SITES['telegram web'], spotify: 'https://open.spotify.com', discord: 'https://discord.com/app' };

const FOLDERS = {
  downloads: 'shell:Downloads',
  download: 'shell:Downloads',
  documents: 'shell:Personal',
  desktop: 'shell:Desktop',
  pictures: 'shell:My Pictures',
  photos: 'shell:My Pictures',
  videos: 'shell:My Video',
  music: 'shell:My Music',
};
const FOLDER_NEEDS_WORD = new Set(['pictures', 'photos', 'videos', 'music']); // "open music" means the player, not the folder

const DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|org|net|io|ai|app|dev|co|uz|ru|edu|gov|me|tv|info|xyz|uk|de|fr)(\/\S*)?$/;

// "how big is my downloads folder", "biggest files in documents", "how many files are on my desktop",
// "how much space is left on c", "what's running", "my pc specs". Returns an intent or null.
// The folder part is deliberately loose (any short phrase or a full path). resolveFolder() decides later whether it is
// a real place; if it is not, the quick path steps aside and the AI answers instead ("how big is the moon").
const FOLDER_WORD = "(?:the |my |your )?(?:folder |directory )?([a-z]:[\\\\/].*?|[a-z] drive|drive [a-z]|[a-z]:|[\\w .'-]{1,40}?)(?: folder| directory)?";
// phrases the folder pattern can swallow by accident ("how many files do i have", "how big is it")
const NOT_A_FOLDER = /^(it|that|this|these|those|everything|total|all|there|here|pc|my pc|computer|my computer|the disk|disk|drive|space|storage|(do|did|can|could|would|will|have|has|are|is|was|i|we|you|they|in|on|of)( .*)?)$/;

function parsePcQuestion(t, nWords) {
  if (nWords > MAX_WORDS_DISK) return null;
  const re = (s) => new RegExp('^' + s + '$');
  let m;
  const folderOk = (ref) => !!ref && !NOT_A_FOLDER.test(ref.trim());

  if ((m = t.match(re("(?:how (?:big|large)|what(?:'s| is) the (?:total )?size of|what(?:'s| is) the size of|how much (?:space|room|storage) (?:is|does|are) (?:used |taken |being used )?(?:by|in|on|inside)|size of)(?: is| of)? " + FOLDER_WORD))) && folderOk(m[1])) {
    return { kind: 'disk', op: 'size', ref: m[1].trim() };
  }
  if ((m = t.match(re("(?:what(?:'s| is| are) )?(?:the )?(?:(\\d+) )?(?:biggest|largest|heaviest|fattest)(?: (\\d+))?(?: files?| things| items)?(?: are)?(?: in| on| inside| under| from)? " + FOLDER_WORD))) && folderOk(m[3])) {
    return { kind: 'disk', op: 'biggest', ref: m[3].trim(), count: Math.min(25, Number(m[1] || m[2]) || 5) };
  }
  if ((m = t.match(re("(?:what(?:'s| is) )?(?:taking up|using|eating)(?: all)?(?: the)?(?: space| room| storage)(?: in| on| inside)? " + FOLDER_WORD))) && folderOk(m[1])) {
    return { kind: 'disk', op: 'size', ref: m[1].trim() };
  }
  if ((m = t.match(re("how many (?:files?|items|things|documents|photos|pictures)(?: are| do i have| have i got| is there)?(?: there)?(?: in| on| inside| under)? " + FOLDER_WORD))) && folderOk(m[1])) {
    return { kind: 'disk', op: 'count', ref: m[1].trim() };
  }
  // free space on one drive: "how much space is left on c", "free space on d:"
  if ((m = t.match(/^(?:how much (?:free )?(?:space|storage|room)(?: is)?(?: left| free| available)? on|(?:free )?(?:space|storage) (?:left )?on|how full is) (?:my |the )?(?:drive |disk )?([a-z])(?::| drive)?$/))) {
    return { kind: 'disk', op: 'space', ref: m[1] + ':' };
  }
  // free space overall
  if (/^(?:how much )?(?:free |disk |drive |storage |hard drive |hard disk )?(?:space|storage|room)(?: (?:do i have|is|have i got))?(?: left| free| available)?(?: on (?:my |the )?(?:disk|drive|pc|computer|laptop|hard drive))?$/.test(t) ||
      /^how much (?:free )?(?:disk |drive |storage |hard drive )?(?:space|storage) (?:do i have|is there|is left|is free|have i got|is available)(?: left| free)?(?: on (?:my |the )?(?:disk|drive|pc|computer|laptop|hard drive))?$/.test(t) ||
      /^(?:disk|drive|storage) (?:space|usage|status)$/.test(t) || /^(?:is |am i )(?:my )?(?:disk|drive|storage) (?:full|running out)$/.test(t) || /^(?:check|show) (?:my )?(?:disk|drive|storage)(?: space)?$/.test(t)) {
    return { kind: 'disk', op: 'space', ref: '' };
  }
  if (/^(?:what(?:'s| is| are)(?: currently)? (?:running|open)(?: right now| now| on my (?:pc|computer|laptop))?|which (?:apps|programs) are (?:running|open)(?: right now)?|list (?:the )?(?:running|open) (?:apps|programs|windows)|(?:show|list) (?:my )?running (?:apps|programs)|what apps are (?:running|open)|what(?:'s| is) using (?:my )?(?:memory|ram))$/.test(t)) {
    return { kind: 'disk', op: 'running' };
  }
  if (/^(?:what(?:'s| is| are) )?(?:my )?(?:pc|computer|laptop|system|machine) (?:specs|info|information|details|configuration)$/.test(t) ||
      /^(?:show|tell me|give me|check) (?:me )?(?:my |the )?(?:pc|computer|laptop|system)(?: specs| info| information)$/.test(t) ||
      /^how much (?:ram|memory) do i have$/.test(t) || /^what (?:cpu|processor|windows version) do i have$/.test(t) || /^system (?:info|information|specs)$/.test(t)) {
    return { kind: 'disk', op: 'specs' };
  }
  return null;
}

function parse(text) {
  const t = clean(text);
  if (!t) return null;
  const words = t.split(' ');
  if (words.length > MAX_WORDS_DISK) return null;
  if (words.length > MAX_WORDS) {
    const pcq = parsePcQuestion(t, words.length);
    return pcq || null;
  }
  let m;

  // --- no AI needed, answered instantly
  if (/^(stop|cancel|never ?mind|be quiet|quiet|shut up|stop talking|that'?s enough|enough|stop it)$/.test(t)) return { kind: 'stop' };
  if (/^(what'?s the time|what is the time|what time is it( now)?|tell me the time|current time|the time)$/.test(t)) return { kind: 'time' };
  if (/^(what'?s the date|what is the date|what'?s today'?s date|what day is it( today)?|what day is today|what'?s the date today|today'?s date|what is today)$/.test(t)) return { kind: 'date' };

  // Sidekick's own settings window (not Windows Settings).
  if (/^(?:open |show |go to )?(?:your|sidekick'?s?|sidekick) (?:settings|voice settings|api key|key)$/.test(t)) return { kind: 'panel' };

  // --- read-only PC questions, answered locally (no AI): folder size, biggest files, counts, disk space, specs, running apps
  const pcq = parsePcQuestion(t, words.length);
  if (pcq) return pcq;

  if (QUESTION_START.test(t)) return null;

  // --- volume
  const setVol = t.match(/^(?:set|put|make) (?:the )?(?:volume|sound) (?:to|at) (\d{1,3})(?: ?percent| ?%)?$/);
  if (setVol) return { kind: 'volume', op: 'set', percent: Math.max(0, Math.min(100, Number(setVol[1]))) };
  if (/^(unmute|un mute)( the)?( sound| volume| audio)?$/.test(t) || /^mute( the)?( sound| volume| audio| music| it)?$/.test(t) || /^(turn|switch) (the )?(sound|volume|audio) off$/.test(t)) {
    return { kind: 'volume', op: 'mute' };
  }
  const hasVol = /\b(volume|sound|audio)\b/.test(t);
  const amount = /\b(a lot|way|much|max)\b/.test(t) ? 10 : /\b(a bit|a little|slightly)\b/.test(t) ? 2 : 5;
  if ((hasVol && /\b(up|higher|louder|increase|raise)\b/.test(t)) || /^(louder|turn it up|make it louder|speak up|a bit louder)$/.test(t)) return { kind: 'volume', op: 'up', amount };
  if ((hasVol && /\b(down|lower|quieter|softer|decrease|reduce)\b/.test(t)) || /^(quieter|softer|turn it down|make it quieter|a bit quieter|too loud)$/.test(t)) return { kind: 'volume', op: 'down', amount };

  // --- media keys
  if (/^(pause|resume|play|unpause|play pause|play ?\/ ?pause)( the)?( music| song| video| media| playback| track| it)?$/.test(t)) return { kind: 'media', op: 'playpause' };
  if (/^(next|skip)( the| this)?( song| track| one| video)?$/.test(t)) return { kind: 'media', op: 'next' };
  if (/^(previous|prev|go back|back)( song| track| one)?$/.test(t)) return { kind: 'media', op: 'prev' };

  // --- windows
  if (/^(show|go to) (the )?desktop$/.test(t) || /^minimi[sz]e (all|everything)( windows)?$/.test(t) || /^hide (all )?windows$/.test(t)) return { kind: 'desktop' };

  // --- window control & fullscreen
  if (/^(?:max(?:imi[sz]e)?(?: the)? (?:screen|window)|make it (?:max|full ?screen)|max(?:imi[sz]e)?|full ?screen|max the screen)$/.test(t)) {
    return { kind: 'window', op: 'maximize' };
  }
  if (/^(?:exit full ?screen|unfullscreen|leave full ?screen)$/.test(t)) {
    return { kind: 'window', op: 'exit_fullscreen' };
  }
  if (/^(?:minimi[sz]e(?: the)? window|minimi[sz]e(?: the screen)?)$/.test(t)) {
    return { kind: 'window', op: 'minimize' };
  }
  if (/^(?:restore(?: the)? window|unmaximi[sz]e)$/.test(t)) {
    return { kind: 'window', op: 'restore' };
  }

  // --- timers
  if (/^(?:cancel|stop|clear|delete)(?: the)? timer$/.test(t)) return { kind: 'timer', op: 'cancel' };
  if (/^(?:how much time (?:is )?left(?: on the timer)?|timer status|time left)$/.test(t)) return { kind: 'timer', op: 'status' };
  let tm = t.match(/^(?:set |start |make |create )?(?:a )?(?:(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs) )?timer(?: for (\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)?)?$/);
  if (!tm) {
    tm = t.match(/^timer (?:for )?(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)?$/);
  }
  if (tm) {
    const rawNum = tm[1] || tm[3] || '1';
    const rawUnit = tm[2] || tm[4] || 'minute';
    const num = Math.max(1, Number(rawNum) || 1);
    let sec = num * 60;
    if (/^sec/i.test(rawUnit)) sec = num;
    else if (/^hr|hour/i.test(rawUnit)) sec = num * 3600;
    return { kind: 'timer', op: 'set', seconds: sec, raw: `${num} ${rawUnit}` };
  }

  // --- direct typing
  m = t.match(/^(?:type|write) (.+)$/);
  if (m) {
    const val = m[1].trim();
    const isCreative = /^(?:a |an |the |some )?(?:poem|code|essay|story|letter|email|message|script|summary|joke|paragraph|article|routine|function)\b/i.test(val) ||
      /^(?:about|explaining|describing|how to|why)\b/i.test(val);
    if (!isCreative && val.length > 0) {
      let textToType = val;
      if (/^(?:from )?1 to 10$/i.test(val)) {
        textToType = '1 2 3 4 5 6 7 8 9 10';
      }
      return { kind: 'type', text: textToType };
    }
  }

  // --- web
  m = t.match(/^(?:play|watch|search|find) (.+?) on youtube$/) ||
      t.match(/^search youtube for (.+)$/) ||
      t.match(/^(?:open |go to )?(?:the |a )?youtube (?:and |to )?(?:play|watch|search for|search|find) (.+)$/);
  if (m) return { kind: 'url', url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(m[1]), say: 'searching youtube.' };
  m = t.match(/^(?:google|search google for|google search for|search on google for) (.+)$/);
  if (m) return { kind: 'url', url: 'https://www.google.com/search?q=' + encodeURIComponent(m[1]), say: 'searching google.' };

  // --- open / launch
  m = t.match(/^(?:open|launch|start|run|fire up|bring up)(?: up)? (.+)$/);
  const go = !m && t.match(/^go to (.+)$/);
  if (m || go) {
    let target = (m || go)[1].trim().replace(/ dot /g, '.').replace(/\s+/g, ' ');
    if (/^(a |an )?new /.test(target) || /^(this|that|it|them|everything|all)$/.test(target)) return null; // "open a new tab" is not an app
    const compact = target.replace(/^(the |my |a |an )+/i, '');
    const folderWord = /^(?:the |my )?(\w+)(?: folder)?$/.exec(compact);
    if (folderWord && FOLDERS[folderWord[1]] && (!FOLDER_NEEDS_WORD.has(folderWord[1]) || /folder$/.test(compact))) {
      return { kind: 'folder', name: folderWord[1], shell: FOLDERS[folderWord[1]] };
    }
    const dom = compact.replace(/\s+/g, '');
    if (DOMAIN.test(dom)) return { kind: 'url', url: 'https://' + dom, say: 'opening ' + dom + '.' };
    return { kind: 'open', target: compact, webOnly: !!go };
  }
  return null;
}

function psSendKeys(code, times) {
  return `$w = New-Object -ComObject WScript.Shell; 1..${Math.max(1, Math.min(60, times))} | ForEach-Object { $w.SendKeys([char]${code}) }; 'ok'`;
}
const KEY = { up: 175, down: 174, mute: 173, next: 176, prev: 177, playpause: 179 };

function timeSentence(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 || 12;
  return `it's ${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}.`;
}
function dateSentence(d) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  return `it's ${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}.`;
}

/*
 * deps: { apps: AppIndex, tools: {openUrl}, run(ps) -> {stdout}, stop(), now?: () => Date }
 * -> { handled:boolean, say?:string }   handled:false means "let the AI deal with it".
 */
async function execute(intent, deps) {
  const { apps, tools, run, stop } = deps;
  const now = deps.now || (() => new Date());
  switch (intent.kind) {
    case 'stop':
      if (stop) stop();
      return { handled: true, say: '' };
    case 'panel':
      if (deps.openPanel) { deps.openPanel(); return { handled: true, say: 'opening my settings.' }; }
      return { handled: false };
    case 'time':
      return { handled: true, say: timeSentence(now()) };
    case 'date':
      return { handled: true, say: dateSentence(now()) };
    case 'volume': {
      if (intent.op === 'mute') {
        await run(psSendKeys(KEY.mute, 1), { timeoutMs: 8000 });
        return { handled: true, say: 'okay.' };
      }
      if (intent.op === 'set') {
        // each key press moves the volume by 2 percent: go to zero, then climb
        const steps = Math.round(intent.percent / 2);
        await run(psSendKeys(KEY.down, 50), { timeoutMs: 10000 });
        if (steps > 0) await run(psSendKeys(KEY.up, steps), { timeoutMs: 10000 });
        return { handled: true, say: `volume ${intent.percent} percent.` };
      }
      await run(psSendKeys(KEY[intent.op], intent.amount || 5), { timeoutMs: 8000 });
      return { handled: true, say: intent.op === 'up' ? 'louder.' : 'quieter.' };
    }
    case 'media':
      await run(psSendKeys(KEY[intent.op], 1), { timeoutMs: 8000 });
      return { handled: true, say: intent.op === 'playpause' ? 'okay.' : intent.op === 'next' ? 'next.' : 'previous.' };
    case 'desktop':
      await run("(New-Object -ComObject Shell.Application).ToggleDesktop(); 'ok'", { timeoutMs: 8000 });
      return { handled: true, say: 'okay.' };
    case 'folder': {
      await run(`Start-Process -FilePath 'explorer.exe' -ArgumentList '${intent.shell.replace(/'/g, "''")}'; 'ok'`, { timeoutMs: 8000 });
      return { handled: true, say: `opening ${intent.name}.` };
    }
    case 'url': {
      const r = await tools.openUrl(intent.url);
      return r && r.ok ? { handled: true, say: intent.say || 'opening that.' } : { handled: false };
    }
    case 'window': {
      const hwnd = deps.win32 ? deps.win32.getForegroundWindow() : null;
      if (intent.op === 'maximize') {
        if (deps.win32 && hwnd && typeof deps.win32.showWindow === 'function') deps.win32.showWindow(hwnd, 3);
        else if (run) await run(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('% x'); 'ok'`, { timeoutMs: 5000 });
        return { handled: true, say: 'maximizing.' };
      }
      if (intent.op === 'minimize') {
        if (deps.win32 && hwnd && typeof deps.win32.showWindow === 'function') deps.win32.showWindow(hwnd, 6);
        else if (run) await run(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('% n'); 'ok'`, { timeoutMs: 5000 });
        return { handled: true, say: 'minimizing.' };
      }
      if (intent.op === 'restore') {
        if (deps.win32 && hwnd && typeof deps.win32.showWindow === 'function') deps.win32.showWindow(hwnd, 9);
        else if (run) await run(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('% r'); 'ok'`, { timeoutMs: 5000 });
        return { handled: true, say: 'restoring.' };
      }
      if (intent.op === 'fullscreen') {
        if (deps.win32 && typeof deps.win32.pressCombo === 'function') deps.win32.pressCombo('f11');
        else if (run) await run(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('{F11}'); 'ok'`, { timeoutMs: 5000 });
        return { handled: true, say: 'full screen.' };
      }
      if (intent.op === 'exit_fullscreen') {
        if (deps.win32 && typeof deps.win32.pressCombo === 'function') deps.win32.pressCombo('escape');
        else if (run) await run(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('{ESC}'); 'ok'`, { timeoutMs: 5000 });
        return { handled: true, say: 'exiting full screen.' };
      }
      return { handled: false };
    }
    case 'timer': {
      if (deps.timers) {
        if (intent.op === 'set') {
          const res = deps.timers.setTimer(intent.seconds, intent.raw);
          return { handled: true, say: `timer set for ${res.humanDuration}.` };
        }
        if (intent.op === 'cancel') {
          const res = deps.timers.cancelAll();
          return { handled: true, say: res.count ? 'timer cancelled.' : 'no timer was running.' };
        }
        if (intent.op === 'status') {
          const st = deps.timers.getStatus();
          return { handled: true, say: st ? `${st.humanLeft} left.` : 'no timer is running.' };
        }
      }
      return { handled: true, say: `timer set for ${intent.raw || 'one minute'}.` };
    }
    case 'type': {
      if (deps.win32 && typeof deps.win32.typeText === 'function') {
        deps.win32.typeText(intent.text);
      } else if (run) {
        const escaped = intent.text.replace(/([+^%~{}()[\]])/g, '{$1}').replace(/'/g, "''");
        await run(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys('${escaped}'); 'ok'`, { timeoutMs: 5000 });
      }
      return { handled: true, say: 'typed.' };
    }
    case 'disk':
      return diskAnswer(intent, deps);
    case 'open':
      return openTarget(intent, { apps, tools });
    default:
      return { handled: false };
  }
}

const TOOL_FOR_OP = { size: 'folder_size', biggest: 'biggest_files', count: 'file_counts', space: 'disk_space', running: 'running_apps', specs: 'system_info' };

// Answers the read-only PC questions from the local tools. Never opens Explorer, never calls the AI.
async function diskAnswer(intent, deps) {
  const { tools } = deps;
  if (!tools || typeof tools.folderSize !== 'function') return { handled: false };
  const sp = (n) => (tools.disk ? tools.disk.spokenBytes(n) : String(n));
  const log = (ok, extra = {}) => {
    if (deps.activity) deps.activity.add(Object.assign({ source: 'quick', tool: TOOL_FOR_OP[intent.op], args: { path: intent.ref, drive: intent.ref }, ok }, extra));
  };
  const resolveRef = () => {
    const full = tools.resolveFolder ? tools.resolveFolder(intent.ref) : null;
    return full || intent.ref;
  };
  const failure = (r) => {
    log(false, { blocked: !!r.blocked, detail: r.error });
    if (r.blocked) return { handled: true, say: 'i am not allowed to look there. you can allow it in home, under folders.', text: r.error };
    return { handled: true, say: 'i could not open that folder.', text: r.error };
  };
  const partialNote = (r) => (r.partial ? ' (that is a lower bound, the folder is huge and i stopped counting early)' : '');
  switch (intent.op) {
    case 'size': {
      const full = resolveRef();
      if (!/^([a-z]:|[\\/]|~)/i.test(full)) return { handled: false }; // not a folder we can name: let the AI decide
      const r = await tools.folderSize(full);
      if (!r.ok) return failure(r);
      log(true);
      const name = String(intent.ref).replace(/^(the |my )/, '');
      const top = r.biggestSubfolders.filter((b) => b.bytes > 0).slice(0, 3);
      const topText = top.length ? ` the biggest part is ${top[0].name.toLowerCase()}, at ${top[0].size.toLowerCase()}.` : '';
      return {
        handled: true,
        say: `${name} is ${sp(r.bytes)}, with ${r.files} files.${r.partial ? ' at least, i stopped counting early.' : topText}`,
        text: `${r.path}\n${r.size} in ${r.files} files and ${r.folders} folders${partialNote(r)}` + (top.length ? '\nBiggest parts: ' + top.map((b) => `${b.name} (${b.size})`).join(', ') : ''),
      };
    }
    case 'biggest': {
      const full = resolveRef();
      if (!/^([a-z]:|[\\/]|~)/i.test(full)) return { handled: false };
      const r = await tools.biggestFiles(full, { count: intent.count || 5 });
      if (!r.ok) return failure(r);
      log(true);
      if (!r.files.length) return { handled: true, say: 'there are no files in there.', text: r.path };
      const first = r.files[0];
      const nm = first.path.split(/[\\/]/).pop();
      return {
        handled: true,
        say: `the biggest one is ${nm}, at ${sp(first.bytes)}. i listed the rest in your chat.`,
        text: `Biggest files in ${r.path}${partialNote(r)}:\n` + r.files.map((f, i) => `${i + 1}. ${f.path} (${f.size})`).join('\n'),
      };
    }
    case 'count': {
      const full = resolveRef();
      if (!/^([a-z]:|[\\/]|~)/i.test(full)) return { handled: false };
      const r = await tools.fileCounts(full);
      if (!r.ok) return failure(r);
      log(true);
      const kinds = Object.entries(r.byType).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`);
      return {
        handled: true,
        say: `${r.files} files in ${r.folders} folders${kinds.length ? ', mostly ' + kinds.join(', ') : ''}.${r.partial ? ' at least, i stopped counting early.' : ''}`,
        text: `${r.path}\n${r.files} files, ${r.folders} folders${partialNote(r)}\n` + Object.entries(r.byType).map(([k, n]) => `${k}: ${n}`).join(', '),
      };
    }
    case 'space': {
      const drive = intent.ref || '';
      const r = await tools.diskSpace(drive);
      if (!r.ok || !r.drives.length) { log(false, { detail: r.error }); return { handled: true, say: 'i could not read the disk space.', text: r.error || '' }; }
      log(true);
      const d = r.drives;
      const lead = d.find((x) => /^c:/i.test(x.drive)) || d[0];
      const say = d.length === 1 || drive
        ? `${lead.drive.replace(/[\\/]$/, '')} has ${sp(lead.freeBytes)} free out of ${sp(lead.totalBytes)}.`
        : `${lead.drive.replace(/[\\/]$/, '')} has ${sp(lead.freeBytes)} free out of ${sp(lead.totalBytes)}, and you have ${d.length - 1} other drive${d.length > 2 ? 's' : ''}.`;
      return { handled: true, say, text: d.map((x) => `${x.drive}  ${x.free} free of ${x.total} (${x.percentFull}% full)`).join('\n') };
    }
    case 'specs': {
      const r = tools.systemInfo();
      log(true);
      return { handled: true, say: `${r.cpu.replace(/\(R\)|\(TM\)/g, '')}, ${r.memoryTotal.replace(' GB', ' gigabytes')} of memory, ${r.os}.`, text: `${r.os}\n${r.cpu} (${r.logicalCores} threads)\nMemory: ${r.memoryFree} free of ${r.memoryTotal}\nUp for ${r.uptime}` };
    }
    case 'running': {
      const r = await tools.runningApps();
      if (!r.ok) { log(false, { detail: r.error }); return { handled: true, say: 'i could not list the running apps.', text: r.error || '' }; }
      log(true);
      const names = Array.from(new Set(r.windows.map((w) => w.app))).slice(0, 5);
      const heavy = r.heaviest[0];
      return {
        handled: true,
        say: `you have ${r.windows.length} windows open${names.length ? ', like ' + names.join(', ') : ''}.${heavy ? ' the heaviest is ' + heavy.name.toLowerCase() + '.' : ''}`,
        text: 'Open windows:\n' + r.windows.map((w) => `${w.app} - ${w.title} (${w.memoryMB} MB)`).join('\n') + '\n\nUsing the most memory:\n' + r.heaviest.map((h) => `${h.name}${h.count > 1 ? ' x' + h.count : ''}: ${h.memoryMB} MB`).join('\n'),
      };
    }
    default:
      return { handled: false };
  }
}

async function openTarget(intent, { apps, tools }) {
  const target = intent.target;
  const key = normalize(target).replace(/^(the |my |a |an )+/i, '');
  if (isBlockedApp(target)) return { handled: false }; // the AI path explains why it will not do that
  const site = SITES[key];
  const openSite = async (url, name) => {
    const r = await tools.openUrl(url);
    return r && r.ok ? { handled: true, say: `opening ${name}.` } : { handled: false };
  };
  if (intent.webOnly) {
    if (site) return openSite(site, key);
    return { handled: false };
  }
  let hit = null;
  if (apps) {
    try {
      hit = await apps.resolve(target);
    } catch (_) {
      hit = null;
    }
  }
  const exactApp = hit && hit.score >= 98;
  if (!exactApp && site) return openSite(site, key);
  if (hit) {
    const r = await apps.open(target);
    if (r.ok) return { handled: true, say: `opening ${String(r.opened).toLowerCase()}.` };
    if (!r.notFound) return { handled: true, say: `i could not start ${String(hit.app.name).toLowerCase()}.` };
  }
  if (FALLBACK_SITES[key]) return openSite(FALLBACK_SITES[key], key);
  return { handled: false };
}

module.exports = { parsePcQuestion, parse, execute, clean, timeSentence, dateSentence, psSendKeys, SITES, FOLDERS, KEY };
