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
//
// The CPU variant (gen-playtest-cpu, settings.playtest "cloudrun-cpu" / cloudrunCpu; docs/playtest-cloudrun.md, "The
// CPU service") is the same service and the same code here without a GPU: WebGL on SwiftShader, request-based billing
// (no idle tail), a usage row gcp-playtest-cpu, longer waits (`slow`), and the run reports software rendering.

import fs from 'node:fs';
import path from 'node:path';
import { paths, type Settings, type PlaytestBackend, type PlaytestProvider } from '../../config.ts';
import { gcpTokens } from '../gcp/gcs.ts';
import { runpodCreditProblem } from '../gpu/credit.ts';
import { isDown } from '../gpu/health.ts';
import { runpodEndpointMax } from './runpodcap.ts';
import { loadServiceMap, pricePerSecond } from '../cloudrun/services.ts';
import type { PlaytestHost } from '../comfy/playtestHost.ts';

export type Variant = 'gpu' | 'cpu' | 'runpod' | 'modal';
/**
 * One Cloud Run playtest service as Gen uses it. `variant` cpu is gen-playtest-cpu (software WebGL); `slow` multiplies
 * the boot wait and the default scenario limit there; `software` says why frame rates mean little (null on the L4).
 */
export type CloudPlaytest = Settings['playtest']['cloudrun'] & { idleSeconds?: number; gpu?: string; url: string; pricePerSecond: number; region: string; name: string; variant?: Variant; slow?: number; software?: string | null;
  /** The runner it is in settings.playtest.runners (runners.ts): its slot and cooldown. */ runner?: string };

/**
 * A build the browser service fetches and serves itself (docs/playtest-runners.md, "Web builds"): the X-Hawkes-Site
 * header on the /pw connection. The service downloads the archive from the signed URL, unpacks it, serves it on its own
 * loopback and maps SITE_HOST to it in that browser, so the page is http://build.hawkes.test/<entry> and Gen serves nothing.
 */
export const SITE_HOST = 'build.hawkes.test';
export const siteHeader = (b: { url: string; kind?: string; sha256?: string; name?: string }) =>
  Buffer.from(JSON.stringify({ url: b.url, kind: b.kind ?? 'archive', sha256: b.sha256 ?? null, name: b.name ?? null })).toString('base64url');
export const sitePageUrl = (entry: string | null | undefined) => `http://${SITE_HOST}/${String(entry ?? '').replace(/^\/+/, '')}`;
export type Backend = PlaytestBackend;

export type ServiceSpec = {
  name: string; region: string; gpu: string | null; cpu: number; memoryGi: number; maxInstances: number; tabsPerInstance: number; timeoutSeconds: number;
  variant?: Variant; slow?: number; prices?: { cpuPerVcpuSecond: number; memoryPerGibSecond: number };
};
export const SPEC_FILE = (variant: Exclude<Variant, 'runpod' | 'modal'> = 'gpu') => path.join(paths.server, 'playtest-cloudrun', variant === 'cpu' ? 'service-cpu.json' : 'service.json');
export const loadSpec = (file = SPEC_FILE()): ServiceSpec => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Which backend a playtest of this project runs on: the project's own setting, else the default. */
export function playtestBackendOf(project: string | null | undefined, t: Settings['playtest']): Backend {
  const own = project ? t.projects[project] : undefined;
  return own ?? t.backend;
}

/** The instance's price per second: the CPU service's own request-based rates, else the L4 rates of services.json. */
export function specPricePerSecond(spec: ServiceSpec): number {
  if (!spec.gpu) {
    const r = spec.prices ?? { cpuPerVcpuSecond: 0.000024, memoryPerGibSecond: 0.0000025 };
    return spec.cpu * r.cpuPerVcpuSecond + spec.memoryGi * r.memoryPerGibSecond;
  }
  return pricePerSecond(loadServiceMap(), { gpu: spec.gpu, cpu: spec.cpu, memoryGi: spec.memoryGi });
}

/** Why a run on the CPU service renders in software (the result's softwareBecause; the review ignores frame rates). */
export const CPU_SOFTWARE_WHY = 'played on the Cloud Run CPU service (gen-playtest-cpu): WebGL on SwiftShader, no GPU, so frame rates and smoothness say nothing about players';

