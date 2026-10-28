// Shared by tools/cloudrun/*.mjs: arguments, the service map, where each model comes from, and running gcloud.
// Every script prints what it would do and changes nothing without --apply.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gcloudBin } from '../gcloud-bin.mjs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLOUDRUN_DIR = path.join(ROOT, 'server', 'cloudrun');
export const STATE_DIR = path.join(ROOT, '.data', 'cloudrun');

/** --name value / --name=value / --flag. Defaults: project hawkes-staging, region us-east4. */
export function parseArgs(argv = process.argv.slice(2)) {
  const a = { project: 'hawkes-staging', region: 'us-east4', apply: false, services: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const [k, inline] = t.slice(2).split('=', 2);
    const next = () => inline ?? argv[++i];
    if (k === 'apply') a.apply = true;
    else if (k === 'service') a.services.push(...String(next()).split(',').filter(Boolean));
    else if (['project', 'region', 'bucket', 'image', 'gen-sa', 'worker-sa', 'network', 'subnet', 'tag', 'machine', 'parallel', 'from', 'to', 'state', 'limit', 'prefix', 'max-instances', 'tabs', 'class'].includes(k)) a[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next();
    else if (['no-sizes', 'setup', 'all', 'help'].includes(k)) a[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    else throw new Error(`Unknown option --${k}`);
  }
  return a;
}

export const loadServiceMap = () => JSON.parse(fs.readFileSync(path.join(CLOUDRUN_DIR, 'services.json'), 'utf8'));
export const loadModels = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'models.json'), 'utf8'));
export const allServices = (map) => ({ ...map.services, ...(map.alternatives ?? {}) });
export const bucketOf = (args, map) => args.bucket ?? `${args.project}${map.bucketSuffix}`;

/** The services a run touches: --service a,b (any, alternatives too), else every main service. */
export function pickServices(args, map) {
  const all = allServices(map);
  const names = args.services.length ? args.services : Object.keys(map.services);
  for (const n of names) if (!all[n]) throw new Error(`No service ${n} in services.json (have: ${Object.keys(all).join(', ')})`);
  return names.map((name) => ({ name, ...all[name] }));
}

/** "dir/file" -> its download URL, from models.json, every workflow manifest, and the code-built graphs' extras. */
export function modelSources() {
  const src = new Map();
  for (const m of loadModels().models) src.set(`${m.dir}/${m.file}`, m.url);
  const wf = path.join(ROOT, 'workflows');
  for (const d of fs.readdirSync(wf)) {
    const f = path.join(wf, d, 'workflow.json');
    if (!fs.existsSync(f)) continue;
    for (const m of JSON.parse(fs.readFileSync(f, 'utf8')).models ?? []) if (m.url && !src.has(`${m.dir}/${m.file}`)) src.set(`${m.dir}/${m.file}`, m.url);
  }
  // graphs.ts ANGLES_LORA (image.edit's angles option), installed on first use on the fleet.
  const graphs = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'comfy', 'graphs.ts'), 'utf8');
  const angles = /ANGLES_LORA = \{\s*file: '([^']+)',\s*dir: '([^']+)',\s*url: '([^']+)'/.exec(graphs);
  if (angles && !src.has(`${angles[2]}/${angles[1]}`)) src.set(`${angles[2]}/${angles[1]}`, angles[3]);
  return src;
}

/** family -> every "dir/file" its tools may load (models.json's families, the workflow manifests, image.edit's angles
 *  LoRA). The bucket needs all of them, not just what a service preloads: the rest are read from the mount on use. */
