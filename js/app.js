/* =========================================================================
 * app.js — state, rendering and interaction for Toroidal Scrabble
 * ========================================================================= */

'use strict';

/* ----------------------------- game state ------------------------------ */
const state = {
  dict: null, // Set of valid lowercase words (null until loaded)
  bag: [], // array of letter chars ('_' = blank)
  players: [
    { name: 'Player 1', score: 0, rack: [] },
    { name: 'Player 2', score: 0, rack: [] },
  ],
  cur: 0,
  board: null, // ROWS x COLS of {letter,blank} | null
  pending: new Map(), // "r,c" -> {letter, blank, rackIndex}
  placedFromRack: new Set(), // rack indices currently on the board
  selected: null, // selected rack index
  firstMove: true,
  scorelessStreak: 0, // consecutive passes/exchanges (ends game at 6)
  lastPlay: null, // the previous committed play, for challenges
  over: false,
  exchangeMode: false,
  exchangeMarks: new Set(),

  // Online (P2P) play. When active, this client controls only `myIndex`;
  // the host (myIndex 0) is authoritative over the shared game state.
  online: { active: false, role: null, myIndex: 0, connected: false },
  ai: { enabled: false, difficulty: 0.55 }, // Player 2 = computer when enabled
  screensaver: { active: false, delay: 1400 }, // two AIs auto-play
  timer: { enabled: false, seconds: 60, remaining: 0, id: null },
  pendingInvalid: false, // current pending tiles aren't in a legal line

  bagOverride: null, // null = bag size auto by shape; else a fixed multiplier (1/2/3)
  viewOffset: { r: 0, c: 0 }, // flat-view seam shift (rolls the torus origin)
};

/* ------------------------------- helpers ------------------------------- */
function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function shuffleBag() {
  shuffle(state.bag);
}

// Torus = two boards → doubled bag (200). Möbius = one surface → standard 100.
// A custom "bag size" option can override this with a fixed multiplier.
function bagMultiplier() {
  if (state.bagOverride) return state.bagOverride;
  return Topo.shape === 'mobius' ? 1 : TILE_MULTIPLIER;
}
function bagTotal() {
  return Object.values(BASE_DISTRIBUTION).reduce((a, b) => a + b, 0) * bagMultiplier();
}
function buildBag() {
  const mult = bagMultiplier();
  const bag = [];
  for (const [letter, count] of Object.entries(BASE_DISTRIBUTION)) {
    for (let i = 0; i < count * mult; i++) bag.push(letter);
  }
  return shuffle(bag);
}

function drawTiles(n) {
  const drawn = [];
  for (let i = 0; i < n && state.bag.length; i++) {
    const letter = state.bag.pop();
    drawn.push({ letter, blank: letter === '_' });
  }
  return drawn;
}

function curPlayer() {
  return state.players[state.cur];
}

/* In online play a client always views its OWN rack; otherwise the current
 * player's rack (hot-seat). It's "my turn" whenever it isn't an online game,
 * or the shared turn pointer matches my seat. */
function rackOwnerIndex() {
  return state.online.active ? state.online.myIndex : state.cur;
}
function isMyTurn() {
  return !state.online.active || state.cur === state.online.myIndex;
}
function packRack(i) {
  return state.players[i].rack.map((t) => ({ letter: t.letter, blank: t.blank }));
}

/* --------------------------- initial dealing --------------------------- */
function newGame() {
  state.bag = buildBag();
  state.board = emptyBoard();
  state.pending.clear();
  state.placedFromRack.clear();
  state.selected = null;
  state.firstMove = true;
  state.scorelessStreak = 0;
  state.lastPlay = null;
  state.over = false;
  state.exchangeMode = false;
  state.exchangeMarks.clear();
  state.cur = 0;
  for (const p of state.players) {
    p.score = 0;
    p.rack = drawTiles(RACK_SIZE);
  }
  const endM = document.getElementById('endModal');
  if (endM) endM.classList.add('hidden');
  clearInterval(window.__danceTimer);
  setMessage('New game. ' + curPlayer().name + ' opens through a ★ start square.', 'info');
  renderAll();
  afterTurn(); // start the clock / computer for the first turn
}

/* ------------------------------ rendering ------------------------------ */
const boardEl = document.getElementById('board');
const rackEl = document.getElementById('rack');
const messageEl = document.getElementById('message');
const scoreboardEl = document.getElementById('scoreboard');
const bagInfoEl = document.getElementById('bagInfo');

// Are the pending tiles all on one legal line? (for live red feedback)
function updatePendingValidity() {
  state.pendingInvalid = false;
  if (state.pending.size <= 1) return;
  const ps = [...state.pending.keys()].map((k) => {
    const [r, c] = k.split(',').map(Number);
    return { r, c };
  });
  const filledAt = (r, c) => state.board[r][c] !== null || state.pending.has(keyOf(r, c));
  const a = ps[0];
  for (const dir of ['H', 'V']) {
    const set = new Set(Engine.collectRun(a.r, a.c, dir, filledAt).map((x) => keyOf(x.r, x.c)));
    if (ps.every((p) => set.has(keyOf(p.r, p.c)))) return; // in a single line
  }
  state.pendingInvalid = true;
}

function renderAll() {
  updatePendingValidity();
  renderBoard();
  renderRack();
  renderScoreboard();
  saveGame();
}

/* ------------------------------ autosave ------------------------------- */
const SAVE_KEY = 'toroidal-scrabble-save-v1';

function saveGame() {
  // Don't persist online or screensaver (ephemeral AI-vs-AI) games.
  if (state.online.active || state.screensaver.active || !state.board) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      shape: Topo.shape,
      rackSize: RACK_SIZE,
      bagOverride: state.bagOverride,
      board: state.board,
      bag: state.bag,
      players: state.players.map((p) => ({ name: p.name, score: p.score, rack: p.rack })),
      cur: state.cur,
      firstMove: state.firstMove,
      scorelessStreak: state.scorelessStreak,
      lastPlay: state.lastPlay,
      over: state.over,
      viewOffset: state.viewOffset,
    }));
  } catch (_) {}
}

function loadSave() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch (_) {
    return null;
  }
}

function restoreGame(snap) {
  // Restore the board topology first (torus vs Möbius) so the engine + 3D match.
  if (snap.shape && snap.shape !== Topo.shape) {
    Topo.shape = snap.shape;
    const sel = document.getElementById('shapeSel');
    if (sel) sel.value = snap.shape;
    if (typeof Board3D !== 'undefined' && Board3D.setShape) Board3D.setShape(snap.shape);
  }
  // Restore custom settings so racks/bag rebuild to the saved sizes.
  if (typeof snap.rackSize === 'number') {
    RACK_SIZE = snap.rackSize;
    const rs = document.getElementById('rackSizeSel');
    if (rs) rs.value = String(snap.rackSize);
  }
  state.bagOverride = snap.bagOverride || null;
  const bs = document.getElementById('bagSizeSel');
  if (bs) bs.value = state.bagOverride ? String(state.bagOverride) : 'auto';
  state.board = snap.board;
  state.bag = snap.bag || [];
  // Rebuild the players array to match the saved count (2–4 supported).
  state.players = snap.players.map((p) => ({ name: p.name, score: p.score, rack: p.rack }));
  const pc = document.getElementById('playerCount');
  if (pc) pc.value = String(state.players.length);
  state.cur = snap.cur || 0;
  state.firstMove = !!snap.firstMove;
  state.scorelessStreak = snap.scorelessStreak || 0;
  state.lastPlay = snap.lastPlay || null;
  state.over = !!snap.over;
  state.viewOffset = snap.viewOffset || { r: 0, c: 0 };
  state.pending.clear();
  state.placedFromRack.clear();
  state.selected = null;
}

