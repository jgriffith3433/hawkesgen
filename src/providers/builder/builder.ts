// The Unity build server: one Windows machine on AWS that builds J's Unity games for WebGL.
//
// Why a server that stays: Unity spends most of a clean build re-importing everything into
// Library/. The server keeps every project's Library between builds (it's stopped, not deleted,
// when idle), so a build only re-imports what changed.
//
// How a build works (runBuild):
//   1. Sync: upload only the files that changed since the last build (size + modified time,
//      compared with what was sent last time), for the Unity project, its website folder and any
//      local file: packages. The server mirrors C:\Projects, so the projects' own build scripts
//      (which write to C:\Projects\<site>\Game\v<n>) work unchanged.
//   2. Build: run Unity in batch mode with the project's own deploy method, detached from SSH
//      (server/builder/build.ps1), and follow its log.
//   3. Pull back: download what the build changed in the website folder (the new Game/v<n>, the
//      page update) into J's checkout. Nothing is committed or pushed.
//
// Windows, not Linux: Unity Personal licenses can only be activated by signing in to Unity Hub,
// so J signs in once over Remote Desktop. Access is SSH (key) and RDP, both from this PC's IP only.
// It powers itself off after idleMinutes with no build and nobody signed in.
// Local state (instance, SSH key, the Remote Desktop password, sync manifests) is in DATA_DIR/builder.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  EC2Client, DescribeImagesCommand, DescribeInstancesCommand, DescribeVpcsCommand, DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand, RunInstancesCommand,
  StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { awsConfig, myIp, classify, lockKey, allowOnly as fleetAllowOnly } from '../comfy/fleet.ts';
import { env, paths } from '../../config.ts';
import { GenError } from '../../util.ts';
import { parsePoll, pollLengthOf, type PollAnswer } from './poll.ts';
import { fetchOrigin, repoIsPrivate, withRepoLock } from './gitfetch.ts';
import { rdpText } from './rdp.ts';

/** Windows on-demand prices (US East), for estimates. */
export const BUILDER_TYPES: Record<string, { vcpus: number; memory: number; price: number }> = {
  'm7i.xlarge': { vcpus: 4, memory: 16, price: 0.386 },
  'm7i.2xlarge': { vcpus: 8, memory: 32, price: 0.771 },
  'c7i.4xlarge': { vcpus: 16, memory: 32, price: 1.45 },
  'm7i.4xlarge': { vcpus: 16, memory: 64, price: 1.542 },
};
export const BUILDER_DEFAULT_TYPE = 'm7i.2xlarge';
export const BUILDER_DISK_GB = 300;
export const BUILDER_DISK_PER_MONTH = BUILDER_DISK_GB * 0.08;
const NAME = 'hawkesgen-builder';
const PROJECT = 'hawkes-gen';
const SG = 'hawkesgen-builder';
const USER = 'Administrator';
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Top-level folders never sent to the server. Unity makes these itself (Library is the point of the server). */
export const UNITY_EXCLUDE = ['Library', 'Temp', 'Logs', 'obj', 'UserSettings', 'Build', 'Builds', 'ServerData', 'MemoryCaptures', 'Recordings', '.git', '.vs', '.vscode', '.idea', '.utmp', '.hawkes'];
export const SITE_EXCLUDE = ['.git', 'node_modules', '.venv', '__pycache__'];

const fail = (message: string, kind = 'builder') => new GenError(message, { status: 409, kind });

// ------------------------------------------------------------ local state

type BuilderState = { instanceId?: string; region?: string; type?: string; password?: string; idleMinutes?: number; launchedAt?: string; unity?: string[] };
const STATE = () => path.join(paths.builder, 'state.json');
const KEY = () => path.join(paths.builder, 'builder_ed25519');
const MANIFESTS = () => path.join(paths.builder, 'manifests');

export function builderState(): BuilderState {
  try {
    return JSON.parse(fs.readFileSync(STATE(), 'utf8'));
  } catch {
    return {};
  }
}
function saveBuilderState(patch: Partial<BuilderState>) {
  const next = { ...builderState(), ...patch };
  fs.writeFileSync(STATE(), JSON.stringify(next, null, 2));
  return next;
}

/** The SSH key for the build server (made on first use). Returns the public key line. */
function ensureKey() {
  if (!fs.existsSync(KEY())) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hawkesgen-builder', '-f', KEY()], { windowsHide: true, encoding: 'utf8' });
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
const homeRegion = () => builderState().region ?? env('AWS_DEFAULT_REGION') ?? 'us-east-1';

// ---------------------------------------------------------------- server

type Found = { instance: any; region: string };

export async function findBuilder(): Promise<Found | null> {
  const st = builderState();
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

export type BuilderStatus = {
  exists: boolean; id?: string; region?: string; type?: string; state?: string; ip?: string | null; pricePerHour: number;
  diskGb: number; diskPerMonth: number; idleMinutes?: number; stage?: { stage: string; detail?: string; time?: number } | null;
  rdpFile?: string | null; passwordFile?: string | null; launched?: string; types: typeof BUILDER_TYPES;
};

export async function builderStatus(): Promise<BuilderStatus> {
  const base = { pricePerHour: BUILDER_TYPES[BUILDER_DEFAULT_TYPE].price, diskGb: BUILDER_DISK_GB, diskPerMonth: BUILDER_DISK_PER_MONTH, types: BUILDER_TYPES };
  const found = await findBuilder();
  if (!found) return { exists: false, ...base };
  const i = found.instance;
  const st = builderState();
  const out: BuilderStatus = {
    ...base, exists: true, id: i.InstanceId, region: found.region, type: i.InstanceType, state: i.State?.Name, ip: i.PublicIpAddress ?? null,
    pricePerHour: BUILDER_TYPES[i.InstanceType]?.price ?? base.pricePerHour, idleMinutes: st.idleMinutes, launched: i.LaunchTime?.toISOString(), stage: null,
    rdpFile: fs.existsSync(rdpPath()) ? rdpPath() : null, passwordFile: fs.existsSync(passwordPath()) ? passwordPath() : null,
  };
  if (out.state === 'running' && out.ip) {
    try {
      const raw = await ssh('Get-Content C:\\hawkes\\status.json -Raw', { timeoutMs: 15_000, found });
      out.stage = JSON.parse(raw.trim());
    } catch {
      out.stage = { stage: 'booting', detail: 'waiting for SSH (Windows takes a few minutes to boot; if this lasts, refresh access)' };
    }
  }
  return out;
}

async function windowsImage(region: string) {
  const r = await ec2(region).send(new DescribeImagesCommand({
    Owners: ['amazon'],
    Filters: [{ Name: 'name', Values: ['Windows_Server-2022-English-Full-Base-*'] }, { Name: 'state', Values: ['available'] }, { Name: 'architecture', Values: ['x86_64'] }],
  }));
  const img = (r.Images ?? []).sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))[0];
  if (!img) throw fail(`No Windows Server 2022 image found in ${region}.`);
  return img;
}

