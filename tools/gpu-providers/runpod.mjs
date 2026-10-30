// RunPod Serverless for Gen's GPU jobs (docs/gpu-providers.md, "RunPod"): the worker image as a load-balancing endpoint,
// so Gen's POST /run reaches the worker's own HTTP server (https://<endpoint id>.api.runpod.ai/run), no queue in between.
//
//   node tools/gpu-providers/runpod.mjs --image ghcr.io/<owner>/hawkes-gen-gpu:<tag>            print the plan
//   node tools/gpu-providers/runpod.mjs --image ... --apply                                      create the template
//   node tools/gpu-providers/runpod.mjs --image ... --update <endpoint id> [--apply]           a new image on a running endpoint:
//     its own template keeps everything (env, worker token, disk, ports) and takes the image; new workers start on it.
//     Add --recycle to end the workers still on an older image (RunPod keeps reusing them on warm starts otherwise;
//     a job running on one is cut off and retried by Gen)
//   options: --name gen-gpu  --gpu "NVIDIA L40S"  --max 2  --disk 120  --registry-auth <id>  --endpoint <id>
//
// What it makes (--apply, with RUNPOD_API_KEY in hawkesgen/.env; costs nothing until a worker runs):
//   a serverless template: the image, port 8080/http, PORT and PORT_HEALTH 8080, STORAGE=broker (files through Gen),
//   MODEL_LOAD=none, WORKER_TOKEN (GPU_WORKER_TOKEN from .env, when set).
// The endpoint itself is made in RunPod's console: its REST API (POST /v1/endpoints) has no field for the
// load-balancing type (checked 2026-10-28), and a queue endpoint can't speak Gen's protocol. The script prints the steps.
// With --endpoint <id> it prints the settings entry for that endpoint.
import { APPLY, arg, secret, workerImage, say, header, redact, printEntry } from './lib.mjs';

const API = 'https://rest.runpod.io/v1';
const name = arg('name', 'hawkes-gen-gpu');
const gpu = arg('gpu', 'NVIDIA L40S');
const max = Number(arg('max', '2'));
const disk = Number(arg('disk', '120'));
const registryAuth = arg('registry-auth');
const endpoint = arg('endpoint');
const image = workerImage();
const key = secret('RUNPOD_API_KEY');
const workerToken = secret('GPU_WORKER_TOKEN');

// RunPod's price for its 48 GB tier (L40S, L40, 6000 Ada), runpod.io/pricing on 2026-10-28.
const PRICES = { 'NVIDIA L40S': 1.75, 'NVIDIA L40': 1.75, 'NVIDIA RTX 6000 Ada Generation': 1.75, 'NVIDIA A40': 1.22, 'NVIDIA RTX A6000': 1.22, 'NVIDIA A100 80GB PCIe': 2.72, 'NVIDIA H100 80GB HBM3': 4.79, 'NVIDIA L4': 0.69 };

