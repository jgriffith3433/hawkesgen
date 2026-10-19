// A running playtest.run job's screenshots, readable while it plays (GET /v1/jobs/:id/shots). The run keeps its
// shots in tmp files and only files them as library assets at the end: the list it appends to is registered here
// so the API can serve them in the meantime. After the run, the job's result lists the filed assets instead.

export type LiveShot = { t: number; reason: string; scene?: string; file: string; peer?: number };

const live = new Map<string, LiveShot[]>();

/** The list a run appends its shots to (a fresh one each time the job starts). */
export function startLiveShots<T extends LiveShot>(job: string): T[] {
  const shots: T[] = [];
  live.set(job, shots);
  return shots;
}

/** The run is over: its tmp files go with the job's scratch folder, and the result has the assets. */
export function endLiveShots(job: string) {
  live.delete(job);
}

type JobLike = { id: string; status: string; detail?: string | null; result?: any };
export type ShotEntry = { i: number; t: number; reason: string; scene: string | null; peer?: number };

/** The shots after `since` (an index), and the bot's latest progress line (the job's step) to caption them. */
export function shotList(job: JobLike, since = -1) {
  const shots = live.get(job.id);
  const all: ShotEntry[] = shots
    ? shots.map((s, i) => ({ i, t: s.t, reason: s.reason, scene: s.scene ?? null, ...(s.peer != null ? { peer: s.peer } : {}) }))
    : (Array.isArray(job.result?.shots) ? job.result.shots : []).map((s: any) => ({ i: s.i, t: s.t, reason: s.reason, scene: s.scene ?? null, ...(s.peer != null ? { peer: s.peer } : {}) }));
  return {
    running: job.status === 'running' || job.status === 'queued',
    progress: job.detail ?? null,
    shots: all.filter((s) => s.i > since),
  };
}

/** Where the i-th shot is: its tmp file while the run plays, else the asset it was filed as. */
export function shotSource(job: JobLike, i: number): { file: string } | { asset: string } | null {
  const shots = live.get(job.id);
  if (shots) return shots[i] ? { file: shots[i].file } : null;
  const s = Array.isArray(job.result?.shots) ? job.result.shots.find((x: any) => x.i === i) : null;
  return s?.asset ? { asset: s.asset } : null;
}
