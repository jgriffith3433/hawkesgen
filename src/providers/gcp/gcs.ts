// Google Cloud: credentials and a small Cloud Storage client (the JSON API over fetch), for the Cloud Run GPU backend
// (src/providers/cloudrun/) and the library's GCS store (src/storage.ts).
//
// Credentials are Application Default Credentials (google-auth-library): GOOGLE_APPLICATION_CREDENTIALS (a service
// account key, or a workload identity federation config so the AWS control server needs no key at all), or
// `gcloud auth application-default login` on J's PC. HAWKESGEN_GCP_IMPERSONATE=<service account email> makes every call
// as that service account (the source credentials need roles/iam.serviceAccountTokenCreator on it): user credentials
// and federated ones can't mint ID tokens for Cloud Run themselves, so this is how they call the GPU services.
//
// The client is deliberately small (no @google-cloud/storage and its dependency tree): stat, read, write (one request
// up to 32 MB, resumable above), copy-in from a stream, delete, list and metadata patch.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../../config.ts';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const API = 'https://storage.googleapis.com/storage/v1';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1';
/** Resumable chunks must be multiples of 256 KiB. */
const CHUNK = 32 * 1024 * 1024;

export type Tokens = { access(): Promise<string>; id(audience: string): Promise<string> };

let tokens: Tokens | null = null;
/** Tests swap in fake tokens. */
export function setTokens(t: Tokens | null) {
  tokens = t;
}

/** Access tokens (Cloud Storage) and ID tokens (Cloud Run's IAM check) from Application Default Credentials. */
export function gcpTokens(): Tokens {
  if (tokens) return tokens;
  let auth: any = null;
  let imp: any = null;
  const ids = new Map<string, { token: string; until: number }>();
  let access: { token: string; until: number } | null = null;
  const load = async () => {
    if (auth) return;
    const G = await import('google-auth-library');
    auth = new G.GoogleAuth({ scopes: [SCOPE] });
    const target = env('HAWKESGEN_GCP_IMPERSONATE');
    if (target) imp = new G.Impersonated({ sourceClient: await auth.getClient(), targetPrincipal: target, targetScopes: [SCOPE], lifetime: 3600, delegates: [] });
  };
  tokens = {
    async access() {
      if (access && Date.now() < access.until) return access.token;
      await load();
      const t = imp ? (await imp.getAccessToken()).token : await auth.getAccessToken();
      if (!t) throw new Error('No Google Cloud credentials (set GOOGLE_APPLICATION_CREDENTIALS, or run gcloud auth application-default login)');
      access = { token: t, until: Date.now() + 45 * 60_000 };
      return t;
    },
    async id(audience) {
      const hit = ids.get(audience);
      if (hit && Date.now() < hit.until) return hit.token;
      await load();
      let t: string;
      if (imp) t = await imp.fetchIdToken(audience, { includeEmail: true });
      else {
        const c = await auth.getIdTokenClient(audience);
        const h = await c.getRequestHeaders();
        t = String((h instanceof Headers ? h.get('authorization') : (h as any).Authorization) ?? '').replace(/^Bearer\s+/i, '');
      }
      if (!t) throw new Error(`Couldn't get an ID token for ${audience}: these credentials can't mint one (use a service account, or set HAWKESGEN_GCP_IMPERSONATE)`);
      // ID tokens last an hour; take a new one well before.
      ids.set(audience, { token: t, until: Date.now() + 45 * 60_000 });
      return t;
    },
  };
  return tokens;
}

export type GcsObject = { name: string; size: number; contentType?: string; cacheControl?: string; generation?: string; md5Hash?: string; updated?: string; metadata?: Record<string, string> };

export const gsUri = (bucket: string, name: string) => `gs://${bucket}/${name}`;
export function splitUri(uri: string): { bucket: string; name: string } {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Not a gs:// object URI: ${uri}`);
  return { bucket: m[1], name: m[2] };
}
const enc = (name: string) => encodeURIComponent(name);

export class GcsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A tiny Cloud Storage client. `fetchImpl` and `tokens` are for tests. */
export class Gcs {
  fetch: typeof fetch;
  tokens: () => Tokens;
  constructor(opts: { fetchImpl?: typeof fetch; tokens?: Tokens } = {}) {
    this.fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.tokens = () => opts.tokens ?? gcpTokens();
  }