async function ensureSecurityGroup(region: string, ip: string) {
  const vpcs = await ec2(region).send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }));
  const vpc = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpc) throw fail(`${region} has no default VPC.`);
  const found = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG] }, { Name: 'vpc-id', Values: [vpc] }] }));
  let sg: any = found.SecurityGroups?.[0];
  if (!sg) {
    const made = await ec2(region).send(new CreateSecurityGroupCommand({
      GroupName: SG, VpcId: vpc, Description: 'Hawkes Gen Unity build server: SSH and Remote Desktop from the developer IP only',
      TagSpecifications: [{ ResourceType: 'security-group', Tags: [{ Key: 'Project', Value: PROJECT }, { Key: 'Name', Value: SG }] }],
    }));
    sg = { GroupId: made.GroupId, IpPermissions: [] };
  }
  await allowOnly(region, sg, ip);
  return sg.GroupId as string;
}

async function allowOnly(region: string, sg: any, ip: string) {
  // The same rule as the GPU fleet's (this machine and HAWKES_ALLOW_IPS), for SSH and Remote Desktop.
  await fleetAllowOnly(region, sg, ip, [22, 3389]);
}

/** Lets an IP in (SSH and Remote Desktop) and nobody else but HAWKES_ALLOW_IPS: the caller's, else this machine's. */
export async function builderAccess(forIp?: string) {
  const ip = forIp ?? await myIp();
  const region = homeRegion();
  const r = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SG] }] }));
  for (const sg of r.SecurityGroups ?? []) await allowOnly(region, sg, ip);
  return { ip, region };
}

/** The changeset of a Unity version installed on this PC (from its modules.json), for the server's installer. */
export function unityChangeset(version: string) {
  // UNITY_CHANGESETS ({"6000.3.7f1": "696ec25a53d1"}) where Unity isn't installed, e.g. the Linux server.
  const known = (() => { try { return JSON.parse(env('UNITY_CHANGESETS') ?? '{}'); } catch { return {}; } })();
  if (known[version]) return known[version] as string;
  const file = path.join('C:\\Program Files\\Unity\\Hub\\Editor', version, 'modules.json');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const m = text.match(/download_unity\/([0-9a-f]{12})\//);
  if (!m) throw fail(`Unity ${version} isn't installed on this PC, so its changeset is unknown. Install it in Unity Hub first.`);
  return m[1];
}

function newPassword() {
  // Windows wants upper, lower, digit and symbol.
  return `Hk#${crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'x')}9z`;
}

/** Creates the build server. Costs money from here on (see BUILDER_TYPES, plus the disk). */
export async function launchBuilder({ type = BUILDER_DEFAULT_TYPE, region = homeRegion(), idleMinutes = 30, unity = '6000.3.7f1' } = {}) {
  if (!BUILDER_TYPES[type]) throw fail(`Not a build server type: ${type} (${Object.keys(BUILDER_TYPES).join(', ')})`);
  if (await findBuilder()) throw fail('There is already a build server. Start it instead.');
  const pub = ensureKey();
  const ip = await myIp();
  const changeset = unityChangeset(unity);
  const password = newPassword();
  const script = fs.readFileSync(path.join(paths.server, 'builder', 'bootstrap.ps1'), 'utf8')
    .replaceAll('__PUBKEY__', pub)
    .replaceAll('__PASSWORD__', password)
    .replaceAll('__IDLE_MINUTES__', String(idleMinutes))
    .replaceAll('__UNITY_VERSION__', unity)
    .replaceAll('__CHANGESET__', changeset);
  const userData = Buffer.from(script).toString('base64');
  if (userData.length > 16384) throw fail('The build server setup script is over EC2\'s 16 KB user-data limit.');
  const [sg, image] = await Promise.all([ensureSecurityGroup(region, ip), windowsImage(region)]);
  const tags = [{ Key: 'Project', Value: PROJECT }, { Key: 'Name', Value: NAME }, { Key: 'Role', Value: 'unity-builder' }];
  try {
    const res = await ec2(region).send(new RunInstancesCommand({
      ImageId: image.ImageId, InstanceType: type as any, MinCount: 1, MaxCount: 1, SecurityGroupIds: [sg], UserData: userData,
      InstanceInitiatedShutdownBehavior: 'stop',
      BlockDeviceMappings: [{ DeviceName: image.RootDeviceName ?? '/dev/sda1', Ebs: { VolumeSize: BUILDER_DISK_GB, VolumeType: 'gp3', Iops: 3000, Throughput: 125, DeleteOnTermination: true } }],
      TagSpecifications: [{ ResourceType: 'instance', Tags: tags }, { ResourceType: 'volume', Tags: tags }],
      MetadataOptions: { HttpTokens: 'required' },
    }));
    const id = res.Instances?.[0]?.InstanceId!;
    saveBuilderState({ instanceId: id, region, type, password, idleMinutes, launchedAt: new Date().toISOString(), unity: [unity] });
    fs.writeFileSync(passwordPath(), password + '\n', { mode: 0o600 });
    lockKey(passwordPath());
    return { id, region, type, image: image.Name, pricePerHour: BUILDER_TYPES[type].price };
  } catch (e: any) {
    const kind = classify(e);
    if (kind === 'quota') throw fail(`The account's on-demand quota for standard instances in ${region} is too low for ${type} (${BUILDER_TYPES[type].vcpus} vCPUs). Request more "Running On-Demand Standard instances" quota, or use a smaller type.`, 'quota');
    throw fail(`Couldn't launch the build server: ${e.name}: ${e.message}`, kind);
  }
}

async function requireBuilder() {
  const f = await findBuilder();
  if (!f) throw fail('There is no build server yet. Launch one first (hawkesgen builder launch).');
  return f;
}

export async function startBuilder(forIp?: string) {
  const { instance: i, region } = await requireBuilder();
  await builderAccess(forIp);
  if (i.State?.Name === 'stopped') {
    try {
      await ec2(region).send(new StartInstancesCommand({ InstanceIds: [i.InstanceId] }));
    } catch (e: any) {
      throw fail(`Couldn't start the build server: ${e.name}: ${e.message}`, classify(e));
    }
  } else if (!['running', 'pending'].includes(i.State?.Name)) {
    throw fail(`The build server is ${i.State?.Name}; wait for it, then start it.`);
  }
  return { id: i.InstanceId, region, was: i.State?.Name };
}

export async function stopBuilder() {
  const { instance: i, region } = await requireBuilder();
  if (['running', 'pending'].includes(i.State?.Name)) await ec2(region).send(new StopInstancesCommand({ InstanceIds: [i.InstanceId] }));
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Deletes the build server and its disk (every project's Library: the next build is a clean one). */
export async function terminateBuilder() {
  const { instance: i, region } = await requireBuilder();
  await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [i.InstanceId] }));
  saveBuilderState({ instanceId: undefined, password: undefined });
  fs.rmSync(MANIFESTS(), { recursive: true, force: true });
  for (const f of [rdpPath(), passwordPath()]) fs.rmSync(f, { force: true });
  return { id: i.InstanceId, region };
}

