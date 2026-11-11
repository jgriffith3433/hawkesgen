// Studio's playtest capacity setting (GET / PUT /v1/playtest/capacity; docs/playtest-runpod.md, "Capacity"): how many
// playtest browsers play at once, and which browser providers web playtests try, in what order.
//
// The number is the RunPod playtest endpoint's workers.max times the browsers each worker plays (tabsPerInstance, 2).
// Setting it PATCHes only workers.max (RunPod API v2, RUNPOD_API_KEY: never the image, template or GPU list), clamped to
// what the account allows: RunPod's serverless worker quota (settings.playtest.runpod.workerQuota, 10 on 2026-11-01)
// minus the workers.max of the account's other endpoints. RunPod's own refusal names the quota and the most this endpoint
// may have ("...your workers quota (10)... at most 5"): Gen takes that number, applies it and remembers the quota. More
// workers cost nothing standing (workers min stays 0; RunPod bills a worker only while it runs). The lane follows at once
// (runpodcap.ts). The provider order is settings.playtest.order / disabled (cloudrun.ts playtestVariantsFor). AWS is listed
// switched off: the account is suspended (2026-10-28).
import type { PlaytestProvider, Settings } from '../../config.ts';
import { env, saveSettings, cleanPlaytestOrder, PLAYTEST_PROVIDERS, MODAL_ENDPOINT } from '../../config.ts';
import type { Secrets } from '../gpu/auth.ts';
import { missingSecrets } from '../gpu/auth.ts';
import { runpodCredit, runpodCreditProblem } from '../gpu/credit.ts';
import { isDown } from '../gpu/health.ts';
import { endpointIdOf, runpodEndpointMax, setRunpodEndpointMax, MAX_WORKERS } from './runpodcap.ts';
import { playtestVariantsFor, providerHealthKey, providerOfVariant } from './cloudrun.ts';

/** The most a RunPod worker stays up with no request open (tools/gpu-providers/runpod-v2.mjs IDLE_SECONDS; J, 2026-11-11: no warm idle pods). */
export const RUNPOD_IDLE_SECONDS = 60;

const API = 'https://api.runpod.io/v2';
export const AWS_REASON = 'AWS is suspended (since 2026-10-28): no EC2 playtesters until the account is back';

export type ProviderId = PlaytestProvider | 'aws';
export type ProviderInfo = {
  id: ProviderId; name: string; kind: 'gpu' | 'software';
  /** Playtests try it now (in the order, not switched off). */ enabled: boolean;
  /** It may be switched on (AWS may not). */ selectable: boolean;
  /** Set up: it has a URL. */ deployed: boolean;
  /** Enabled, set up, with credit and not cooling down: a run may play there now. */ ready: boolean;
  /** The same as ready. */ ok: boolean;
  /** Browsers it plays at once now. */ browsers: number;
  /** The most it may be set to (RunPod: what the account's worker quota leaves this endpoint); null: not settable here. */ maxBrowsers: number | null;
  perWorker: number; gpu: string | null; pricePerHour: number | null;
  credit: { ok: boolean; balance: number | null } | null;
  /** Why it isn't ready, or null. */ reason: string | null;
};
export type RunpodAccount = { endpoint: string; workers: number | null; min: number; idleTimeout: number; others: number; quota: number; maxWorkers: number };
export type Capacity = {
  /** Browsers the RunPod lane plays at once (workers x perWorker): the number Studio shows and sets. */ browsers: number;
  perWorker: number; workers: number;
  /** The most `browsers` may be set to now; null when RunPod can't be read. */ maxBrowsers: number | null;
  /** The providers web playtests try, in order (enabled ones only). */ order: PlaytestProvider[];
  providers: ProviderInfo[];
  runpod: (RunpodAccount & { readError: string | null }) | { endpoint: string | null; readError: string };
};
export type Deps = { get?: Secrets; fetcher?: typeof fetch; now?: () => number; save?: (patch: Partial<Settings>) => Settings };

const NAMES: Record<ProviderId, string> = { runpod: 'RunPod', modal: 'Modal', cloudrun: 'Cloud Run L4', 'cloudrun-cpu': 'Cloud Run CPU (software WebGL)', aws: 'AWS EC2 playtesters' };