  async req(url: string, init: RequestInit & { ok404?: boolean } = {}, tries = 4): Promise<Response | null> {
    for (let attempt = 1; ; attempt++) {
      const headers = new Headers(init.headers ?? {});
      headers.set('Authorization', `Bearer ${await this.tokens().access()}`);
      let r: Response;
      try {
        r = await this.fetch(url, { ...init, headers });
      } catch (e: any) {
        if (attempt >= tries || init.body instanceof ReadableStream || init.signal?.aborted) throw e;
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        continue;
      }
      if (r.ok) return r;
      if (r.status === 404 && init.ok404) {
        await r.body?.cancel().catch(() => undefined);
        return null;
      }
      const body = await r.text().catch(() => '');
      // 429 and 5xx are worth another try (Google's own advice), unless the body was a one-shot stream.
      if ((r.status === 429 || r.status >= 500) && attempt < tries && !(init.body instanceof ReadableStream)) {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        continue;
      }
      throw new GcsError(`Cloud Storage ${init.method ?? 'GET'} ${url.replace(/\?.*$/, '')}: ${r.status} ${body.slice(0, 300)}`, r.status);
    }
  }

  async stat(uri: string): Promise<GcsObject | null> {
    const { bucket, name } = splitUri(uri);
    const r = await this.req(`${API}/b/${bucket}/o/${enc(name)}`, { ok404: true });
    if (!r) return null;
    const o = await r.json();
    return { ...o, size: Number(o.size) };
  }

  async read(uri: string): Promise<Buffer | null> {
    const { bucket, name } = splitUri(uri);
    const r = await this.req(`${API}/b/${bucket}/o/${enc(name)}?alt=media`, { ok404: true });
    return r ? Buffer.from(await r.arrayBuffer()) : null;
  }

  async readJson<T = any>(uri: string): Promise<T | null> {
    const b = await this.read(uri);
    return b ? JSON.parse(b.toString('utf8')) : null;
  }