export function familyModels() {
  const by = new Map();
  const add = (fam, id) => { if (!by.has(fam)) by.set(fam, new Set()); by.get(fam).add(id); };
  for (const m of loadModels().models) for (const f of m.families) add(f, `${m.dir}/${m.file}`);
  const wf = path.join(ROOT, 'workflows');
  for (const d of fs.readdirSync(wf)) {
    const f = path.join(wf, d, 'workflow.json');
    if (!fs.existsSync(f)) continue;
    const w = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const m of w.models ?? []) add(w.family, `${m.dir}/${m.file}`);
  }
  const graphs = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'comfy', 'graphs.ts'), 'utf8');
  const angles = /ANGLES_LORA = \{\s*file: '([^']+)',\s*dir: '([^']+)'/.exec(graphs);
  if (angles) add('qwen-edit', `${angles[2]}/${angles[1]}`);
  return by;
}

/** Everything a service's families need in the bucket, preloads first. */
export function serviceModels(svc, by = familyModels()) {
  return [...new Set([...svc.models, ...svc.families.flatMap((f) => [...(by.get(f) ?? [])])])];
}

/** Where a service runs: the asked region when its GPU is offered there, else the GPU's fallback (with a note). */
export function regionFor(map, svc, region) {
  const g = map.gpus[svc.gpu];
  if (!g) throw new Error(`${svc.name}: unknown GPU ${svc.gpu}`);
  if (g.regions.includes(region)) return { region, note: '' };
  return { region: g.fallbackRegion, note: `${svc.gpu} isn't offered in ${region} for Cloud Run services; ${svc.name} goes to ${g.fallbackRegion}` };
}

export const pricePerHour = (map, s) => (map.prices.gpuPerSecond[s.gpu] + s.cpu * map.prices.cpuPerVcpuSecond + s.memoryGi * map.prices.memoryPerGibSecond) * 3600;

/** The worker image's context hash: the image tag changes when the Dockerfile, worker, nodes or ComfyUI tag do. */
export function contextFiles() {
  const m = loadModels();
  const nodes = m.nodes.map((n) => `${n.repo} ${n.commit}`).join('\n') + '\n';
  const files = {
    Dockerfile: fs.readFileSync(path.join(CLOUDRUN_DIR, 'Dockerfile')),
    'worker.py': fs.readFileSync(path.join(CLOUDRUN_DIR, 'worker.py')),
    'entrypoint.sh': fs.readFileSync(path.join(CLOUDRUN_DIR, 'entrypoint.sh')),
    'nodes.txt': Buffer.from(nodes),
  };
  const h = crypto.createHash('sha256');
  h.update(`${m.comfyui.repo} ${m.comfyui.tag}\n`);
  for (const [k, v] of Object.entries(files)) h.update(k).update(v);
  return { files, comfy: m.comfyui, hash: h.digest('hex').slice(0, 10) };
}

export const imageRepo = (args, map) => `${args.region}-docker.pkg.dev/${args.project}/${map.repository}/${map.image}`;
export const imageTag = (args, map) => {
  const { comfy, hash } = contextFiles();
  return `${imageRepo(args, map)}:${comfy.tag}-${hash}`;
};

/** Quotes one argument for display (and for cmd.exe on Windows). */
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`);
export const show = (cmd) => cmd.map(q).join(' ');

/**
 * Runs gcloud (or prints it). `read: true` runs it even in a dry run (describe/list calls that change nothing) and
 * returns stdout, or null when it fails.
 */
export function gcloud(args, cmd, { read = false, quiet = false } = {}) {
  const full = ['gcloud', ...cmd];
  if (!args.apply && !read) {
    console.log(`  would run: ${show(full)}`);
    return null;
  }
  if (!quiet && !read) console.log(`  running: ${show(full)}`);
  const win = process.platform === 'win32';
  void win; void q;
  const [bin, pre] = gcloudBin();
  const r = spawnSync(bin, [...pre, ...cmd], { encoding: 'utf8', stdio: read ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (r.error) {
    if (read) return null;
    throw new Error(`gcloud isn't installed or not on PATH (${r.error.message}); install the Google Cloud CLI`);
  }
  if (r.status !== 0) {
    if (read) return null;
    throw new Error(`gcloud ${cmd.slice(0, 3).join(' ')} failed (exit ${r.status})`);
  }
  return read ? r.stdout.trim() : '';
}

export function saveState(name, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(value, null, 2));
}
export function readState(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
