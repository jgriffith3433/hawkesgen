// Modal for Gen's GPU jobs (docs/gpu-providers.md, "Modal"): the worker image behind a Modal web endpoint
// (@modal.web_server on port 8080, proxy auth), so Gen's POST /run reaches the worker's own HTTP server.
//
//   node tools/gpu-providers/modal.mjs --image ghcr.io/<owner>/hawkes-gen-gpu:<tag>     write .data/modal/modal_app.py, print the plan
//   node tools/gpu-providers/modal.mjs --image ... --apply                               also: the worker token secret, modal deploy
//   options: --app hawkes-gen-gpu  --gpu L40S  --max 2  --registry-secret <modal secret with REGISTRY_USERNAME/PASSWORD>
//            --url <the endpoint's URL, printed by modal deploy>  (prints Gen's settings entry)
//
// Needs the modal CLI signed in on this PC (pip install modal; modal setup). Deploying costs nothing until a request
// starts a container. Gen calls it with a proxy token (MODAL_PROXY_KEY / MODAL_PROXY_SECRET in Gen's environment:
// Modal dashboard > Settings > Proxy Auth Tokens, or `modal workspace proxy-tokens`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APPLY, ROOT, arg, secret, workerImage, say, header, redact, printEntry } from './lib.mjs';

const app = arg('app', 'hawkes-gen-gpu');
const gpu = arg('gpu', 'L40S');
const max = Number(arg('max', '2'));
const registrySecret = arg('registry-secret');
const url = arg('url');
const image = workerImage();
const workerToken = secret('GPU_WORKER_TOKEN');

// modal.com/pricing on 2026-10-28, per second: L40S $0.000542, physical core $0.0000131, GiB $0.00000222.
const GPU_PER_S = { L40S: 0.000542, L4: 0.000222, A10: 0.000306, 'A100-40GB': 0.000583, 'A100-80GB': 0.000694, H100: 0.001097 };
const CORES = 4;
const MEMORY_GIB = 32;
const perHour = Math.round(((GPU_PER_S[gpu] ?? 0) + CORES * 0.0000131 + MEMORY_GIB * 0.00000222) * 3600 * 100) / 100;

const py = `# Made by hawkesgen tools/gpu-providers/modal.mjs: Gen's GPU worker (server/cloudrun/worker.py) as a Modal web endpoint.
# Files go through Gen's broker (STORAGE=broker): no Google credentials here.
import os
import subprocess

import modal

image = modal.Image.from_registry(${JSON.stringify(image)}${registrySecret ? `, secret=modal.Secret.from_name(${JSON.stringify(registrySecret)})` : ''}).env({
    "PORT": "8080", "STORAGE": "broker", "MODEL_LOAD": "none", "HAWKES_SERVICE": ${JSON.stringify(app)},
})
app = modal.App(${JSON.stringify(app)})


@app.function(
    image=image,
    gpu=${JSON.stringify(gpu)},
    cpu=${CORES}.0,
    memory=${MEMORY_GIB * 1024},
    timeout=3600,
    # A request ends at Modal's 150 s HTTP limit while the run goes on: keep the container while Gen follows the heartbeat.
    scaledown_window=1200,
    max_containers=${max},
    secrets=[${workerToken ? 'modal.Secret.from_name("hawkes-gen-worker")' : ''}],
)
@modal.concurrent(max_inputs=1)
@modal.web_server(8080, startup_timeout=900, requires_proxy_auth=True)
def worker():
    subprocess.Popen(["/opt/hawkes/entrypoint.sh"], env=dict(os.environ))
`;

const dir = path.join(ROOT, '.data', 'modal');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'modal_app.py');
fs.writeFileSync(file, py);
header(`Modal app ${app} (${file})`);
say(py);
say(`GPU_WORKER_TOKEN: ${redact(workerToken)} (optional; when set it goes into the Modal secret hawkes-gen-worker as WORKER_TOKEN)`);
say(`About $${perHour}/hour while a container runs (${gpu}, ${CORES} cores, ${MEMORY_GIB} GiB).`);

const modal = (args) => spawnSync('modal', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (APPLY) {
  if (workerToken) {
    say('\n$ modal secret create --force hawkes-gen-worker WORKER_TOKEN=<GPU_WORKER_TOKEN>');
    const r = spawnSync('modal', ['secret', 'create', '--force', 'hawkes-gen-worker', `WORKER_TOKEN=${workerToken}`], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    if (r.status !== 0) { console.error('modal secret create failed (is the modal CLI installed and signed in?)'); process.exit(1); }
  }
  say(`\n$ modal deploy ${file}`);
  const r = modal(['deploy', file]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  say('\nCopy the web endpoint URL above and run this again with --url <it> for Gen\'s settings entry.');
} else {
  say('\n(dry run: --apply creates the secret and runs modal deploy)');
}
if (url) {
  printEntry({ id: 'modal', provider: 'modal', url: url.replace(/\/+$/, ''), families: ['*'], gpu, pricePerHour: perHour, maxConcurrent: max, graphLimitSeconds: 3300, enabled: true });
}
say('\nGen also needs MODAL_PROXY_KEY and MODAL_PROXY_SECRET in its environment (tools/gen-cloudrun/deploy.mjs mounts them) and HAWKESGEN_PUBLIC_URL.');