  /** Writes a buffer in one request. */
  async write(uri: string, data: Buffer | string, contentType = 'application/octet-stream', cacheControl?: string) {
    const { bucket, name } = splitUri(uri);
    const body = typeof data === 'string' ? Buffer.from(data) : data;
    if (body.length > CHUNK) return this.writeStream(uri, Readable.from([body]), body.length, contentType, cacheControl);
    if (!cacheControl) {
      await this.req(`${UPLOAD}/b/${bucket}/o?uploadType=media&name=${enc(name)}`, { method: 'POST', headers: { 'Content-Type': contentType }, body: new Uint8Array(body) });
      return;
    }
    // Metadata with the bytes: a multipart upload.
    const boundary = `hawkes${Date.now().toString(36)}`;
    const meta = JSON.stringify({ name, contentType, cacheControl });
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await this.req(`${UPLOAD}/b/${bucket}/o?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(multipart) });
  }

  async writeJson(uri: string, value: unknown) {
    await this.write(uri, JSON.stringify(value), 'application/json');
  }

  /** Uploads a local file: one request when small, resumable in chunks when large. */
  async writeFile(uri: string, file: string, contentType = 'application/octet-stream', cacheControl?: string) {
    const size = fs.statSync(file).size;
    if (size <= CHUNK) return this.write(uri, fs.readFileSync(file), contentType, cacheControl);
    return this.writeStream(uri, fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }), size, contentType, cacheControl);
  }

  /** Starts a resumable upload session. -> its URL (good for a week; keep it to resume after a crash). */
  async startResumable(uri: string, size: number | null, contentType: string, cacheControl?: string, metadata?: Record<string, string>): Promise<string> {
    const { bucket, name } = splitUri(uri);
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': contentType };
    if (size !== null) headers['X-Upload-Content-Length'] = String(size);
    const r = (await this.req(`${UPLOAD}/b/${bucket}/o?uploadType=resumable`, { method: 'POST', headers, body: JSON.stringify({ name, contentType, cacheControl, metadata }) }))!;
    const loc = r.headers.get('location');
    await r.body?.cancel().catch(() => undefined);
    if (!loc) throw new Error('Cloud Storage gave no resumable upload URL');
    return loc;
  }

  /** How many bytes a resumable session already has (-1 when it is finished). */
  async resumableOffset(session: string, size: number): Promise<number> {
    const headers = new Headers({ 'Content-Range': `bytes */${size}`, 'Content-Length': '0', Authorization: `Bearer ${await this.tokens().access()}` });
    const r = await this.fetch(session, { method: 'PUT', headers });
    await r.body?.cancel().catch(() => undefined);
    if (r.status === 200 || r.status === 201) return -1;
    if (r.status !== 308) throw new GcsError(`resumable upload status: ${r.status}`, r.status);
    const range = r.headers.get('range');
    return range ? Number(range.split('-')[1]) + 1 : 0;
  }

  /**
   * Streams `size` bytes into an object through a resumable session, CHUNK at a time. `from` skips that many bytes of
   * the stream (resuming a session that already has them); `streamOffset` says the stream itself starts that far in (an
   * HTTP Range read), so fewer are skipped. `onChunk` reports bytes sent.
   */
  async writeStream(uri: string, stream: Readable | AsyncIterable<Uint8Array>, size: number, contentType: string, cacheControl?: string, opts: { session?: string; from?: number; streamOffset?: number; onChunk?: (sent: number) => void; metadata?: Record<string, string> } = {}) {
    const session = opts.session ?? (await this.startResumable(uri, size, contentType, cacheControl, opts.metadata));
    const skip = opts.from ?? 0;
    // `offset`: bytes the session holds; `read`: bytes of the stream seen (the first `skip` are already uploaded).
    let offset = skip;
    let read = opts.streamOffset ?? 0;
    let buf = Buffer.alloc(0);
    const put = async (part: Buffer) => {
      const range = part.length ? `bytes ${offset}-${offset + part.length - 1}/${size}` : `bytes */${size}`;
      const headers = new Headers({ 'Content-Length': String(part.length), 'Content-Range': range, Authorization: `Bearer ${await this.tokens().access()}` });
      const r = await this.fetch(session, { method: 'PUT', headers, body: part.length ? new Uint8Array(part) : undefined });
      await r.body?.cancel().catch(() => undefined);
      if (!(r.status === 308 || r.ok)) throw new GcsError(`resumable upload of ${uri} at ${offset}: ${r.status}`, r.status);
      offset += part.length;
      opts.onChunk?.(offset);
    };
    for await (const piece of stream as AsyncIterable<Uint8Array>) {
      let b = Buffer.from(piece);
      if (read + b.length <= skip) { read += b.length; continue; }
      if (read < skip) b = b.subarray(skip - read);
      read += piece.length;
      buf = buf.length ? Buffer.concat([buf, b]) : b;
      // Whole chunks go as they fill (multiples of 256 KiB, as the API wants); the rest waits for the end.
      while (buf.length >= CHUNK && offset + CHUNK < size) {
        await put(buf.subarray(0, CHUNK));
        buf = buf.subarray(CHUNK);
      }
    }
    if (offset + buf.length !== size) throw new Error(`upload of ${uri}: the stream gave ${offset + buf.length} bytes, expected ${size}`);
    await put(buf);
    return session;
  }

  /** Downloads an object to a local file (atomically, through a .part file). */
  async download(uri: string, dest: string) {
    const { bucket, name } = splitUri(uri);
    const r = (await this.req(`${API}/b/${bucket}/o/${enc(name)}?alt=media`))!;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(r.body as any).on('error', reject).pipe(out).on('finish', () => resolve()).on('error', reject);
    });
    fs.renameSync(tmp, dest);
  }

  async del(uri: string) {
    const { bucket, name } = splitUri(uri);
    await this.req(`${API}/b/${bucket}/o/${enc(name)}`, { method: 'DELETE', ok404: true });
  }

  async patch(uri: string, meta: { contentType?: string; cacheControl?: string; metadata?: Record<string, string> }) {
    const { bucket, name } = splitUri(uri);
    await this.req(`${API}/b/${bucket}/o/${enc(name)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
  }

  /** Every object under a prefix (name and size). */
  async *list(bucket: string, prefix: string): AsyncGenerator<GcsObject> {
    let page = '';
    for (;;) {
      const q = new URLSearchParams({ prefix, fields: 'items(name,size,contentType,md5Hash,metadata),nextPageToken', maxResults: '1000' });
      if (page) q.set('pageToken', page);
      const r = await (await this.req(`${API}/b/${bucket}/o?${q}`))!.json();
      for (const o of r.items ?? []) yield { ...o, size: Number(o.size) };
      if (!r.nextPageToken) return;
      page = r.nextPageToken;
    }
  }
}

let shared: Gcs | null = null;
export const gcs = () => (shared ??= new Gcs());
