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
import { isDown, lastingDown } from './health.ts';
import { runpodCreditProblem } from './credit.ts';
import { endpointHeaders, missingSecrets, type Secrets } from './auth.ts';

export type Choice = { kind: 'service'; service: CloudService } | { kind: 'fleet' };
/**
 * skipped: why each provider was passed over, in words. blockers: the same, each marked lasting when it won't clear on its
 * own (no key, no credit, not set up, AWS refusing us) as opposed to passing (busy, cooling down after a capacity error,
 * this job already failed there). With no choice and every blocker lasting, the job fails at once (nogpu.ts).
 */
export type Blocker = { reason: string; lasting: boolean };
export type Candidates = { choices: Choice[]; skipped: string[]; blockers: Blocker[] };

type Job = { id?: string; family: string | null; params: Record<string, any>; labels?: Record<string, unknown> };
type ToolLike = Pick<Tool, 'provider' | 'server' | 'gpuSeconds'> & { image?: Tool['image'] };

/**
 * Why the AWS fleet can't be used at all, or '' when it can: the same credentials rule as fleet.ts awsConfig (keys, the
 * Google-to-AWS federation, an instance role), checked without loading the AWS SDK. Kept in step with awsConfig.
 * 2026-11-07: with no keys in Gen's environment the fleet stayed in the order, so jobs were sent there and failed on
 * the credentials before moving on; now it is skipped as a lasting blocker.
 */
export function fleetCredentialProblem(get: Secrets = env): string {
  if (get('AWS_ACCESS_KEY_ID') && get('AWS_SECRET_ACCESS_KEY')) return '';
  if (get('HAWKES_AWS_FEDERATION') === 'gce' || (get('K_SERVICE') && get('HAWKES_AWS_ROLE_ARN'))) return '';
  if (get('HAWKES_AWS_ROLE')) return '';
  return 'no AWS credentials, so the GPU servers can\'t be started';
}

/** The ids this job already failed on (it moves on from them). */
export const triedOf = (job: Job): string[] => (Array.isArray(job.labels?.gpuTried) ? (job.labels!.gpuTried as unknown[]).map(String) : []);

/**
 * The order that applies to a family: its own, else the default; empty means the old rule. A family's own list is
 * followed by every other enabled endpoint that names that family (before the fleet), so a second endpoint for it is a
 * fallback the moment it is added. 2026-11-08: the 3D families' list was ["runpod-3d", "fleet"]; when RunPod ran out of
 * credit they had nowhere to go though Modal was up, because a family's list replaced everything. Endpoints serving
 * every family ("*") are not appended: a family with its own list may keep off them on purpose (long video graphs).
 */
export function orderFor(settings: Pick<Settings, 'gpu'>, family: string | null): string[] {
  const own = settings.gpu.familyOrder?.[family ?? ''];
  if (!own) return settings.gpu.order ?? [];
  if (!family) return own;
  const named = (settings.gpu.providers ?? []).filter((p) => p.enabled !== false && p.families?.includes(family) && !own.includes(p.id)).map((p) => p.id);
  if (!named.length) return own;
  const at = own.indexOf('fleet');
  return at < 0 ? [...own, ...named] : [...own.slice(0, at), ...named, ...own.slice(at)];
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
    ...(ep.coldStartSeconds ? { coldStartMs: ep.coldStartSeconds * 1000 } : {}),
  };
}

/**
 * The providers this job may run on, in order. `now` and `get` are for tests. A job forced to the fleet
 * (labels.gpuBackend "fleet": its graph ran past a provider's limit) gets the fleet alone.
 */
