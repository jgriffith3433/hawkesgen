// The whole Worker: the same request to Gen on Cloud Run, the answer streamed back as it comes (Gen's event streams and
// downloads included). The visitor's address goes along as X-Hawkes-Client-IP: Gen believes it only when the request
// reached Google from Cloudflare's edge (src/analytics/collect.ts clientIp).
//
// The names that used to be the customer portal (PORTAL_HOSTS: hawkesgen.ai and www before the portal moved to
// hawkesgames.com, docs/domain-move.md) are Gen's now, but links, editors and code out there still use them, so there:
//   - Gen's own paths (the dashboard at /, /sdk/, /client/, /cdn/) are Gen's;
//   - /v1/ and /mcp, which both have, go to Gen first, and to the portal when Gen doesn't know the caller or the route
//     (401 or 404): a portal key (hg_, the same shape as Gen's), a portal OAuth token (hgo_) or the portal's session
//     cookie goes straight to the portal; a platform token (a JWT) only to Gen;
//   - everything else is the portal's: a page (a browser asking for HTML) is redirected to PORTAL_ORIGIN, anything else
//     (OAuth, signed upload and download links, the play API) is passed on to it, so `curl -T` and token refreshes work.
type Env = { GEN_ORIGIN: string; PORTAL_ORIGIN?: string; PORTAL_HOSTS?: string };

const GEN_PAGES = new Set(['/', '/index.html', '/app.js', '/style.css', '/favicon.svg']);
const isGenPath = (p: string) => GEN_PAGES.has(p) || p.startsWith('/sdk/') || p.startsWith('/client/') || p.startsWith('/cdn/');
const isShared = (p: string) => p.startsWith('/v1/') || p === '/mcp' || p.startsWith('/mcp/');
/** The largest body kept to send again to the portal (its own limit for an upload in a request is 30 MB). */
const REPLAY_MAX = 32 * 1024 * 1024;

function forward(request: Request, target: string, body: BodyInit | null, extra: Record<string, string> = {}): Promise<Response> {
  const url = new URL(request.url);
  const to = new URL(target);
  url.protocol = to.protocol;
  url.hostname = to.hostname;
  url.port = '';
  const headers = new Headers(request.headers);
  headers.set('X-Hawkes-Client-IP', request.headers.get('CF-Connecting-IP') ?? '');
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', 'https');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return fetch(url, { method: request.method, headers, body, redirect: 'manual' });
}

/** Who a request on a former portal name is for, by what it carries. */
export function callerOf(request: Request): 'gen' | 'portal' | 'either' {
  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  if (auth.startsWith('hgo_')) return 'portal';
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(auth)) return 'gen';
  if (!auth && /(?:^|;\s*)__session=/.test(request.headers.get('Cookie') ?? '')) return 'portal';
  return 'either';
}

async function onPortalHost(request: Request, env: Env & { PORTAL_ORIGIN: string }): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (isGenPath(p)) return forward(request, env.GEN_ORIGIN, hasBody ? request.body : null);
  if (!isShared(p)) {
    const page = (request.method === 'GET' || request.method === 'HEAD') && /text\/html/.test(request.headers.get('Accept') ?? '');
    if (page) return Response.redirect(`${env.PORTAL_ORIGIN}${p}${url.search}`, 301);
    return forward(request, env.PORTAL_ORIGIN, hasBody ? request.body : null);
  }
  const who = callerOf(request);
  if (who !== 'either') return forward(request, who === 'gen' ? env.GEN_ORIGIN : env.PORTAL_ORIGIN, hasBody ? request.body : null);
  // Gen first; the same request to the portal when Gen doesn't know the key or the route. A body too big to keep goes to
  // Gen alone.
  const size = Number(request.headers.get('Content-Length') ?? NaN);
  if (hasBody && !(size <= REPLAY_MAX)) return forward(request, env.GEN_ORIGIN, request.body);
  const body = hasBody ? await request.arrayBuffer() : null;
  const gen = await forward(request, env.GEN_ORIGIN, body);
  if (gen.status !== 401 && gen.status !== 404) return gen;
  return forward(request, env.PORTAL_ORIGIN, body);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname;
    const portalHosts = (env.PORTAL_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    if (env.PORTAL_ORIGIN && portalHosts.includes(host)) return onPortalHost(request, { ...env, PORTAL_ORIGIN: env.PORTAL_ORIGIN.replace(/\/+$/, '') });
    return forward(request, env.GEN_ORIGIN, request.method === 'GET' || request.method === 'HEAD' ? null : request.body);
  },
};
