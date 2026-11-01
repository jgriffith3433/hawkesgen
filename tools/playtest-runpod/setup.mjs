#!/usr/bin/env node
// The playtest browser on RunPod (docs/playtest-runpod.md): the playtest image (server/playtest-cloudrun/, built to GHCR
// by .github/workflows/playtest-image.yml) as a RunPod serverless LOAD-BALANCER endpoint, so Gen's chromium.connect
// reaches the image's own server over a WebSocket at wss://<endpoint id>.api.runpod.ai/pw.
//
//   node tools/playtest-runpod/setup.mjs                      print the plan (changes nothing)
//   node tools/playtest-runpod/setup.mjs --apply              create or update the template and the endpoint
//   options: --image ghcr.io/jgriffith3433/hawkes-gen-playtest:latest  --name hawkes-gen-playtest
//            --gpu AMPERE_16,AMPERE_24  --max 2  --tabs 2  --idle 60
//
// Creating or updating a template or an endpoint costs nothing: RunPod bills only while a worker runs (from its start
// to `--idle` seconds after the last connection). Workers min stays 0. The script never starts a worker.
//
// Secrets (hawkesgen/.env, never printed): RUNPOD_API_KEY (the API, and Gen's calls to the endpoint), and the token the
// image checks as HAWKES_TOKEN: PLAYTEST_RUNPOD_TOKEN, else GPU_WORKER_TOKEN (Gen already has it), else none (then only
// RunPod's API key guards the endpoint).
import { APPLY, arg, secret, say, header, redact } from '../gpu-providers/lib.mjs';
import { runpod, gpuFor, envObject, lbEndpoint, upsertTemplate, findEndpoint, readCatalog, POOL_PRICES, POOL_GPUS } from '../gpu-providers/runpod-v2.mjs';

// RunPod's management API v2 (tools/gpu-providers/runpod-v2.mjs): REST v1 is retired on 2026-11-15, GraphQL early 2027.
const image = arg('image', 'ghcr.io/jgriffith3433/hawkes-gen-playtest:latest');
const name = arg('name', 'hawkes-gen-playtest');
const gpus = arg('gpu', 'AMPERE_16,AMPERE_24');
const max = Math.max(1, Math.min(10, Number(arg('max', '2')) || 2));
const tabs = Math.max(1, Math.min(8, Number(arg('tabs', '2')) || 2));
const idle = Math.max(5, Math.min(3600, Number(arg('idle', '60')) || 60));
const key = secret('RUNPOD_API_KEY');
const token = secret('PLAYTEST_RUNPOD_TOKEN') || secret('GPU_WORKER_TOKEN');

/** RunPod's serverless price per worker hour for its GPU pools: the first pool of --gpu sets Gen's pricePerHour. */
export { POOL_PRICES, POOL_GPUS };
const pools = gpus.split(',').map((s) => s.trim()).filter(Boolean);
const first = pools[0];
/**
 * The exact GPU models the endpoint may use, in RunPod's order of preference. A pool alone isn't enough: RunPod put
 * "RTX PRO 6000 Blackwell MIG 1g.24gb" slices in AMPERE_24 (2026-10-29), and a MIG slice has CUDA but no graphics (no
 * EGL, OpenGL or Vulkan), so Chromium only had software WebGL and every playtest fell back to the CPU service. These are
 * whole cards with a display engine. v2 has no allow-list: every other type in the pools goes in gpu.excludedTypes,
 * from RunPod's catalog. `--gpu-types a,b` replaces the list.
 */
export const GRAPHICS_GPUS = ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA RTX 2000 Ada Generation', 'NVIDIA RTX A5000', 'NVIDIA L4', 'NVIDIA GeForce RTX 3090'];
const gpuTypes = arg('gpu-types', '') ? arg('gpu-types', '').split(',').map((s) => s.trim()).filter(Boolean) : GRAPHICS_GPUS;