function tileInner(letter, blank) {
  const shown = blank ? letter : letter; // blanks display their assigned letter
  const val = blank ? 0 : LETTER_VALUES[letter] || 0;
  return (
    '<span class="t-letter">' + (shown === '_' ? '' : shown) + '</span>' +
    '<span class="t-val">' + val + '</span>'
  );
}

function renderBoard() {
  renderFlatGrid();
  if (typeof Board3D !== 'undefined' && Board3D.ready()) Board3D.redraw();
}

function renderFlatGrid() {
  const offR = state.viewOffset.r;
  const offC = state.viewOffset.c;
  const cells = [];
  // i,j are on-screen positions; r,c are the logical (wrapped) board cells.
  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      const r = (i + offR) % ROWS;
      const c = (j + offC) % COLS;
      const key = keyOf(r, c);
      const pend = state.pending.get(key);
      const committed = state.board[r][c];
      const prem = PREMIUM[r][c];

      let cls = 'cell';
      if (prem) cls += ' prem-' + prem;
      // Mark where the torus is currently "cut" on screen (logical edge 0),
      // so you can see which edges meet.
      if (r === 0) cls += ' wrap-top';
      if (c === 0) cls += ' wrap-left';

      let inner = '';
      if (pend) {
        cls += ' filled pending';
        if (state.pendingInvalid) cls += ' invalid';
        inner = tileInner(pend.letter, pend.blank);
      } else if (committed) {
        cls += ' filled';
        inner = tileInner(committed.letter, committed.blank);
      } else if (prem) {
        inner = '<span class="prem-label">' + PREMIUM_LABEL[prem] + '</span>';
      }

      // data-r/data-c hold the LOGICAL cell, so clicks map correctly regardless
      // of the seam offset.
      cells.push(
        '<div class="' + cls + '" data-r="' + r + '" data-c="' + c + '">' + inner + '</div>'
      );
    }
  }
  boardEl.innerHTML = cells.join('');
}

function renderRack() {
  const rack = state.players[rackOwnerIndex()].rack;
  const tiles = [];
  for (let i = 0; i < rack.length; i++) {
    const t = rack[i];
    let cls = 'rtile';
    if (state.placedFromRack.has(i)) cls += ' placed';
    if (state.selected === i) cls += ' selected';
    if (state.exchangeMode && state.exchangeMarks.has(i)) cls += ' marked';
    tiles.push(
      '<div class="' + cls + '" data-index="' + i + '">' +
        tileInner(t.letter, t.blank) +
      '</div>'
    );
  }
  rackEl.innerHTML = tiles.join('');

  let owner;
  if (state.online.active) {
    owner =
      'You — Player ' + (state.online.myIndex + 1) + ' · ' +
      (state.over ? 'game over' : isMyTurn() ? 'your move' : "opponent's move");
  } else {
    owner = curPlayer().name + "'s rack";
  }
  document.getElementById('rackOwner').textContent = owner;
  document.getElementById('btnExchange').textContent = state.exchangeMode
    ? 'Confirm exchange'
    : 'Exchange';
  document.body.classList.toggle('not-my-turn', state.online.active && !isMyTurn() && !state.over);
}

function renderScoreboard() {
  scoreboardEl.innerHTML = state.players
    .map((p, i) => {
      const active = i === state.cur && !state.over;
      const you = state.online.active && i === state.online.myIndex ? ' (you)' : '';
      return (
        '<div class="score' + (active ? ' active' : '') + '">' +
        '<span class="pname rename" data-i="' + i + '" title="Click to rename">' +
        escapeHtml(p.name) + you + '</span>' +
        (active ? '<span class="turn-dot">●</span>' : '') +
        '<span class="pscore">' + p.score + '</span>' +
        '</div>'
      );
    })
    .join('');
  bagInfoEl.textContent =
    state.bag.length + ' / ' + bagTotal() + ' tiles in bag · ' +
    (Topo.shape === 'mobius' ? 'standard 100' : '2× standard (200)');
  const ss = document.getElementById('ssScore');
  if (ss) ss.textContent = state.players.map((p) => p.name + ': ' + p.score).join('   ·   ');
}

function setMessage(text, type) {
  messageEl.className = 'message ' + (type || 'info');
  messageEl.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])
  );
}

function reverseWord(w) {
  return w.split('').reverse().join('');
}
// Show a word forwards and, if different, backwards — so on this wrap-around
// board the opponent can judge it either reading direction.
function wordLabel(text) {
  const rev = reverseWord(text);
  return text.length > 1 && rev !== text ? text + '/' + rev : text;
}
// A word is legitimate if it (or, on this board, its reverse) is in the dict.
function wordIsValid(text) {
  const w = text.toLowerCase();
  return state.dict.has(w) || state.dict.has(reverseWord(w));
}

// Launch the 3D torus. If WebGL/Three isn't available, hide the donut, show a
// note, and open the flat view so the game is still fully playable.
function init3D() {
  if (typeof Board3D === 'undefined' || !Board3D.init()) {
    const el3d = document.getElementById('board3d');
    if (el3d) el3d.classList.add('hidden');
    const err = document.getElementById('board3dError');
    if (err) {
      err.classList.remove('hidden');
      err.textContent = '3D donut unavailable in this browser — using the flat board below.';
    }
    const flat = document.getElementById('flatView');
    if (flat) flat.open = true;
    return false;
  }
  Board3D.setLight(document.body.getAttribute('data-mode') || 'day');
  return true;
}

// Size the flat grid to fill the width of its (collapsible) container.
function fitBoard() {
  const frame = document.querySelector('.board-frame');
  const flat = document.getElementById('flatView');
  if (!frame || (flat && !flat.open)) return;
  const cs = getComputedStyle(frame);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const gap = 2;
  const availW = frame.clientWidth - padX;
  let cell = Math.floor((availW - gap * (COLS - 1)) / COLS);
  cell = Math.max(14, Math.min(30, cell));
  document.documentElement.style.setProperty('--cell', cell + 'px');
}

// Roll the flat view's origin (the torus seam) so different edges/corners meet.
function shiftView(dr, dc) {
  state.viewOffset.r = (((state.viewOffset.r + dr) % ROWS) + ROWS) % ROWS;
  state.viewOffset.c = (((state.viewOffset.c + dc) % COLS) + COLS) % COLS;
  renderFlatGrid();
}

