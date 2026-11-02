#!/usr/bin/env node
// The playtest browser on Modal (docs/playtest-runpod.md, "Modal"): the same image RunPod runs (server/playtest-cloudrun/,
// built to GHCR by .github/workflows/playtest-image.yml) as a Modal web endpoint on a GPU, so Gen's chromium.connect
// reaches the image's own server over a WebSocket at wss://<workspace>--hawkes-gen-playtest-browser.modal.run/pw.
// Scale to zero: no container runs until a playtest connects, and one stops `--idle` seconds after its last connection.
//
//   node tools/playtest-modal/deploy.mjs                  write .data/modal/playtest_app.py and print the plan
//   node tools/playtest-modal/deploy.mjs --apply          also: the token secret, modal deploy
//   options: --image ghcr.io/jgriffith3433/hawkes-gen-playtest:latest  --gpu L4  --max 2  --tabs 2  --idle 60
//            --app hawkes-gen-playtest
//
// Needs the modal CLI with MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment (the ops-modal-playtest-deploy
// workflow has them). Gen calls the endpoint with the Modal proxy auth token it already holds for GPU jobs
// (MODAL_PROXY_KEY / MODAL_PROXY_SECRET); the image checks X-Hawkes-Token against HAWKES_TOKEN, put in the Modal secret
// hawkes-gen-playtest from GPU_WORKER_TOKEN (Gen sends it). Deploying costs nothing until a playtest starts a container.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APPLY, ROOT, arg, secret, say, header, redact } from '../gpu-providers/lib.mjs';

// modal.com/pricing on 2026-10-28, per second. Graphics-capable cards only (Chromium needs EGL/Vulkan, not just CUDA).
export const GPU_PER_S = { T4: 0.000164, L4: 0.000222, A10: 0.000306, L40S: 0.000542 };
export const CORES = 4;
export const MEMORY_GIB = 16;
export const pricePerHour = (gpu) => Math.round(((GPU_PER_S[gpu] ?? 0) + CORES * 0.0000131 + MEMORY_GIB * 0.00000222) * 3600 * 100) / 100;

export function playtestApp({ image, app, gpu, max, tabs, idle, token }) {
  return `# Made by hawkesgen tools/playtest-modal/deploy.mjs: Gen's playtest browser (server/playtest-cloudrun/server.mjs) as a
# Modal web endpoint on a GPU. Scale to zero (no warm containers); each container plays ${tabs} browsers.
import os
import subprocess

import modal

image = modal.Image.from_registry(${JSON.stringify(image)}, add_python="3.12").env({
    "PORT": "8080", "HAWKES_TABS": "${tabs}",
    # The image fetches the driver's graphics libraries when the host mounts only compute ones (gpu.mjs).
    "NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all",
    # Modal's WebSocket relay can't read permessage-deflate frames and closes the connection on the first one (gpu.mjs).
    "HAWKES_WS_DEFLATE": "0",
}).entrypoint([])  # Modal runs an image's ENTRYPOINT with its runner as arguments: the function starts the server itself.
app = modal.App(${JSON.stringify(app)})


@app.function(
    image=image,
    gpu=${JSON.stringify(gpu)},
    cpu=${CORES}.0,
    memory=${MEMORY_GIB * 1024},
    # One playtest holds its connection for minutes: an hour is the most a run takes.
    timeout=3600,
    scaledown_window=${idle},
    max_containers=${max},
    secrets=[${token ? 'modal.Secret.from_name("hawkes-gen-playtest")' : ''}],
)
# A browser is one /pw WebSocket and its video one /encode WebSocket: room for both per tab.
@modal.concurrent(max_inputs=${tabs * 2}, target_inputs=${tabs})
@modal.web_server(8080, startup_timeout=600, requires_proxy_auth=True)
def browser():
    subprocess.Popen(["node", "server.mjs"], cwd="/app", env=dict(os.environ))
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const image = arg('image', 'ghcr.io/jgriffith3433/hawkes-gen-playtest:latest');
  const app = arg('app', 'hawkes-gen-playtest');
  const gpu = arg('gpu', 'L4');
  const max = Math.max(1, Math.min(10, Number(arg('max', '2')) || 2));
  const tabs = Math.max(1, Math.min(4, Number(arg('tabs', '2')) || 2));
  const idle = Math.max(10, Math.min(1200, Number(arg('idle', '60')) || 60));
  const token = secret('PLAYTEST_MODAL_TOKEN') || secret('GPU_WORKER_TOKEN');
  if (!GPU_PER_S[gpu]) { console.error(`--gpu ${gpu}: one of ${Object.keys(GPU_PER_S).join(', ')} (cards with graphics)`); process.exit(1); }
  if (!/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._-]+)+(:[A-Za-z0-9._-]+)?$/.test(image)) { console.error(`--image ${image}: not an image reference`); process.exit(1); }
  if (!/^[a-z0-9-]{3,40}$/.test(app)) { console.error(`--app ${app}: lower-case letters, digits and dashes`); process.exit(1); }

  const py = playtestApp({ image, app, gpu, max, tabs, idle, token });
  const dir = path.join(ROOT, '.data', 'modal');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'playtest_app.py');
  fs.writeFileSync(file, py);
  header(`Modal app ${app} (${file})`);
  say(py);
  say(`HAWKES_TOKEN: ${redact(token)} (PLAYTEST_MODAL_TOKEN, else GPU_WORKER_TOKEN; goes into the Modal secret hawkes-gen-playtest)`);
  const perHour = pricePerHour(gpu);
  say(`About $${perHour}/hour while a container runs (${gpu}, ${CORES} cores, ${MEMORY_GIB} GiB), ${tabs} browsers each; nothing while none runs.`);

  if (APPLY) {
    const modal = (args, quiet = false) => spawnSync('modal', args, { stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit', shell: process.platform === 'win32' });
    if (token) {
      say('\n$ modal secret create --force hawkes-gen-playtest HAWKES_TOKEN=<token>');
      if (modal(['secret', 'create', '--force', 'hawkes-gen-playtest', `HAWKES_TOKEN=${token}`], true).status !== 0) { console.error('modal secret create failed (is the modal CLI installed and signed in?)'); process.exit(1); }
    }
    say(`\n$ modal deploy ${file}`);
    const r = spawnSync('modal', ['deploy', file], { encoding: 'utf8', shell: process.platform === 'win32' });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    if (r.status !== 0) process.exit(r.status ?? 1);
    const url = /https:\/\/[a-z0-9-]+(\.[a-z]{2}-[a-z]+[0-9]?)?\.modal\.run/.exec(`${r.stdout}\n${r.stderr}`)?.[0];
    header('Then tell Gen (owner key): its playtests try Modal in the provider order');
    say(JSON.stringify({ modal: { url: url ?? '<the web endpoint URL above>', gpu, maxInstances: max, tabsPerInstance: tabs, pricePerHour: perHour, idleSeconds: idle } }, null, 2));
    say('PUT https://hawkesgen.ai/v1/playtest/capacity with that body (or POST /v1/settings {"playtest": {...}}).');
  } else {
    say('\n(dry run: --apply creates the secret and runs modal deploy)');
  }
}
