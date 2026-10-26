// Where a GPU job may run, by the disk the server has left. A full disk fails a render with "No space left on device"
// (2026-10-26, Yooba Land's trailer: i-007d6a919621647c2 sat at 0 GB free and kept getting Blender work while other
// servers had 100+ GB). Pure functions: jobs.ts supplies the free-disk numbers.

/** Tools that write a lot to the server's disk besides the models (renders, rigs, motion, audio models). */
const HEAVY_TOOLS = new Set(['blender.render', 'blender.character', 'mesh.rig', 'motion.from-text']);
const HEAVY_FAMILIES = new Set(['blender', 'rig', 'motion']);

/** Free bytes under which a server gets no disk-heavy job. */
export const MIN_FREE_BYTES = 10e9;

export const isDiskHeavy = (job: { tool: string; family?: string | null }) => HEAVY_TOOLS.has(job.tool) || HEAVY_FAMILIES.has(job.family ?? '');

/** The error a full disk gives. */
export const isDiskFullError = (message: string | null | undefined) => /no space left on device|ENOSPC/i.test(message ?? '');

/**
 * Whether `job` may take server `serverId`. `free` is the known free bytes per server (a server not in it is unknown and
 * allowed); `avoid` is the servers this job already failed on with a full disk.
 */
export function mayPlace(job: { tool: string; family?: string | null }, serverId: string, free: ReadonlyMap<string, number>, avoid: ReadonlySet<string> = new Set(), min = MIN_FREE_BYTES) {
  if (avoid.has(serverId)) return false;
  if (!isDiskHeavy(job)) return true;
  const f = free.get(serverId);
  return f === undefined || f >= min;
}

/** The sentence a waiting job shows when no ready server has room, or '' when some do. */
export function noRoomReason(serverIds: string[], free: ReadonlyMap<string, number>, avoid: ReadonlySet<string> = new Set(), min = MIN_FREE_BYTES) {
  if (!serverIds.length) return '';
  const ok = serverIds.some((id) => !avoid.has(id) && (free.get(id) === undefined || free.get(id)! >= min));
  if (ok) return '';
  const low = serverIds.map((id) => (avoid.has(id) && !(free.get(id)! < min) ? `${id} (failed with a full disk)` : `${id} (${((free.get(id) ?? 0) / 1e9).toFixed(1)} GB free)`));
  return `waiting: no GPU server has ${(min / 1e9).toFixed(0)} GB of free disk for this job: ${low.join(', ')}. Free space on one (fleet models prune) or start another server.`;
}

/** Whether a job that failed with `message` on a server goes back in the line: once, and only for a full disk. */
export const retryOnDiskFull = (message: string | null | undefined, avoid: ReadonlySet<string>, cancelled = false) => !cancelled && isDiskFullError(message) && avoid.size === 0;
