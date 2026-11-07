// Machine sizes for customer Unity builds on Cloud Run (docs/unity-cloudrun.md, "Customer mode", "Machine sizes").
// J, 2026-11-01: "make it work and make it cheap if we don't need all that ... $1 a build feels wrong to me". A Cloud
// Run execution can't change its job's CPU or memory (jobs.run overrides are env, task count and timeout only), so a
// size is a job of its own: "<customer job>-<size>", a copy of the customer job with other limits. The size equal to the
// customer job's own (settings.unityBuild.gcp cpu / memoryGiB, 8 vCPU / 32 GiB) keeps that job's name, as before.
import { GenError } from '../../util.ts';
import { gapi, type CloudRunTarget } from './gcp.ts';

export * from './machine-sizes.ts';
import { byMemory, machineProblem, type Machine, type MachineSizes } from './machine-sizes.ts';

const bad = (m: string) => new GenError(m, { status: 400, kind: 'params' });

/** The label of a size that isn't one of the named ones: "4c12g". */
export const customLabel = (cpu: number, memoryGiB: number) => `${cpu}c${memoryGiB}g`;

/**
 * The `machine` param, checked: a size name from settings, or { cpu, memoryGiB } (a named size when it matches one).
 * Absent: settings' customerSize. Throws 400 'params' naming the sizes.
 */
export function resolveMachine(raw: unknown, gcp: { sizes: MachineSizes; customerSize: string }): Machine {
  const sizes = gcp.sizes;
  const names = byMemory(sizes).map((s) => `${s.name} (${s.cpu} vCPU, ${s.memoryGiB} GiB)`).join(', ');
  if (raw === undefined || raw === null || raw === '') {
    const name = gcp.customerSize in sizes ? gcp.customerSize : byMemory(sizes)[0].name;
    return { name, ...sizes[name] };
  }
  let v: any = raw;
  if (typeof v === 'string' && v.trim().startsWith('{')) { try { v = JSON.parse(v); } catch { throw bad('machine must be a size name or { cpu, memoryGiB }'); } }
  if (typeof v === 'string') {
    const name = v.trim().toLowerCase();
    if (!(name in sizes)) throw bad(`machine "${name.slice(0, 20)}" isn't a build size. Sizes: ${names}; or { "cpu": 4, "memoryGiB": 16 }.`);
    return { name, ...sizes[name] };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`machine must be a size name (${names}) or { cpu, memoryGiB }`);
  const extra = Object.keys(v).filter((k) => k !== 'cpu' && k !== 'memoryGiB');
  if (extra.length) throw bad(`machine takes { cpu, memoryGiB } (not ${extra.join(', ')})`);
  const problem = machineProblem(v.cpu, v.memoryGiB);
  if (problem) throw bad(`machine: ${problem}`);
  const cpu = Number(v.cpu);
  const memoryGiB = Number(v.memoryGiB);
  const named = byMemory(sizes).find((s) => s.cpu === cpu && s.memoryGiB === memoryGiB);
  return named ?? { name: customLabel(cpu, memoryGiB), cpu, memoryGiB };
}

/** The param as stored on the job: the size's name, or { cpu, memoryGiB } for one that isn't named. */
export function storedMachine(m: Machine, sizes: MachineSizes): string | { cpu: number; memoryGiB: number } {
  return m.name in sizes ? m.name : { cpu: m.cpu, memoryGiB: m.memoryGiB };
}

/** The next bigger named size (more memory) for a build that ran out of memory, or null at the biggest. */
export function nextBigger(m: Machine, sizes: MachineSizes): Machine | null {
  return byMemory(sizes).find((s) => s.memoryGiB > m.memoryGiB) ?? null;
}

/** The Cloud Run job of a size: the customer job's own name for its own size, else "<job>-<size>". */
export function sizedJobName(base: string, m: Machine, own: { cpu: number; memoryGiB: number }): string {
  return m.cpu === own.cpu && m.memoryGiB === own.memoryGiB ? base : `${base}-${m.name}`;
}

/** The limits Cloud Run's v2 API takes: cpu "4", memory "16Gi". */
export const limitsOf = (m: { cpu: number; memoryGiB: number }) => ({ cpu: String(m.cpu), memory: `${m.memoryGiB}Gi` });

/** Labels and annotations Google sets itself, never copied onto a new job. */
const own = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !/(^|\.)googleapis\.com\//.test(k) && !k.startsWith('run.googleapis.com')));

/**
 * The body that makes (or brings in line) a sized job: the customer job's whole template (image, service account,
 * env and secrets, timeout, execution environment, volumes) with the first container's cpu and memory changed.
 */
export function sizedJobBody(base: any, m: Machine, baseName: string): any {
  const template = JSON.parse(JSON.stringify(base?.template ?? {}));
  const task = (template.template ??= {});
  const c0 = (task.containers ??= [{}])[0];
  c0.resources = { ...(c0.resources ?? {}), limits: { ...(c0.resources?.limits ?? {}), ...limitsOf(m) } };
  const body: any = {
    labels: { ...own(base?.labels), 'hawkes-size': m.name, 'hawkes-base': baseName.slice(0, 63) },
    annotations: own(base?.annotations),
    template,
  };
  if (base?.launchStage) body.launchStage = base.launchStage;
  if (base?.binaryAuthorization) body.binaryAuthorization = base.binaryAuthorization;
  return body;
}

