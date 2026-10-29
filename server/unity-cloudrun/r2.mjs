// R2 (S3 API) for the Unity cloud build's builds-in-R2 step (github.sh github_r2_builds; hawkesstudio
// docs/unity-builds-storage.md). Runs with the Node that Unity's WebGL module ships (Emscripten's), so the image needs
// nothing new; the image's curl (Ubuntu 22.04, 7.81) signs uploads wrongly and R2 answered 403 (2026-10-29).
//
//   node r2.mjs putdir <dir> <key prefix>     every file under dir, Brotli/gzip .unityweb stored with their Content-Encoding
//   node r2.mjs versions <prefix>             the v<n> folders under prefix, one per line
//   node r2.mjs rmprefix <prefix>             deletes every key under prefix
//
// Env: R2_BUILDS_TOKEN (the r2-builds secret), R2_ACCOUNT, R2_BUCKET. The S3 key is the token's id and the secret the
// SHA-256 of its value (Cloudflare's rule for R2 API tokens).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { R2_BUILDS_TOKEN: token, R2_ACCOUNT: account, R2_BUCKET: bucket } = process.env;
if (!token || !account || !bucket) { console.error('r2.mjs needs R2_BUILDS_TOKEN, R2_ACCOUNT and R2_BUCKET'); process.exit(2); }
const host = `${account}.r2.cloudflarestorage.com`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const verify = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => ({}));
const keyId = verify?.result?.id;
if (!keyId) { console.error("the R2 token doesn't verify"); process.exit(2); }
const secret = sha(token);

/** One signed S3 request (SigV4, region auto, unsigned payload). */
async function s3(method, key, { query = {}, body, headers = {} } = {}) {
  const uri = `/${bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amz.slice(0, 8);
  const signed = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amz };
  const names = Object.keys(signed).sort();
  const canonical = [method, uri, qs, names.map((n) => `${n}:${signed[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canonical)].join('\n');
  const k = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), 'auto'), 's3'), 'aws4_request');
  const auth = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(k, toSign).toString('hex')}`;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${host}${uri}${qs ? `?${qs}` : ''}`, { method, body, headers: { ...headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amz, Authorization: auth } }).catch((e) => ({ ok: false, status: 0, text: async () => String(e.message ?? e) }));
    if (r.ok) return r;
    if (attempt >= 3 || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(`${method} ${key || '(bucket)'}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    await new Promise((ok) => setTimeout(ok, 1000 * attempt));
  }
}

const TYPES = [[/\.wasm(\.|$)/, 'application/wasm'], [/\.js(\.|$)/, 'application/javascript'], [/\.json$/, 'application/json'], [/\.html$/, 'text/html'], [/\.css$/, 'text/css'], [/\.png$/, 'image/png'], [/\.jpe?g$/, 'image/jpeg'], [/\.svg$/, 'image/svg+xml']];
const typeOf = (f) => TYPES.find(([re]) => re.test(f))?.[1] ?? 'application/octet-stream';
/** br for Unity's Brotli files (their first bytes say so), gzip for gzip, none otherwise. */
function encodingOf(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(64);
  fs.readSync(fd, b, 0, 64, 0);
  fs.closeSync(fd);
  if (b.toString('latin1').includes('UnityWeb Compressed Content (brotli)')) return 'br';
  return b[0] === 0x1f && b[1] === 0x8b ? 'gzip' : null;
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

async function keys(prefix, delimiter) {
  const out = { keys: [], prefixes: [] };
  let token2 = '';
  do {
    const r = await s3('GET', '', { query: { 'list-type': '2', prefix, ...(delimiter ? { delimiter } : {}), ...(token2 ? { 'continuation-token': token2 } : {}) } });
    const xml = await r.text();
    out.keys.push(...[...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]));
    out.prefixes.push(...[...xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix));
    token2 = /<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? '';
  } while (token2);
  return out;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'putdir') {
  const files = walk(a);
  let i = 0;
  let done = 0;
  const work = async () => {
    while (i < files.length) {
      const f = files[i++];
      const rel = path.relative(a, f).split(path.sep).join('/');
      const e = encodingOf(f);
      await s3('PUT', `${b}${rel}`, { body: fs.readFileSync(f), headers: { 'Content-Type': typeOf(rel), ...(e ? { 'Content-Encoding': e } : {}) } });
      done++;
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  console.log(`uploaded ${done} files to ${b}`);
} else if (cmd === 'versions') {
  for (const p of (await keys(a, '/')).prefixes) { const m = /\/(v\d+)\/$/.exec(p); if (m) console.log(m[1]); }
} else if (cmd === 'rmprefix') {
  const { keys: ks } = await keys(a);
  for (const k of ks) await s3('DELETE', k);
  console.log(`deleted ${ks.length} keys under ${a}`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