/**
 * The Cloud Run services this project's playtests try, in order: "cloudrun" is the L4 service, then the CPU service
 * when it is deployed (a missing L4 falls back to software WebGL before the playtesters); "cloudrun-cpu" is the CPU
 * service only; "ec2" is none. Empty: the playtesters (and their own fallbacks) as before.
 */
export function cloudPlaytestsFor(project: string | null | undefined, settings: Pick<Settings, 'playtest'>, specs: { gpu?: ServiceSpec; cpu?: ServiceSpec } = {}): CloudPlaytest[] {
  const t = settings.playtest;
  const order = playtestVariantsFor(project, t);
  const out: CloudPlaytest[] = [];
  for (const v of order) {
    if (v === 'modal') {
      if (t.modal?.url) out.push(modalPlaytest({ ...t.modal, url: t.modal.url }));
      continue;
    }
    if (v === 'runpod') {
      // The endpoint's own workers.max once Gen has read it (runpodcap.ts), so raising the endpoint raises the lane.
      const live = runpodEndpointMax(t.runpod?.url);
      if (t.runpod?.url) out.push(runpodPlaytest({ ...t.runpod, url: t.runpod.url, ...(live ? { maxInstances: live } : {}) }));
      continue;
    }
    const conf = v === 'cpu' ? t.cloudrunCpu : t.cloudrun;
    if (!conf?.url) continue;
    const spec = specs[v] ?? loadSpec(SPEC_FILE(v));
    const one = { ...conf, url: conf.url, pricePerSecond: specPricePerSecond(spec), region: spec.region, name: spec.name, variant: v,
      slow: v === 'cpu' ? Math.max(1, Number(spec.slow) || 2) : 1, software: v === 'cpu' ? CPU_SOFTWARE_WHY : null };
    out.push(one);
    // The CPU service's other regions, in order: each has its own Cloud Run CPU quota (settings.playtest.cloudrunCpu.extra).
    if (v === 'cpu') for (const x of t.cloudrunCpu.extra ?? []) out.push({ ...one, url: x.url, region: x.region, maxInstances: x.maxInstances });
  }
  return out;
}

const VARIANT_OF: Record<PlaytestProvider, Variant> = { runpod: 'runpod', modal: 'modal', cloudrun: 'gpu', 'cloudrun-cpu': 'cpu' };
export const providerOfVariant = (v: Variant | undefined): PlaytestProvider => (v === 'runpod' ? 'runpod' : v === 'modal' ? 'modal' : v === 'cpu' ? 'cloudrun-cpu' : 'cloudrun');

/**
 * The browser services a web playtest of this project tries, in order, as variants. A project's own backend
 * (settings.playtest.projects) keeps today's rule; else settings.playtest.order (Studio's provider order) when it is
 * set, without the disabled ones; else the default backend's rule (runpod: RunPod then the CPU service; cloudrun: the L4
 * then the CPU service; cloudrun-cpu: the CPU service; ec2: none). Software WebGL is always last.
 */
export function playtestVariantsFor(project: string | null | undefined, t: Settings['playtest']): Variant[] {
  const own = project ? t.projects[project] : undefined;
  if (!own && t.order?.length) {
    const off = new Set(t.disabled ?? []);
    return t.order.filter((id) => !off.has(id)).map((id) => VARIANT_OF[id]);
  }
  const backend = own ?? t.backend;
  return backend === 'runpod' ? ['runpod', 'cpu'] : backend === 'cloudrun' ? ['gpu', 'cpu'] : backend === 'cloudrun-cpu' ? ['cpu'] : [];
}

/** A web playtest provider's cooldown key after it refused us (gpu/health.ts), for providers not listed as runners. */
export const providerHealthKey = (v: Variant | undefined) => `playtest:${providerOfVariant(v)}`;
/** The provider's cooldown now, or null. */
export const providerDown = (c: Pick<CloudPlaytest, 'variant' | 'runner'>, now = Date.now()) => isDown(c.runner ? `runner:${c.runner}` : providerHealthKey(c.variant), now);

