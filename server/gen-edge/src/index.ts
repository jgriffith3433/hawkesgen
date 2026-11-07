// The whole Worker: the same request to Gen on Cloud Run, the answer streamed back as it comes (Gen's event streams and
// downloads included). The visitor's address goes along as X-Hawkes-Client-IP: Gen believes it only when the request
// reached Google from Cloudflare's edge (src/analytics/collect.ts clientIp).
//
// The names that used to be the customer portal (PORTAL_HOSTS: hawkesgen.ai and www before the portal moved to
// hawkesgames.com, docs/domain-move.md) are Gen's now: Gen's app, its sign-in, /legal, /admin, the API. Links, editors
// and code out there still name the portal there, so:
//   - Gen's MCP and its sign-in (/mcp, /oauth/, /.well-known/oauth-*) and its signed links (/dl/, /up/) are Gen's alone
//     (2026-10-30: the portal's MCP moved here, signing in with Gen accounts);
//   - a portal OAuth token (hgo_) goes to the portal, and so does the portal's session cookie on /v1 and /mcp;
//     a platform token (a JWT) only to Gen;
//   - everything else goes to Gen first. What Gen doesn't have (404) is the portal's: a page (a browser asking for HTML)
//     is redirected to PORTAL_ORIGIN, anything else (OAuth, signed upload and download links, the play API) is passed on
//     to it, so `curl -T` and token refreshes work. On /v1 and /mcp a key Gen refuses (401: a portal key, hg_ like Gen's)
//     is passed on to the portal too.
type Env = { GEN_ORIGIN: string; PORTAL_ORIGIN?: string; PORTAL_HOSTS?: string };

const isApi = (p: string) => p.startsWith('/v1/') || p === '/mcp' || p.startsWith('/mcp/');
/** Gen's own sign-in for editors (src/genoauth.ts, 2026-10-30): its MCP and OAuth are never the portal's, refused or not. */
const genOnly = (p: string) => p === '/mcp' || p.startsWith('/mcp/') || p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth-') || p === '/.well-known/openid-configuration' || p.startsWith('/dl/') || p.startsWith('/up/');
/** The largest body kept to send again to the portal (its own limit for an upload in a request is 30 MB). */
const REPLAY_MAX = 32 * 1024 * 1024;

/**
 * When Gen can't be reached or drops the connection part way (a restart or a deploy while an AI answer is being written),
 * fetch() throws and Cloudflare would answer with its own HTML error page, which the app then printed as the AI's reply
 * (2026-11-02). The API gets Gen's own JSON error shape instead; a page gets a short plain page.
 */
