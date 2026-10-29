// A fixed address for Gen on Cloud Run (docs/gpu-providers.md, "The fleet from Cloud Run"): the AWS servers' security
// groups let one address in, and Cloud Run has none of its own. Direct VPC egress sends all of Gen's traffic through a
// subnet whose Cloud NAT uses a reserved static IP; settings.fleet.egressIp (or deploy.mjs --egress-ip) is then that IP.
//
//   node tools/gpu-providers/egress.mjs            print the plan (gcloud commands)
//   node tools/gpu-providers/egress.mjs --apply    run them (J: network changes and a static IP cost money)
//   options: --project hawkes-staging  --region us-east4  --service gen  --network default  --range 10.8.0.0/26
//
// Cost (cloud.google.com/vpc/network-pricing, cloud.google.com/nat/pricing): a static IP in use about $0.005/hour
// (~$3.65/month), Cloud NAT about $0.0014/hour per VM-equivalent plus $0.045/GB processed; Direct VPC egress itself is
// free. Model downloads to the fleet don't pass through it (they go to the servers from S3/Hugging Face).
import { spawnSync } from 'node:child_process';
import { APPLY, arg, say, header } from './lib.mjs';

const project = arg('project', 'hawkes-staging');
const region = arg('region', 'us-east4');
const service = arg('service', 'gen');
const network = arg('network', 'default');
const range = arg('range', '10.8.0.0/26');
const subnet = `${service}-egress`;
const router = `${service}-egress-router`;
const nat = `${service}-egress-nat`;
const ip = `${service}-egress-ip`;
const P = `--project=${project}`;

const steps = [
  ['compute', 'addresses', 'create', ip, `--region=${region}`, P],
  ['compute', 'networks', 'subnets', 'create', subnet, `--network=${network}`, `--range=${range}`, `--region=${region}`, P],
  ['compute', 'routers', 'create', router, `--network=${network}`, `--region=${region}`, P],
  ['compute', 'routers', 'nats', 'create', nat, `--router=${router}`, `--region=${region}`, `--nat-custom-subnet-ip-ranges=${subnet}`, `--nat-external-ip-pool=${ip}`, P],
  ['run', 'services', 'update', service, `--region=${region}`, `--network=${network}`, `--subnet=${subnet}`, '--vpc-egress=all-traffic', P],
];

const gcloud = (a, read = false) => {
  if (!APPLY && !read) { say(`  would run: gcloud ${a.join(' ')}`); return { status: 0, stdout: '' }; }
  if (!read) say(`  $ gcloud ${a.join(' ')}`);
  return spawnSync('gcloud', a, { encoding: 'utf8', shell: process.platform === 'win32', stdio: read ? ['ignore', 'pipe', 'ignore'] : 'inherit' });
};

header(`Static egress for the Cloud Run service ${service} (${project}, ${region})`);
for (const s of steps) {
  const r = gcloud(s);
  if (APPLY && r.status !== 0) say('  (failed: if it already exists that is fine; otherwise fix it and run again)');
}
const addr = gcloud(['compute', 'addresses', 'describe', ip, `--region=${region}`, P, '--format=value(address)'], true).stdout?.trim();
header('Then');
say(`Gen's address is ${addr || `<the address of ${ip}>`}. Tell Gen and the fleet:`);
say(`  POST /v1/settings {"fleet": {"egressIp": "${addr || '<ip>'}"}}   (or tools/gen-cloudrun/deploy.mjs --egress-ip ${addr || '<ip>'})`);
say('  then `hawkesgen fleet access` (or any fleet start) lets that address into every region\'s security group.');
