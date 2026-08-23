/* =========================================================================
 * gif.js — a tiny, self-contained animated GIF89a encoder (no dependencies).
 *
 *  - Fixed 256-colour RGB-3-3-2 palette (fast, no palette search needed).
 *  - Real LZW compression (variable code sizes), so a donut on a solid
 *    background compresses to a small file.
 *  - Frames are Uint8Array palette indices (one byte per pixel), same w×h.
 * ========================================================================= */
'use strict';

var GifEncoder = (function () {
  // 256-colour RGB332 palette (3 bits red, 3 green, 2 blue).
  function palette332() {
    const p = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const r = (i >> 5) & 7, g = (i >> 2) & 7, b = i & 3;
      p[i * 3] = Math.round((r * 255) / 7);
      p[i * 3 + 1] = Math.round((g * 255) / 7);
      p[i * 3 + 2] = Math.round((b * 255) / 3);
    }
    return p;
  }

  // RGBA pixels -> RGB332 palette indices.
  function quantize(rgba, out) {
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      out[j] = ((rgba[i] & 0xE0)) | ((rgba[i + 1] & 0xE0) >> 3) | ((rgba[i + 2] & 0xC0) >> 6);
    }
    return out;
  }

  // Standard GIF LZW compression of one frame's indices.
  function lzw(minCode, pixels) {
    const CLEAR = 1 << minCode;      // 256
    const END = CLEAR + 1;           // 257
    let codeSize = minCode + 1;      // 9
    let next = END + 1;              // 258
    let dict = new Map();
    const out = [];
    let cur = 0, bits = 0;
    function output(code) {
      cur |= code << bits;
      bits += codeSize;
      while (bits >= 8) { out.push(cur & 0xFF); cur >>= 8; bits -= 8; }
    }
    output(CLEAR);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
      } else {
        output(prefix);
        if (next < 4096) {
          dict.set(key, next++);
          if (next > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
          output(CLEAR);
          dict = new Map();
          codeSize = minCode + 1;
          next = END + 1;
        }
        prefix = k;
      }
    }
    output(prefix);
    output(END);
    if (bits > 0) out.push(cur & 0xFF);
    return out;
  }

  function encode(frames, w, h, delayCs) {
    const bytes = [];
    const u8 = (v) => bytes.push(v & 0xFF);
    const short = (v) => { bytes.push(v & 0xFF); bytes.push((v >> 8) & 0xFF); };
    const str = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };

    str('GIF89a');
    short(w); short(h);
    u8(0xF7);          // global colour table, 8-bit colour, 256 entries
    u8(0);             // background colour index
    u8(0);             // pixel aspect ratio
    const pal = palette332();
    for (let i = 0; i < 768; i++) u8(pal[i]);

    // NETSCAPE loop-forever extension
    u8(0x21); u8(0xFF); u8(0x0B); str('NETSCAPE2.0'); u8(0x03); u8(0x01); short(0); u8(0x00);

    for (const frame of frames) {
      u8(0x21); u8(0xF9); u8(0x04); u8(0x00); short(delayCs); u8(0x00); u8(0x00); // graphic control
      u8(0x2C); short(0); short(0); short(w); short(h); u8(0x00);                 // image descriptor
      const minCode = 8;
      u8(minCode);
      const data = lzw(minCode, frame);
      for (let i = 0; i < data.length;) {
        const n = Math.min(255, data.length - i);
        u8(n);
        for (let j = 0; j < n; j++) u8(data[i + j]);
        i += n;
      }
      u8(0x00); // block terminator
    }
    u8(0x3B); // trailer
    return new Uint8Array(bytes);
  }

  return { quantize, encode };
})();
