// Draws the toolbar icon (text lines with one highlighted word) as PNGs.
// Usage: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in a 0..1 coordinate space; supersampled for anti-aliasing.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const BG = [201, 100, 66];
const LINE = [255, 247, 240];
const HL = [255, 213, 74];
const INK = [60, 30, 20];

function colorAt(x, y) {
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return null;
  const h = 0.085;
  const lines = [
    { y: 0.27, x0: 0.2, x1: 0.8 },
    { y: 0.5, x0: 0.2, x1: 0.8 },
    { y: 0.73, x0: 0.2, x1: 0.6 },
  ];
  // highlighted word on the middle line
  if (inRoundRect(x, y, 0.4, 0.5 - 0.13, 0.72, 0.5 + 0.13, 0.06)) {
    if (inRoundRect(x, y, 0.46, 0.5 - h / 2, 0.66, 0.5 + h / 2, h / 2)) return INK;
    return HL;
  }
  for (const l of lines) {
    if (l.y === 0.5) {
      if (inRoundRect(x, y, l.x0, l.y - h / 2, 0.34, l.y + h / 2, h / 2)) return LINE;
      continue;
    }
    if (inRoundRect(x, y, l.x0, l.y - h / 2, l.x1, l.y + h / 2, h / 2)) return LINE;
  }
  return BG;
}

function draw(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return png(size, buf);
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), draw(s));
console.log('icons written to', out);
