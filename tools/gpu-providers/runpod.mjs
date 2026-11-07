// RunPod Serverless for Gen's GPU jobs (docs/gpu-providers.md, "RunPod"): the worker image as a load-balancing endpoint,
// so Gen's POST /run reaches the worker's own HTTP server (https://<endpoint id>.api.runpod.ai/run), no queue in between.
//
//   node tools/gpu-providers/runpod.mjs --image ghcr.io/<owner>/hawkes-gen-gpu:<tag>            print the plan
//   node tools/gpu-providers/runpod.mjs --image ... --apply                                      create the template
//   node tools/gpu-providers/runpod.mjs --image ... --update <endpoint id> [--apply]           a new image on a running endpoint:
//     PATCH /v2/serverless/<id> {image}: everything else (env, worker token, disk, ports) stays; RunPod makes a new
//     release and rolls it out as workers cycle. --recycle lists the workers still on the old release (API v2 has no
//     call to end one worker; set the endpoint's max workers to 0 and back in the console to cycle them at once)
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
import { runpod } from './runpod-v2.mjs';

// --kind 3d: the 3D worker (server/gpu3d): Blender, the rig, motion and mocap venvs; weights on a network volume.
const is3d = KIND === '3d';
const name = arg('name', is3d ? 'hawkes-gen-3d' : 'hawkes-gen-gpu');
const gpu = arg('gpu', 'NVIDIA L40S');
const max = Number(arg('max', '2'));
const disk = Number(arg('disk', is3d ? '80' : '120'));
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
  const saved = await api.req('PATCH', `/serverless/${update}`, { image });
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
if (APPLY) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env (RunPod console > Settings > API Keys).'); process.exit(1); }
  try { templateId = (await runpod(key).req('POST', '/templates', template)).id; }
  catch (e) { console.error(`RunPod refused the template: ${e.message}`); process.exit(1); }
  say(`made template ${templateId}`);
} else say('(dry run: --apply creates it)');

header('Then the endpoint, in the RunPod console (Serverless > New Endpoint)');
say(`1. Import from template: ${templateId ?? name}. Endpoint type: Load balancer.`);
say(`2. GPU: ${gpu} (48 GB, like the fleet's L40S). Max workers ${max}, active (min) workers 0, idle timeout 600 s, FlashBoot on.`);
if (is3d) {
  say('3. Health check path: /ping (the 3D worker answers 200 at once: it has no ComfyUI to wait for). Port 8080 exposed. Idle timeout 900 s: a long job keeps going after its request ends (Gen follows its heartbeat).');
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
