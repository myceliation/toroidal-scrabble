/* =========================================================================
 * board3d.js — the board as a freely-rotatable 3D torus, rendered in a plain
 * 2D canvas (NO WebGL), so it works in every browser including Firefox.
 *
 *  - Free trackball rotation via an accumulated 3x3 matrix (no Euler clamp, so
 *    you can tumble it right over and see the underside).
 *  - Mapping: the board's centre column (the ★ start) sits on the OUTER
 *    equator; the column seam falls on the INNER hole. A "tube roll" offset
 *    lets you roll the surface from outside to inside.
 *  - Geometry (corners/normals) is precomputed; each frame only multiplies by
 *    the rotation matrix. Interaction renders are rAF-batched; labels/borders
 *    are skipped while dragging. ~sub-ms per frame.
 * ========================================================================= */

'use strict';

const Board3D = (function () {
  const R = 2.05;
  const TUBE = 0.95;
  const CAMZ = 6.2;
  const TAU = Math.PI * 2;
  const VPHASE = Math.PI; // puts centre column on the outer equator, seam inside
  // Möbius: width = π·radius makes each cell square (board is 30 long × 15 wide,
  // so a square-celled strip is half as wide as it is long → a "fat" band).
  const MR = 1.5, MWIDTH = Math.PI * MR;

  let container, canvas, ctx;
  let cssW = 300, cssH = 300, cx = 150, cy = 150, baseScale = 60, baseFit = 60, zoom = 1;
  let M = mul(rotY(0.2), rotX(-0.5)); // orientation matrix (initial tilt)
  let tubeRoll = 0;
  let tileFont = '"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Mono", ui-monospace, "DejaVu Sans Mono", "Roboto Mono", Menlo, monospace'; // customizable tile lettering (default: monospace)
  function setFont(f) { if (f) { tileFont = f; if (inited) render(); } }
  let shape = 'torus', cullBack = true;
  let inited = false, dragging = false, hoverCell = null;
  let panX = 0, panY = 0, panMode = false; // "Move" mode drags the donut around
  let baseQuads = [];
  let lastQuads = [];

  let lightDir = norm([0.35, 0.5, 0.85]);
  let ambient = 0.62, intensity = 0.8, fill = 0.3, cool = 0;

  const PREM_FILL = { TW: '#d64550', DW: '#e88fb0', TL: '#2f7fd6', DL: '#7fc0e8', ST: '#f2c14e' };
  const EMPTY_FILL = '#243252';

  function ready() { return inited; }

  /* ------------------------------ math --------------------------------- */
  function norm(v) { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; }
  function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
  function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  function mul(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  }
  function torusPoint(u, v) {
    const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    return [(R + TUBE * cv) * cu, (R + TUBE * cv) * su, TUBE * sv];
  }
  function mobiusPoint(uFrac, vFrac) {
    const t = uFrac * TAU;             // long looping axis (rows)
    const s = (vFrac - 0.5) * MWIDTH;  // across the strip (cols)
    const h = t / 2;                   // half-twist
    const rad = MR + s * Math.cos(h);
    return [rad * Math.cos(t), rad * Math.sin(t), s * Math.sin(h)];
  }
  function cornersFor(i, j) {
    if (shape === 'mobius') {
      // "Roll" a Möbius strip = advance the tiles along the loop; because of the
      // half-twist, tiles travel from one face around to the other, so the
      // inner/underside comes outward.
      const roll = tubeRoll / TAU;
      return [
        mobiusPoint(i / ROWS + roll, j / COLS),
        mobiusPoint((i + 1) / ROWS + roll, j / COLS),
        mobiusPoint((i + 1) / ROWS + roll, (j + 1) / COLS),
        mobiusPoint(i / ROWS + roll, (j + 1) / COLS),
      ];
    }
    const u0 = (i / ROWS) * TAU, u1 = ((i + 1) / ROWS) * TAU;
    const v0 = VPHASE + tubeRoll + (j / COLS) * TAU;
    const v1 = VPHASE + tubeRoll + ((j + 1) / COLS) * TAU;
    return [torusPoint(u0, v0), torusPoint(u1, v0), torusPoint(u1, v1), torusPoint(u0, v1)];
  }
  function normalOf(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return norm([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
  }
  function project(p) {
    const persp = CAMZ / (CAMZ - p[2]);
    return [cx + panX + p[0] * persp * baseScale, cy + panY - p[1] * persp * baseScale, p[2]];
  }
  function buildBaseQuads() {
    baseQuads = [];
    for (let i = 0; i < ROWS; i++)
      for (let j = 0; j < COLS; j++)
        baseQuads.push({ i, j, c: cornersFor(i, j) });
  }

  /* ------------------------------ setup -------------------------------- */
  function init() {
    if (inited) return true;
    container = document.getElementById('board3d');
    if (!container) return false;
    try {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab;';
      container.appendChild(canvas);
      ctx = canvas.getContext('2d');
      if (!ctx) return false;
      buildBaseQuads();
      bindEvents();
      resize();
      setTimeout(resize, 120);
      inited = true;
      render();
      return true;
    } catch (e) {
      console.error('Board3D (canvas) init failed:', e);
      return false;
    }
  }

  function resize() {
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    cssW = Math.max(200, rect.width);
    cssH = Math.max(200, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25); // cap for fill speed
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Centre the donut in the OPEN area (right of the sidebar) at default zoom
    // so nothing blocks it; zooming still lets it fill the whole screen.
    let left = 0;
    const sb = document.querySelector('.sidebar');
    if (sb && window.innerWidth > 820) {
      const sr = sb.getBoundingClientRect();
      if (sr.width && sr.right < cssW * 0.6) left = sr.right + 16;
    }
    const openW = cssW - left;
    cx = left + openW / 2;
    cy = cssH / 2;
    baseFit = Math.min(openW, cssH) * 0.13;
    baseScale = baseFit * zoom;
    if (inited) render();
  }
  window.addEventListener('resize', resize);

  /* --------------------------- render ---------------------------------- */
  let rafPending = false;
  function markDirty() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }
  function redraw() { if (inited) render(); }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = ((n >> 16) & 255) * f, g = ((n >> 8) & 255) * f, b = (n & 255) * f;
    if (cool) { r *= 0.8; g *= 0.9; b = Math.min(255, b * 1.05 + 10); }
    return 'rgb(' + Math.min(255, r | 0) + ',' + Math.min(255, g | 0) + ',' + Math.min(255, b | 0) + ')';
  }

  function render() {
    if (!inited) return;
    ctx.clearRect(0, 0, cssW, cssH);
    const m = M;
    const rot = (p) => [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
      m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
      m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
    ];
    const quads = [];
    for (const bq of baseQuads) {
      const q0 = rot(bq.c[0]), q1 = rot(bq.c[1]), q2 = rot(bq.c[2]), q3 = rot(bq.c[3]);
      const rn = normalOf(q0, q1, q3);
      if (cullBack && rn[2] <= 0.03) continue; // torus: hide back faces
      const s0 = project(q0), s1 = project(q1), s2 = project(q2), s3 = project(q3);
      const dot = rn[0] * lightDir[0] + rn[1] * lightDir[1] + rn[2] * lightDir[2];
      // torus lights one side (+ fill for the inner ring); the Möbius is
      // one-sided so it's shaded two-sided (abs).
      const s = cullBack ? Math.max(0, dot) + fill * Math.max(0, -dot) : Math.abs(dot);
      quads.push({ i: bq.i, j: bq.j, s: [s0, s1, s2, s3],
        lit: Math.min(1.4, ambient + intensity * s),
        depth: (s0[2] + s1[2] + s2[2] + s3[2]) / 4 });
    }
    quads.sort((a, b) => a.depth - b.depth);
    lastQuads = quads;
    for (const q of quads) drawQuad(q);
  }

  function drawQuad(q) {
    const r = q.i, c = q.j, s = q.s;
    const prem = PREMIUM[r][c];
    const committed = state.board ? state.board[r][c] : null;
    const pend = state.pending ? state.pending.get(keyOf(r, c)) : null;
    const tile = pend || committed;
    const badPend = pend && state.pendingInvalid;
    const base = tile
      ? (pend ? (badPend ? '#e0554d' : '#ffe6a8') : '#f0e0bd')
      : (PREM_FILL[prem] || EMPTY_FILL);

    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    ctx.lineTo(s[1][0], s[1][1]);
    ctx.lineTo(s[2][0], s[2][1]);
    ctx.lineTo(s[3][0], s[3][1]);
    ctx.closePath();
    ctx.fillStyle = shade(base, q.lit);
    ctx.fill();

    if (pend) { ctx.strokeStyle = badPend ? '#ff3b30' : '#ffcf4d'; ctx.lineWidth = 2.2; ctx.stroke(); }
    else if (hoverCell && hoverCell.r === r && hoverCell.c === c && !committed) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2; ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    const mx = (s[0][0] + s[1][0] + s[2][0] + s[3][0]) / 4;
    const my = (s[0][1] + s[1][1] + s[2][1] + s[3][1]) / 4;
    const size = Math.hypot(s[2][0] - s[0][0], s[2][1] - s[0][1]) * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (tile) {
      ctx.fillStyle = '#3a2b12';
      ctx.font = 'bold ' + Math.max(8, size * 0.6) + 'px ' + tileFont;
      ctx.fillText(tile.letter === '_' ? '' : tile.letter, mx - size * 0.08, my - size * 0.05);
      // small point value, like a real tile
      const val = tile.blank ? 0 : LETTER_VALUES[tile.letter] || 0;
      ctx.font = 'bold ' + Math.max(6, size * 0.3) + 'px ' + tileFont;
      ctx.fillText(String(val), mx + size * 0.5, my + size * 0.5);
    } else if (prem) {
      ctx.fillStyle = prem === 'ST' ? '#5a3d00' : 'rgba(255,255,255,0.92)';
      ctx.font = 'bold ' + Math.max(6, size * 0.4) + 'px system-ui, sans-serif';
      ctx.fillText(prem === 'ST' ? '★' : prem, mx, my);
    }
  }

  // Arrow from (x,y) toward (dx,dy), fixed length, with a small label.
  /* ------------------------------ picking ------------------------------ */
  function pointInQuad(px, py, s) {
    let inside = false;
    for (let a = 0, b = 3; a < 4; b = a++) {
      const xa = s[a][0], ya = s[a][1], xb = s[b][0], yb = s[b][1];
      if ((ya > py) !== (yb > py) && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) inside = !inside;
    }
    return inside;
  }
  function pickCell(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    let hit = null;
    for (const q of lastQuads) if (pointInQuad(px, py, q.s)) hit = q;
    return hit ? { r: hit.i, c: hit.j } : null;
  }

  // Is (x,y) over a UI panel/menu? (rect-based, since panels are pointer-none)
  function overMenu(x, y) {
    const els = document.querySelectorAll(
      '.panel, .flat-view[open], .site-header, .roll-controls, .board-toolbar, .modal:not(.hidden)'
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  /* ------------------------------ events ------------------------------- */
  function setZoom(z) {
    zoom = Math.max(0.4, Math.min(6, z));
    baseScale = baseFit * zoom;
  }
  function bindEvents() {
    // Track every active pointer so two fingers = pinch-to-zoom (+ two-finger
    // pan). One finger keeps the trackball rotate / tap-to-place behaviour.
    const pointers = new Map(); // pointerId -> {x,y}
    let downX = 0, downY = 0, lastX = 0, lastY = 0, moved = false;
    let pinching = false, pinchDist = 0, pinchMidX = 0, pinchMidY = 0, pinchAng = 0;
    const metrics = () => {
      const p = [...pointers.values()];
      const dx = p[0].x - p[1].x, dy = p[0].y - p[1].y;
      return { dist: Math.hypot(dx, dy) || 1, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2, ang: Math.atan2(dy, dx) };
    };
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downX = lastX = e.clientX;
      downY = lastY = e.clientY;
      moved = false;
      canvas.style.cursor = 'grabbing';
      if (pointers.size === 2) {
        const m = metrics();
        pinching = true; pinchDist = m.dist; pinchMidX = m.mx; pinchMidY = m.my; pinchAng = m.ang;
        moved = true; dragging = false; // a two-finger gesture is never a tap
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Two fingers: pinch to zoom, slide the midpoint to pan, and twist
      // (one finger up, one down) to roll/rotate the donut — like a photo app.
      if (pinching && pointers.size >= 2) {
        const m = metrics();
        setZoom(zoom * (m.dist / pinchDist));
        panX += m.mx - pinchMidX;
        panY += m.my - pinchMidY;
        let dA = m.ang - pinchAng;
        if (dA > Math.PI) dA -= TAU; else if (dA < -Math.PI) dA += TAU;
        M = mul(rotZ(dA), M);
        pinchDist = m.dist; pinchMidX = m.mx; pinchMidY = m.my; pinchAng = m.ang;
        window.__donutDragging = true;
        markDirty();
        return;
      }
      if (e.buttons) {
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
        if (moved) {
          dragging = true;
          window.__donutDragging = true; // lets the starfield pause while dragging
          if (panMode) {
            // Move mode: slide the donut around its background layer.
            panX += e.clientX - lastX;
            panY += e.clientY - lastY;
          } else {
            // Trackball: free rotation about the screen axes.
            const inc = mul(rotY((e.clientX - lastX) * 0.01), rotX((e.clientY - lastY) * 0.01));
            M = mul(inc, M);
          }
          lastX = e.clientX;
          lastY = e.clientY;
          markDirty();
        }
      } else {
        const cell = pickCell(e.clientX, e.clientY);
        const changed = (cell && (!hoverCell || hoverCell.r !== cell.r || hoverCell.c !== cell.c)) ||
          (!cell && hoverCell);
        if (changed) { hoverCell = cell; markDirty(); }
      }
    });
    function up(e) {
      try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      pointers.delete(e.pointerId);
      canvas.style.cursor = 'grab';
      // Coming out of a pinch: re-anchor the remaining finger so rotation
      // doesn't jump, and never treat the lift as a tap.
      if (pinching) {
        if (pointers.size < 2) pinching = false;
        if (pointers.size === 1) {
          const p = [...pointers.values()][0];
          downX = lastX = p.x; downY = lastY = p.y; moved = true;
        }
        window.__donutDragging = pointers.size > 0;
        if (dragging) { dragging = false; render(); }
        return;
      }
      window.__donutDragging = false;
      const wasClick = !moved;
      if (dragging) { dragging = false; render(); }
      if (wasClick) {
        const cell = pickCell(e.clientX, e.clientY);
        if (cell) cellAction(cell.r, cell.c);
      }
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinching = false;
      window.__donutDragging = pointers.size > 0;
      if (dragging) { dragging = false; render(); }
    });
    canvas.addEventListener('pointerleave', () => { if (hoverCell) { hoverCell = null; render(); } });
    canvas.addEventListener('wheel', (e) => {
      // Over a menu/panel, let the page scroll instead of zooming. Panels are
      // pointer-events:none so hit-testing ignores them — use their rects.
      if (overMenu(e.clientX, e.clientY)) return; // no preventDefault -> page scroll
      e.preventDefault();
      setZoom(zoom * (e.deltaY > 0 ? 0.9 : 1.1));
      markDirty();
    }, { passive: false });
  }

  /* --------------------------- tube roll ------------------------------- */
  // Roll the surface around the tube (outer <-> inner), like spinning the
  // cross-section of the ring in your hand.
  function rollTube(delta) {
    tubeRoll += delta;
    buildBaseQuads();
    if (inited) render();
  }

  // Switch the surface (torus | mobius). The Möbius is one-sided, so it renders
  // two-sided (no back-face culling).
  function setShape(s) {
    shape = s === 'mobius' ? 'mobius' : 'torus';
    cullBack = shape !== 'mobius';
    panX = 0; panY = 0; zoom = 1;
    buildBaseQuads();
    resize(); // re-fit for the new extents
    if (inited) render();
  }

  // "Move" mode: dragging slides the donut around instead of rotating it.
  function setPanMode(on) {
    panMode = !!on;
    if (canvas) canvas.style.cursor = panMode ? 'move' : 'grab';
    return panMode;
  }
  function recenter() { panX = 0; panY = 0; zoom = 1; baseScale = baseFit; if (inited) render(); }

  /* ------------------------------ lighting ----------------------------- */
  function setLight(mode, sx, sy) {
    if (sx != null && sy != null) {
      const nx = (sx / window.innerWidth) * 2 - 1;
      const ny = -((sy / window.innerHeight) * 2 - 1);
      lightDir = norm([nx, ny, 0.85]);
    }
    if (mode === 'night') { ambient = 0.42; intensity = 0.62; fill = 0.2; cool = 1; }
    else { ambient = 0.62; intensity = 0.8; fill = 0.3; cool = 0; }
    if (inited) render();
  }

  // test hooks
  function _pickAt(x, y) { return pickCell(x, y); }
  function _renderNow() { render(); return lastQuads.length; }

  return { init, ready, redraw, resize, setLight, rollTube, setShape, setPanMode, recenter, setFont, _pickAt, _renderNow };
})();
