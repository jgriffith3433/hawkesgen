#!/usr/bin/env node
// Makes the build VM for a project too big for Cloud Run (docs/unity-cloudrun.md, "The build VM"), or updates its image
// and startup script. Gen starts and stops it per build (src/providers/builder/vm.ts); it is stopped otherwise.
//
//   node tools/unity-cloudrun/vm.mjs --folder C:\Projects\sickofitgame-unity --image <image> --project <gcp-project>
//        [--zone us-east4-a] [--machine-type n2-standard-8] [--disk-gb 200] [--offline] [--apply]
//
// What it makes (named after the project, e.g. hawkes-unity-sickofitgame-unity):
//   - a pd-balanced disk <name>-work (--disk-gb, default 200) that keeps the sources and the Library between builds,
//     kept when the VM is deleted;
//   - a spot VM: Container-Optimized OS, --machine-type (n2-standard-8: 8 vCPU, 32 GB), a 50 GB boot disk (the 7.5 GB
//     image is pulled once and kept), the build service account, the startup script server/unity-cloudrun/vm-startup.sh,
//     metadata hawkes-image; a spot VM taken back by Google stops (it is not deleted);
//   - the rights: the job's account reads the image; Gen's account may start, stop and set metadata on instances.
// Creating it boots it once: with no build to run it prepares the disk, pulls the image and powers itself off.
// Costs: about $0.08-0.10/hour while building (spot), the disks about $20/month (200 GB) + $5/month (50 GB boot).
import path from 'node:path';
import { ROOT, config, flag, die, done, gcloud, gcloudQuery, runtimeSa, genSa } from './common.mjs';

const c = config();
const folder = flag('folder') ?? die('Which project? Pass --folder C:\\Projects\\<project> (the Unity project folder).');
const image = flag('image') ?? die('Which image? Pass --image <the image build-image.mjs printed>.');
const diskGb = Number(flag('disk-gb', 200));
const project = path.relative(path.resolve('C:\\Projects'), path.resolve(folder)).replace(/\\/g, '/');
// The same name Gen uses (src/providers/builder/vm.ts vmName).
const slug = project.replace(/[\\/]+/g, '--').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 64).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const name = `hawkes-unity-${slug}`.slice(0, 63).replace(/-$/, '');
const P = `--project=${c.project}`;
const Z = `--zone=${c.zone}`;
const startup = path.join(ROOT, 'server', 'unity-cloudrun', 'vm-startup.sh');

console.log(`Build VM ${name} for ${project}: ${c.machineType} spot in ${c.zone}, work disk ${diskGb} GB\nImage ${image}\n`);

console.log('# Rights');
gcloud(['services', 'enable', 'compute.googleapis.com', P]);
gcloud(['artifacts', 'repositories', 'add-iam-policy-binding', c.registry, P, `--location=${c.region}`, `--member=serviceAccount:${runtimeSa(c)}`, '--role=roles/artifactregistry.reader']);
gcloud(['projects', 'add-iam-policy-binding', c.project, `--member=serviceAccount:${genSa(c)}`, '--role=roles/compute.instanceAdmin.v1', '--condition=None']);

const exists = gcloudQuery(['compute', 'instances', 'describe', name, P, Z, '--format=value(name)']);
if (exists) {
  console.log(`\n# ${name} exists: updating its image and startup script (it keeps its disk and Library)`);
  gcloud(['compute', 'instances', 'add-metadata', name, P, Z, `--metadata=hawkes-image=${image}`, `--metadata-from-file=startup-script=${startup}`]);
  done();
  process.exit(0);
}

console.log('\n# The work disk');
if (!gcloudQuery(['compute', 'disks', 'describe', `${name}-work`, P, Z, '--format=value(name)'])) {
  gcloud(['compute', 'disks', 'create', `${name}-work`, P, Z, `--size=${diskGb}GB`, '--type=pd-balanced', '--labels=project=hawkes-gen,role=unity-build']);
}

console.log('\n# The VM');
gcloud([
  'compute', 'instances', 'create', name, P, Z,
  `--machine-type=${c.machineType}`,
  '--provisioning-model=SPOT', '--instance-termination-action=STOP',
  '--image-family=cos-stable', '--image-project=cos-cloud', '--boot-disk-size=50GB', '--boot-disk-type=pd-balanced',
  `--disk=name=${name}-work,device-name=work,mode=rw,auto-delete=no`,
  `--service-account=${runtimeSa(c)}`, '--scopes=cloud-platform',
  `--metadata=hawkes-image=${image},google-logging-enabled=true`,
  `--metadata-from-file=startup-script=${startup}`,
  '--labels=project=hawkes-gen,role=unity-build',
]);

console.log(`
Then in Hawkes Gen (owner): POST /v1/settings with
  { "unityBuild": { "projects": { "${project}": "vm" }, "vm": { "zone": "${c.zone}", "machineType": "${c.machineType}" } } }
(send the whole "projects" map: it replaces the old one). The first build restores the project's cache from the bucket
if there is one (seed-cache.mjs), then keeps the Library on the VM's disk.`);
done();
