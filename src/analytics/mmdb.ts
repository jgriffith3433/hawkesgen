// A small reader for MaxMind DB files (.mmdb: DB-IP Lite's format), enough to look up a city record by IP.
// Spec: https://maxmind.github.io/MaxMind-DB/. The file is read by position through a small page cache, so a 100+ MB
// database doesn't sit in memory.

import fs from 'node:fs';
import net from 'node:net';

const MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);
const PAGE = 4096;
const PAGES = 2048; // 8 MB of cache at most

/** Random access to the bytes: a Buffer (tests) or a file read by position. */
export type Source = { size: number; read(offset: number, length: number): Buffer; close?(): void };

export function bufferSource(buf: Buffer): Source {
  return { size: buf.length, read: (o, n) => buf.subarray(o, o + n) };
}

export function fileSource(file: string): Source {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const pages = new Map<number, Buffer>();
  const page = (n: number) => {
    let b = pages.get(n);
    if (b) {
      pages.delete(n);
      pages.set(n, b);
      return b;
    }
    b = Buffer.alloc(Math.min(PAGE, size - n * PAGE));
    fs.readSync(fd, b, 0, b.length, n * PAGE);
    pages.set(n, b);
    if (pages.size > PAGES) pages.delete(pages.keys().next().value!);
    return b;
  };
  return {
    size,
    read(offset, length) {
      const first = Math.floor(offset / PAGE);
      const last = Math.floor((offset + length - 1) / PAGE);
      if (first === last) return page(first).subarray(offset - first * PAGE, offset - first * PAGE + length);
      const parts: Buffer[] = [];
      for (let n = first; n <= last; n++) parts.push(page(n));
      const all = Buffer.concat(parts);
      return all.subarray(offset - first * PAGE, offset - first * PAGE + length);
    },
    close: () => fs.closeSync(fd),
  };
}

export class Mmdb {
  src: Source;
  meta: any;
  nodeCount: number;
  recordSize: number;
  ipVersion: number;
  treeSize: number;
  dataStart: number;
  ipv4Start = 0;

  constructor(src: Source) {
    this.src = src;
    const tailLen = Math.min(src.size, 128 * 1024);
    const tail = src.read(src.size - tailLen, tailLen);
    const at = tail.lastIndexOf(MARKER);
    if (at < 0) throw new Error('Not a MaxMind DB file (no metadata marker)');
    const metaStart = src.size - tailLen + at + MARKER.length;
    this.meta = this.decode(metaStart, metaStart).value;
    this.nodeCount = Number(this.meta.node_count);
    this.recordSize = Number(this.meta.record_size);
    this.ipVersion = Number(this.meta.ip_version);
    if (![24, 28, 32].includes(this.recordSize)) throw new Error(`Unsupported record size ${this.recordSize}`);
    this.treeSize = (this.recordSize * 2 / 8) * this.nodeCount;
    this.dataStart = this.treeSize + 16;
    // IPv4 addresses live under ::/96 in an IPv6 tree.
    if (this.ipVersion === 6) {
      let node = 0;
      for (let i = 0; i < 96 && node < this.nodeCount; i++) node = this.record(node, 0);
      this.ipv4Start = node;
    }
  }

  static open(file: string) {
    return new Mmdb(fileSource(file));
  }

  close() {
    this.src.close?.();
  }

  private record(node: number, bit: number): number {
    const bytes = this.recordSize / 4;
    const b = this.src.read(node * bytes, bytes);
    if (this.recordSize === 24) return bit ? b.readUIntBE(3, 3) : b.readUIntBE(0, 3);
    if (this.recordSize === 32) return bit ? b.readUInt32BE(4) : b.readUInt32BE(0);
    return bit ? ((b[3] & 0x0f) << 24) | b.readUIntBE(4, 3) : ((b[3] & 0xf0) << 20) | b.readUIntBE(0, 3);
  }

