// The broker's door (broker.ts says what it is): one gs:// object per request, the run's token in
// X-Hawkes-Run-Token. Answers before Gen's key check (the token is the credential), from api.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gcs, gcpTokens } from '../gcp/gcs.ts';
import { readToken, allowed } from './broker.ts';
import { signer as defaultSigner, signedGetUrl, type Signer } from './sign.ts';

export type BrokerDeps = {
  stat: (uri: string) => Promise<{ size: number } | null>;
  write: (uri: string, data: Buffer, contentType: string) => Promise<unknown>;
  /** The object's bytes as a stream (with a Range header passed on), or null when it isn't there. */
  open: (uri: string, range?: string) => Promise<Response | null>;
  signer: () => Promise<Signer | null>;
};

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
  if ((op === 'write') !== (method === 'PUT') || !allowed(run, op, uri)) return json(403, { error: `not allowed: ${op} ${uri}` });
  try {
    if (op === 'stat') {
      const s = await deps.stat(uri);
      return s ? json(200, { size: Number(s.size) }) : json(404, { error: 'not found' });
    }
    if (op === 'write') {
      await deps.write(uri, await readBody(req, MAX_WRITE), String(req.headers['content-type'] ?? 'application/octet-stream'));
      return json(200, { ok: true });
    }
    if (op === 'url') {
      const s = await deps.stat(uri);
      if (!s) return json(404, { error: 'not found' });
      const who = await deps.signer().catch(() => null);
      if (!who) return json(200, { proxy: true, size: Number(s.size) });
      return json(200, { url: await signedGetUrl(uri, who, 900), size: Number(s.size) });
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
