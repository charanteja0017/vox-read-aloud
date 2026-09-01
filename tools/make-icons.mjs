/* Generates the extension icons: a rounded amber tile with a waveform.
   Rendered at 4x and box-downsampled so the edges stay clean at 16px. */
import zlib from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";

const SS = 4; // supersample factor

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function roundedRectSDF(x, y, w, h, r) {
  const dx = Math.abs(x - w / 2) - (w / 2 - r);
  const dy = Math.abs(y - h / 2) - (h / 2 - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function render(size) {
  const S = size * SS;
  const buf = new Float32Array(S * S * 4);

  const tileR = S * 0.235;
  // Waveform bars, as fractions of the tile.
  const bars = [
    { c: 0.185, h: 0.30 },
    { c: 0.345, h: 0.56 },
    { c: 0.505, h: 0.86 },
    { c: 0.665, h: 0.50 },
    { c: 0.825, h: 0.24 },
  ];
  const barW = S * 0.098;
  const barR = barW / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      const i = (y * S + x) * 4;

      const tile = clamp01(0.5 - roundedRectSDF(px, py, S, S, tileR));
      if (tile <= 0) continue;

      // Amber gradient, brighter at the top-left.
      const t = clamp01((px * 0.55 + py * 0.85) / (S * 1.25));
      let r = 255 * (1 - t) + 245 * t;
      let g = 216 * (1 - t) + 166 * t;
      let b = 84 * (1 - t) + 35 * t;

      let ink = 0;
      for (const bar of bars) {
        const cx = S * bar.c, h = S * bar.h;
        const d = roundedRectSDF(px - (cx - barW / 2), py - (S - h) / 2, barW, h, barR);
        ink = Math.max(ink, clamp01(0.5 - d));
      }
      if (ink > 0) {
        r = r * (1 - ink) + 22 * ink;
        g = g * (1 - ink) + 26 * ink;
        b = b * (1 - ink) + 34 * ink;
      }

      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255 * tile;
    }
  }

  // Box downsample with premultiplied alpha so edges don't fringe.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          const alpha = buf[i + 3] / 255;
          r += buf[i] * alpha; g += buf[i + 1] * alpha; b += buf[i + 2] * alpha; a += alpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePNG(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(new URL("../src/icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(render(size), size);
  await writeFile(new URL(`../src/icons/icon${size}.png`, import.meta.url), png);
  console.log(`  icon${size}.png  ${png.length} bytes`);
}
