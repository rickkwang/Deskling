// Minimal PNG decoder/encoder for the character importer (Node only). Decodes
// 8-bit non-interlaced greyscale, RGB, palette and RGBA images — what image
// models and editors write — into { width, height, data: RGBA Uint8Array }.

import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPng(bytes) {
  return Buffer.from(bytes.subarray(0, 8)).equals(SIG);
}

export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (!isPng(buf)) throw new Error('not a PNG file');
  let width, height, depth, type, interlace, palette, trns;
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('latin1', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      [depth, type, , , interlace] = body.subarray(8);
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace || !CHANNELS[type]) {
    throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${type}${interlace ? ', interlaced' : ''})`);
  }
  const bpp = CHANNELS[type];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      row[i] = v;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * bpp, d = p * 4;
    if (type === 6) data.set(px.subarray(s, s + 4), d);
    else if (type === 2) { data.set(px.subarray(s, s + 3), d); data[d + 3] = 255; }
    else if (type === 3) {
      const k = px[s];
      data.set(palette.subarray(k * 3, k * 3 + 3), d);
      data[d + 3] = trns && k < trns.length ? trns[k] : 255;
    } else {
      data[d] = data[d + 1] = data[d + 2] = px[s];
      data[d + 3] = type === 4 ? px[s + 1] : 255;
    }
  }
  return { width, height, data };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// RGBA -> PNG, choosing each row's filter by the usual minimum-sum heuristic.
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const out = Buffer.alloc((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = up ? up[i] : 0;
        const c = up && i >= 4 ? up[i - 4] : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
        const v = (row[i] - pred) & 0xff;
        cand[f][i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(kind, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}
