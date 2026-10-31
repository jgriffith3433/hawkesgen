// Shared by tools/cpu-cloudrun/*.mjs (docs/cpu-cloudrun.md): the services' spec, the image's build context and its tag,
// and the Cloud Run service definitions. Pure, so the tests read it.
//
// The build context is the service's own files and nothing else: server/cpu-cloudrun/server.ts and every Gen source
// file it (and src/lod-mesh.ts, which the service runs for asset.lod) imports, found by following their imports, plus
// post/*.py, the Dockerfile, requirements.txt and a package.json with the exact versions of the Node packages they use
// (from Gen's package-lock.json). The tag is a hash of all of it, so a change to any tool rebuilds the image and an
// unrelated change to Gen doesn't.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../cloudrun/lib.mjs';

export const DIR = path.join(ROOT, 'server', 'cpu-cloudrun');
export const loadSpec = () => JSON.parse(fs.readFileSync(path.join(DIR, 'service.json'), 'utf8'));

/** The entry points the service runs. */
export const ENTRIES = ['server/cpu-cloudrun/server.ts', 'src/lod-mesh.ts'];
/** The Node packages those files import (versions come from package-lock.json). */
export const NODE_PACKAGES = ['@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'meshoptimizer', 'draco3dgltf', 'google-auth-library'];

/** Every Gen source file the entries reach through value imports (`import type` brings nothing at run time). */
export function sourceClosure(entries = ENTRIES, root = ROOT) {
  const seen = new Set();
  const packages = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const specs = [
      ...[...text.matchAll(/^\s*import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...text.matchAll(/^\s*export\s+(?!type\s)[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const s of specs) {
      if (s.startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)));
      else if (!s.startsWith('node:')) packages.add(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
    }
  };
  for (const e of entries) visit(e);
  return { files: [...seen].sort(), packages: [...packages].sort() };
}

/** package.json for the image: exactly the versions Gen runs. */
export function packageJson(root = ROOT) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const deps = {};
  for (const p of NODE_PACKAGES) {
    const v = lock.packages?.[`node_modules/${p}`]?.version;
    if (!v) throw new Error(`${p} isn't in package-lock.json`);
    deps[p] = v;
  }
  return JSON.stringify({ name: 'gen-cpu', private: true, type: 'module', engines: { node: '>=24' }, dependencies: deps }, null, 2);
}

/** The build context: name -> bytes, and its hash. Source files go under app/ at their paths in Gen. */
export function buildContext(root = ROOT) {
  const { files, packages } = sourceClosure(ENTRIES, root);
  const missing = packages.filter((p) => !NODE_PACKAGES.includes(p));
  if (missing.length) throw new Error(`the service imports ${missing.join(', ')}, which tools/cpu-cloudrun/lib.mjs NODE_PACKAGES doesn't install`);
  // post/quality/*.py too: quality.identity's face script.
  const post = [
    ...fs.readdirSync(path.join(root, 'post')).filter((f) => f.endsWith('.py')).sort().map((f) => `post/${f}`),
    ...fs.readdirSync(path.join(root, 'post', 'quality')).filter((f) => f.endsWith('.py')).sort().map((f) => `post/quality/${f}`),
  ];
  // Text with LF line ends: a Windows checkout (CRLF) and a Linux one give the same image and the same tag.
  const text = (file) => Buffer.from(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  const out = {
    Dockerfile: text(path.join(DIR, 'Dockerfile')),
    'requirements.txt': text(path.join(DIR, 'requirements.txt')),
    'package.json': Buffer.from(packageJson(root)),
  };
  for (const f of [...files, ...post]) out[`app/${f}`] = text(path.join(root, f));
  const h = crypto.createHash('sha256');
  for (const name of Object.keys(out).sort()) h.update(name).update('\0').update(out[name]);
  return { files: out, sources: files, hash: h.digest('hex').slice(0, 12) };
}

export const imageRepo = (args, spec) => `${args.region}-docker.pkg.dev/${args.project}/${spec.repository}/${spec.image}`;
export const imageTag = (args, spec, ctx = buildContext()) => `${imageRepo(args, spec)}:${ctx.hash}`;
export const bucketOf = (args) => args.bucket ?? `${args.project}-gen-cpu`;

/** A class's instance price per hour while a request runs (request-based billing). */
export const pricePerHour = (spec, cls) => (spec.classes[cls].cpu * spec.prices.cpuPerVcpuSecond + spec.classes[cls].memoryGi * spec.prices.memoryPerGibSecond) * 3600;

/**
 * One class's Knative service: scale to zero, request-based billing (CPU only while a request runs: cpu-throttling on),
 * its vCPUs, memory, concurrency and max instances, startup CPU boost, gen2, its request timeout, the service account,
 * a liveness probe on /healthz. The same image serves both classes.
 */
export function serviceYaml(spec, cls, { image, region, serviceAccount, bucket }) {
  const c = spec.classes[cls];
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: c.name,
      labels: { 'cloud.googleapis.com/location': region, hawkes: 'gen-cpu' },
      annotations: { 'run.googleapis.com/ingress': 'all' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': String(c.maxInstances),
            'run.googleapis.com/cpu-throttling': 'true',
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/startup-cpu-boost': 'true',
          },
        },
        spec: {
          containerConcurrency: c.concurrency,
          timeoutSeconds: c.timeoutSeconds,
          serviceAccountName: serviceAccount,
          containers: [{
            image,
            ports: [{ name: 'http1', containerPort: 8080 }],
            env: [{ name: 'HAWKES_CPU_CLASS', value: cls }, { name: 'HAWKES_CPU_BUCKET', value: bucket }],
            resources: { limits: { cpu: String(c.cpu), memory: `${c.memoryGi}Gi` } },
            startupProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
            livenessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3 },
          }],
        },
      },
    },
  };
}