export function unreachable(request: Request): Response {
  const api = isApi(new URL(request.url).pathname);
  const error = 'Gen was interrupted before it could answer (it may have just restarted). Nothing was lost: please try again.';
  return api
    ? new Response(JSON.stringify({ error, kind: 'unreachable' }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' } })
    : new Response(`Hawkes Gen is restarting. Please reload in a few seconds.`, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' } });
}

/**
 * Gen restarting, by the answer: Google's own HTML error page from Cloud Run (500 "could not start", 503 "readiness"),
 * or Gen's stand-in for a deploy's old copy (server/gen-cloudrun/standby.mjs, X-Hawkes-Restarting). During a deploy the
 * old copy hands the database to the new one and for about half a minute nothing else answers (2026-11-02: the app's
 * live stream got Google's "Server Error" page and the browser gave up on it).
 */
export const restarting = (r: Response) => r.headers.get('X-Hawkes-Restarting') === '1' || (r.status >= 500 && /text\/html/i.test(r.headers.get('Content-Type') ?? ''));

/** The waits between tries of a read while Gen restarts: about 25 s in all, a deploy's handover. */
export const RETRY_WAITS = [1000, 2000, 3000, 4000, 5000, 5000, 5000];
let wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** For tests: no real waiting. */
export function setWait(fn: (ms: number) => Promise<void>) { wait = fn; }

/** What a caller gets when Gen is still restarting after the waits: Gen's JSON error shape, or a short plain page. */
export function stillRestarting(request: Request): Response {
  const path = new URL(request.url).pathname;
  // An event stream that ends normally after `retry:` is opened again by the browser itself, in 5 s.
  if (path === '/v1/events') return new Response('retry: 5000\n: Gen is restarting\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  const error = 'Gen is restarting (a new version is starting up). Please try again in a few seconds.';
  return isApi(path)
    ? new Response(JSON.stringify({ error, kind: 'restarting' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' } })
    : new Response('Hawkes Gen is restarting. Please reload in a few seconds.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' } });
}

async function forward(request: Request, target: string, body: BodyInit | null): Promise<Response> {
  // A read is asked again while Gen restarts, so the caller waits a little instead of seeing an error; a write (it may
  // have happened) never is.
  const read = request.method === 'GET' || request.method === 'HEAD';
  for (let i = 0; ; i++) {
    let r: Response;
    try {
      r = await send(request, target, body);
    } catch (e) {
      console.error(`gen-edge: ${request.method} ${new URL(request.url).pathname} to ${new URL(target).hostname} failed: ${(e as Error)?.message ?? e}`);
      return unreachable(request);
    }
    if (!restarting(r)) {
      // Workers Logs keep only error lines (wrangler.jsonc): a 5xx from Gen is one, a routine hit is never logged.
      if (r.status >= 500) console.error(`gen-edge: ${request.method} ${new URL(request.url).pathname}: ${r.status} from ${new URL(target).hostname}`);
      return r;
    }
    if (!read || i >= RETRY_WAITS.length) {
      console.error(`gen-edge: ${request.method} ${new URL(request.url).pathname}: Gen restarting (${r.status})${read ? ' after the waits' : ''}`);
      return stillRestarting(request);
    }
    await r.body?.cancel();
    await wait(RETRY_WAITS[i]);
  }
}

function send(request: Request, target: string, body: BodyInit | null): Promise<Response> {
  const url = new URL(request.url);
  const to = new URL(target);
  url.protocol = to.protocol;
  url.hostname = to.hostname;
  url.port = '';
  const headers = new Headers(request.headers);
  headers.set('X-Hawkes-Client-IP', request.headers.get('CF-Connecting-IP') ?? '');
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('X-Forwarded-Proto', 'https');
  return fetch(url, { method: request.method, headers, body, redirect: 'manual' });
}

/** Who a request on a former portal name is for, by what it carries. */
export function callerOf(request: Request): 'gen' | 'portal' | 'either' {
  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  if (auth.startsWith('hgo_')) return 'portal';
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(auth)) return 'gen';
  if (!auth && isApi(new URL(request.url).pathname) && /(?:^|;\s*)__session=/.test(request.headers.get('Cookie') ?? '')) return 'portal';
  return 'either';
}

async function onPortalHost(request: Request, env: Env & { PORTAL_ORIGIN: string }): Promise<Response> {
  const url = new URL(request.url);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (genOnly(url.pathname)) return forward(request, env.GEN_ORIGIN, hasBody ? request.body : null);
  const who = callerOf(request);
  if (who !== 'either') return forward(request, who === 'gen' ? env.GEN_ORIGIN : env.PORTAL_ORIGIN, hasBody ? request.body : null);
  // Gen first; the portal for what Gen doesn't have. A body too big to keep goes to Gen alone.
  const size = Number(request.headers.get('Content-Length') ?? NaN);
  if (hasBody && !(size <= REPLAY_MAX)) return forward(request, env.GEN_ORIGIN, request.body);
  const body = hasBody ? await request.arrayBuffer() : null;
  const gen = await forward(request, env.GEN_ORIGIN, body);
  if (!(gen.status === 404 || (gen.status === 401 && isApi(url.pathname)))) return gen;
  const page = (request.method === 'GET' || request.method === 'HEAD') && !isApi(url.pathname) && /text\/html/.test(request.headers.get('Accept') ?? '');
  if (page) return Response.redirect(`${env.PORTAL_ORIGIN}${url.pathname}${url.search}`, 301);
  const portal = await forward(request, env.PORTAL_ORIGIN, body);
  // An API call the portal doesn't have either comes back as its 404 (HTML page or JSON): Gen's own answer says more. A
  // signed-out call to Gen's own route (GET /v1/editor/tools) is Gen's 401, not the portal's "not found" (2026-11-02).
  if (isApi(url.pathname) && !portal.ok && (portal.status === 404 || /text\/html/i.test(portal.headers.get('Content-Type') ?? ''))) return gen;
  return portal;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname;
    const portalHosts = (env.PORTAL_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    if (env.PORTAL_ORIGIN && portalHosts.includes(host)) return onPortalHost(request, { ...env, PORTAL_ORIGIN: env.PORTAL_ORIGIN.replace(/\/+$/, '') });
    return forward(request, env.GEN_ORIGIN, request.method === 'GET' || request.method === 'HEAD' ? null : request.body);
  },
};
