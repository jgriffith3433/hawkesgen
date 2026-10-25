// The GPU fleet on AWS: EC2 machines with a 48 GB+ NVIDIA GPU that run
// ComfyUI. Ported from Dose Of Destruction's tools/gpu/aws.mjs, which built
// and tuned it (read docs/comfyui.md before changing flags or models).
//
// A server is launched from the fleet's machine image when one matches
// server/models.json (image.ts builds it): server/firstboot.sh makes it its own
// and it is ready in minutes. Launched that way it is disposable by default:
// idle, it powers itself off and AWS terminates it, so no disk is left paying.
// Without a matching image it installs itself from server/bootstrap.sh (30-45
// minutes), then powers itself off when idle and is started and stopped after
// that. ComfyUI listens on 127.0.0.1 only; nginx in front of it
// (port 8189) needs the server's token (HTTP basic auth), and the security
// group lets in only this machine's IP.
//
// Two kinds of server are managed side by side:
//   gen  launched by Hawkes Gen: Project=hawkes-gen, Name=hawkesgen-comfy,
//        auth user "gen", status at /gen/status.json
//   dod  launched by Dose Of Destruction before Hawkes Gen existed:
//        Project=dose-of-destruction, Name=dod-comfy, user "dod",
//        /dod/status.json. Adopted as they are (their disks hold ~90 GB of
//        models), using the tokens and keys copied into DATA_DIR/fleet.
//
// Local state (each server's token and SSH key) lives in DATA_DIR/fleet.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  EC2Client, DescribeImagesCommand, DescribeInstancesCommand, DescribeInstanceTypeOfferingsCommand, DescribeSubnetsCommand,
  DescribeVpcsCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand, DescribeKeyPairsCommand, CreateKeyPairCommand, RunInstancesCommand, StartInstancesCommand,
  StopInstancesCommand, TerminateInstancesCommand, GetSpotPlacementScoresCommand, DescribeVolumesCommand, ModifyVolumeCommand,
  DescribeVolumesModificationsCommand, type Image,
} from '@aws-sdk/client-ec2';
import { ServiceQuotasClient, GetServiceQuotaCommand, ListRequestedServiceQuotaChangeHistoryByQuotaCommand, RequestServiceQuotaIncreaseCommand } from '@aws-sdk/client-service-quotas';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { env, paths, loadSettings } from '../../config.ts';
import { installScript as blenderInstall } from '../blender/install.ts';
import { GenError } from '../../util.ts';

/**
 * Instance types that fit the models (a 48 GB+ GPU and 32 GB+ memory). Prices
 * are on-demand list prices in the US regions, for estimates only.
 * g6e: NVIDIA L40S 48 GB, the cheapest fit. g7e: RTX PRO 6000 Blackwell 96 GB,
 * faster, and image and video models fit side by side.
 */
export const TYPES: Record<string, { vcpus: number; memory: number; vram: number; gpu: string; price: number }> = {
  'g6e.xlarge': { vcpus: 4, memory: 32, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 1.861 },
  'g6e.2xlarge': { vcpus: 8, memory: 64, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 2.242 },
  'g7e.2xlarge': { vcpus: 8, memory: 64, vram: 96, gpu: 'NVIDIA RTX PRO 6000 Blackwell, 96 GB', price: 3.36 },
  'g6e.4xlarge': { vcpus: 16, memory: 128, vram: 48, gpu: 'NVIDIA L40S, 48 GB', price: 3.004 },
  'g7e.4xlarge': { vcpus: 16, memory: 128, vram: 96, gpu: 'NVIDIA RTX PRO 6000 Blackwell, 96 GB', price: 4.0 },
};
export const DEFAULT_TYPE = 'g6e.xlarge';
/** Where GPU servers may run. HAWKES_REGIONS (comma list) narrows it: the cloud uses the three US regions (us-east-1, us-east-2, us-west-2) since 2026-10-16. */
export const REGIONS = (env('HAWKES_REGIONS') ?? 'us-east-1,us-east-2,us-west-2,eu-north-1,eu-central-1,ap-northeast-1').split(',').map((r) => r.trim()).filter(Boolean);
const PRICE_FACTOR: Record<string, number> = { 'eu-north-1': 1.1, 'eu-central-1': 1.25, 'ap-northeast-1': 1.3 };
export const priceIn = (type: string, region?: string) => (TYPES[type]?.price ?? TYPES[DEFAULT_TYPE].price) * (PRICE_FACTOR[region ?? ''] ?? 1);
// 400 GB (J, 2026-10-22): the image carries the video pipeline's models too (H3 scenes, InfiniteTalk, LTX-2.3, Z-Image:
// about 270 GB with the OS and ComfyUI), with room left for workflow models that download on first use.
export const DISK_GB = 400;
export const DISK_PER_MONTH = DISK_GB * 0.08 + (300 - 125) * 0.04;
export const PORT = 8189;
const QUOTA = { ServiceCode: 'ec2', QuotaCode: 'L-DB2E81BA' }; // Running On-Demand G and VT instances (vCPUs)

/** What differs between servers Hawkes Gen launched and ones Dose Of Destruction launched. */
type Profile = { flavor: 'gen' | 'dod'; project: string; name: string; sg: string; keyBase: string; user: string; status: string; idleScript: string; bootLog: string };
const PROFILES: Record<'gen' | 'dod', Profile> = {
  gen: { flavor: 'gen', project: 'hawkes-gen', name: 'hawkesgen-comfy', sg: 'hawkesgen-comfy', keyBase: 'hawkesgen-comfy', user: 'gen', status: '/gen/status.json', idleScript: '/usr/local/bin/gen-idle.sh', bootLog: '/var/log/gen-bootstrap.log' },
  dod: { flavor: 'dod', project: 'dose-of-destruction', name: 'dod-comfy', sg: 'dod-comfy', keyBase: 'dod-comfy', user: 'dod', status: '/dod/status.json', idleScript: '/usr/local/bin/dod-idle.sh', bootLog: '/var/log/dod-bootstrap.log' },
};
export const PROFILES_GEN = PROFILES.gen;
const profileOf = (instance: any): Profile => (tagOf(instance, 'Name') === PROFILES.dod.name ? PROFILES.dod : PROFILES.gen);
const tagOf = (instance: any, key: string) => (instance?.Tags ?? []).find((t: any) => t.Key === key)?.Value;

const STATE_FILE = path.join(paths.fleet, 'server.json');

export function awsConfig() {
  const key = env('AWS_ACCESS_KEY_ID');
  const secret = env('AWS_SECRET_ACCESS_KEY');
  const region = env('AWS_DEFAULT_REGION') || 'us-east-1';
  if (key && secret) return { region, credentials: { accessKeyId: key, secretAccessKey: secret } };
  // On the AWS control server the instance role provides credentials (no keys on disk); HAWKES_AWS_ROLE says so.
  if (env('HAWKES_AWS_ROLE')) return { region };
  throw new GenError('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not in hawkesgen/.env', { status: 503, kind: 'auth' });
}

/** capacity: AWS is out of these machines here right now. quota: the account may not run that many. */
export function classify(e: any): string {
  const n = e?.name ?? e?.Code ?? '';
  if (['InsufficientInstanceCapacity', 'InsufficientCapacity', 'InsufficientHostCapacity', 'Unsupported'].includes(n)) return 'capacity';
  if (['VcpuLimitExceeded', 'InstanceLimitExceeded', 'MaxSpotInstanceCountExceeded'].includes(n)) return 'quota';
  if (['UnauthorizedOperation', 'AuthFailure', 'InvalidClientTokenId', 'SignatureDoesNotMatch', 'AccessDenied', 'AccessDeniedException', 'OptInRequired', 'UnrecognizedClientException'].includes(n)) return 'auth';
  return 'other';
}
const fleetError = (message: string, kind = 'other', attempts: unknown[] = []) => new GenError(message, { status: 409, kind, attempts });

const clients = new Map<string, EC2Client>();
export function ec2(region: string) {
  if (!clients.has(region)) clients.set(region, new EC2Client({ ...awsConfig(), region }));
  return clients.get(region)!;
}
const quotas = (region: string) => new ServiceQuotasClient({ ...awsConfig(), region });

// ------------------------------------------------------------ local state

/** What a server's /gen/status.json says (bootstrap.sh). run counts install runs (one per boot until ready). */
export type Boot = { stage: string; detail?: string; time?: number; run?: number; started?: number; lastFailure?: string; image?: string; warm?: string };
type ServerRecord = {
  region?: string; type?: string; token?: string; idleMinutes?: number; keyName?: string; zone?: string; launchedAt?: string; modelsUsed?: Record<string, number>;
  /** The last status the server itself reported, so a stopped server still says whether its install finished. */
  lastBoot?: Boot; readyAt?: string;
  /** Launched from this machine image (firstboot.sh) instead of installing. */
  image?: string;
  /** Launched to be thrown away: powering itself off terminates it, and Gen's stop terminates it. */
  disposable?: boolean;
  /** 'image-build': launched to become an image (image.ts); never given jobs. */
  purpose?: string;
  /** Cleaned for imaging (image-prep.sh): its password and keys are gone, so it can't serve jobs again. */
  imageSource?: string;
};
type State = { servers: Record<string, ServerRecord>; [k: string]: any };