/** The Modal web endpoint as a playtest service: a GPU container per `tabsPerInstance` browsers, billed per second. */
export function modalPlaytest(m: Settings['playtest']['modal'] & { url: string }): CloudPlaytest {
  const app = /^https:\/\/[a-z0-9-]+?--([a-z0-9-]+)\.modal\.run/.exec(m.url)?.[1] ?? 'local';
  return { ...m, url: m.url, pricePerSecond: m.pricePerHour / 3600, region: 'Modal', name: `modal ${app}`, variant: 'modal', slow: 1, software: null };
}

/** The RunPod endpoint as a playtest service (docs/playtest-runpod.md): a real GPU, billed per worker second. */
export function runpodPlaytest(r: Omit<Settings['playtest']['runpod'], 'workerQuota'> & { url: string }): CloudPlaytest {
  const id = /^https:\/\/([a-z0-9]+)(?:\.api\.runpod\.ai|-\d+\.proxy\.runpod\.net)/.exec(r.url)?.[1] ?? 'local';
  return { ...r, url: r.url, pricePerSecond: r.pricePerHour / 3600, region: 'RunPod', name: `runpod ${id}`, variant: 'runpod', slow: 1, software: null };
}

/** The first Cloud Run service for this project's playtests, or null (EC2: the backend says so, or nothing is deployed). */
export function cloudPlaytestFor(project: string | null | undefined, settings: Pick<Settings, 'playtest'>, spec?: ServiceSpec): CloudPlaytest | null {
  return cloudPlaytestsFor(project, settings, spec ? { [spec.gpu ? 'gpu' : 'cpu']: spec } : {})[0] ?? null;
}

/** The queue lane a Cloud Run playtest takes: one per service, so the L4's and the CPU service's tabs are counted apart. */
export const cloudLaneKey = (c: Pick<CloudPlaytest, 'variant'>) => (c.variant === 'cpu' ? 'playtest-cloud-cpu' : c.variant === 'runpod' ? 'playtest-runpod' : c.variant === 'modal' ? 'playtest-modal' : 'playtest-cloud');

/** Browser tabs the service plays at once: Gen's lane for Cloud Run playtests. */
export const cloudLanes = (c: Pick<CloudPlaytest, 'maxInstances' | 'tabsPerInstance'>) => c.maxInstances * c.tabsPerInstance;

/** What one tab costs for `seconds`: its share of the instance (GPU + vCPUs + memory over the tabs it holds). */
export const tabCost = (c: Pick<CloudPlaytest, 'pricePerSecond' | 'tabsPerInstance'>, seconds: number, tabs = 1) => (c.pricePerSecond / c.tabsPerInstance) * seconds * tabs;

/** A service on this machine (http://127.0.0.1:<port>, the container run beside Gen): no Google token. */
export const isLocalService = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url);
/** The Authorization header for a call to the service: a Google ID token for Cloud Run, nothing for a local one. */
export const authFor = async (url: string, idToken: (aud: string) => Promise<string>): Promise<Record<string, string>> => (isLocalService(url) ? {} : { Authorization: `Bearer ${await idToken(url)}` });

/**
 * RunPod's headers (docs/playtest-runpod.md): RunPod's gateway checks Gen's RUNPOD_API_KEY (and drops it); the service
 * checks X-Hawkes-Token against its HAWKES_TOKEN (PLAYTEST_RUNPOD_TOKEN here, else GPU_WORKER_TOKEN, the worker lock
 * Gen already has). A local container gets only the token.
 */
/** A RunPod serverless endpoint's address (its gateway checks the API key), as opposed to a Pod's proxy or a local container. */
export const isRunpodGateway = (url: string) => /^https:\/\/[a-z0-9]+\.api\.runpod\.ai\/?$/.test(url);

export function runpodHeaders(url: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.PLAYTEST_RUNPOD_TOKEN || env.GPU_WORKER_TOKEN || '';
  // The API key only ever goes to RunPod's serverless gateway: a Pod's proxy (https://<pod>-8080.proxy.runpod.net) hands
  // every header to the container.
  return { ...(isRunpodGateway(url) && env.RUNPOD_API_KEY ? { Authorization: `Bearer ${env.RUNPOD_API_KEY}` } : {}), ...(token ? { 'X-Hawkes-Token': token } : {}) };
}

