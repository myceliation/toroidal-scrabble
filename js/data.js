/* =========================================================================
 * data.js — static game data for Toroidal Scrabble
 *
 * Open-source / public-domain building blocks:
 *   - Letter values & tile distribution: standard English Scrabble (public
 *     domain rules; the tile frequencies are facts, not copyrighted content).
 *   - Premium-square layout: the classic 15x15 board, stamped onto each half.
 *   - Dictionary: ENABLE word list (public domain), loaded from data/enable1.txt
 * ========================================================================= */

'use strict';

/* Board dimensions: two 15x15 boards stacked => 15 wide x 30 tall.
 * The surface is a TORUS: column 14 is adjacent to column 0, and
 * row 29 is adjacent to row 0. Both edge pairs are glued. */
const COLS = 15;
const ROWS = 30;
let RACK_SIZE = 7; // mutable: customizable rack size (default 7)

/* "Double the available letters" — two full standard bags. */
const TILE_MULTIPLIER = 2;

/* Standard English Scrabble letter values ('_' is a blank tile). */
const LETTER_VALUES = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1,
  J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1,
  S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10, _: 0,
};

/* Standard 100-tile distribution (doubled at bag-build time). */
const BASE_DISTRIBUTION = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9,
  J: 1, K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6,
  S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1, _: 2,
};

/* One standard 15x15 premium layout.
 *   TW = triple word, DW = double word, TL = triple letter,
 *   DL = double letter, ST = start square (scores as a double word),
 *   .  = plain square. */
const STD_PREMIUM = [
  'TW .  .  DL .  .  .  TW .  .  .  DL .  .  TW',
  '.  DW .  .  .  TL .  .  .  TL .  .  .  DW .',
  '.  .  DW .  .  .  DL .  DL .  .  .  DW .  .',
  'DL .  .  DW .  .  .  DL .  .  .  DW .  .  DL',
  '.  .  .  .  DW .  .  .  .  .  DW .  .  .  .',
  '.  TL .  .  .  TL .  .  .  TL .  .  .  TL .',
  '.  .  DL .  .  .  DL .  DL .  .  .  DL .  .',
  'TW .  .  DL .  .  .  ST .  .  .  DL .  .  TW',
  '.  .  DL .  .  .  DL .  DL .  .  .  DL .  .',
  '.  TL .  .  .  TL .  .  .  TL .  .  .  TL .',
  '.  .  .  .  DW .  .  .  .  .  DW .  .  .  .',
  'DL .  .  DW .  .  .  DL .  .  .  DW .  .  DL',
  '.  .  DW .  .  .  DL .  DL .  .  .  DW .  .',
  '.  DW .  .  .  TL .  .  .  TL .  .  .  DW .',
  'TW .  .  DL .  .  .  TW .  .  .  DL .  .  TW',
];

/* Expand the single-board template into the full 15x30 torus grid.
 * PREMIUM[r][c] is '' | 'TW' | 'DW' | 'TL' | 'DL' | 'ST'. */
const PREMIUM = (function buildPremium() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const tokens = STD_PREMIUM[r % 15].trim().split(/\s+/);
    grid.push(tokens.map((t) => (t === '.' ? '' : t)));
  }
  return grid;
})();

/* Human-readable labels shown on empty premium squares. */
const PREMIUM_LABEL = { TW: 'TW', DW: 'DW', TL: 'TL', DL: 'DL', ST: '★' };

/* Valid short words missing from the public-domain ENABLE list (ENABLE predates
 * several modern additions). These are facts (word validity), added on load.
 * Note: the current official lists (NWL/Collins) are copyrighted and can't be
 * redistributed here — this supplements ENABLE with the well-known gaps. */
const DICT_SUPPLEMENT = [
  // The complete official (NWL2020) 2-letter word list — guarantees full
  // coverage regardless of ENABLE's gaps (verified: only "oi" was missing).
  'aa', 'ab', 'ad', 'ae', 'ag', 'ah', 'ai', 'al', 'am', 'an', 'ar', 'as', 'at', 'aw', 'ax', 'ay',
  'ba', 'be', 'bi', 'bo', 'by', 'da', 'de', 'do', 'ed', 'ef', 'eh', 'el', 'em', 'en', 'er', 'es',
  'et', 'ew', 'ex', 'fa', 'fe', 'gi', 'go', 'ha', 'he', 'hi', 'hm', 'ho', 'id', 'if', 'in', 'is',
  'it', 'jo', 'ka', 'ki', 'la', 'li', 'lo', 'ma', 'me', 'mi', 'mm', 'mo', 'mu', 'my', 'na', 'ne',
  'no', 'nu', 'od', 'oe', 'of', 'oh', 'oi', 'ok', 'om', 'on', 'oo', 'op', 'or', 'os', 'ow', 'ox',
  'oy', 'pa', 'pe', 'pi', 'po', 'qi', 're', 'sh', 'si', 'so', 'ta', 'te', 'ti', 'to', 'uh', 'um',
  'un', 'up', 'ur', 'us', 'ut', 'we', 'wo', 'xi', 'xu', 'ya', 'ye', 'yo', 'za', 'zo',
  // common short-word inflections + a few other frequently-missed words
  'qis', 'zas', 'zos', 'kis', 'fes', 'gis', 'pos', 'tes', 'oks', 'ois',
  'zen', 'zin', 'cig', 'vid', 'sez', 'wuz', 'qat', 'suq', 'zek', 'zoa', 'meh', 'nah', 'heh',
];

/* Board topology — how the edges connect. Torus wraps both axes. Möbius wraps
 * the long axis (rows) with a half-twist (the column is flipped at the seam)
 * and leaves the short axis (columns) as free strip edges.
 * step(r,c,dir,sign) returns the next cell {r,c} or null at a boundary.
 * dir 'H' varies the column (across); dir 'V' varies the row (down). */
const Topo = {
  shape: 'torus',
  step(r, c, dir, sign) {
    if (this.shape === 'mobius') {
      if (dir === 'H') {
        const nc = c + sign;
        return nc < 0 || nc >= COLS ? null : { r, c: nc }; // bounded width
      }
      let nr = r + sign;
      let cc = c;
      if (nr >= ROWS) { nr = 0; cc = COLS - 1 - c; }        // half-twist seam
      else if (nr < 0) { nr = ROWS - 1; cc = COLS - 1 - c; }
      return { r: nr, c: cc };
    }
    // torus: both axes wrap
    if (dir === 'H') return { r, c: ((c + sign) % COLS + COLS) % COLS };
    return { r: ((r + sign) % ROWS + ROWS) % ROWS, c };
  },
};

/* Map "r,c" -> key string helper, used across engine + app. */
function keyOf(r, c) {
  return r + ',' + c;
}