export function localState(): State {
  let st: any;
  try {
    st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    st = {};
  }
  st.servers ??= {};
  // Dose Of Destruction's first server was saved at the top level.
  if (st.instanceId && st.token && !st.servers[st.instanceId]) {
    st.servers[st.instanceId] = { region: st.region, type: st.type, token: st.token, idleMinutes: st.idleMinutes, keyName: st.keyName, zone: st.zone, launchedAt: st.launchedAt };
  }
  return st;
}
const record = (instanceId: string): ServerRecord => localState().servers[instanceId] ?? {};
function saveState(patch: Partial<State>) {
  const next = { ...localState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}
function saveRecord(instanceId: string, patch: ServerRecord) {
  const st = localState();
  saveState({ servers: { ...st.servers, [instanceId]: { ...(st.servers[instanceId] ?? {}), ...patch } } });
}
export const serverRecord = record;
export const saveServerRecord = saveRecord;

/**
 * Copies another project's fleet state (tokens and SSH keys) in, so Hawkes
 * Gen can run its servers. Existing records win. Returns what it adopted.
 */
export function adoptState(fromDir: string) {
  const src = path.join(fromDir, 'server.json');
  if (!fs.existsSync(src)) throw new GenError(`No fleet state at ${src}`);
  const theirs = JSON.parse(fs.readFileSync(src, 'utf8'));
  if (theirs.instanceId && theirs.token) (theirs.servers ??= {})[theirs.instanceId] ??= { region: theirs.region, type: theirs.type, token: theirs.token, idleMinutes: theirs.idleMinutes, keyName: theirs.keyName, zone: theirs.zone, launchedAt: theirs.launchedAt };
  const st = localState();
  const adopted = Object.keys(theirs.servers ?? {}).filter((k) => !st.servers[k]);
  saveState({ servers: { ...(theirs.servers ?? {}), ...st.servers } });
  const keys: string[] = [];
  for (const f of fs.readdirSync(fromDir).filter((n) => n.endsWith('.pem'))) {
    const dest = path.join(paths.fleet, f);
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(path.join(fromDir, f), dest);
    lockKey(dest);
    keys.push(f);
  }
  return { servers: adopted, keys };
}

function homeRegion() {
  const r = env('AWS_DEFAULT_REGION');
  return r && REGIONS.includes(r) ? r : REGIONS[0];
}

export async function myIp() {
  const r = await fetch('https://checkip.amazonaws.com');
  const ip = (await r.text()).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new GenError(`Could not work out this machine's public IP (got "${ip}")`);
  return ip;
}

// --------------------------------------------------------------- servers

async function serversIn(region: string) {
  const r = await ec2(region).send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Project', Values: [PROFILES.gen.project, PROFILES.dod.project] },
      { Name: 'tag:Name', Values: [PROFILES.gen.name, PROFILES.dod.name] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'] },
    ],
  }));
  return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((instance) => ({ instance, region }));
}

type Found = { instance: any; region: string };
let listCache: { at: number; value: Found[] | null } = { at: 0, value: null };

/** Every GPU server that isn't terminated, in every region, newest first. Cached for 5 s. */
export async function listServers({ force = false } = {}): Promise<Found[]> {
  if (!force && listCache.value && Date.now() - listCache.at < 5000) return listCache.value;
  awsConfig();
  let complete = true;
  const all = (await Promise.all(REGIONS.map((r) => serversIn(r).catch(() => { complete = false; return [] as Found[]; })))).flat();
  const value = all.sort((a, b) => (b.instance.LaunchTime?.getTime() ?? 0) - (a.instance.LaunchTime?.getTime() ?? 0));
  listCache = { at: Date.now(), value };
  if (complete) forgetGone(value);
  return value;
}

/** Drops the saved state of servers AWS no longer lists (disposable ones terminate themselves). Only when every region answered. */
function forgetGone(found: Found[]) {
  const st = localState();
  const live = new Set(found.map((f) => f.instance.InstanceId));
  const hour = Date.now() - 60 * 60 * 1000;
  const gone = Object.keys(st.servers).filter((id) => !live.has(id) && Date.parse(st.servers[id].launchedAt ?? '') < hour);
  if (!gone.length) return;
  const servers = { ...st.servers };
  for (const id of gone) delete servers[id];
  saveState({ servers });
  console.log(`[fleet] forgot ${gone.length} server(s) that no longer exist: ${gone.join(', ')}`);
}

export async function findServer(instanceId?: string) {
  const all = await listServers();
  if (instanceId) return all.find((s) => s.instance.InstanceId === instanceId) ?? null;
  return all.find((s) => ['running', 'pending'].includes(s.instance.State?.Name)) ?? all[0] ?? null;
}

const BASE = () => ({ types: TYPES, regions: REGIONS, defaultType: DEFAULT_TYPE, diskPerMonth: DISK_PER_MONTH, diskGb: DISK_GB });

export function authHeader(token: string, user = 'gen') {
  return { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` };
}

export type ServerStatus = {
  exists: boolean; id?: string; region?: string; type?: string; state?: string; reason?: string | null; ip?: string | null; zone?: string;
  launched?: string; pricePerHour: number; url?: string | null; user?: string; flavor?: string; hasToken?: boolean; idleMinutes?: number | null;
  key?: string | null; boot?: Boot | null;
  /** Launched from this machine image; disposable: idle or stopped, it is terminated. */
  image?: string | null; disposable?: boolean; purpose?: string | null; imageSource?: string | null;
  /** Installing with no progress (status time unchanged) for STUCK_MINUTES: the server powers itself off at 20. */
  stuck?: { minutes: number; detail: string } | null;
  /** Stopped (or not answering) with an install that never finished: starting it resumes the install. */
  unfinished?: { stage: string; detail: string; resumable: boolean } | null;
  [k: string]: any;
};

/** An install whose status hasn't moved for this long is flagged stuck (bootstrap.sh moves it on every bit of progress). */
export const STUCK_MINUTES = 10;
const INSTALLING = new Set(['installing', 'downloading']);

/** Is this install stuck? Status time is the server's clock (seconds). */
export function stuckFor(boot: Boot | null | undefined, now = Date.now()) {
  if (!boot || !INSTALLING.has(boot.stage) || !boot.time) return null;
  const minutes = Math.floor((now - boot.time * 1000) / 60_000);
  return minutes >= STUCK_MINUTES ? { minutes, detail: boot.detail ?? '' } : null;
}

/**
 * The install a stopped server left unfinished, from the last status it reported (null when it finished or nothing is
 * known). resumable: launched with the bootstrap.sh that resumes on boot (its status counts runs); older servers don't.
 */
export function unfinishedInstall(rec: { lastBoot?: Boot; readyAt?: string }) {
  const b = rec.lastBoot;
  if (!b || b.stage === 'ready') return null;
  return { stage: b.stage, detail: b.lastFailure || b.detail || b.stage, resumable: typeof b.run === 'number' };
}

const warnedStuck = new Map<string, number>();

/** Keeps the server's own report (stage changes only, so polling doesn't rewrite the state file), and logs a stuck install once. */
function noteBoot(instanceId: string, boot: Boot) {
  const rec = record(instanceId);
  const prev = rec.lastBoot;
  if (!prev || prev.stage !== boot.stage || prev.detail !== boot.detail || prev.run !== boot.run) {
    saveRecord(instanceId, { lastBoot: { stage: boot.stage, detail: boot.detail, time: boot.time, run: boot.run, lastFailure: boot.lastFailure }, ...(boot.stage === 'ready' && !rec.readyAt ? { readyAt: new Date().toISOString() } : {}) });
  }
  const stuck = stuckFor(boot);
  if (stuck && warnedStuck.get(instanceId) !== boot.time) {
    warnedStuck.set(instanceId, boot.time!);
    console.warn(`[fleet] ${instanceId} looks stuck installing: no progress for ${stuck.minutes} min (at: ${stuck.detail}). It powers itself off after 20; the next start resumes the install.`);
  }
}

async function statusOf({ instance: i, region }: Found): Promise<ServerStatus> {
  const rec = record(i.InstanceId);
  const prof = profileOf(i);
  const ip = i.PublicIpAddress ?? null;
  const keyName = i.KeyName ?? rec.keyName;
  const out: ServerStatus = {
    exists: true, ...BASE(), id: i.InstanceId, region, type: i.InstanceType, state: i.State?.Name, reason: i.StateReason?.Message ?? null, ip,
    zone: i.Placement?.AvailabilityZone, launched: i.LaunchTime?.toISOString(), pricePerHour: priceIn(i.InstanceType, region),
    url: ip ? `http://${ip}:${PORT}` : null, user: prof.user, flavor: prof.flavor, hasToken: Boolean(rec.token), idleMinutes: rec.idleMinutes ?? null,
    key: keyName ? path.join(paths.fleet, `${keyName}.pem`) : null, boot: null,
    image: tagOf(i, 'Image') ?? rec.image ?? null, disposable: tagOf(i, 'Disposable') === 'yes' || rec.disposable === true,
    purpose: tagOf(i, 'Purpose') ?? rec.purpose ?? null, imageSource: rec.imageSource ?? null,
  };
  if (rec.imageSource) {
    out.boot = { stage: 'image source', detail: `cleaned for the image ${rec.imageSource}: it can't take jobs any more (terminate it once J agrees)` };
  } else if (i.State?.Name === 'running' && ip && rec.token) {
    try {
      const r = await fetch(`http://${ip}:${PORT}${prof.status}`, { headers: authHeader(rec.token, prof.user), signal: AbortSignal.timeout(4000) });
      out.boot = r.ok ? await r.json() : r.status === 401 ? { stage: 'locked out', detail: 'the server rejected the saved password' } : { stage: 'unreachable', detail: `HTTP ${r.status}` };
    } catch {
      out.boot = { stage: 'booting', detail: 'waiting for the server to answer (if this lasts, your IP may have changed: Refresh access)' };
    }
    if (out.boot && typeof out.boot.time === 'number' && !['locked out', 'unreachable', 'booting'].includes(out.boot.stage)) noteBoot(i.InstanceId, out.boot);
  } else if (i.State?.Name === 'running' && !rec.token) {
    out.boot = { stage: 'locked out', detail: 'Hawkes Gen has no password for it (DATA_DIR/fleet/server.json): it was launched elsewhere. Adopt its state first.' };
  }
  out.stuck = i.State?.Name === 'running' ? stuckFor(out.boot) : null;
  out.unfinished = !rec.imageSource && (i.State?.Name !== 'running' || !out.boot || out.boot.stage === 'booting') ? unfinishedInstall(record(i.InstanceId)) : null;
  return out;
}

