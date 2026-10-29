// A customer's web build, served by the browser service itself (Gen docs/playtest-runners.md, "Web builds"). Gen
// connects to /pw with X-Hawkes-Site: base64url JSON { url, kind, sha256, name }, where url is a signed link to the
// build's archive (the library bucket, or GitHub's own download link). Before the browser starts, this downloads the
// archive (once per build on this instance), unpacks it (zip, tar, tar.gz), serves the folder on 127.0.0.1 and the
// browser maps SITE_HOST to that port (--host-resolver-rules), so the page is http://build.hawkes.test/<entry>. Gen
// never fetches or serves a customer's build itself.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export const SITE_HOST = 'build.hawkes.test';
const MAX_ARCHIVE = Number(process.env.HAWKES_SITE_MAX_BYTES || 4 * 1024 ** 3);
const MAX_UNPACKED = Number(process.env.HAWKES_SITE_MAX_UNPACKED || 8 * 1024 ** 3);
const MAX_FILES = 200_000;
const ROOT = process.env.HAWKES_SITE_DIR || path.join(os.tmpdir(), 'hawkes-sites');

/** The header as { url, kind, sha256, name }, or null (missing or malformed). Only https links. */
export function parseSiteHeader(v) {
  if (!v) return null;
  try {
    const j = JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8'));
    if (typeof j?.url !== 'string' || !/^https:\/\//.test(j.url)) return null;
    return { url: j.url, kind: String(j.kind ?? 'archive'), sha256: /^[0-9a-f]{64}$/.test(String(j.sha256)) ? j.sha256 : null, name: j.name ? String(j.name).slice(0, 200) : null };
  } catch {
    return null;
  }
}

/** The browser flag that sends SITE_HOST to the build's server. */
export const siteArg = (port) => `--host-resolver-rules=MAP ${SITE_HOST}:80 127.0.0.1:${port}`;

/** Zip, tar or gzip by the first bytes; null otherwise. */
export function archiveKind(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(512);
    const n = fs.readSync(fd, head, 0, 512, 0);
    if (n >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
    if (n >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tgz';
    if (n >= 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Downloads url to dest, at most `max` bytes (a bigger build is refused, not truncated). */
export async function download(url, dest, { max = MAX_ARCHIVE, fetchImpl = fetch, signal } = {}) {
  const r = await fetchImpl(url, { signal: signal ?? AbortSignal.timeout(20 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`the build's link answered ${r.status}`);
  const said = Number(r.headers.get('content-length') || 0);
  if (said > max) throw new Error(`the build is ${Math.round(said / 1e6)} MB, past the ${Math.round(max / 1e6)} MB limit`);
  let got = 0;
  const cap = new Transform({
    transform(chunk, _e, cb) {
      got += chunk.length;
      cb(got > max ? new Error(`the build is past the ${Math.round(max / 1e6)} MB limit`) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(r.body), cap, fs.createWriteStream(dest));
  return got;
}

const run = (cmd, args, { ms = 10 * 60_000, cwd } = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const t = setTimeout(() => p.kill('SIGKILL'), ms);
  p.on('error', (e) => { clearTimeout(t); reject(e); });
  p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').pop() ?? ''}`)); });
});

/** Every regular file under dir (no symlinks followed), with the total size; throws past the limits. */
export function walk(dir, { maxFiles = MAX_FILES, maxBytes = MAX_UNPACKED } = {}) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { fs.rmSync(p, { force: true }); continue; } // a link could point out of the build
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
        if (files > maxFiles || bytes > maxBytes) throw new Error(`the build unpacks past the limit (${maxFiles} files, ${Math.round(maxBytes / 1e6)} MB)`);
      }
    }
  }
  return { files, bytes };
}

/** Unpacks an archive into dir: unzip (or bsdtar) for zip, tar for tar(.gz). Members with ".." or absolute paths are dropped by both. */
export async function unpack(file, dir) {
  const kind = archiveKind(file);
  if (!kind) throw new Error('the build is not a zip, tar or tar.gz archive');
  fs.mkdirSync(dir, { recursive: true });
  // Run inside dir with a relative archive path: GNU tar reads "C:\..." as a remote host (Windows, in tests).
  const rel = path.relative(dir, file).split(path.sep).join('/');
  if (kind === 'zip') await run('unzip', ['-q', '-o', rel, '-d', '.'], { cwd: dir }).catch(() => run('bsdtar', ['-xf', rel], { cwd: dir }));
  else await run('tar', [kind === 'tgz' ? '-xzf' : '-xf', rel, '--no-same-owner', '--no-same-permissions'], { cwd: dir });
  walk(dir);
  return kind;
}

/** The folder to serve: the archive's own, or the one folder inside it (zipballs and many artifacts wrap the build in one). */
export function siteRoot(dir) {
  let d = dir;
  for (let i = 0; i < 3; i++) {
    const items = fs.readdirSync(d, { withFileTypes: true }).filter((e) => !e.name.startsWith('__MACOSX'));
    if (items.some((e) => e.isFile() && /^index\.html?$/i.test(e.name))) return d;
    if (items.length === 1 && items[0].isDirectory()) d = path.join(d, items[0].name);
    else return d;
  }
  return d;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.pck': 'application/octet-stream', '.data': 'application/octet-stream',
};

/** Content-Type and Content-Encoding for a file: Unity's and Godot's pre-compressed .gz / .br files are served as what they hold. */
export function headersFor(name) {
  const lower = name.toLowerCase();
  const enc = lower.endsWith('.br') ? 'br' : lower.endsWith('.gz') ? 'gzip' : null;
  const inner = enc ? lower.slice(0, lower.lastIndexOf('.')) : lower;
  const type = TYPES[path.extname(inner)] ?? 'application/octet-stream';
  return { 'Content-Type': type, ...(enc ? { 'Content-Encoding': enc } : {}) };
}

/** The file a request path names inside root, or null (outside it, missing). Directories give their index.html. */
export function resolvePath(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const real = fs.realpathSync(root);
  let p = path.resolve(real, `.${path.posix.normalize(`/${rel}`)}`);
  if (p !== real && !p.startsWith(real + path.sep)) return null;
  try {
    if (fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    const rp = fs.realpathSync(p);
    if (rp !== real && !rp.startsWith(real + path.sep)) return null;
    return fs.statSync(rp).isFile() ? rp : null;
  } catch {
    return null;
  }
}

/** A static server for root on 127.0.0.1 (a random port). */
export function serve(root) {
  const server = http.createServer((req, res) => {
    const file = resolvePath(root, new URL(req.url ?? '/', 'http://x').pathname);
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(file ? 405 : 404, { 'Content-Type': 'text/plain' });
      return res.end(file ? 'method not allowed' : 'not found');
    }
    const size = fs.statSync(file).size;
    res.writeHead(200, { ...headersFor(file), 'Content-Length': size, 'Cache-Control': 'no-cache', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

// Builds unpacked on this instance, by content (or link): several tabs of one run, or runs of the same build, share one.
const builds = new Map();

/** Opens a site for one browser session: the build fetched and unpacked once, a server of its own. */
export async function openSite(site, { dir = ROOT, fetchImpl = fetch, log = () => {} } = {}) {
  const key = site.sha256 ?? crypto.createHash('sha256').update(site.url.split('?')[0]).digest('hex');
  let ready = builds.get(key);
  if (!ready) {
    ready = (async () => {
      const base = path.join(dir, key.slice(0, 32));
      const archive = `${base}.archive`;
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(base, { recursive: true, force: true });
      const t0 = Date.now();
      const bytes = await download(site.url, archive, { fetchImpl });
      if (site.sha256) {
        const h = crypto.createHash('sha256');
        for await (const c of fs.createReadStream(archive)) h.update(c);
        if (h.digest('hex') !== site.sha256) throw new Error('the build downloaded differs from its checksum');
      }
      const kind = await unpack(archive, base);
      fs.rmSync(archive, { force: true });
      log(`site ${key.slice(0, 12)}: ${Math.round(bytes / 1e6)} MB ${kind} unpacked in ${Math.round((Date.now() - t0) / 1000)} s`);
      return siteRoot(base);
    })();
    builds.set(key, ready);
    ready.catch(() => builds.delete(key));
  }
  const root = await ready;
  return { root, ...(await serve(root)) };
}
