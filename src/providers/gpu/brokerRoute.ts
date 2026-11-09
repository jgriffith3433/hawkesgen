// The broker's door (broker.ts says what it is): one gs:// object per request, the run's token in
// X-Hawkes-Run-Token. Answers before Gen's key check (the token is the credential), from api.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gcs, gcpTokens } from '../gcp/gcs.ts';
import { readToken, allowed } from './broker.ts';
import { signer as defaultSigner, signedGetUrl, signedUrl, type Signer } from './sign.ts';

export type BrokerDeps = {
  stat: (uri: string) => Promise<{ size: number } | null>;
  write: (uri: string, data: Buffer, contentType: string) => Promise<unknown>;
  /** The object's bytes as a stream (with a Range header passed on), or null when it isn't there. */
  open: (uri: string, range?: string) => Promise<Response | null>;
  signer: () => Promise<Signer | null>;
  /** A model that isn't in the bucket: its public download (server/models.json's url) and size, or null. */
  source: (uri: string) => Promise<{ url: string; size: number } | null>;
};

// Models straight from Hugging Face (J, 2026-10-29: "for now, download from hugging face"; provider volumes later): a
// models/<dir>/<file> the bucket doesn't hold is answered with models.json's public URL, which workers download in
// ranges like a signed one (free egress, no copy to keep). Workflow manifests' models count too. Sizes are asked once per file.
const sizes = new Map<string, number>();
async function modelSource(uri: string): Promise<{ url: string; size: number } | null> {
  const m = /^gs:\/\/[^/]+\/models\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return null;
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const list = JSON.parse(readFileSync(fileURLToPath(new URL('../../../server/models.json', import.meta.url)), 'utf8'));
  // Core models first, then the ones a workflow tool's manifest names with their download (audio.music, audio.sfx-sa3...).
  const { listWorkflows } = await import('../../workflows/registry.ts');
  const all = [...(list.models ?? []), ...listWorkflows().flatMap((w) => w.manifest.models ?? [])];
  const e = all.find((x: any) => x.dir === m[1] && x.file === m[2] && /^https:\/\//.test(String(x.url ?? '')));
  if (!e) return null;
  let size = sizes.get(e.url);
  if (size === undefined) {
    const r = await fetch(e.url, { method: 'HEAD', redirect: 'follow' });
    size = Number(r.headers.get('x-linked-size') ?? r.headers.get('content-length') ?? 0);
    if (!r.ok || !(size > 0)) return null;
    sizes.set(e.url, size);
  }
  return { url: e.url, size };
}

const media = (uri: string) => {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri)!;
  return `https://storage.googleapis.com/storage/v1/b/${m[1]}/o/${encodeURIComponent(m[2])}?alt=media`;
};

export const defaultBrokerDeps = (): BrokerDeps => ({
  stat: (uri) => gcs().stat(uri),
  write: (uri, data, ct) => gcs().write(uri, data, ct),
  async open(uri, range) {
    const r = await fetch(media(uri), { headers: { Authorization: `Bearer ${await gcpTokens().access()}`, ...(range ? { Range: range } : {}) } });
    if (r.status === 404) return null;
    if (!r.ok && r.status !== 206) throw new Error(`Cloud Storage ${r.status}`);
    return r;
  },
  signer: defaultSigner,
  source: modelSource,
});

const MAX_WRITE = 512 * 1024 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** Handles one broker request. */
export async function handleBroker(req: IncomingMessage, res: ServerResponse, url: URL, deps: BrokerDeps = defaultBrokerDeps()) {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const run = readToken(String(req.headers['x-hawkes-run-token'] ?? ''));
  if (!run) return json(401, { error: 'no valid run token' });
  const op = url.searchParams.get('op') ?? '';
  const uri = url.searchParams.get('uri') ?? '';
  const method = req.method ?? 'GET';
  if ((op === 'write') !== (method === 'PUT') || (op === 'put' && method !== 'GET') || !allowed(run, op, uri)) return json(403, { error: `not allowed: ${op} ${uri}` });
  try {
    if (op === 'stat') {
      const s = (await deps.stat(uri)) ?? (await deps.source(uri));
      return s ? json(200, { size: Number(s.size) }) : json(404, { error: 'not found' });
    }
    if (op === 'write') {
      await deps.write(uri, await readBody(req, MAX_WRITE), String(req.headers['content-type'] ?? 'application/octet-stream'));
      return json(200, { ok: true });
    }
    if (op === 'url') {
      const s = await deps.stat(uri);
      if (!s) {
        const src = await deps.source(uri);
        return src ? json(200, { url: src.url, size: src.size, from: 'huggingface' }) : json(404, { error: 'not found' });
      }
      const who = await deps.signer().catch(() => null);
      if (!who) return json(200, { proxy: true, size: Number(s.size) });
      return json(200, { url: await signedGetUrl(uri, who, 900), size: Number(s.size) });
    }
    if (op === 'put') {
      // A signed upload link for one object of this run's folder: large outputs go straight to Cloud Storage and never
      // pass through Cloud Run's 32 MiB request limit. Without a signer the worker falls back to op=write.
      const who = await deps.signer().catch(() => null);
      if (!who) return json(200, { proxy: true });
      return json(200, { url: await signedUrl('PUT', uri, who, 1800) });
    }
    if (op === 'read') {
      const r = await deps.open(uri, req.headers.range ? String(req.headers.range) : undefined);
      if (!r) return json(404, { error: 'not found' });
      const h: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
      for (const k of ['content-length', 'content-range']) { const v = r.headers.get(k); if (v) h[k] = v; }
      res.writeHead(r.status === 206 ? 206 : 200, h);
      if (r.body) for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) res.write(chunk);
      return res.end();
    }
    return json(400, { error: `unknown op ${op}` });
  } catch (e: any) {
    if (!res.headersSent) return json(e.status ?? 502, { error: e.message });
    res.destroy();
  }
}
