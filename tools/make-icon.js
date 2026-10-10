/* Optima icon maker: draws an app icon in the Optima Machina style. A rounded-square key of
   off-white plastic, and on it a glyph made only of light and shadow: shapes pressed into the
   plastic or raised out of it, filled with the one Optima blue so it still reads at 16 px. Lit from the top left exactly like the
   site's CSS (a white highlight up-left, a warm shadow down-right), so icons and UI match.

   How it works: everything is a height map (the key's face = 1, a pressed shape lower, a raised
   one higher). Each pixel compares itself with the blurred height a little up-left (shadow) and a
   little down-right (highlight). That is the two-box-shadow neumorphic look, computed for any shape.

   Use: edit GLYPH below, then   node tools/make-icon.js [outDir]
   Writes the extension's icon16/32/48/128.png and icon-512.png (the website's shelf slot). */
'use strict';

const fs = require('fs'), path = require('path'), zlib = require('zlib');

// ------------------------------------------------------------------ the glyph (edit this per app)
// Coordinates are on a 1024 canvas; the key's face spans roughly 70..954. depth < 0 presses into
// the plastic, depth > 0 raises out of it. Keep it to a few bold shapes: it has to read at 16 px.
const NAME = 'Optima Time Machine';
function GLYPH(rect, tri) {
  // a play button pressed into the plastic, its corners softened; nudged right
  // of centre the way a play triangle sits optically
  const cx = 512, cy = 496, h = 470, w = h * 0.88, nudge = w * 0.08;
  tri([[cx - w / 2 + nudge, cy - h / 2], [cx - w / 2 + nudge, cy + h / 2], [cx + w / 2 + nudge, cy]], 52, -0.5);
}

// ------------------------------------------------------------------ the style (same for every app)

const N = 1024;
const PLASTIC_HI = [0xf1, 0xed, 0xe8], PLASTIC_LO = [0xd8, 0xd2, 0xc9];   // site: --plastic-hi / --plastic-lo
const SHADOW = [0x9e, 0x93, 0x85], WHITE = [255, 255, 255];                // site: --lo (158,147,133) / --hi
const INK = [0x2a, 0x47, 0xc4];                                            // site: --blue, the glyph's fill
const KEY = { cx: 512, cy: 496, half: 444, r: 236, bevel: 40 };
const LIGHT = 26, SOFT = 22;      // how far the light reaches (offset) and how soft the shadows are (blur)

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function sdRound(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdTriangle(px, py, P) {
  const [[x0, y0], [x1, y1], [x2, y2]] = P;
  const e = [[x1 - x0, y1 - y0], [x2 - x1, y2 - y1], [x0 - x2, y0 - y2]];
  const v = [[px - x0, py - y0], [px - x1, py - y1], [px - x2, py - y2]];
  const s0 = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  let d = Infinity, sg = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = Math.min(1, Math.max(0, (v[k][0] * e[k][0] + v[k][1] * e[k][1]) / (e[k][0] ** 2 + e[k][1] ** 2)));
    const qx = v[k][0] - e[k][0] * t, qy = v[k][1] - e[k][1] * t;
    d = Math.min(d, qx * qx + qy * qy);
    sg = Math.min(sg, s0 * (v[k][0] * e[k][1] - v[k][1] * e[k][0]));
  }
  return -Math.sqrt(d) * Math.sign(sg);
}

function heightMap() {
  const H = new Float32Array(N * N), A = new Float32Array(N * N), G = new Float32Array(N * N); // G: glyph coverage
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const d = sdRound(x + 0.5, y + 0.5, KEY.cx, KEY.cy, KEY.half, KEY.half, KEY.r);
    A[y * N + x] = Math.min(1, Math.max(0, 0.5 - d));
    H[y * N + x] = smooth(0, KEY.bevel, -d);                       // a rounded bevel up onto the face
  }
  GLYPH((x, y, w, h, r, depth) => {
    const cx = x + w / 2, cy = y + h / 2;
    for (let j = Math.max(0, Math.floor(y - 12)); j < Math.min(N, Math.ceil(y + h + 12)); j++)
      for (let i = Math.max(0, Math.floor(x - 12)); i < Math.min(N, Math.ceil(x + w + 12)); i++) {
        const d = sdRound(i + 0.5, j + 0.5, cx, cy, w / 2, h / 2, r);
        H[j * N + i] += depth * smooth(0, 10, -d);                  // soft-walled tile
        G[j * N + i] = Math.max(G[j * N + i], smooth(-1.5, 1.5, -d));
      }
  }, (pts, r, depth) => {                                           // a triangle with rounded corners
    // shrink toward the centre by r, then round by r, so the outer size stays put
    const gx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, gy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    const inner = pts.map(([px, py]) => { const dx = px - gx, dy = py - gy, l = Math.hypot(dx, dy); return [px - dx / l * r * 2, py - dy / l * r * 2]; });
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    for (let j = Math.max(0, Math.floor(Math.min(...ys) - 12)); j < Math.min(N, Math.ceil(Math.max(...ys) + 12)); j++)
      for (let i = Math.max(0, Math.floor(Math.min(...xs) - 12)); i < Math.min(N, Math.ceil(Math.max(...xs) + 12)); i++) {
        const d = sdTriangle(i + 0.5, j + 0.5, inner) - r;
        H[j * N + i] += depth * smooth(0, 10, -d);
        G[j * N + i] = Math.max(G[j * N + i], smooth(-1.5, 1.5, -d));
      }
  });
  return { H, A, G };
}

