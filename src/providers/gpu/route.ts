// Where a GPU job runs (docs/gpu-providers.md): the providers in settings.gpu.order (or the family's familyOrder),
// first usable one first. Each is "fleet" (the AWS servers), "cloudrun" (the family's Cloud Run service) or an endpoint
// id from settings.gpu.providers (RunPod, Modal, any host running the worker image). A provider is skipped while it
// cools down after refusing us (health.ts), when it isn't set up (no URL, no key, no bucket), when this job already
// failed there, or when the job can't run there (tools that work over SSH need the fleet; a graph longer than the
// provider's request limit). With no order at all, the old rule applies unchanged: Cloud Run when settings send the
// family there and its service is deployed, else the fleet.
import type { GpuEndpoint, Settings } from '../../config.ts';
import { env } from '../../config.ts';
import type { Tool } from '../../tools/types.ts';
import { cloudRoute, serviceForFamily, allServices, type CloudService, type ServiceMap } from '../cloudrun/services.ts';
import { isDown } from './health.ts';
import { runpodCreditProblem } from './credit.ts';
import { endpointHeaders, missingSecrets, type Secrets } from './auth.ts';

export type Choice = { kind: 'service'; service: CloudService } | { kind: 'fleet' };
export type Candidates = { choices: Choice[]; skipped: string[] };

type Job = { id?: string; family: string | null; params: Record<string, any>; labels?: Record<string, unknown> };
type ToolLike = Pick<Tool, 'provider' | 'server' | 'gpuSeconds'> & { image?: Tool['image'] };

/** The ids this job already failed on (it moves on from them). */
export const triedOf = (job: Job): string[] => (Array.isArray(job.labels?.gpuTried) ? (job.labels!.gpuTried as unknown[]).map(String) : []);

/** The order that applies to a family: its own, else the default; empty means the old rule. */
export function orderFor(settings: Pick<Settings, 'gpu'>, family: string | null): string[] {
  return settings.gpu.familyOrder?.[family ?? ''] ?? settings.gpu.order ?? [];
}

/** An endpoint as the run protocol's service: no preloads (every model the graph names rides along), through the broker. */
export function endpointService(ep: GpuEndpoint, family: string, map: ServiceMap, bucket: string, get: Secrets = env): CloudService {
  const svcName = serviceForFamily(map, family);
  const spec = svcName ? allServices(map)[svcName] : undefined;
  return {
    name: ep.id, url: ep.url, gpu: ep.gpu, maxInstances: ep.maxConcurrent, pricePerSecond: ep.pricePerHour / 3600,
    graphLimitSeconds: ep.graphLimitSeconds, preload: new Set(), bucket,
    provider: ep.provider, lane: ep.id, broker: true, familyModels: spec?.models ?? [],
    headers: () => endpointHeaders(ep.provider, get),
    // Elsewhere is waiting in line: a busy endpoint hands the job on after a short wait.
    waitForInstanceMs: 3 * 60_000,
  };
}

/**
 * The providers this job may run on, in order. `now` and `get` are for tests. A job forced to the fleet
 * (labels.gpuBackend "fleet": its graph ran past a provider's limit) gets the fleet alone.
 */
