import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const id = (prefix: string, bytes = 8) => `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;

export const sha256 = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex');

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** JSON with sorted keys, so the same object always hashes the same. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'model/obj',
  '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown',
};
export const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
export const extOf = (mime: string) => Object.entries(MIME).find(([, m]) => m === mime)?.[0] ?? '.bin';

/** image, video, audio, mesh, text or file. */
export function kindOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('model/')) return 'mesh';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'file';
}

/** An error with an HTTP status, and for AWS errors a kind (capacity, quota, auth, other) and the attempts made. */
export class GenError extends Error {
  status: number;
  kind: string;
  attempts: unknown[];
  constructor(message: string, { status = 400, kind = 'other', attempts = [] as unknown[] } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.attempts = attempts;
  }
}

/** Runs a program; resolves to stdout, rejects with the end of stderr. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...opts.env }, signal: opts.signal, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err || out).trim().slice(-800) || `${path.basename(cmd)} exited ${code}`))));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.filter((k) => (o as any)[k] !== undefined).map((k) => [k, (o as any)[k]]));
