// The playtesters: small GPU machines (g4dn.xlarge, NVIDIA T4, about $0.53/hr) that only run a Playwright browser
// server, so game playtests from the Linux control server render on a real GPU instead of in software.
//
// Each is launched once (server/playtester/bootstrap.sh installs Node, Playwright and Chromium at first boot), then
// started and stopped: Hawkes Studio's daily run starts the first one before games are played and stops them when the
// run ends, a playtest starts a stopped one when the running ones are full, and each powers itself off after its idle
// time (nobody connected to its browser server). The browser server listens on 127.0.0.1:3600; playtests reach it
// through an SSH tunnel (playtestHost.ts). Each region's security group lets in SSH only, from this machine and
// HAWKES_ALLOW_IPS.
//
// There can be several (up to HAWKES_PLAYTESTERS_MAX, default 2), in any of the fleet's regions: every instance named
// hawkesgen-playtester is one. Each has lanes (how many browser tabs it plays at once, by type); a playtest claims
// lanes on one (claimPlaytester) for as long as it plays, so the queue (jobs.ts) admits only what fits.
//
// Local state (the first one's id and settings per machine, the SSH key, known hosts) lives in DATA_DIR/fleet/playtester*.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  EC2Client, DescribeInstancesCommand, DescribeVpcsCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
  RunInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { awsConfig, myIp, classify, lockKey, allowOnly, gpuImage, REGIONS } from '../comfy/fleet.ts';
import { env, paths } from '../../config.ts';
import { GenError } from '../../util.ts';

/** lanes: browser tabs played at once (measured: docs/playtest-video.md). */
export const PLAYTESTER_TYPES: Record<string, { vcpus: number; memory: number; gpu: string; price: number; lanes: number }> = {
  'g4dn.xlarge': { vcpus: 4, memory: 16, gpu: 'NVIDIA T4, 16 GB', price: 0.526, lanes: 2 },
  'g4dn.2xlarge': { vcpus: 8, memory: 32, gpu: 'NVIDIA T4, 16 GB', price: 0.752, lanes: 4 },
};
export const PLAYTESTER_DEFAULT_TYPE = 'g4dn.xlarge';
/** The GPU image's smallest root disk. */
export const PLAYTESTER_DISK_GB = 75;
export const PLAYTESTER_DISK_PER_MONTH = PLAYTESTER_DISK_GB * 0.08;
export const PLAYTESTER_PORT = 3600;
export const PLAYTESTERS_MAX = Math.max(1, Number(env('HAWKES_PLAYTESTERS_MAX') ?? 2) || 2);
const NAME = 'hawkesgen-playtester';
const PROJECT = 'hawkes-gen';
const SG = 'hawkesgen-playtester';
const USER = 'ubuntu';

const fail = (message: string, kind = 'playtester') => new GenError(message, { status: 409, kind });

type MachineState = { region?: string; type?: string; idleMinutes?: number; launchedAt?: string };
/** instanceId/region/...: the first playtester (as before); machines: every one's settings by instance id. */
type State = MachineState & { instanceId?: string; machines?: Record<string, MachineState> };
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
function machineState(id: string): MachineState {
  const st = playtesterState();
  return { ...(st.instanceId === id ? { region: st.region, type: st.type, idleMinutes: st.idleMinutes, launchedAt: st.launchedAt } : {}), ...(st.machines?.[id] ?? {}) };
}
function saveMachine(id: string, patch: MachineState) {
  const st = playtesterState();
  saveState({ machines: { ...(st.machines ?? {}), [id]: { ...(st.machines?.[id] ?? {}), ...patch } } });
}

/** The playtesters' own SSH key (made on first use, the same for all). Returns the public key line. */
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
/** Where playtesters are looked for: the home region first, then the fleet's. */
const regions = () => [...new Set([homeRegion(), ...REGIONS, ...Object.values(playtesterState().machines ?? {}).map((m) => m.region).filter(Boolean) as string[]])];

type Found = { instance: any; region: string };
const ALIVE = ['pending', 'running', 'stopping', 'stopped', 'shutting-down'];

