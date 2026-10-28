// Shared by tools/playtest-cloudrun/*.mjs (docs/playtest-cloudrun.md): the service spec, the image's build context
// (Gen's exact Playwright version written in), its tag, and the Cloud Run service definition. Pure, so the tests read it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadServiceMap } from '../cloudrun/lib.mjs';

export const DIR = path.join(ROOT, 'server', 'playtest-cloudrun');
export const loadSpec = () => JSON.parse(fs.readFileSync(path.join(DIR, 'service.json'), 'utf8'));

/** The Playwright version Gen runs (package-lock.json): the browser server must speak the client's protocol. */
export function playwrightVersion() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const v = lock.packages?.['node_modules/playwright']?.version;
  if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) throw new Error('No playwright version in package-lock.json');
  return v;
}

const FILES = ['Dockerfile', 'package.json', 'server.mjs', 'gpu.mjs', '10_nvidia.json', 'nvidia_icd.json'];

/** The build context with __PW_VERSION__ filled in, and its hash (the tag changes when any file or the version does). */
export function buildContext(version = playwrightVersion()) {
  const files = {};
  const h = crypto.createHash('sha256').update(`playwright ${version}\n`);
  for (const f of FILES) {
    const data = Buffer.from(fs.readFileSync(path.join(DIR, f), 'utf8').replaceAll('__PW_VERSION__', version));
    files[f] = data;
    h.update(f).update(data);
  }
  return { files, version, hash: h.digest('hex').slice(0, 10) };
}

export const imageRepo = (args, spec) => `${args.region}-docker.pkg.dev/${args.project}/${spec.repository}/${spec.image}`;
export const imageTag = (args, spec, ctx = buildContext()) => `${imageRepo(args, spec)}:pw${ctx.version}-${ctx.hash}`;

/** Instance price per hour from server/cloudrun/services.json's rates (the same L4 price as the GPU services). */
export function pricePerHour(spec, map = loadServiceMap()) {
  return (map.prices.gpuPerSecond[spec.gpu] + spec.cpu * map.prices.cpuPerVcpuSecond + spec.memoryGi * map.prices.memoryPerGibSecond) * 3600;
}

/**
 * The Knative service: one L4, scale to zero, containerConcurrency = tabs per instance (one WebSocket = one tab),
 * instance-based billing (GPUs need it), no zonal redundancy, a 60-minute request limit (one playtest's connection),
 * the startup probe on /ready (the GPU self-test passes first), liveness on /healthz.
 */
export function serviceYaml(spec, { image, region, serviceAccount, maxInstances = spec.maxInstances, tabs = spec.tabsPerInstance }) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: spec.name,
      labels: { 'cloud.googleapis.com/location': region, hawkes: 'gen-playtest' },
      annotations: { 'run.googleapis.com/launch-stage': 'BETA', 'run.googleapis.com/ingress': 'all' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': String(maxInstances),
            'run.googleapis.com/cpu-throttling': 'false',
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/gpu-zonal-redundancy-disabled': 'true',
            'run.googleapis.com/startup-cpu-boost': 'true',
          },
        },
        spec: {
          containerConcurrency: tabs,
          timeoutSeconds: spec.timeoutSeconds,
          serviceAccountName: serviceAccount,
          nodeSelector: { 'run.googleapis.com/accelerator': spec.gpu },
          containers: [{
            image,
            ports: [{ name: 'http1', containerPort: 8080 }],
            env: [{ name: 'HAWKES_TABS', value: String(tabs) }],
            resources: { limits: { cpu: String(spec.cpu), memory: `${spec.memoryGi}Gi`, 'nvidia.com/gpu': '1' } },
            // The self-test launches Chromium once per GL path until one draws on the GPU: up to 5 minutes.
            startupProbe: { httpGet: { path: '/ready', port: 8080 }, initialDelaySeconds: 0, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 },
            livenessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3 },
          }],
        },
      },
    },
  };
}