export async function serverStatus(instanceId?: string): Promise<ServerStatus> {
  const found = await findServer(instanceId);
  if (!found) return { exists: false, ...BASE(), type: DEFAULT_TYPE, pricePerHour: TYPES[DEFAULT_TYPE].price };
  return statusOf(found);
}

/** Every server's status, newest first. Ready servers are brought to the configured idle stop. */
export async function fleetStatus({ syncIdle = true } = {}): Promise<ServerStatus[]> {
  const list = await Promise.all((await listServers()).map(statusOf));
  const idle = loadSettings().fleet.idleMinutes;
  if (syncIdle) for (const st of list) if (st.state === 'running' && st.boot?.stage === 'ready' && !st.purpose && st.idleMinutes !== idle) void setIdle(st.id!, idle);
  return list;
}

const settingIdle = new Set<string>();

/** Changes how long a running server waits idle before it stops itself (over SSH). */
export async function setIdle(instanceId: string, minutes: number) {
  const m = Math.max(10, Math.min(240, Math.round(Number(minutes))));
  if (settingIdle.has(instanceId)) return;
  settingIdle.add(instanceId);
  try {
    const found = await findServer(instanceId);
    const script = profileOf(found?.instance).idleScript;
    await sshRun(`sudo sed -i -E 's/^IDLE_MINUTES=.*/IDLE_MINUTES=${m}/' ${script} && grep -q '^IDLE_MINUTES=${m}$' ${script} && echo ok`, instanceId);
    saveRecord(instanceId, { idleMinutes: m });
    console.log(`[fleet] ${instanceId} now stops after ${m} idle minutes`);
  } catch (e: any) {
    console.warn(`[fleet] couldn't set the idle stop on ${instanceId}: ${e.message}`);
  } finally {
    settingIdle.delete(instanceId);
  }
}

async function vcpusInUse() {
  const used: Record<string, number> = {};
  for (const { instance: i, region } of await listServers()) {
    if (['running', 'pending'].includes(i.State?.Name)) used[region] = (used[region] ?? 0) + (TYPES[i.InstanceType]?.vcpus ?? 4);
  }
  return used;
}

// ---------------------------------------------------------------- regions

let regionCache: { at: number; value: any[] | null } = { at: 0, value: null };

/** Per region: GPU quota, open quota requests, and the zones offering each type. Cached for 5 minutes. */
export async function regionsInfo({ force = false } = {}) {
  if (!force && regionCache.value && Date.now() - regionCache.at < 5 * 60 * 1000) return regionCache.value;
  const value = await Promise.all(REGIONS.map(async (region) => {
    const out: any = { region, quota: null, requests: [], zones: {}, error: null };
    try {
      const q = await quotas(region).send(new GetServiceQuotaCommand(QUOTA));
      out.quota = q.Quota?.Value ?? 0;
    } catch (e: any) {
      out.error = `quota unreadable (${e.name})`;
    }
    try {
      const h = await quotas(region).send(new ListRequestedServiceQuotaChangeHistoryByQuotaCommand(QUOTA));
      out.requests = (h.RequestedQuotas ?? [])
        .sort((a, b) => (b.Created?.getTime() ?? 0) - (a.Created?.getTime() ?? 0))
        .slice(0, 3)
        .map((r) => ({ value: r.DesiredValue, status: r.Status, caseId: r.CaseId ?? null, created: r.Created?.toISOString() }));
    } catch {
      // The history is a nice-to-have.
    }
    try {
      const off = await ec2(region).send(new DescribeInstanceTypeOfferingsCommand({ LocationType: 'availability-zone', Filters: [{ Name: 'instance-type', Values: Object.keys(TYPES) }] }));
      for (const o of off.InstanceTypeOfferings ?? []) (out.zones[o.InstanceType!] ??= []).push(o.Location);
      for (const z of Object.values(out.zones) as string[][]) z.sort();
    } catch (e: any) {
      out.error ??= `offerings unreadable (${e.name})`;
    }
    return out;
  }));
  regionCache = { at: Date.now(), value };
  return value;
}

/** Quota request statuses AWS is still working on. */
export const OPEN_QUOTA_STATUSES = ['PENDING', 'CASE_OPENED'];

/** Why a GPU quota request shouldn't be filed (null when it can be): an unknown region, a silly size, no increase, one already open. */
export function quotaRequestProblem(region: string, value: unknown, current: number | null, requests: { status?: string; value?: number }[] = [], regions = REGIONS) {
  if (!regions.includes(region)) return `Not a region the fleet uses: ${region}`;
  const want = Math.round(Number(value));
  if (!(want >= 4 && want <= 64)) return 'Ask for between 4 and 64 vCPUs';
  if (current != null && want <= current) return `${region} already allows ${current} vCPUs; ask for more than that`;
  const open = requests.find((r) => OPEN_QUOTA_STATUSES.includes(r.status ?? ''));
  if (open) return `${region} already has a quota request open (${open.value} vCPUs, ${open.status}). Wait for AWS to answer it.`;
  return null;
}

/** One region's GPU quota now and its recent increase requests (newest first). Read-only, uncached. */
export async function quotaStatus(region: string) {
  if (!REGIONS.includes(region)) throw fleetError(`Not a region the fleet uses: ${region}`);
  const [q, h] = await Promise.all([
    quotas(region).send(new GetServiceQuotaCommand(QUOTA)),
    quotas(region).send(new ListRequestedServiceQuotaChangeHistoryByQuotaCommand(QUOTA)).catch(() => null),
  ]);
  const requests = (h?.RequestedQuotas ?? [])
    .sort((a, b) => (b.Created?.getTime() ?? 0) - (a.Created?.getTime() ?? 0))
    .slice(0, 5)
    .map((r) => ({ value: r.DesiredValue, status: r.Status, caseId: r.CaseId ?? null, created: r.Created?.toISOString() }));
  return { region, quota: q.Quota?.Value ?? 0, requests, open: requests.some((r) => OPEN_QUOTA_STATUSES.includes(r.status ?? '')) };
}

/** Asks AWS for more GPU quota in a region. Free; AWS reviews it. */
export async function requestQuota(region: string, value: number) {
  const now = REGIONS.includes(region) ? await quotaStatus(region).catch(() => null) : null;
  const problem = quotaRequestProblem(region, value, now?.quota ?? null, now?.requests);
  if (problem) throw fleetError(problem);
  const want = Math.round(Number(value));
  try {
    const r = await quotas(region).send(new RequestServiceQuotaIncreaseCommand({ ...QUOTA, DesiredValue: want }));
    regionCache.at = 0;
    return { region, value: r.RequestedQuota?.DesiredValue, status: r.RequestedQuota?.Status };
  } catch (e: any) {
    if (e.name === 'ResourceAlreadyExistsException') throw fleetError(`${region} already has a quota request open. Wait for AWS to answer it.`, 'quota');
    if (e.name === 'IllegalArgumentException' || e.name === 'InvalidParameterValueException') throw fleetError(`AWS wouldn't take that request: ${e.message}`, 'quota');
    throw fleetError(`${e.name}: ${e.message}`, classify(e));
  }
}

const scoreCache = new Map<string, { at: number; value: Record<string, number> }>();

/** AWS's spot placement scores (1 to 10 per region): where machines of a type are free. Read-only. */
export async function capacityScores(types = ['g6e.xlarge', 'g6e.2xlarge', 'g7e.2xlarge'], regions = [...REGIONS, 'us-west-1', 'ca-central-1']) {
  const client = new EC2Client(awsConfig());
  const out: Record<string, Record<string, number>> = {};
  for (const type of types) {
    const r = await client.send(new GetSpotPlacementScoresCommand({ InstanceTypes: [type], TargetCapacity: 1, TargetCapacityUnitType: 'units', RegionNames: regions }));
    out[type] = Object.fromEntries((r.SpotPlacementScores ?? []).map((s) => [s.Region!, s.Score!]));
  }
  return out;
}