export function gpuCandidates(job: Job, tool: ToolLike, settings: Pick<Settings, 'gpu'>, map: ServiceMap | null, now = Date.now(), get: Secrets = env): Candidates {
  const skipped: string[] = [];
  const order = orderFor(settings, job.family);
  if (tool.provider !== 'comfy') return { choices: [{ kind: 'fleet' }], skipped: ['not a GPU tool'] };
  // The old rule, exactly: no order set.
  if (!order.length) {
    if (!map) return { choices: [{ kind: 'fleet' }], skipped: ['no services.json'] };
    const r = cloudRoute(job, tool, settings, map);
    return r.service ? { choices: [{ kind: 'service', service: { ...r.service, provider: 'cloudrun', lane: r.service.name } }], skipped } : { choices: [{ kind: 'fleet' }], skipped: [r.why] };
  }
  if (job.labels?.gpuBackend === 'fleet' || tool.server === 'ssh') {
    return { choices: [{ kind: 'fleet' }], skipped: [tool.server === 'ssh' ? 'the tool works on the server over SSH: the fleet only' : 'this job asked for the fleet'] };
  }
  const tried = new Set(triedOf(job));
  const family = job.family ?? '';
  const perGraph = Number(tool.gpuSeconds?.(job.params) ?? 0);
  const bucket = settings.gpu.cloudrun.bucket;
  const choices: Choice[] = [];
  for (const id of order) {
    const cool = isDown(id, now);
    if (tried.has(id)) { skipped.push(`${id}: this job already failed there`); continue; }
    if (cool) { skipped.push(`${id}: ${cool.reason} (skipped for ${Math.ceil((cool.until - now) / 60_000)} min)`); continue; }
    if (id === 'fleet') { choices.push({ kind: 'fleet' }); continue; }
    if (!map) { skipped.push(`${id}: no services.json`); continue; }
    if (id === 'cloudrun') {
      const r = cloudRoute({ ...job, labels: { ...(job.labels ?? {}), gpuBackend: 'cloudrun' } }, tool, settings, map);
      // Cloud Run's services cool down and are tried one by one (a job's tried list and the cooldowns hold service names).
      const down = r.service && isDown(r.service.name, now);
      if (r.service && tried.has(r.service.name)) skipped.push(`cloudrun: this job already failed on ${r.service.name}`);
      else if (r.service && down) skipped.push(`cloudrun: ${r.service.name} ${down.reason} (skipped for ${Math.ceil((down.until - now) / 60_000)} min)`);
      else if (r.service) choices.push({ kind: 'service', service: { ...r.service, provider: 'cloudrun', lane: r.service.name } });
      else skipped.push(`cloudrun: ${r.why}`);
      continue;
    }
    const ep = settings.gpu.providers.find((p) => p.id === id);
    if (!ep) { skipped.push(`${id}: not in settings.gpu.providers`); continue; }
    if (!ep.enabled) { skipped.push(`${id}: turned off`); continue; }
    if (!ep.families.includes('*') && !ep.families.includes(family)) { skipped.push(`${id}: doesn't run the ${family || 'job\'s'} family`); continue; }
    // "*" is the ComfyUI image: a 3D tool's script needs an endpoint running the 3D image, which names its family.
    if (tool.image === '3d' && !ep.families.includes(family)) { skipped.push(`${id}: runs the ComfyUI image ("*"); ${family} needs an endpoint with the 3D image that names it`); continue; }
    if (perGraph > ep.graphLimitSeconds) { skipped.push(`${id}: one graph may run ${Math.round(perGraph / 60)} min, past its limit`); continue; }
    if (!bucket) { skipped.push(`${id}: settings.gpu.cloudrun.bucket is not set (the worker's files go there)`); continue; }
    if (!env('HAWKESGEN_PUBLIC_URL')) { skipped.push(`${id}: HAWKESGEN_PUBLIC_URL is not set (the worker reaches the bucket through Gen)`); continue; }
    const missing = missingSecrets(ep.provider, get);
    if (missing) { skipped.push(`${id}: ${missing}`); continue; }
    const broke = ep.provider === 'runpod' ? runpodCreditProblem(get) : null;
    if (broke) { skipped.push(`${id}: ${broke}`); continue; }
    choices.push({ kind: 'service', service: endpointService(ep, family, map, bucket, get) });
  }
  return { choices, skipped };
}

/**
 * Whether a GPU tool can run now, for the app's Create list and make.checked's routing: a tool that works over SSH
 * needs the fleet; a 3D tool needs the fleet or an enabled endpoint that names its family (the 3D worker image).
 */
export function toolReady(tool: Pick<Tool, 'server' | 'family' | 'image'> | undefined | null, o: { fleetDown: boolean; settings: Pick<Settings, 'gpu'> | null }): boolean {
  if (!tool) return false;
  if (tool.server === 'ssh') return !o.fleetDown;
  if (tool.image !== '3d') return true;
  if (!o.fleetDown) return true;
  const family = typeof tool.family === 'string' ? tool.family : '';
  return Boolean(o.settings?.gpu.providers?.some((p) => p.enabled && p.families.includes(family)));
}
