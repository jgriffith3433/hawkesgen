// Shared by tools/playtest-cloudrun/*.mjs (docs/playtest-cloudrun.md): the service spec, the image's build context
// (Gen's exact Playwright version written in), its tag, and the Cloud Run service definition. Pure, so the tests read it.
// Two variants: "gpu" (gen-playtest, the L4: service.json, Dockerfile) and "cpu" (gen-playtest-cpu, software WebGL on
// SwiftShader: service-cpu.json, Dockerfile.cpu; --variant cpu).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadServiceMap } from '../cloudrun/lib.mjs';

export const DIR = path.join(ROOT, 'server', 'playtest-cloudrun');
export const variantOf = (v) => (v === 'cpu' ? 'cpu' : 'gpu');
export const loadSpec = (variant = 'gpu') => JSON.parse(fs.readFileSync(path.join(DIR, variantOf(variant) === 'cpu' ? 'service-cpu.json' : 'service.json'), 'utf8'));
/** Where build.mjs leaves the image tag for deploy.mjs, and deploy.mjs the URL. */
export const stateName = (variant, what) => `playtest-${variantOf(variant) === 'cpu' ? 'cpu-' : ''}${what}.json`;

/** The Playwright version Gen runs (package-lock.json): the browser server must speak the client's protocol. */
export function playwrightVersion() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const v = lock.packages?.['node_modules/playwright']?.version;
  if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) throw new Error('No playwright version in package-lock.json');
  return v;
}

/** The build context's files: [name in the context, file in server/playtest-cloudrun/]. */
export const FILES = {
  gpu: [['Dockerfile', 'Dockerfile'], ['package.json', 'package.json'], ['server.mjs', 'server.mjs'], ['gpu.mjs', 'gpu.mjs'], ['site.mjs', 'site.mjs'], ['10_nvidia.json', '10_nvidia.json'], ['nvidia_icd.json', 'nvidia_icd.json']],
  cpu: [['Dockerfile', 'Dockerfile.cpu'], ['package.json', 'package.json'], ['server.mjs', 'server.mjs'], ['gpu.mjs', 'gpu.mjs'], ['site.mjs', 'site.mjs']],
};

/** The build context with __PW_VERSION__ filled in, and its hash (the tag changes when any file or the version does). */
export function buildContext(version = playwrightVersion(), variant = 'gpu') {
  const files = {};
  const h = crypto.createHash('sha256').update(`playwright ${version}\n`);
  for (const [name, src] of FILES[variantOf(variant)]) {
    const data = Buffer.from(fs.readFileSync(path.join(DIR, src), 'utf8').replaceAll('__PW_VERSION__', version));
    files[name] = data;
    h.update(name).update(data);
  }
  return { files, version, variant: variantOf(variant), hash: h.digest('hex').slice(0, 10) };
}

export const imageRepo = (args, spec) => `${args.region}-docker.pkg.dev/${args.project}/${spec.repository}/${spec.image}`;
export const imageTag = (args, spec, ctx = buildContext(undefined, spec.variant)) => `${imageRepo(args, spec)}:pw${ctx.version}-${ctx.hash}`;

/**
 * Instance price per hour. The L4 service: services.json's rates (the same L4 price as the GPU services). The CPU
 * service: its own request-based rates in service-cpu.json (billed only while a tab or an encode is connected).
 */
export function pricePerHour(spec, map = loadServiceMap()) {
  if (!spec.gpu) return (spec.cpu * spec.prices.cpuPerVcpuSecond + spec.memoryGi * spec.prices.memoryPerGibSecond) * 3600;
  return (map.prices.gpuPerSecond[spec.gpu] + spec.cpu * map.prices.cpuPerVcpuSecond + spec.memoryGi * map.prices.memoryPerGibSecond) * 3600;
}

/**
 * The Knative service: one L4, scale to zero, containerConcurrency = tabs per instance (one WebSocket = one tab),
 * instance-based billing (GPUs need it), no zonal redundancy, a 60-minute request limit (one playtest's connection),
 * the startup probe on /ready (the GPU self-test passes first), liveness on /healthz.
 * The CPU service (spec.gpu null): no accelerator, request-based billing (CPU only while a connection is open, so no
 * idle tail), HAWKES_GL_MODE=software (the self-test proves WebGL draws on SwiftShader).
 */
export function serviceYaml(spec, { image, region, serviceAccount, maxInstances = spec.maxInstances, tabs = spec.tabsPerInstance }) {
  if (!spec.gpu) return cpuServiceYaml(spec, { image, region, serviceAccount, maxInstances, tabs });
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

/** gen-playtest-cpu: the same container in software mode, no GPU, request-based billing. */
export function cpuServiceYaml(spec, { image, region, serviceAccount, maxInstances, tabs }) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: spec.name,
      labels: { 'cloud.googleapis.com/location': region, hawkes: 'gen-playtest-cpu' },
      annotations: { 'run.googleapis.com/ingress': 'all' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': String(maxInstances),
            // Request-based billing: CPU (and the bill) only while a tab or an encode is connected. A WebSocket is a
            // request for as long as it is open, so a playtest has its CPU for its whole run.
            'run.googleapis.com/cpu-throttling': 'true',
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/startup-cpu-boost': 'true',
          },
        },
        spec: {
          containerConcurrency: tabs,
          timeoutSeconds: spec.timeoutSeconds,
          serviceAccountName: serviceAccount,
          containers: [{
            image,
            ports: [{ name: 'http1', containerPort: 8080 }],
            env: [{ name: 'HAWKES_TABS', value: String(tabs) }, { name: 'HAWKES_GL_MODE', value: 'software' }],
            resources: { limits: { cpu: String(spec.cpu), memory: `${spec.memoryGi}Gi` } },
            // The self-test launches Chromium on SwiftShader, draws and times a WebGL loop: ~5-15 s.
            startupProbe: { httpGet: { path: '/ready', port: 8080 }, initialDelaySeconds: 0, periodSeconds: 3, timeoutSeconds: 3, failureThreshold: 60 },
            livenessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3 },
          }],
        },
      },
    },
  };
}
