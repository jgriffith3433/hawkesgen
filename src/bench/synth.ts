// Stand-in outputs for Gen Bench's mock runs: small real files (a PNG, a WAV, a GLB) made in Node with no ffmpeg,
// Python or GPU, so a mock run files real assets the Bench tab can show. A mock "video" is its poster frame (a PNG).

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A colour from words. */
export function colorOf(seed: string): [number, number, number] {
  const h = crypto.createHash('sha256').update(seed).digest();
  return [60 + (h[0] % 160), 60 + (h[1] % 160), 60 + (h[2] % 160)];
}

/** A w x h PNG: a vertical gradient between two colours from the seed, with a lighter disc in the middle (a "subject"). */
export function png(seed: string, w = 256, h = 160): Buffer {
  const a = colorOf(seed);
  const b = colorOf(seed + '/b');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = y / (h - 1);
      const inDisc = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 4) ** 2;
      for (let k = 0; k < 3; k++) raw[y * (w * 3 + 1) + 1 + x * 3 + k] = Math.min(255, Math.round(a[k] * (1 - t) + b[k] * t + (inDisc ? 50 : 0)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A mono 16-bit WAV: a tone whose pitch comes from the seed, faded in and out. */
export function wav(seed: string, seconds = 1.5, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const f = 220 + (colorOf(seed)[0] % 200) * 2;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (rate * 0.05), (n - i) / (rate * 0.05));
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * i) / rate) * 0.4 * env * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** A GLB holding one box (12 triangles), sized from the seed. */
export async function glb(seed: string): Promise<Buffer> {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const s = 0.5 + (colorOf(seed)[0] % 100) / 100;
  const doc = new Document();
  const buf = doc.createBuffer();
  const p = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].flat().map((v) => v * s);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buf);
  const ind = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buf);
  const [r, g, b] = colorOf(seed).map((c) => c / 255);
  const mat = doc.createMaterial('mock').setBaseColorFactor([r, g, b, 1]);
  const mesh = doc.createMesh('box').addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setIndices(ind).setMaterial(mat));
  doc.createScene().addChild(doc.createNode('box').setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