/**
 * Modal's headers: Modal's gateway checks a proxy auth token (MODAL_PROXY_KEY / MODAL_PROXY_SECRET, the ones Gen's GPU
 * jobs use) and the image checks X-Hawkes-Token against its HAWKES_TOKEN (PLAYTEST_MODAL_TOKEN, else GPU_WORKER_TOKEN).
 * The proxy token only ever goes to *.modal.run; a local container gets only the image's token.
 */
export function modalHeaders(url: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.PLAYTEST_MODAL_TOKEN || env.GPU_WORKER_TOKEN || '';
  const gateway = /^https:\/\/[a-z0-9-]+\.modal\.run\/?$/.test(url) && env.MODAL_PROXY_KEY && env.MODAL_PROXY_SECRET;
  return { ...(gateway ? { 'Modal-Key': env.MODAL_PROXY_KEY!, 'Modal-Secret': env.MODAL_PROXY_SECRET! } : {}), ...(token ? { 'X-Hawkes-Token': token } : {}) };
}

/** The headers for a call to a playtest service: RunPod's or Modal's for theirs, a Google ID token for Cloud Run. */
export const headersFor = async (c: Pick<CloudPlaytest, 'url'> & Partial<Pick<CloudPlaytest, 'variant'>>, idToken: (aud: string) => Promise<string>, env?: Record<string, string | undefined>) =>
  (c.variant === 'runpod' ? runpodHeaders(c.url, env) : c.variant === 'modal' ? modalHeaders(c.url, env) : authFor(c.url, idToken));

/** A provider's refusal for money (Modal's spend limit or credit, a 402): no use waiting or retrying there. */
export const refusedForMoney = (e: any) => /\b402\b|Payment Required|billing|spend(ing)? limit|out of credits?|insufficient (funds|credits?|balance)/i.test(String(e?.message ?? e));

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

export type ConnectDeps = { idToken: (aud: string) => Promise<string>; sleep: (ms: number) => Promise<void>; now: () => number; env?: Record<string, string | undefined> };
const defaultConnectDeps = (): ConnectDeps => ({ idToken: (aud) => gcpTokens().id(aud), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });

/**
 * A refusal worth trying again: the service at its max instances (429), an instance starting or going away (503), or a
 * 500 on the WebSocket while a new instance cold-starts (2026-10-29: two playtests at once, one tab per instance).
 */
const serviceLabel = (v: Variant | undefined) => (v === 'runpod' ? 'RunPod' : v === 'modal' ? 'Modal' : 'Cloud Run');
export const retryable = (e: any) => /\b(429|503|502|500|504|408|524)\b|Too Many|Service Unavailable|Internal Server Error|Gateway Time-?out|no workers|ECONNRESET|socket hang up/i.test(String(e?.message ?? e));

/**
 * One browser on the service. Waits through a cold start (Cloud Run holds the request until the startup probe
 * passes: the GPU self-test) and retries a full service (429) or a starting one (503) until `timeoutMs`.
 */