const template = {
  name, image, serverless: true, category: 'NVIDIA', disk: 20, ports: ['8080/http'],
  env: envObject([
    ['PORT', '8080'], ['PORT_HEALTH', '8080'], ['HAWKES_TABS', String(tabs)],
    // The NVIDIA runtime mounts the graphics libraries (EGL, Vulkan) only when asked; the image asks too.
    ['NVIDIA_DRIVER_CAPABILITIES', 'all'],
    ['HAWKES_TOKEN', token],
  ]),
};
// One playtest holds its connection for minutes: an hour is the most a run takes (playtest.run's own watchdog is shorter).
const endpointBody = (templateId, gpu) => lbEndpoint({ name, templateId, gpu, max, idle, perWorker: tabs, timeoutMs: 3_600_000 });

header(`RunPod template ${name}`);
say(JSON.stringify({ ...template, env: { ...template.env, ...(token ? { HAWKES_TOKEN: redact(token) } : {}) } }, null, 2));
header(`RunPod load-balancer endpoint ${name}`);
say(JSON.stringify(endpointBody('<template id>', gpuFor(gpuTypes, { pools })), null, 2));
say(`GPU models (only these, never a MIG slice): ${gpuTypes.join(', ')}`);
say(`GPU pools ${gpus}: ${pools.map((g) => POOL_GPUS[g] ?? g).join(', ')}; about $${POOL_PRICES[first] ?? '?'}/h per worker while it runs.`);
say(`RUNPOD_API_KEY: ${redact(key)}; HAWKES_TOKEN (PLAYTEST_RUNPOD_TOKEN or GPU_WORKER_TOKEN): ${redact(token)}`);

let endpointId = null;
if (APPLY) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env (RunPod console > Settings > API Keys).'); process.exit(1); }
  const api = runpod(key);
  const catalog = await readCatalog(api);
  if (!catalog) { console.error('Could not read RunPod\'s GPU catalog (GET /v2/catalog/gpus): without it a new MIG slice in the pools would not be excluded. Nothing changed.'); process.exit(1); }
  const gpu = gpuFor(gpuTypes, { pools, catalog });
  say(`excluded in those pools: ${gpu.excludedTypes.join(', ') || 'none'}`);
  const [t, madeT] = await upsertTemplate(api, template);
  say(`\n${madeT ? 'made' : 'updated'} template ${t.id}`);
  const old = await findEndpoint(api, name);
  // templateId applies the template once (v2 keeps no link), so an update sends it again to carry the image and env over.
  const e = old ? await api.req('PATCH', `/serverless/${old.id}`, endpointBody(t.id, gpu)) : await api.req('POST', '/serverless', endpointBody(t.id, gpu));
  endpointId = e.id;
  say(`${old ? 'updated' : 'made'} endpoint ${e.id} (type ${e.type}); GPU pools ${(e.gpu?.pools ?? gpu.pools).join(', ')}`);
} else say('\n(dry run: --apply creates or updates them; that costs nothing until a playtest starts a worker)');

header('Then Gen\'s settings (POST /v1/settings, or the dashboard\'s settings JSON)');
say(JSON.stringify({
  playtest: {
    backend: 'runpod',
    runpod: { url: `https://${endpointId ?? '<endpoint id>'}.api.runpod.ai`, maxInstances: max, tabsPerInstance: tabs, encode: 'service', gpu: POOL_GPUS[first] ?? first, pricePerHour: POOL_PRICES[first] ?? 0.7, idleSeconds: idle },
  },
}, null, 2));
say('backend "runpod" tries the endpoint first and falls back to the CPU service (settings.playtest.cloudrunCpu), then the playtesters.');
say('Gen needs RUNPOD_API_KEY in its environment (tools/gen-cloudrun/deploy.mjs mounts it) and the same token as the endpoint:');
say('PLAYTEST_RUNPOD_TOKEN, else GPU_WORKER_TOKEN (already mounted). The image must be public on GHCR (docs/playtest-runpod.md).');
say('Check it: GET /v1/playtester/cloud?variant=runpod&selftest=1 (starts a worker: about a cent).');
