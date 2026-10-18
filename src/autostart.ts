// Auto start: when GPU jobs wait and too few servers run, the queue starts stopped servers by itself (setting
// fleet.auto), and launches new ones from the fleet image only with fleet.autoLaunch (J, 2026-10-18: start stopped
// servers, no new launches). The fleet is passed in, so tests run it against a fake one.
//
// A start that fails (no capacity in the zone, no quota in the region) moves on to the next stopped server in another
// zone or region in the same round, and that server isn't tried again for BACKOFF_MS.

import type { ServerStatus } from './providers/comfy/fleet.ts';

/** J's rule: GPU servers only in US regions (us-east-1, us-east-2, us-west-2). */
export const US_REGION = /^us-/;
/** How long a server whose start failed is left alone before auto start tries it again. */
export const BACKOFF_MS = 15 * 60_000;

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
  /** One line for the waiting jobs and the fleet status. */
  note: string;
};

/** Server id -> until when auto start leaves it alone, and why. */
export type Backoff = Map<string, { until: number; reason: string }>;

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
  for (const [id, b] of backoff) if (b.until <= now) backoff.delete(id);
  const round: AutoStartRound = { at: now, want, started: [], failed: [], launched: null, note: '' };
  const all = await fleet.status();
  const up = all.filter((st) => ['running', 'pending'].includes(st.state!)).length;
  let short = Math.max(0, Math.min(opts.servers, want) - up);
  const candidates = all.filter((st) => st.state === 'stopped' && !st.imageSource && !st.purpose && US_REGION.test(st.region ?? '') && !backoff.has(st.id!));
  const badZones = new Set<string>();
  const badRegions = new Set<string>();
  for (const st of candidates) {
    if (short <= 0) break;
    const zone = st.zone ?? null;
    if (badRegions.has(st.region!) || (zone && badZones.has(zone))) continue;
    try {
      await fleet.start(st.id!);
      round.started.push({ id: st.id!, region: st.region!, zone });
      short -= 1;
    } catch (e: any) {
      const kind = e?.kind ?? 'other';
      round.failed.push({ id: st.id!, region: st.region!, zone, kind, error: e?.message ?? String(e) });
      backoff.set(st.id!, { until: now + BACKOFF_MS, reason: `${kind}: ${e?.message ?? e}` });
      if (kind === 'capacity' && zone) badZones.add(zone);
      if (kind === 'quota') badRegions.add(st.region!);
    }
  }
  if (short > 0 && opts.autoLaunch && all.length < opts.servers && (await fleet.imageAvailable())) {
    const r = await fleet.launch().catch((e) => {
      round.failed.push({ id: 'launch', region: '', zone: null, kind: e?.kind ?? 'other', error: e?.message ?? String(e) });
      return null;
    });
    if (r) round.launched = { id: r.id, region: r.region ?? null };
  }
  const parts: string[] = [];
  for (const s of round.started) parts.push(`started server ${s.id} (${s.zone ?? s.region}) for waiting jobs`);
  if (round.launched) parts.push(`launched server ${round.launched.id} from the image for waiting jobs`);
  if (round.failed.length) parts.push(`couldn't start ${round.failed.map((f) => `${f.id} (${f.zone ?? f.region}: ${f.kind})`).join(', ')}`);
  if (!parts.length && short > 0) parts.push(candidates.length || backoff.size ? 'no stopped server could start; trying again later' : opts.autoLaunch ? 'no stopped server to start' : 'no stopped server to start (launching new ones is off: start or launch one in the Fleet tab)');
  round.note = parts.join('; ');
  return round;
}
