#!/usr/bin/env node
// The desktop playtest runner on RunPod (docs/play-native.md): the hawkes-play-native image (server/play-native/,
// built to GHCR by .github/workflows/play-native-image.yml) as a RunPod serverless LOAD-BALANCER endpoint, so Gen's
// conductor reaches the image's own server over a WebSocket at wss://<endpoint id>.api.runpod.ai/session.
// Mirrors tools/playtest-runpod/setup.mjs (the browser runner).
//
//   node tools/play-native/setup.mjs                      print the plan (changes nothing)
//   node tools/play-native/setup.mjs --check              read RunPod (GETs only) and say what --apply would change
//   node tools/play-native/setup.mjs --apply              create or update the template and the endpoint
//   options: --image ghcr.io/jgriffith3433/hawkes-gen-gpu:play-native-5-ebc6186  --name hawkes-play-native
//            --gpu AMPERE_16  --gpu-types "NVIDIA RTX A4000,..."  --max 2  --idle 60  --max-seconds 3600
//            --recreate   delete the endpoint of this name first and make a new one (a new GPU list needs one)
//
// A new endpoint gets its GPU models (pools and excluded types) in the request that makes it (API v2), so RunPod never
// places a standby worker on a GPU outside the list: with v1 and GraphQL they came in two steps, and the first endpoint
// (xkhpihvfrfsx6g, 2026-10-29) got an RTX PRO 6000 MIG slice in between. A worker stays on the machine it was first
// placed on, so an endpoint whose GPU list changed needs --recreate.
//
// Creating or updating a template or an endpoint costs nothing: RunPod bills only while a worker runs (from its start
// to `--idle` seconds after the last connection). Workers min stays 0. The script never starts a worker.
//
// Secrets (hawkesgen/.env, never printed): RUNPOD_API_KEY, and the token the image checks as HAWKES_TOKEN:
// PLAY_NATIVE_TOKEN, else PLAYTEST_RUNPOD_TOKEN, else GPU_WORKER_TOKEN, else none (then only RunPod's key guards it).
import { APPLY, arg, secret, say, header, redact } from '../gpu-providers/lib.mjs';
import { runpod, gpuFor, envObject, lbEndpoint, upsertTemplate, findEndpoint, readCatalog, checkPlan, POOL_PRICES, POOL_GPUS } from '../gpu-providers/runpod-v2.mjs';

// RunPod's management API v2 (tools/gpu-providers/runpod-v2.mjs): REST v1 is retired on 2026-11-15, GraphQL early 2027.
const flag = (n) => process.argv.includes(`--${n}`);

// Only the browser runner's four: with A5000, L4 and 3090 in the list as well (the 24 GB pool), two endpoints in a row
// got an RTX PRO 6000 Blackwell MIG slice (2026-10-29), which has no graphics.
const GRAPHICS_GPUS = ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA RTX 2000 Ada Generation'];

// The image the endpoint runs now: the public hawkes-gen-gpu copy, pinned. hawkes-play-native:latest is in a package
// that may not be public, so RunPod might not pull it. Move this to the new tag each time a new image is proven.
const DEFAULT_IMAGE = 'ghcr.io/jgriffith3433/hawkes-gen-gpu:play-native-5-ebc6186';
const image = arg('image', DEFAULT_IMAGE);
const name = arg('name', 'hawkes-play-native');
const gpus = arg('gpu', 'AMPERE_16');
const max = Math.max(1, Math.min(10, Number(arg('max', '2')) || 2));
const idle = Math.max(5, Math.min(3600, Number(arg('idle', '60')) || 60));
const maxSeconds = Math.max(60, Math.min(7200, Number(arg('max-seconds', '3600')) || 3600));
const key = secret('RUNPOD_API_KEY');
const token = secret('PLAY_NATIVE_TOKEN') || secret('PLAYTEST_RUNPOD_TOKEN') || secret('GPU_WORKER_TOKEN');
const pools = gpus.split(',').map((s) => s.trim()).filter(Boolean);
const first = pools[0];
// Whole cards with a display engine only: a MIG slice has CUDA but no graphics (tools/playtest-runpod/setup.mjs).
const gpuTypes = arg('gpu-types', '') ? arg('gpu-types', '').split(',').map((s) => s.trim()).filter(Boolean) : GRAPHICS_GPUS;

