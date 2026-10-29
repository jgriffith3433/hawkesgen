// cdn.hawkesgen.ai: GET /sha256/<64 hex> only. A file comes from Cloudflare's cache when it's there, else from Gen's
// CDN origin route (src/api.ts /cdn/sha256/<hash>: Gen reads its private bucket with its own identity, no key), and is
// cached for a year (a hash's bytes never change). Nothing else is served: no listing, no other paths, no writes. Open
// CORS (games load assets from any page).
type Env = { GEN_ORIGIN: string };
const KEY = /^\/sha256\/[0-9a-f]{64}$/;
const YEAR = 31536000;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors });
    const url = new URL(request.url);
    if (!KEY.test(url.pathname)) return new Response('Not found', { status: 404, headers: cors });
    const cache = caches.default;
    const cacheKey = new Request(`https://cdn.hawkesgen.ai${url.pathname}`);
    const hit = await cache.match(cacheKey);
    if (hit) return request.method === 'HEAD' ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
    const r = await fetch(`${env.GEN_ORIGIN}/cdn${url.pathname}`);
    if (!r.ok) return new Response(r.status === 404 ? 'Not found' : 'Not available', { status: r.status === 404 ? 404 : 502, headers: cors });
    const headers = new Headers(cors);
    headers.set('Content-Type', r.headers.get('Content-Type') ?? 'application/octet-stream');
    if (r.headers.get('Content-Length')) headers.set('Content-Length', r.headers.get('Content-Length')!);
    headers.set('Cache-Control', `public, max-age=${YEAR}, immutable`);
    headers.set('X-Content-Type-Options', 'nosniff');
    const res = new Response(r.body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : res;
  },
};
