// GET /v1/gpu/providers (docs/gpu-providers.md): every GPU provider Gen knows, in the order jobs try them, with whether
// it is set up, cooling down (and why), its last error and its price. The dashboard's Settings > GPU providers card.
import type { Settings } from '../../config.ts';
import { env } from '../../config.ts';
import { allServices, pricePerSecond, type ServiceMap } from '../cloudrun/services.ts';
import { healthOf } from './health.ts';
import { missingSecrets, type Secrets } from './auth.ts';
import { fleetBlocked } from './egress.ts';
import { orderFor } from './route.ts';

export type ProviderRow = {
  id: string; provider: 'fleet' | 'cloudrun' | 'runpod' | 'modal' | 'http'; url: string | null; gpu: string; pricePerHour: number | null;
  families: string[]; enabled: boolean; ready: boolean; problem: string | null; health: ReturnType<typeof healthOf>;
};

const host = (u: string) => { try { return new URL(u).host; } catch { return null; } };

export function gpuStatus(settings: Pick<Settings, 'gpu' | 'fleet'>, map: ServiceMap | null, get: Secrets = env) {
  const g = settings.gpu;
  const rows: ProviderRow[] = [];
  const blocked = fleetBlocked(settings.fleet, get);
  rows.push({ id: 'fleet', provider: 'fleet', url: null, gpu: 'L40S (g6e.xlarge)', pricePerHour: 1.86, families: ['*'], enabled: true, ready: !blocked, problem: blocked, health: healthOf('fleet') });
  const urls = g.cloudrun.urls;
  const services = map ? Object.entries(allServices(map)) : [];
  const deployed = services.filter(([name]) => urls[name]);
  rows.push({
    id: 'cloudrun', provider: 'cloudrun', url: deployed.length ? deployed.map(([n]) => host(urls[n])).join(', ') : null,
    gpu: [...new Set(deployed.map(([, s]) => s.gpu))].join(', ') || 'L4',
    pricePerHour: map && deployed.length ? Math.round(pricePerSecond(map, deployed[0][1]) * 3600 * 100) / 100 : null,
    families: deployed.flatMap(([, s]) => s.families ?? []), enabled: true,
    ready: !!deployed.length && !!g.cloudrun.bucket,
    problem: !map ? 'no services.json' : !deployed.length ? 'no service deployed (settings.gpu.cloudrun.urls)' : !g.cloudrun.bucket ? 'settings.gpu.cloudrun.bucket is not set' : null,
    health: healthOf('cloudrun'),
  });
  for (const ep of g.providers) {
    const missing = missingSecrets(ep.provider, get);
    const problem = !ep.enabled ? 'turned off' : missing ?? (!g.cloudrun.bucket ? 'settings.gpu.cloudrun.bucket is not set' : !get('HAWKESGEN_PUBLIC_URL') ? 'HAWKESGEN_PUBLIC_URL is not set' : null);
    rows.push({ id: ep.id, provider: ep.provider, url: host(ep.url), gpu: ep.gpu, pricePerHour: ep.pricePerHour, families: ep.families, enabled: ep.enabled, ready: !problem, problem, health: healthOf(ep.id) });
  }
  const families = Object.keys(g.familyOrder);
  return {
    // No order: the old rule (each family's backend setting, fleet by default).
    legacy: !g.order.length && !families.length,
    order: orderFor(settings, null),
    familyOrder: g.familyOrder,
    providers: rows,
  };
}