async function scoresFor(type: string) {
  const hit = scoreCache.get(type);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = (await capacityScores([type], REGIONS))[type] ?? {};
  scoreCache.set(type, { at: Date.now(), value });
  return value;
}

/** Who the AWS keys belong to and the account's GPU quota. Read-only. */
export async function checkAccount() {
  const cfg = awsConfig();
  const out: any = { region: cfg.region };
  const me = await new STSClient(cfg).send(new GetCallerIdentityCommand({}));
  out.account = me.Account;
  out.arn = me.Arn;
  try {
    const q = await new ServiceQuotasClient(cfg).send(new GetServiceQuotaCommand(QUOTA));
    out.gpuQuota = q.Quota?.Value ?? null;
  } catch (e: any) {
    out.gpuQuota = `unreadable (${e.name})`;
  }
  return out;
}

// ----------------------------------------------------------------- set up

async function defaultVpc(region: string) {
  const r = await ec2(region).send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }));
  const vpc = r.Vpcs?.[0]?.VpcId;
  if (!vpc) throw fleetError(`${region} has no default VPC. Create one in the VPC console there (Actions > Create default VPC).`);
  return vpc;
}

async function ensureSecurityGroup(region: string, ip: string) {
  const vpc = await defaultVpc(region);
  const prof = PROFILES.gen;
  const found = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [prof.sg] }, { Name: 'vpc-id', Values: [vpc] }] }));
  let sg: any = found.SecurityGroups?.[0];
  if (!sg) {
    const made = await ec2(region).send(new CreateSecurityGroupCommand({
      GroupName: prof.sg,
      Description: 'Hawkes Gen GPU server: ComfyUI proxy and SSH from the developer IP only',
      VpcId: vpc,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: [{ Key: 'Project', Value: prof.project }, { Key: 'Name', Value: prof.sg }] }],
    }));
    sg = { GroupId: made.GroupId, IpPermissions: [] };
  }
  await allowOnly(region, sg, ip);
  return sg.GroupId as string;
}

/** Opens the proxy and SSH ports to one IP and closes them to any other. */
/** This machine's IP plus HAWKES_ALLOW_IPS (comma list): the laptop and the cloud control server can both get in. */
export function allowedIps(ip: string) {
  return [...new Set([ip, ...(env('HAWKES_ALLOW_IPS') ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s))])];
}

/** Opens the given ports to exactly these IPs (this machine's and HAWKES_ALLOW_IPS) and closes them to any other. */
export async function allowOnly(region: string, sg: any, ip: string, ports: number[] = [PORT, 22]) {
  const want = new Set(allowedIps(ip).map((x) => `${x}/32`));
  const stale: any[] = [];
  for (const perm of sg.IpPermissions ?? []) {
    for (const range of perm.IpRanges ?? []) {
      if (!want.has(range.CidrIp)) stale.push({ IpProtocol: perm.IpProtocol, FromPort: perm.FromPort, ToPort: perm.ToPort, IpRanges: [{ CidrIp: range.CidrIp }] });
    }
  }
  if (stale.length) await ec2(region).send(new RevokeSecurityGroupIngressCommand({ GroupId: sg.GroupId, IpPermissions: stale }));
  for (const port of ports) {
    for (const cidr of want) {
      const has = (sg.IpPermissions ?? []).some((p: any) => p.FromPort === port && (p.IpRanges ?? []).some((r: any) => r.CidrIp === cidr));
      if (has) continue;
      try {
        await ec2(region).send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: sg.GroupId,
          IpPermissions: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp: cidr, Description: 'hawkesgen' }] }],
        }));
      } catch (e: any) {
        if (e.name !== 'InvalidPermission.Duplicate') throw e;
      }
    }
  }
}

/** Lets this machine's current IP in, in every region with a server, for both kinds of security group. */
export async function refreshAccess(forIp?: string) {
  const ip = forIp ?? await myIp();
  const regions = [...new Set((await listServers()).map((s) => s.region))];
  if (!regions.length) regions.push(localState().region ?? homeRegion());
  for (const region of regions) {
    const r = await ec2(region).send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [PROFILES.gen.sg, PROFILES.dod.sg] }] }));
    for (const sg of r.SecurityGroups ?? []) await allowOnly(region, sg, ip);
  }
  return { ip, regions };
}

async function ensureKeyPair(region: string) {
  const base = region === 'us-east-1' ? PROFILES.gen.keyBase : `${PROFILES.gen.keyBase}-${region}`;
  const existing = await ec2(region).send(new DescribeKeyPairsCommand({ Filters: [{ Name: 'key-name', Values: [base] }] }));
  if (existing.KeyPairs?.length && fs.existsSync(path.join(paths.fleet, `${base}.pem`))) return base;
  // A key without its private half here is no use; make a fresh one with a new name.
  const name = existing.KeyPairs?.length ? `${base}-${Date.now()}` : base;
  const made = await ec2(region).send(new CreateKeyPairCommand({ KeyName: name, KeyType: 'ed25519', TagSpecifications: [{ ResourceType: 'key-pair', Tags: [{ Key: 'Project', Value: PROFILES.gen.project }] }] }));
  const file = path.join(paths.fleet, `${name}.pem`);
  fs.writeFileSync(file, made.KeyMaterial!, { mode: 0o600 });
  lockKey(file);
  return name;
}