export async function connectOne(chromium: any, c: Pick<CloudPlaytest, 'url'> & Partial<Pick<CloudPlaytest, 'variant'>>, { job, site, timeoutMs = 6 * 60_000, onStep = (_s: string) => {}, deps = defaultConnectDeps() }: { job?: string; site?: string; timeoutMs?: number; onStep?: (s: string) => void; deps?: ConnectDeps } = {}) {
  const end = deps.now() + timeoutMs;
  let wait = 3_000;
  for (let attempt = 1; ; attempt++) {
    const left = end - deps.now();
    // An empty RunPod balance starts no worker (gpu/credit.ts): no use waiting for one.
    const broke = c.variant === 'runpod' ? runpodCreditProblem(deps.env ? (k) => deps.env![k] : undefined) : null;
    if (broke) throw new Error(`RunPod playtest service: ${broke}`);
    try {
      return await chromium.connect(wsEndpointOf(c.url), {
        timeout: Math.max(10_000, Math.min(left, 5 * 60_000)),
        headers: { ...(await headersFor(c, deps.idToken, deps.env)), ...(job ? { 'x-hawkes-job': job } : {}), ...(site ? { 'x-hawkes-site': site } : {}) },
      });
    } catch (e: any) {
      // A RunPod or Modal gateway may hold the handshake while a worker cold-starts until Playwright's own timeout: there
      // that is a slow start, not a refusal, so it is tried again until the whole wait is up. A refusal for money isn't.
      const gateway = c.variant === 'runpod' || c.variant === 'modal';
      const again = !refusedForMoney(e) && (retryable(e) || (gateway && /Timeout \d+ ?ms exceeded/i.test(String(e?.message ?? e))));
      if (!again || deps.now() + wait > end) throw new Error(`${serviceLabel(c.variant)} playtest service: ${String(e?.message ?? e).split('\n')[0]}`);
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
export async function openCloudPlaytestHost(c: CloudPlaytest, { pageUrl, tabs = 1, job, site, step = (_s: string) => {}, onUsage, chromium, connectDeps, proxyDeps, connectTimeoutMs }: {
  pageUrl: string; tabs?: number; job?: string; step?: (s: string) => void;
  /** A build the service serves itself (siteHeader): nothing is served from here then. */ site?: string;
  onUsage?: (u: { provider: string; unit: string; amount: number; cost?: number; detail?: string }) => void;
  chromium?: any; connectDeps?: ConnectDeps; proxyDeps?: ProxyDeps;
  /** How long to wait for a browser here before giving up (another region may have room); connectOne's default otherwise. */
  connectTimeoutMs?: number;
}): Promise<PlaytestHost> {
  const pw = chromium ?? (await import('playwright')).chromium;
  // Local origins are served from here only for J's own local builds; a build the service serves itself needs none.
  const ports = site ? [] : localPortsOf(pageUrl);
  const n = Math.max(1, Math.min(8, Math.round(tabs)));
  const cpu = c.variant === 'cpu';
  const runpod = c.variant === 'runpod';
  const modal = c.variant === 'modal';
  const where = runpod ? `RunPod (${c.name.replace(/^runpod /, 'endpoint ')}, ${c.gpu ?? 'GPU'})` : modal ? `Modal (${c.name.replace(/^modal /, '')}, ${c.gpu ?? 'GPU'})` : `Cloud Run (${c.name}, ${c.region}${cpu ? ', software WebGL' : ''})`;
  step(`opening ${n === 1 ? 'a browser' : `${n} browsers`} on ${where}; a cold start takes ${cpu ? 'about half a minute' : runpod ? 'up to a few minutes (the image is pulled once per machine)' : modal ? 'a minute or two (the GPU self-test)' : 'a minute or two'}`);
  const t0 = Date.now();
  // A router's runner (runners.ts) counts this run against its maxConcurrent until close().
  const releaseRunner = c.runner ? (await import('./runners.ts')).claimRunner(c.runner) : () => {};
  let pool: BrowserPool;
  try {
    pool = await new BrowserPool(() => connectOne(pw, c, { job, site, onStep: step, deps: connectDeps, ...(connectTimeoutMs ? { timeoutMs: connectTimeoutMs } : {}) })).open(n);
  } catch (e) {
    releaseRunner();
    throw e;
  }
  const connectedAt = Date.now();
  let closed = false;
  return {
    wsEndpoint: wsEndpointOf(c.url),
    server: runpod ? `RunPod ${c.name.replace(/^runpod /, '')} (${c.gpu ?? 'GPU'})` : modal ? `Modal ${c.name.replace(/^modal /, '')} (${c.gpu ?? 'GPU'})` : `Cloud Run ${c.name} (${c.region}${cpu ? ', software WebGL' : ''})`,
    playtester: null,
    runner: c.runner ?? null,
    backend: runpod ? 'runpod' : modal ? 'modal' : cpu ? 'cloudrun-cpu' : 'cloudrun',
    software: c.software ?? null,
    slow: c.slow ?? 1,
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
      releaseRunner();
      const seconds = Math.round((Date.now() - connectedAt) / 100) / 10;
      if (runpod || modal) return onUsage?.(runpodUsage(c, { seconds, connectSeconds: (connectedAt - t0) / 1000, tabs: n }, modal ? 'modal-playtest' : 'runpod-playtest'));
      onUsage?.({
        provider: cpu ? 'gcp-playtest-cpu' : 'gcp-playtest', unit: 'tab_seconds', amount: Math.round(seconds * n * 10) / 10, cost: Math.round(tabCost(c, seconds, n) * 10_000) / 10_000,
        detail: `${n} tab(s) on ${c.name} for ${seconds} s (connecting took ${Math.round((connectedAt - t0) / 1000)} s)${cpu ? '; request-based billing, no idle tail' : '; the instance\'s idle tail is not included'}`,
      });
    },
  };
}

/**
 * A RunPod playtest's usage row (provider runpod-playtest). RunPod bills a worker from its start (the cold start Gen
 * waited through counts) until its idle timeout after the last request, so the cost is the tabs' share of the worker for
 * the connect wait and the play, plus the idle tail once: an upper bound when playtests follow each other on a warm worker.
 */
export function runpodUsage(c: Pick<CloudPlaytest, 'pricePerSecond' | 'tabsPerInstance' | 'name' | 'gpu' | 'idleSeconds'>, { seconds, connectSeconds, tabs }: { seconds: number; connectSeconds: number; tabs: number }, provider: 'runpod-playtest' | 'modal-playtest' = 'runpod-playtest') {
  const idle = c.idleSeconds ?? 0;
  const share = Math.min(1, tabs / c.tabsPerInstance);
  const cost = c.pricePerSecond * share * (seconds + connectSeconds + idle);
  return {
    provider, unit: 'tab_seconds', amount: Math.round(seconds * tabs * 10) / 10, cost: Math.round(cost * 10_000) / 10_000,
    detail: `${tabs} tab(s) on ${c.name} (${c.gpu ?? 'GPU'}) for ${seconds} s; connecting took ${Math.round(connectSeconds)} s; includes the ${provider === 'modal-playtest' ? 'container' : 'worker'}'s ${idle} s idle tail`,
  };
}

// ------------------------------------------------------------------ the video

export const encodeUrlOf = (url: string, viewport: { width: number; height: number }) => `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/encode?w=${viewport.width}&h=${viewport.height}`;

/**
 * Encodes the screencast's MJPEG on the service (NVENC there) over a WebSocket (Cloud Run caps an HTTP/1 request body
 * at 32 MiB; a few minutes of MJPEG is hundreds of MB). Returns the encoder's name. Throws to fall back here.
 * The protocol (server.mjs encodeSession): binary chunks, then "end"; back {"encoder","bytes"}, the mp4's chunks, "done".
 */
export async function encodeOnService(c: Pick<CloudPlaytest, 'url'> & Partial<Pick<CloudPlaytest, 'variant'>>, mjpeg: string, out: string, viewport: { width: number; height: number }, signal: AbortSignal, deps: { WebSocket: any; idToken: (aud: string) => Promise<string>; env?: Record<string, string | undefined> } = { WebSocket: globalThis.WebSocket, idToken: (aud) => gcpTokens().id(aud) }): Promise<string> {
  // Node's WebSocket (undici) takes request headers as its second argument.
  const ws = new deps.WebSocket(encodeUrlOf(c.url, viewport), { headers: await headersFor(c, deps.idToken, deps.env) });
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

/** The service's self-test (GET /selftest): how WebGL draws there (the L4, or SwiftShader on the CPU service), the driver's libraries, NVENC. */
export async function cloudSelfTest(c: Pick<CloudPlaytest, 'url'> & Partial<Pick<CloudPlaytest, 'variant'>>, { fresh = false, all = false } = {}) {
  const q = [fresh ? 'fresh=1' : '', all ? 'all=1' : ''].filter(Boolean).join('&');
  const r = await fetch(`${c.url}/selftest${q ? `?${q}` : ''}`, { headers: await headersFor(c, (aud) => gcpTokens().id(aud)), signal: AbortSignal.timeout(8 * 60_000) });
  if (!r.ok) throw new Error(`The playtest service answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json();
}
