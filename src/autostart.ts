// Auto start: when GPU jobs wait and too few servers run, the queue starts stopped servers by itself (setting
// fleet.auto), and launches new ones from the fleet image only with fleet.autoLaunch (J, 2026-10-18: start stopped
// servers, no new launches). The fleet is passed in, so tests run it against a fake one.
//
// A round tries stopped servers in different zones at the same time (one per server still wanted), then the next wave,
// skipping zones (no capacity) and regions (no quota) that failed in the round. A server whose start failed is left
// alone for a while that doubles with each miss (2, 4, 8, then 15 minutes: AWS capacity often clears in minutes), and
// the round says when the next try is and about how long until a server takes jobs (expectedWait, for Studio).

import type { ServerStatus } from './providers/comfy/fleet.ts';

/** J's rule: GPU servers only in US regions (us-east-1, us-east-2, us-west-2). */
export const US_REGION = /^us-/;
/** How long a server whose start failed is left alone before auto start tries it again: the first miss, and at most. */
export const BACKOFF_MIN_MS = 2 * 60_000;
export const BACKOFF_MS = 15 * 60_000;
/** How often the queue runs a round while GPU jobs wait (src/jobs.ts autoStart). */
export const ROUND_MS = 120_000;
/** About how long a started (stopped) server takes to boot and bring ComfyUI up. */
export const BOOT_SECONDS = 240;
/** The wait after a server's n-th miss in a row. */
export const backoffMs = (misses: number) => Math.min(BACKOFF_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, misses - 1));

export type AutoStartFleet = {
  status: () => Promise<ServerStatus[]>;
  start: (id: string) => Promise<unknown>;
  launch: () => Promise<{ id: string; region?: string } | null | void>;
  imageAvailable: () => Promise<boolean>;
};

export type AutoStartRound = {
  at: number;
  want: number;
  started: { id: string; region: string; zone: string | null }[];
  failed: { id: string; region: string; zone: string | null; kind: string; error: string }[];
  launched: { id: string; region: string | null } | null;
  /** When auto start tries a stopped server again (null: nothing left to try, or a server started). */
  nextTry: number | null;
  /** About how many seconds until a server takes jobs: booting, or the next try plus booting (null: no server to start). */
  expectedWait: number | null;
  /** One line for the waiting jobs and the fleet status. */
  note: string;
};

/** Server id -> until when auto start leaves it alone, why, and its misses in a row (kept a while after, to keep doubling). */
export type Backoff = Map<string, { until: number; reason: string; misses?: number }>;

/**
 * One round: start stopped servers until there's one per waiting job (at most `servers` up), skipping zones (capacity)
 * and regions (quota) that already failed this round; then, only with autoLaunch, launch one from the image.
 */
export async function autoStartRound(
  want: number,
  opts: { servers: number; autoLaunch: boolean },
  fleet: AutoStartFleet,
  backoff: Backoff,
  now = Date.now(),
): Promise<AutoStartRound> {
  // A miss is forgotten an hour after its backoff ends (the doubling starts over).
  for (const [id, b] of backoff) if (b.until + 3_600_000 <= now) backoff.delete(id);
  const waiting = (id: string) => (backoff.get(id)?.until ?? 0) > now;
  const round: AutoStartRound = { at: now, want, started: [], failed: [], launched: null, nextTry: null, expectedWait: null, note: '' };
  const all = await fleet.status();
  const up = all.filter((st) => ['running', 'pending'].includes(st.state!)).length;
  let short = Math.max(0, Math.min(opts.servers, want) - up);
  const usable = all.filter((st) => st.state === 'stopped' && !st.imageSource && !st.purpose && US_REGION.test(st.region ?? ''));
  const candidates = usable.filter((st) => !waiting(st.id!));
  const badZones = new Set<string>();
  const badRegions = new Set<string>();
  const tried = new Set<string>();
  while (short > 0) {
    // One wave: up to `short` servers, each in a zone not tried in this wave, started at the same time.
    const wave: typeof candidates = [];
    const zones = new Set<string>();
    for (const st of candidates) {
      if (wave.length >= short) break;
      const zone = st.zone ?? st.region!;
      if (tried.has(st.id!) || badRegions.has(st.region!) || badZones.has(zone) || zones.has(zone)) continue;
      wave.push(st);
      zones.add(zone);
    }
    if (!wave.length) break;
    const results = await Promise.allSettled(wave.map((st) => {
      tried.add(st.id!);
      return fleet.start(st.id!);
    }));
    results.forEach((r, k) => {
      const st = wave[k];
      const zone = st.zone ?? null;
      if (r.status === 'fulfilled') {
        round.started.push({ id: st.id!, region: st.region!, zone });
        backoff.delete(st.id!);
        short -= 1;
        return;
      }
      const e: any = r.reason;
      const kind = e?.kind ?? 'other';
      const misses = (backoff.get(st.id!)?.misses ?? 0) + 1;
      round.failed.push({ id: st.id!, region: st.region!, zone, kind, error: e?.message ?? String(e) });
      backoff.set(st.id!, { until: now + backoffMs(misses), reason: `${kind}: ${e?.message ?? e}`, misses });
      if (kind === 'capacity' && zone) badZones.add(zone);
      if (kind === 'quota') badRegions.add(st.region!);
    });
  }
  if (short > 0 && opts.autoLaunch && all.length < opts.servers && (await fleet.imageAvailable())) {
    const r = await fleet.launch().catch((e) => {
      round.failed.push({ id: 'launch', region: '', zone: null, kind: e?.kind ?? 'other', error: e?.message ?? String(e) });
      return null;
    });
    if (r) round.launched = { id: r.id, region: r.region ?? null };
  }
  if (round.started.length || round.launched) round.expectedWait = BOOT_SECONDS;
  else if (short > 0) {
    // The next try: the soonest a stopped server leaves its backoff (or the next round, for one skipped this round).
    const next = usable.map((st) => (waiting(st.id!) ? backoff.get(st.id!)!.until : tried.has(st.id!) ? null : now + ROUND_MS)).filter((t): t is number => t !== null);
    round.nextTry = next.length ? Math.max(now, Math.min(...next)) : null;
    round.expectedWait = round.nextTry === null ? null : Math.round((round.nextTry - now) / 1000) + BOOT_SECONDS;
  }
  const parts: string[] = [];
  for (const s of round.started) parts.push(`started server ${s.id} (${s.zone ?? s.region}) for waiting jobs`);
  if (round.launched) parts.push(`launched server ${round.launched.id} from the image for waiting jobs`);
  if (round.failed.length) parts.push(`couldn't start ${round.failed.map((f) => `${f.id} (${f.zone ?? f.region}: ${f.kind})`).join(', ')}`);
  if (!round.started.length && !round.launched && short > 0) {
    if (round.nextTry !== null) parts.push(`next try in ${Math.max(1, Math.round((round.nextTry - now) / 60_000))} min, a server in about ${Math.round(round.expectedWait! / 60)} min if AWS has one free by then`);
    else if (!round.failed.length) parts.push(usable.length ? 'no stopped server could start; trying again later' : opts.autoLaunch ? 'no stopped server to start' : 'no stopped server to start (launching new ones is off: start or launch one in the Fleet tab)');
  }
  round.note = parts.join('; ');
  return round;
}