/** What has to match between the customer job and a sized one (everything a build depends on but the limits). */
export function templatePrint(job: any): string {
  const t = job?.template ?? {};
  const task = t.template ?? {};
  const c = (task.containers ?? []).map((x: any) => ({ image: x.image, env: x.env ?? [], command: x.command ?? null, args: x.args ?? null, limits: x.resources?.limits ?? null, mounts: x.volumeMounts ?? [] }));
  return JSON.stringify({ c, sa: task.serviceAccount ?? '', env: task.executionEnvironment ?? '', timeout: task.timeout ?? '', retries: task.maxRetries ?? null, volumes: task.volumes ?? [], vpc: task.vpcAccess ?? null });
}

export type JobApi = (url: string, init?: { method?: string; body?: unknown; missingOk?: boolean }) => Promise<any>;
const runBase = (t: { project: string; region: string }) => `https://run.googleapis.com/v2/projects/${t.project}/locations/${t.region}`;

/** Waits for a Cloud Run long-running operation (create or patch) to finish, at most ~90 s. */
async function waitOp(op: any, api: JobApi, sleep: (ms: number) => Promise<void>) {
  if (!op?.name || op.done) { if (op?.error) throw new Error(op.error.message ?? 'the operation failed'); return; }
  for (let i = 0; i < 30; i++) {
    await sleep(3_000);
    const o = await api(`https://run.googleapis.com/v2/${op.name}`);
    if (o?.done) { if (o.error) throw new Error(o.error.message ?? 'the operation failed'); return; }
  }
}

/**
 * Makes sure the sized job is there in one region and matches the customer job (`base` names it): made from its
 * template when missing, patched when its image or anything else but the limits differs (a new image on the customer
 * job reaches the sizes on their next build). Returns 'ok', 'nobase' (no customer job in that region), or throws.
 */
export async function ensureSizedJobIn(base: CloudRunTarget, sized: string, m: Machine, api: JobApi = gapi, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<'ok' | 'made' | 'updated' | 'nobase'> {
  const b = await api(`${runBase(base)}/jobs/${base.job}`, { missingOk: true });
  if (!b) return 'nobase';
  const want = sizedJobBody(b, m, base.job);
  const cur = await api(`${runBase(base)}/jobs/${sized}`, { missingOk: true });
  if (!cur) {
    await waitOp(await api(`${runBase(base)}/jobs?jobId=${encodeURIComponent(sized)}`, { method: 'POST', body: want }), api, sleep);
    return 'made';
  }
  if (templatePrint(cur) === templatePrint({ template: want.template })) return 'ok';
  await waitOp(await api(`${runBase(base)}/jobs/${sized}`, { method: 'PATCH', body: { ...want, name: `projects/${base.project}/locations/${base.region}/jobs/${sized}` } }), api, sleep);
  return 'updated';
}

const ensured = new Map<string, number>();
/** Tests: ensure every sized job again. */
export function forgetSizedJobs() { ensured.clear(); }

/**
 * The job a customer build of size `m` runs on. Its own size: the customer job. Another: the sized job, made or brought
 * in line in every region the customer job is in (remembered 10 minutes). If none could be made (Gen's account may not
 * create jobs), the customer job and its own size, with a warning: a build never fails over this.
 */
export async function customerJobForMachine(o: {
  base: string; machine: Machine; own: { cpu: number; memoryGiB: number }; project: string; regions: string[]; sizes?: MachineSizes;
  log?: (s: string) => void; api?: JobApi; sleep?: (ms: number) => Promise<void>;
}): Promise<{ job: string; machine: Machine; warning?: string }> {
  const sized = sizedJobName(o.base, o.machine, o.own);
  if (sized === o.base) return { job: o.base, machine: o.machine };
  const key = `${o.project}/${o.regions.join(',')}/${sized}`;
  if ((ensured.get(key) ?? 0) > Date.now()) return { job: sized, machine: o.machine };
  let ok = 0;
  let anyBase = false;
  let why = '';
  for (const region of o.regions) {
    try {
      const r = await ensureSizedJobIn({ project: o.project, region, job: o.base }, sized, o.machine, o.api ?? gapi, o.sleep);
      if (r === 'nobase') continue;
      anyBase = true;
      ok++;
      if (r !== 'ok') o.log?.(`${r === 'made' ? 'made' : 'updated'} the Cloud Run job ${sized} in ${region} (${o.machine.cpu} vCPU, ${o.machine.memoryGiB} GiB)`);
    } catch (e: any) {
      anyBase = true;
      why ||= String(e?.message ?? e).slice(0, 300);
      o.log?.(`(${region}: couldn't make or update ${sized}: ${String(e?.message ?? e).slice(0, 200)})`);
    }
  }
  if (ok) { ensured.set(key, Date.now() + 10 * 60_000); return { job: sized, machine: o.machine }; }
  const named = Object.entries(o.sizes ?? {}).find(([, v]) => v.cpu === o.own.cpu && v.memoryGiB === o.own.memoryGiB)?.[0];
  const fallback: Machine = { name: named ?? customLabel(o.own.cpu, o.own.memoryGiB), ...o.own };
  // No customer job anywhere: its own check says so with the setup to run (customer.ts checkCustomerJob).
  if (!anyBase) return { job: o.base, machine: fallback };
  const warning = `The ${o.machine.name} build machine (${o.machine.cpu} vCPU, ${o.machine.memoryGiB} GiB) isn't set up (${why}); built on ${o.base} (${o.own.cpu} vCPU, ${o.own.memoryGiB} GiB) instead. Make the sizes: node tools/unity-cloudrun/customer-setup.mjs --sizes --apply.`;
  o.log?.(warning);
  return { job: o.base, machine: fallback, warning };
}
