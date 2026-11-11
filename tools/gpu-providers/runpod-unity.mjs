// The unity-render endpoint on RunPod (docs/unity-render.md): `node tools/gpu-providers/runpod.mjs --kind unity-render`
// (or this file directly). Prints the plan; --apply makes (or brings up to date) the template and the load-balancer
// endpoint, and with --dc <data center> a 50 GB network volume there if none of that name exists.
//
//   --image ghcr.io/jgriffith3433/hawkes-gen-gpu:unity-render-latest   --max 10   --idle 60   --disk 50   --volume-gb 50
//   --dc <RunPod data center id, e.g. US-KS-2>   --volume <existing volume id>   --endpoint <id> (print Gen's settings entry)
//
// GPUs: exact models with proven graphics on RunPod (the playtest endpoint's list: RTX A4000, RTX A4500, RTX 4000 Ada),
// every other type in their pool excluded (a pool alone handed out MIG slices: CUDA, no graphics). The Unity build
// account goes into the template's env from UNITY_EMAIL / UNITY_PASSWORD (process env or hawkesgen/.env), else from
// Secret Manager (unity-email, unity-password in --gcp-project, default hawkes-staging) through gcloud; never printed.
import { execFileSync } from 'node:child_process';
import { APPLY, arg, secret, say, header, redact } from './lib.mjs';
import { runpod, upsertTemplate, findEndpoint, lbEndpoint, readCatalog, gpuFor } from './runpod-v2.mjs';

const name = arg('name', 'hawkes-gen-unity-render');
const image = arg('image', 'ghcr.io/jgriffith3433/hawkes-gen-gpu:unity-render-latest');
const max = Number(arg('max', '10'));
const idle = Number(arg('idle', '60')); // at most runpod-v2.mjs IDLE_SECONDS (lbEndpoint)
const disk = Number(arg('disk', '50'));
const volumeGb = Number(arg('volume-gb', '50'));
const dc = arg('dc');
const endpointId = arg('endpoint');
const GPUS = (arg('gpu-types', '') || 'NVIDIA RTX A4000,NVIDIA RTX A4500,NVIDIA RTX 4000 Ada Generation').split(',').map((s) => s.trim()).filter(Boolean);
const key = secret('RUNPOD_API_KEY');
const workerToken = secret('GPU_WORKER_TOKEN');

function gcpSecret(id) {
  try {
    return execFileSync(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${id}`, `--project=${arg('gcp-project', 'hawkes-staging')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }) // gcloud is a .cmd on Windows.trim();
  } catch { return ''; }
}
const unity = () => ({ email: secret('UNITY_EMAIL') || gcpSecret('unity-email'), password: secret('UNITY_PASSWORD') || gcpSecret('unity-password') });

const env = (u) => ({
  PORT: '8080', PORT_HEALTH: '8080', HEALTH_CHECK_PATH: '/ping', STORAGE: 'broker', MODEL_LOAD: 'none', HAWKES_COMFY: '0', HAWKES_SERVICE: name,
  ...(workerToken ? { WORKER_TOKEN: workerToken } : {}),
  ...(u?.email ? { UNITY_EMAIL: u.email } : {}), ...(u?.password ? { UNITY_PASSWORD: u.password } : {}),
});
const template = (u) => ({ name, image, serverless: true, disk, category: 'NVIDIA', ports: ['8080/http'], env: env(u) });

header(`RunPod unity-render endpoint ${name}`);
say(`image ${image}; GPUs (only these): ${GPUS.join(', ')}; max workers ${max}, idle ${idle} s, container disk ${disk} GB, volume ${volumeGb} GB${dc ? ` in ${dc}` : ''}`);
say(`RUNPOD_API_KEY ${redact(key)}; GPU_WORKER_TOKEN ${redact(workerToken)}; the Unity account is read only with --apply`);

if (APPLY) {
  if (!key) { console.error('RUNPOD_API_KEY is not in hawkesgen/.env'); process.exit(1); }
  if (!workerToken) { console.error('GPU_WORKER_TOKEN is not in hawkesgen/.env: the worker refuses scripts without it.'); process.exit(1); }
  const u = unity();
  if (!u.email || !u.password) { console.error('No Unity build account: set UNITY_EMAIL and UNITY_PASSWORD, or let gcloud read unity-email / unity-password (--gcp-project).'); process.exit(1); }
  say(`Unity account: email ${redact(u.email)}, password ${redact(u.password)}`);
  const api = runpod(key);
  const catalog = await readCatalog(api);
  if (!catalog) { console.error('Could not read RunPod\'s GPU catalog: a MIG slice could slip in. Nothing changed.'); process.exit(1); }
  const gpu = gpuFor(GPUS, { catalog });
  say(`pools ${gpu.pools.join(', ')}; excluded there: ${gpu.excludedTypes.join(', ') || 'none'}`);
  let volume = arg('volume');
  if (!volume && dc) {
    const vols = await api.list('/network-volumes', 'networkVolumes').catch(() => []);
    const have = vols.find((v) => v.name === `${name}-vol` && (v.dataCenterId ?? v.dataCenter) === dc);
    volume = have?.id ?? (await api.req('POST', '/network-volumes', { name: `${name}-vol`, size: volumeGb, dataCenter: dc })).id;
    say(`${have ? 'kept' : 'made'} network volume ${volume} (${volumeGb} GB, ${dc}; about $${(volumeGb * 0.07).toFixed(2)} a month)`);
  }
  const [t, madeT] = await upsertTemplate(api, template(u));
  say(`${madeT ? 'made' : 'updated'} template ${t.id}`);
  const body = { ...lbEndpoint({ name, templateId: t.id, gpu, max, idle, perWorker: 1, timeoutMs: 7_200_000 }), ...(volume ? { networkVolumes: [volume] } : {}) };
  const old = await findEndpoint(api, name);
  const { templateId: _t, ...update } = body;
  const e = old ? await api.req('PATCH', `/serverless/${old.id}`, update) : await api.req('POST', '/serverless', body);
  say(`${old ? 'updated' : 'made'} endpoint ${e.id} (${e.type})`);
  printEntry(e.id);
} else {
  say(JSON.stringify({ template: { ...template(null), env: { ...env(null), WORKER_TOKEN: redact(workerToken), UNITY_EMAIL: '<from secrets>', UNITY_PASSWORD: '<from secrets>' } }, endpoint: lbEndpoint({ name, templateId: '<template id>', gpu: gpuFor(GPUS), max, idle, perWorker: 1, timeoutMs: 7_200_000 }) }, null, 2));
  say('(dry run: --apply makes it; --dc <data center> also makes the network volume)');
  if (endpointId) printEntry(endpointId);
}

function printEntry(id) {
  header('Gen settings (POST /v1/settings; providers and familyOrder replace the whole list and map: include what is there)');
  say(JSON.stringify({ gpu: { providers: [{ id: 'runpod-unity', provider: 'runpod', url: `https://${id}.api.runpod.ai`, families: ['unity-render'], gpu: 'RTX A4000 class', pricePerHour: 0.58, maxConcurrent: max, graphLimitSeconds: 7200, enabled: true }], familyOrder: { 'unity-render': ['runpod-unity'] } } }, null, 2));
}