// Lay a typed word onto the board starting at (r0,c0), taking tiles from the
// current rack (blanks fill any letter). Existing tiles on the path must match.
function layWordAt(r0, c0) {
  if (state.over) return false;
  if (state.online.active && !isMyTurn()) {
    setMessage("It's not your turn.", 'info');
    return false;
  }
  const input = document.getElementById('wordEntry');
  const word = ((input && input.value) || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!word) return false;
  // Four directions: → right / ← left (horizontal), ↓ down / ↑ up (vertical).
  // Left & up simply lay the typed letters "backwards" from the tapped square.
  const dir = (document.querySelector('input[name="wedir"]:checked') || {}).value || 'right';
  const axis = (dir === 'down' || dir === 'up') ? 'V' : 'H';
  const sign = (dir === 'left' || dir === 'up') ? -1 : 1;

  recallAll();
  const rack = state.players[rackOwnerIndex()].rack;
  const avail = rack.map((t, i) => ({ t, i, used: false }));
  const placements = [];
  let cell = { r: r0, c: c0 };
  for (let k = 0; k < word.length; k++) {
    if (!cell) { // ran off a free boundary (e.g. a Möbius strip edge)
      setMessage('“' + word + '” runs off the edge of the surface from there — try another square or direction.', 'error');
      recallAll();
      renderAll();
      return false;
    }
    const r = cell.r, c = cell.c;
    const letter = word[k];
    const committed = state.board[r][c];
    if (committed) {
      if (committed.letter !== letter) {
        setMessage('“' + word + '” doesn’t fit the tiles already there (need ' + committed.letter + ' at that square).', 'error');
        recallAll();
        renderAll();
        return false;
      }
      // existing tile is part of the word, not a new placement
    } else {
      let slot = avail.find((s) => !s.used && !s.t.blank && s.t.letter === letter);
      let blank = false;
      if (!slot) { slot = avail.find((s) => !s.used && s.t.blank); blank = true; }
      if (!slot) {
        setMessage('You don’t have the tiles for “' + word + '” (missing ' + letter + ').', 'error');
        recallAll();
        renderAll();
        return false;
      }
      slot.used = true;
      placements.push({ r, c, letter, blank, rackIndex: slot.i });
    }
    cell = Topo.step(r, c, axis, sign); // topology-aware next square (may be null at a boundary)
  }
  if (placements.length === 0) {
    setMessage('“' + word + '” is already on the board there.', 'info');
    return false;
  }
  for (const p of placements) {
    state.pending.set(keyOf(p.r, p.c), { letter: p.letter, blank: p.blank, rackIndex: p.rackIndex });
    state.placedFromRack.add(p.rackIndex);
  }
  state.selected = null;
  setMessage('Placed “' + word + '”. Press Submit to score it, or Recall to change.', 'info');
  renderAll();
  return true;
}

function renamePlayer(i) {
  if (state.online.active && i !== state.online.myIndex) {
    setMessage('You can only rename yourself in an online game.', 'info');
    return;
  }
  const val = (window.prompt('Player name:', state.players[i].name) || '').trim().slice(0, 20);
  if (!val) return;
  state.players[i].name = val;
  renderScoreboard();
  renderRack();
  if (state.online.active) {
    if (state.online.role === 'host') broadcastState();
    else Net.send({ t: 'rename', name: val });
  }
}

function hostHandleRename(msg) {
  const val = String(msg.name || '').trim().slice(0, 20);
  if (val) {
    state.players[1].name = val;
    renderScoreboard();
    broadcastState();
  }
}

/* ---------------------------- interaction ------------------------------ */
// Place / recall a tile at (r,c). Shared by the flat grid and the 3D torus.
function cellAction(r, c) {
  if (state.over) return;
  if (isAiTurn() && !aiActing) return;
  if (state.online.active && !isMyTurn()) {
    setMessage("It's not your turn yet — waiting for your opponent.", 'info');
    return;
  }
  const key = keyOf(r, c);

  // Clicking a pending tile recalls it.
  if (state.pending.has(key)) {
    const p = state.pending.get(key);
    state.placedFromRack.delete(p.rackIndex);
    state.pending.delete(key);
    renderAll();
    return;
  }
  // Occupied by a committed tile — nothing to do.
  if (state.board[r][c]) return;
  // No rack tile selected: if a word is typed, lay it from here; else prompt.
  if (state.selected === null) {
    const wi = document.getElementById('wordEntry');
    if (wi && wi.value.trim()) {
      layWordAt(r, c);
      return;
    }
    setMessage('Pick a tile from your rack, or type a word above and click a starting square.', 'info');
    return;
  }

  const tile = curPlayer().rack[state.selected];
  const rackIndex = state.selected;
  if (tile.blank) {
    pickBlankLetter((letter) => {
      if (!letter) { setMessage('Blank cancelled.', 'info'); return; }
      state.pending.set(key, { letter, blank: true, rackIndex });
      state.placedFromRack.add(rackIndex);
      state.selected = null;
      renderAll();
    });
    return;
  }
  state.pending.set(key, { letter: tile.letter, blank: false, rackIndex });
  state.placedFromRack.add(rackIndex);
  state.selected = null;
  renderAll();
}

/* ---------------------------- blank picker ----------------------------- */
let blankCb = null;
function pickBlankLetter(cb) {
  blankCb = cb;
  const grid = document.getElementById('blankGrid');
  if (!grid.children.length) {
    for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const b = document.createElement('button');
      b.className = 'blank-key';
      b.textContent = L;
      b.dataset.l = L;
      grid.appendChild(b);
    }
  }
  document.getElementById('blankModal').classList.remove('hidden');
}
function closeBlank(letter) {
  document.getElementById('blankModal').classList.add('hidden');
  const cb = blankCb;
  blankCb = null;
  if (cb) cb(letter || null);
}

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  cellAction(+cell.dataset.r, +cell.dataset.c);
});

function handleRackSelect(i) {
  if (state.over) return;
  if (isAiTurn() && !aiActing) return;
  if (state.online.active && !isMyTurn()) return;
  if (state.exchangeMode) {
    if (state.exchangeMarks.has(i)) state.exchangeMarks.delete(i);
    else state.exchangeMarks.add(i);
    renderRack();
    return;
  }
  if (state.placedFromRack.has(i)) return;
  state.selected = state.selected === i ? null : i;
  renderRack();
}

// Rack: tap a tile to select it, or drag to reorder (only when nothing is
// pending, so tile indices stay valid).
let rackDrag = null;
rackEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.rtile');
  if (!el) return;
  rackDrag = { i: +el.dataset.index, el, startX: e.clientX, moved: false };
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
});
rackEl.addEventListener('pointermove', (e) => {
  if (!rackDrag) return;
  const canReorder = state.pending.size === 0 && !state.exchangeMode &&
    (!state.online.active || isMyTurn());
  if (!canReorder) return;
  const dx = e.clientX - rackDrag.startX;
  if (Math.abs(dx) > 6) rackDrag.moved = true;
  if (rackDrag.moved) {
    rackDrag.el.style.transform = 'translate(' + dx + 'px,-8px)';
    rackDrag.el.style.zIndex = '5';
    rackDrag.el.style.opacity = '0.9';
  }
});
window.addEventListener('pointerup', (e) => {
  if (!rackDrag) return;
  const drag = rackDrag;
  rackDrag = null;
  drag.el.style.transform = '';
  drag.el.style.zIndex = '';
  drag.el.style.opacity = '';
  if (!drag.moved) { handleRackSelect(drag.i); return; }
  const rack = state.players[rackOwnerIndex()].rack;
  const tiles = [...rackEl.querySelectorAll('.rtile')];
  let target = tiles.length;
  for (let k = 0; k < tiles.length; k++) {
    const r = tiles[k].getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) { target = k; break; }
  }
  const from = drag.i;
  if (target !== from && target !== from + 1) {
    const [t] = rack.splice(from, 1);
    rack.splice(target > from ? target - 1 : target, 0, t);
  }
  state.selected = null;
  renderRack();
});

/* ------------------------------- moves --------------------------------- */
function recallAll() {
  state.pending.clear();
  state.placedFromRack.clear();
  state.selected = null;
}

function pendingPlacements() {
  return [...state.pending.entries()].map(([k, v]) => {
    const [r, c] = k.split(',').map(Number);
    return { r, c, letter: v.letter, blank: v.blank };
  });
}

function refillRack(player) {
  const need = RACK_SIZE - player.rack.length;
  if (need > 0) player.rack.push(...drawTiles(need));
}

function nextPlayer() {
  state.cur = (state.cur + 1) % state.players.length;
  state.selected = null;
}

// Human-readable summary of a scored move, flagging palindromes/reversibles.
function moveSummary(name, result) {
  return name + ': ' +
    result.words.map((w) => {
      let s = wordLabel(w.text) + ' (' + w.score + ')';
      if (w.kind === 'palindrome') s += ' ✨palindrome +20';
      else if (w.kind === 'reversible') s += ' ↔ reversible +5';
      return s;
    }).join(', ') +
    (result.bingo ? '  +50 BINGO!' : '') +
    '  →  +' + result.total;
}