/** Windows' ssh refuses a key other accounts can read, so give only this user read access. */
export function lockKey(file: string) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* not ours */ }
    return;
  }
  spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:R`], { stdio: 'ignore' });
}

export async function gpuImage(region: string) {
  const r = await ec2(region).send(new DescribeImagesCommand({
    Owners: ['amazon'],
    Filters: [
      { Name: 'name', Values: ['Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*'] },
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['x86_64'] },
    ],
  }));
  const img = (r.Images ?? []).sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))[0];
  if (!img) throw fleetError(`Could not find the AWS Deep Learning Base GPU image in ${region}.`);
  return img;
}

export function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(paths.server, 'models.json'), 'utf8')) as {
    comfyui: { repo: string; tag: string };
    nodes: { repo: string; commit: string }[];
    models: { dir: string; file: string; families: string[]; url: string }[];
  };
}

// ------------------------------------------------------------------ images
// The fleet's machine image: a ready install with ComfyUI and the core models (image.ts builds, copies and prunes
// it). An image matches when its ModelsKey tag is manifestKey(): ComfyUI's tag, the nodes and the core models.

export const IMAGE_ROLE = 'comfy-image';

/** A short hash of what an image must contain (models.json without its descriptions). */
export function manifestKey(m = loadManifest()) {
  const parts = { comfyui: m.comfyui, nodes: m.nodes.map((n) => [n.repo, n.commit]), models: m.models.map((x) => [x.dir, x.file, x.url]) };
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

export type FleetImage = { id: string; region: string; name: string; state: string; created: string; key: string | null; comfy: string | null; snapshots: string[]; usedGb: number | null; build: string | null; root: string };

const imageOf = (img: Image, region: string): FleetImage => {
  const tag = (k: string) => img.Tags?.find((t) => t.Key === k)?.Value ?? null;
  return {
    id: img.ImageId!, region, name: img.Name ?? '', state: img.State ?? '', created: img.CreationDate ?? '', key: tag('ModelsKey'), comfy: tag('ComfyUI'),
    snapshots: (img.BlockDeviceMappings ?? []).map((b) => b.Ebs?.SnapshotId).filter((x): x is string => Boolean(x)),
    usedGb: Number(tag('UsedGb')) || null, build: tag('Build'), root: img.RootDeviceName ?? '/dev/sda1',
  };
};

/** Every fleet image in a region (any state), newest first. */
export async function imagesIn(region: string): Promise<FleetImage[]> {
  const r = await ec2(region).send(new DescribeImagesCommand({ Owners: ['self'], Filters: [{ Name: 'tag:Project', Values: [PROFILES.gen.project] }, { Name: 'tag:Role', Values: [IMAGE_ROLE] }] }));
  return (r.Images ?? []).map((img) => imageOf(img, region)).sort((a, b) => b.created.localeCompare(a.created));
}

const imageCache = new Map<string, { at: number; value: FleetImage | null }>();
export const forgetImages = () => imageCache.clear();

/** The newest available image in a region that matches models.json, or null (then servers install from bootstrap.sh). Cached for 5 minutes. */
export async function findImage(region: string): Promise<FleetImage | null> {
  const hit = imageCache.get(region);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
  const key = manifestKey();
  const value = (await imagesIn(region)).find((img) => img.state === 'available' && img.key === key) ?? null;
  imageCache.set(region, { at: Date.now(), value });
  return value;
}

/** Whether a server launched now (in any fleet region) would come from the image. */
export async function imageAvailable() {
  for (const r of REGIONS) if (await findImage(r).catch(() => null)) return true;
  return false;
}

let sizeCache: { at: number; value: Record<string, number> } | null = null;

/** Each core model's size on Hugging Face ("dir/file" -> bytes; 0 when unknown). Cached for a day. */
export async function coreSizes() {
  if (sizeCache && Date.now() - sizeCache.at < 24 * 3600_000) return sizeCache.value;
  const m = loadManifest();
  const sizes = await Promise.all(m.models.map((x) => remoteSize(x.url)));
  const value = Object.fromEntries(m.models.map((x, i) => [`${x.dir}/${x.file}`, sizes[i]]));
  if (sizes.every(Boolean)) sizeCache = { at: Date.now(), value };
  return value;
}

/** firstboot.sh with the token, idle time, image and core models (with their sizes, checked at first boot) filled in, gzipped for EC2 user data. */
export function imageUserData(token: string, idleMinutes: number, imageId: string, sizes: Record<string, number> = {}) {
  const m = loadManifest();
  const script = fs.readFileSync(path.join(paths.server, 'firstboot.sh'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replaceAll('__TOKEN__', token)
    .replaceAll('__IDLE_MINUTES__', String(idleMinutes))
    .replaceAll('__IMAGE__', imageId)
    .replaceAll('__COMFY_TAG__', m.comfyui.tag)
    .replace('__MODELS__', m.models.map((x) => `${x.dir}/${x.file} ${sizes[`${x.dir}/${x.file}`] ?? 0}`).join('\n'));
  return zlib.gzipSync(Buffer.from(script)).toString('base64');
}

/** bootstrap.sh with the token, idle time and server/models.json filled in, gzipped for EC2 user data. */
export function userData(token: string, idleMinutes: number) {
  const m = loadManifest();
  const script = fs.readFileSync(path.join(paths.server, 'bootstrap.sh'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replaceAll('__TOKEN__', token)
    .replaceAll('__IDLE_MINUTES__', String(idleMinutes))
    .replaceAll('__COMFY_TAG__', m.comfyui.tag)
    .replaceAll('__COMFY_REPO__', m.comfyui.repo)
    .replace('__NODES__', m.nodes.map((n) => `${n.repo} ${n.commit}`).join('\n'))
    .replace('__BLENDER__', () => blenderInstall(''))
    .replace('__MODELS__', m.models.map((x) => `${x.dir} ${x.file} ${x.url}`).join('\n'));
  return zlib.gzipSync(Buffer.from(script)).toString('base64');
}

async function launchRegions(region: string, vcpus: number, type: string) {
  if (region && region !== 'auto') {
    if (!REGIONS.includes(region)) throw fleetError(`Not a region the fleet uses: ${region}`);
    return [region];
  }
  const info = await regionsInfo();
  const used = await vcpusInUse();
  const free = (r: string) => (info.find((x) => x.region === r)?.quota ?? 0) - (used[r] ?? 0);
  const score = type ? await scoresFor(type).catch(() => ({} as Record<string, number>)) : {};
  const order = [homeRegion(), ...REGIONS].filter((r, i, a) => a.indexOf(r) === i);
  const ok = order.filter((r) => free(r) >= vcpus).sort((a, b) => (score[b] ?? 0) - (score[a] ?? 0) || free(b) - free(a));
  if (!ok.length) {
    throw fleetError(`No region has ${vcpus} GPU vCPUs of quota free (${info.map((x) => `${x.region}: ${(x.quota ?? 0) - (used[x.region] ?? 0)} of ${x.quota ?? '?'} free`).join(', ')}). Stop a server, or request more quota.`, 'quota');
  }
  return ok;
}

/** Disk speed for servers launched from the image: their disk loads lazily from S3, and the warm-up reads ~90 GB. About $0.02/hr over the gp3 baseline. */
const IMAGE_DISK = { Iops: 4000, Throughput: 500 };

/**
 * Creates a server. Costs money from here on (see TYPES). type 'auto' tries
 * every type, cheapest first, in every region with quota free for it.
 * From the region's matching image when there is one (ready in minutes; disposable unless settings say otherwise),
 * else it installs itself (bootstrap.sh). fromImage false always installs (how images are built).
 */
export async function launchServer({ idleMinutes = loadSettings().fleet.idleMinutes, region = 'auto', type = DEFAULT_TYPE, max = loadSettings().fleet.servers, fromImage = true, purpose = '' } = {}) {
  if (type !== 'auto' && !TYPES[type]) throw fleetError(`Not an instance type the fleet uses: ${type}`);
  const existing = await listServers({ force: true });
  if (existing.length >= max) throw fleetError(`There are already ${existing.length} GPU servers (the most "servers" allows). Start one of them instead, or raise the setting.`);
  const ip = await myIp();
  const token = crypto.randomBytes(24).toString('base64url');
  const attempts: any[] = [];
  const setups = new Map<string, Promise<any>>();
  const prof = PROFILES.gen;
  const disposableSetting = loadSettings().fleet.disposable;

  const setupFor = (r: string) => {
    if (!setups.has(r)) {
      setups.set(r, (async () => {
        const [sg, key, fleetImage] = await Promise.all([ensureSecurityGroup(r, ip), ensureKeyPair(r), fromImage ? findImage(r).catch(() => null) : null]);
        const image = fleetImage ? { ImageId: fleetImage.id, Name: fleetImage.name, RootDeviceName: fleetImage.root } : await gpuImage(r);
        const vpc = await defaultVpc(r);
        const subnets = await ec2(r).send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'default-for-az', Values: ['true'] }] }));
        const disposable = Boolean(fleetImage) && disposableSetting && !purpose;
        const data = fleetImage ? imageUserData(token, idleMinutes, fleetImage.id, await coreSizes()) : userData(token, idleMinutes);
        const tags = [
          { Key: 'Project', Value: prof.project }, { Key: 'Name', Value: prof.name },
          ...(fleetImage ? [{ Key: 'Image', Value: fleetImage.id }] : []), ...(disposable ? [{ Key: 'Disposable', Value: 'yes' }] : []), ...(purpose ? [{ Key: 'Purpose', Value: purpose }] : []),
        ];
        return { sg, key, image, fleetImage, disposable, data, tags, subnets: subnets.Subnets ?? [] };
      })());
    }
    return setups.get(r)!;
  };

  const types = type === 'auto' ? Object.keys(TYPES) : [type];
  for (const t of types) {
    let regions: string[];
    try {
      regions = await launchRegions(region, TYPES[t].vcpus, t);
    } catch (e: any) {
      attempts.push({ region: region === 'auto' ? 'any' : region, zone: null, type: t, code: 'quota', kind: 'quota', message: e.message });
      continue;
    }
    for (const r of regions) {
      let setup: any;
      let candidates: any[];
      try {
        setup = await setupFor(r);
        const offered = await ec2(r).send(new DescribeInstanceTypeOfferingsCommand({ LocationType: 'availability-zone', Filters: [{ Name: 'instance-type', Values: [t] }] }));
        const zones = new Set((offered.InstanceTypeOfferings ?? []).map((o) => o.Location));
        candidates = setup.subnets.filter((s: any) => zones.has(s.AvailabilityZone));
        if (!candidates.length) throw fleetError(`${r} has no default subnet in a zone offering ${t}`, 'capacity');
      } catch (e: any) {
        const kind = e.kind ?? classify(e);
        attempts.push({ region: r, zone: null, type: t, code: e.name, kind, message: e.message });
        if (kind === 'auth') throw fleetError(`The AWS keys aren't allowed to set up a server in ${r}: ${e.message}`, 'auth', attempts);
        continue;
      }
      // First let AWS choose the zone, then try each zone.
      for (const subnet of [null, ...candidates]) {
        try {
          const res = await ec2(r).send(new RunInstancesCommand({
            ImageId: setup.image.ImageId, InstanceType: t as any, MinCount: 1, MaxCount: 1, KeyName: setup.key,
            ...(subnet ? { SubnetId: subnet.SubnetId } : {}),
            // A disposable server powering itself off (idle, or a failed first boot) is terminated with its disk.
            SecurityGroupIds: [setup.sg], UserData: setup.data, InstanceInitiatedShutdownBehavior: setup.disposable ? 'terminate' : 'stop',
            BlockDeviceMappings: [{ DeviceName: setup.image.RootDeviceName ?? '/dev/sda1', Ebs: { VolumeSize: DISK_GB, VolumeType: 'gp3', ...(setup.fleetImage ? IMAGE_DISK : { Iops: 3000, Throughput: 125 }), DeleteOnTermination: true } }],
            TagSpecifications: [{ ResourceType: 'instance', Tags: setup.tags }, { ResourceType: 'volume', Tags: setup.tags }],
          }));
          const instanceId = res.Instances?.[0]?.InstanceId!;
          const zone = res.Instances?.[0]?.Placement?.AvailabilityZone ?? subnet?.AvailabilityZone ?? 'any';
          saveState({ region: r });
          saveRecord(instanceId, {
            region: r, type: t, token, idleMinutes, keyName: setup.key, zone, launchedAt: new Date().toISOString(),
            ...(setup.fleetImage ? { image: setup.fleetImage.id } : {}), ...(setup.disposable ? { disposable: true } : {}), ...(purpose ? { purpose } : {}),
          });
          listCache.at = 0;
          attempts.push({ region: r, zone, type: t, code: 'ok', kind: 'ok', message: 'launched' });
          const how = setup.fleetImage ? `from the image ${setup.fleetImage.id}${setup.disposable ? ' (disposable: terminated when idle)' : ''}` : 'installing from bootstrap.sh (30-45 min; no matching image)';
          console.log(`[fleet] launched ${instanceId} in ${zone}, ${how}`);
          return { id: instanceId, region: r, zone, type: t, image: setup.image.Name, fromImage: setup.fleetImage?.id ?? null, disposable: setup.disposable, attempts };
        } catch (e: any) {
          const kind = classify(e);
          attempts.push({ region: r, zone: subnet?.AvailabilityZone ?? 'any zone', type: t, code: e.name, kind, message: e.message });
          if (kind === 'auth') throw fleetError(`The AWS keys aren't allowed to launch ${t} in ${r}: ${e.message}`, 'auth', attempts);
          if (kind === 'quota') break;
          if (kind !== 'capacity') throw fleetError(`${r} ${subnet?.AvailabilityZone ?? 'any zone'} ${t}: ${e.name}: ${e.message}`, kind, attempts);
        }
      }
    }
  }
  throw failure(type === 'auto' ? `any 48 GB GPU machine (${types.join(', ')})` : type, attempts);
}

