'use strict';
(function () {
  const sk = window.sidekick;
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EYES = [
    { cx: 48, pupil: $('pupilL'), glint: $('glintL'), top: $('lidTopL'), bot: $('lidBotL') },
    { cx: 102, pupil: $('pupilR'), glint: $('glintR'), top: $('lidTopR'), bot: $('lidBotR') },
  ];
  const CY = 46;
  const RX = 27;
  const RY = 34;

  let state = 'idle';
  let look = { x: 0, y: 0 };
  const cur = { x: 0, y: 0, r: 12, blink: 0, squint: 0, raise: 0, bob: 0 };
  let blinkUntil = 0;
  let nextBlink = performance.now() + 2500;

  const PARAMS = {
    idle: { r: 12, squint: 0, raise: 0 },
    listening: { r: 15, squint: 0, raise: 0.12 },
    processing: { r: 9, squint: 0.1, raise: 0 },
    responding: { r: 12, squint: 0.3, raise: 0 },
  };

  function scheduleBlink(now) {
    blinkUntil = now + 140;
    // now and then a quick double blink
    nextBlink = now + (Math.random() < 0.2 ? 380 : 2500 + Math.random() * 3500);
  }

  function frame(now) {
    const p = PARAMS[state] || PARAMS.idle;
    // where the pupils want to look
    let tx = look.x;
    let ty = look.y;
    if (state === 'processing' && !reduce) {
      tx = Math.sin(now / 700) * 0.7;
      ty = -0.55 + Math.sin(now / 1100) * 0.15; // up and wandering: "thinking"
    }
    cur.x += (tx - cur.x) * 0.25;
    cur.y += (ty - cur.y) * 0.25;
    cur.r += (p.r - cur.r) * 0.2;
    cur.squint += (p.squint - cur.squint) * 0.2;
    cur.raise += (p.raise - cur.raise) * 0.2;

    if (now >= nextBlink) scheduleBlink(now);
    const blinkTarget = now < blinkUntil ? 1 : 0;
    cur.blink += (blinkTarget - cur.blink) * 0.6;

    const bob = state === 'responding' && !reduce ? Math.sin(now / 130) * 1.8 : 0;
    $('bob').setAttribute('transform', 'translate(0 ' + bob.toFixed(2) + ')');

    const maxX = RX - cur.r - 4;
    const maxY = RY - cur.r - 4;
    for (const e of EYES) {
      const px = e.cx + cur.x * maxX;
      const py = CY + cur.y * maxY;
      e.pupil.setAttribute('cx', px.toFixed(2));
      e.pupil.setAttribute('cy', py.toFixed(2));
      e.pupil.setAttribute('r', cur.r.toFixed(2));
      e.glint.setAttribute('cx', (px - cur.r * 0.35).toFixed(2));
      e.glint.setAttribute('cy', (py - cur.r * 0.4).toFixed(2));
      // upper lid: blink closes it fully; "raise" opens the eye wider (lid goes up out of view)
      const topH = Math.max(0, cur.blink * 2 * RY * 0.5 + cur.squint * 14 - cur.raise * 10);
      const botH = cur.blink * RY * 0.5 + cur.squint * 22;
      e.top.setAttribute('y', (CY - RY - 4).toFixed(2));
      e.top.setAttribute('height', (topH + 0.01).toFixed(2));
      e.bot.setAttribute('y', (CY + RY + 4 - botH).toFixed(2));
      e.bot.setAttribute('height', (botH + 0.01).toFixed(2));
      // a closed lid has no height but would still draw its outline: hide it
      e.top.setAttribute('visibility', topH > 0.6 ? 'visible' : 'hidden');
      e.bot.setAttribute('visibility', botH > 0.6 ? 'visible' : 'hidden');
    }
    requestAnimationFrame(frame);
  }

  try {
    sk.on('eyes:look', (v) => { if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) look = v; });
    sk.on('eyes:state', (s) => { if (PARAMS[s]) state = s; });
  } catch (_) { /* no bridge: eyes just look straight ahead */ }
  requestAnimationFrame(frame);
})();
