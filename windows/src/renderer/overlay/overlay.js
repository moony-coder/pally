'use strict';
/*
 * Per-display overlay: port of BlueCursorView (OverlayWindow.swift) plus the
 * extended drawing layer, cards, captions and drive-mode chrome.
 * Coordinates arrive in global DIP; everything here is converted to local.
 */
(function () {
  const M = window.SidekickMotion;
  const api = window.sidekick;
  const $ = (id) => document.getElementById(id);
  const tri = $('buddy-triangle');
  const triSvg = tri.querySelector('svg');
  const wave = $('buddy-wave');
  const spinner = $('buddy-spinner');
  const welcomeEl = $('welcome');
  const promptEl = $('prompt');
  const introEl = $('intro-card');
  const navBubble = $('nav-bubble');
  const drawLayer = $('draw-layer');
  const cardsEl = $('cards');
  const captionEl = $('caption');

  const PHRASES = ['right here!', 'this one!', 'over here!', 'click this!', 'here it is!', 'found it!'];

  let bounds = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  let settings = {};
  let voiceState = 'idle';
  let audioLevel = 0;
  let cursorGlobal = { x: 0, y: 0 };
  let onThisScreen = false;
  let mode = 'following'; // following | navigating | pointing
  let returning = false;
  let externalNav = false;
  let cursorOpacity = 0;
  let spring = M.createSpring(0.2, 0.6, { x: 0, y: 0 });
  let pos = { x: 0, y: 0 };
  let rotation = M.RESTING_TRIANGLE_ROTATION_DEGREES;
  let flightScale = 1;
  let navStartMouse = { x: 0, y: 0 };
  let flight = null;
  let showWelcome = false;
  let firstAppearance = false;
  let lastT = performance.now();

  for (let i = 0; i < 5; i++) wave.appendChild(document.createElement('i'));
  const bars = Array.from(wave.children);

  // spinner: 70% arc with angular fade (approximated with a gradient stroke)
  (function buildSpinner() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = spinner.querySelector('svg');
    const defs = document.createElementNS(ns, 'defs');
    defs.innerHTML = '<linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3380FF" stop-opacity="0"/><stop offset="1" stop-color="#3380FF"/></linearGradient>';
    svg.appendChild(defs);
    const r = 5.75;
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', 7); c.setAttribute('cy', 7); c.setAttribute('r', r);
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', 'url(#sg)');
    c.setAttribute('stroke-width', 2.5); c.setAttribute('stroke-linecap', 'round');
    const circ = 2 * Math.PI * r;
    c.setAttribute('stroke-dasharray', `${circ * 0.7} ${circ}`);
    c.setAttribute('transform', `rotate(${0.15 * 360} 7 7)`);
    svg.appendChild(c);
  })();

  const local = (g) => ({ x: g.x - bounds.x, y: g.y - bounds.y });
  const inBounds = (g) => g.x >= bounds.x && g.x < bounds.x + bounds.width && g.y >= bounds.y && g.y < bounds.y + bounds.height;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  function cursorTarget() {
    const l = local(cursorGlobal);
    return { x: l.x + M.BUDDY_FOLLOW_OFFSET.x, y: l.y + M.BUDDY_FOLLOW_OFFSET.y };
  }

  // ------------------------------------------------------------------ frame loop
  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    onThisScreen = inBounds(cursorGlobal);

    if (mode === 'navigating' && returning) {
      const l = local(cursorGlobal);
      if (Math.hypot(l.x - navStartMouse.x, l.y - navStartMouse.y) > 100) cancelNavigation();
    }
    if (mode === 'following') {
      const target = cursorTarget();
      M.stepSpring(spring, target, dt);
      pos = { x: spring.x, y: spring.y };
    } else if (mode === 'navigating' && flight) {
      const elapsed = (now - flight.t0) / 1000;
      const progress = Math.min(1, elapsed / flight.duration);
      const f = M.flightFrame(flight.start, flight.end, progress);
      pos = { x: f.x, y: f.y };
      rotation = f.rotationDegrees;
      flightScale = f.scale;
      if (progress >= 1) {
        const done = flight.onComplete;
        flight = null;
        flightScale = 1;
        done();
      }
    } else {
      // pointing: hold position; keep the spring in sync for the return
      spring.x = pos.x; spring.y = pos.y; spring.vx = 0; spring.vy = 0;
    }

    render(now);
    requestAnimationFrame(frame);
  }

  function buddyVisible() {
    if (mode === 'following') return !externalNav && onThisScreen;
    return true;
  }

  function setOpacity(el, v) {
    const s = String(v);
    if (el.__op !== s) { el.style.opacity = s; el.__op = s; }
  }

  function render(now) {
    const visible = buddyVisible();
    const showTri = visible && (voiceState === 'idle' || voiceState === 'responding');
    const showWave = visible && voiceState === 'listening';
    const showSpin = visible && voiceState === 'processing';
    setOpacity(tri, showTri ? cursorOpacity : 0);
    setOpacity(wave, showWave ? cursorOpacity : 0);
    setOpacity(spinner, showSpin ? cursorOpacity : 0);
    const t = `translate(${pos.x.toFixed(2)}px, ${pos.y.toFixed(2)}px)`;
    tri.style.transform = t;
    wave.style.transform = t;
    spinner.style.transform = t;
    triSvg.style.transition = mode === 'navigating' ? 'none' : 'transform .3s ease-in-out';
    triSvg.style.transform = `rotate(${rotation.toFixed(2)}deg) scale(${flightScale.toFixed(3)})`;
    triSvg.style.filter = `drop-shadow(0 0 ${M.triangleGlowRadius(flightScale).toFixed(1)}px #3380FF)`;

    if (showWave) {
      const h = M.waveformBarHeights(audioLevel, now / 1000);
      for (let i = 0; i < 5; i++) bars[i].style.height = h[i].toFixed(2) + 'px';
    }
    placeBubble(welcomeEl);
    placeBubble(promptEl);
    placeBubble(navBubble);
  }

  function placeBubble(el) {
    if (el.__hidden) return;
    const h = el.offsetHeight || 20;
    const scale = el.__scale == null ? 1 : el.__scale;
    el.style.transform = `translate(${(pos.x + M.BUBBLE_OFFSET.x).toFixed(2)}px, ${(pos.y + M.BUBBLE_OFFSET.y - h / 2).toFixed(2)}px) scale(${scale})`;
  }

  // ------------------------------------------------------------------ navigation
  function startFlight(end, onComplete) {
    const start = { x: pos.x, y: pos.y };
    flight = { start, end, duration: M.flightDurationSeconds(M.distance(start, end)), t0: performance.now(), onComplete };
    mode = 'navigating';
  }

  function startPointing(target, label, customText, rect) {
    if (showWelcome && welcomeEl.textContent) return;
    const l = local(target);
    const end = M.clampNavigationTarget(l, { x: 0, y: 0, width: bounds.width, height: bounds.height });
    navStartMouse = local(cursorGlobal);
    mode = 'navigating';
    returning = false;
    startFlight(end, () => {
      if (mode !== 'navigating') return;
      showTargetBox(rect);
      arriveAtTarget(customText || label);
    });
  }

  async function arriveAtTarget(text) {
    mode = 'pointing';
    rotation = M.RESTING_TRIANGLE_ROTATION_DEGREES;
    const phrase = text || PHRASES[Math.floor(Math.random() * PHRASES.length)];
    navBubble.__hidden = false;
    navBubble.textContent = '';
    navBubble.__scale = 0.5;
    navBubble.style.transition = 'opacity .5s ease-out, box-shadow .4s ease-out';
    navBubble.style.boxShadow = '0 0 22px rgba(51,128,255,1)';
    setOpacity(navBubble, 1);
    for (let i = 0; i < phrase.length; i++) {
      if (mode !== 'pointing') return;
      navBubble.textContent += phrase[i];
      if (i === 0) {
        navBubble.__scale = 1;
        navBubble.style.boxShadow = '0 0 6px rgba(51,128,255,.5)';
      }
      await new Promise((r) => later(r, 30 + Math.random() * 30));
    }
    await new Promise((r) => later(r, 3000));
    if (mode !== 'pointing') return;
    setOpacity(navBubble, 0);
    await new Promise((r) => later(r, 500));
    if (mode !== 'pointing') return;
    flyBack();
  }

  function flyBack() {
    hideTargetBox();
    navStartMouse = local(cursorGlobal);
    mode = 'navigating';
    returning = true;
    startFlight(cursorTarget(), finishNavigation);
  }

  function cancelNavigation() {
    hideTargetBox();
    flight = null;
    navBubble.textContent = '';
    setOpacity(navBubble, 0);
    finishNavigation();
  }

  function finishNavigation() {
    flight = null;
    mode = 'following';
    returning = false;
    rotation = M.RESTING_TRIANGLE_ROTATION_DEGREES;
    flightScale = 1;
    navBubble.textContent = '';
    setOpacity(navBubble, 0);
    navBubble.__scale = 1;
    spring.x = pos.x; spring.y = pos.y; spring.vx = 0; spring.vy = 0;
    api.invoke('overlay:event', { type: 'pointing-done' });
  }

  // ------------------------------------------------------------------ welcome + onboarding
  function streamText(el, message, perCharMs, done) {
    el.__hidden = false;
    el.textContent = '';
    let i = 0;
    const tick = () => {
      if (i >= message.length) { if (done) done(); return; }
      el.textContent += message[i++];
      later(tick, perCharMs);
    };
    tick();
  }

  let introTimer = null;
  function showIntroCard() {
    if (!introEl) return;
    const shortcutEl = $('intro-shortcut');
    if (shortcutEl) {
      const p = String(settings.onboardingPrompt || 'Hold Control + Alt and ask out loud.');
      shortcutEl.textContent = p.charAt(0).toUpperCase() + p.slice(1) + (p.endsWith('.') ? '' : '.');
    }
    introEl.classList.remove('hidden');
    requestAnimationFrame(() => introEl.classList.add('show'));
    clearTimeout(introTimer);
    introTimer = later(hideIntroCard, 7200);
  }
  function hideIntroCard() {
    if (!introEl) return;
    introEl.classList.remove('show');
    later(() => { if (!introEl.classList.contains('show')) introEl.classList.add('hidden'); }, 420);
  }

  function startWelcome() {
    showWelcome = true;
    cursorOpacity = 0;
    tri.style.transition = 'opacity 2s ease-in';
    wave.style.transition = 'opacity 2s ease-in';
    spinner.style.transition = 'opacity 2s ease-in';
    cursorOpacity = 1;
    later(showIntroCard, 500);
    later(() => {
      welcomeEl.style.transition = 'opacity .4s ease-in';
      setOpacity(welcomeEl, 1);
      streamText(welcomeEl, "hey! i'm sidekick", 30, () => {
        later(() => { welcomeEl.style.transition = 'opacity .5s ease-out'; setOpacity(welcomeEl, 0); }, 2000);
        later(() => {
          showWelcome = false;
          welcomeEl.textContent = '';
          welcomeEl.__hidden = true;
          api.invoke('overlay:event', { type: 'welcome-done' });
        }, 2500);
      });
    }, 2000);
    later(() => { tri.style.transition = 'opacity .25s ease-in'; wave.style.transition = 'opacity .15s ease-in'; spinner.style.transition = 'opacity .15s ease-in'; }, 2100);
  }

  // First run: no video. The cursor greets, points at something real on screen, then shows the hint.
  function startOnboardingIntro() {
    if (!onThisScreen) return; // only the screen the cursor is on runs it
    later(() => api.invoke('overlay:event', { type: 'demo' }), 500);
    later(() => {
      api.invoke('overlay:event', { type: 'video-ended' });
      startPromptStream();
    }, 8000);
  }

  function startPromptStream() {
    const message = settings.onboardingPrompt || 'press control + option and introduce yourself';
    promptEl.__hidden = false;
    promptEl.style.transition = 'opacity .4s ease-in';
    setOpacity(promptEl, 0);
    requestAnimationFrame(() => setOpacity(promptEl, 1));
    promptEl.__shown = true;
    streamText(promptEl, message, 30, () => {
      later(() => {
        if (!promptEl.__shown) return;
        dismissPrompt();
      }, 10000);
    });
  }

  function dismissPrompt() {
    if (!promptEl.__shown) return;
    promptEl.__shown = false;
    promptEl.style.transition = 'opacity .3s ease-out';
    setOpacity(promptEl, 0);
    later(() => { promptEl.textContent = ''; promptEl.__hidden = true; }, 350);
  }

  // ------------------------------------------------------------------ drawing
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function strokePair(group, d, dur, delay, cls) {
    const halo = svgEl('path', { d, pathLength: 1, class: 'stroke-halo' + (cls ? ' ' + cls : '') });
    const core = svgEl('path', { d, pathLength: 1, class: 'stroke-core' + (cls ? ' ' + cls : '') });
    [halo, core].forEach((p) => { p.style.setProperty('--dur', dur + 's'); p.style.animationDelay = delay + 's'; });
    group.appendChild(halo);
    group.appendChild(core);
  }

  function smoothPath(points) {
    if (points.length < 3) return `M${points[0].x},${points[0].y} L${points[points.length - 1].x},${points[points.length - 1].y}`;
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
      const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
      d += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }

  function wobblyEllipse(cx, cy, rx, ry, rand) {
    const pts = [];
    const n = 14;
    const start = rand() * Math.PI * 2;
    const over = 1.12; // overshoot so the ends cross like a real marker circle
    for (let i = 0; i <= n; i++) {
      const a = start + (i / n) * Math.PI * 2 * over;
      const k = 1 + (rand() - 0.5) * 0.08 + i * 0.004;
      pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
    }
    return smoothPath(pts);
  }

  function wobblyLine(a, b, rand, wob) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(2, Math.round(len / 90));
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const off = i === 0 || i === n ? 0 : (rand() - 0.5) * wob;
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
    }
    return smoothPath(pts);
  }

  function drawShape(shape, index) {
    if (!shape.bounds || shape.bounds.x !== bounds.x || shape.bounds.y !== bounds.y) return;
    const rand = rng(Math.floor(shape.points[0].x * 7 + shape.points[0].y * 13 + index * 101));
    const pts = shape.points.map(local);
    const delay = index * 0.35;
    const group = svgEl('g', { class: 'shape' });
    drawLayer.appendChild(group);
    let labelAt = null;
    switch (shape.kind) {
      case 'circle': {
        const r = shape.r;
        strokePair(group, wobblyEllipse(pts[0].x, pts[0].y, r * 1.05, r * 0.92, rand), 0.75, delay);
        strokePair(group, wobblyEllipse(pts[0].x, pts[0].y, r * 1.0, r * 0.97, rand), 0.6, delay + 0.5, 'echo');
        labelAt = { x: pts[0].x, y: pts[0].y - r - 10 };
        break;
      }
      case 'rect': {
        const [a, b] = pts;
        const c = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
        let d = wobblyLine(c[0], c[1], rand, 3);
        d += ' ' + wobblyLine(c[1], c[2], rand, 3).replace('M', 'L');
        d += ' ' + wobblyLine(c[2], c[3], rand, 3).replace('M', 'L');
        d += ' ' + wobblyLine(c[3], { x: c[0].x - 2, y: c[0].y + 3 }, rand, 3).replace('M', 'L');
        strokePair(group, d, 0.9, delay);
        labelAt = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 10 };
        break;
      }
      case 'highlight': {
        const [a, b] = pts;
        const r = svgEl('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), rx: 6, class: 'hl' });
        r.style.animationDelay = delay + 's';
        group.appendChild(r);
        labelAt = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 10 };
        break;
      }
      case 'underline': {
        const [a, b] = pts;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 4 };
        strokePair(group, smoothPath([a, mid, { x: b.x, y: b.y + 1 }]), 0.6, delay);
        labelAt = { x: mid.x, y: Math.min(a.y, b.y) - 12 };
        break;
      }
      case 'line': {
        strokePair(group, wobblyLine(pts[0], pts[1], rand, 4), 0.6, delay);
        labelAt = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 - 12 };
        break;
      }
      case 'arrow': {
        const [a, b] = pts;
        strokePair(group, wobblyLine(a, b, rand, 4), 0.6, delay);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const hl = 16;
        const h1 = { x: b.x - Math.cos(ang - 0.45) * hl, y: b.y - Math.sin(ang - 0.45) * hl };
        const h2 = { x: b.x - Math.cos(ang + 0.45) * hl, y: b.y - Math.sin(ang + 0.45) * hl };
        strokePair(group, `M${h1.x},${h1.y} L${b.x},${b.y} L${h2.x},${h2.y}`, 0.3, delay + 0.55);
        labelAt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 14 };
        break;
      }
      case 'path': {
        strokePair(group, smoothPath(pts), Math.min(2.2, 0.5 + pts.length * 0.18), delay);
        labelAt = { x: pts[0].x, y: pts[0].y - 14 };
        break;
      }
      case 'text': {
        const p = document.createElement('div');
        p.className = 'draw-pill';
        p.textContent = shape.label || '';
        p.style.left = pts[0].x + 'px';
        p.style.top = pts[0].y + 'px';
        p.style.animationDelay = delay + 's';
        document.body.appendChild(p);
        scheduleFade([p], 9000 + delay * 1000);
        return;
      }
      case 'note': {
        const n = makeSticky(shape.label || '', pts[0], index);
        n.style.animationDelay = delay + 's';
        document.body.appendChild(n);
        avoidReserved(n);
        scheduleFade([n], 14000 + delay * 1000);
        return;
      }
      case 'step': {
        const b = document.createElement('div');
        b.className = 'draw-badge';
        b.textContent = shape.label || '1';
        b.style.left = pts[0].x + 'px';
        b.style.top = pts[0].y + 'px';
        b.style.animationDelay = delay + 's';
        document.body.appendChild(b);
        scheduleFade([b], 9000 + delay * 1000);
        return;
      }
      default:
        return;
    }
    const extra = [group];
    if (shape.label && labelAt) {
      const pill = document.createElement('div');
      pill.className = 'draw-pill';
      pill.textContent = shape.label;
      pill.style.left = Math.max(60, Math.min(bounds.width - 60, labelAt.x)) + 'px';
      pill.style.top = Math.max(30, labelAt.y) + 'px';
      pill.style.animationDelay = (delay + 0.45) + 's';
      document.body.appendChild(pill);
      extra.push(pill);
    }
    scheduleFade(extra, 9000 + delay * 1000);
  }

  // A short tip pinned to a spot: dark glass card, colored edge, tiny pin on the exact point.
  const NOTE_COLORS = ['#2ee6c5', '#ffc247', '#ff6b9a', '#9b8cff'];
  function makeSticky(text, at, index) {
    const color = NOTE_COLORS[index % NOTE_COLORS.length];
    const tilt = ((index * 37) % 5 - 2) * 0.7;
    const el = document.createElement('div');
    el.className = 'sticky';
    el.style.setProperty('--note', color);
    el.style.setProperty('--tilt', tilt + 'deg');
    el.style.left = Math.max(10, Math.min(bounds.width - 190, at.x - 14)) + 'px';
    el.style.top = Math.max(10, at.y - 54) + 'px';
    const pin = document.createElement('i');
    pin.className = 'pin';
    pin.style.left = Math.min(176, Math.max(0, at.x - parseFloat(el.style.left))) + 'px';
    const t = document.createElement('span');
    t.textContent = text.slice(0, 90);
    el.appendChild(t);
    el.appendChild(pin);
    el.dataset.atx = String(at.x);
    return el;
  }

  // Keep sticky notes out from under the explainer card and the info cards. The pin stays as
  // close to the real point as the note's width allows.
  function avoidReserved(el) {
    const blockers = [explainEl, cardsEl].filter(Boolean).map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!blockers.length) return;
    const m = 12;
    for (let pass = 0; pass < 2; pass++) {
      const r = el.getBoundingClientRect();
      const hit = blockers.find((b) => r.right > b.left - m && r.left < b.right + m && r.bottom + 20 > b.top - m && r.top < b.bottom + m);
      if (!hit) break;
      const left = Math.max(10, hit.left - m - el.offsetWidth);
      el.style.left = left + 'px';
      const pin = el.querySelector('.pin');
      if (pin) pin.style.left = Math.min(172, Math.max(6, Number(el.dataset.atx) - left)) + 'px';
    }
  }

  // Reticle that frames the exact control the cursor landed on.
  let targetBox = null;
  function showTargetBox(rect) {
    hideTargetBox();
    if (!rect) return;
    const l = local({ x: rect.x, y: rect.y });
    const el = document.createElement('div');
    el.className = 'target-box';
    const pad = 5;
    el.style.left = l.x - pad + 'px';
    el.style.top = l.y - pad + 'px';
    el.style.width = Math.max(18, rect.width + pad * 2) + 'px';
    el.style.height = Math.max(18, rect.height + pad * 2) + 'px';
    el.innerHTML = '<b></b><b></b><b></b><b></b>';
    document.body.appendChild(el);
    targetBox = el;
  }
  function hideTargetBox() {
    if (!targetBox) return;
    const el = targetBox;
    targetBox = null;
    el.classList.add('out');
    later(() => el.remove(), 400);
  }

  // ------------------------------------------------------------------ explainer card
  let explainEl = null;
  let explainTimer = null;
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // wobbly rounded box drawn as an SVG stroke that animates in
  function sketchBox(box, seedText, delay) {
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const rand = rng(hashSeed(seedText));
    const j = () => (rand() - 0.5) * 3;
    const d = `M${4 + j()},${6 + j()} L${w - 6 + j()},${3 + j()} L${w - 3 + j()},${h - 5 + j()} L${5 + j()},${h - 3 + j()} Z`;
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'sketch' });
    const p = svgEl('path', { d, pathLength: 1, class: 'sketch-stroke' });
    p.style.animationDelay = delay + 's';
    svg.appendChild(p);
    box.appendChild(svg);
  }
  function sketchArrow(host, delay) {
    const svg = svgEl('svg', { viewBox: '0 0 34 16', width: 34, height: 16, class: 'sketch-arrow' });
    const a = svgEl('path', { d: 'M2,8 C10,6 20,10 30,8', pathLength: 1, class: 'sketch-stroke' });
    const b = svgEl('path', { d: 'M24,2 L31,8 L24,14', pathLength: 1, class: 'sketch-stroke' });
    [a, b].forEach((p, i) => { p.style.animationDelay = (delay + i * 0.18) + 's'; svg.appendChild(p); });
    host.appendChild(svg);
  }

  function showExplain(card) {
    if (!card || !onThisScreen || !card.rows || !card.rows.length) return;
    hideExplain(true);
    const el = document.createElement('div');
    el.id = 'explain-card';
    const title = document.createElement('div');
    title.className = 'ex-title';
    title.textContent = card.title || '';
    el.appendChild(title);
    const pending = [];
    let t = 0.5;
    card.rows.forEach((row, i) => {
      const r = document.createElement('div');
      r.className = 'ex-row ' + row.type;
      r.style.animationDelay = t + 's';
      if (row.type === 'flow') {
        row.nodes.forEach((n, k) => {
          const group = document.createElement('span');
          group.className = 'ex-node';
          const box = document.createElement('span');
          box.className = 'ex-box';
          box.textContent = n;
          box.style.animationDelay = (t + k * 0.35) + 's';
          group.appendChild(box);
          pending.push({ box, text: n + i + k, delay: t + k * 0.35 + 0.1 });
          if (k < row.nodes.length - 1) {
            const ar = document.createElement('span');
            ar.className = 'ex-arrow';
            sketchArrow(ar, t + k * 0.35 + 0.3);
            group.appendChild(ar);
          }
          r.appendChild(group);
        });
        t += row.nodes.length * 0.35 + 0.5;
      } else if (row.type === 'step') {
        r.innerHTML = '<i class="ex-n"></i><span class="ex-t"></span>';
        r.querySelector('.ex-n').textContent = row.n;
        r.querySelector('.ex-t').textContent = row.text;
        t += 0.8;
      } else {
        r.textContent = row.text;
        t += 0.6;
      }
      el.appendChild(r);
    });
    document.body.appendChild(el);
    explainEl = el;
    document.querySelectorAll('.sticky').forEach(avoidReserved);
    // boxes need real sizes before their outline can be sketched
    requestAnimationFrame(() => pending.forEach((p) => sketchBox(p.box, p.text, p.delay)));
    const chars = card.rows.reduce((n, r) => n + (r.text ? r.text.length : r.nodes.join('').length), 0);
    explainTimer = setTimeout(() => hideExplain(false), 22000 + chars * 60);
  }

  function hideExplain(immediate) {
    clearTimeout(explainTimer);
    const el = explainEl;
    explainEl = null;
    if (!el) return;
    if (immediate) { el.remove(); return; }
    el.classList.add('out');
    setTimeout(() => el.remove(), 700);
  }

  function scheduleFade(els, ms) {
    later(() => {
      els.forEach((e) => { e.style.opacity = '0'; });
      later(() => els.forEach((e) => e.remove()), 900);
    }, ms);
  }

  function clearDrawings() {
    drawLayer.innerHTML = '';
    document.querySelectorAll('.draw-pill, .draw-badge, .sticky').forEach((e) => e.remove());
    hideTargetBox();
    hideExplain(false);
  }

  // ------------------------------------------------------------------ cards / caption / drive
  function showCards(cards) {
    cards.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card glass';
      el.style.animationDelay = i * 0.12 + 's';
      const img = c.photoUrl ? `<img alt="" src="${encodeURI(c.photoUrl)}">` : '';
      el.innerHTML = `${img}<div class="cb"><div class="tag">SIDEKICK</div><h4></h4><p></p></div>`;
      el.querySelector('h4').textContent = c.title;
      el.querySelector('p').textContent = c.body || '';
      const im = el.querySelector('img');
      if (im) im.onerror = () => im.remove();
      cardsEl.appendChild(el);
      later(() => { el.classList.add('out'); later(() => el.remove(), 700); }, 15000);
    });
  }

  let captionTimer = null;
  function showCaption(text) {
    if (!settings.captions || !text) return;
    captionEl.textContent = text;
    captionEl.classList.add('show');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => captionEl.classList.remove('show'), 2600 + text.length * 45);
  }

  function setDrive(d) {
    $('drive-edge').classList.toggle('on', !!d.active);
    $('drive-chip').classList.toggle('on', !!d.active);
    if (d.name) $('drive-text').textContent = 'Sidekick is driving: ' + d.name.slice(0, 40);
  }

  // ------------------------------------------------------------------ IPC wiring
  function clearAll() {
    cancelNavigationIfAny();
    clearDrawings();
  }
  function cancelNavigationIfAny() {
    if (mode !== 'following') {
      flight = null;
      navBubble.textContent = '';
      setOpacity(navBubble, 0);
      mode = 'following';
      returning = false;
      rotation = M.RESTING_TRIANGLE_ROTATION_DEGREES;
      flightScale = 1;
      spring.x = pos.x; spring.y = pos.y;
    }
    externalNav = false;
  }

  api.on('overlay:init', (init) => {
    bounds = init.bounds;
    settings = init.settings || {};
    firstAppearance = !!init.firstAppearance;
    cursorGlobal = init.cursor || cursorGlobal;
    voiceState = init.voiceState || 'idle';
    onThisScreen = inBounds(cursorGlobal);
    const t = cursorTarget();
    pos = { x: t.x, y: t.y };
    spring = M.createSpring(0.2, 0.6, pos);
    if (firstAppearance && onThisScreen) startWelcome();
    else cursorOpacity = 1;
  });
  api.on('settings', (s) => { settings = Object.assign({}, settings, s); });
  api.on('cursor', (c) => { cursorGlobal = c; });
  api.on('voice-state', (s) => { voiceState = s; });
  api.on('audio-level', (l) => { audioLevel = l; });
  api.on('overlay:point', (p) => {
    if (inBounds(p.target)) startPointing(p.target, p.label, p.text, p.rect);
    else externalNav = true;
  });
  api.on('overlay:pointing-state', (s) => { if (!s.active) externalNav = false; });
  api.on('overlay:draw', (shapes) => shapes.forEach((s, i) => drawShape(s, i)));
  api.on('overlay:cards', showCards);
  api.on('overlay:explain', showExplain);
  api.on('overlay:caption', (c) => showCaption(c.text));
  api.on('overlay:clear', clearAll);
  api.on('overlay:onboarding', (o) => {
    if (o.action === 'video-start') startOnboardingIntro();
  });
  api.on('overlay:prompt-dismiss', dismissPrompt);
  api.on('drive-state', setDrive);
  api.on('overlay:fade-out', () => {
    document.body.style.transition = 'opacity .4s ease-out';
    document.body.style.opacity = '0';
  });

  requestAnimationFrame(frame);
  api.invoke('overlay:ready');
})();
