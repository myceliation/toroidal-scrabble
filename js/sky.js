/* =========================================================================
 * sky.js — deep-space backdrop + draggable sun/moon lighting.
 *
 *  - Starfield: twinkling stars behind everything.
 *  - Sun & Moon: draggable celestial bodies (mouse OR touch via Pointer
 *    Events). TAP one to switch daylight/night; DRAG it to move the light
 *    and illuminate the part of the board you want to see.
 * ========================================================================= */

'use strict';

(function () {
  const reduceMotion =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------- starfield ------------------------------ */
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let W, H, stars;
  let starAlpha = 0.55; // brightened at night by setMode()

  function seedStars() {
    // Cap density and skip devicePixelRatio scaling — stars are cheap ambience,
    // not worth 4x pixels on a high-DPI screen.
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    const count = Math.min(220, Math.round((W * H) / 12000));
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() < 0.15 ? 2 : 1, // integer sizes for cheap fillRect
        base: Math.random() * 0.5 + 0.3,
        tw: Math.random() * Math.PI * 2,
        sp: Math.random() * 0.03 + 0.005,
      });
    }
  }
  seedStars();
  window.addEventListener('resize', () => {
    seedStars();
    updateLighting();
  });

  function drawStars(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#eaf1ff';
    for (const s of stars) {
      const tw = reduceMotion ? 1 : 0.6 + 0.4 * Math.sin(s.tw + t * s.sp * 60);
      ctx.globalAlpha = Math.min(1, s.base * tw * starAlpha * 1.6);
      ctx.fillRect(s.x, s.y, s.r, s.r); // fillRect is much cheaper than arc
    }
    ctx.globalAlpha = 1;
  }

  let running = true;
  let lastDraw = 0;
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running && !reduceMotion) requestAnimationFrame(loop);
  });
  function loop(t) {
    // Throttle the twinkle to ~20fps, and pause entirely while the donut is
    // being dragged so all the CPU goes to smooth rotation.
    if (!window.__donutDragging && t - lastDraw > 48) { drawStars(t / 1000); lastDraw = t; }
    if (running && !reduceMotion) requestAnimationFrame(loop);
  }
  if (reduceMotion) drawStars(0);
  else requestAnimationFrame(loop);

  /* --------------------------- sun & moon ------------------------------- */
  const sun = document.getElementById('sun');
  const moon = document.getElementById('moon');
  const stage = document.querySelector('.board-stage');
  let active = sun; // currently-driving light

  // Initial positions (viewport px). Sun upper-right, moon upper-left.
  function place(el, x, y) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
  place(sun, window.innerWidth - 96, 96);
  place(moon, 40, 120);

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function setMode(el) {
    active = el;
    const night = el === moon;
    document.body.setAttribute('data-mode', night ? 'night' : 'day');
    starAlpha = night ? 1 : 0.5;
    sun.classList.toggle('is-active', el === sun);
    moon.classList.toggle('is-active', el === moon);
    if (reduceMotion) drawStars(0);
    updateLighting();
  }

  function updateLighting() {
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    const c = centerOf(active);
    // Flat-view overlay position.
    stage.style.setProperty('--lx', c.x - sr.left + 'px');
    stage.style.setProperty('--ly', c.y - sr.top + 'px');
    // Drive the real 3D torus lighting when the donut view is active.
    const mode = document.body.getAttribute('data-mode') || 'day';
    if (typeof Board3D !== 'undefined' && Board3D.ready()) {
      Board3D.setLight(mode, c.x, c.y);
    }
  }
  window.addEventListener('scroll', updateLighting, { passive: true });

  // Drag handling (mouse + touch) via Pointer Events.
  function makeDraggable(el) {
    let grabX = 0,
      grabY = 0,
      startX = 0,
      startY = 0,
      moved = false;

    el.addEventListener('pointerdown', (e) => {
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      const r = el.getBoundingClientRect();
      grabX = e.clientX - r.left;
      grabY = e.clientY - r.top;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      el.classList.add('grabbing');
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) moved = true;
      const x = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, e.clientX - grabX));
      const y = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, e.clientY - grabY));
      place(el, x, y);
      if (active !== el) setMode(el);
      else updateLighting();
    });

    function end(e) {
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch (_) {}
      el.classList.remove('grabbing');
      if (!moved) setMode(el); // treat as a tap: switch day/night
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // Keyboard: Enter/Space toggles this light's mode.
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setMode(el);
      }
    });
  }
  makeDraggable(sun);
  makeDraggable(moon);

  // Start in daylight with the sun driving the light.
  setMode(sun);
  // Recompute once layout settles (fonts/scrollbars).
  setTimeout(updateLighting, 50);
  // Keep the lit region aligned while the board scrolls internally.
  const frame = document.querySelector('.board-frame');
  if (frame) frame.addEventListener('scroll', updateLighting, { passive: true });

  // Keep both bodies on-screen after a resize / device rotation.
  function clampBody(el) {
    const x = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, el.offsetLeft));
    const y = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, el.offsetTop));
    place(el, x, y);
  }
  window.addEventListener('resize', () => {
    clampBody(sun);
    clampBody(moon);
    updateLighting();
  });
})();
