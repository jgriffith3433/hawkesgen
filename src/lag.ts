// Event-loop lag monitor: a 100 ms timer that notices when it fires late. A block over BLOCK_MS is logged with the
// routes that started most recently (what was probably running) and kept for GET /v1/health (`loop`).
// Same idea as Studio's ops.ts.

import { monitorEventLoopDelay } from 'node:perf_hooks';

const TICK_MS = 100;
const BLOCK_MS = 500;
const KEEP = 30;

export type Block = { at: string; ms: number; recent: string[] };

const recentRoutes: string[] = [];
const blocks: Block[] = [];
let maxLag = 0;
let started = 0;
let hist: ReturnType<typeof monitorEventLoopDelay> | null = null;

/** Called for every request: the last few routes are what a block is blamed on. */
export function noteRoute(method: string, route: string) {
  recentRoutes.push(`${new Date().toISOString().slice(11, 23)} ${method} ${route}`);
  if (recentRoutes.length > 6) recentRoutes.shift();
}

export function startLagMonitor() {
  if (started) return;
  started = Date.now();
  hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK_MS;
    last = now;
    if (lag > maxLag) maxLag = lag;
    if (lag >= BLOCK_MS) {
      const b = { at: new Date().toISOString(), ms: Math.round(lag), recent: [...recentRoutes] };
      blocks.push(b);
      if (blocks.length > KEEP) blocks.shift();
      console.warn(`[lag] event loop blocked ${b.ms} ms; recent requests: ${b.recent.join(' | ') || 'none'}`);
    }
  }, TICK_MS).unref();
}

export function lagReport() {
  return {
    since: started ? new Date(started).toISOString() : null,
    maxMs: Math.round(maxLag),
    p99Ms: hist ? Math.round(hist.percentile(99) / 1e6) : 0,
    blocks: blocks.slice(-10),
  };
}
