#!/usr/bin/env node
// The desktop playtest runner on RunPod (docs/play-native.md): the hawkes-play-native image (server/play-native/,
// built to GHCR by .github/workflows/play-native-image.yml) as a RunPod serverless LOAD-BALANCER endpoint, so Gen's
// conductor reaches the image's own server over a WebSocket at wss://<endpoint id>.api.runpod.ai/session.
// Mirrors tools/playtest-runpod/setup.mjs (the browser runner).
//
//   node tools/play-native/setup.mjs                      print the plan (changes nothing)
//   node tools/play-native/setup.mjs --apply              create or update the template and the endpoint
//   options: --image ghcr.io/jgriffith3433/hawkes-play-native:latest  --name hawkes-play-native
//            --gpu AMPERE_16,AMPERE_24  --gpu-types "NVIDIA RTX A4000,..."  --max 2  --idle 60  --max-seconds 3600
//
// Creating or updating a template or an endpoint costs nothing: RunPod bills only while a worker runs (from its start
// to `--idle` seconds after the last connection). Workers min stays 0. The script never starts a worker.
//
// Secrets (hawkesgen/.env, never printed): RUNPOD_API_KEY, and the token the image checks as HAWKES_TOKEN:
// PLAY_NATIVE_TOKEN, else PLAYTEST_RUNPOD_TOKEN, else GPU_WORKER_TOKEN, else none (then only RunPod's key guards it).
import { APPLY, arg, secret, say, header, redact } from '../gpu-providers/lib.mjs';

// Copied from tools/playtest-runpod/setup.mjs (importing it would run that script). RunPod serverless flex prices per
// worker hour, 2026-10-29.
const POOL_PRICES = { AMPERE_16: 0.58, AMPERE_24: 0.69, ADA_24: 1.10, AMPERE_48: 1.22, ADA_48_PRO: 1.75 };
const POOL_GPUS = { AMPERE_16: 'RTX A4000 class (16 GB)', AMPERE_24: 'L4 / A5000 class (24 GB)', ADA_24: 'RTX 4090 (24 GB)', AMPERE_48: 'A6000 / A40 (48 GB)', ADA_48_PRO: 'L40S class (48 GB)' };
const GRAPHICS_GPUS = ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA RTX 2000 Ada Generation', 'NVIDIA RTX A5000', 'NVIDIA L4', 'NVIDIA GeForce RTX 3090'];

const GQL = 'https://api.runpod.io/graphql';
const image = arg('image', 'ghcr.io/jgriffith3433/hawkes-play-native:latest');
const name = arg('name', 'hawkes-play-native');
const gpus = arg('gpu', 'AMPERE_16,AMPERE_24');
const max = Math.max(1, Math.min(10, Number(arg('max', '2')) || 2));
const idle = Math.max(5, Math.min(3600, Number(arg('idle', '60')) || 60));
const maxSeconds = Math.max(60, Math.min(7200, Number(arg('max-seconds', '3600')) || 3600));
const key = secret('RUNPOD_API_KEY');
const token = secret('PLAY_NATIVE_TOKEN') || secret('PLAYTEST_RUNPOD_TOKEN') || secret('GPU_WORKER_TOKEN');
const first = gpus.split(',')[0].trim();
// Whole cards with a display engine only: a MIG slice has CUDA but no graphics (tools/playtest-runpod/setup.mjs).
const gpuTypes = arg('gpu-types', '') ? arg('gpu-types', '').split(',').map((s) => s.trim()).filter(Boolean) : GRAPHICS_GPUS;

const template = {
  // 40 GB: Proton (~1.3 GB), the warm prefix (~0.5 GB), one run's unpacked build, and the build cache (HAWKES_BUILD_CACHE_GB).
  name, imageName: image, isServerless: true, containerDiskInGb: 40, volumeInGb: 0, ports: '8080/http', dockerArgs: '', readme: '',
  env: [
    ['PORT', '8080'], ['PORT_HEALTH', '8080'], ['HAWKES_MAX_SECONDS', String(maxSeconds)], ['HAWKES_BUILD_CACHE_GB', '15'],
    // The NVIDIA runtime mounts the graphics and display libraries only when asked; the image asks too.
    ['NVIDIA_DRIVER_CAPABILITIES', 'all'],
    ...(token ? [['HAWKES_TOKEN', token]] : []),
  ].map(([k, value]) => ({ key: k, value })),
};
const endpoint = {
  // One run per worker (the display, the input and the CPU are the run's): the scaler adds a worker per session.
  name, gpuIds: gpus, workersMin: 0, workersMax: max, idleTimeout: idle, scalerType: 'REQUEST_COUNT', scalerValue: 1, type: 'LB',
  executionTimeoutMs: (maxSeconds + 900) * 1000,
};