function submitMove() {
  if (state.over) return;
  if (isAiTurn() && !aiActing) return;
  if (state.exchangeMode) {
    setMessage('Finish or cancel the exchange first.', 'info');
    return;
  }
  if (!state.dict) {
    setMessage('Dictionary still loading — one moment.', 'info');
    return;
  }
  if (state.online.active && !isMyTurn()) {
    setMessage("It's not your turn.", 'info');
    return;
  }
  // Guest: hand the move to the authoritative host and wait.
  if (state.online.active && state.online.role === 'guest') {
    const placements = pendingPlacements();
    if (placements.length === 0) {
      setMessage('Place at least one tile on the board.', 'info');
      return;
    }
    Net.send({ t: 'move', kind: 'submit', placements });
    setMessage('Move sent — waiting for the host to confirm…', 'info');
    return;
  }

  const opts = {
    zeroShortWords: document.getElementById('optZeroShort').checked,
    requireDictionary: false, // challenge model — invalid words are allowed
  };
  const result = Engine.validateMove(
    state.board,
    state.pending,
    state.firstMove,
    state.dict,
    opts
  );
  if (!result.ok) {
    setMessage(result.error, 'error');
    return;
  }

  // Commit pending tiles to the board, recording enough to undo on a challenge.
  const player = curPlayer();
  const wasFirst = state.firstMove;
  const cells = [];
  const usedIndices = [];
  for (const [key, p] of state.pending.entries()) {
    const [r, c] = key.split(',').map(Number);
    state.board[r][c] = { letter: p.letter, blank: p.blank };
    usedIndices.push(p.rackIndex);
    cells.push({ r, c });
  }
  const playedTiles = usedIndices.map((i) => ({
    letter: player.rack[i].letter,
    blank: player.rack[i].blank,
  }));
  usedIndices.slice().sort((a, b) => b - a).forEach((i) => player.rack.splice(i, 1));

  player.score += result.total;
  state.firstMove = false;
  state.scorelessStreak = 0;
  recallAll();
  const drawn = drawTiles(RACK_SIZE - player.rack.length);
  player.rack.push(...drawn);

  state.lastPlay = {
    player: state.cur,
    cells,
    words: result.words.map((w) => w.text),
    score: result.total,
    playedTiles,
    drawn,
    wasFirstMove: wasFirst,
  };

  const wi = document.getElementById('wordEntry');
  if (wi) wi.value = '';

  const summary = moveSummary(player.name, result);
  setMessage(summary, 'success');

  // End condition: a player empties their rack with an empty bag.
  if (player.rack.length === 0 && state.bag.length === 0) {
    endGame(state.cur);
  } else {
    nextPlayer();
  }
  renderAll();
  if (state.online.active) broadcastState(summary);
  afterTurn();
}

function passTurn() {
  if (state.over || state.exchangeMode) return;
  if (isAiTurn() && !aiActing) return;
  if (state.online.active && !isMyTurn()) {
    setMessage("It's not your turn.", 'info');
    return;
  }
  if (state.online.active && state.online.role === 'guest') {
    recallAll();
    Net.send({ t: 'move', kind: 'pass' });
    setMessage('Pass sent…', 'info');
    renderAll();
    return;
  }
  recallAll();
  state.lastPlay = null; // passing closes the challenge window
  const who = curPlayer().name;
  state.scorelessStreak++;
  if (state.scorelessStreak >= state.players.length * 3) {
    endGame(null);
    renderAll();
    if (state.online.active) broadcastState('Game over — too many passes.');
    return;
  }
  nextPlayer();
  setMessage(who + ' passed.', 'info');
  renderAll();
  if (state.online.active) broadcastState(who + ' passed.');
  afterTurn();
}

function toggleExchange() {
  if (state.over) return;
  if (isAiTurn() && !aiActing) return;
  if (state.online.active && !isMyTurn()) {
    setMessage("It's not your turn.", 'info');
    return;
  }
  if (!state.exchangeMode) {
    if (state.bag.length === 0) {
      setMessage('The bag is empty — you cannot exchange tiles.', 'error');
      return;
    }
    recallAll();
    state.exchangeMode = true;
    state.exchangeMarks.clear();
    setMessage('Exchange: tap tiles to swap, then "Confirm exchange". Recall cancels.', 'info');
    renderRack();
    return;
  }
  // Confirm.
  const marks = [...state.exchangeMarks].sort((a, b) => b - a);
  if (marks.length === 0) {
    setMessage('No tiles marked — cancelled exchange.', 'info');
    cancelExchange();
    return;
  }
  if (marks.length > state.bag.length) {
    setMessage('Not enough tiles in the bag for that exchange.', 'error');
    return;
  }
  // Guest: let the authoritative host perform the swap.
  if (state.online.active && state.online.role === 'guest') {
    Net.send({ t: 'move', kind: 'exchange', idx: marks });
    state.exchangeMode = false;
    state.exchangeMarks.clear();
    setMessage('Exchange sent…', 'info');
    renderAll();
    return;
  }
  const player = curPlayer();
  const returned = marks.map((i) => player.rack.splice(i, 1)[0].letter);
  player.rack.push(...drawTiles(marks.length));
  state.bag.push(...returned);
  shuffleBag();
  state.exchangeMode = false;
  state.exchangeMarks.clear();
  state.lastPlay = null; // exchanging closes the challenge window
  const who = player.name;
  state.scorelessStreak++;
  if (state.scorelessStreak >= state.players.length * 3) {
    endGame(null);
    renderAll();
    if (state.online.active) broadcastState('Game over — too many passes.');
    return;
  }
  nextPlayer();
  setMessage(who + ' exchanged ' + marks.length + ' tile(s).', 'info');
  renderAll();
  if (state.online.active) broadcastState(who + ' exchanged ' + marks.length + ' tile(s).');
  afterTurn();
}

function cancelExchange() {
  state.exchangeMode = false;
  state.exchangeMarks.clear();
  renderRack();
}

function recallOrCancel() {
  if (state.exchangeMode) {
    cancelExchange();
    setMessage('Exchange cancelled.', 'info');
    return;
  }
  recallAll();
  renderAll();
}

function shuffleRack() {
  if (state.over) return;
  const rack = curPlayer().rack;
  // Recall pending first so indices stay valid.
  recallAll();
  for (let i = rack.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rack[i], rack[j]] = [rack[j], rack[i]];
  }
  renderAll();
}

function endGame(finisherIndex) {
  state.over = true;
  // Standard endgame adjustment: each player loses the value of their unplayed
  // tiles; if someone went out, they gain the sum of everyone else's.
  let bonusToFinisher = 0;
  state.players.forEach((p, i) => {
    const rackVal = p.rack.reduce(
      (s, t) => s + (t.blank ? 0 : LETTER_VALUES[t.letter] || 0),
      0
    );
    if (i !== finisherIndex) {
      p.score -= rackVal;
      bonusToFinisher += rackVal;
    }
  });
  if (finisherIndex !== null) state.players[finisherIndex].score += bonusToFinisher;

  const best = Math.max(...state.players.map((p) => p.score));
  const winners = state.players.filter((p) => p.score === best);
  const verdict =
    winners.length === 1
      ? winners[0].name + ' wins with ' + best + '!'
      : 'Tie at ' + best + ' between ' + winners.map((w) => w.name).join(' & ') + '!';
  setMessage('Game over. ' + verdict, 'success');
  renderAll();
  showEndgame();
}