let listed: { at: number; list: Found[] } | null = null;
/** Every playtester (EC2 Describe in each region; cached 15 s), the first one first. */
export async function listPlaytesters({ fresh = false } = {}): Promise<Found[]> {
  if (!fresh && listed && Date.now() - listed.at < 15_000) return listed.list;
  const first = playtesterState().instanceId;
  const found = await Promise.all(regions().map(async (region) => {
    try {
      const r = await ec2(region).send(new DescribeInstancesCommand({ Filters: [{ Name: 'tag:Name', Values: [NAME] }, { Name: 'instance-state-name', Values: ALIVE }] }));
      return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((instance) => ({ instance, region }));
    } catch (e) {
      // The home region must answer; another region that can't (no access) has none for us.
      if (region === homeRegion()) throw e;
      return [];
    }
  }));
  const list = found.flat().sort((a, b) => Number(b.instance.InstanceId === first) - Number(a.instance.InstanceId === first) || String(a.instance.LaunchTime).localeCompare(String(b.instance.LaunchTime)));
  listed = { at: Date.now(), list };
  return list;
}
const forget = () => { listed = null; };

/** The first playtester, or the one with this id. */
export async function findPlaytester(id?: string): Promise<Found | null> {
  const list = await listPlaytesters({ fresh: true });
  return (id ? list.find((f) => f.instance.InstanceId === id) : list[0]) ?? null;
}

export const lanesOf = (type?: string | null) => PLAYTESTER_TYPES[type ?? '']?.lanes ?? PLAYTESTER_TYPES[PLAYTESTER_DEFAULT_TYPE].lanes;

export type PlaytesterStatus = {
  exists: boolean; id?: string; region?: string; type?: string; state?: string; ip?: string | null; pricePerHour: number;
  diskGb: number; diskPerMonth: number; idleMinutes?: number; stage?: { stage: string; detail?: string; time?: number } | null; launched?: string;
  /** Browser tabs it plays at once, and how many playtests have claimed now. */
  lanes?: number; inUse?: number;
};

const base = () => ({ pricePerHour: PLAYTESTER_TYPES[PLAYTESTER_DEFAULT_TYPE].price, diskGb: PLAYTESTER_DISK_GB, diskPerMonth: PLAYTESTER_DISK_PER_MONTH });

async function statusOf(found: Found): Promise<PlaytesterStatus> {
  const i = found.instance;
  const out: PlaytesterStatus = {
    ...base(), exists: true, id: i.InstanceId, region: found.region, type: i.InstanceType, state: i.State?.Name, ip: i.PublicIpAddress ?? null,
    pricePerHour: PLAYTESTER_TYPES[i.InstanceType]?.price ?? base().pricePerHour, idleMinutes: machineState(i.InstanceId).idleMinutes, launched: i.LaunchTime?.toISOString(), stage: null,
    lanes: lanesOf(i.InstanceType), inUse: claimed.get(i.InstanceId) ?? 0,
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
  if (out.stage?.stage === 'ready') readyAt.set(out.id!, Date.now());
  else readyAt.delete(out.id!);
  return out;
}

/** The first playtester's status (or this one's). */
export async function playtesterStatus(id?: string): Promise<PlaytesterStatus> {
  const found = await findPlaytester(id);
  return found ? statusOf(found) : { exists: false, ...base() };
}

/** Every playtester's status, and the lanes in all. */
export async function playtestersStatus() {
  const machines = await Promise.all((await listPlaytesters({ fresh: true })).map((f) => statusOf(f)));
  return { machines, max: PLAYTESTERS_MAX, lanes: machines.reduce((a, m) => a + (m.lanes ?? 0), 0), inUse: machines.reduce((a, m) => a + (m.inUse ?? 0), 0) };
}

/** Lanes on every playtester that exists (running or not): what the queue may admit to them. Cached; no SSH. */
export async function playtesterCapacity(): Promise<{ machines: number; lanes: number }> {
  const list = await listPlaytesters().catch(() => [] as Found[]);
  const usable = list.filter((f) => f.instance.State?.Name !== 'shutting-down');
  return { machines: usable.length, lanes: usable.reduce((a, f) => a + lanesOf(f.instance.InstanceType), 0) };
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

/** Lets this machine's current IP (and HAWKES_ALLOW_IPS) in over SSH, and nobody else, in every region with a playtester. */
export async function playtesterAccess() {
  const ip = await myIp();
  const where = [...new Set([homeRegion(), ...(await listPlaytesters({ fresh: true })).map((f) => f.region)])];
  for (const region of where) {
    const r = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG] }] }));
    for (const sg of r.SecurityGroups ?? []) await allowOnly(region, sg, ip, [22]);
  }
  return { ip, region: homeRegion(), regions: where };
}