async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`RunPod: ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 400)}`);
  return j.data;
}

header(`RunPod template ${name}`);
say(JSON.stringify({ ...template, env: template.env.map((e) => (e.key === 'HAWKES_TOKEN' ? { ...e, value: redact(e.value) } : e)) }, null, 2));
header(`RunPod load-balancer endpoint ${name}`);
say(JSON.stringify(endpoint, null, 2));
say(`GPU models (only these, never a MIG slice): ${gpuTypes.join(', ')}`);
say(`GPU pools ${gpus}: ${gpus.split(',').map((g) => POOL_GPUS[g.trim()] ?? g).join(', ')}; about $${POOL_PRICES[first] ?? '?'}/h per worker while it runs.`);
say(`RUNPOD_API_KEY: ${redact(key)}; HAWKES_TOKEN (PLAY_NATIVE_TOKEN, PLAYTEST_RUNPOD_TOKEN or GPU_WORKER_TOKEN): ${redact(token)}`);

let endpointId = null;
if (APPLY) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env (RunPod console > Settings > API Keys).'); process.exit(1); }
  const mine = (await gql('{ myself { podTemplates { id name } endpoints { id name templateId } } }')).myself;
  const oldT = mine.podTemplates.find((t) => t.name === name);
  const t = (await gql('mutation($i: SaveTemplateInput) { saveTemplate(input: $i) { id } }', { i: { ...(oldT ? { id: oldT.id } : {}), ...template } })).saveTemplate;
  say(`\n${oldT ? 'updated' : 'made'} template ${t.id}`);
  const oldE = mine.endpoints.find((e) => e.name === name || e.name === `${name} -fb`);
  const e = (await gql('mutation($i: EndpointInput!) { saveEndpoint(input: $i) { id type } }', { i: { ...(oldE ? { id: oldE.id } : {}), ...endpoint, templateId: t.id } })).saveEndpoint;
  endpointId = e.id;
  say(`${oldE ? 'updated' : 'made'} endpoint ${e.id} (type ${e.type})`);
  const r = await fetch(`https://rest.runpod.io/v1/endpoints/${e.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ gpuTypeIds: gpuTypes, gpuCount: 1 }) });
  if (!r.ok) throw new Error(`RunPod REST: ${r.status} ${(await r.text()).slice(0, 400)}`);
  say(`endpoint ${e.id} GPU models: ${((await r.json()).gpuTypeIds ?? gpuTypes).join(', ')}`);
} else say('\n(dry run: --apply creates or updates them; that costs nothing until a playtest starts a worker)');

const url = `https://${endpointId ?? '<endpoint id>'}.api.runpod.ai`;
header('Then Gen\'s runner list (platform-plan 3.3; Gen\'s router reads it once it exists)');
say(JSON.stringify({
  playtest: {
    runners: [{ id: 'runpod-native', provider: 'runpod', url, targets: ['linux', 'proton'], maxConcurrent: max, pricePerSecond: Math.round(((POOL_PRICES[first] ?? 0.7) / 3600) * 1e6) / 1e6, gpu: POOL_GPUS[first] ?? first }],
  },
}, null, 2));
say('Gen connects to wss://<endpoint>/session with Authorization: Bearer RUNPOD_API_KEY (the gateway) and X-Hawkes-Token.');
say('The image must be public on GHCR (docs/play-native.md, "Deploy").');
say(`Check a worker (starts one: about a cent): curl -H "Authorization: Bearer $RUNPOD_API_KEY" -H "X-Hawkes-Token: ..." ${url}/selftest`);
