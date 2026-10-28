// Playtests on Google Cloud Run (docs/playtest-cloudrun.md): the browser runs in the gen-playtest service
// (server/playtest-cloudrun/) on an NVIDIA L4, scale to zero, and Gen drives it as it drives a playtester:
// chromium.connect over a WebSocket, with a Google ID token for Gen's service account (the only invoker).
//
// What changes against the EC2 playtesters (playtester.ts + playtestHost.ts):
// - No SSH, no tunnel, no machines to start or stop. One connection = one browser = one tab; a multiplayer run opens a
//   connection per player (a pool that looks like one browser to playtest.ts), so Cloud Run's per-instance concurrency
//   counts tabs, and Gen's lane admits maxInstances x tabsPerInstance tabs (jobs.ts).
// - Local builds (http://localhost:<port> on the control server) never leave the control server: every request the
//   page makes to that origin is caught with Playwright's context.route() and fetched here, and WebSockets to it are
//   bridged with routeWebSocket(). Nothing is uploaded, nothing listens on the internet, and dev servers work as well as
//   static builds.
// - The video: the screencast's frames come here over CDP as before (the live view reads them); after the run the
//   MJPEG goes to the service's /encode (NVENC on the L4), else it is encoded here.
// - Cost: the tab's seconds times the instance price over its tabs, as a gcp-playtest usage row.

import fs from 'node:fs';
import path from 'node:path';
import { paths, type Settings } from '../../config.ts';
import { gcpTokens } from '../gcp/gcs.ts';
import { loadServiceMap, pricePerSecond } from '../cloudrun/services.ts';
import type { PlaytestHost } from '../comfy/playtestHost.ts';

export type CloudPlaytest = Settings['playtest']['cloudrun'] & { url: string; pricePerSecond: number; region: string; name: string };
export type Backend = 'ec2' | 'cloudrun';

export type ServiceSpec = { name: string; region: string; gpu: string; cpu: number; memoryGi: number; maxInstances: number; tabsPerInstance: number; timeoutSeconds: number };
export const SPEC_FILE = () => path.join(paths.server, 'playtest-cloudrun', 'service.json');
export const loadSpec = (file = SPEC_FILE()): ServiceSpec => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Which backend a playtest of this project runs on: the project's own setting, else the default. */
export function playtestBackendOf(project: string | null | undefined, t: Settings['playtest']): Backend {
  const own = project ? t.projects[project] : undefined;
  return own ?? t.backend;
}

/** The Cloud Run service for this project's playtests, or null (EC2: the backend says so, or nothing is deployed). */
export function cloudPlaytestFor(project: string | null | undefined, settings: Pick<Settings, 'playtest'>, spec: ServiceSpec = loadSpec()): CloudPlaytest | null {
  const t = settings.playtest;
  if (playtestBackendOf(project, t) !== 'cloudrun' || !t.cloudrun.url) return null;
  const map = loadServiceMap();
  return { ...t.cloudrun, url: t.cloudrun.url, pricePerSecond: pricePerSecond(map, spec), region: spec.region, name: spec.name };
}

/** Browser tabs the service plays at once: Gen's lane for Cloud Run playtests. */
export const cloudLanes = (c: Pick<CloudPlaytest, 'maxInstances' | 'tabsPerInstance'>) => c.maxInstances * c.tabsPerInstance;

/** What one tab costs for `seconds`: its share of the instance (GPU + vCPUs + memory over the tabs it holds). */
export const tabCost = (c: Pick<CloudPlaytest, 'pricePerSecond' | 'tabsPerInstance'>, seconds: number, tabs = 1) => (c.pricePerSecond / c.tabsPerInstance) * seconds * tabs;

export const wsEndpointOf = (url: string) => `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/pw`;

// ------------------------------------------------------------------ local builds through the connection

/** The local ports a page URL needs served from here (the same rule as the SSH tunnel's -R). */
export function localPortsOf(pageUrl: string): number[] {
  const u = new URL(pageUrl);
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) ? [Number(u.port || (u.protocol === 'https:' ? 443 : 80))] : [];
}

/** Whether a request is for one of those local origins (http(s) or ws(s), localhost / 127.0.0.1 / [::1]). */
export function isLocal(u: URL | string, ports: Set<number> | number[]): boolean {
  const url = typeof u === 'string' ? new URL(u) : u;
  const set = ports instanceof Set ? ports : new Set(ports);
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return false;
  const port = Number(url.port || (/^(https|wss):$/.test(url.protocol) ? 443 : 80));
  return set.has(port);
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length']);
/** The browser's request headers as fetch may send them (no hop-by-hop ones, no host: fetch sets it). */
export function requestHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase()) && !k.startsWith(':')) out[k] = v;
  return out;
}

