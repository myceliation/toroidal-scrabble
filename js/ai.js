/* =========================================================================
 * ai.js — a computer opponent. It's a bounded greedy move generator, not a
 * perfect solver: it forms words from its rack, tries to place them at valid
 * anchor points on the board (works for torus OR Möbius via Topo.step), asks
 * the real engine to validate + score them, and picks by difficulty.
 * ========================================================================= */

'use strict';

const AI = (function () {
  // All dictionary words (2..rack length) that can be built from the rack
  // (blanks are wild). Returned uppercase.
  function rackAnagrams(rack, dict) {
    const avail = {};
    let blanks = 0;
    for (const t of rack) {
      if (t.blank) blanks++;
      else { const c = t.letter.toLowerCase(); avail[c] = (avail[c] || 0) + 1; }
    }
    const maxLen = rack.length;
    const out = [];
    for (const w of dict) {
      const L = w.length;
      if (L < 2 || L > maxLen) continue;
      const cnt = {};
      for (let i = 0; i < L; i++) cnt[w[i]] = (cnt[w[i]] || 0) + 1;
      let deficit = 0;
      for (const c in cnt) {
        const have = avail[c] || 0;
        if (cnt[c] > have) { deficit += cnt[c] - have; if (deficit > blanks) break; }
      }
      if (deficit <= blanks) out.push(w.toUpperCase());
    }
    return out;
  }

  // Map each letter of `word` to a rack tile (exact first, then blanks).
  function assignTiles(word, rack) {
    const used = new Array(rack.length).fill(false);
    const res = new Array(word.length).fill(null);
    for (let k = 0; k < word.length; k++) {
      for (let i = 0; i < rack.length; i++) {
        if (!used[i] && !rack[i].blank && rack[i].letter === word[k]) {
          used[i] = true; res[k] = { letter: word[k], blank: false, rackIndex: i }; break;
        }
      }
    }
    for (let k = 0; k < word.length; k++) {
      if (res[k]) continue;
      let ok = false;
      for (let i = 0; i < rack.length; i++) {
        if (!used[i] && rack[i].blank) { used[i] = true; res[k] = { letter: word[k], blank: true, rackIndex: i }; ok = true; break; }
      }
      if (!ok) return null;
    }
    return res;
  }

  // Cells of a length-`len` word laid along `dir` with position k on `anchor`.
  function lineCells(anchor, dir, k, len) {
    let r = anchor.r, c = anchor.c;
    for (let i = 0; i < k; i++) { const p = Topo.step(r, c, dir, -1); if (!p) return null; r = p.r; c = p.c; }
    const cells = [{ r, c }];
    for (let i = 1; i < len; i++) { const p = Topo.step(r, c, dir, 1); if (!p) return null; r = p.r; c = p.c; cells.push({ r, c }); }
    return cells;
  }

  function startAnchors() {
    const a = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (PREMIUM[r][c] === 'ST') a.push({ r, c });
    return a;
  }
  function boardAnchors(board) {
    const a = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (board[r][c]) continue;
      let adj = false;
      for (const dir of ['H', 'V']) for (const s of [1, -1]) {
        const p = Topo.step(r, c, dir, s);
        if (p && board[p.r][p.c]) { adj = true; }
      }
      if (adj) a.push({ r, c });
    }
    return a;
  }

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // difficulty in [0,1]: 1 = always the top-scoring play; 0 = anything (often
  // short/fun words). Returns { placements, words, score } or null.
  function chooseMove(board, rack, firstMove, dict, difficulty) {
    if (!dict) return null;
    let words = rackAnagrams(rack, dict);
    words.sort((a, b) => b.length - a.length); // try high-value (long) first
    if (words.length > 160) words = words.slice(0, 160);
    let anchors = firstMove ? startAnchors() : boardAnchors(board);
    if (anchors.length > 90) anchors = anchors.slice(0, 90);

    const moves = [];
    const seen = new Set();
    const t0 = now();
    let stop = false;

    for (const word of words) {
      if (stop) break;
      const assign = assignTiles(word, rack); // same for every placement
      if (!assign) continue;
      for (const dir of ['H', 'V']) {
        if (stop) break;
        for (const anchor of anchors) {
          if (stop) break;
          for (let k = 0; k < word.length; k++) {
            const cells = lineCells(anchor, dir, k, word.length);
            if (!cells) continue;
            let allEmpty = true;
            let key = word + '|' + dir;
            for (const cell of cells) {
              if (board[cell.r][cell.c]) { allEmpty = false; break; }
              key += ' ' + cell.r + ',' + cell.c;
            }
            if (!allEmpty || seen.has(key)) continue;
            seen.add(key);
            const pending = new Map();
            for (let m = 0; m < cells.length; m++) {
              pending.set(keyOf(cells[m].r, cells[m].c), { letter: assign[m].letter, blank: assign[m].blank });
            }
            const res = Engine.validateMove(board, pending, firstMove, dict, { requireDictionary: true });
            if (res.ok) {
              moves.push({
                placements: cells.map((c2, m) => ({
                  r: c2.r, c: c2.c, letter: assign[m].letter, blank: assign[m].blank, rackIndex: assign[m].rackIndex,
                })),
                words: res.words,
                score: res.total,
              });
            }
            if (moves.length > 400 || now() - t0 > 280) { stop = true; break; }
          }
        }
      }
    }

    if (!moves.length) return null;
    moves.sort((a, b) => b.score - a.score);
    const n = moves.length;
    const d = Math.max(0, Math.min(1, difficulty));
    let idx = Math.floor((1 - d) * Math.random() * n);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    return moves[idx];
  }

  return { chooseMove };
})();