const template = {
  // 40 GB: Proton (~1.3 GB), the warm prefix (~0.5 GB), one run's unpacked build, and the build cache (HAWKES_BUILD_CACHE_GB).
  name, image, serverless: true, category: 'NVIDIA', disk: 40, ports: ['8080/http'],
  env: envObject([
    ['PORT', '8080'], ['PORT_HEALTH', '8080'], ['HAWKES_MAX_SECONDS', String(maxSeconds)], ['HAWKES_BUILD_CACHE_GB', '15'],
    // The NVIDIA runtime mounts the graphics and display libraries only when asked; the image asks too.
    ['NVIDIA_DRIVER_CAPABILITIES', 'all'],
    ['HAWKES_TOKEN', token],
  ]),
};
// One run per worker (the display, the input and the CPU are the run's): the scaler adds a worker per session.
const endpointBody = (templateId, gpu) => lbEndpoint({ name, templateId, gpu, max, idle, perWorker: 1, timeoutMs: (maxSeconds + 900) * 1000 });

header(`RunPod template ${name}`);
say(JSON.stringify({ ...template, env: { ...template.env, ...(token ? { HAWKES_TOKEN: redact(token) } : {}) } }, null, 2));
header(`RunPod load-balancer endpoint ${name}`);
say(JSON.stringify(endpointBody('<template id>', gpuFor(gpuTypes, { pools })), null, 2));
say(`GPU models (only these, never a MIG slice): ${gpuTypes.join(', ')}`);
say(`GPU pools ${gpus}: ${pools.map((g) => POOL_GPUS[g] ?? g).join(', ')}; about $${POOL_PRICES[first] ?? '?'}/h per worker while it runs.`);
say(`RUNPOD_API_KEY: ${redact(key)}; HAWKES_TOKEN (PLAY_NATIVE_TOKEN, PLAYTEST_RUNPOD_TOKEN or GPU_WORKER_TOKEN): ${redact(token)}`);

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
  let old = await findEndpoint(api, name);
  if (old && flag('recreate')) {
    // DELETE ends the endpoint's workers and cancels its jobs; scaling to 0 first lets nothing new start meanwhile.
    await api.req('PATCH', `/serverless/${old.id}`, { workers: { min: 0, max: 0 } });
    await api.req('DELETE', `/serverless/${old.id}`);
    say(`deleted endpoint ${old.id}`);
    old = null;
  }
  // templateId applies the template once (v2 keeps no link), so an update sends it again to carry the image and env over.
  const e = old ? await api.req('PATCH', `/serverless/${old.id}`, endpointBody(t.id, gpu)) : await api.req('POST', '/serverless', endpointBody(t.id, gpu));
  endpointId = e.id;
  say(`${old ? 'updated' : 'made'} endpoint ${e.id} (type ${e.type}); GPU pools ${(e.gpu?.pools ?? gpu.pools).join(', ')}, open to ${max} workers`);
  if (old) say('An endpoint that existed keeps the workers it placed: --recreate if its GPU list changed.');
} else if (process.argv.includes('--check')) {
  // Read-only (GETs): what --apply would change.
  if (!key) { console.error('RUNPOD_API_KEY is not set.'); process.exit(1); }
  header('Check against RunPod API v2 (reads only, changes nothing)');
  try { for (const line of await checkPlan(runpod(key), { template, name, gpuTypes, pools, endpointBody })) say(line); }
  catch (e) { console.error(e.message); process.exit(1); }
} else say('\n(dry run: --check reads RunPod without changing it; --apply creates or updates them, which costs nothing until a playtest starts a worker)');

const url = `https://${endpointId ?? '<endpoint id>'}.api.runpod.ai`;
header('Then Gen\'s runner list (platform-plan 3.3; Gen\'s router reads it once it exists)');
say(JSON.stringify({
  playtest: {
    // Gen's router's shape (src/config.ts PlaytestRunner): a native runner, the image's token as X-Hawkes-Token and
    // RunPod's key for its gateway (Authorization: Bearer).
    runners: [{
      id: 'runpod-native', provider: 'native', url, targets: ['linux', 'proton'], lanes: ['studio', 'customer'], maxConcurrent: max,
      pricePerSecond: Math.round(((POOL_PRICES[first] ?? 0.7) / 3600) * 1e6) / 1e6,
      tokenEnv: secret('PLAY_NATIVE_TOKEN') ? 'PLAY_NATIVE_TOKEN' : secret('PLAYTEST_RUNPOD_TOKEN') ? 'PLAYTEST_RUNPOD_TOKEN' : secret('GPU_WORKER_TOKEN') ? 'GPU_WORKER_TOKEN' : null,
      gatewayKeyEnv: 'RUNPOD_API_KEY', enabled: true,
    }],
  },
}, null, 2));
say('Gen connects to wss://<endpoint>/session with Authorization: Bearer RUNPOD_API_KEY (the gateway) and X-Hawkes-Token.');
say('The image must be public on GHCR (docs/play-native.md, "Deploy").');
say(`Check a worker (starts one: about a cent): curl -H "Authorization: Bearer $RUNPOD_API_KEY" -H "X-Hawkes-Token: ..." ${url}/selftest`);
