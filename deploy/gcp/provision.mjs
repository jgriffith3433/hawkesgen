// The Hawkes control server's VM on Google Compute Engine (hawkes-prod, us-east4-c, beside the portal's and Hawkes
// Net's VMs). Idempotent: every step looks at what exists first. Plan by default; --apply makes what's missing.
// J runs it (IAM and resource creation are his; the assistant only plans).
//
//   node deploy/gcp/provision.mjs                          the plan, with what already exists
//   node deploy/gcp/provision.mjs --apply                  make it
//   node deploy/gcp/provision.mjs --apply --bucket <b>...  also Storage on Gen's GCS buckets (repeat --bucket)
//   options: --type e2-standard-4 (CONTROL_GCE_TYPE)  --disk 200  --offline (no gcloud reads in the plan)
//
// What it makes:
//   - service account hawkes-control@hawkes-prod with only: Logging and Monitoring writer, Cloud Run invoker, jobs executor
//     and viewer (Gen's new GPU and Unity backends), objectAdmin on the buckets named with --bucket. Secret Manager access
//     is granted per secret by secrets.mjs (hawkes-control-* only), not project-wide.
//   - static external IP hawkes-control (us-east4): DNS and the AWS security groups (fleet, builder, playtester) trust it
//   - firewall: 80/443 from anywhere to tag hawkes-control; 22 from J (99.57.156.100) and the other VMs in the zone
//   - the VM: Ubuntu 24.04, e2-standard-4 (4 vCPU, 16 GB), 200 GB pd-balanced boot disk kept on delete, Shielded VM,
//     deletion protection, the cloud-platform scope (the service account's roles are the real limit), the AWS server's
//     SSH key for ubuntu, first boot from deploy/gcp/cloud-init.sh
import fs from 'node:fs';
import path from 'node:path';
import { GCP, SA_EMAIL, J_IP, OLD_IP, SSH_KEY, HERE, APPLY, args, flag, opt, say, warn, header, show, step, gcloud, gcloudJson, gcpState, saveGcpState } from './lib.mjs';

const TYPE = opt('type', GCP.machineType);
const DISK = Number(opt('disk', GCP.diskGb));
const OFFLINE = flag('offline');
const BUCKETS = args.flatMap((a, i) => (args[i - 1] === '--bucket' ? [a] : []));
const P = ['--project', GCP.project];
const read = (a) => (OFFLINE ? null : gcloudJson(a));

// Prices in us-east4 (on-demand, about; check https://cloud.google.com/compute/vm-instance-pricing before relying on them).
const PRICES = {
  'e2-standard-4': { hour: 0.151, note: 'no sustained-use discount on E2' },
  'n2-standard-4': { hour: 0.219, note: 'about 20% off for a full month (sustained use): about $128' },
  'e2-standard-8': { hour: 0.302, note: 'no sustained-use discount on E2' },
};
const DISK_GB_MONTH = 0.11; // pd-balanced, us-east4
const IP_MONTH = 0.005 * 730; // an external IPv4 in use

header('Hawkes control server on Google Compute Engine');
const price = PRICES[TYPE];
say(`machine ${TYPE}${price ? `: about $${(price.hour * 730).toFixed(0)}/month (${price.note})` : ''}; disk ${DISK} GB ${GCP.diskType}: about $${(DISK * DISK_GB_MONTH).toFixed(0)}/month; static IP about $${IP_MONTH.toFixed(2)}/month`);

// 0. APIs
await step('APIs: Compute, IAM, Secret Manager, Cloud Run, Logging', { gcloud: ['services', 'enable', 'compute.googleapis.com', 'iam.googleapis.com', 'secretmanager.googleapis.com', 'run.googleapis.com', 'logging.googleapis.com', 'monitoring.googleapis.com', ...P] });

// 1. Service account
const sa = read(['iam', 'service-accounts', 'describe', SA_EMAIL, ...P]);
await step(`service account ${SA_EMAIL}`, {
  skip: sa ? `exists (unique id ${sa.uniqueId})` : undefined,
  gcloud: ['iam', 'service-accounts', 'create', GCP.serviceAccount, '--display-name', 'Hawkes control server (Studio + Gen)', '--description', 'The control VM: Secret Manager (hawkes-control-*), Gen buckets, Cloud Run, logs. AWS trusts its unique id (deploy/gcp/aws-federation.mjs).', ...P],
});

