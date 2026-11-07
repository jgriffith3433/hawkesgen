// Shared by tools/gpu-providers/*.mjs (docs/gpu-providers.md). Every script prints what it would do and changes nothing
// without --apply. Secrets are read from hawkesgen/.env and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APPLY = process.argv.includes('--apply');

/** --name value / --name=value, else the fallback. */
export function arg(name, fallback = undefined) {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === `--${name}`) return a[i + 1];
    if (a[i].startsWith(`--${name}=`)) return a[i].slice(name.length + 3);
  }
  return fallback;
}

/** hawkesgen/.env as an object (values stay in memory). */
export function envFile() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** A value from the process environment or .env. */
export const secret = (name) => process.env[name] || envFile()[name] || '';

/**
 * The worker image other providers pull (the same image as the Cloud Run GPU services, server/cloudrun/). Google's
 * Artifact Registry would need a Google key on the provider, so it is copied to a registry they can read without one.
 * --image <ref>, else GPU_WORKER_IMAGE in .env.
 */
export function workerImage() {
  const image = arg('image') || secret('GPU_WORKER_IMAGE');
  if (!image) {
    console.error('No worker image: pass --image <registry/name:tag> (docs/gpu-providers.md, "The image": copy the Cloud Run GPU image to GHCR or Docker Hub first).');
    process.exit(1);
  }
  return image;
}

export const say = (s = '') => console.log(s);
export const header = (s) => console.log(`\n# ${s}`);
export const redact = (v) => (v ? `<set, ${String(v).length} characters>` : '<not set>');

/**
 * --kind 3d: the 3D worker image (server/gpu3d, docs/3d-animation.md) instead of the ComfyUI one. Its endpoint names
 * the 3D families (never "*") and gets a longer graph limit; settings.gpu.familyOrder sends those families to it.
 */
export const KIND = arg('kind', 'comfy');
export const THREE_D_FAMILIES = ['rig', 'motion', 'mocap', 'blender'];
export const IMAGE_3D = 'ghcr.io/jgriffith3433/hawkes-gen-3d:latest';

/** The settings entry for a 3D endpoint: the families it runs and the order that sends them there (fleet after). */
export function print3dEntry(entry) {
  header('Then add this to Gen (POST /v1/settings; settings.gpu.providers replaces the whole list: include the endpoints already there)');
  const familyOrder = Object.fromEntries(THREE_D_FAMILIES.map((f) => [f, [entry.id, 'fleet']]));
  say(JSON.stringify({ gpu: { providers: [{ ...entry, families: THREE_D_FAMILIES }], familyOrder } }, null, 2));
  say('(familyOrder replaces the whole map too: include any family orders already there. GPU_WORKER_TOKEN must be set in Gen and on the endpoint: the 3D worker refuses scripts without it.)');
}

/** The settings.gpu.providers entry to add (printed for J; Gen's settings are changed through its API or dashboard). */
export function printEntry(entry) {
  header('Then add this to Gen (POST /v1/settings, or the dashboard: Settings > GPU providers shows it once added)');
  say(JSON.stringify({ gpu: { providers: [entry], order: ['cloudrun', entry.id, 'fleet'] } }, null, 2));
  say('(settings.gpu.providers replaces the whole list: include any endpoints already there.)');
}
