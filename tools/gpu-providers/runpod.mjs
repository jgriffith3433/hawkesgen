// RunPod Serverless for Gen's GPU jobs (docs/gpu-providers.md, "RunPod"): the worker image as a load-balancing endpoint,
// so Gen's POST /run reaches the worker's own HTTP server (https://<endpoint id>.api.runpod.ai/run), no queue in between.
//
//   node tools/gpu-providers/runpod.mjs --image ghcr.io/<owner>/hawkes-gen-gpu:<tag>            print the plan
//   node tools/gpu-providers/runpod.mjs --image ... --apply                                      create the template
//   node tools/gpu-providers/runpod.mjs --image ... --update <endpoint id> [--apply]           a new image on a running endpoint:
//     PATCH /v2/serverless/<id> {image}: everything else (env, worker token, disk, ports) stays; RunPod makes a new
//     release and rolls it out as workers cycle. --recycle lists the workers still on the old release (API v2 has no
//     call to end one worker; set the endpoint's max workers to 0 and back in the console to cycle them at once)
//   --kind unity-render: the render farm endpoint (tools/gpu-providers/runpod-unity.mjs)
//   options: --name gen-gpu  --gpu "NVIDIA L40S"  --max 2  --disk 120  --registry-auth <id>  --endpoint <id>
//
// What it makes (--apply, with RUNPOD_API_KEY in hawkesgen/.env; costs nothing until a worker runs):
//   a serverless template: the image, port 8080/http, PORT and PORT_HEALTH 8080, STORAGE=broker (files through Gen),
//   MODEL_LOAD=none, WORKER_TOKEN (GPU_WORKER_TOKEN from .env, when set).
// The endpoint itself is made in RunPod's console (the steps are printed). RunPod's API v2 can now make a load-balancer
// endpoint too (type LOAD_BALANCER: tools/playtest-runpod/setup.mjs does), so this could follow it later.
// All calls go to RunPod's API v2 (runpod-v2.mjs): REST v1 is retired on 2026-11-15 and GraphQL early 2027.
// With --endpoint <id> it prints the settings entry for that endpoint.
import { APPLY, arg, secret, workerImage, say, header, redact, printEntry, print3dEntry, KIND, IMAGE_3D } from './lib.mjs';
import { runpod, upsertTemplate, findEndpoint, lbEndpoint, readCatalog, gpuFor, IDLE_SECONDS, idleWorkers, wastesIdle } from './runpod-v2.mjs';

// --kind unity-render: the render farm's endpoint (runpod-unity.mjs, docs/unity-render.md).
if (KIND === 'unity-render') { await import('./runpod-unity.mjs'); process.exit(0); }

// The idle rule (runpod-v2.mjs IDLE_SECONDS) on every endpoint of the account: min workers 0, idle timeout at most
// IDLE_SECONDS; max workers stay. Prints what it would change; changes it with --apply. --idle runs only this; --update
// runs it first too, so every image update (ops-runpod-image.yml) also puts the whole account back on the rule, including
// an endpoint someone set up or changed in the console.
async function idleSweep(api) {
  const eps = await api.list('/serverless', 'endpoints');
  let n = 0;
  for (const ep of eps) {
    const w = ep.workers ?? {};
    if (!wastesIdle(ep)) { say(`${ep.name} (${ep.id}): min ${w.min ?? 0}, idle ${w.idleTimeout ?? '?'} s: fine`); continue; }
    n++;
    const workers = idleWorkers(Number(w.max ?? 0));
    say(`${ep.name} (${ep.id}): min ${w.min ?? 0}, idle ${w.idleTimeout ?? '?'} s -> min 0, idle ${workers.idleTimeout} s (max ${workers.max})`);
    if (APPLY) await api.req('PATCH', `/serverless/${ep.id}`, { workers });
  }
  say(n ? (APPLY ? `idle rule: changed ${n} endpoint(s)` : `(dry run: --apply changes ${n} endpoint(s))`) : 'idle rule: every endpoint already keeps no warm or long-idle workers');
}
if (process.argv.includes('--idle')) {
  const idleKey = secret('RUNPOD_API_KEY');
  if (!idleKey) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env'); process.exit(1); }
  await idleSweep(runpod(idleKey));
  process.exit(0);
}

