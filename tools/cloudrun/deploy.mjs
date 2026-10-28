#!/usr/bin/env node
// Deploys (or updates) each family's Cloud Run GPU service from server/cloudrun/services.json. docs/cloudrun.md, "Deploy".
//
//   node tools/cloudrun/deploy.mjs [--project hawkes-staging] [--region us-east4] [--service gen-z-image,gen-qwen-edit]
//        [--image <tag>] [--bucket <name>] [--gen-sa <email>] [--worker-sa <email>] [--network default --subnet default]
//        [--setup] [--apply]
//
// Each service: 1 GPU of its type, its vCPUs and memory, instance-based billing (CPU always allocated, which GPUs
// require), concurrency 1, min instances 0 (scale to zero), its max instances, a 60-minute request timeout, no GPU zonal
// redundancy (cheaper; failover only best effort), the models bucket mounted read-only at /mnt/models, a startup probe
// on /ready (traffic only once the models are in place and ComfyUI answers), the worker service account, and
// roles/run.invoker for Gen's service account only (never allUsers). The service is written as a Knative YAML and
// applied with `gcloud run services replace`, so running it again is an update, not a second service.
//
// A GPU not offered in --region for services (the RTX PRO 6000 isn't in us-east4) puts that service in the GPU's
// fallback region (us-central1), said loudly. --setup also creates the two service accounts and grants them the bucket.
// --network/--subnet add Direct VPC egress (all traffic), which Google recommends for loading models from Cloud Storage
// (Private Google Access must be on in that subnet). Without --apply: prints every command and YAML, changes nothing.
// At the end it prints the settings patch that points Gen at the deployed services.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadServiceMap, pickServices, bucketOf, regionFor, pricePerHour, imageTag, gcloud, saveState, readState, STATE_DIR } from './lib.mjs';

const args = parseArgs();
const map = loadServiceMap();
const bucket = bucketOf(args, map);
const services = pickServices(args, map);
const image = args.image ?? readState('image.json')?.tag ?? imageTag(args, map);
const workerSa = args.workerSa ?? `gen-gpu-worker@${args.project}.iam.gserviceaccount.com`;
const genSa = args.genSa ?? `gen-control@${args.project}.iam.gserviceaccount.com`;

console.log(`Project ${args.project}, region ${args.region}, image ${image}`);
console.log(`Bucket gs://${bucket} (models/ and cloudrun/ runs), worker ${workerSa}, Gen calls as ${genSa}\n`);

if (args.setup) {
  console.log('Setup: service accounts and bucket access');
  for (const [sa, title] of [[workerSa, 'Hawkes Gen GPU worker'], [genSa, 'Hawkes Gen control server']]) {
    const id = sa.split('@')[0];
    const have = gcloud(args, ['iam', 'service-accounts', 'describe', sa, `--project=${args.project}`, '--format=value(email)'], { read: true });
    if (!have) gcloud(args, ['iam', 'service-accounts', 'create', id, `--project=${args.project}`, `--display-name=${title}`]);
    // Both read models and write run files (the worker its outputs, Gen the inputs and cancel markers).
    gcloud(args, ['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin']);
  }
  console.log('');
}