function blur(src, r) { // three box passes per axis, about a gaussian
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) for (const horiz of [true, false]) {
    for (let k = 0; k < N; k++) {
      let acc = 0;
      const get = i => a[horiz ? k * N + Math.min(N - 1, Math.max(0, i)) : Math.min(N - 1, Math.max(0, i)) * N + k];
      for (let i = -r; i <= r; i++) acc += get(i);
      for (let i = 0; i < N; i++) {
        b[horiz ? k * N + i : i * N + k] = acc / (2 * r + 1);
        acc += get(i + r + 1) - get(i - r);
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

function renderMaster() {
  const { H, A, G } = heightMap(), Hb = blur(H, SOFT), px = new Float32Array(N * N * 5);
  const at = (x, y) => Hb[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, h = H[i];
    const sh = Math.max(0, at(x - LIGHT, y - LIGHT) - h);           // something higher up-left: in its shadow
    const hl = Math.max(0, at(x + LIGHT, y + LIGHT) - h);           // something higher down-right: catches the light
    const t = (x + y) / (2 * N);
    let c = PLASTIC_HI.map((v, k) => v + (PLASTIC_LO[k] - v) * t);
    c = c.map((v, k) => v + (INK[k] - v) * G[i]);                    // the glyph is blue plastic
    const ks = Math.min(1, sh * 1.5), kh = Math.min(1, hl * 1.3);
    c = c.map((v, k) => v + (SHADOW[k] - v) * ks * 0.85);
    c = c.map((v, k) => v + (WHITE[k] - v) * kh * 0.9);
    let a = A[i];
    if (a < 1) { // outside the key: only its soft shadow falls on the desktop
      const cast = Math.min(1, Math.max(0, at(x - LIGHT, y - LIGHT) - 0) * 0.55);
      const out = cast * (1 - a);
      const na = a + out;
      c = na > 0 ? c.map((v, k) => (v * a + SHADOW[k] * 0.75 * out) / na) : c;
      a = na;
    }
    px.set([c[0], c[1], c[2], a, G[i]], i * 5);
  }
  return px;
}

// area-average down to `size`; small sizes get their light and shadow pushed so the glyph still reads
function downsample(master, size) {
  const k = N / size, out = Buffer.alloc(size * size * 4), boost = size <= 48 ? 1.7 : size <= 64 ? 1.3 : 1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0, ink = 0;
    for (let j = Math.floor(y * k); j < Math.floor((y + 1) * k); j++) for (let i = Math.floor(x * k); i < Math.floor((x + 1) * k); i++) {
      const o = (j * N + i) * 5, w = master[o + 3];
      r += master[o] * w; g += master[o + 1] * w; b += master[o + 2] * w; a += w; ink += master[o + 4] * w;
    }
    const n = Math.floor((y + 1) * k) - Math.floor(y * k), m = Math.floor((x + 1) * k) - Math.floor(x * k), o = (y * size + x) * 4;
    let c = a ? [r / a, g / a, b / a] : [0, 0, 0];
    if (boost !== 1) { // push light and shadow on the plastic only; the blue stays the blue
      const f = a ? ink / a : 0, bst = 1 + (boost - 1) * (1 - f);
      const base = PLASTIC_HI.map((v, q) => (v + PLASTIC_LO[q]) / 2 + (INK[q] - (v + PLASTIC_LO[q]) / 2) * f);
      c = c.map((v, q) => base[q] + (v - base[q]) * bst);
    }
    out[o] = Math.round(Math.min(255, Math.max(0, c[0]))); out[o + 1] = Math.round(Math.min(255, Math.max(0, c[1])));
    out[o + 2] = Math.round(Math.min(255, Math.max(0, c[2]))); out[o + 3] = Math.round(a / (n * m) * 255);
  }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const v of buf) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([s, data], i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(off, e + 12); off += data.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p[1])]);
}

const outDir = process.argv[2] || path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const master = renderMaster();
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(outDir, `icon${size}.png`), png(size, downsample(master, size)));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), png(512, downsample(master, 512)));
console.log(`${NAME}: wrote icon16/32/48/128.png and icon-512.png to ${outDir}`);