/**
 * The local server's response headers as route.fulfill takes them: fetch has already decoded the body, so no
 * content-encoding or length; every Set-Cookie kept (newline-joined, which Playwright splits again).
 */
export function responseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    const key = k.toLowerCase();
    if (HOP.has(key) || key === 'content-encoding' || key === 'set-cookie') return;
    out[key] = v;
  });
  const cookies = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  if (cookies.length) out['set-cookie'] = cookies.join('\n');
  return out;
}

export type ProxyDeps = { fetch: typeof fetch; WebSocket: typeof WebSocket; log?: (s: string) => void };
const defaultProxyDeps = (): ProxyDeps => ({ fetch: (i, init) => fetch(i, init), WebSocket: globalThis.WebSocket });

/** One routed request: fetched here from the local server, answered to the remote browser. */
export async function serveRoute(route: any, deps: ProxyDeps = defaultProxyDeps()) {
  const req = route.request();
  let r: Response;
  try {
    const body = req.postDataBuffer?.() ?? null;
    r = await deps.fetch(req.url(), {
      method: req.method(), headers: requestHeaders(await req.allHeaders()), body: body && !/^(GET|HEAD)$/i.test(req.method()) ? body : undefined,
      redirect: 'manual', signal: AbortSignal.timeout(120_000),
    });
  } catch (e: any) {
    deps.log?.(`local ${req.method()} ${req.url()}: ${e?.cause?.code ?? e?.message ?? e}`);
    await route.abort(/ECONNREFUSED/.test(String(e?.cause?.code ?? e?.message)) ? 'connectionrefused' : 'failed').catch(() => {});
    return;
  }
  const body = req.method().toUpperCase() === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer());
  await route.fulfill({ status: r.status, headers: responseHeaders(r.headers), body }).catch(() => {});
}

/** A routed WebSocket (a dev server's reload socket, a local game server): bridged to the local server from here. */
export function bridgeWebSocket(ws: any, deps: ProxyDeps = defaultProxyDeps()) {
  let target: WebSocket;
  try {
    target = new deps.WebSocket(ws.url());
  } catch {
    ws.close({ code: 1000, reason: 'local server unreachable' }).catch?.(() => {});
    return;
  }
  target.binaryType = 'arraybuffer';
  const pending: (string | Buffer)[] = [];
  let open = false;
  let closed = false;
  const closeBrowserSide = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    // A browser may only be closed with 1000 or 3000-4999.
    const ok = code === 1000 || (typeof code === 'number' && code >= 3000 && code <= 4999);
    Promise.resolve(ws.close({ code: ok ? code : 1000, reason: (reason ?? '').slice(0, 120) })).catch(() => {});
  };
  target.onopen = () => {
    open = true;
    for (const m of pending.splice(0)) target.send(m);
  };
  target.onmessage = (e: MessageEvent) => {
    try {
      ws.send(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer));
    } catch {
      // The page went away.
    }
  };
  target.onclose = (e: CloseEvent) => closeBrowserSide(e.code, e.reason);
  target.onerror = () => closeBrowserSide(1000, 'local server error');
  ws.onMessage((m: string | Buffer) => {
    if (open) target.send(m);
    else pending.push(m);
  });
  ws.onClose(() => {
    closed = true;
    try { target.close(); } catch { /* already closed */ }
  });
}

/** Serves the page's local origins to a remote browser context: requests and WebSockets go through this process. */
export async function proxyLocal(context: any, ports: number[], deps: ProxyDeps = defaultProxyDeps()) {
  if (!ports.length) return;
  const set = new Set(ports);
  await context.route((u: URL) => isLocal(u, set), (route: any) => serveRoute(route, deps));
  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket((u: URL) => isLocal(u, set), (ws: any) => bridgeWebSocket(ws, deps));
}

// ------------------------------------------------------------------ connecting

export type ConnectDeps = { idToken: (aud: string) => Promise<string>; sleep: (ms: number) => Promise<void>; now: () => number };
const defaultConnectDeps = (): ConnectDeps => ({ idToken: (aud) => gcpTokens().id(aud), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });

/** A refusal worth trying again: the service at its max instances (429), an instance starting or going away (503). */
export const retryable = (e: any) => /\b(429|503|502)\b|Too Many|Service Unavailable|ECONNRESET|socket hang up/i.test(String(e?.message ?? e));