function failure(type: string, attempts: any[]) {
  const kinds = new Set(attempts.map((a) => a.kind));
  const where = [...new Set(attempts.map((a) => a.region))].join(', ');
  if (kinds.size === 1 && kinds.has('capacity')) return fleetError(`AWS has no ${type} free right now in ${where}. This usually clears within minutes to hours; try again or keep trying.`, 'capacity', attempts);
  if (kinds.has('quota') && !kinds.has('capacity')) return fleetError(`The account's GPU quota is too low for ${type} in ${where}. Request more quota.`, 'quota', attempts);
  if (kinds.has('capacity')) return fleetError(`No capacity or quota for ${type} in ${where} right now.`, 'capacity', attempts);
  return fleetError(`Couldn't launch ${type}: ${attempts.map((a) => `${a.region}${a.zone ? ` ${a.zone}` : ''}: ${a.code}`).join(', ')}`, 'other', attempts);
}

async function requireServer(instanceId?: string) {
  const s = await findServer(instanceId);
  if (!s) throw fleetError(instanceId ? `There is no GPU server ${instanceId}.` : 'There is no GPU server yet. Launch one first.');
  return s;
}

export async function startServer(instanceId?: string) {
  const { instance: i, region } = await requireServer(instanceId);
  const source = record(i.InstanceId).imageSource;
  if (source) throw fleetError(`${i.InstanceId} was cleaned to make the image ${source}: it has no password or SSH keys any more, so it can't take jobs. Launch a new server (from the image) instead.`);
  const unfinished = unfinishedInstall(record(i.InstanceId));
  if (unfinished && !unfinished.resumable && i.State?.Name === 'stopped') {
    // Launched before installs resumed: started, it would sit half installed and never stop itself (2026-10-16).
    throw fleetError(`${i.InstanceId} stopped before its install finished (at: ${unfinished.detail}), and it was launched before installs could resume: started, it would sit idle and paying. Terminate it and launch a new one, or rerun its install by hand.`, 'other');
  }
  await refreshAccess();
  if (i.State?.Name === 'stopped') {
    try {
      await ec2(region).send(new StartInstancesCommand({ InstanceIds: [i.InstanceId] }));
      listCache.at = 0;
    } catch (e: any) {
      const kind = classify(e);
      const attempts = [{ region, zone: i.Placement?.AvailabilityZone, code: e.name, kind, message: e.message }];
      if (kind === 'capacity') throw fleetError(`AWS has no ${i.InstanceType} free in ${i.Placement?.AvailabilityZone} right now, so the server can't start. It stays where it is (with its models); try again or keep trying.`, 'capacity', attempts);
      if (kind === 'quota') throw fleetError(`${region} has no GPU quota free for another running server. Stop one there, or request more quota.`, 'quota', attempts);
      throw fleetError(`${e.name}: ${e.message}`, kind, attempts);
    }
  } else if (i.State?.Name !== 'running' && i.State?.Name !== 'pending') {
    throw fleetError(`The server is ${i.State?.Name}; wait for it to finish, then start it.`);
  }
  // A server stopped mid-install (or after its install failed) carries on from where it stopped: bootstrap.sh runs on every boot until ready.
  const note = unfinished ? `resuming the install (it stopped at: ${unfinished.detail}); not ready for jobs until it finishes` : undefined;
  if (note) console.log(`[fleet] starting ${i.InstanceId}: ${note}`);
  return { id: i.InstanceId, region, was: i.State?.Name, ...(note ? { resuming: true, note } : {}) };
}

/** Stops a server. A disposable one (launched from the image) is terminated instead: a stopped disk costs about $20/month, and the image brings a new one up in minutes. */
export async function stopServer(instanceId?: string) {
  const { instance: i, region } = await requireServer(instanceId);
  if (tagOf(i, 'Disposable') === 'yes' && ['running', 'pending', 'stopping', 'stopped'].includes(i.State?.Name)) {
    return { ...(await terminateServer(i.InstanceId)), was: i.State?.Name, terminated: true };
  }
  if (i.State?.Name === 'running' || i.State?.Name === 'pending') await ec2(region).send(new StopInstancesCommand({ InstanceIds: [i.InstanceId] }));
  listCache.at = 0;
  return { id: i.InstanceId, region, was: i.State?.Name };
}

/** Deletes a server and its disk (models included). Launching again re-downloads everything. */
export async function terminateServer(instanceId?: string) {
  const { instance: i, region } = await requireServer(instanceId);
  await ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [i.InstanceId] }));
  const st = localState();
  const servers = { ...st.servers };
  delete servers[i.InstanceId];
  saveState({ servers, ...(st.instanceId === i.InstanceId ? { instanceId: null, token: null } : {}), terminatedAt: new Date().toISOString() });
  listCache.at = 0;
  return { id: i.InstanceId, region };
}

export type Endpoint = { id: string; region: string; price: number; url: string; headers: Record<string, string> };

/** Every server ready for jobs. */
export async function comfyEndpoints(): Promise<Endpoint[]> {
  return (await fleetStatus())
    .filter((st) => st.state === 'running' && st.boot?.stage === 'ready' && !st.purpose)
    .map((st) => ({ id: st.id!, region: st.region!, price: st.pricePerHour, url: st.url!, headers: authHeader(record(st.id!).token!, st.user) }));
}

// -------------------------------------------------------------------- ssh

/** The last few real lines of ssh's stderr (never empty). */
function sshTail(err: string, code: number | null) {
  const lines = err.split('\n').map((l) => l.trim()).filter((l) => l && !/^Warning: Permanently added/i.test(l));
  return lines.slice(-3).join(' | ') || `exit ${code}`;
}