  /** The record for an IP address, or null. */
  get(ip: string): any {
    const kind = net.isIP(ip);
    if (!kind) return null;
    const bits = kind === 4 ? v4Bits(ip) : v6Bits(ip);
    if (!bits) return null;
    let node = 0;
    if (kind === 4 && this.ipVersion === 6) node = this.ipv4Start;
    else if (kind === 6 && this.ipVersion === 4) return null;
    for (let i = 0; i < bits.length && node < this.nodeCount; i++) node = this.record(node, bits[i]);
    // node_count itself means "no data"; below it, the address ran out of bits inside the tree.
    if (node <= this.nodeCount) return null;
    const offset = node - this.nodeCount - 16 + this.dataStart;
    return this.decode(offset, this.dataStart).value;
  }

  /** Decodes one value at `offset`; pointers are relative to `base` (the data section, or the metadata). */
  private decode(offset: number, base: number): { value: any; next: number } {
    const head = this.src.read(offset, 1)[0];
    let type = head >> 5;
    let pos = offset + 1;
    if (type === 1) {
      const ss = (head >> 3) & 3;
      const v = head & 7;
      const b = this.src.read(pos, ss + 1);
      let p: number;
      if (ss === 0) p = (v << 8) | b[0];
      else if (ss === 1) p = ((v << 16) | b.readUInt16BE(0)) + 2048;
      else if (ss === 2) p = ((v << 24) | b.readUIntBE(0, 3)) + 526336;
      else p = b.readUInt32BE(0);
      return { value: this.decode(base + p, base).value, next: pos + ss + 1 };
    }
    if (type === 0) {
      type = 7 + this.src.read(pos, 1)[0];
      pos++;
    }
    let size = head & 0x1f;
    if (size >= 29) {
      const n = size - 28;
      const b = this.src.read(pos, n);
      pos += n;
      size = size === 29 ? 29 + b[0] : size === 30 ? 285 + b.readUInt16BE(0) : 65821 + b.readUIntBE(0, 3);
    }
    switch (type) {
      case 2: return { value: this.src.read(pos, size).toString('utf8'), next: pos + size };
      case 3: return { value: this.src.read(pos, 8).readDoubleBE(0), next: pos + 8 };
      case 4: return { value: Buffer.from(this.src.read(pos, size)), next: pos + size };
      case 5: case 6: case 9: case 10: {
        let n = 0n;
        for (const x of this.src.read(pos, size)) n = (n << 8n) | BigInt(x);
        return { value: n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n, next: pos + size };
      }
      case 8: {
        const b = Buffer.alloc(4);
        this.src.read(pos, size).copy(b, 4 - size);
        return { value: b.readInt32BE(0), next: pos + size };
      }
      case 7: {
        const out: Record<string, any> = {};
        for (let i = 0; i < size; i++) {
          const k = this.decode(pos, base);
          const v = this.decode(k.next, base);
          out[String(k.value)] = v.value;
          pos = v.next;
        }
        return { value: out, next: pos };
      }
      case 11: {
        const out: any[] = [];
        for (let i = 0; i < size; i++) {
          const v = this.decode(pos, base);
          out.push(v.value);
          pos = v.next;
        }
        return { value: out, next: pos };
      }
      case 14: return { value: size !== 0, next: pos };
      case 15: return { value: this.src.read(pos, 4).readFloatBE(0), next: pos + 4 };
      default: return { value: null, next: pos + size };
    }
  }
}

function v4Bits(ip: string): number[] {
  const out: number[] = [];
  for (const part of ip.split('.')) for (let i = 7; i >= 0; i--) out.push((Number(part) >> i) & 1);
  return out;
}

function v6Bits(ip: string): number[] | null {
  let s = ip.split('%')[0];
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const p = m[1].split('.').map(Number);
    s = s.slice(0, -m[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [l, r] = s.split('::');
  const left = l ? l.split(':') : [];
  const right = r !== undefined && r ? r.split(':') : [];
  const groups = s.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const v = parseInt(g || '0', 16);
    for (let i = 15; i >= 0; i--) out.push((v >> i) & 1);
  }
  return out;
}
