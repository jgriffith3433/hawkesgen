// What a running playtest.run job is doing, live, for Studio's Playtests page (GET /v1/playtests/live, GET
// /v1/jobs/:id/live) and its live video (GET /v1/jobs/:id/live.mjpeg): its steps so far, where it plays (which
// playtester), each player's latest state from the game's bot (scene, progress, fps, its note: what it's doing), the
// problems, console errors and failed requests so far, and the newest video frame. The run registers a source (a
// function over its own variables) and nothing is copied until someone asks; the entry goes when the run ends, and the
// job's result has the rest.

import type { RunContext } from './types.ts';

type Frameable = { latest: Buffer | null; latestAt: number } | null | undefined;
export type LivePlayer = { i: number; scenario: string | null; state: any; detail?: string | null; outcome?: string | null; recorder?: Frameable };
export type LiveSource = {
  host: string | null; playtester: string | null; recorder: string | null; contract: boolean;
  scenario: { id: string; title?: string | null; seconds?: number | null } | null;
  players: LivePlayer[];
  problems: { severity?: string; message: string; source?: string; peer?: number }[];
  console: { type: string; text: string; t: number }[];
  failed: { url: string; status: number | string }[];
  shots: { file: string }[];
  timeline: any[];
  loadSeconds: number | null;
  outcome: string | null;
};
type Entry = { job: string; project: string; tool: string; startedAt: number; url: string; mode: string; scenario: string | null; peers: number; device: string; steps: { t: number; text: string }[]; source: (() => Partial<LiveSource>) | null };

const live = new Map<string, Entry>();
const MAX_STEPS = 300;

/** At the start of a run: registers it and keeps a copy of every step it reports (ctx.step). */
export function beginLive(ctx: RunContext) {
  const p = ctx.params;
  const entry: Entry = {
    job: ctx.job.id, project: ctx.job.project, tool: ctx.job.tool, startedAt: Date.now(), url: String(p.url ?? ''), mode: String(p.mode ?? 'auto'),
    scenario: p.scenario ?? null, peers: Math.max(1, Number(p.peers) || 1), device: p.mobile ? 'phone' : 'desktop', steps: [], source: null,
  };
  live.set(ctx.job.id, entry);
  const step = ctx.step.bind(ctx);
  ctx.step = (detail: string) => {
    entry.steps.push({ t: Date.now(), text: String(detail).slice(0, 400) });
    if (entry.steps.length > MAX_STEPS) entry.steps.splice(0, entry.steps.length - MAX_STEPS);
    step(detail);
  };
  return {
    /** What the run knows now; read only when asked. */
    source(fn: () => Partial<LiveSource>) {
      entry.source = fn;
    },
    end() {
      if (live.get(ctx.job.id) === entry) live.delete(ctx.job.id);
    },
  };
}

export const liveJobs = () => [...live.keys()];
export const isLive = (job: string) => live.has(job);
/** Which playtester a live playtest plays on (for the machine monitor). */
export function livePlaytester(job: string): string | null {
  const e = live.get(job);
  try {
    return e?.source?.().playtester ?? null;
  } catch {
    return null;
  }
}

const pick = (st: any) => (st && typeof st === 'object' ? {
  status: st.status ?? null, scene: st.scene ?? null, progress: typeof st.progress === 'number' ? st.progress : null,
  fps: typeof st.fps === 'number' ? Math.round(st.fps) : null, note: typeof st.note === 'string' ? st.note.slice(0, 300) : null,
  ...(st.metrics && typeof st.metrics === 'object' ? { metrics: Object.fromEntries(Object.entries(st.metrics).slice(0, 12).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : v])) } : {}),
} : null);

/**
 * A live playtest as JSON. The light version (the grid) has the latest step, each player's state, the counts and the
 * last few problems; `full` (the maximized view) adds every step and the timeline of progress and fps.
 */
export function liveSnapshot(job: string, { full = false } = {}) {
  const e = live.get(job);
  if (!e) return null;
  let s: Partial<LiveSource> = {};
  try {
    s = e.source?.() ?? {};
  } catch {
    // The run is between states; the steps still say where it is.
  }
  const now = Date.now();
  const problems = s.problems ?? [];
  const consoleLines = s.console ?? [];
  const errors = consoleLines.filter((c) => c.type === 'error');
  const failed = s.failed ?? [];
  const timeline = s.timeline ?? [];
  return {
    job: e.job, project: e.project, live: true, startedAt: e.startedAt, elapsed: Math.round((now - e.startedAt) / 1000),
    url: e.url, mode: e.mode, device: e.device, scenario: s.scenario ?? (e.scenario ? { id: e.scenario } : null), peers: e.peers,
    host: s.host ?? null, playtester: s.playtester ?? null, recorder: s.recorder ?? null, contract: Boolean(s.contract), loadSeconds: s.loadSeconds ?? null,
    step: e.steps.at(-1)?.text ?? 'starting', stepAt: e.steps.at(-1)?.t ?? e.startedAt,
    steps: full ? e.steps : e.steps.slice(-6),
    players: (s.players ?? []).map((pl) => ({
      i: pl.i, scenario: pl.scenario, detail: pl.detail ?? null, outcome: pl.outcome ?? null, state: pick(pl.state),
      frameAt: pl.recorder?.latestAt || null,
    })),
    problems: { count: problems.length, last: problems.slice(full ? -50 : -4).map((x) => ({ severity: x.severity ?? 'bug', message: String(x.message).slice(0, 300), source: x.source ?? null, ...(x.peer != null ? { peer: x.peer } : {}) })) },
    console: { errors: errors.length, warnings: consoleLines.length - errors.length, last: errors.slice(full ? -20 : -2).map((c) => ({ t: c.t, text: c.text.slice(0, 300) })) },
    failed: { count: failed.length, last: failed.slice(full ? -20 : -2) },
    shots: (s.shots ?? []).length,
    outcome: s.outcome ?? null,
    ...(full ? { timeline: thin(timeline, 300).map((x: any) => ({ t: x.t, peer: x.peer ?? 0, progress: typeof x.progress === 'number' ? x.progress : null, fps: typeof x.fps === 'number' ? Math.round(x.fps) : null, scene: x.scene ?? null, status: x.status ?? null })) } : {}),
  };
}

/** At most n points, evenly picked, the last always in. */
function thin<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const out: T[] = [];
  for (let i = 0; i < n - 1; i++) out.push(list[Math.floor((i * list.length) / (n - 1))]);
  out.push(list[list.length - 1]);
  return out;
}

/** The newest frame of a player: the screencast's, else the newest screenshot's file (Playwright's recorder has no frames). */
export function liveFrame(job: string, player = 0): { jpeg: Buffer; at: number } | { file: string; at: number } | null {
  const e = live.get(job);
  if (!e) return null;
  let s: Partial<LiveSource> = {};
  try {
    s = e.source?.() ?? {};
  } catch {
    return null;
  }
  const pl = (s.players ?? []).find((x) => x.i === player) ?? (s.players ?? [])[0];
  if (pl?.recorder?.latest) return { jpeg: pl.recorder.latest, at: pl.recorder.latestAt };
  const shot = (s.shots ?? []).at(-1);
  return shot ? { file: shot.file, at: 0 } : null;
}
