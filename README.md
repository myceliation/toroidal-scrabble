# Toroidal Scrabble

A floating **toroidal** Scrabble variant. Two standard Scrabble boards are fused
top-to-bottom into a single 15×30 surface that wraps on **both** axes — a torus
(a rectangle with both edge-pairs glued). Words can run off any edge and continue
on the opposite side. The tile bag is **doubled** to 200 tiles to match the
doubled playing area.

Built with plain HTML/CSS/JavaScript — no build step, no dependencies. Uses the
public-domain **ENABLE** word list for dictionary validation.

## How it differs from standard Scrabble

- **3D torus board.** The 15×30 grid is mapped onto a real, draggable donut
  (Three.js) floating in space — drag to rotate, scroll to zoom, click a square
  to place. A toolbar button flips between the 3D donut and a flat 2D grid.
- **Toroidal board.** 15 wide × 30 tall (two 15×15 boards stacked). Column 14 is
  adjacent to column 0, and row 29 is adjacent to row 0. Words wrap around edges.
- **Two centres.** Each half keeps the classic premium layout, so there are two
  ★ start squares. The opening move must cover one of them.
- **Doubled bag.** 200 tiles (2× the standard distribution) instead of 100.
- **Floating in space.** A twinkling starfield backdrop, with a draggable **sun**
  and **moon**. Tap one to switch daylight/night; drag it across the sky to shine
  the light on the part of the board you want to see (night casts a tight
  spotlight, daylight lights the whole board).
- **2- & 3-letter word helper.** A searchable reference lists every legal 2- and
  3-letter word, and an optional **trainer mode** makes those short words score 0
  — they still open the board, but knowing them no longer inflates the score.
- **Editable names.** Click a player's name in the scoreboard to rename them
  (syncs to your opponent in online play).
- **Touch + desktop.** Plays with taps on phones/tablets and clicks on desktop;
  the sun/moon and the donut all drag with mouse or finger (Pointer Events).
- Everything else follows Scrabble rules: letter/word premiums (only under
  newly-placed tiles), cross-word validation, blanks (score 0), a 50-point bingo
  for using all 7 tiles, and endgame rack-value adjustments.

## Running it

The dictionary is baked into `js/dictionary.js`, so **no server is needed** —
just **double-click `index.html`** (or open it in any browser). Everything runs
locally from `file://`.

If you'd rather serve it over HTTP (optional), from the `toroidal-scrabble`
folder run `python -m http.server 8000` (or `npx serve -l 8000`) and open
<http://127.0.0.1:8000/>. Online play needs internet either way.

## How to play

- Click a tile in your rack to select it, then click a board square to place it.
  In the 3D donut view, **drag** to rotate and **scroll** to zoom; the hovered
  square highlights so you can aim. Use the toolbar button to switch to flat 2D.
- Click a placed (glowing) tile to send it back to your rack.
- Blank tiles ask which letter they represent when placed.
- **Submit word** validates and scores the move; **Recall / cancel** returns
  pending tiles; **Shuffle** reorders your rack; **Exchange** swaps tiles for new
  ones (a scoreless turn); **Pass** skips your turn; **New game** restarts.
- Two-player hot-seat on one screen. The active player is highlighted; the rack
  shows whoever's turn it is.

## Playing against a friend (online, P2P)

No server to run — it uses **WebRTC** peer-to-peer via PeerJS's free public
broker (which only helps the two browsers find each other; the actual game data
goes directly between you).

1. One player clicks **Host game** and reads out the 5-character **room code**.
2. The other clicks **Join game**, types the code, and hits **Connect**.
3. You now play on separate devices. The host is Player 1 and moves first.

The **host is authoritative** — it owns the bag, board and both racks — so each
of you only ever sees your **own** tiles. Everything (words, blanks, exchanges,
passes, scoring, endgame) syncs automatically after each move.

Caveats: both devices need internet; some strict corporate/school firewalls
block WebRTC; and the free public broker is best-effort (fine for casual play).
If a connection can't be made, fall back to hot-seat on one device.

## Files

```
index.html          page shell + layout
styles.css          space / floating-donut styling
data/enable1.txt    ENABLE dictionary source (public domain)
js/dictionary.js    the dictionary baked into a script (so no server is needed)
js/data.js          tile values, distribution, premium layout, board size
js/engine.js        pure toroidal move validation + scoring (+ trainer rule)
js/board3d.js       3D torus view (Three.js): canvas-texture board + raycast picking
js/app.js           game state, rendering, interaction, word-list helper, P2P sync
js/net.js           WebRTC lobby + transport (host/join room codes)
js/sky.js           starfield + draggable sun/moon lighting (drives 3D lights)
js/vendor/three.min.js    Three.js r128 (MIT), vendored locally
js/vendor/peerjs.min.js   PeerJS (MIT), vendored locally
```

## Credits / open-source data

- **ENABLE** word list — public domain (via <https://norvig.com/ngrams/enable1.txt>).
- **PeerJS** — MIT-licensed WebRTC library (<https://peerjs.com>), vendored in `js/vendor/`.
- **Three.js** — MIT-licensed 3D library (<https://threejs.org>), vendored in `js/vendor/`.
- Scrabble letter values and tile frequencies are the standard English set
  (game facts, used here for an original toroidal variant).
