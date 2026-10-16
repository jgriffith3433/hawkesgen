// The playtester: a small GPU machine (g4dn.xlarge, NVIDIA T4, about $0.53/hr) that only runs a Playwright browser
// server, so game playtests from the Linux control server render on a real GPU instead of in software.
//
// It is launched once (server/playtester/bootstrap.sh installs Node, Playwright and Chromium at first boot), then
// started and stopped: Hawkes Studio's daily run starts it before games are played and stops it when the run ends,
// and it powers itself off after its idle time (nobody connected to the browser server) in case nobody does.
// The browser server listens on 127.0.0.1:3600; playtests reach it through an SSH tunnel (playtestHost.ts).
// The security group lets in SSH only, from this machine and HAWKES_ALLOW_IPS.
//
// Local state (instance id, SSH key, known hosts) lives in DATA_DIR/fleet/playtester*.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  EC2Client, DescribeInstancesCommand, DescribeVpcsCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
  RunInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { awsConfig, myIp, classify, lockKey, allowOnly, gpuImage } from '../comfy/fleet.ts';
import { env, paths } from '../../config.ts';
import { GenError } from '../../util.ts';

export const PLAYTESTER_TYPES: Record<string, { vcpus: number; memory: number; gpu: string; price: number }> = {
  'g4dn.xlarge': { vcpus: 4, memory: 16, gpu: 'NVIDIA T4, 16 GB', price: 0.526 },
  'g4dn.2xlarge': { vcpus: 8, memory: 32, gpu: 'NVIDIA T4, 16 GB', price: 0.752 },
};
export const PLAYTESTER_DEFAULT_TYPE = 'g4dn.xlarge';
/** The GPU image's smallest root disk. */
export const PLAYTESTER_DISK_GB = 75;
export const PLAYTESTER_DISK_PER_MONTH = PLAYTESTER_DISK_GB * 0.08;
export const PLAYTESTER_PORT = 3600;
const NAME = 'hawkesgen-playtester';
const PROJECT = 'hawkes-gen';
const SG = 'hawkesgen-playtester';
const USER = 'ubuntu';

const fail = (message: string, kind = 'playtester') => new GenError(message, { status: 409, kind });

type State = { instanceId?: string; region?: string; type?: string; idleMinutes?: number; launchedAt?: string };
const STATE = () => path.join(paths.fleet, 'playtester.json');
const KEY = () => path.join(paths.fleet, 'playtester_ed25519');
const KNOWN = () => path.join(paths.fleet, 'playtester_known_hosts');

export function playtesterState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE(), 'utf8'));
  } catch {
    return {};
  }
}
function saveState(patch: Partial<State>) {
  const next = { ...playtesterState(), ...patch };
  fs.writeFileSync(STATE(), JSON.stringify(next, null, 2));
  return next;
}