/* ------------------------- players + endgame ---------------------------- */
function setPlayerCount(n) {
  if (state.online.active) {
    setMessage('Online games are 2-player. Player count applies to hot-seat.', 'info');
    return;
  }
  n = Math.max(2, Math.min(5, n | 0));
  state.players = [];
  for (let i = 0; i < n; i++) state.players.push({ name: 'Player ' + (i + 1), score: 0, rack: [] });
  newGame();
}

// Switch the board topology (torus | mobius): updates the engine's wrapping AND
// the 3D surface, then starts a fresh game.
function setShape(s) {
  Topo.shape = s === 'mobius' ? 'mobius' : 'torus';
  if (typeof Board3D !== 'undefined' && Board3D.setShape) Board3D.setShape(Topo.shape);
  newGame();
}

/* ---------------------------- computer player -------------------------- */
let aiActing = false; // true while the AI applies its own move (bypasses guards)
let aiThinking = false;
function isAiTurn() {
  if (state.online.active || state.over) return false;
  return state.screensaver.active || (state.ai.enabled && state.cur === 1);
}

// Run after every turn change: start the clock for a human, or the computer.
function afterTurn() {
  startTurnTimer();
  if (!isAiTurn() || aiThinking) return;
  aiThinking = true;
  setMessage(curPlayer().name + ' is thinking…', 'info');
  renderScoreboard();
  setTimeout(aiTakeTurn, state.screensaver.active ? state.screensaver.delay : 550);
}
function aiTakeTurn() {
  aiThinking = false;
  if (!isAiTurn()) return;
  let move = null;
  try {
    move = AI.chooseMove(state.board, curPlayer().rack, state.firstMove, state.dict, state.ai.difficulty);
  } catch (e) {
    console.error('AI error:', e);
  }
  aiActing = true;
  if (!move || !move.placements || !move.placements.length) {
    passTurn();
  } else {
    recallAll();
    for (const p of move.placements) {
      state.pending.set(keyOf(p.r, p.c), { letter: p.letter, blank: p.blank, rackIndex: p.rackIndex });
      state.placedFromRack.add(p.rackIndex);
    }
    submitMove();
  }
  aiActing = false;
  // Screensaver: roll into a fresh game when one ends.
  if (state.screensaver.active && state.over) {
    setTimeout(() => { if (state.screensaver.active) { newGame(); afterTurn(); } }, 3500);
  }
}

/* ------------------------------ turn timer ----------------------------- */
function startTurnTimer() {
  clearInterval(state.timer.id);
  state.timer.id = null;
  if (!state.timer.enabled || state.over || state.screensaver.active || state.online.active || isAiTurn()) {
    updateTimerDisplay();
    return;
  }
  state.timer.remaining = state.timer.seconds;
  updateTimerDisplay();
  state.timer.id = setInterval(() => {
    state.timer.remaining--;
    updateTimerDisplay();
    if (state.timer.remaining <= 0) {
      clearInterval(state.timer.id);
      state.timer.id = null;
      const who = curPlayer().name;
      if (state.exchangeMode) cancelExchange();
      recallAll();
      setMessage('⏱ Time! ' + who + ' forfeits the turn.', 'error');
      passTurn();
    }
  }, 1000);
}
function updateTimerDisplay() {
  const el = document.getElementById('turnTimer');
  if (el) el.textContent = state.timer.id ? '⏱ ' + state.timer.remaining + 's' : '';
}

/* ------------------------------ screensaver ---------------------------- */
function startScreensaver() {
  if (state.online.active) { setMessage('Exit online play first.', 'info'); return; }
  state.screensaver.active = true;
  state.ai.enabled = false;
  document.body.classList.add('screensaver');
  state.players.forEach((p, i) => (p.name = 'Computer ' + String.fromCharCode(65 + i)));
  try { const el = document.documentElement; if (el.requestFullscreen) el.requestFullscreen(); } catch (_) {}
  newGame(); // its afterTurn() kicks off the first computer move
}
function stopScreensaver() {
  state.screensaver.active = false;
  document.body.classList.remove('screensaver');
  state.players.forEach((p, i) => (p.name = 'Player ' + (i + 1)));
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (_) {}
  renderAll();
}

// A few 3-frame dancing winners and some loser tableaus (simple stick figures).
const WINNER_DANCES = [
  [[' \\o/', '  | ', ' / \\'], ['  o ', ' /|\\', ' / \\'], [' \\o/', '  | ', '_/ \\_']],
  [[' o/ ', ' /| ', ' / \\'], [' \\o ', '  |\\', ' / \\'], [' _o_', '  | ', ' / \\']],
  [['\\o/ ', ' |  ', '/ \\ '], [' o  ', '/|\\ ', '/ \\ '], [' \\o/', '  | ', ' /\\ ']],
  [['(o)', '/|\\', '/ \\'], ['(o)', '\\|/', '/ \\'], ['(o)', '-|-', '/ \\']],
];
const LOSER_ARTS = [
  ["  ' . ` , . `", '      o     ', '     /|\\    ', '     / \\    ', '   ~ ~ ~ ~  '],
  ['     o      ', '    /|      ', '   / |__    ', '  (_____)   ', '   in shame '],
];

