// RunPod's management API v2 (https://api.runpod.io/v2), shared by the RunPod setup scripts:
// tools/gpu-providers/runpod.mjs, tools/playtest-runpod/setup.mjs and tools/play-native/setup.mjs.
//
// REST v1 (rest.runpod.io/v1) is retired on 2026-11-15 and the GraphQL API "in early 2027" (docs.runpod.io/release-notes,
// docs.runpod.io/api-reference-v2/migrate-from-v1, read 2026-11-01). What changed for us:
//   - endpoints are /v2/serverless; workersMin/workersMax/idleTimeout are workers {min, max, idleTimeout}; scalerType and
//     scalerValue are scaling {type: QUEUE_DELAY|REQUEST_COUNT, queueDelay|requestCount}; type is QUEUE or LOAD_BALANCER
//     (a load balancer needs REQUEST_COUNT); executionTimeoutMs is timeout; gpuIds/gpuTypeIds are gpu {pools, count,
//     excludedTypes}: pools are serverless pool ids (AMPERE_16...) and excludedTypes pod GPU type ids ("NVIDIA L4").
//     There is no allow-list of GPU models any more, so an allow-list becomes "every type in those pools but these".
//   - templates: imageName is image, containerDiskInGb disk, isServerless serverless, containerRegistryAuthId registry;
//     env is an object, ports an array.
//   - a template is applied to an endpoint once (on create, or a PATCH with templateId): editing the template later
//     does not change the endpoint. A new image goes to the endpoint itself (PATCH /v2/serverless/{id} {image}), which
//     makes a new release that rolls out as workers cycle.
//   - lists come wrapped ({endpoints: [...], pagination: {nextCursor}}) and errors are RFC 9457 ({title, detail}).
// Nothing here starts a worker: RunPod bills only while one runs.

export const API = 'https://api.runpod.io/v2';

/**
 * How long a RunPod worker with no request open stays up, for every one of Gen's endpoints, and that none is kept warm
 * (min workers 0). J, 2026-11-11: "Make sure runpod isn't wasted on builds and playtests if at all possible", "No warm
 * idle pods". A worker bills until this runs out, so 60 s is the most an idle one costs. A long run is never cut by it:
 * Gen holds a request open for the whole run and asks again the moment RunPod ends one (src/providers/cloudrun/run.ts
 * reattach), so the worker always has a request open while it works. 2026-11-11 08:36 UTC the GPU and 3D endpoints
 * had idle timeouts of 600 s and 900 s from their console setup, and idle workers sat on them.
 */
export const IDLE_SECONDS = 60;

/** An endpoint's workers as Gen keeps them: none warm, each gone IDLE_SECONDS after its last request. `idle` only lowers it. */
export const idleWorkers = (max, idle = IDLE_SECONDS) => ({ min: 0, max, idleTimeout: Math.max(5, Math.min(IDLE_SECONDS, Number(idle) || IDLE_SECONDS)) });

/** Whether an endpoint keeps warm workers or idle ones longer than IDLE_SECONDS (what --idle fixes). */
export const wastesIdle = (ep) => Number(ep?.workers?.min ?? 0) > 0 || Number(ep?.workers?.idleTimeout ?? 0) > IDLE_SECONDS;

/** The serverless GPU pools (docs.runpod.io/references/gpu-types) and RunPod's flex prices per worker hour, 2026-10-29. */
export const POOL_PRICES = { AMPERE_16: 0.58, AMPERE_24: 0.69, ADA_24: 1.10, AMPERE_48: 1.22, ADA_48_PRO: 1.75, AMPERE_80: 2.72, ADA_80_PRO: 4.79 };
export const POOL_GPUS = { AMPERE_16: 'RTX A4000 class (16 GB)', AMPERE_24: 'L4 / A5000 class (24 GB)', ADA_24: 'RTX 4090 (24 GB)', AMPERE_48: 'A6000 / A40 (48 GB)', ADA_48_PRO: 'L40S class (48 GB)', AMPERE_80: 'A100 (80 GB)', ADA_80_PRO: 'H100 (80 GB)' };
/** Pod GPU type id -> its serverless pool, for when the catalog can't be read (the catalog wins). */
export const POOL_OF = {
  'NVIDIA RTX A4000': 'AMPERE_16', 'NVIDIA RTX A4500': 'AMPERE_16', 'NVIDIA RTX 4000 Ada Generation': 'AMPERE_16', 'NVIDIA RTX 2000 Ada Generation': 'AMPERE_16',
  'NVIDIA L4': 'AMPERE_24', 'NVIDIA RTX A5000': 'AMPERE_24', 'NVIDIA GeForce RTX 3090': 'AMPERE_24',
  'NVIDIA GeForce RTX 4090': 'ADA_24',
  'NVIDIA RTX A6000': 'AMPERE_48', 'NVIDIA A40': 'AMPERE_48',
  'NVIDIA L40': 'ADA_48_PRO', 'NVIDIA L40S': 'ADA_48_PRO', 'NVIDIA RTX 6000 Ada Generation': 'ADA_48_PRO',
  'NVIDIA A100 80GB PCIe': 'AMPERE_80', 'NVIDIA A100-SXM4-80GB': 'AMPERE_80',
  'NVIDIA H100 80GB HBM3': 'ADA_80_PRO', 'NVIDIA H100 PCIe': 'ADA_80_PRO',
};