/** The playtester's own SSH key (made on first use). Returns the public key line. */
function ensureKey() {
  if (!fs.existsSync(KEY())) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', NAME, '-f', KEY()], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw fail(`Couldn't make an SSH key (ssh-keygen: ${r.stderr || r.error?.message}). Install OpenSSH.`);
  }
  lockKey(KEY());
  return fs.readFileSync(`${KEY()}.pub`, 'utf8').trim();
}

const clients = new Map<string, EC2Client>();
function ec2(region: string) {
  if (!clients.has(region)) clients.set(region, new EC2Client({ ...awsConfig(), region }));
  return clients.get(region)!;
}
const homeRegion = () => playtesterState().region ?? env('AWS_DEFAULT_REGION') ?? 'us-east-1';

type Found = { instance: any; region: string };

export async function findPlaytester(): Promise<Found | null> {
  const st = playtesterState();
  const region = st.region ?? homeRegion();
  const r = await ec2(region).send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Name', Values: [NAME] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'] },
    ],
  }));
  const all = (r.Reservations ?? []).flatMap((x) => x.Instances ?? []);
  const instance = all.find((i) => i.InstanceId === st.instanceId) ?? all[0];
  return instance ? { instance, region } : null;
}

export type PlaytesterStatus = {
  exists: boolean; id?: string; region?: string; type?: string; state?: string; ip?: string | null; pricePerHour: number;
  diskGb: number; diskPerMonth: number; idleMinutes?: number; stage?: { stage: string; detail?: string; time?: number } | null; launched?: string;
};

export async function playtesterStatus(): Promise<PlaytesterStatus> {
  const base = { pricePerHour: PLAYTESTER_TYPES[PLAYTESTER_DEFAULT_TYPE].price, diskGb: PLAYTESTER_DISK_GB, diskPerMonth: PLAYTESTER_DISK_PER_MONTH };
  const found = await findPlaytester();
  if (!found) return { exists: false, ...base };
  const i = found.instance;
  const out: PlaytesterStatus = {
    ...base, exists: true, id: i.InstanceId, region: found.region, type: i.InstanceType, state: i.State?.Name, ip: i.PublicIpAddress ?? null,
    pricePerHour: PLAYTESTER_TYPES[i.InstanceType]?.price ?? base.pricePerHour, idleMinutes: playtesterState().idleMinutes, launched: i.LaunchTime?.toISOString(), stage: null,
  };
  if (out.state === 'running' && out.ip) {
    try {
      const raw = await ssh('cat /var/lib/hawkes/status.json', { timeoutMs: 15_000, found });
      out.stage = JSON.parse(raw.trim());
      if (out.stage?.stage === 'ready') {
        const up = (await ssh(`ss -Hltn '( sport = :${PLAYTESTER_PORT} )' | grep -q . && echo up || echo down`, { timeoutMs: 15_000, found })).trim();
        if (up !== 'up') out.stage = { stage: 'starting', detail: 'the browser server is starting' };
      }
    } catch {
      out.stage = { stage: 'booting', detail: 'waiting for SSH (if this lasts, refresh access)' };
    }
  }
  return out;
}

async function ensureSecurityGroup(region: string, ip: string) {
  const vpcs = await ec2(region).send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }));
  const vpc = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpc) throw fail(`${region} has no default VPC.`);
  const found = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG] }, { Name: 'vpc-id', Values: [vpc] }] }));
  let sg: any = found.SecurityGroups?.[0];
  if (!sg) {
    const made = await ec2(region).send(new CreateSecurityGroupCommand({
      GroupName: SG, VpcId: vpc, Description: 'Hawkes Gen playtester: SSH from the developer and control server IPs only',
      TagSpecifications: [{ ResourceType: 'security-group', Tags: [{ Key: 'Project', Value: PROJECT }, { Key: 'Name', Value: SG }] }],
    }));
    sg = { GroupId: made.GroupId, IpPermissions: [] };
  }
  await allowOnly(region, sg, ip, [22]);
  return sg.GroupId as string;
}

/** Lets this machine's current IP (and HAWKES_ALLOW_IPS) in over SSH, and nobody else. */
export async function playtesterAccess() {
  const ip = await myIp();
  const region = homeRegion();
  const r = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG] }] }));
  for (const sg of r.SecurityGroups ?? []) await allowOnly(region, sg, ip, [22]);
  return { ip, region };
}

/** Creates the playtester. Costs money from here on: the disk always, the machine while it runs. */
export async function launchPlaytester({ type = PLAYTESTER_DEFAULT_TYPE, region = homeRegion(), idleMinutes = 20 } = {}) {
  if (!PLAYTESTER_TYPES[type]) throw fail(`Not a playtester type: ${type} (${Object.keys(PLAYTESTER_TYPES).join(', ')})`);
  if (await findPlaytester()) throw fail('There is already a playtester. Start it instead.');
  const { PW_VERSION, NODE_URL } = await import('../comfy/playtestHost.ts');
  const pub = ensureKey();
  const ip = await myIp();
  const script = fs.readFileSync(path.join(paths.server, 'playtester', 'bootstrap.sh'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replaceAll('__PUBKEY__', pub)
    .replaceAll('__IDLE_MINUTES__', String(Math.max(10, Math.min(240, Math.round(idleMinutes)))))
    .replaceAll('__PW_VERSION__', PW_VERSION)
    .replaceAll('__NODE_URL__', NODE_URL);
  const [sg, image] = await Promise.all([ensureSecurityGroup(region, ip), gpuImage(region)]);
  const tags = [{ Key: 'Project', Value: PROJECT }, { Key: 'Name', Value: NAME }, { Key: 'Role', Value: 'playtester' }];
  try {
    const res = await ec2(region).send(new RunInstancesCommand({
      ImageId: image.ImageId, InstanceType: type as any, MinCount: 1, MaxCount: 1, SecurityGroupIds: [sg],
      UserData: Buffer.from(script).toString('base64'),
      InstanceInitiatedShutdownBehavior: 'stop',
      BlockDeviceMappings: [{ DeviceName: image.RootDeviceName ?? '/dev/sda1', Ebs: { VolumeSize: PLAYTESTER_DISK_GB, VolumeType: 'gp3', Iops: 3000, Throughput: 125, DeleteOnTermination: true } }],
      TagSpecifications: [{ ResourceType: 'instance', Tags: tags }, { ResourceType: 'volume', Tags: tags }],
      MetadataOptions: { HttpTokens: 'required' },
    }));
    const id = res.Instances?.[0]?.InstanceId!;
    saveState({ instanceId: id, region, type, idleMinutes, launchedAt: new Date().toISOString() });
    return { id, region, type, image: image.Name, pricePerHour: PLAYTESTER_TYPES[type].price, diskPerMonth: PLAYTESTER_DISK_PER_MONTH };
  } catch (e: any) {
    const kind = classify(e);
    if (kind === 'quota') throw fail(`The account's G-instance quota in ${region} has no room for ${type} (${PLAYTESTER_TYPES[type].vcpus} vCPUs) next to the running GPU servers.`, 'quota');
    if (kind === 'capacity') throw fail(`AWS has no ${type} free in ${region} right now; try again later.`, 'capacity');
    throw fail(`Couldn't launch the playtester: ${e.name}: ${e.message}`, kind);
  }
}