// 2. Its roles: project-level only where Google has no narrower place to grant them yet.
const ROLES = [
  ['roles/logging.logWriter', 'journald/Ops Agent logs to Cloud Logging'],
  ['roles/monitoring.metricWriter', 'VM metrics'],
  ['roles/run.invoker', "call Gen's Cloud Run services (GPU, Unity backends)"],
  ['roles/run.jobsExecutorWithOverrides', "run Gen's Cloud Run jobs with per-job arguments"],
  ['roles/run.viewer', 'read job and execution status'],
];
const policy = read(['projects', 'get-iam-policy', GCP.project]);
const has = (role) => !!policy?.bindings?.some((b) => b.role === role && b.members?.includes(`serviceAccount:${SA_EMAIL}`));
for (const [role, why] of ROLES) {
  await step(`role ${role} (${why})`, { skip: has(role) ? 'granted' : undefined, gcloud: ['projects', 'add-iam-policy-binding', GCP.project, '--member', `serviceAccount:${SA_EMAIL}`, '--role', role, '--condition=None'] });
}
if (!BUCKETS.length) warn("no --bucket given: Storage on Gen's GCS buckets is granted once the storage move names them (re-run with --bucket <name>, once per bucket)");
for (const b of BUCKETS) {
  await step(`Storage objectAdmin on gs://${b}`, { gcloud: ['storage', 'buckets', 'add-iam-policy-binding', `gs://${b}`, '--member', `serviceAccount:${SA_EMAIL}`, '--role', 'roles/storage.objectAdmin'] });
  await step(`bucket metadata and listing on gs://${b}`, { gcloud: ['storage', 'buckets', 'add-iam-policy-binding', `gs://${b}`, '--member', `serviceAccount:${SA_EMAIL}`, '--role', 'roles/storage.legacyBucketReader'] });
}

// 3. Static IP
let addr = read(['compute', 'addresses', 'describe', GCP.name, '--region', GCP.region, ...P]);
await step(`static IP ${GCP.name} (${GCP.region})`, {
  skip: addr ? `exists: ${addr.address}` : undefined,
  gcloud: ['compute', 'addresses', 'create', GCP.name, '--region', GCP.region, '--network-tier', 'PREMIUM', '--description', 'Hawkes control server (studio., gen. and the beta sites)', ...P],
});
if (APPLY && !addr) addr = read(['compute', 'addresses', 'describe', GCP.name, '--region', GCP.region, ...P]);

// 4. Firewall
const peers = (read(['compute', 'instances', 'list', '--filter', `zone:${GCP.zone}`, ...P]) ?? [])
  .filter((i) => i.name !== GCP.name)
  .map((i) => ({ name: i.name, ip: i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP }))
  .filter((p) => p.ip);
if (OFFLINE) warn('--offline: the portal and Hawkes Net VMs are not looked up; SSH is opened to J only');
else say(`other VMs in ${GCP.zone}: ${peers.map((p) => `${p.name} ${p.ip}`).join(', ') || 'none found'}`);
const sshFrom = [`${J_IP}/32`, ...peers.map((p) => `${p.ip}/32`)];
const rules = read(['compute', 'firewall-rules', 'list', '--filter', `targetTags:${GCP.tag}`, ...P]) ?? [];
const rule = (n) => rules.find((r) => r.name === n);
await step('firewall hawkes-control-web: 80, 443 from anywhere', {
  skip: rule('hawkes-control-web') ? 'exists' : undefined,
  gcloud: ['compute', 'firewall-rules', 'create', 'hawkes-control-web', '--network', 'default', '--direction', 'INGRESS', '--action', 'ALLOW', '--rules', 'tcp:80,tcp:443', '--source-ranges', '0.0.0.0/0', '--target-tags', GCP.tag, '--description', 'Caddy: HTTPS (80 redirects)', ...P],
});
const sshRule = rule('hawkes-control-ssh');
const sameSsh = sshRule && [...(sshRule.sourceRanges ?? [])].sort().join() === [...sshFrom].sort().join();
await step(`firewall hawkes-control-ssh: 22 from ${sshFrom.join(', ')}`, {
  skip: sameSsh ? 'exists with these sources' : undefined,
  gcloud: ['compute', 'firewall-rules', sshRule ? 'update' : 'create', 'hawkes-control-ssh', ...(sshRule ? [] : ['--network', 'default', '--direction', 'INGRESS', '--action', 'ALLOW', '--rules', 'tcp:22', '--target-tags', GCP.tag, '--description', 'SSH: J and the other Hawkes VMs']), '--source-ranges', sshFrom.join(','), ...P],
});