/** Sets how long the server waits idle before powering off (applies on the server right away). */
export async function setBuilderIdle(minutes: number) {
  const m = Math.max(10, Math.min(240, Math.round(Number(minutes)) || 30));
  saveBuilderState({ idleMinutes: m });
  const f = await findBuilder();
  if (f?.instance.State?.Name === 'running') await ssh(`Set-Content C:\\hawkes\\idle-minutes '${m}'`, { found: f });
  return { idleMinutes: m };
}

const rdpPath = () => path.join(paths.builder, 'hawkes-builder.rdp');
const passwordPath = () => path.join(paths.builder, 'remote-desktop-password.txt');

/** Writes a Remote Desktop file for the server (the password is in a file next to it, never printed). */
export async function builderRdp() {
  const { instance: i } = await requireBuilder();
  if (!i.PublicIpAddress) throw fail('The build server has no address until it runs. Start it first.');
  await builderAccess();
  fs.writeFileSync(rdpPath(), rdpText(i.PublicIpAddress, USER));
  return { rdpFile: rdpPath(), passwordFile: passwordPath(), user: USER, ip: i.PublicIpAddress };
}

type RdpDeps = { find: () => Promise<Found | null>; access: (ip?: string) => Promise<unknown> };

/**
 * The Remote Desktop file for the web UI, built for the server's current public address. Lets the caller's IP in first
 * (also while the server is stopped, so it works once started). Starts nothing: a server that isn't running comes back
 * as { ready: false, state } for the UI to offer Start.
 */
export async function builderRdpDownload(forIp?: string, deps: RdpDeps = { find: findBuilder, access: builderAccess }) {
  const found = await deps.find();
  if (!found) throw fail('There is no build server yet. Launch one first (hawkesgen builder launch).');
  const i = found.instance;
  const state = String(i.State?.Name ?? 'unknown');
  await deps.access(forIp);
  if (state !== 'running' || !i.PublicIpAddress) return { ready: false as const, state, id: i.InstanceId as string };
  return { ready: true as const, state, id: i.InstanceId as string, ip: i.PublicIpAddress as string, user: USER, filename: 'hawkes-builder.rdp', content: rdpText(i.PublicIpAddress, USER) };
}

/** The Administrator password (owner only: the route checks). Never log it. */
export function builderPassword() {
  let password = builderState().password;
  if (!password) {
    try { password = fs.readFileSync(passwordPath(), 'utf8').trim(); } catch { /* none */ }
  }
  if (!password) throw fail('The build server\'s password isn\'t saved on this machine.');
  return { user: USER, password };
}

// -------------------------------------------------------------------- ssh

async function addressOf(found?: Found | null) {
  const f = found ?? (await requireBuilder());
  const ip = f.instance.PublicIpAddress;
  if (!ip || f.instance.State?.Name !== 'running') throw fail(`The build server is ${f.instance.State?.Name}; start it first.`);
  return ip as string;
}

const sshBase = () => ['-i', KEY(), '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(paths.builder, 'known_hosts')}`, '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15'];

function proc(cmd: string, args: string[], timeoutMs: number, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(fail(`Couldn't run ${cmd} (${e.message}). Install OpenSSH.`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(fail(`${what} failed: ${(err || out).trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`));
    });
  });
}

/** Runs PowerShell on the build server; resolves to its output. */
export async function ssh(command: string, { timeoutMs = 120_000, found }: { timeoutMs?: number; found?: Found | null } = {}) {
  ensureKey();
  const ip = await addressOf(found);
  return proc('ssh', [...sshBase(), `${USER}@${ip}`, command], timeoutMs, 'ssh');
}

async function scpUp(files: string[], remoteDir: string, timeoutMs = 3_600_000) {
  const ip = await addressOf();
  return proc('scp', [...sshBase(), '-q', ...files, `${USER}@${ip}:${remoteDir.replace(/\\/g, '/')}`], timeoutMs, 'upload');
}

async function scpDown(remote: string, local: string, timeoutMs = 3_600_000) {
  const ip = await addressOf();
  return proc('scp', [...sshBase(), '-q', `${USER}@${ip}:${remote.replace(/\\/g, '/')}`, local], timeoutMs, 'download');
}