async function requirePlaytester() {
  const f = await findPlaytester();
  if (!f) throw fail('There is no playtester yet. Launch one first (hawkesgen playtester launch).', 'missing');
  return f;
}

export async function startPlaytester() {
  const { instance: i, region } = await requirePlaytester();
  if (i.State?.Name === 'stopped') {
    await playtesterAccess();
    try {
      await ec2(region).send(new StartInstancesCommand({ InstanceIds: [i.InstanceId] }));
    } catch (e: any) {
      throw fail(`Couldn't start the playtester: ${e.name}: ${e.message}`, classify(e));
    }
  } else if (!['running', 'pending'].includes(i.State?.Name)) {
    throw fail(`The playtester is ${i.State?.Name}; wait for it, then start it.`);
  }
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Starts the playtester if needed and waits until its browser server answers. */
export async function ensurePlaytester(onStep: (s: string) => void = () => {}, timeoutMs = 15 * 60_000) {
  const end = Date.now() + timeoutMs;
  const first = await startPlaytester();
  if (first.was !== 'running') onStep('starting the playtester (T4 GPU)');
  for (;;) {
    const st = await playtesterStatus().catch(() => null);
    if (st?.state === 'running' && st.stage?.stage === 'ready') return { id: st.id!, region: st.region!, started: first.was !== 'running' };
    if (st?.stage?.stage === 'installing') onStep(`playtester: ${st.stage.detail ?? 'installing'}`);
    if (Date.now() > end) throw fail(`The playtester wasn't ready within ${Math.round(timeoutMs / 60_000)} minutes (${st?.state ?? '?'}, ${st?.stage?.stage ?? 'no answer'}).`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Stops the playtester (the disk stays: about $6/month). */
export async function stopPlaytester() {
  const { instance: i, region } = await requirePlaytester();
  if (['running', 'pending'].includes(i.State?.Name)) await ec2(region).send(new StopInstancesCommand({ InstanceIds: [i.InstanceId] }));
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Deletes the playtester and its disk. A new launch sets it up again (about 10 minutes). */
export async function terminatePlaytester() {
  const { instance: i, region } = await requirePlaytester();
  await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [i.InstanceId] }));
  saveState({ instanceId: undefined });
  fs.rmSync(KNOWN(), { force: true });
  return { id: i.InstanceId, region };
}

/** Sets how long it waits without a playtest before powering off (applies on the machine right away). */
export async function setPlaytesterIdle(minutes: number) {
  const m = Math.max(10, Math.min(240, Math.round(Number(minutes)) || 20));
  saveState({ idleMinutes: m });
  const f = await findPlaytester();
  if (f?.instance.State?.Name === 'running') await ssh(`echo ${m} | sudo tee /var/lib/hawkes/idle-minutes >/dev/null`, { found: f });
  return { idleMinutes: m };
}

// -------------------------------------------------------------------- ssh

/** The SSH options for the playtester. Its address changes on every start, so it has its own known-hosts file. */
export const sshOptions = () => ['-i', KEY(), '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${KNOWN()}`, '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15'];

/** Where to reach it: null unless it's running with its browser server ready. */
export async function playtesterTarget(): Promise<{ id: string; region: string; ip: string; user: string; args: string[] } | null> {
  const st = await playtesterStatus().catch(() => null);
  if (!st?.exists || st.state !== 'running' || st.stage?.stage !== 'ready' || !st.ip) return null;
  return { id: st.id!, region: st.region!, ip: st.ip, user: USER, args: sshOptions() };
}

const seen = new Map<string, string>();
/** A stopped-and-started machine gets a new address that may have been someone else's: forget the old entry once. */
function forgetIfNew(id: string, ip: string) {
  if (seen.get(id) === ip) return;
  seen.set(id, ip);
  if (fs.existsSync(KNOWN())) spawnSync('ssh-keygen', ['-R', ip, '-f', KNOWN()], { windowsHide: true, stdio: 'ignore' });
}

/** Runs a shell command on the playtester; resolves to its output. */
export async function ssh(command: string, { timeoutMs = 120_000, found }: { timeoutMs?: number; found?: Found | null } = {}): Promise<string> {
  ensureKey();
  const f = found ?? (await requirePlaytester());
  const ip = f.instance.PublicIpAddress;
  if (!ip || f.instance.State?.Name !== 'running') throw fail(`The playtester is ${f.instance.State?.Name}; start it first.`);
  forgetIfNew(f.instance.InstanceId, ip);
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshOptions(), `${USER}@${ip}`, command], { windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(fail(`Couldn't run ssh (${e.message}). Install OpenSSH.`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(fail(`ssh failed: ${(err || out).trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`));
    });
  });
}