function showEndgame() {
  const modal = document.getElementById('endModal');
  const ranked = state.players.map((p, i) => ({ name: p.name, score: p.score, i }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0].score;
  const winners = ranked.filter((p) => p.score === top);
  document.getElementById('endTitle').innerHTML =
    (winners.length === 1 ? '🏆 ' + escapeHtml(winners[0].name) + ' wins!' :
      '🤝 Tie: ' + winners.map((w) => escapeHtml(w.name)).join(' &amp; ')) + ' — ' + top + ' pts';

  const dance = WINNER_DANCES[Math.floor(Math.random() * WINNER_DANCES.length)];
  const loser = LOSER_ARTS[Math.floor(Math.random() * LOSER_ARTS.length)];
  const scoreRows = ranked.map((p, idx) =>
    '<div class="' + (idx === 0 ? 'w' : '') + '">' + (idx + 1) + '. ' +
    escapeHtml(p.name) + ' — ' + p.score + '</div>').join('');
  document.getElementById('endBody').innerHTML =
    '<pre class="ascii win" id="winAscii"></pre>' +
    '<div class="end-scores">' + scoreRows + '</div>' +
    '<pre class="ascii lose">' + loser.join('\n') + '</pre>' +
    '<div class="lose-label">' + escapeHtml(ranked[ranked.length - 1].name) + ', better luck next time.</div>';
  modal.classList.remove('hidden');

  let f = 0;
  const winEl = document.getElementById('winAscii');
  winEl.textContent = dance[0].join('\n');
  clearInterval(window.__danceTimer);
  window.__danceTimer = setInterval(() => {
    f = (f + 1) % dance.length;
    winEl.textContent = dance[f].join('\n');
  }, 360);
}

/* --------------------------- online (P2P) ------------------------------ */
/* Host is authoritative: it owns the bag, board, both racks, scores and the
 * turn pointer. The guest sends its intended move; the host validates and
 * broadcasts the resulting public state (plus only the guest's own rack). */

function getPublicState() {
  return {
    board: state.board,
    scores: state.players.map((p) => p.score),
    names: state.players.map((p) => p.name),
    cur: state.cur,
    firstMove: state.firstMove,
    bagCount: state.bag.length,
    over: state.over,
  };
}

function applyPublicState(pub, yourRack, msg) {
  state.board = pub.board;
  state.players[0].score = pub.scores[0];
  state.players[1].score = pub.scores[1];
  if (pub.names) {
    state.players[0].name = pub.names[0];
    state.players[1].name = pub.names[1];
  }
  state.cur = pub.cur;
  state.firstMove = pub.firstMove;
  state.over = pub.over;
  state.bag = new Array(pub.bagCount).fill('?'); // count only; guest never draws
  state.players[state.online.myIndex].rack = (yourRack || []).map((t) => ({
    letter: t.letter,
    blank: t.blank,
  }));
  recallAll();
  if (msg) setMessage(msg, state.over ? 'success' : 'info');
  renderAll();
}

function broadcastState(summary) {
  Net.send({ t: 'state', public: getPublicState(), yourRack: packRack(1), msg: summary });
}

// Host: deal a fresh match once the guest has connected.
function hostBeginMatch() {
  newGame();
  state.online.active = true;
  state.online.role = 'host';
  state.online.myIndex = 0;
  Net.send({ t: 'start', yourIndex: 1, public: getPublicState(), yourRack: packRack(1) });
  setMessage('Opponent connected. You are Player 1 — your move.', 'success');
  renderAll();
}

function guestHandleStart(msg) {
  state.online.active = true;
  state.online.role = 'guest';
  state.online.myIndex = msg.yourIndex != null ? msg.yourIndex : 1;
  state.online.connected = true;
  applyPublicState(
    msg.public,
    msg.yourRack,
    'Connected! You are Player ' + (state.online.myIndex + 1) + '. Waiting for Player 1…'
  );
}

function guestHandleState(msg) {
  applyPublicState(msg.public, msg.yourRack, msg.msg);
}

function guestHandleReject(msg) {
  setMessage(msg.reason || 'Move rejected — adjust and try again.', 'error');
  // Pending tiles stay put so the guest can fix and resubmit.
}

// Host validates + applies a move the guest (player index 1) sent.
function hostHandleGuestMove(msg) {
  if (msg.kind === 'submit') {
    const pending = new Map();
    for (const p of msg.placements) {
      pending.set(keyOf(p.r, p.c), { letter: p.letter, blank: p.blank });
    }
    // Confirm the placed tiles come from the guest's rack; note which to use.
    const rackCopy = state.players[1].rack.slice();
    const usedIdx = [];
    let mismatch = false;
    for (const p of msg.placements) {
      const idx = rackCopy.findIndex(
        (t) => t && (p.blank ? t.blank : !t.blank && t.letter === p.letter)
      );
      if (idx < 0) { mismatch = true; break; }
      usedIdx.push(idx);
      rackCopy[idx] = null;
    }
    if (mismatch) {
      Net.send({ t: 'reject', reason: 'Out of sync — those tiles are not in your rack.' });
      return;
    }
    const opts = {
      zeroShortWords: document.getElementById('optZeroShort').checked,
      requireDictionary: false,
    };
    const result = Engine.validateMove(state.board, pending, state.firstMove, state.dict, opts);
    if (!result.ok) {
      Net.send({ t: 'reject', reason: result.error });
      return;
    }
    const wasFirst = state.firstMove;
    const cells = [];
    const playedTiles = usedIdx.map((i) => ({
      letter: state.players[1].rack[i].letter,
      blank: state.players[1].rack[i].blank,
    }));
    for (const p of msg.placements) {
      state.board[p.r][p.c] = { letter: p.letter, blank: p.blank };
      cells.push({ r: p.r, c: p.c });
    }
    state.players[1].rack = state.players[1].rack.filter((_, i) => !usedIdx.includes(i));
    state.players[1].score += result.total;
    state.firstMove = false;
    state.scorelessStreak = 0;
    const drawn = drawTiles(RACK_SIZE - state.players[1].rack.length);
    state.players[1].rack.push(...drawn);
    state.lastPlay = {
      player: 1, cells, words: result.words.map((w) => w.text),
      score: result.total, playedTiles, drawn, wasFirstMove: wasFirst,
    };
    const summary = moveSummary(state.players[1].name || 'Player 2', result);
    setMessage(summary, 'success');
    if (state.players[1].rack.length === 0 && state.bag.length === 0) endGame(1);
    else state.cur = 0;
    renderAll();
    broadcastState(summary);
  } else if (msg.kind === 'pass') {
    state.lastPlay = null;
    state.scorelessStreak++;
    if (state.scorelessStreak >= state.players.length * 3) {
      endGame(null);
      renderAll();
      broadcastState('Game over — too many passes.');
      return;
    }
    state.cur = 0;
    setMessage('Player 2 passed.', 'info');
    renderAll();
    broadcastState('Player 2 passed.');
  } else if (msg.kind === 'exchange') {
    const idx = (msg.idx || []).slice().sort((a, b) => b - a);
    if (idx.length === 0 || idx.length > state.bag.length) {
      Net.send({ t: 'reject', reason: 'Exchange failed — not enough tiles in the bag.' });
      return;
    }
    const guest = state.players[1];
    const returned = idx.map((i) => guest.rack.splice(i, 1)[0].letter);
    guest.rack.push(...drawTiles(idx.length));
    state.bag.push(...returned);
    shuffleBag();
    state.lastPlay = null;
    state.scorelessStreak++;
    if (state.scorelessStreak >= state.players.length * 3) {
      endGame(null);
      renderAll();
      broadcastState('Game over — too many passes.');
      return;
    }
    state.cur = 0;
    setMessage('Player 2 exchanged ' + idx.length + ' tile(s).', 'info');
    renderAll();
    broadcastState('Player 2 exchanged ' + idx.length + ' tile(s).');
  }
}

function onNewGameClicked() {
  if (state.online.active) {
    if (state.online.role === 'host') hostBeginMatch();
    else setMessage('Only the host can start a new game.', 'info');
    return;
  }
  newGame();
}

/* ----------------------------- challenges ------------------------------ */
// The current player challenges the previous play. Guests route to the host.
function challengeWord() {
  if (state.over) return;
  if (!state.lastPlay) {
    setMessage('There is no recent play to challenge.', 'info');
    return;
  }
  if (state.online.active && !isMyTurn()) {
    setMessage("It's not your turn to challenge.", 'info');
    return;
  }
  if (state.online.active && state.online.role === 'guest') {
    recallAll();
    Net.send({ t: 'challenge' });
    setMessage('Challenge sent…', 'info');
    renderAll();
    return;
  }
  resolveChallenge();
}

// Authoritative resolution (hot-seat or host).
function resolveChallenge() {
  const lp = state.lastPlay;
  if (!lp) return;
  recallAll();
  const challengerName = state.players[state.cur].name;
  const playerName = state.players[lp.player].name;
  const bad = lp.words.filter((w) => !wordIsValid(w));

  if (bad.length === 0) {
    // Words hold up — the challenger forfeits this turn.
    state.lastPlay = null;
    const msg = 'Challenge failed — ' + lp.words.join(', ') + ' valid. ' +
      challengerName + ' loses the turn.';
    state.cur = (state.cur + 1) % state.players.length;
    setMessage(msg, 'info');
    renderAll();
    if (state.online.active) broadcastState(msg);
    afterTurn();
    return;
  }

  // Invalid — retract the play, refund tiles + score, player loses the turn.
  const pl = state.players[lp.player];
  for (const { r, c } of lp.cells) state.board[r][c] = null;
  pl.score -= lp.score;
  for (const t of lp.drawn) {
    const idx = pl.rack.indexOf(t);
    if (idx >= 0) pl.rack.splice(idx, 1);
  }
  state.bag.push(...lp.drawn.map((t) => t.letter));
  pl.rack.push(...lp.playedTiles.map((t) => ({ letter: t.letter, blank: t.blank })));
  shuffleBag();
  if (lp.wasFirstMove) state.firstMove = true;
  state.lastPlay = null;
  const msg = 'Challenge upheld — ' + bad.join(', ') + ' not valid. ' +
    playerName + '’s word is removed and they lose the turn.';
  setMessage(msg, 'success'); // challenger keeps the turn (state.cur unchanged)
  renderAll();
  if (state.online.active) broadcastState(msg);
  afterTurn();
}

/* ----------------------------- dictionary ------------------------------ */
async function loadDictionary() {
  setMessage('Loading dictionary…', 'info');
  try {
    // Prefer the baked-in list (js/dictionary.js) so the game runs from a
    // plain file:// open with no server; fall back to fetch if it's absent.
    let text;
    if (typeof ENABLE_TEXT !== 'undefined') {
      text = ENABLE_TEXT;
    } else {
      const res = await fetch('data/enable1.txt');
      text = await res.text();
    }
    state.dict = new Set(text.split(/\r?\n/).filter(Boolean));
    if (typeof DICT_SUPPLEMENT !== 'undefined') {
      for (const w of DICT_SUPPLEMENT) state.dict.add(w);
    }
    populateWordLists();
    setMessage(
      'Dictionary ready (' + state.dict.size.toLocaleString() + ' words). ' +
        (state.firstMove
          ? curPlayer().name + ' opens through a ★ start square.'
          : 'Resumed your saved game — ' + curPlayer().name + '’s turn. (New game restarts.)'),
      'info'
    );
  } catch (err) {
    setMessage('Could not load the dictionary. Serve the folder over http (see README).', 'error');
    console.error(err);
  }
}

/* -------------------------- 2/3-letter helper -------------------------- */
let twoAll = [];
let threeAll = [];

function populateWordLists() {
  twoAll = [];
  threeAll = [];
  for (const w of state.dict) {
    if (w.length === 2) twoAll.push(w);
    else if (w.length === 3) threeAll.push(w);
  }
  twoAll.sort();
  threeAll.sort();
  renderWordLists('');
}

function renderWordLists(filter) {
  const f = filter.trim().toLowerCase();
  const two = f ? twoAll.filter((w) => w.includes(f)) : twoAll;
  const three = f ? threeAll.filter((w) => w.includes(f)) : threeAll;
  const chips = (arr) => arr.map((w) => '<span class="wchip">' + w + '</span>').join('');
  document.getElementById('list2').innerHTML = chips(two);
  document.getElementById('list3').innerHTML = chips(three);
  document.getElementById('c2').textContent = '(' + two.length + ')';
  document.getElementById('c3').textContent = '(' + three.length + ')';
}

function openWordList() {
  if (!state.dict) {
    setMessage('Dictionary still loading — one moment.', 'info');
    return;
  }
  document.getElementById('wordModal').classList.remove('hidden');
  const filter = document.getElementById('wordFilter');
  filter.value = '';
  renderWordLists('');
  filter.focus();
}
function closeWordList() {
  document.getElementById('wordModal').classList.add('hidden');
}

/* ------------------------------- wiring -------------------------------- */
document.getElementById('btnWordList').addEventListener('click', openWordList);
document.getElementById('btnCloseWords').addEventListener('click', closeWordList);
document.getElementById('wordFilter').addEventListener('input', (e) =>
  renderWordLists(e.target.value)
);
document.getElementById('wordModal').addEventListener('click', (e) => {
  if (e.target.id === 'wordModal') closeWordList(); // click backdrop to close
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeWordList(); if (blankCb) closeBlank(null); closeConfirm(false); }
});