// --kind 3d: the 3D worker (server/gpu3d): Blender, the rig, motion and mocap venvs; weights on a network volume.
const is3d = KIND === '3d';
const name = arg('name', is3d ? 'hawkes-gen-3d' : 'hawkes-gen-gpu');
const gpu = arg('gpu', 'NVIDIA L40S');
const max = Number(arg('max', '2'));
const disk = Number(arg('disk', is3d ? '150' : '120'));
const registryAuth = arg('registry-auth');
const endpoint = arg('endpoint');
const image = is3d && !arg('image') ? IMAGE_3D : workerImage();
const key = secret('RUNPOD_API_KEY');
const workerToken = secret('GPU_WORKER_TOKEN');

// RunPod's price for its 48 GB tier (L40S, L40, 6000 Ada), runpod.io/pricing on 2026-10-28.
const PRICES = { 'NVIDIA L40S': 1.75, 'NVIDIA L40': 1.75, 'NVIDIA RTX 6000 Ada Generation': 1.75, 'NVIDIA A40': 1.22, 'NVIDIA RTX A6000': 1.22, 'NVIDIA A100 80GB PCIe': 2.72, 'NVIDIA H100 80GB HBM3': 4.79, 'NVIDIA L4': 0.69 };

// --update: a new image on an existing endpoint. With API v2 a template is applied to an endpoint once and keeps no link,
// so the image goes to the endpoint itself; RunPod rolls the new release out as workers cycle.
const update = arg('update');
if (update) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env'); process.exit(1); }
  const api = runpod(key);
  header('Idle rule, every endpoint');
  await idleSweep(api);
  const ep = await api.req('GET', `/serverless/${update}`);
  header(`Endpoint ${ep.name} (${ep.id})`);
  say(`image: ${ep.image ?? '(from its template)'}
   ->  ${image}`);
  const recycle = async () => {
    if (!process.argv.includes('--recycle')) return;
    const { workers = [] } = await api.req('GET', `/serverless/${update}/workers`);
    const old = workers.filter((w) => w.isStale || (w.image && w.image !== image));
    if (!old.length) { say('No workers on an older image.'); return; }
    for (const w of old) say(`still on the old release: worker ${w.id} (${w.status}, ${w.image ?? 'image not reported'})`);
    say('API v2 has no call to end one worker: they are replaced as they cycle (or set max workers to 0 and back in the console).');
  };
  if (ep.image === image) { say('Already on this image.'); await recycle(); process.exit(0); }
  if (!APPLY) { say('(dry run: --apply saves it)'); await recycle(); process.exit(0); }
  // The idle rule comes along (runpod-v2.mjs IDLE_SECONDS): an endpoint made in the console kept warm or long-idle workers.
  const saved = await api.req('PATCH', `/serverless/${update}`, { image, ...(wastesIdle(ep) ? { workers: idleWorkers(Number(ep.workers?.max ?? 0)) } : {}) });
  say(`saved: endpoint ${saved.id ?? update} now runs ${saved.image ?? image}; new workers start on it`);
  await recycle();
  process.exit(0);
}

const template = {
  name, image, serverless: true, disk, category: 'NVIDIA', ports: ['8080/http'],
  env: { PORT: '8080', PORT_HEALTH: '8080', STORAGE: 'broker', MODEL_LOAD: 'none', HAWKES_SERVICE: name, ...(workerToken ? { WORKER_TOKEN: workerToken } : {}) },
  ...(registryAuth ? { registry: registryAuth } : {}),
};

header(`RunPod template ${name}`);
say(JSON.stringify({ ...template, env: { ...template.env, ...(workerToken ? { WORKER_TOKEN: redact(workerToken) } : {}) } }, null, 2));
say(`RUNPOD_API_KEY: ${redact(key)}; GPU_WORKER_TOKEN: ${redact(workerToken)} (optional: the worker then refuses requests without it)`);