/**
 * One browser on the service. Waits through a cold start (Cloud Run holds the request until the startup probe
 * passes: the GPU self-test) and retries a full service (429) or a starting one (503) until `timeoutMs`.
 */
export async function connectOne(chromium: any, c: Pick<CloudPlaytest, 'url'>, { job, timeoutMs = 6 * 60_000, onStep = (_s: string) => {}, deps = defaultConnectDeps() }: { job?: string; timeoutMs?: number; onStep?: (s: string) => void; deps?: ConnectDeps } = {}) {
  const end = deps.now() + timeoutMs;
  let wait = 3_000;
  for (let attempt = 1; ; attempt++) {
    const left = end - deps.now();
    try {
      return await chromium.connect(wsEndpointOf(c.url), {
        timeout: Math.max(10_000, Math.min(left, 5 * 60_000)),
        headers: { Authorization: `Bearer ${await deps.idToken(c.url)}`, ...(job ? { 'x-hawkes-job': job } : {}) },
      });
    } catch (e: any) {
      if (!retryable(e) || deps.now() + wait > end) throw new Error(`Cloud Run playtest service: ${String(e?.message ?? e).split('\n')[0]}`);
      onStep(`the playtest service is full or starting (attempt ${attempt}); trying again in ${Math.round(wait / 1000)} s`);
      await deps.sleep(wait);
      wait = Math.min(30_000, wait * 2);
    }
  }
}

/**
 * The browsers of one playtest, as one browser to playtest.ts: newContext() takes a connected browser with no open
 * context (connecting another if none is free), close() closes them all. `tabs` browsers connect up front, so a
 * multiplayer run finds its players' browsers ready (each may cost a cold start; they start in parallel).
 */
export class BrowserPool {
  browsers: any[] = [];
  private connect: () => Promise<any>;
  constructor(connect: () => Promise<any>) {
    this.connect = connect;
  }
  async open(n: number) {
    const got = await Promise.allSettled(Array.from({ length: n }, () => this.connect()));
    for (const g of got) if (g.status === 'fulfilled') this.browsers.push(g.value);
    const failed = got.find((g) => g.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) {
      await this.close();
      throw failed.reason;
    }
    return this;
  }
  async newContext(options: any) {
    let b = this.browsers.find((x) => x.isConnected?.() !== false && x.contexts().length === 0);
    if (!b) {
      b = await this.connect();
      this.browsers.push(b);
    }
    return b.newContext(options);
  }
  async close() {
    await Promise.all(this.browsers.map((b) => b.close().catch(() => {})));
  }
}

// ------------------------------------------------------------------ the host

/**
 * A playtest's browser on Cloud Run, shaped like the EC2 host (playtestHost.ts PlaytestHost): its `tabs` connections
 * are made here (so a failure falls back to the playtesters before the run starts), local origins are served through
 * each context, the video encodes on the service, and close() records the tab-seconds as a gcp-playtest usage row.
 */
export async function openCloudPlaytestHost(c: CloudPlaytest, { pageUrl, tabs = 1, job, step = (_s: string) => {}, onUsage, chromium, connectDeps, proxyDeps }: {
  pageUrl: string; tabs?: number; job?: string; step?: (s: string) => void;
  onUsage?: (u: { provider: string; unit: string; amount: number; cost?: number; detail?: string }) => void;
  chromium?: any; connectDeps?: ConnectDeps; proxyDeps?: ProxyDeps;
}): Promise<PlaytestHost> {
  const pw = chromium ?? (await import('playwright')).chromium;
  const ports = localPortsOf(pageUrl);
  const n = Math.max(1, Math.min(8, Math.round(tabs)));
  step(`opening ${n === 1 ? 'a browser' : `${n} browsers`} on Cloud Run (${c.name}, ${c.region}; a cold start takes a minute or two)`);
  const t0 = Date.now();
  const pool = await new BrowserPool(() => connectOne(pw, c, { job, onStep: step, deps: connectDeps })).open(n);
  const connectedAt = Date.now();
  let closed = false;
  return {
    wsEndpoint: wsEndpointOf(c.url),
    server: `Cloud Run ${c.name} (${c.region})`,
    playtester: null,
    backend: 'cloudrun',
    ssh: null,
    browser: pool,
    // The remote browser asks for http://localhost:<port> as the page says; routing answers it from here.
    mapUrl: (url: string) => url,
    contextOptions: ports.length ? { serviceWorkers: 'block' } : {},
    prepareContext: (context: any) => proxyLocal(context, ports, proxyDeps),
    encode: c.encode === 'service' ? (mjpeg, out, viewport, signal) => encodeOnService(c, mjpeg, out, viewport, signal) : undefined,
    close() {
      if (closed) return;
      closed = true;
      void pool.close();
      const seconds = Math.round((Date.now() - connectedAt) / 100) / 10;
      onUsage?.({
        provider: 'gcp-playtest', unit: 'tab_seconds', amount: Math.round(seconds * n * 10) / 10, cost: Math.round(tabCost(c, seconds, n) * 10_000) / 10_000,
        detail: `${n} tab(s) on ${c.name} for ${seconds} s (connecting took ${Math.round((connectedAt - t0) / 1000)} s); the instance's idle tail is not included`,
      });
    },
  };
}

