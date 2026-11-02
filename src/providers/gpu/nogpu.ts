// When no GPU can take a job (docs/gpu-providers.md, "When no GPU can run a job"). A GPU job used to wait in the line
// for as long as it took, "waiting: no GPU provider can take it now", with no end: RunPod out of credit and the AWS
// fleet refusing Gen's keys left a video edit at "starting" for 20 minutes and more (J, 2026-11-02: "This should NEVER
// happen"). Now the queue decides, each time it looks at a job that has nowhere to run:
//   - every provider is out for a reason that won't clear on its own (no credit, no key, AWS refusing us, nothing set up
//     for the job's models): the job fails at once with NO_GPU_ERROR;
//   - something may come free (a provider cooling down after a capacity error, servers booting): it waits, at most
//     settings.queue.gpuWaitMinutes from when it first had nowhere to run, then fails the same way.
// A job waiting behind other jobs on a GPU that exists (a busy server, a full lane, its project's fair share) is not
// "nowhere to run": that wait is the line moving, and it has no limit here.
// The clock is the job's label gpuWaitSince (kept in the database, so a restart doesn't start it again; a customer
// never sees it: publictext.ts drops gpu* labels). Pure, tested in test/no-gpu.test.ts.

import type { Blocker } from './route.ts';

/** What the person reads (the editor, the API, Studio). Plain words: customers never read provider names (publictext.ts). */
export const NO_GPU_ERROR = 'No GPU is available right now, so this couldn\'t start. Nothing was charged. Please try again later.';
/** The same after a wait that didn't end. */
export const noGpuAfter = (minutes: number) => `No GPU came free in ${minutes} minute${minutes === 1 ? '' : 's'}, so this couldn't start. Nothing was charged. Please try again later.`;

export type NoGpuVerdict =
  /** Fail it now: `error` for the person, `log` with the reasons for the owner. */
  | { fail: true; error: string; log: string; since: number }
  /** Keep it waiting: `detail` for the job, `since` the clock to keep in its labels. */
  | { fail: false; detail: string; since: number };

/**
 * A GPU job with nowhere to run now. `since` is its gpuWaitSince label (when it first had nowhere to run), or null on
 * the first look. `blockers` say why each provider was passed over.
 */
export function noGpuVerdict(blockers: Blocker[], since: number | null | undefined, waitMinutes: number, now = Date.now()): NoGpuVerdict {
  const start = typeof since === 'number' && since > 0 && since <= now ? since : now;
  const reasons = blockers.map((b) => b.reason).join('; ') || 'no GPU provider is set up';
  const lasting = blockers.length === 0 || blockers.every((b) => b.lasting);
  if (lasting) return { fail: true, error: NO_GPU_ERROR, log: `no GPU provider can run this job, and none will come back by itself: ${reasons}`, since: start };
  const waited = now - start;
  if (waited >= waitMinutes * 60_000) return { fail: true, error: noGpuAfter(waitMinutes), log: `no GPU provider could take this job for ${waitMinutes} min: ${reasons}`, since: start };
  const left = Math.max(1, Math.ceil((waitMinutes * 60_000 - waited) / 60_000));
  return { fail: false, detail: `waiting for a GPU (none can take it now: ${reasons}); it stops in ${left} min if none comes free`, since: start };
}

/** The job's clock from its labels. */
export const waitSinceOf = (labels: Record<string, unknown> | undefined): number | null => {
  const v = Number(labels?.gpuWaitSince);
  return Number.isFinite(v) && v > 0 ? v : null;
};