/** Creates a playtester (up to PLAYTESTERS_MAX). Costs money from here on: the disk always, the machine while it runs. */
export async function launchPlaytester({ type = PLAYTESTER_DEFAULT_TYPE, region = homeRegion(), idleMinutes = 20 } = {}) {
  if (!PLAYTESTER_TYPES[type]) throw fail(`Not a playtester type: ${type} (${Object.keys(PLAYTESTER_TYPES).join(', ')})`);
  const have = await listPlaytesters({ fresh: true });
  if (have.length >= PLAYTESTERS_MAX) throw fail(`There ${have.length === 1 ? 'is already a playtester' : `are already ${have.length} playtesters`} (the most: ${PLAYTESTERS_MAX}, HAWKES_PLAYTESTERS_MAX). Start one instead.`);
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
    const settings = { region, type, idleMinutes, launchedAt: new Date().toISOString() };
    // The first one keeps its place in the old fields (Studio and older code read them).
    if (!have.length) saveState({ instanceId: id, ...settings });
    saveMachine(id, settings);
    forget();
    return { id, region, type, image: image.Name, pricePerHour: PLAYTESTER_TYPES[type].price, diskPerMonth: PLAYTESTER_DISK_PER_MONTH, playtesters: have.length + 1 };
  } catch (e: any) {
    const kind = classify(e);
    if (kind === 'quota') throw fail(`The account's G-instance quota in ${region} has no room for ${type} (${PLAYTESTER_TYPES[type].vcpus} vCPUs) next to the running GPU servers.`, 'quota');
    if (kind === 'capacity') throw fail(`AWS has no ${type} free in ${region} right now; try again later.`, 'capacity');
    throw fail(`Couldn't launch the playtester: ${e.name}: ${e.message}`, kind);
  }
}

async function requirePlaytester(id?: string) {
  const f = await findPlaytester(id);
  if (!f) throw fail(id ? `No playtester ${id}.` : 'There is no playtester yet. Launch one first (hawkesgen playtester launch).', 'missing');
  return f;
}

