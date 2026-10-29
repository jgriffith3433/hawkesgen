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

/** The settings.gpu.providers entry to add (printed for J; Gen's settings are changed through its API or dashboard). */
export function printEntry(entry) {
  header('Then add this to Gen (POST /v1/settings, or the dashboard: Settings > GPU providers shows it once added)');
  say(JSON.stringify({ gpu: { providers: [entry], order: ['cloudrun', entry.id, 'fleet'] } }, null, 2));
  say('(settings.gpu.providers replaces the whole list: include any endpoints already there.)');
}
