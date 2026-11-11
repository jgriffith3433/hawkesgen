// Phone load budget for playtest.run when mobile:true: CDP 4x CPU + Slow 4G, transferred
// bytes until gameplay, and where the fps p5 dip sat. Pure helpers are tested without a browser.

/** Chrome / Lighthouse "Slow 4G": ~150 ms RTT, 1.6 Mbps down, 750 Kbps up (bytes/s). */
export const SLOW_4G = {
  offline: false as const,
  latency: 150,
  downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
  uploadThroughput: Math.round((750 * 1024) / 8),
};

export const PHONE_CPU_RATE = 4;
export const PHONE_DPR = 2;

export type TransferHit = { url: string; bytes: number; t: number };

export type PhoneAsset = { url: string; bytes: number; path: string };

export type PhoneResult = {
  throttling: { cpu: number; network: 'slow-4g'; dpr: number };
  mbBeforeGameplay: number;
  secondsToGameplay: number | null;
  fpsP5: number | null;
  fpsDipAt: number | null;
  assets: PhoneAsset[];
};

/** Path (and query) of a transfer URL, truncated for the report. */
export function transferPath(url: string): string {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    return (p || '/').slice(0, 200);
  } catch {
    return String(url || '').slice(0, 200);
  }
}

/**
 * Collect transferred bytes from CDP Network.responseReceived + loadingFinished.
 * `now()` is the runner clock (seconds since the run started), same as loadSeconds / events.
 */
export function createTransferLog(now: () => number) {
  const pending = new Map<string, string>();
  const hits: TransferHit[] = [];
  return {
    hits,
    onResponseReceived(params: { requestId?: string; response?: { url?: string } }) {
      const id = params?.requestId;
      if (!id) return;
      pending.set(id, String(params.response?.url ?? ''));
    },
    onLoadingFinished(params: { requestId?: string; encodedDataLength?: number }) {
      const id = params?.requestId;
      if (!id) return;
      const url = pending.get(id) ?? '';
      pending.delete(id);
      const bytes = Math.max(0, Number(params.encodedDataLength) || 0);
      hits.push({ url, bytes, t: now() });
    },
  };
}

/** Sum bytes before a cutoff; top assets by transferred size (at least 5 when that many exist). */
export function rollupTransfers(hits: TransferHit[], cutoff: number | null, top = 5): { totalBytes: number; mbBeforeGameplay: number; assets: PhoneAsset[] } {
  const before = cutoff == null ? hits : hits.filter((h) => h.t <= cutoff);
  const byUrl = new Map<string, number>();
  for (const h of before) {
    const url = h.url || '(unknown)';
    byUrl.set(url, (byUrl.get(url) ?? 0) + h.bytes);
  }
  const totalBytes = [...byUrl.values()].reduce((a, b) => a + b, 0);
  const assets = [...byUrl.entries()]
    .map(([url, bytes]) => ({ url: url.slice(0, 300), bytes, path: transferPath(url) }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, Math.max(5, top));
  return {
    totalBytes,
    mbBeforeGameplay: Math.round((totalBytes / 1e6) * 10) / 10,
    assets,
  };
}

/**
 * Seconds to gameplay: milestone event, then metric milestone.gameplay / ftue.secondsToGameplay,
 * else loadSeconds. Null only when none of those exist.
 */
export function gameplayCutoffSeconds(input: {
  events?: { type?: string; detail?: string; t?: number }[] | null;
  metrics?: Record<string, unknown> | null;
  loadSeconds?: number | null;
}): number | null {
  const events = input.events ?? [];
  for (const e of events) {
    if (e?.type === 'milestone' && e.detail === 'gameplay' && typeof e.t === 'number' && Number.isFinite(e.t)) {
      return Math.round(e.t * 10) / 10;
    }
  }
  const m = input.metrics ?? {};
  for (const key of ['ftue.secondsToGameplay', 'milestone.gameplay']) {
    const v = Number(m[key]);
    if (Number.isFinite(v) && v >= 0) return Math.round(v * 10) / 10;
  }
  if (input.loadSeconds != null && Number.isFinite(input.loadSeconds)) {
    return Math.round(Number(input.loadSeconds) * 10) / 10;
  }
  return null;
}

/**
 * Seconds into the run of the sample at/near fps p5 during play (after loading).
 * Matches summarizeFps: skip the first two samples when loadSeconds is unknown; otherwise skip
 * samples before load. Sample i (0-based) finished at about i+1 seconds.
 */
export function fpsDipAt(samples: number[], loadSeconds: number | null = null): number | null {
  if (!samples.length) return null;
  const skip = loadSeconds != null && Number.isFinite(loadSeconds)
    ? Math.max(0, Math.ceil(loadSeconds))
    : 2;
  const play = samples
    .map((fps, i) => ({ fps, t: i + 1 }))
    .slice(skip)
    .filter((s) => Number.isFinite(s.fps));
  if (!play.length) return null;
  const sorted = [...play].sort((a, b) => a.fps - b.fps);
  const p5 = sorted[Math.floor(sorted.length * 0.05)]!;
  const hit = play.find((s) => s.fps === p5.fps) ?? p5;
  return hit.t;
}

/** Arm CDP CPU + Slow 4G and start the transfer log. Call before page.goto. */
export async function armPhoneNetwork(context: { newCDPSession: (page: unknown) => Promise<any> }, page: unknown, now: () => number) {
  const cdp = await context.newCDPSession(page);
  const log = createTransferLog(now);
  cdp.on('Network.responseReceived', (p: any) => log.onResponseReceived(p));
  cdp.on('Network.loadingFinished', (p: any) => log.onLoadingFinished(p));
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PHONE_CPU_RATE });
  await cdp.send('Network.emulateNetworkConditions', { ...SLOW_4G });
  return { cdp, log };
}

/** Build the result.phone block (and the metrics keys Studio files findings from). */
export function buildPhoneResult(input: {
  hits: TransferHit[];
  events?: { type?: string; detail?: string; t?: number }[] | null;
  metrics?: Record<string, unknown> | null;
  loadSeconds?: number | null;
  fpsSamples: number[];
  fpsP5?: number | null;
}): PhoneResult {
  const secondsToGameplay = gameplayCutoffSeconds(input);
  const rolled = rollupTransfers(input.hits, secondsToGameplay, 5);
  const fpsP5 = input.fpsP5 !== undefined
    ? input.fpsP5
    : (() => {
        const s = input.fpsSamples.slice(2);
        if (!s.length) return null;
        const sorted = [...s].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.05)] ?? null;
      })();
  return {
    throttling: { cpu: PHONE_CPU_RATE, network: 'slow-4g', dpr: PHONE_DPR },
    mbBeforeGameplay: rolled.mbBeforeGameplay,
    secondsToGameplay,
    fpsP5,
    fpsDipAt: fpsDipAt(input.fpsSamples, input.loadSeconds ?? null),
    assets: rolled.assets,
  };
}

/** Merge phone numbers onto the report metrics object (does not remove existing keys). */
export function applyPhoneMetrics(metrics: Record<string, unknown>, phone: PhoneResult): Record<string, unknown> {
  return {
    ...metrics,
    'phone.mbBeforeGameplay': phone.mbBeforeGameplay,
    'phone.secondsToGameplay': phone.secondsToGameplay,
    'phone.fpsP5': phone.fpsP5,
  };
}
