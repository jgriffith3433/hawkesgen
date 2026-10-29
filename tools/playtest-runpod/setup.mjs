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

const GQL = 'https://api.runpod.io/graphql';
const image = arg('image', 'ghcr.io/jgriffith3433/hawkes-gen-playtest:latest');
const name = arg('name', 'hawkes-gen-playtest');
const gpus = arg('gpu', 'AMPERE_16,AMPERE_24');
const max = Math.max(1, Math.min(10, Number(arg('max', '2')) || 2));
const tabs = Math.max(1, Math.min(8, Number(arg('tabs', '2')) || 2));
const idle = Math.max(5, Math.min(3600, Number(arg('idle', '60')) || 60));
const key = secret('RUNPOD_API_KEY');
const token = secret('PLAYTEST_RUNPOD_TOKEN') || secret('GPU_WORKER_TOKEN');

/**
 * RunPod's serverless price per worker hour for its GPU pools (flex workers, runpod.io/serverless pricing, 2026-10-29):
 * the first pool of --gpu sets Gen's pricePerHour (a fallback pool may cost a little more).
 */
export const POOL_PRICES = { AMPERE_16: 0.58, AMPERE_24: 0.69, ADA_24: 1.10, AMPERE_48: 1.22, ADA_48_PRO: 1.75 };
export const POOL_GPUS = { AMPERE_16: 'RTX A4000 class (16 GB)', AMPERE_24: 'L4 / A5000 class (24 GB)', ADA_24: 'RTX 4090 (24 GB)', AMPERE_48: 'A6000 / A40 (48 GB)', ADA_48_PRO: 'L40S class (48 GB)' };
const first = gpus.split(',')[0].trim();
/**
 * The exact GPU models the endpoint may use (RunPod REST `gpuTypeIds`), in RunPod's order of preference. A pool alone
 * isn't enough: RunPod put "RTX PRO 6000 Blackwell MIG 1g.24gb" slices in AMPERE_24 (2026-10-29), and a MIG slice has
 * CUDA but no graphics (no EGL, OpenGL or Vulkan), so Chromium only had software WebGL and every playtest fell back to
 * the CPU service. These are whole cards with a display engine. `--gpu-types a,b` replaces the list.
 */
export const GRAPHICS_GPUS = ['NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA RTX 2000 Ada Generation', 'NVIDIA RTX A5000', 'NVIDIA L4', 'NVIDIA GeForce RTX 3090'];
const gpuTypes = arg('gpu-types', '') ? arg('gpu-types', '').split(',').map((s) => s.trim()).filter(Boolean) : GRAPHICS_GPUS;

const template = {
  name, imageName: image, isServerless: true, containerDiskInGb: 20, volumeInGb: 0, ports: '8080/http', dockerArgs: '', readme: '',
  env: [
    ['PORT', '8080'], ['PORT_HEALTH', '8080'], ['HAWKES_TABS', String(tabs)],
    // The NVIDIA runtime mounts the graphics libraries (EGL, Vulkan) only when asked; the image asks too.
    ['NVIDIA_DRIVER_CAPABILITIES', 'all'],
    ...(token ? [['HAWKES_TOKEN', token]] : []),
  ].map(([k, value]) => ({ key: k, value })),
};
const endpoint = {
  name, gpuIds: gpus, workersMin: 0, workersMax: max, idleTimeout: idle, scalerType: 'REQUEST_COUNT', scalerValue: tabs, type: 'LB',
  // One playtest holds its connection for minutes: an hour is the most a run takes (playtest.run's own watchdog is shorter).
  executionTimeoutMs: 3_600_000,
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
say(`GPU pools ${gpus}:${gpus.split(',').map((g) => POOL_GPUS[g.trim()] ?? g).join(', ')}; about $${POOL_PRICES[first] ?? '?'}/h per worker while it runs.`);
say(`RUNPOD_API_KEY: ${redact(key)}; HAWKES_TOKEN (PLAYTEST_RUNPOD_TOKEN or GPU_WORKER_TOKEN): ${redact(token)}`);

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
  // GraphQL's saveEndpoint takes pools only; the exact models go through the REST API.
  const r = await fetch(`https://rest.runpod.io/v1/endpoints/${e.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ gpuTypeIds: gpuTypes, gpuCount: 1 }) });
  if (!r.ok) throw new Error(`RunPod REST: ${r.status} ${(await r.text()).slice(0, 400)}`);
  say(`endpoint ${e.id} GPU models: ${((await r.json()).gpuTypeIds ?? gpuTypes).join(', ')}`);
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