/** Turns ssh/scp's stderr into a message that says what really happened. Pure (tested). */
export function sshFailure(err: string, code: number | null, ctx: { id?: string; ip?: string; keyFile: string; platform?: string; what?: string }) {
  const where = `${ctx.id ?? 'server'}${ctx.ip ? ` (${ctx.ip})` : ''}, key ${ctx.keyFile}`;
  const what = ctx.what ?? 'ssh';
  if (/unprotected private key|bad permissions/i.test(err)) {
    return (ctx.platform ?? process.platform) === 'win32'
      ? `${what} refused the key file's permissions (${where}). In PowerShell: icacls "${ctx.keyFile}" /inheritance:r /grant:r "$env:USERNAME:R"`
      : `${what} refused the key file's permissions (${where}): chmod 600 ${ctx.keyFile}. ${sshTail(err, code)}`;
  }
  if (/permission denied \(.*publickey/i.test(err)) return `key rejected by ${where}: the key doesn't match this server. ${sshTail(err, code)}`;
  return `${what} failed on ${where}: ${sshTail(err, code)} (if your IP changed, refresh access)`;
}

const isKeyRejected = (err: string) => /permission denied \(.*publickey/i.test(err);
const goodKey = new Map<string, string>(); // instance id -> the key file that worked

/** The key files to try for a server, in order: the one that worked before, the instance's own, then every other .pem in the fleet folder. */
function keyCandidates(instanceId: string, keyName: string | undefined) {
  const own = keyName ? path.join(paths.fleet, `${keyName}.pem`) : null;
  let all: string[] = [];
  try { all = fs.readdirSync(paths.fleet).filter((n) => n.endsWith('.pem')).sort().map((n) => path.join(paths.fleet, n)); } catch { /* none */ }
  const first = [goodKey.get(instanceId), own].filter((k): k is string => Boolean(k) && fs.existsSync(k!));
  return [...new Set([...first, ...all])];
}

type Run = { code: number | null; out: string; err: string; spawnError?: string };
function runKeyed(cmd: string, args: string[], timeoutMs?: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: null, out, err, spawnError: e.message }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Runs ssh or scp with the server's key; when the server rejects it, tries the other keys in the fleet folder (adopted servers can carry another key pair) and remembers the one that works. */
async function withKey(cmd: 'ssh' | 'scp', found: Found, build: (key: string, ip: string) => string[], timeoutMs?: number): Promise<Run & { key: string }> {
  const ip = found.instance.PublicIpAddress as string;
  const id = found.instance.InstanceId as string;
  const keyName = found.instance.KeyName ?? record(id).keyName;
  const keys = keyCandidates(id, keyName);
  const own = keyName ? `${keyName}.pem` : '(none recorded)';
  if (!keys.length) throw fleetError(`No SSH key for ${id} (${ip}): its key pair is ${own} and there is no .pem in ${paths.fleet}.`);
  let last: (Run & { key: string }) | null = null;
  let retriedChmod = false;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    lockKey(key);
    let r = await runKeyed(cmd, build(key, ip), timeoutMs);
    if (/unprotected private key|bad permissions/i.test(r.err) && !retriedChmod && process.platform !== 'win32') {
      retriedChmod = true;
      try { fs.chmodSync(key, 0o600); } catch { /* not ours */ }
      r = await runKeyed(cmd, build(key, ip), timeoutMs);
    }
    last = { ...r, key };
    if (r.spawnError) throw fleetError(`Couldn't run ${cmd} (${r.spawnError}). Install OpenSSH.`);
    if (r.code === 0 || (cmd === 'ssh' && r.out)) { goodKey.set(id, key); return last; }
    if (!isKeyRejected(r.err)) break;
    if (goodKey.get(id) === key) goodKey.delete(id);
  }
  return last!;
}

/** The address and SSH key of a running server (for tunnels). */
export async function sshTarget(instanceId: string) {
  const found = await findServer(instanceId);
  const ip = found?.instance.PublicIpAddress;
  if (!found || !ip) throw fleetError(`The server ${instanceId} is not running.`);
  const keyName = found.instance.KeyName ?? record(found.instance.InstanceId).keyName;
  const keys = keyCandidates(instanceId, keyName);
  if (!keys.length) throw fleetError(`No SSH key for ${instanceId} (${ip}): its key pair is ${keyName ?? '(none recorded)'}.pem and that file isn't in ${paths.fleet}.`);
  lockKey(keys[0]);
  return { ip: ip as string, key: keys[0] };
}

/** The ssh command for a GPU server (Linux: no Remote Desktop). The key file stays on the control server; only its name is given. */
export async function sshCommand(instanceId?: string) {
  const found = await findServer(instanceId);
  if (!found) throw fleetError('There is no GPU server.');
  const i = found.instance;
  const state = String(i.State?.Name ?? 'unknown');
  const ip = i.PublicIpAddress as string | undefined;
  if (state !== 'running' || !ip) return { ready: false, state, id: i.InstanceId as string };
  const keyName = i.KeyName ?? record(i.InstanceId).keyName;
  const keyFile = keyName ? `${keyName}.pem` : null;
  return { ready: true, state, id: i.InstanceId as string, ip, user: 'ubuntu', keyFile, command: `ssh ${keyFile ? `-i ${keyFile} ` : ''}ubuntu@${ip}` };
}

/** Runs a command on a server over SSH with its saved key; resolves to its output. */
export async function sshRun(remote: string, instanceId?: string, { timeoutMs = 120_000 } = {}): Promise<string> {
  const found = await findServer(instanceId);
  if (!found) throw fleetError('There is no GPU server.');
  const ip = found.instance.PublicIpAddress;
  if (!ip) throw fleetError(`The server is ${found.instance.State?.Name}; it has no address until it runs.`);
  const r = await withKey('ssh', found, (key, addr) => ['-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', `ubuntu@${addr}`, remote], timeoutMs);
  if (r.code === 0 || r.out) return r.out;
  throw fleetError(sshFailure(r.err, r.code, { id: found.instance.InstanceId, ip, keyFile: path.basename(r.key) }));
}

/** Copies a local file to a server (to /tmp, then moved into place with sudo). For models made here, e.g. trained LoRAs. */
export async function scpToServer(local: string, remote: string, instanceId?: string): Promise<void> {
  const found = await findServer(instanceId);
  const ip = found?.instance.PublicIpAddress;
  if (!found || !ip) throw fleetError('The GPU server is not running.');
  const tmp = `/tmp/hg-${crypto.randomBytes(6).toString('hex')}`;
  const r = await withKey('scp', found, (key, addr) => ['-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-q', local, `ubuntu@${addr}:${tmp}`]);
  if (r.code !== 0) throw fleetError(sshFailure(r.err, r.code, { id: found.instance.InstanceId, ip, keyFile: path.basename(r.key), what: 'upload (scp)' }));
  await sshRun(`sudo mkdir -p "$(dirname '${remote}')" && sudo mv ${tmp} '${remote}' && sudo chmod 644 '${remote}' && echo ok`, found.instance.InstanceId);
}

/** The setup log, disk, memory, GPU and ComfyUI, over SSH. */
export async function serverLog(lines = 40, instanceId?: string) {
  const n = Math.max(10, Math.min(400, Number(lines) || 40));
  const found = await findServer(instanceId);
  const log = profileOf(found?.instance).bootLog;
  return sshRun([
    'echo "## steps"', `sudo grep "^== " ${log} | tail -n 30`,
    'echo "## last lines"', `sudo tail -n ${n} ${log} | grep -v -E "^(Requirement already satisfied|  Downloading|  Using cached)"`,
    'echo "## ComfyUI"', 'systemctl show -p ExecStart --value comfyui 2>/dev/null | grep -o "argv\\[\\]=[^;]*"', 'sudo journalctl -u comfyui --no-pager -n 15 2>/dev/null | cut -c1-220',
    'echo "## machine"', 'uptime', 'df -h / | tail -1', 'free -h | sed -n 2,3p',
    'nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo "no GPU info"',
    'echo "ComfyUI service: $(systemctl is-active comfyui 2>/dev/null || echo not installed yet)"',
  ].join('; '), instanceId);
}

/** The ComfyUI flags that work on these machines (docs/comfyui.md), and ones that break them. */
export const COMFY_FLAGS = { want: ['--disable-pinned-memory'], avoid: ['--highvram', '--disable-dynamic-vram', '--gpu-only'] };

export async function serverHealth(instanceId?: string) {
  const out = await sshRun([
    'echo "flags=$(systemctl show -p ExecStart --value comfyui 2>/dev/null | grep -o "main.py[^;]*" | head -1)"',
    'echo "active=$(systemctl is-active comfyui 2>/dev/null)"',
    "free -m | awk '/^Mem:/{print \"ram=\"$3\"/\"$2} /^Swap:/{print \"swap=\"$3\"/\"$2}'",
    "df -BG / | awk 'NR==2{print \"disk=\"$3\"/\"$2}'",
    'echo "gpu=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | tr -d " ")"',
  ].join('; '), instanceId);
  const v: Record<string, string> = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...r]) => [k.trim(), r.join('=').trim()]));
  const flags = (v.flags ?? '').split(/\s+/).filter((f) => f.startsWith('--'));
  const missing = COMFY_FLAGS.want.filter((f) => !flags.includes(f));
  const bad = COMFY_FLAGS.avoid.filter((f) => flags.includes(f));
  const [gUsed, gTotal] = (v.gpu ?? '').split(',').map(Number);
  return {
    ok: !missing.length && !bad.length && v.active === 'active', active: v.active ?? 'unknown', flags, missing, bad,
    ram: v.ram ?? null, swap: v.swap ?? null, disk: v.disk ?? null, gpu: Number.isFinite(gTotal) ? { usedMb: gUsed, totalMb: gTotal } : null,
  };
}

/** Puts ComfyUI on the flags that work and restarts it. */
export async function fixServer(instanceId?: string) {
  const want = `--listen 127.0.0.1 --port 8188 --disable-auto-launch ${COMFY_FLAGS.want.join(' ')}`;
  await sshRun([
    `sudo sed -i -E "s|^(ExecStart=.*main\\.py).*|\\1 ${want}|" /etc/systemd/system/comfyui.service`,
    'sudo systemctl daemon-reload', 'sudo systemctl restart comfyui',
    'for i in $(seq 1 45); do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8188/system_stats | grep -q 200 && break; sleep 2; done',
  ].join(' && '), instanceId);
  return serverHealth(instanceId);
}

/**
 * Brings a running server up to server/models.json: downloads model files it
 * doesn't have and installs missing custom nodes (then restarts ComfyUI).
 * How a workflow added after a server was launched gets its models.
 */
export async function syncServer(instanceId?: string, { families }: { families?: string[] } = {}) {
  const m = loadManifest();
  const models = m.models.filter((x) => !families || x.families.some((f) => families.includes(f)));
  const have = new Set((await sshRun('cd /opt/comfy/models && find . -type f -size +1k | sed "s|^./||"', instanceId)).split('\n').map((s) => s.trim()).filter(Boolean));
  const missingModels = models.filter((x) => !have.has(`${x.dir}/${x.file}`));
  const nodesHave = new Set((await sshRun('ls /opt/comfy/custom_nodes', instanceId)).split('\n').map((s) => s.trim()));
  const missingNodes = m.nodes.filter((n) => !nodesHave.has(path.basename(n.repo, '.git')));
  const steps: string[] = [];
  for (const n of missingNodes) {
    const name = path.basename(n.repo, '.git');
    steps.push(`cd /opt/comfy/custom_nodes && sudo git clone ${n.repo} ${name} && sudo git -C ${name} checkout ${n.commit} && ( [ ! -f ${name}/requirements.txt ] || sudo /opt/comfy/venv/bin/pip install -r ${name}/requirements.txt )`);
  }
  for (const x of missingModels) {
    steps.push(`sudo mkdir -p /opt/comfy/models/${x.dir} && sudo aria2c -q -x 16 -s 16 -c --file-allocation=none -d /opt/comfy/models/${x.dir} -o '${x.file}' '${x.url}'`);
  }
  if (missingNodes.length) steps.push('sudo systemctl restart comfyui');
  if (steps.length) await sshRun(steps.join(' && '), instanceId, { timeoutMs: 60 * 60 * 1000 });
  return { models: missingModels.map((x) => `${x.dir}/${x.file}`), nodes: missingNodes.map((n) => path.basename(n.repo, '.git')) };
}