// --update: swap the image of an existing endpoint's template in place (RunPod's GraphQL saveTemplate needs every field,
// so they are read back first). Workers already running finish on the old image; new ones start on this one.
const update = arg('update');
if (update) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env'); process.exit(1); }
  const gql = async (query, variables) => {
    const r = await fetch('https://api.runpod.io/graphql', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join('; '));
    return j.data;
  };
  const d = await gql('query { myself { endpoints { id name template { id name imageName containerDiskInGb volumeInGb volumeMountPath dockerArgs ports containerRegistryAuthId readme env { key value } } } } }');
  const ep = d.myself.endpoints.find((e) => e.id === update);
  if (!ep) { console.error(`No RunPod endpoint ${update}`); process.exit(1); }
  const t = ep.template;
  header(`Endpoint ${ep.name} (${ep.id}), template ${t.id}`);
  say(`image: ${t.imageName}
   ->  ${image}`);
  const recycle = async () => {
    if (!process.argv.includes('--recycle')) return;
    const e = await fetch(`${API}/endpoints/${update}?includeWorkers=true`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
    const old = (e.workers ?? []).filter((w) => w.desiredStatus !== 'EXITED' && w.imageName && w.imageName !== image);
    if (!old.length) { say('No workers on an older image.'); return; }
    for (const w of old) {
      say(`${APPLY ? 'ending' : 'would end'} worker ${w.id} (${w.imageName})`);
      if (APPLY) await gql('mutation($input: PodTerminateInput!) { podTerminate(input: $input) }', { input: { podId: w.id } });
    }
  };
  if (t.imageName === image) { say('Already on this image.'); await recycle(); process.exit(0); }
  if (!APPLY) { say('(dry run: --apply saves it)'); await recycle(); process.exit(0); }
  const input = {
    id: t.id, name: t.name, imageName: image, isServerless: true, containerDiskInGb: t.containerDiskInGb, volumeInGb: t.volumeInGb ?? 0,
    volumeMountPath: t.volumeMountPath ?? '/workspace', dockerArgs: t.dockerArgs ?? '', ports: t.ports ?? '8080/http', readme: t.readme ?? '',
    env: (t.env ?? []).map(({ key: k, value }) => ({ key: k, value })), ...(t.containerRegistryAuthId ? { containerRegistryAuthId: t.containerRegistryAuthId } : {}),
  };
  const saved = await gql('mutation($input: SaveTemplateInput) { saveTemplate(input: $input) { id imageName } }', { input });
  say(`saved: template ${saved.saveTemplate.id} now runs ${saved.saveTemplate.imageName}`);
  await recycle();
  process.exit(0);
}

const template = {
  name, imageName: image, isServerless: true, containerDiskInGb: disk, category: 'NVIDIA', ports: ['8080/http'],
  env: { PORT: '8080', PORT_HEALTH: '8080', STORAGE: 'broker', MODEL_LOAD: 'none', HAWKES_SERVICE: name, ...(workerToken ? { WORKER_TOKEN: workerToken } : {}) },
  ...(registryAuth ? { containerRegistryAuthId: registryAuth } : {}),
};

header(`RunPod template ${name}`);
say(JSON.stringify({ ...template, env: { ...template.env, ...(workerToken ? { WORKER_TOKEN: redact(workerToken) } : {}) } }, null, 2));
say(`RUNPOD_API_KEY: ${redact(key)}; GPU_WORKER_TOKEN: ${redact(workerToken)} (optional: the worker then refuses requests without it)`);

let templateId = null;
if (APPLY) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env (RunPod console > Settings > API Keys).'); process.exit(1); }
  const r = await fetch(`${API}/templates`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(template) });
  const body = await r.text();
  if (!r.ok) { console.error(`RunPod refused the template (${r.status}): ${body.slice(0, 400)}`); process.exit(1); }
  templateId = JSON.parse(body).id;
  say(`made template ${templateId}`);
} else say('(dry run: --apply creates it)');

header('Then the endpoint, in the RunPod console (Serverless > New Endpoint)');
say(`1. Import from template: ${templateId ?? name}. Endpoint type: Load balancer.`);
say(`2. GPU: ${gpu} (48 GB, like the fleet's L40S). Max workers ${max}, active (min) workers 0, idle timeout 600 s, FlashBoot on.`);
say('3. Health check path: /ping (the worker answers 200 when ComfyUI is up, 204 while it starts). Port 8080 exposed.');
say('4. Optional: a network volume mounted at /mnt/models with the models (then models load from it, not through Gen).');
say('5. Copy the endpoint id; run this again with --endpoint <id> for Gen\'s settings entry.');

if (endpoint) {
  printEntry({ id: 'runpod', provider: 'runpod', url: `https://${endpoint}.api.runpod.ai`, families: ['*'], gpu: gpu.replace(/^NVIDIA /, ''), pricePerHour: PRICES[gpu] ?? 0, maxConcurrent: max, graphLimitSeconds: 300, enabled: true });
}
say('\nGen also needs RUNPOD_API_KEY in its environment (tools/gen-cloudrun/deploy.mjs mounts it from Secret Manager) and HAWKESGEN_PUBLIC_URL.');
