// Raw uploads without holding the file in memory (2026-11-08: readBody buffered whole uploads on a 4 GiB instance shared
// with ffmpeg and python). A body streams to a temp file in the data folder while its hash is computed, then moves into
// the library. Uploads are counted: per caller and in total, past which the answer is a plain 429. A size cap per role.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { paths } from './config.ts';
import { GenError, id } from './util.ts';

const GIB = 1024 * 1024 * 1024;
const num = (name: string, d: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : d; };

/** Limits, read on each call so tests (and the owner, by environment) can change them. */
export const uploadLimits = () => ({
  perCaller: num('HAWKESGEN_UPLOAD_PER_USER', 3),
  total: num('HAWKESGEN_UPLOAD_TOTAL', 6),
  /** Size cap in bytes: customers and app accounts (role user) get less than the studio's own keys. */
  maxBytes: (role: string) => (role === 'user' ? num('HAWKESGEN_UPLOAD_MAX_USER', 1 * GIB) : num('HAWKESGEN_UPLOAD_MAX', 2 * GIB)),
});

const active = new Map<string, number>();
let activeTotal = 0;

export const uploadsNow = () => ({ total: activeTotal, callers: active.size });

/** Takes a slot for one upload, or throws the 429 with its plain message. Call `release` when it ends, whatever happens. */
export function takeUpload(who: string): () => void {
  const lim = uploadLimits();
  const mine = active.get(who) ?? 0;
  if (mine >= lim.perCaller) {
    throw new GenError(`That's ${lim.perCaller} uploads at once. Wait for one to finish, then add the next.`, { status: 429, kind: 'uploads' });
  }
  if (activeTotal >= lim.total) {
    throw new GenError('Too many uploads at once right now. Try again in a minute.', { status: 429, kind: 'uploads' });
  }
  active.set(who, mine + 1);
  activeTotal++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    activeTotal--;
    const n = (active.get(who) ?? 1) - 1;
    if (n > 0) active.set(who, n); else active.delete(who);
  };
}

export type Streamed = { file: string; bytes: number; sha256: string };

/** Streams a request body to a temp file (never more than `limit` bytes), hashing as it goes. The caller moves or removes the file. */
export async function streamBody(req: IncomingMessage, limit: number): Promise<Streamed> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw tooBig(limit);
  const dir = path.join(paths.tmp, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id('up', 8)}.part`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > limit) return cb(tooBig(limit));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, count, fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  return { file, bytes, sha256: hash.digest('hex') };
}

function tooBig(limit: number) {
  const mb = Math.round(limit / (1024 * 1024));
  return new GenError(`That file is too big: the limit is ${mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`}.`, { status: 413, kind: 'size' });
}