/** Waits until SSH answers (after a start), up to timeoutMs. */
export async function waitForBuilder(onStep: (s: string) => void = () => {}, timeoutMs = 20 * 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const f = await findBuilder();
    if (f?.instance.State?.Name === 'running' && f.instance.PublicIpAddress) {
      try {
        const raw = await ssh('Get-Content C:\\hawkes\\status.json -Raw', { timeoutMs: 15_000, found: f });
        return JSON.parse(raw.trim()) as { stage: string; detail?: string };
      } catch {
        onStep('build server: waiting for Windows to boot');
      }
    } else {
      onStep(`build server: ${f?.instance.State?.Name ?? 'missing'}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw fail('The build server did not answer within 20 minutes.');
}

// ------------------------------------------------------------------- sync

type Manifest = Record<string, [number, number]>;

/**
 * Files under C:\Projects\<root> (relative to C:\Projects, forward slashes) with size and modified time. `from` is a
 * local folder standing in for the root (an agent change's worktree, a scratch copy of a site); keys stay <root>/...
 */
export function walk(root: string, exclude: string[], from?: string): Manifest {
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const out: Manifest = {};
  const top = from ?? path.join(paths.projects, root);
  if (!fs.existsSync(top)) return out;
  const visit = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (depth === 0 && skip.has(e.name.toLowerCase())) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.isFile()) {
        const s = fs.statSync(full);
        out[`${root}/${path.relative(top, full).replace(/\\/g, '/')}`] = [s.size, Math.round(s.mtimeMs)];
      }
    }
  };
  visit(top, 0);
  return out;
}

/** Where a <root>/... key is on this machine. */
const localFile = (root: string, key: string, from?: string) => (from ? path.join(from, key.slice(root.length + 1)) : path.join(paths.projects, key));

/** A folder to run tar in so <root>/... names read from `from`: <tmp>/<root> is a link to it. */
function tarBase(root: string, from: string | undefined, tmp: string) {
  if (!from) return paths.projects;
  const base = path.join(tmp, 'base');
  const link = path.join(base, root);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.resolve(from), link, process.platform === 'win32' ? 'junction' : 'dir');
  return base;
}

/** Removes tarBase's link before the temp folder is deleted, so a recursive delete never reaches the real folder. */
function dropLink(root: string, from: string | undefined, tmp: string) {
  if (!from) return;
  const link = path.join(tmp, 'base', root);
  try {
    fs.unlinkSync(link);
  } catch {
    try { fs.rmdirSync(link); } catch { /* not there */ }
  }
}

/** A stand-in folder for a root: it must be inside C:\Projects (the API takes it from callers). */
function standIn(dir: string | undefined, what: string) {
  if (!dir) return undefined;
  const full = path.resolve(paths.projects, dir);
  const rel = path.relative(paths.projects, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw fail(`${what} must be a folder inside ${paths.projects} (got ${dir}).`);
  if (!fs.existsSync(full)) throw fail(`${what} ${dir} doesn't exist.`);
  return full;
}

const manifestFile = (root: string) => path.join(MANIFESTS(), `${root.replace(/[\\/]/g, '__')}.json`);
function loadSent(root: string): Manifest {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8'));
    return m.instanceId === builderState().instanceId ? m.files : {};
  } catch {
    return {};
  }
}
function saveSent(root: string, files: Manifest) {
  fs.mkdirSync(MANIFESTS(), { recursive: true });
  fs.writeFileSync(manifestFile(root), JSON.stringify({ instanceId: builderState().instanceId, files }));
}

/** Folders a Unity project needs besides itself: its file: packages under C:\Projects. */
export function localPackages(project: string, from?: string) {
  // A stand-in's file: paths still resolve from the project's usual place (that's where the server has it).
  const file = path.join(from ?? path.join(paths.projects, project), 'Packages', 'manifest.json');
  if (!fs.existsSync(file)) return [];
  const deps = JSON.parse(fs.readFileSync(file, 'utf8')).dependencies ?? {};
  const out: string[] = [];
  for (const v of Object.values(deps) as string[]) {
    if (typeof v !== 'string' || !v.startsWith('file:')) continue;
    let p = v.slice(5);
    // Manifests written on Windows name C:/Projects/...; on the Linux control server that is paths.projects.
    const win = /^[A-Za-z]:[\\/]Projects[\\/](.*)$/i.exec(p);
    if (win) p = path.join(paths.projects, ...win[1].split(/[\\/]/));
    else if (!path.isAbsolute(p)) p = path.resolve(path.join(paths.projects, project, 'Packages'), p);
    const rel = path.relative(paths.projects, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw fail(`${project} uses a local package outside C:\\Projects (${p}); the build server can't mirror it.`);
    out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}

const BATCH_BYTES = 400 * 1024 * 1024;

/** Uploads what changed under one root since the last sync (resumable: progress is saved per batch). */
export async function syncRoot(root: string, exclude: string[], log: (s: string) => void = () => {}, from?: string) {
  const local = walk(root, exclude, from);
  const sent = loadSent(root);
  const changed = Object.keys(local).filter((k) => !sent[k] || sent[k][0] !== local[k][0] || sent[k][1] !== local[k][1]);
  const deleted = Object.keys(sent).filter((k) => !local[k]);
  if (!changed.length && !deleted.length) return { root, files: 0, bytes: 0, deleted: 0 };
  const total = changed.reduce((n, k) => n + local[k][0], 0);
  log(`${root}: sending ${changed.length} changed files (${mb(total)})${deleted.length ? `, deleting ${deleted.length}` : ''}`);
  const tmp = fs.mkdtempSync(path.join(paths.tmp, 'sync-'));
  const base = tarBase(root, from, tmp);
  try {
    let batch: string[] = [];
    let size = 0;
    let done = 0;
    const flush = async () => {
      if (!batch.length) return;
      const list = path.join(tmp, 'list.txt');
      const tarFile = path.join(tmp, `${crypto.randomBytes(6).toString('hex')}.tgz`);
      fs.writeFileSync(list, batch.join('\n') + '\n');
      await proc(TAR, ['-czf', tarFile, '-C', base, '-T', list], 3_600_000, 'tar');
      await scpUp([tarFile], 'C:/hawkes/incoming/');
      await ssh(`& C:\\hawkes\\bin\\apply.ps1 -Tar C:\\hawkes\\incoming\\${path.basename(tarFile)}`, { timeoutMs: 3_600_000 });
      fs.rmSync(tarFile, { force: true });
      for (const k of batch) sent[k] = local[k];
      saveSent(root, sent);
      done += size;
      if (total > BATCH_BYTES) log(`${root}: ${mb(done)} of ${mb(total)} sent`);
      batch = [];
      size = 0;
    };
    for (const k of changed) {
      batch.push(k);
      size += local[k][0];
      if (size >= BATCH_BYTES) await flush();
    }
    await flush();
    if (deleted.length) {
      const del = path.join(tmp, `del-${crypto.randomBytes(4).toString('hex')}.txt`);
      fs.writeFileSync(del, deleted.join('\n') + '\n');
      await scpUp([del], 'C:/hawkes/incoming/');
      await ssh(`& C:\\hawkes\\bin\\apply.ps1 -Deletes C:\\hawkes\\incoming\\${path.basename(del)}`);
      for (const k of deleted) delete sent[k];
      saveSent(root, sent);
    }
  } finally {
    dropLink(root, from, tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { root, files: changed.length, bytes: total, deleted: deleted.length };
}

const mb = (n: number) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

// --------------------------------------------------------- git seeding
//
// J's connection may be slow; AWS-to-GitHub is fast. So when a root is in a GitHub repo, the server clones (or
// fetches) the repo and checks out the commit J's work is based on (the merge base with origin's default
// branch), and only what differs from that commit is uploaded: uncommitted edits, unpushed commits, untracked and
// ignored files the build needs. Private repos are read with a deploy key (builderGitHubAccess) that can only read.

const GIT = `& 'C:\\Program Files\\Git\\cmd\\git.exe'`;
const GH_KEY = 'C:/hawkes/github_ed25519';

function localGit(dir: string, args: string[]) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\r?\n$/, ''), err: (r.stderr ?? '').trim() };
}

type RepoInfo = { top: string; dir: string; slug: string; base: string; branch: string };

/**
 * The GitHub repo a root lives in (top folder relative to C:\Projects as the server mirrors it, the local checkout,
 * owner/name, the base commit), or null. With `from` (a worktree standing in for the root), the server's folder is
 * still the root's usual one: C:\Projects\<root> minus the root's path inside the repo.
 */
export function repoOf(root: string, from?: string): RepoInfo | null {
  const dir = from ?? path.join(paths.projects, root);
  const top = localGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const url = localGit(dir, ['remote', 'get-url', 'origin']).out;
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/);
  if (!m) return null;
  const head = localGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/main';
  const base = localGit(dir, ['merge-base', 'HEAD', head]);
  if (!base.ok || !base.out) return null;
  const inside = path.relative(path.resolve(top.out), path.resolve(dir)).replace(/\\/g, '/');
  if (inside.startsWith('..')) return null;
  const rel = !inside ? root : root.endsWith(`/${inside}`) ? root.slice(0, -(inside.length + 1)) : null;
  if (!rel) return null;
  return { top: rel, dir: path.resolve(top.out), slug: m[1], base: base.out.trim(), branch: head.replace(/^origin\//, '') };
}

const isPrivate = (slug: string) => repoIsPrivate(slug, { token: env('GITHUB_TOKEN') });

/**
 * Gives the build server read-only access to J's private repos: a key on the server, added as a read-only deploy
 * key to each repo with J's GitHub CLI (gh auth login first). Safe to run again.
 */
export async function builderGitHubAccess(slugs: string[]) {
  // The key is made here and copied over (quoting an empty passphrase through SSH into PowerShell is unreliable).
  const localKey = path.join(paths.builder, 'github_ed25519');
  if (!fs.existsSync(localKey)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hawkes-builder', '-f', localKey], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw fail(`Couldn't make the GitHub deploy key (ssh-keygen: ${r.stderr || r.error?.message}).`);
  }
  lockKey(localKey);
  await scpUp([localKey], GH_KEY);
  await ssh(`icacls ${GH_KEY.replace(/\//g, '\\')} /inheritance:r /grant:r Administrator:F SYSTEM:F | Out-Null; 'ok'`);
  const pub = fs.readFileSync(`${localKey}.pub`, 'utf8').trim();
  // On the cloud control server there is no gh CLI, but GITHUB_TOKEN (Secrets Manager hawkes/github) is in the environment.
  const token = env('GITHUB_TOKEN');
  if (token) {
    const out: Record<string, string> = {};
    const gh = (route: string, init: RequestInit = {}) =>
      fetch(`https://api.github.com/repos/${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const keyBody = pub.split(' ').slice(0, 2).join(' ');
    for (const slug of slugs) {
      const list = await gh(`${slug}/keys`);
      if (!list.ok) {
        out[slug] = `failed: listing deploy keys answered HTTP ${list.status}`;
        continue;
      }
      if (((await list.json()) as any[]).some((k) => String(k.key).trim() === keyBody)) {
        out[slug] = 'already added';
        continue;
      }
      const add = await gh(`${slug}/keys`, { method: 'POST', body: JSON.stringify({ title: 'hawkes-builder', key: keyBody, read_only: true }) });
      out[slug] = add.ok ? 'added (read-only)' : `failed: HTTP ${add.status} ${(await add.text()).slice(0, 200)}`;
    }
    return out;
  }
  const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true });
  if (auth.status !== 0) throw fail('The GitHub CLI is not signed in on this PC. Run: gh auth login', 'auth');
  const tmp = path.join(paths.tmp, 'builder-key.pub');
  fs.writeFileSync(tmp, pub + '\n');
  const out: Record<string, string> = {};
  for (const slug of slugs) {
    const list = spawnSync('gh', ['repo', 'deploy-key', 'list', '--repo', slug], { encoding: 'utf8', windowsHide: true });
    if (list.stdout?.includes('hawkes-builder')) {
      out[slug] = 'already added';
      continue;
    }
    const add = spawnSync('gh', ['repo', 'deploy-key', 'add', tmp, '--repo', slug, '--title', 'hawkes-builder'], { encoding: 'utf8', windowsHide: true });
    out[slug] = add.status === 0 ? 'added (read-only)' : `failed: ${(add.stderr || add.stdout).trim()}`;
  }
  fs.rmSync(tmp, { force: true });
  return out;
}

/**
 * Makes the server's copy of a root's repo match the commit J's work is based on, and records every file that
 * matches it as already sent, so syncRoot uploads only the difference. Returns null when the root isn't in a
 * GitHub repo (syncRoot then sends everything, as before).
 */
export async function seedFromGit(root: string, exclude: string[], log: (s: string) => void = () => {}, from?: string, lf = false) {
  const repo = repoOf(root, from);
  if (!repo) return null;
  const remoteDir = `C:\\Projects\\${repo.top.replace(/\//g, '\\')}`;
  const priv = await isPrivate(repo.slug);
  // Private repos: with GITHUB_TOKEN (the cloud control server) git reads over HTTPS with the token sent as a header on
  // each clone/fetch only, never stored on the build server; without it (J's PC) the server's deploy key over SSH.
  const token = priv ? env('GITHUB_TOKEN') : undefined;
  const https = `https://github.com/${repo.slug}.git`;
  const url = priv && !token ? `git@github.com:${repo.slug}.git` : https;
  const authArg = token ? ` -c 'http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}'` : '';
  const sshCmd = priv && !token ? ` -c core.sshCommand='ssh -i ${GH_KEY} -o StrictHostKeyChecking=accept-new'` : '';
  log(`${repo.top}: the server fetches ${repo.slug} from GitHub (${repo.base.slice(0, 7)})`);
  // Never wait on a password prompt (there is nobody to answer it).
  const noPrompt = `$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'`;
  const prepare = [
    `$ErrorActionPreference = 'Stop'`,
    noPrompt,
    `if (-not (Test-Path '${remoteDir}\\.git')) { if (Test-Path '${remoteDir}') { ${GIT} -C '${remoteDir}' init -q; ${GIT} -C '${remoteDir}' remote add origin '${url}' } else { ${GIT}${sshCmd}${authArg} clone -q --no-checkout '${url}' '${remoteDir}' } }`,
    priv && !token ? `${GIT} -C '${remoteDir}' config core.sshCommand 'ssh -i ${GH_KEY} -o StrictHostKeyChecking=accept-new'` : '',
    token ? `${GIT} -C '${remoteDir}' remote set-url origin '${https}'` : '',
    // A failed git command doesn't stop PowerShell ($ErrorActionPreference only covers cmdlets): check each one.
    `if (-not (Test-Path '${remoteDir}\\.git')) { throw 'cloning ${repo.slug} failed' }`,
    `'ready'`,
  ].filter(Boolean).join('; ');
  // The fetch runs on its own so a locked ref can be retried (gitfetch.ts).
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    noPrompt,
    // A website's files come back from the server and are committed as they are: check them out with the repo's own
    // line endings, not Git for Windows' CRLF (else every go live rewrites index.html whole). Dropping the index makes
    // the checkout below rewrite the files once. A Unity project keeps CRLF (rewriting it would reimport everything).
    lf ? `if ((${GIT} -C '${remoteDir}' config --local core.autocrlf) -ne 'false') { ${GIT} -C '${remoteDir}' config core.autocrlf false; Remove-Item -Force -ErrorAction SilentlyContinue '${remoteDir}\\.git\\index' }` : '',
    // Checkout downloads Git LFS files (Sick Of It keeps its assets there), which needs the same token.
    `${GIT} -C '${remoteDir}'${authArg} checkout -q -f --detach ${repo.base}; if ($LASTEXITCODE) { throw 'git checkout ${repo.base.slice(0, 7)} failed for ${repo.slug} (Git LFS?)' }`,
    `${GIT} -C '${remoteDir}' clean -q -fd`,
    `'seeded'`,
  ].filter(Boolean).join('; ');
  try {
    // One seed per server checkout at a time: two fetches in one checkout fail with "cannot lock ref".
    await withRepoLock(remoteDir, async () => {
      await ssh(prepare, { timeoutMs: 30 * 60_000 });
      await fetchOrigin({ run: (cmd) => ssh(`${noPrompt}; ${cmd}`, { timeoutMs: 30 * 60_000 }), dir: remoteDir, authArg, slug: repo.slug, log });
      await ssh(script, { timeoutMs: 60 * 60_000 });
    });
  } catch (e: any) {
    // Never let the token reach a log or an error message.
    const msg = token ? String(e.message).split(token).join('***').replace(/Basic [A-Za-z0-9+/=]{20,}/g, 'Basic ***') : String(e.message);
    if (priv && /Permission denied|publickey|Could not read from remote|cloning .* failed|Authentication failed|fetch failed/i.test(msg)) {
      throw fail(token
        ? `The build server couldn't read the private repo ${repo.slug} with the GitHub token (hawkes/github): check it has Contents read access to that repo. (${msg.slice(0, 200)})`
        : `The build server can't read the private repo ${repo.slug}. Give it read-only access: sign in with "gh auth login" here, then run "hawkesgen builder github".`, 'auth');
    }
    if (token) throw fail(msg);
    throw e instanceof GenError ? e : fail(msg);
  }

  // What differs from the base commit, as paths relative to C:\Projects under this root.
  const topDir = repo.dir;
  const under = (p: string) => {
    const rel = `${repo.top}/${p}`.replace(/^\/+/, '');
    return rel === root || rel.startsWith(`${root}/`) ? rel : null;
  };
  const changed = new Set<string>();
  const deleted: string[] = [];
  for (const line of localGit(topDir, ['-c', 'core.quotepath=off', 'diff', '--name-status', '--no-renames', repo.base]).out.split('\n').filter(Boolean)) {
    const [st, p] = line.split('\t');
    const rel = under(p);
    if (!rel) continue;
    if (st === 'D') deleted.push(rel);
    else changed.add(rel);
  }
  const tracked = new Set(localGit(topDir, ['-c', 'core.quotepath=off', 'ls-files']).out.split('\n').filter(Boolean).map(under).filter(Boolean) as string[]);
  const local = walk(root, exclude, from);
  const sent = loadSent(root);
  // The checkout and clean just reset tracked and untracked files on the server, so those are re-sent if J changed
  // them. Ignored files (git clean leaves them) that were sent before and haven't changed stay sent.
  const untracked = new Set(localGit(topDir, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean).map(under).filter(Boolean) as string[]);
  for (const k of Object.keys(sent)) {
    const keep = !tracked.has(k) && !untracked.has(k) && local[k] && sent[k][0] === local[k][0] && sent[k][1] === local[k][1];
    if (!keep) delete sent[k];
  }
  let skipped = 0;
  for (const [k, v] of Object.entries(local)) {
    // Tracked and unchanged since the base: the server already has it from GitHub.
    if (tracked.has(k) && !changed.has(k)) {
      sent[k] = v;
      skipped++;
    }
  }
  saveSent(root, sent);
  if (deleted.length) {
    const del = path.join(paths.tmp, `del-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(del, deleted.join('\n') + '\n');
    await scpUp([del], 'C:/hawkes/incoming/');
    await ssh(`& C:\\hawkes\\bin\\apply.ps1 -Deletes C:\\hawkes\\incoming\\${path.basename(del)}`);
    fs.rmSync(del, { force: true });
  }
  log(`${root}: ${skipped} files came from GitHub; ${Object.keys(local).length - skipped} to upload, ${deleted.length} deleted`);
  return { repo: repo.slug, base: repo.base, fromGit: skipped, toUpload: Object.keys(local).length - skipped, deleted: deleted.length };
}

async function uploadScripts() {
  const dir = path.join(paths.server, 'builder');
  const files = ['snapshot.ps1', 'apply.ps1', 'build.ps1', 'poll.ps1'].map((f) => path.join(dir, f));
  await ssh('New-Item -ItemType Directory -Force C:\\hawkes\\bin, C:\\hawkes\\incoming, C:\\hawkes\\jobs | Out-Null');
  await scpUp(files, 'C:/hawkes/bin/');
}

// ------------------------------------------------------------------ build

export type BuildSpec = {
  /** The Unity project folder, relative to C:\Projects ("sickofitgame-unity", "YoobaLand/YoobaLand"). */
  project: string;
  /** The website folder the build writes into, relative to C:\Projects (pulled back after the build). */
  site?: string;
  /** -executeMethod: the project's own batch build/deploy method. */
  method?: string;
  target?: string;
  env?: Record<string, string>;
  args?: string[];
  /** Run tests instead of (or after) a method: EditMode or PlayMode. Results come back as NUnit XML. */
  tests?: 'EditMode' | 'PlayMode';
  /** -testCategory for the test run. */
  testFilter?: string;
  /**
   * Local folders (inside C:\Projects) standing in for the project and the site: an agent change's worktree and a
   * scratch copy of the website, so the build is of the change and lands in the copy, not in the real site folder.
   * The server still builds in C:\Projects\<project> (its Library) and the deploy method still writes C:\Projects\<site>.
   */
  projectDir?: string;
  siteDir?: string;
};

export type BuildHooks = { step(s: string): void; log(s: string): void; signal?: AbortSignal };

const parseSnapshot = (text: string): Manifest => {
  const out: Manifest = {};
  for (const line of text.split('\n')) {
    const [rel, size, ms] = line.replace(/\r$/, '').split('\t');
    if (rel) out[rel] = [Number(size), Number(ms)];
  }
  return out;
};

function unityVersionOf(project: string, from?: string) {
  const file = path.join(from ?? path.join(paths.projects, project), 'ProjectSettings', 'ProjectVersion.txt');
  const m = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').match(/m_EditorVersion:\s*(\S+)/) : null;
  if (!m) throw fail(`${project} isn't a Unity project (no ProjectSettings/ProjectVersion.txt).`);
  return m[1];
}

/** What Unity said that's worth showing as progress. */
function progressOf(line: string): string | null {
  const l = line.trim();
  if (!l) return null;
  if (/^\[Licensing::|Licensing::|license/i.test(l) && /error|fail|no valid|not activated|expired/i.test(l)) return `license: ${l}`;
  if (/^(Building|Build |Compiling|Start importing|Asset Pipeline Refresh|Refreshing native plugins|Started building|Running Bee|\[\s*\d+\/\d+|Linking|Converting|Emscripten|wasm-opt|Optimizing|Packaging|Exiting batchmode|\[Hawkes\]|Step \d|Deploy)/i.test(l)) return l.slice(0, 200);
  return null;
}

const LICENSE_RE = /No valid Unity Editor license found|Licensing::Module.*(error|failed)|LicensingClient has failed|User is not logged in|Unity license is not valid|not entitled/i;
/** License lines that do stop a build (unlike "Access token is unavailable", which successful builds log too). */
const HARD_LICENSE_RE = /No valid Unity Editor license found|User is not logged in|Unity license is not valid|not entitled/i;

/**
 * Builds a Unity project on the build server. Starts the server if it is stopped (it stops itself
 * when idle again). Returns what changed in the website folder, which is now in J's checkout.
 */
export async function runBuild(jobId: string, spec: BuildSpec, hooks: BuildHooks) {
  const t0 = Date.now();
  const target = spec.target ?? 'WebGL';
  spec = { ...spec, projectDir: standIn(spec.projectDir, 'projectDir'), siteDir: standIn(spec.siteDir, 'siteDir') };
  if (spec.siteDir && !spec.site) throw fail('siteDir needs site (the website folder it stands in for).');
  const unity = unityVersionOf(spec.project, spec.projectDir);
  let f = await requireBuilder();
  if (f.instance.State?.Name !== 'running') {
    hooks.step('starting the build server');
    await startBuilder();
  }
  const stage = await waitForBuilder(hooks.step);
  if (stage.stage === 'unity' || stage.stage === 'setup') throw fail(`The build server is still setting up (${stage.detail ?? stage.stage}). Try again when it's done.`, 'busy');
  if (stage.stage === 'failed') throw fail(`The build server's setup failed: ${stage.detail}`);
  f = (await findBuilder())!;

  const remoteJob = `C:\\hawkes\\jobs\\${jobId}`;
  const already = JSON.parse((await ssh(`& { if (Test-Path ${remoteJob}\\started.txt) { 'true' } else { 'false' } }`)).trim() || 'false');
  if (!already) {
    hooks.step('uploading build scripts');
    await uploadScripts();
    const roots: [string, string[], string?][] = [[spec.project, UNITY_EXCLUDE, spec.projectDir], ...localPackages(spec.project, spec.projectDir).map((p) => [p, ['.git']] as [string, string[]])];
    if (spec.site) roots.push([spec.site, SITE_EXCLUDE, spec.siteDir]);
    for (const [root, exclude, from] of roots) {
      const what = from ? `${root} (from ${path.relative(paths.projects, from).replace(/\\/g, '/')})` : root;
      hooks.step(`fetching ${what} from GitHub on the server`);
      await seedFromGit(root, exclude, hooks.log, from, root === spec.site);
      hooks.step(`uploading local changes to ${what}`);
      const r = await syncRoot(root, exclude, hooks.log, from);
      if (r.files || r.deleted) hooks.log(`${root}: ${r.files} files (${mb(r.bytes)}) sent, ${r.deleted} deleted`);
    }
    const job = { unity, project: spec.project, site: spec.site ?? null, method: spec.method ?? null, target, env: spec.env ?? {}, args: spec.args ?? [], tests: spec.tests ?? null, testFilter: spec.testFilter ?? null, projectExclude: UNITY_EXCLUDE.join(',') };
    const local = path.join(paths.tmp, `${jobId}-job.json`);
    fs.writeFileSync(local, JSON.stringify(job));
    await ssh(`New-Item -ItemType Directory -Force ${remoteJob} | Out-Null`);
    await scpUp([local], `${remoteJob.replace(/\\/g, '/')}/job.json`);
    fs.rmSync(local, { force: true });
    // Win32_Process.Create runs outside the SSH session, so the build survives a dropped connection.
    const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\hawkes\\bin\\build.ps1 -Job ${jobId}`;
    await ssh(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}' }; if ($r.ReturnValue -ne 0) { throw ('start failed: ' + $r.ReturnValue) }; 'started'`);
    hooks.log(`build started on the server (Unity ${unity}, ${target}${spec.method ? `, ${spec.method}` : ''})`);
  } else {
    hooks.log('the build was already running on the server; following it');
  }

  // Follow the Unity log until the build ends.
  let offset = 0;
  let tail = '';
  let licenseProblem = '';
  let lastStep = 'building';
  let badPolls = 0;
  const decoder = new TextDecoder();
  hooks.step('Unity is opening the project');
  for (;;) {
    if (hooks.signal?.aborted) {
      await ssh(`Get-Process Unity -ErrorAction SilentlyContinue | Stop-Process -Force; 'stopped'`).catch(() => {});
      throw fail('cancelled', 'cancelled');
    }
    let raw: string;
    try {
      raw = await ssh(`& C:\\hawkes\\bin\\poll.ps1 -Job ${jobId} -Offset ${offset}`, { timeoutMs: 60_000 });
    } catch (e: any) {
      hooks.log(`(couldn't reach the build server: ${e.message}; retrying)`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    let p: PollAnswer;
    try {
      p = parsePoll(raw, decoder);
      badPolls = 0;
    } catch (e: any) {
      // The server answered but the answer can't be read: the same chunk would fail forever, so skip past it.
      badPolls++;
      const skipTo = pollLengthOf(raw);
      if (badPolls >= 3 && skipTo !== null && skipTo > offset) {
        hooks.log(`(couldn't read the build log at ${offset}-${skipTo}: ${e.message}; skipping that part of the log)`);
        offset = skipTo;
        badPolls = 0;
        continue;
      }
      if (badPolls >= 10) throw fail(`The build server's progress can't be read (${e.message}), ${badPolls} times in a row. The build may still be running on the server (job ${jobId}).`);
      hooks.log(`(couldn't read the build server's answer: ${e.message}; retrying)`);
      await new Promise((r) => setTimeout(r, 8_000));
      continue;
    }
    if (p.text) {
      offset = p.length;
      const lines = (tail + p.text).split(/\r?\n/);
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (LICENSE_RE.test(line)) licenseProblem ||= line.trim();
        const s = progressOf(line);
        if (s && s !== lastStep) {
          lastStep = s;
          hooks.step(s);
          if (/error|fail|license|Deploy|Step \d|\[Hawkes\]|Exiting/i.test(s)) hooks.log(s);
        }
      }
    }
    if (p.exit !== null && p.exit !== undefined) {
      if (p.error) hooks.log(`build script: ${String(p.error).trim()}`);
      return await finishBuild(jobId, spec, hooks, { exit: p.exit, licenseProblem, t0, type: f.instance.InstanceType });
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
}

async function finishBuild(jobId: string, spec: BuildSpec, hooks: BuildHooks, { exit, licenseProblem, t0, type }: { exit: number; licenseProblem: string; t0: number; type: string }) {
  const remoteJob = `C:/hawkes/jobs/${jobId}`;
  const tmp = fs.mkdtempSync(path.join(paths.tmp, 'build-'));
  const logFile = path.join(tmp, 'unity.log');
  await scpDown(`${remoteJob}/unity.log`, logFile).catch(() => fs.writeFileSync(logFile, ''));
  const log = fs.readFileSync(logFile);
  let results: Buffer | null = null;
  if (spec.tests) {
    const rf = path.join(tmp, 'results.xml');
    await scpDown(`${remoteJob}/results.xml`, rf).catch(() => {});
    if (fs.existsSync(rf)) results = fs.readFileSync(rf);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const cost = (seconds / 3600) * (BUILDER_TYPES[type]?.price ?? BUILDER_TYPES[BUILDER_DEFAULT_TYPE].price);
  const base = { exitCode: exit, seconds, cost, log, results, logTail: log.toString('utf8').split(/\r?\n/).slice(-60).join('\n'), tmp };

  // A test run exits 2 when tests fail; that's a result, not a broken build.
  if (spec.tests && results) return { ...base, ok: true, error: null, kind: null, site: null, project: null };
  if (exit !== 0) {
    // The project's own errors come first: Unity logs "Licensing::Module Error: Access token is unavailable" even in
    // builds that succeed, so a license line alone isn't the cause when the deploy method or compiler said why.
    const lines = log.toString('utf8').split(/\r?\n/);
    const errors = [...new Set(lines.filter((l) => /\[GameDeploy\].*(ERROR|FAILED)|DEPLOY FAILED|\[Hawkes\].*(error|failed)|error CS\d+|BuildFailedException|Build Failed|Exception:|error:/i.test(l) && !/Licensing::/i.test(l)).map((l) => l.trim()))].slice(0, 20);
    const hardLicense = lines.find((l) => HARD_LICENSE_RE.test(l));
    if (hardLicense) {
      return { ...base, ok: false, error: `Unity isn't licensed on the build server (${hardLicense.trim()}). Open the Remote Desktop file (hawkesgen builder rdp), sign in to Unity Hub once, then build again.`, kind: 'license', site: null, project: null };
    }
    // Soft license lines ("Access token is unavailable") are noise; with no other error found, say what the log ended with
    // instead of blaming the license.
    const lastLine = errors[0] ?? lines.filter((l) => l.trim() && !/Licensing::/i.test(l)).slice(-1)[0]?.trim();
    const softLicense = !errors.length && (licenseProblem || LICENSE_RE.test(base.logTail));
    const hint = softLicense ? ' (the log also has a soft licensing line, "Access token is unavailable", which successful builds log too; it is probably not the cause)' : '';
    return { ...base, ok: false, error: `Unity exited with code ${exit}${lastLine ? `: ${lastLine}` : ''}${hint}`, errors, kind: 'build', site: null, project: null };
  }

  // Pull back what the build changed in the website folder.
  let site: { changed: string[]; deleted: string[]; bytes: number } | null = null;
  if (spec.site) {
    const siteLocal = spec.siteDir ?? path.join(paths.projects, spec.site);
    hooks.step('downloading the build');
    await scpDown(`${remoteJob}/site-before.txt`, path.join(tmp, 'site-before.txt'));
    await scpDown(`${remoteJob}/site-after.txt`, path.join(tmp, 'site-after.txt'));
    const before = parseSnapshot(fs.readFileSync(path.join(tmp, 'site-before.txt'), 'utf8'));
    const after = parseSnapshot(fs.readFileSync(path.join(tmp, 'site-after.txt'), 'utf8'));
    const changed = Object.keys(after).filter((k) => !before[k] || before[k][0] !== after[k][0] || before[k][1] !== after[k][1]);
    const deleted = Object.keys(before).filter((k) => !after[k]);
    const bytes = changed.reduce((n, k) => n + after[k][0], 0);
    if (changed.length) {
      const listLocal = path.join(tmp, 'pull.txt');
      fs.writeFileSync(listLocal, changed.join('\n') + '\n');
      await scpUp([listLocal], `${remoteJob}/pull.txt`);
      await ssh(`tar -czf C:\\hawkes\\jobs\\${jobId}\\pull.tgz -C C:\\Projects -T C:\\hawkes\\jobs\\${jobId}\\pull.txt; if ($LASTEXITCODE -ne 0) { throw 'tar failed' }; 'ok'`, { timeoutMs: 1_800_000 });
      hooks.log(`downloading ${changed.length} files (${mb(bytes)}) into ${spec.siteDir ? path.relative(paths.projects, siteLocal).replace(/\\/g, '/') : spec.site}`);
      const tgz = path.join(tmp, 'pull.tgz');
      await scpDown(`${remoteJob}/pull.tgz`, tgz);
      if (!spec.siteDir) {
        await proc(TAR, ['-xzf', tgz, '-C', paths.projects], 1_800_000, 'tar');
      } else {
        // Into the stand-in: unpack beside it, then move each file over (tar won't extract through a link).
        const out = path.join(tmp, 'pulled');
        fs.mkdirSync(out);
        await proc(TAR, ['-xzf', tgz, '-C', out], 1_800_000, 'tar');
        for (const k of changed) {
          const dest = localFile(spec.site, k, siteLocal);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.rmSync(dest, { force: true }); // a hard link from a preview must not be written through
          try {
            fs.renameSync(path.join(out, k), dest);
          } catch {
            fs.copyFileSync(path.join(out, k), dest); // another disk
          }
        }
      }
    }
    for (const rel of deleted) fs.rmSync(localFile(spec.site, rel, spec.siteDir), { force: true });
    // Prune folders the build emptied (an old Game/v<n>).
    for (const rel of new Set(deleted.map((d) => path.dirname(localFile(spec.site!, d, spec.siteDir))))) {
      let dir = rel;
      while (dir.startsWith(siteLocal) && dir !== siteLocal) {
        try {
          if (fs.readdirSync(dir).length) break;
          fs.rmdirSync(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
    // The checkout now matches the server: record it so these files aren't sent back.
    const sent = loadSent(spec.site);
    const now = walk(spec.site, SITE_EXCLUDE, spec.siteDir);
    for (const k of changed) if (now[k]) sent[k] = now[k];
    for (const k of deleted) delete sent[k];
    saveSent(spec.site, sent);
    site = { changed, deleted, bytes };
  }

  // Files the build changed inside the project stay on the server; resend J's copy next time.
  let project: string[] = [];
  try {
    await scpDown(`${remoteJob}/project-before.txt`, path.join(tmp, 'project-before.txt'));
    await scpDown(`${remoteJob}/project-after.txt`, path.join(tmp, 'project-after.txt'));
    const before = parseSnapshot(fs.readFileSync(path.join(tmp, 'project-before.txt'), 'utf8'));
    const after = parseSnapshot(fs.readFileSync(path.join(tmp, 'project-after.txt'), 'utf8'));
    project = Object.keys(after).filter((k) => !before[k] || before[k][0] !== after[k][0] || before[k][1] !== after[k][1]);
    if (project.length) {
      const sent = loadSent(spec.project);
      for (const k of project) delete sent[k];
      saveSent(spec.project, sent);
    }
  } catch {
    // Only an optimization.
  }
  await ssh(`Remove-Item -Force C:\\hawkes\\jobs\\${jobId}\\pull.tgz -ErrorAction SilentlyContinue`).catch(() => {});
  return { ...base, ok: true, error: null, kind: null, site, project };
}