async function rp(method: string, path: string, key: string, fetcher: typeof fetch, body?: unknown) {
  const r = await fetcher(`${API}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { detail: text }; }
  if (!r.ok) throw Object.assign(new Error(`RunPod ${method} ${path}: ${r.status} ${[j.title, j.detail, j.message].filter(Boolean).join(': ').slice(0, 400) || text.slice(0, 400)}`), { status: r.status });
  return j;
}

/** RunPod's quota refusal: the account's quota and the most this endpoint may have ("...quota (10)... at most 5"). */
export function quotaRefusal(message: string): { quota: number | null; atMost: number | null } | null {
  if (!/quota/i.test(message)) return null;
  const quota = Number(/quota \((\d+)\)/i.exec(message)?.[1]);
  const atMost = Number(/at most (\d+)/i.exec(message)?.[1]);
  return { quota: Number.isFinite(quota) && quota > 0 ? quota : null, atMost: Number.isFinite(atMost) && atMost >= 0 ? atMost : null };
}

/** The playtest endpoint's workers and what the account's quota leaves it (every endpoint's workers.max, one call). */
export async function readRunpodAccount(t: Settings['playtest'], key: string, fetcher: typeof fetch = fetch): Promise<RunpodAccount> {
  const id = endpointIdOf(t.runpod.url);
  if (!id) throw new Error('settings.playtest.runpod.url is not a RunPod serverless endpoint');
  const j = await rp('GET', '/serverless?limit=100', key, fetcher);
  const list: any[] = Array.isArray(j) ? j : (j.endpoints ?? []);
  const mine = list.find((e) => e?.id === id);
  if (!mine) throw new Error(`RunPod has no endpoint ${id}`);
  const others = list.filter((e) => e?.id !== id).reduce((n, e) => n + Math.max(0, Number(e?.workers?.max ?? e?.workersMax) || 0), 0);
  const quota = t.runpod.workerQuota;
  return {
    endpoint: id, workers: Number(mine.workers?.max ?? mine.workersMax) || null, min: Number(mine.workers?.min ?? 0) || 0, idleTimeout: Number(mine.workers?.idleTimeout ?? t.runpod.idleSeconds) || t.runpod.idleSeconds,
    others, quota, maxWorkers: Math.max(0, Math.min(MAX_WORKERS, quota - others)),
  };
}

/** The effective order: settings.playtest.order (or the backend's rule, without the providers not set up: it lists
 *  every GPU provider as a fallback, and one with no URL is skipped anyway), switched-off ones out. */
const effectiveOrder = (t: Settings['playtest']): PlaytestProvider[] => {
  const ids = [...new Set(playtestVariantsFor(null, t).map((v) => providerOfVariant(v)))];
  if (t.order?.length) return ids;
  const url = (id: PlaytestProvider) => (id === 'runpod' ? t.runpod : id === 'modal' ? t.modal : id === 'cloudrun' ? t.cloudrun : t.cloudrunCpu)?.url;
  return ids.filter((id) => id === 'cloudrun-cpu' || url(id));
};

/** Everything Studio's setting shows. Reads RunPod once (its endpoints) when it has a key and an endpoint. */
export async function playtestCapacity(settings: Pick<Settings, 'playtest'>, { get = env, fetcher = fetch, now = Date.now }: Deps = {}): Promise<Capacity> {
  const t = settings.playtest;
  const key = get('RUNPOD_API_KEY');
  let account: RunpodAccount | null = null;
  let readError: string | null = null;
  if (!key) readError = 'RUNPOD_API_KEY is not set';
  else if (!endpointIdOf(t.runpod.url)) readError = 'settings.playtest.runpod.url is not a RunPod serverless endpoint';
  else {
    try {
      account = await readRunpodAccount(t, key, fetcher);
      if (account.workers) setRunpodEndpointMax({ id: account.endpoint, max: Math.min(MAX_WORKERS, account.workers), at: now() });
    } catch (e: any) {
      readError = String(e?.message ?? e).slice(0, 300);
    }
  }
  const perWorker = t.runpod.tabsPerInstance;
  const workers = account?.workers ?? runpodEndpointMax(t.runpod.url, now) ?? t.runpod.maxInstances;
  const order = effectiveOrder(t);
  const at = now();
  const coolOf = (id: PlaytestProvider) => isDown(providerHealthKey(id === 'runpod' ? 'runpod' : id === 'modal' ? 'modal' : id === 'cloudrun' ? 'gpu' : 'cpu'), at);
  const row = (id: PlaytestProvider): ProviderInfo => {
    const enabled = order.includes(id);
    const conf = id === 'runpod' ? t.runpod : id === 'modal' ? t.modal : id === 'cloudrun' ? t.cloudrun : t.cloudrunCpu;
    const deployed = Boolean(conf.url);
    const extra = id === 'cloudrun-cpu' ? t.cloudrunCpu.extra.reduce((n, x) => n + x.maxInstances, 0) : 0;
    const browsers = id === 'runpod' ? workers * perWorker : (conf.maxInstances + extra) * conf.tabsPerInstance;
    let credit: ProviderInfo['credit'] = null;
    let reason: string | null = !deployed ? `not deployed (settings.playtest.${id === 'cloudrun-cpu' ? 'cloudrunCpu' : id}.url is not set)` : null;
    if (id === 'runpod') {
      const c = key ? runpodCredit() : null;
      credit = { ok: !runpodCreditProblem(get, at), balance: c?.balance ?? null };
      reason ??= !key ? 'RUNPOD_API_KEY is not set' : runpodCreditProblem(get, at);
    }
    if (id === 'modal') reason ??= missingSecrets('modal', get) || null;
    const cool = coolOf(id);
    reason ??= cool ? `${cool.reason} (skipped until ${new Date(cool.until).toISOString()})` : null;
    if (!enabled) reason ??= 'switched off';
    return {
      id, name: NAMES[id], kind: id === 'cloudrun-cpu' ? 'software' : 'gpu', enabled, selectable: true, deployed, ready: enabled && !reason, ok: enabled && !reason, browsers,
      maxBrowsers: id === 'runpod' ? (account ? account.maxWorkers * perWorker : null) : null, perWorker: conf.tabsPerInstance,
      gpu: id === 'runpod' ? t.runpod.gpu : id === 'modal' ? t.modal.gpu : id === 'cloudrun' ? 'L4' : null,
      pricePerHour: id === 'runpod' ? t.runpod.pricePerHour : id === 'modal' ? t.modal.pricePerHour : null, credit, reason,
    };
  };
  const listed = [...order, ...PLAYTEST_PROVIDERS.filter((id) => !order.includes(id))].map(row);
  const aws: ProviderInfo = { id: 'aws', name: NAMES.aws, kind: 'gpu', enabled: false, selectable: false, deployed: false, ready: false, ok: false, browsers: 0, maxBrowsers: null, perWorker: 1, gpu: 'T4', pricePerHour: 0.53, credit: null, reason: AWS_REASON };
  return {
    browsers: workers * perWorker, perWorker, workers, maxBrowsers: account ? account.maxWorkers * perWorker : null, order, providers: [...listed, aws],
    runpod: account ? { ...account, readError } : { endpoint: endpointIdOf(t.runpod.url), readError: readError ?? 'not read' },
  };
}

export class CapacityError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** PUT's providers: ids (switched on, in order) or { id, enabled }. Unlisted ones are switched off. AWS can't be switched on. */
export function providersPatch(list: unknown): { order: PlaytestProvider[]; disabled: PlaytestProvider[] } {
  if (!Array.isArray(list)) throw new CapacityError('providers: a list of provider ids in order (or { id, enabled })');
  const items = list.map((x: any) => (typeof x === 'string' ? { id: x, enabled: true } : { id: String(x?.id ?? ''), enabled: x?.enabled !== false }));
  for (const x of items) {
    if (x.id === 'aws') { if (x.enabled) throw new CapacityError(AWS_REASON, 409); continue; }
    if (!PLAYTEST_PROVIDERS.includes(x.id as PlaytestProvider)) throw new CapacityError(`providers: unknown provider "${x.id}" (${[...PLAYTEST_PROVIDERS, 'aws'].join(', ')})`);
  }
  const known = items.filter((x) => x.id !== 'aws');
  const on = new Set(known.filter((x) => x.enabled).map((x) => x.id));
  if (!on.size) throw new CapacityError('providers: switch at least one on');
  // Studio sends only the ticked ones, in order: the rest are kept after them, switched off.
  const order = cleanPlaytestOrder([...known.map((x) => x.id), ...PLAYTEST_PROVIDERS]);
  return { order, disabled: order.filter((id) => !on.has(id)) };
}

export type Applied = { browsers?: number; workers?: number; requested?: number; clamped?: string | null; providers?: PlaytestProvider[]; modal?: Settings['playtest']['modal'] };

/**
 * Applies Studio's setting: `browsers` (RunPod workers.max = ceil(browsers / perWorker), clamped to what the account
 * allows), `providers` (the order, switched-off ones), `modal` (the Modal endpoint's settings once deployed) and
 * `runpod.workerQuota` (when RunPod raises it). Returns what was applied and the capacity after it.
 */
export async function setPlaytestCapacity(body: any, settings: Pick<Settings, 'playtest'>, deps: Deps = {}): Promise<{ applied: Applied } & Capacity> {
  const { get = env, fetcher = fetch, now = Date.now, save = saveSettings } = deps;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CapacityError('a JSON object: { browsers?, providers?, modal?, runpod? }');
  const applied: Applied = {};
  let t = settings.playtest;
  const patch: Partial<Settings['playtest']> = {};
  if (body.providers !== undefined) Object.assign(patch, providersPatch(body.providers));
  if (body.modal !== undefined) {
    if (!body.modal || typeof body.modal !== 'object') throw new CapacityError('modal: { url, maxInstances?, tabsPerInstance?, gpu?, pricePerHour?, idleSeconds? }');
    const u = body.modal.url;
    if (u !== undefined && u !== null && !(typeof u === 'string' && MODAL_ENDPOINT.test(u))) throw new CapacityError('modal.url: a Modal web endpoint (https://<workspace>--<app>-<function>.modal.run), or null');
    patch.modal = { ...t.modal, ...body.modal };
  }
  if (body.runpod?.workerQuota !== undefined) {
    const q = Number(body.runpod.workerQuota);
    if (!Number.isInteger(q) || q < 1 || q > 1000) throw new CapacityError('runpod.workerQuota: a whole number from 1 to 1000');
    patch.runpod = { ...t.runpod, workerQuota: q };
  }
  if (Object.keys(patch).length) {
    t = save({ playtest: { ...t, ...patch } } as Partial<Settings>).playtest;
    if (patch.order) applied.providers = effectiveOrder(t);
    if (patch.modal) applied.modal = t.modal;
  }
  if (body.browsers !== undefined) {
    const browsers = Number(body.browsers);
    const perWorker = t.runpod.tabsPerInstance;
    if (!Number.isInteger(browsers) || browsers < 1 || browsers > MAX_WORKERS * perWorker) throw new CapacityError(`browsers: a whole number from 1 to ${MAX_WORKERS * perWorker}`);
    const key = get('RUNPOD_API_KEY');
    if (!key) throw new CapacityError('RUNPOD_API_KEY is not set: Gen can\'t change the RunPod endpoint', 503);
    if (!endpointIdOf(t.runpod.url)) throw new CapacityError('settings.playtest.runpod.url is not a RunPod serverless endpoint', 409);
    const acct = await readRunpodAccount(t, key, fetcher).catch((e: any) => { throw new CapacityError(`reading RunPod: ${e?.message ?? e}`, 502); });
    const wanted = Math.ceil(browsers / perWorker);
    let workers = Math.max(1, Math.min(wanted, acct.maxWorkers));
    let clamped: string | null = workers < wanted
      ? `RunPod's worker quota is ${acct.quota} across the account and its other endpoints have ${acct.others}: this endpoint may have ${acct.maxWorkers} (${acct.maxWorkers * perWorker} browsers)`
      : null;
    // None warm and none idle past RUNPOD_IDLE_SECONDS (tools/gpu-providers/runpod-v2.mjs IDLE_SECONDS), whatever the endpoint had.
    const patchWorkers = (max: number) => rp('PATCH', `/serverless/${acct.endpoint}`, key, fetcher, { workers: { min: 0, max, idleTimeout: Math.min(RUNPOD_IDLE_SECONDS, acct.idleTimeout) } });
    if (workers !== acct.workers) {
      try {
        await patchWorkers(workers);
      } catch (e: any) {
        // RunPod names the quota and the most this endpoint may have: take that, and remember the quota.
        const q = quotaRefusal(String(e?.message ?? e));
        if (!q || q.atMost === null || q.atMost < 1 || q.atMost >= workers) throw new CapacityError(String(e?.message ?? e).slice(0, 400), 502);
        if (q.quota && q.quota !== t.runpod.workerQuota) t = save({ playtest: { ...t, runpod: { ...t.runpod, workerQuota: q.quota } } } as Partial<Settings>).playtest;
        clamped = `RunPod: ${String(e.message).replace(/^RunPod PATCH [^:]+: \d+ /, '').slice(0, 300)}`;
        workers = q.atMost;
        await patchWorkers(workers);
      }
    }
    // Read back: the lane follows what RunPod says now.
    const after = await readRunpodAccount(t, key, fetcher).catch(() => null);
    const got = after?.workers ?? workers;
    setRunpodEndpointMax({ id: acct.endpoint, max: Math.min(MAX_WORKERS, got), at: now() });
    if (got !== workers) throw new CapacityError(`RunPod still says workers.max ${got} (asked for ${workers})`, 502);
    Object.assign(applied, { requested: browsers, workers: got, browsers: got * perWorker, clamped });
    if (got !== acct.workers) console.log(`[playtest] RunPod endpoint ${acct.endpoint} workers.max ${acct.workers} -> ${got} (${got * perWorker} browsers)${clamped ? `: ${clamped}` : ''}`);
  }
  if (!Object.keys(applied).length) throw new CapacityError('nothing to change: { browsers?, providers?, modal?, runpod? }');
  return { applied, ...(await playtestCapacity({ playtest: t }, { get, fetcher, now })) };
}