// 5. The VM
const vm = read(['compute', 'instances', 'describe', GCP.name, '--zone', GCP.zone, ...P]);
const pub = fs.existsSync(`${SSH_KEY}.pub`) ? fs.readFileSync(`${SSH_KEY}.pub`, 'utf8').trim() : null;
if (!pub) warn(`no ${SSH_KEY}.pub: the VM would have no SSH key for ubuntu`);
const meta = path.join(HERE, '.ssh-keys.tmp');
const userData = path.join(HERE, '.user-data.tmp'); // cloud-init.sh with LF endings (a Windows checkout may have CRLF)
const create = [
  'compute', 'instances', 'create', GCP.name, '--zone', GCP.zone, '--machine-type', TYPE,
  '--image-family', GCP.image.family, '--image-project', GCP.image.project,
  '--boot-disk-size', `${DISK}GB`, '--boot-disk-type', GCP.diskType, '--boot-disk-device-name', GCP.name, '--no-boot-disk-auto-delete',
  '--address', GCP.name, '--network-tier', 'PREMIUM', '--tags', GCP.tag,
  '--service-account', SA_EMAIL, '--scopes', 'cloud-platform',
  '--shielded-secure-boot', '--shielded-vtpm', '--shielded-integrity-monitoring', '--deletion-protection',
  '--labels', 'project=hawkes-cloud,role=control',
  '--metadata', 'enable-oslogin=FALSE,block-project-ssh-keys=TRUE',
  '--metadata-from-file', `user-data=${userData},ssh-keys=${meta}`,
  ...P,
];
await step(`VM ${GCP.name}: ${TYPE}, ${DISK} GB ${GCP.diskType}, Ubuntu 24.04, ${GCP.zone}`, {
  skip: vm ? `exists (${vm.status}, ${vm.machineType?.split('/').pop()})` : undefined,
  detail: `${create.slice(0, 6).join(' ')} … (ssh-keys: ubuntu:<${path.basename(SSH_KEY)}.pub>; user-data: deploy/gcp/cloud-init.sh)`,
  run: () => {
    fs.writeFileSync(meta, `ubuntu:${pub}\n`);
    try { gcloud(create, { quiet: false }); } finally { fs.rmSync(meta, { force: true }); }
  },
});
if (!vm) show(`gcloud ${create.join(' ')}`.replace(meta, '<ubuntu:public key file>').replace(userData, 'deploy/gcp/cloud-init.sh'));

// 6. State
const ip = addr?.address ?? gcpState().ip;
const uniqueId = sa?.uniqueId ?? (APPLY ? read(['iam', 'service-accounts', 'describe', SA_EMAIL, ...P])?.uniqueId : undefined);
if (APPLY || ip || uniqueId) {
  const s = saveGcpState({ project: GCP.project, zone: GCP.zone, name: GCP.name, type: TYPE, ip, serviceAccount: SA_EMAIL, serviceAccountId: uniqueId, oldIp: OLD_IP, key: SSH_KEY });
  say(`state: ${JSON.stringify(s)}`);
}
say(`next: node deploy/gcp/aws-federation.mjs (the AWS role for ${SA_EMAIL}), node deploy/gcp/secrets.mjs, then node deploy/gcp/move.mjs prepare`);
say(`first boot takes about 5 minutes: ssh -i ${SSH_KEY} ubuntu@${ip ?? '<the static IP>'} test -f /var/lib/hawkes/ready`);