// generic in-page confirmation dialog
let confirmYesCb = null;
let confirmNoCb = null;
function showConfirm(title, msg, onYes, onNo) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  confirmYesCb = onYes;
  confirmNoCb = onNo;
  document.getElementById('confirmModal').classList.remove('hidden');
}
function closeConfirm(yes) {
  document.getElementById('confirmModal').classList.add('hidden');
  const y = confirmYesCb;
  const n = confirmNoCb;
  confirmYesCb = confirmNoCb = null;
  if (yes) { if (y) y(); } else if (n) n();
}
document.getElementById('confirmYes').addEventListener('click', () => closeConfirm(true));
document.getElementById('confirmNo').addEventListener('click', () => closeConfirm(false));
document.getElementById('confirmModal').addEventListener('click', (e) => {
  if (e.target.id === 'confirmModal') closeConfirm(false);
});

// Apply a "new game" setting (players / bag / rack). If tiles are already
// played, confirm first (it restarts); on a fresh board, just apply.
function applySetting(msg, apply, revert) {
  if (state.online.active) {
    setMessage('That setting is fixed during online games.', 'info');
    if (revert) revert();
    return;
  }
  if (state.firstMove && !state.over) { apply(); return; }
  showConfirm('Restart the game?', msg + ' This starts a new game — continue?', apply, revert || (() => {}));
}

// Elevated play must hold for a whole game — toggling asks to restart.
document.getElementById('optZeroShort').addEventListener('change', (e) => {
  const now = e.target.checked;
  if (state.online.active) {
    e.target.checked = !now;
    setMessage('Elevated play is fixed once an online game starts.', 'info');
    return;
  }
  showConfirm(
    'Restart the game?',
    'Elevated play must be set for the whole game — turning it ' + (now ? 'ON' : 'OFF') +
      ' will restart the current game. Continue?',
    () => newGame(),
    () => { e.target.checked = !now; }
  );
});

// blank-tile picker
document.getElementById('blankGrid').addEventListener('click', (e) => {
  const b = e.target.closest('.blank-key');
  if (b) closeBlank(b.dataset.l);
});
document.getElementById('btnCloseBlank').addEventListener('click', () => closeBlank(null));
document.getElementById('blankModal').addEventListener('click', (e) => {
  if (e.target.id === 'blankModal') closeBlank(null);
});

// endgame + player count
document.getElementById('btnEndNew').addEventListener('click', () => {
  document.getElementById('endModal').classList.add('hidden');
  clearInterval(window.__danceTimer);
  onNewGameClicked();
});
const pcSel = document.getElementById('playerCount');
if (pcSel) pcSel.addEventListener('change', () => {
  const n = +pcSel.value, prev = state.players.length;
  applySetting('Playing with ' + n + ' players.',
    () => setPlayerCount(n),
    () => { pcSel.value = String(prev); });
});

// Custom bag size (tile count) — auto (by shape) or a fixed 1×/2×/3×.
const bagSel = document.getElementById('bagSizeSel');
if (bagSel) bagSel.addEventListener('change', () => {
  const v = bagSel.value;
  const prevVal = state.bagOverride ? String(state.bagOverride) : 'auto';
  applySetting('Changing the tile-bag size.',
    () => { state.bagOverride = v === 'auto' ? null : +v; newGame(); },
    () => { bagSel.value = prevVal; });
});

// Custom rack size (tiles per player).
const rackSel = document.getElementById('rackSizeSel');
if (rackSel) rackSel.addEventListener('change', () => {
  const n = Math.max(3, Math.min(12, +rackSel.value)), prev = RACK_SIZE;
  applySetting('Setting rack size to ' + n + ' tiles.',
    () => { RACK_SIZE = n; newGame(); },
    () => { rackSel.value = String(prev); });
});

