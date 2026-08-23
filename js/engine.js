/* =========================================================================
 * engine.js — pure game logic for Toroidal Scrabble
 *
 * Everything here is side-effect free: it reads the committed board plus the
 * pending placements and returns a validation/scoring result. All coordinate
 * math wraps toroidally, so a word can run off one edge and continue on the
 * opposite side.
 * ========================================================================= */

'use strict';

const Engine = {
  /* Toroidal coordinate normalisation. */
  nr(r) {
    return ((r % ROWS) + ROWS) % ROWS;
  },
  nc(c) {
    return ((c % COLS) + COLS) % COLS;
  },

  /* Return the maximal contiguous run of filled cells through (r0,c0) in the
   * given direction ('H' varies column, 'V' varies row), as an ordered list
   * of {r,c}. Wrapping is handled; a fully-filled ring stops cleanly instead
   * of looping forever. `filledAt(r,c)` reports whether a cell holds a tile. */
  collectRun(r0, c0, dir, filledAt) {
    if (!filledAt(r0, c0)) return [];
    // Generous bound: a Möbius line can double-cover before returning to start.
    const maxSteps = (dir === 'H' ? COLS : ROWS) * 2 + 2;

    // Walk backwards to the start of the run (topology-aware via Topo.step).
    let sr = r0;
    let sc = c0;
    for (let i = 0; i < maxSteps; i++) {
      const p = Topo.step(sr, sc, dir, -1);
      if (!p) break; // free boundary (e.g. Möbius strip edge)
      if (p.r === r0 && p.c === c0) break; // full loop — stop at origin
      if (filledAt(p.r, p.c)) { sr = p.r; sc = p.c; } else break;
    }

    // Walk forwards collecting cells.
    const cells = [];
    let cr = sr;
    let cc = sc;
    for (let i = 0; i < maxSteps; i++) {
      if (!filledAt(cr, cc)) break;
      cells.push({ r: cr, c: cc });
      const p = Topo.step(cr, cc, dir, +1);
      if (!p) break;
      if (p.r === sr && p.c === sc) break; // looped back to start
      cr = p.r;
      cc = p.c;
    }
    return cells;
  },

  /* Validate + score a move.
   *   board   : ROWS x COLS array of committed tiles ({letter,blank} | null)
   *   pending : Map "r,c" -> {letter, blank}   (this turn's placements)
   *   firstMove : boolean
   *   dict    : Set of lowercase valid words
   *   opts    : { zeroShortWords:boolean } — score words of length <=3 as 0
   * Returns { ok:true, words:[{text,score}], total, bingo } on success,
   * or { ok:false, error } describing why the move is illegal. */
  validateMove(board, pending, firstMove, dict, opts) {
    opts = opts || {};
    const placements = [...pending.entries()].map(([k, v]) => {
      const [r, c] = k.split(',').map(Number);
      return { r, c, letter: v.letter, blank: v.blank };
    });
    if (placements.length === 0) {
      return { ok: false, error: 'Place at least one tile on the board.' };
    }

    const filledAt = (r, c) => board[r][c] !== null || pending.has(keyOf(r, c));
    const isNew = (r, c) => pending.has(keyOf(r, c));
    const letterAt = (r, c) => {
      const p = pending.get(keyOf(r, c));
      if (p) return p.letter;
      const b = board[r][c];
      return b ? b.letter : null;
    };
    const blankAt = (r, c) => {
      const p = pending.get(keyOf(r, c));
      if (p) return p.blank;
      const b = board[r][c];
      return b ? b.blank : false;
    };

    // Determine the line the tiles lie on by which axis-run contains them all.
    // (Works for any topology, incl. Möbius words that flip across the seam.)
    let mainDir = null;
    if (placements.length === 1) {
      mainDir = 'single';
    } else {
      const a = placements[0];
      const inRun = (d) => {
        const set = new Set(this.collectRun(a.r, a.c, d, filledAt).map((x) => keyOf(x.r, x.c)));
        return placements.every((p) => set.has(keyOf(p.r, p.c)));
      };
      if (inRun('H')) mainDir = 'H';
      else if (inRun('V')) mainDir = 'V';
      else {
        return {
          ok: false,
          error: 'All placed tiles must lie in a single line (with no gaps).',
        };
      }
    }

    // Gather every word (contiguous run of length >= 2) touched by the move.
    const words = [];
    const pushWord = (cells) => {
      if (cells.length >= 2) words.push(cells);
    };

    if (mainDir === 'single') {
      const p = placements[0];
      pushWord(this.collectRun(p.r, p.c, 'H', filledAt));
      pushWord(this.collectRun(p.r, p.c, 'V', filledAt));
    } else {
      const anchor = placements[0];
      const main = this.collectRun(anchor.r, anchor.c, mainDir, filledAt);
      const mainSet = new Set(main.map((x) => keyOf(x.r, x.c)));
      for (const p of placements) {
        if (!mainSet.has(keyOf(p.r, p.c))) {
          return {
            ok: false,
            error: 'Placed tiles are not contiguous — there is a gap in the line.',
          };
        }
      }
      pushWord(main);
      const crossDir = mainDir === 'H' ? 'V' : 'H';
      for (const p of placements) {
        pushWord(this.collectRun(p.r, p.c, crossDir, filledAt));
      }
    }

    if (words.length === 0) {
      return {
        ok: false,
        error: 'A move must form at least one word of two or more letters.',
      };
    }

    // Connectivity rules.
    if (firstMove) {
      const onStart = placements.some((p) => PREMIUM[p.r][p.c] === 'ST');
      if (!onStart) {
        return {
          ok: false,
          error: 'The opening move must cover a start ★ square (either board centre).',
        };
      }
    } else {
      const touchesExisting = words.some((cells) =>
        cells.some(({ r, c }) => !isNew(r, c))
      );
      // You may also start a fresh, unconnected cluster on a ★ start square
      // (e.g. the other centre) — but it earns no double-word bonus (below).
      const onStart = placements.some((p) => PREMIUM[p.r][p.c] === 'ST');
      if (!touchesExisting && !onStart) {
        return {
          ok: false,
          error: 'Your move must connect to existing tiles (or start a new cluster on a ★ square).',
        };
      }
    }

    // Build word strings. The dictionary is only enforced when requested
    // (challenge model: players may lay invalid words and be challenged).
    const built = words.map((cells) => ({
      cells,
      text: cells.map(({ r, c }) => letterAt(r, c)).join(''),
    }));
    if (opts.requireDictionary) {
      const bad = built.filter((w) => !dict.has(w.text.toLowerCase()));
      if (bad.length) {
        const list = [...new Set(bad.map((w) => w.text))].join(', ');
        return { ok: false, error: 'Not in dictionary: ' + list };
      }
    }

    // Score every formed word. Premiums apply only under tiles placed this
    // turn; a new tile's letter/word premium counts in each word it joins.
    let total = 0;
    let wordBonus = 0;
    const scored = [];
    for (const w of built) {
      let wordScore = 0;
      let wordMult = 1;
      for (const { r, c } of w.cells) {
        let val = blankAt(r, c) ? 0 : LETTER_VALUES[letterAt(r, c)] || 0;
        if (isNew(r, c)) {
          const pr = PREMIUM[r][c];
          if (pr === 'DL') val *= 2;
          else if (pr === 'TL') val *= 3;
          else if (pr === 'DW') wordMult *= 2;
          else if (pr === 'TW') wordMult *= 3;
          else if (pr === 'ST' && firstMove) wordMult *= 2; // ★ bonus: opening move only
        }
        wordScore += val;
      }
      wordScore *= wordMult;
      // Optional trainer rule: 2- and 3-letter words score nothing. Knowing
      // them is a big skill boost, so this keeps them useful for opening the
      // board without inflating the score.
      if (opts.zeroShortWords && w.cells.length <= 3) wordScore = 0;

      // Palindrome / reversible-word bonus (4+ letter words only), marked per
      // word so the UI can flag them.
      let bonus = 0;
      let kind = null;
      if (w.cells.length >= 4) {
        const up = w.text.toUpperCase();
        const rev = up.split('').reverse().join('');
        if (up === rev) { bonus = 20; kind = 'palindrome'; } // reads the same both ways
        else if (dict.has(rev.toLowerCase())) { bonus = 5; kind = 'reversible'; } // valid backwards too
      }
      wordBonus += bonus;
      total += wordScore;
      scored.push({ text: w.text, score: wordScore, bonus, kind });
    }
    total += wordBonus;

    // Bingo: all 7 tiles from the rack in one move.
    const bingo = placements.length === RACK_SIZE;
    if (bingo) total += 50;

    return { ok: true, words: scored, total, bingo, wordBonus };
  },
};
