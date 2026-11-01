// The machine sizes of customer Unity builds, as settings hold them (no imports: config.ts reads it). sizes.ts uses them.

export type Machine = { name: string; cpu: number; memoryGiB: number };
export type MachineSizes = Record<string, { cpu: number; memoryGiB: number }>;

/** Cloud Run's vCPU counts we offer and the memory each allows (at most; at least MEMORY_MIN). */
export const MEMORY_MAX: Record<number, number> = { 2: 8, 4: 16, 6: 24, 8: 32 };
export const MEMORY_MIN: Record<number, number> = { 2: 1, 4: 2, 6: 4, 8: 4 };
export const DEFAULT_SIZES: MachineSizes = { s: { cpu: 2, memoryGiB: 8 }, m: { cpu: 4, memoryGiB: 16 }, l: { cpu: 6, memoryGiB: 24 }, xl: { cpu: 8, memoryGiB: 32 } };
export const DEFAULT_CUSTOMER_SIZE = 'm';
export const SIZE_NAME_RE = /^[a-z0-9]{1,8}$/;


/** Why cpu / memoryGiB isn't a combination Cloud Run runs, or null when it is. */
export function machineProblem(cpu: unknown, memoryGiB: unknown): string | null {
  const c = Number(cpu);
  const m = Number(memoryGiB);
  if (!(c in MEMORY_MAX)) return `cpu must be ${Object.keys(MEMORY_MAX).join(', ')} (got ${String(cpu).slice(0, 20)})`;
  if (!Number.isInteger(m)) return `memoryGiB must be a whole number of GiB (got ${String(memoryGiB).slice(0, 20)})`;
  if (m > MEMORY_MAX[c] || m < MEMORY_MIN[c]) return `${c} vCPU takes ${MEMORY_MIN[c]} to ${MEMORY_MAX[c]} GiB of memory (got ${m})`;
  return null;
}

/** settings.unityBuild.gcp.sizes, checked: valid names and Cloud Run combinations only; none left: the defaults. */
export function cleanSizes(raw: unknown): MachineSizes {
  const out: MachineSizes = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      if (!SIZE_NAME_RE.test(k) || !v || typeof v !== 'object' || machineProblem(v.cpu, v.memoryGiB)) continue;
      out[k] = { cpu: Number(v.cpu), memoryGiB: Number(v.memoryGiB) };
    }
  }
  return Object.keys(out).length ? out : { ...DEFAULT_SIZES };
}

/** settings.unityBuild.gcp.customerSize, checked against the sizes: "m" when it is there, else the smallest. */
export function cleanCustomerSize(raw: unknown, sizes: MachineSizes): string {
  if (typeof raw === 'string' && raw in sizes) return raw;
  if (DEFAULT_CUSTOMER_SIZE in sizes) return DEFAULT_CUSTOMER_SIZE;
  return byMemory(sizes)[0].name;
}

export const byMemory = (sizes: MachineSizes): Machine[] => Object.entries(sizes).map(([name, s]) => ({ name, ...s })).sort((a, b) => a.memoryGiB - b.memoryGiB || a.cpu - b.cpu);