/** Starts a playtester (the first one, or this one). */
export async function startPlaytester(id?: string) {
  const { instance: i, region } = await requirePlaytester(id);
  if (i.State?.Name === 'stopped') {
    await playtesterAccess();
    try {
      await ec2(region).send(new StartInstancesCommand({ InstanceIds: [i.InstanceId] }));
    } catch (e: any) {
      throw fail(`Couldn't start the playtester ${i.InstanceId}: ${e.name}: ${e.message}`, classify(e));
    }
    forget();
  } else if (!['running', 'pending'].includes(i.State?.Name)) {
    throw fail(`The playtester ${i.InstanceId} is ${i.State?.Name}; wait for it, then start it.`);
  }
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Starts a playtester (the first, or this one) if needed and waits until its browser server answers. */
export async function ensurePlaytester(onStep: (s: string) => void = () => {}, timeoutMs = 15 * 60_000, id?: string) {
  const end = Date.now() + timeoutMs;
  // Caught mid idle-stop: EC2 can't start a stopping machine, so wait for the stop to finish, then start it again
  // (falling back to software on the control server instead once froze it with two games rendering on 2 CPUs).
  for (;;) {
    const { instance: i } = await requirePlaytester(id);
    if (i.State?.Name !== 'stopping') break;
    onStep('the playtester is powering off after its idle time; starting it again once it has');
    if (Date.now() > end) throw fail('The playtester was still powering off; try again in a minute.');
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const first = await startPlaytester(id);
  if (first.was !== 'running') onStep(`starting the playtester ${first.id} (T4 GPU, ${first.region})`);
  for (;;) {
    const st = await playtesterStatus(first.id).catch(() => null);
    if (st?.state === 'running' && st.stage?.stage === 'ready') return { id: st.id!, region: st.region!, started: first.was !== 'running' };
    if (st?.stage?.stage === 'installing') onStep(`playtester: ${st.stage.detail ?? 'installing'}`);
    if (Date.now() > end) throw fail(`The playtester ${first.id} wasn't ready within ${Math.round(timeoutMs / 60_000)} minutes (${st?.state ?? '?'}, ${st?.stage?.stage ?? 'no answer'}).`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Stops a playtester, or every one (their disks stay: about $6/month each). */
export async function stopPlaytester(id?: string) {
  const list = id ? [await requirePlaytester(id)] : await listPlaytesters({ fresh: true });
  if (!list.length) throw fail('There is no playtester yet. Launch one first (hawkesgen playtester launch).', 'missing');
  const out: { id: string; region: string; was: string }[] = [];
  for (const { instance: i, region } of list) {
    if (['running', 'pending'].includes(i.State?.Name)) await ec2(region).send(new StopInstancesCommand({ InstanceIds: [i.InstanceId] }));
    out.push({ id: i.InstanceId, region, was: i.State?.Name });
  }
  forget();
  // One machine answers as before.
  return list.length === 1 ? out[0] : { stopped: out };
}

/** Deletes a playtester and its disk (the id is needed when there are several). A new launch sets it up again (about 10 minutes). */
export async function terminatePlaytester(id?: string) {
  if (!id && (await listPlaytesters({ fresh: true })).length > 1) throw fail('There are several playtesters: say which (id).');
  const { instance: i, region } = await requirePlaytester(id);
  await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [i.InstanceId] }));
  const st = playtesterState();
  const machines = { ...(st.machines ?? {}) };
  delete machines[i.InstanceId];
  saveState({ machines, ...(st.instanceId === i.InstanceId ? { instanceId: undefined } : {}) });
  forget();
  return { id: i.InstanceId, region };
}

/** Sets how long a playtester (or every one) waits without a playtest before powering off (applies on the machine right away). */
export async function setPlaytesterIdle(minutes: number, id?: string) {
  const m = Math.max(10, Math.min(240, Math.round(Number(minutes)) || 20));
  const list = id ? [await requirePlaytester(id)] : await listPlaytesters({ fresh: true });
  if (!id) saveState({ idleMinutes: m });
  for (const f of list) {
    saveMachine(f.instance.InstanceId, { idleMinutes: m });
    if (f.instance.State?.Name === 'running') await ssh(`echo ${m} | sudo tee /var/lib/hawkes/idle-minutes >/dev/null`, { found: f });
  }
  return { idleMinutes: m };
}

// ---------------------------------------------------------------- claiming lanes

/** Lanes claimed per playtester by the playtests playing on it now. */
const claimed = new Map<string, number>();
/** When each was last seen ready (its status checked over SSH): a claim within a minute trusts it. */
const readyAt = new Map<string, number>();

export type Target = { id: string; region: string; ip: string; user: string; args: string[] };
export type Claim = { target: Target; lanes: number; release: () => void };

const room = (f: Found) => lanesOf(f.instance.InstanceType) - (claimed.get(f.instance.InstanceId) ?? 0);
/** A playtest of `tabs` tabs fits when the room is there, or when a machine is empty and the playtest is bigger than it. */
const fits = (f: Found, tabs: number) => room(f) >= Math.min(tabs, lanesOf(f.instance.InstanceType));

function hold(id: string, n: number) {
  claimed.set(id, (claimed.get(id) ?? 0) + n);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (claimed.get(id) ?? 0) - n;
    if (left > 0) claimed.set(id, left);
    else claimed.delete(id);
  };
}

async function targetOf(f: Found): Promise<Target | null> {
  const i = f.instance;
  if (i.State?.Name !== 'running' || !i.PublicIpAddress) return null;
  const fresh = (readyAt.get(i.InstanceId) ?? 0) > Date.now() - 60_000;
  if (!fresh) {
    const st = await statusOf(f).catch(() => null);
    if (st?.stage?.stage !== 'ready') return null;
  }
  return { id: i.InstanceId, region: f.region, ip: i.PublicIpAddress, user: USER, args: sshOptions() };
}

/**
 * Claims lanes on a playtester for a playtest of `tabs` browser tabs: a ready one with room (the busiest that fits, so
 * the others can go idle and power off), else, when `start` is set, a stopped or starting one, which it starts and waits
 * for. The claim is made before any wait, so playtests starting together spread out. Null when none can take it.
 */
export async function claimPlaytester(tabs = 1, { start = false, onStep = (_s: string) => {} } = {}): Promise<Claim | null> {
  const list = await listPlaytesters().catch(() => [] as Found[]);
  const running = list.filter((f) => f.instance.State?.Name === 'running').sort((a, b) => room(a) - room(b));
  for (const f of running) {
    if (!fits(f, tabs)) continue;
    const n = Math.min(tabs, lanesOf(f.instance.InstanceType));
    const release = hold(f.instance.InstanceId, n);
    const target = await targetOf(f).catch(() => null);
    if (target) return { target, lanes: n, release };
    release();
  }
  if (!start) return null;
  // Starting ones first (already on their way), then stopped ones.
  const order = (f: Found) => ({ pending: 0, running: 0, stopping: 1, stopped: 2 } as Record<string, number>)[f.instance.State?.Name] ?? 3;
  const startable = list.filter((f) => ['pending', 'running', 'stopping', 'stopped'].includes(f.instance.State?.Name) && fits(f, tabs)).sort((a, b) => order(a) - order(b));
  for (const f of startable) {
    const n = Math.min(tabs, lanesOf(f.instance.InstanceType));
    const release = hold(f.instance.InstanceId, n);
    try {
      await ensurePlaytester(onStep, 15 * 60_000, f.instance.InstanceId);
      const target = await targetOf((await findPlaytester(f.instance.InstanceId)) ?? f);
      if (target) return { target, lanes: n, release };
      release();
    } catch (e: any) {
      release();
      onStep(`the playtester ${f.instance.InstanceId} didn't start (${e.message})`);
    }
  }
  return null;
}

// -------------------------------------------------------------------- ssh

/** The SSH options for the playtesters. Their addresses change on every start, so they have their own known-hosts file. */
export const sshOptions = () => ['-i', KEY(), '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${KNOWN()}`, '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15'];

/** Where to reach the first ready playtester (no lanes claimed): null unless one is running with its browser server ready. */
export async function playtesterTarget(): Promise<Target | null> {
  for (const f of await listPlaytesters({ fresh: true }).catch(() => [] as Found[])) {
    const t = await targetOf(f).catch(() => null);
    if (t) return t;
  }
  return null;
}

const seen = new Map<string, string>();
/** A stopped-and-started machine gets a new address that may have been someone else's: forget the old entry once. */
function forgetIfNew(id: string, ip: string) {
  if (seen.get(id) === ip) return;
  seen.set(id, ip);
  if (fs.existsSync(KNOWN())) spawnSync('ssh-keygen', ['-R', ip, '-f', KNOWN()], { windowsHide: true, stdio: 'ignore' });
}

/** Runs a shell command on a playtester (the first, this id, or this found one); resolves to its output. */
export async function ssh(command: string, { timeoutMs = 120_000, found, id }: { timeoutMs?: number; found?: Found | null; id?: string } = {}): Promise<string> {
  ensureKey();
  const f = found ?? (await requirePlaytester(id));
  const ip = f.instance.PublicIpAddress;
  if (!ip || f.instance.State?.Name !== 'running') throw fail(`The playtester ${f.instance.InstanceId} is ${f.instance.State?.Name}; start it first.`);
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