const urls = {};
for (const svc of services) {
  const { region, note } = regionFor(map, svc, args.region);
  const g = map.gpus[svc.gpu];
  if (svc.cpu < g.minCpu || svc.memoryGi < g.minMemoryGi) throw new Error(`${svc.name}: ${svc.gpu} needs at least ${g.minCpu} vCPU and ${g.minMemoryGi} GiB`);
  console.log(`${svc.name}: ${svc.gpu} x1, ${svc.cpu} vCPU, ${svc.memoryGi} GiB, max ${svc.maxInstances} instance(s), models ${svc.load} (${svc.models.length}), about $${pricePerHour(map, svc).toFixed(2)}/hour per instance while up`);
  if (note) console.log(`  NOTE: ${note}`);
  if (region !== args.region) console.log(`  NOTE: the bucket and image are in ${args.region}: reading them from ${region} is slower and pays cross-region transfer. Prefer one region for all (us-central1 offers both GPUs).`);

  const annotations = {
    'autoscaling.knative.dev/minScale': '0',
    'autoscaling.knative.dev/maxScale': String(svc.maxInstances),
    'run.googleapis.com/cpu-throttling': 'false',
    'run.googleapis.com/execution-environment': 'gen2',
    'run.googleapis.com/gpu-zonal-redundancy-disabled': 'true',
    'run.googleapis.com/startup-cpu-boost': 'true',
  };
  if (args.network) {
    annotations['run.googleapis.com/network-interfaces'] = JSON.stringify([{ network: args.network, subnetwork: args.subnet ?? args.network }]);
    annotations['run.googleapis.com/vpc-access-egress'] = 'all-traffic';
  }
  const yaml = {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: svc.name,
      labels: { 'cloud.googleapis.com/location': region, hawkes: 'gen-gpu' },
      // GPUs other than the L4 may still be in preview: the BETA stage admits both.
      annotations: { 'run.googleapis.com/launch-stage': 'BETA', 'run.googleapis.com/ingress': 'all' },
    },
    spec: {
      template: {
        metadata: { annotations },
        spec: {
          containerConcurrency: 1,
          timeoutSeconds: map.timeoutSeconds,
          serviceAccountName: workerSa,
          nodeSelector: { 'run.googleapis.com/accelerator': svc.gpu },
          containers: [{
            image,
            ports: [{ name: 'http1', containerPort: 8080 }],
            env: [
              { name: 'HAWKES_SERVICE', value: svc.name },
              { name: 'HAWKES_BUCKET', value: bucket },
              { name: 'MODEL_LOAD', value: svc.load },
              { name: 'MODELS_MOUNT', value: '/mnt/models' },
              { name: 'HAWKES_MODELS', value: svc.models.join(',') },
            ],
            resources: { limits: { cpu: String(svc.cpu), memory: `${svc.memoryGi}Gi`, 'nvidia.com/gpu': '1' } },
            // Model download plus ComfyUI's start: up to 10 minutes before the instance counts as failed.
            startupProbe: { httpGet: { path: '/ready', port: 8080 }, initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 60 },
            livenessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3 },
            volumeMounts: [{ name: 'models', mountPath: '/mnt/models', readOnly: true }],
          }],
          volumes: [{ name: 'models', csi: { driver: 'gcsfuse.run.googleapis.com', readOnly: true, volumeAttributes: { bucketName: bucket, mountOptions: 'only-dir=models' } } }],
        },
      },
    },
  };
  const file = path.join(STATE_DIR, `service-${svc.name}.yaml`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // JSON is YAML: gcloud reads it as is.
  fs.writeFileSync(file, JSON.stringify(yaml, null, 2));
  console.log(`  service definition: ${file}`);
  gcloud(args, ['run', 'services', 'replace', file, `--project=${args.project}`, `--region=${region}`]);
  gcloud(args, ['run', 'services', 'add-iam-policy-binding', svc.name, `--project=${args.project}`, `--region=${region}`, `--member=serviceAccount:${genSa}`, '--role=roles/run.invoker']);
  const policy = gcloud(args, ['run', 'services', 'get-iam-policy', svc.name, `--project=${args.project}`, `--region=${region}`, '--format=json'], { read: true });
  if (policy && /allUsers|allAuthenticatedUsers/.test(policy)) console.log(`  WARNING: ${svc.name} is open to allUsers/allAuthenticatedUsers: remove that binding (only Gen's account may call it)`);
  const url = gcloud(args, ['run', 'services', 'describe', svc.name, `--project=${args.project}`, `--region=${region}`, '--format=value(status.url)'], { read: true });
  if (url) urls[svc.name] = url;
  console.log('');
}

const patch = { gpu: { cloudrun: { bucket, urls } } };
if (!args.apply) {
  console.log('Dry run: nothing deployed. Add --apply to deploy (J\'s OK: GPU quota, and instances bill while up).');
  if (Object.keys(urls).length) console.log(`\nServices already deployed answer at: ${JSON.stringify(urls)}`);
  process.exit(0);
}
saveState('urls.json', { ...readState('urls.json', {}), ...urls });
console.log('Point Gen at them (POST /v1/settings, owner key); families switch over only when settings.gpu says cloudrun for them:');
console.log(JSON.stringify(patch, null, 2));
