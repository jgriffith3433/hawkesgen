// The Cloud Run GPU services (docs/cloudrun.md): which service runs each model family (server/cloudrun/services.json),
// what an instance costs, and the routing rule the queue uses: a GPU job goes to its family's Cloud Run service when
// settings.gpu says cloudrun for that family, the service is deployed (its URL is in settings), and the tool runs
// nothing but ComfyUI graphs. Everything else stays on the AWS fleet.

import fs from 'node:fs';
import path from 'node:path';
import { paths, type Settings } from '../../config.ts';
import type { Tool } from '../../tools/types.ts';

export type ServiceSpec = {
  gpu: string; cpu: number; memoryGi: number; maxInstances: number; load: 'download' | 'mount';
  families: string[]; models: string[]; why?: string;
};
export type ServiceMap = {
  image: string; repository: string; bucketSuffix: string; timeoutSeconds: number; graphLimitSeconds: number;
  prices: { cpuPerVcpuSecond: number; memoryPerGibSecond: number; gpuPerSecond: Record<string, number>; verified?: boolean };
  gpus: Record<string, { vramGb: number; minCpu: number; minMemoryGi: number; regions: string[]; fallbackRegion: string }>;
  services: Record<string, ServiceSpec>;
  alternatives?: Record<string, ServiceSpec>;
  stayOnVm?: Record<string, string>;
};

/** A deployed service as the queue sees it. */
export type CloudService = {
  name: string; url: string; gpu: string; maxInstances: number; pricePerSecond: number;
  /** The most one graph may run (under Cloud Run's 60-minute request limit). */
  graphLimitSeconds: number;
  /** "dir/file" models every instance has at startup. */
  preload: Set<string>;
  bucket: string;
  /**
   * Other GPU providers (src/providers/gpu/, docs/gpu-providers.md) run the same worker. Unset on Cloud Run: provider
   * "cloudrun", the queue's lane is the service's name, the worker reaches the bucket itself and Gen calls it with a
   * Google ID token.
   */
  provider?: 'cloudrun' | 'runpod' | 'modal' | 'http';
  /** The queue lane (an endpoint id elsewhere; the service name on Cloud Run). */
  lane?: string;
  /** The worker has no Google identity: it reads and writes the bucket through Gen's broker (gpu/broker.ts). */
  broker?: boolean;
  /** "dir/file" models of the family's service in services.json: sent along when the graph names them (nothing preloads). */
  familyModels?: string[];
  /** The request headers for this endpoint (gpu/auth.ts); unset: a Google ID token for the service URL. */
  headers?: () => Record<string, string>;
  /** How long a run waits for a free instance before the job goes to the next provider. */
  waitForInstanceMs?: number;
};

export const SERVICES_FILE = () => path.join(paths.server, 'cloudrun', 'services.json');
let cached: { file: string; mtime: number; map: ServiceMap } | null = null;

/** services.json (re-read when it changes). */
export function loadServiceMap(file = SERVICES_FILE()): ServiceMap {
  const mtime = fs.statSync(file).mtimeMs;
  if (cached && cached.file === file && cached.mtime === mtime) return cached.map;
  const map = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceMap;
  cached = { file, mtime, map };
  return map;
}

/** Every service, the pilot alternatives too. */
export const allServices = (map: ServiceMap): Record<string, ServiceSpec> => ({ ...map.services, ...(map.alternatives ?? {}) });

/** What one instance of a service costs per second while it is up (GPU + vCPUs + memory; instance-based billing). */
export function pricePerSecond(map: ServiceMap, spec: Pick<ServiceSpec, 'gpu' | 'cpu' | 'memoryGi'>): number {
  const gpu = map.prices.gpuPerSecond[spec.gpu];
  if (gpu === undefined) throw new Error(`No price for GPU ${spec.gpu} in services.json`);
  return gpu + spec.cpu * map.prices.cpuPerVcpuSecond + spec.memoryGi * map.prices.memoryPerGibSecond;
}

/** The service that runs a family: a settings override first, else the map. */
export function serviceForFamily(map: ServiceMap, family: string, overrides: Record<string, string> = {}): string | null {
  if (overrides[family]) return overrides[family];
  for (const [name, s] of Object.entries(map.services)) if (s.families.includes(family)) return name;
  return null;
}

/** Where this job's GPU work runs: a Cloud Run service, or the fleet and why. */
export type Route = { service: CloudService; why?: undefined } | { service: null; why: string };

export function cloudRoute(job: { family: string | null; params: Record<string, any>; labels?: Record<string, unknown> }, tool: Pick<Tool, 'provider' | 'server' | 'gpuSeconds'> & { image?: Tool['image'] }, settings: Pick<Settings, 'gpu'>, map: ServiceMap): Route {
  const fleet = (why: string): Route => ({ service: null, why });
  if (tool.provider !== 'comfy') return fleet('not a GPU tool');
  if (tool.server === 'ssh') return fleet('the tool works on the server over SSH');
  if (tool.image === '3d') return fleet('the tool needs the 3D worker image (Cloud Run runs ComfyUI services): a 3D endpoint in settings.gpu.order, or the fleet');
  const family = job.family ?? '';
  const forced = job.labels?.gpuBackend;
  if (forced === 'fleet') return fleet('this job asked for the fleet');
  const backend = forced === 'cloudrun' ? 'cloudrun' : settings.gpu.families[family] ?? settings.gpu.backend;
  if (backend !== 'cloudrun') return fleet(`the ${family || 'job'} family runs on the fleet`);
  const name = serviceForFamily(map, family, settings.gpu.cloudrun.services);
  if (!name) return fleet(`no Cloud Run service runs ${family || 'this family'}`);
  const spec = allServices(map)[name];
  if (!spec) return fleet(`settings name the Cloud Run service ${name}, which services.json doesn't have`);
  const url = settings.gpu.cloudrun.urls[name];
  if (!url) return fleet(`${name} isn't deployed (no URL in settings.gpu.cloudrun.urls)`);
  const bucket = settings.gpu.cloudrun.bucket;
  if (!bucket) return fleet('settings.gpu.cloudrun.bucket is not set');
  const perGraph = Number(tool.gpuSeconds?.(job.params) ?? 0);
  if (perGraph > map.graphLimitSeconds) return fleet(`one graph may run ${Math.round(perGraph / 60)} min, past Cloud Run's limit`);
  return {
    service: {
      name, url, gpu: spec.gpu, maxInstances: Math.max(1, spec.maxInstances), pricePerSecond: pricePerSecond(map, spec),
      graphLimitSeconds: map.graphLimitSeconds, preload: new Set(spec.models), bucket,
    },
  };
}

/** Is any family routed to Cloud Run at all (so the queue skips the routing work when it's all fleet)? */
export const cloudEnabled = (settings: Pick<Settings, 'gpu'>) =>
  settings.gpu.backend === 'cloudrun' || Object.values(settings.gpu.families).includes('cloudrun');