export function gpuCandidates(job: Job, tool: ToolLike, settings: Pick<Settings, 'gpu'>, map: ServiceMap | null, now = Date.now(), get: Secrets = env): Candidates {
  const skipped: string[] = [];
  const blockers: Blocker[] = [];
  const skip = (reason: string, lasting: boolean) => { skipped.push(reason); blockers.push({ reason, lasting }); };
  const order = orderFor(settings, job.family);
  if (tool.provider !== 'comfy') return { choices: [{ kind: 'fleet' }], skipped: ['not a GPU tool'], blockers: [] };
  // The old rule, exactly: no order set.
  if (!order.length) {
    if (!map) return { choices: [{ kind: 'fleet' }], skipped: ['no services.json'], blockers };
    const r = cloudRoute(job, tool, settings, map);
    return r.service ? { choices: [{ kind: 'service', service: { ...r.service, provider: 'cloudrun', lane: r.service.name } }], skipped, blockers } : { choices: [{ kind: 'fleet' }], skipped: [r.why], blockers };
  }
  if (job.labels?.gpuBackend === 'fleet' || tool.server === 'ssh') {
    const why = tool.server === 'ssh' ? 'the tool works on the server over SSH: the fleet only' : 'this job asked for the fleet';
    const off = fleetCredentialProblem(get);
    if (off) { skip(`${why}; fleet: ${off}`, true); return { choices: [], skipped, blockers }; }
    return { choices: [{ kind: 'fleet' }], skipped: [why], blockers };
  }
  const tried = new Set(triedOf(job));
  const family = job.family ?? '';
  const perGraph = Number(tool.gpuSeconds?.(job.params) ?? 0);
  const bucket = settings.gpu.cloudrun.bucket;
  const choices: Choice[] = [];
  for (const id of order) {
    const cool = isDown(id, now);
    if (tried.has(id)) { skip(`${id}: this job already failed there`, false); continue; }
    if (cool) { skip(`${id}: ${cool.reason} (skipped for ${Math.ceil((cool.until - now) / 60_000)} min)`, lastingDown(cool)); continue; }
    if (id === 'fleet') {
      const off = fleetCredentialProblem(get);
      if (off) skip(`fleet: ${off}`, true);
      else choices.push({ kind: 'fleet' });
      continue;
    }
    if (!map) { skip(`${id}: no services.json`, true); continue; }
    if (id === 'cloudrun') {
      const r = cloudRoute({ ...job, labels: { ...(job.labels ?? {}), gpuBackend: 'cloudrun' } }, tool, settings, map);
      // Cloud Run's services cool down and are tried one by one (a job's tried list and the cooldowns hold service names).
      const down = r.service && isDown(r.service.name, now);
      if (r.service && tried.has(r.service.name)) skip(`cloudrun: this job already failed on ${r.service.name}`, false);
      else if (r.service && down) skip(`cloudrun: ${r.service.name} ${down.reason} (skipped for ${Math.ceil((down.until - now) / 60_000)} min)`, lastingDown(down));
      else if (r.service) choices.push({ kind: 'service', service: { ...r.service, provider: 'cloudrun', lane: r.service.name } });
      else skip(`cloudrun: ${r.why}`, true);
      continue;
    }
    const ep = settings.gpu.providers.find((p) => p.id === id);
    if (!ep) { skip(`${id}: not in settings.gpu.providers`, true); continue; }
    if (!ep.enabled) { skip(`${id}: turned off`, true); continue; }
    if (!ep.families.includes('*') && !ep.families.includes(family)) { skip(`${id}: doesn't run the ${family || 'job\'s'} family`, true); continue; }
    // "*" is the ComfyUI image: a 3D tool's script needs an endpoint running the 3D image, which names its family.
    if (tool.image && !ep.families.includes(family)) { skip(`${id}: runs the ComfyUI image ("*"); ${family} needs an endpoint with the ${tool.image} image that names it`, true); continue; }
    if (perGraph > ep.graphLimitSeconds) { skip(`${id}: one graph may run ${Math.round(perGraph / 60)} min, past its limit`, true); continue; }
    if (!bucket) { skip(`${id}: settings.gpu.cloudrun.bucket is not set (the worker's files go there)`, true); continue; }
    if (!env('HAWKESGEN_PUBLIC_URL')) { skip(`${id}: HAWKESGEN_PUBLIC_URL is not set (the worker reaches the bucket through Gen)`, true); continue; }
    const missing = missingSecrets(ep.provider, get);
    if (missing) { skip(`${id}: ${missing}`, true); continue; }
    const broke = ep.provider === 'runpod' ? runpodCreditProblem(get) : null;
    if (broke) { skip(`${id}: ${broke}`, true); continue; }
    choices.push({ kind: 'service', service: endpointService(ep, family, map, bucket, get) });
  }
  return { choices, skipped, blockers };
}

/**
 * Whether a GPU tool can run now, for the app's Create list and make.checked's routing: a tool that works over SSH
 * needs the fleet; a 3D tool needs the fleet or an enabled endpoint that names its family (the 3D worker image).
 */
export function toolReady(tool: Pick<Tool, 'server' | 'family' | 'image'> | undefined | null, o: { fleetDown: boolean; settings: Pick<Settings, 'gpu'> | null }): boolean {
  if (!tool) return false;
  if (tool.server === 'ssh') return !o.fleetDown;
  if (!tool.image) return true;
  if (!o.fleetDown && tool.image === '3d') return true; // the fleet has Blender and the venvs, never Unity
  const family = typeof tool.family === 'string' ? tool.family : '';
  return Boolean(o.settings?.gpu.providers?.some((p) => p.enabled && p.families.includes(family)));
}