// ------------------------------------------------------------------ models
// Workflow tools name the models they need (with download links). A server
// gets them the first time a job needs them; prune frees disk later.

export const MODELS_DIR = '/opt/comfy/models';
const modelCache = new Map<string, { at: number; files: Map<string, number>; free: number }>();

/** The model files a server has ("dir/file" -> bytes) and its free disk, over SSH. Cached for 10 minutes. */
export async function serverModels(instanceId: string, { force = false } = {}) {
  const hit = modelCache.get(instanceId);
  if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const out = await sshRun(`find ${MODELS_DIR} -type f -size +1k -printf '%P\t%s\n'; echo "__free\t$(df --output=avail -B1 / | tail -1)"`, instanceId);
  const files = new Map<string, number>();
  let free = 0;
  for (const line of out.split('\n')) {
    const [p, size] = line.trim().split('\t');
    if (!p) continue;
    if (p === '__free') free = Number(size);
    else files.set(p, Number(size));
  }
  const v = { at: Date.now(), files, free };
  modelCache.set(instanceId, v);
  return v;
}

/** A download's size from its headers (follows redirects), or 0 when unknown. Remembered per URL. */
const remoteSizes = new Map<string, number>();
async function remoteSize(url: string) {
  if (remoteSizes.has(url)) return remoteSizes.get(url)!;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const n = Number(r.headers.get('x-linked-size') ?? r.headers.get('content-length') ?? 0);
    if (n) remoteSizes.set(url, n);
    return n;
  } catch {
    return 0;
  }
}

/**
 * Downloads the models a server is missing (aria2c, 16 connections, straight
 * from Hugging Face to the server). Refuses when the disk would get too full,
 * with what to prune. onProgress gets a line per file.
 */
export async function installModels(instanceId: string, models: { dir: string; file: string; url: string }[], onProgress: (line: string) => void = () => {}) {
  const have = await serverModels(instanceId);
  // A file that's there but shorter than the download (a cut-off copy: ComfyUI fails with "extends past the end of the
  // file") counts as missing: aria2c -c finishes it.
  const want = await Promise.all(models.map((m) => remoteSize(m.url)));
  const missing = models.filter((m, i) => {
    const got = have.files.get(`${m.dir}/${m.file}`);
    return got === undefined || (want[i] > 0 && got < want[i]);
  });
  if (!missing.length) return [];
  const sizes = missing.map((m) => {
    const full = want[models.indexOf(m)];
    return Math.max(0, full - (have.files.get(`${m.dir}/${m.file}`) ?? 0));
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  const reserve = 15e9;
  if (total && have.free - total < reserve) {
    // Make room: remove the models this server used least recently (never core models,
    // never ones this job needs). They download again when a job needs them.
    const need = total + reserve - have.free;
    const keep = new Set([...loadManifest().models.map((m) => `${m.dir}/${m.file}`), ...models.map((m) => `${m.dir}/${m.file}`)]);
    const used = record(instanceId).modelsUsed ?? {};
    const candidates = [...have.files.entries()].filter(([f]) => !keep.has(f)).sort((a, b) => (used[a[0]] ?? 0) - (used[b[0]] ?? 0));
    const remove: string[] = [];
    let freed = 0;
    for (const [f, bytes] of candidates) {
      if (freed >= need) break;
      remove.push(f);
      freed += bytes;
    }
    // Not enough even after pruning: grow the disk when the settings allow it (fleet.maxDiskGb), and keep what's there.
    if (loadSettings().fleet.maxDiskGb && (!loadSettings().fleet.autoPrune || freed < need)) {
      await growDisk(instanceId, need, onProgress);
      return installModels(instanceId, models, onProgress);
    }
    if (!loadSettings().fleet.autoPrune || freed < need) {
      throw new GenError(`Server ${instanceId} needs ${(total / 1e9).toFixed(1)} GB for ${missing.map((m) => m.file).join(', ')} but has ${(have.free / 1e9).toFixed(1)} GB free (keeping ${reserve / 1e9} GB spare)${loadSettings().fleet.autoPrune ? ', and removing unused models would not free enough' : ''}. Prune models (fleet models) or use another server.`, { status: 409, kind: 'disk' });
    }
    onProgress(`making room: removing ${remove.length} model${remove.length > 1 ? 's' : ''} not used lately (${(freed / 1e9).toFixed(1)} GB)`);
    await pruneModels(instanceId, remove);
  }
  for (const [i, m] of missing.entries()) {
    onProgress(`installing model ${i + 1} of ${missing.length}: ${m.file}${sizes[i] ? ` (${(sizes[i] / 1e9).toFixed(1)} GB)` : ''}`);
    if (!/^[\w.-]+$/.test(m.file) || !/^[\w./-]+$/.test(m.dir) || !/^https:\/\/[^\s'"]+$/.test(m.url)) throw new GenError(`Refusing an odd model entry: ${m.dir}/${m.file}`);
    const full = want[models.indexOf(m)];
    const check = full ? `test $(stat -c %s ${MODELS_DIR}/${m.dir}/${m.file}) -eq ${full}` : `test -s ${MODELS_DIR}/${m.dir}/${m.file}`;
    await sshRun(`sudo mkdir -p ${MODELS_DIR}/${m.dir} && for a in 1 2 3; do sudo aria2c -q -x 16 -s 16 -c --file-allocation=none -d ${MODELS_DIR}/${m.dir} -o '${m.file}' '${m.url}' && ${check} && break; sleep 10; done && ${check} && echo ok`, instanceId, { timeoutMs: 60 * 60 * 1000 });
  }
  modelCache.delete(instanceId);
  return missing.map((m) => `${m.dir}/${m.file}`);
}

/**
 * Grows a server's root disk by at least `bytes` (rounded up to 50 GB, never past settings.fleet.maxDiskGb), then its
 * partition and filesystem, while it runs. EBS allows one change per volume every six hours.
 */
export async function growDisk(instanceId: string, bytes: number, onProgress: (line: string) => void = () => {}) {
  const region = record(instanceId).region ?? localState().region ?? homeRegion();
  const client = ec2(region);
  const inst = (await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))).Reservations?.[0]?.Instances?.[0];
  const rootName = inst?.RootDeviceName;
  const volumeId = inst?.BlockDeviceMappings?.find((b) => b.DeviceName === rootName)?.Ebs?.VolumeId;
  if (!volumeId) throw new GenError(`Couldn't find ${instanceId}'s disk`);
  const vol = (await client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))).Volumes?.[0];
  const now = vol?.Size ?? DISK_GB;
  const max = loadSettings().fleet.maxDiskGb;
  const want = Math.min(max, Math.ceil((now + bytes / 1e9) / 50) * 50);
  if (want <= now) throw new GenError(`Server ${instanceId}'s disk is ${now} GB, the most fleet.maxDiskGb (${max}) allows; it needs ${(bytes / 1e9).toFixed(1)} GB more`, { status: 409, kind: 'disk' });
  onProgress(`growing the disk from ${now} to ${want} GB (about $${((want - now) * 0.08).toFixed(0)}/month more)`);
  await client.send(new ModifyVolumeCommand({ VolumeId: volumeId, Size: want }));
  // The new size can be used once the change is "optimizing" (it finishes in the background).
  for (let i = 0; i < 60; i++) {
    const m = (await client.send(new DescribeVolumesModificationsCommand({ VolumeIds: [volumeId] }))).VolumesModifications?.[0];
    if (m?.ModificationState === 'optimizing' || m?.ModificationState === 'completed') break;
    if (m?.ModificationState === 'failed') throw new GenError(`Growing ${instanceId}'s disk failed: ${m.StatusMessage ?? ''}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  await sshRun(
    'ROOT=$(findmnt -n -o SOURCE /) && PART=$(cat /sys/class/block/$(basename $ROOT)/partition) && DISK=/dev/$(lsblk -no pkname $ROOT) && ' +
      '(sudo growpart $DISK $PART || true) && (sudo resize2fs $ROOT || sudo xfs_growfs /) && df -h / | tail -1',
    instanceId, { timeoutMs: 5 * 60 * 1000 },
  );
  modelCache.delete(instanceId);
  onProgress(`the disk is now ${want} GB`);
  return want;
}

/** Remembers when a server last used these models (for least-recently-used pruning). */
export function markModelsUsed(instanceId: string, models: { dir: string; file: string }[]) {
  const rec = record(instanceId);
  const used = { ...(rec.modelsUsed ?? {}) };
  for (const m of models) used[`${m.dir}/${m.file}`] = Date.now();
  saveRecord(instanceId, { modelsUsed: used });
}

/** Deletes model files from a server (re-downloaded when a job needs them again). Never the core models in server/models.json. */
export async function pruneModels(instanceId: string, files: string[]) {
  const core = new Set(loadManifest().models.map((m) => `${m.dir}/${m.file}`));
  const remove = files.filter((f) => !core.has(f) && /^[\w./-]+$/.test(f) && !f.includes('..'));
  if (remove.length) await sshRun(`cd ${MODELS_DIR} && sudo rm -f ${remove.map((f) => `'${f}'`).join(' ')}`, instanceId);
  modelCache.delete(instanceId);
  return remove;
}