// ------------------------------------------------------------------ the video

export const encodeUrlOf = (url: string, viewport: { width: number; height: number }) => `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/encode?w=${viewport.width}&h=${viewport.height}`;

/**
 * Encodes the screencast's MJPEG on the service (NVENC there) over a WebSocket (Cloud Run caps an HTTP/1 request body
 * at 32 MiB; a few minutes of MJPEG is hundreds of MB). Returns the encoder's name. Throws to fall back here.
 * The protocol (server.mjs encodeSession): binary chunks, then "end"; back {"encoder","bytes"}, the mp4's chunks, "done".
 */
export async function encodeOnService(c: Pick<CloudPlaytest, 'url'>, mjpeg: string, out: string, viewport: { width: number; height: number }, signal: AbortSignal, deps: { WebSocket: any; idToken: (aud: string) => Promise<string> } = { WebSocket: globalThis.WebSocket, idToken: (aud) => gcpTokens().id(aud) }): Promise<string> {
  const token = await deps.idToken(c.url);
  // Node's WebSocket (undici) takes request headers as its second argument.
  const ws = new deps.WebSocket(encodeUrlOf(c.url, viewport), { headers: { Authorization: `Bearer ${token}` } });
  ws.binaryType = 'arraybuffer';
  return new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = [];
    let info: { encoder?: string; bytes?: number; error?: string } | null = null;
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* closed */ }
      reject(e);
    };
    const onAbort = () => fail(new Error('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    ws.onerror = () => fail(new Error('the service\'s encode connection failed'));
    ws.onclose = () => fail(new Error('the service closed the encode before the video came back'));
    ws.onopen = async () => {
      try {
        for await (const chunk of fs.createReadStream(mjpeg, { highWaterMark: 1 << 20 })) {
          if (settled) return;
          ws.send(chunk);
          // Don't queue hundreds of MB in memory: wait while the socket's buffer is full.
          while (ws.bufferedAmount > 8 * (1 << 20) && !settled) await new Promise((r) => setTimeout(r, 20));
        }
        ws.send('end');
      } catch (e: any) {
        fail(new Error(`sending the video: ${e?.message ?? e}`));
      }
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return void parts.push(Buffer.from(e.data as ArrayBuffer));
      if (e.data === 'done') {
        const buf = Buffer.concat(parts);
        if (info?.bytes !== undefined && buf.length !== info.bytes) return fail(new Error(`the video came back short (${buf.length} of ${info.bytes} bytes)`));
        if (!buf.length) return fail(new Error('the service sent an empty video'));
        fs.writeFileSync(out, buf);
        settled = true;
        signal.removeEventListener('abort', onAbort);
        try { ws.close(); } catch { /* closed */ }
        return resolve(info?.encoder ?? 'unknown');
      }
      try {
        info = JSON.parse(e.data);
      } catch {
        return;
      }
      if (info?.error) fail(new Error(`the service's encode failed: ${info.error}`));
    };
  });
}

/** The service's GPU self-test (GET /selftest): how WebGL reaches the GPU there, the driver's libraries, NVENC. */
export async function cloudSelfTest(c: Pick<CloudPlaytest, 'url'>, { fresh = false, all = false } = {}) {
  const q = [fresh ? 'fresh=1' : '', all ? 'all=1' : ''].filter(Boolean).join('&');
  const r = await fetch(`${c.url}/selftest${q ? `?${q}` : ''}`, { headers: { Authorization: `Bearer ${await gcpTokens().id(c.url)}` }, signal: AbortSignal.timeout(8 * 60_000) });
  if (!r.ok) throw new Error(`The playtest service answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json();
}