const optVsAI = document.getElementById('optVsAI');
if (optVsAI) {
  optVsAI.addEventListener('change', () => {
    if (state.online.active) {
      optVsAI.checked = false;
      setMessage('Turn off online play to use the computer opponent.', 'info');
      return;
    }
    state.ai.enabled = optVsAI.checked;
    state.players[1].name = state.ai.enabled ? 'Computer' : 'Player 2';
    renderScoreboard();
    setMessage(state.ai.enabled ? 'Now playing vs the computer (Player 2).' : 'Computer opponent off.', 'info');
    afterTurn(); // in case it's already the computer's turn
  });
}
// ---- appearance & AI-skill preferences (persisted across sessions) ----
const PREFS_KEY = 'toroidal-scrabble-prefs-v1';
const TILE_FONTS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, "Segoe UI", Arial, sans-serif',
  rounded: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif',
  mono: '"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Mono", ui-monospace, "DejaVu Sans Mono", "Roboto Mono", Menlo, monospace',
  script: '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive',
};
function skillLabel(d) {
  return d < 0.2 ? 'Casual' : d < 0.4 ? 'Easy' : d < 0.65 ? 'Normal' : d < 0.85 ? 'Hard' : 'Max';
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      font: (document.getElementById('fontSel') || {}).value || 'mono',
      textSize: (document.getElementById('textSizeSel') || {}).value || 'md',
      difficulty: state.ai.difficulty,
    }));
  } catch (_) {}
}
function applyPrefs(p) {
  p = p || {};
  const fk = TILE_FONTS[p.font] ? p.font : 'mono'; // monospace is the default
  document.documentElement.style.setProperty('--tile-font', TILE_FONTS[fk]);
  if (typeof Board3D !== 'undefined' && Board3D.setFont) Board3D.setFont(TILE_FONTS[fk]);
  const fsel = document.getElementById('fontSel'); if (fsel) fsel.value = fk;

  const sz = ['sm', 'md', 'lg'].includes(p.textSize) ? p.textSize : 'md';
  document.body.classList.remove('ui-sm', 'ui-lg');
  if (sz === 'sm') document.body.classList.add('ui-sm');
  else if (sz === 'lg') document.body.classList.add('ui-lg');
  const tsel = document.getElementById('textSizeSel'); if (tsel) tsel.value = sz;

  if (typeof p.difficulty === 'number') {
    state.ai.difficulty = p.difficulty;
    const s = document.getElementById('aiDiff'); if (s) s.value = String(Math.round(p.difficulty * 100));
  }
  const lbl = document.getElementById('aiDiffLabel'); if (lbl) lbl.textContent = skillLabel(state.ai.difficulty);
}

const aiDiff = document.getElementById('aiDiff');
if (aiDiff) aiDiff.addEventListener('input', () => {
  state.ai.difficulty = +aiDiff.value / 100;
  const lbl = document.getElementById('aiDiffLabel'); if (lbl) lbl.textContent = skillLabel(state.ai.difficulty);
  savePrefs();
});
const fontSel = document.getElementById('fontSel');
if (fontSel) fontSel.addEventListener('change', () => {
  const f = TILE_FONTS[fontSel.value] || TILE_FONTS.serif;
  document.documentElement.style.setProperty('--tile-font', f);
  if (typeof Board3D !== 'undefined' && Board3D.setFont) Board3D.setFont(f);
  savePrefs();
});
const textSizeSel = document.getElementById('textSizeSel');
if (textSizeSel) textSizeSel.addEventListener('change', () => {
  document.body.classList.remove('ui-sm', 'ui-lg');
  if (textSizeSel.value === 'sm') document.body.classList.add('ui-sm');
  else if (textSizeSel.value === 'lg') document.body.classList.add('ui-lg');
  savePrefs();
});
// apply saved preferences at startup
applyPrefs((function () { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) { return {}; } })());

// turn timer
const optTimer = document.getElementById('optTimer');
const timerSecs = document.getElementById('timerSecs');
if (optTimer) {
  optTimer.addEventListener('change', () => {
    state.timer.enabled = optTimer.checked;
    if (timerSecs) state.timer.seconds = +timerSecs.value;
    startTurnTimer();
  });
}
if (timerSecs) {
  timerSecs.addEventListener('change', () => {
    state.timer.seconds = +timerSecs.value;
    if (state.timer.enabled) startTurnTimer();
  });
}

// screensaver (two computers auto-play)
const btnSS = document.getElementById('btnScreensaver');
if (btnSS) btnSS.addEventListener('click', startScreensaver);
const btnExitSS = document.getElementById('btnExitSS');
if (btnExitSS) btnExitSS.addEventListener('click', stopScreensaver);
const ssSpeed = document.getElementById('ssSpeed');
if (ssSpeed) {
  state.screensaver.delay = +ssSpeed.value;
  ssSpeed.addEventListener('input', () => { state.screensaver.delay = +ssSpeed.value; });
}

// tap-to-type: press a letter key to select that tile from your rack
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  if (state.over || isAiTurn() || (state.online.active && !isMyTurn())) return;
  if (!/^[a-zA-Z]$/.test(e.key)) return;
  const L = e.key.toUpperCase();
  const rack = state.players[rackOwnerIndex()].rack;
  const idx = rack.findIndex((tile, i) => !state.placedFromRack.has(i) && !tile.blank && tile.letter === L);
  if (idx >= 0) { state.selected = idx; renderRack(); }
});

const shapeSel = document.getElementById('shapeSel');
if (shapeSel) {
  shapeSel.addEventListener('change', (e) => {
    const s = e.target.value;
    const prev = Topo.shape;
    if (s === prev) return;
    if (state.online.active) {
      e.target.value = prev;
      setMessage('Board shape is fixed during online games.', 'info');
      return;
    }
    showConfirm(
      'Change board shape?',
      'Switching to the ' + (s === 'mobius' ? 'Möbius strip' : 'torus') +
        ' starts a new game. Continue?',
      () => setShape(s),
      () => { e.target.value = prev; }
    );
  });
}

document.getElementById('seamControls').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dr]');
  if (b) shiftView(+b.dataset.dr, +b.dataset.dc);
});

const ROLL_STEP = (2 * Math.PI) / COLS; // one column per press
function rollTube(delta) {
  if (typeof Board3D !== 'undefined' && Board3D.ready()) Board3D.rollTube(delta);
}
document.getElementById('rollCCW').addEventListener('click', () => rollTube(-ROLL_STEP));
document.getElementById('rollCW').addEventListener('click', () => rollTube(ROLL_STEP));

const btnMove = document.getElementById('btnMove');
if (btnMove) {
  btnMove.addEventListener('click', () => {
    const on = btnMove.classList.toggle('active');
    if (typeof Board3D !== 'undefined' && Board3D.setPanMode) Board3D.setPanMode(on);
    btnMove.textContent = on ? '✥ Moving…' : '✥ Move';
  });
}
const btnRecenter = document.getElementById('btnRecenter');
if (btnRecenter) {
  btnRecenter.addEventListener('click', () => {
    if (typeof Board3D !== 'undefined' && Board3D.recenter) Board3D.recenter();
  });
}
scoreboardEl.addEventListener('click', (e) => {
  const el = e.target.closest('.rename');
  if (el) renamePlayer(+el.dataset.i);
});

document.getElementById('btnSubmit').addEventListener('click', submitMove);
document.getElementById('btnRecall').addEventListener('click', recallOrCancel);
document.getElementById('btnShuffle').addEventListener('click', shuffleRack);
document.getElementById('btnChallenge').addEventListener('click', challengeWord);
document.getElementById('btnPass').addEventListener('click', passTurn);
document.getElementById('btnExchange').addEventListener('click', toggleExchange);
document.getElementById('btnNew').addEventListener('click', onNewGameClicked);

// Launch in the 3D donut, with a collapsible flat view alongside it.
init3D();
const flatView = document.getElementById('flatView');
if (flatView) {
  // Collapsed by default so the 3D launch stays scroll-free; expand any time.
  flatView.addEventListener('toggle', () => {
    if (flatView.open) fitBoard();
  });
}
// Resume the last game if one was saved (captured before newGame overwrites it).
const savedGame = loadSave();
newGame();
if (savedGame && savedGame.players && savedGame.board) {
  restoreGame(savedGame);
  renderAll();
}
loadDictionary();
setTimeout(fitBoard, 80);
window.addEventListener('resize', () => {
  fitBoard();
  if (typeof Board3D !== 'undefined' && Board3D.ready()) Board3D.resize();
});