let templateId = null;
// --kind 3d --apply makes the template and the load-balancer endpoint through API v2 (like tools/playtest-runpod/setup.mjs),
// on the 48 GB pools (L40S class, then A6000/A40): HY-Motion wants 26 GB, SkinTokens 14 GB. No volume unless --volume <id>.
if (APPLY && is3d) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env'); process.exit(1); }
  if (!workerToken) { console.error('GPU_WORKER_TOKEN is not in hawkesgen/.env: the 3D worker refuses scripts without it.'); process.exit(1); }
  const api = runpod(key);
  const t3 = { ...template, env: { ...template.env, HEALTH_CHECK_PATH: '/ping' } };
  const [t, madeT] = await upsertTemplate(api, t3);
  say(`${madeT ? 'made' : 'updated'} template ${t.id}`);
  const volume = arg('volume');
  // Whole 48 GB cards only. The pools also hold RTX PRO 6000 Blackwell MIG slices (the first 3D worker landed on one):
  // a slice is not a whole card, and HY-Motion's PyTorch 2.5.1 (cu124) has no Blackwell kernels. Every other type in
  // the pools is excluded, read from RunPod's catalog so a type added since is excluded too.
  const catalog = await readCatalog(api);
  if (!catalog) { console.error('Could not read RunPod\'s GPU catalog: without it a new MIG slice would not be excluded. Nothing changed.'); process.exit(1); }
  const gpu3d = gpuFor(['NVIDIA L40S', 'NVIDIA L40', 'NVIDIA RTX 6000 Ada Generation', 'NVIDIA RTX A6000', 'NVIDIA A40'], { pools: ['ADA_48_PRO', 'AMPERE_48'], catalog });
  say(`excluded in those pools: ${gpu3d.excludedTypes.join(', ') || 'none'}`);
  const body = {
    ...lbEndpoint({ name, templateId: t.id, gpu: gpu3d, max, idle: IDLE_SECONDS, perWorker: 1, timeoutMs: 3_600_000 }),
    ...(volume ? { networkVolumes: [volume] } : {}),
  };
  const old = await findEndpoint(api, name);
  // An update leaves the template out (RunPod refuses a PATCH that names one again: 422).
  const { templateId: _t, ...update } = body;
  const e = old ? await api.req('PATCH', `/serverless/${old.id}`, update) : await api.req('POST', '/serverless', body);
  say(`${old ? 'updated' : 'made'} endpoint ${e.id} (${e.type}), pools ${(e.gpu?.pools ?? []).join(', ')}`);
  print3dEntry({ id: 'runpod-3d', provider: 'runpod', url: `https://${e.id}.api.runpod.ai`, gpu: 'L40S', pricePerHour: PRICES['NVIDIA L40S'], maxConcurrent: max, graphLimitSeconds: 1800, enabled: true });
  process.exit(0);
}
if (APPLY) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env (RunPod console > Settings > API Keys).'); process.exit(1); }
  try { templateId = (await runpod(key).req('POST', '/templates', template)).id; }
  catch (e) { console.error(`RunPod refused the template: ${e.message}`); process.exit(1); }
  say(`made template ${templateId}`);
} else say('(dry run: --apply creates it)');

header('Then the endpoint, in the RunPod console (Serverless > New Endpoint)');
say(`1. Import from template: ${templateId ?? name}. Endpoint type: Load balancer.`);
say(`2. GPU: ${gpu} (48 GB, like the fleet's L40S). Max workers ${max}, active (min) workers 0, idle timeout ${IDLE_SECONDS} s, FlashBoot on.`);
if (is3d) {
  say('3. Health check path: /ping (the 3D worker answers 200 at once: it has no ComfyUI to wait for). Port 8080 exposed. Idle timeout ${IDLE_SECONDS} s: Gen keeps a request open for the whole job and asks again when RunPod ends one, so a long job is never cut by it.');
  say('4. A network volume (about 150 GB, same region as the GPUs) attached to the endpoint: RunPod mounts it at /runpod-volume and the worker keeps every 3D weight there (rig ~5 GB, Kimodo + Llama 3 8B ~20 GB, HY-Motion ~20 GB, GEM-X ~4 GB), so only the first job ever downloads them.');
  if (!workerToken) say('   GPU_WORKER_TOKEN is not set in hawkesgen/.env: set it first. The 3D worker refuses hawkes_job scripts without a worker token.');
} else {
  say('3. Health check path: /ping (the worker answers 200 when ComfyUI is up, 204 while it starts). Port 8080 exposed.');
  say('4. Optional: a network volume mounted at /mnt/models with the models (then models load from it, not through Gen).');
}
say('5. Copy the endpoint id; run this again with --endpoint <id> for Gen\'s settings entry.');

if (endpoint && is3d) {
  print3dEntry({ id: 'runpod-3d', provider: 'runpod', url: `https://${endpoint}.api.runpod.ai`, gpu: gpu.replace(/^NVIDIA /, ''), pricePerHour: PRICES[gpu] ?? 0, maxConcurrent: max, graphLimitSeconds: 1800, enabled: true });
} else if (endpoint) {
  printEntry({ id: 'runpod', provider: 'runpod', url: `https://${endpoint}.api.runpod.ai`, families: ['*'], gpu: gpu.replace(/^NVIDIA /, ''), pricePerHour: PRICES[gpu] ?? 0, maxConcurrent: max, graphLimitSeconds: 300, enabled: true });
}
say('\nGen also needs RUNPOD_API_KEY in its environment (tools/gen-cloudrun/deploy.mjs mounts it from Secret Manager) and HAWKESGEN_PUBLIC_URL.');