/** A small client: req() throws with RunPod's own words on any non-2xx; list() walks every page of a list. */
export function runpod(key, { fetch: f = globalThis.fetch, base = API } = {}) {
  async function req(method, path, body) {
    const r = await f(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { detail: text }; }
    if (!r.ok) throw new Error(`RunPod ${method} ${path}: ${r.status} ${[j.title, j.detail, j.message].filter(Boolean).join(': ').slice(0, 400) || text.slice(0, 400)}`);
    return j;
  }
  /** Every item of a wrapped list ({<key>: [...], pagination: {nextCursor}}); a bare array is taken as it is. */
  async function list(path, key) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      const j = await req('GET', `${path}${path.includes('?') ? '&' : '?'}limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const items = Array.isArray(j) ? j : (j[key] ?? Object.values(j).find(Array.isArray) ?? []);
      out.push(...items);
      cursor = j.pagination?.hasNextPage ? j.pagination.nextCursor : null;
      if (!cursor) break;
    }
    return out;
  }
  return { req, list };
}

/**
 * gpu {pools, excludedTypes, count} for "only these GPU models": the pools that hold them, and every other type in those
 * pools excluded. `catalog` is GET /v2/catalog/gpus ([{id, pool}]); without it the known table above stands in, which
 * can't exclude a type RunPod added since (a MIG slice), so the catalog should be read when applying.
 */
export function gpuFor(models, { pools = null, catalog = null, count = 1 } = {}) {
  const poolOf = (id) => (catalog ? catalog.find((g) => g.id === id)?.pool : null) ?? POOL_OF[id] ?? null;
  const unknown = models.filter((m) => !poolOf(m));
  if (unknown.length) throw new Error(`No serverless pool known for ${unknown.join(', ')}`);
  const use = pools?.length ? pools : [...new Set(models.map(poolOf))];
  const outside = models.filter((m) => !use.includes(poolOf(m)));
  if (outside.length) throw new Error(`${outside.join(', ')} not in the pools ${use.join(', ')}`);
  const inPools = catalog ? catalog.filter((g) => use.includes(g.pool)).map((g) => g.id) : Object.keys(POOL_OF).filter((id) => use.includes(POOL_OF[id]));
  return { pools: use, excludedTypes: inPools.filter((id) => !models.includes(id)).sort(), count };
}

/** env as v2 wants it (an object), from [[k, v]] pairs, leaving out empty values. */
export const envObject = (pairs) => Object.fromEntries(pairs.filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** A load-balancer endpoint body (POST or PATCH /v2/serverless). */
export function lbEndpoint({ name, templateId, gpu, max, idle, perWorker, timeoutMs }) {
  return {
    name, type: 'LOAD_BALANCER', ...(templateId ? { templateId } : {}), gpu,
    workers: idleWorkers(max, idle), scaling: { type: 'REQUEST_COUNT', requestCount: perWorker }, timeout: timeoutMs,
  };
}

/** Make the named template, or bring the one of that name up to date. Returns [template, made]. */
export async function upsertTemplate(api, template) {
  const old = (await api.list('/templates', 'templates')).find((t) => t.name === template.name);
  if (old) return [await api.req('PATCH', `/templates/${old.id}`, template), false];
  return [await api.req('POST', '/templates', template), true];
}

/** The endpoint of this name (or its FlashBoot twin "<name> -fb"), or null. */
export async function findEndpoint(api, name) {
  return (await api.list('/serverless', 'endpoints')).find((e) => e.name === name || e.name === `${name} -fb`) ?? null;
}

/** GET /v2/catalog/gpus as [{id, pool}], or null when it can't be read. */
export async function readCatalog(api) {
  try { return (await api.list('/catalog/gpus', 'gpus')).map((g) => ({ id: g.id, pool: g.pool ?? null })); } catch { return null; }
}

/**
 * Read-only: what --apply would do, from the same GETs it starts with (the catalog, the template and the endpoint of
 * this name). Returns lines to print; throws when the catalog can't be read (--apply would stop there too).
 */
export async function checkPlan(api, { template, name, gpuTypes, pools, endpointBody }) {
  const out = [];
  const catalog = await readCatalog(api);
  if (!catalog) throw new Error('Could not read GET /v2/catalog/gpus: --apply would stop here.');
  out.push(`catalog: ${catalog.length} GPU types`);
  const gpu = gpuFor(gpuTypes, { pools, catalog });
  out.push(`would exclude in ${gpu.pools.join(', ')}: ${gpu.excludedTypes.join(', ') || 'none'}`);
  const t = (await api.list('/templates', 'templates')).find((x) => x.name === template.name);
  out.push(t ? `template ${t.id}: would PATCH (image now ${t.image ?? '?'}, wanted ${template.image})` : `no template named ${template.name}: would POST one`);
  const old = await findEndpoint(api, name);
  if (!old) { out.push(`no endpoint named ${name}: would POST one`); return out; }
  const e = await api.req('GET', `/serverless/${old.id}`);
  const pick = (x) => ({ type: x.type, workers: x.workers, scaling: x.scaling, timeout: x.timeout, gpu: x.gpu });
  out.push(`endpoint ${old.id} (${old.name}): would PATCH`, `  now:    ${JSON.stringify(pick(e))}`, `  wanted: ${JSON.stringify(pick(endpointBody('<template id>', gpu)))}`);
  return out;
}
