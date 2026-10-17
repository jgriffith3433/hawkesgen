// The GPU fleet's machine image: a ready install (ComfyUI, its nodes and the core models of server/models.json)
// that new servers launch from, so they are ready in minutes instead of installing for 30-45 (fleet.ts
// launchServer; server/firstboot.sh). Servers launched from it are disposable: idle, they are terminated.
//
// A build turns a ready server into the image ("as is": a stopped ready server imaged without starting it, no prep,
// for when AWS has no machine free to start it; firstboot.sh then removes leftovers and wrong-sized models on every
// server launched from it, and the source stays a normal server):
//   launching   (no source given) a new server installs itself from server/bootstrap.sh, the way images are built
//   installing  waits for it to be ready (starting it again if its install powered it off: installs resume)
//   preparing   server/image-prep.sh over SSH: leftovers and non-core models removed, every core model's size
//               checked (and re-downloaded + sha256 checked when wrong), ComfyUI and node versions read back,
//               per-server state stripped (password, host keys, idle clock, logs, cloud-init)
//   stopping    stops it
//   imaging     CreateImage from the stopped server, tagged with ComfyUI's tag and manifestKey()
//   copying     copies it to every fleet region
//   pruning     deletes older fleet images and their snapshots; terminates the source when the build launched it
//               (a source J chose stays stopped and marked "image source": terminating it is J's call)
// The build is saved in DATA_DIR/fleet/image.json after every step, so it carries on after a restart.
// Costs: the build server's time (~$1.86/hr), and each image's snapshot, ~$0.05 per GB-month in each region.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CreateImageCommand, CopyImageCommand, DeregisterImageCommand, DeleteSnapshotCommand, DescribeImagesCommand, StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { paths, loadSettings } from '../../config.ts';
import { GenError } from '../../util.ts';
import {
  REGIONS, PROFILES_GEN, IMAGE_ROLE, ec2, loadManifest, manifestKey, imagesIn, forgetImages, findServer, serverStatus, startServer,
  launchServer, terminateServer, scpToServer, sshRun, saveServerRecord, serverRecord, DEFAULT_TYPE, type FleetImage,
} from './fleet.ts';

const FILE = path.join(paths.fleet, 'image.json');
/** Snapshot storage, dollars per GB-month (EBS snapshots, standard tier). */
export const SNAPSHOT_PER_GB_MONTH = 0.05;

type Phase = 'launching' | 'installing' | 'preparing' | 'stopping' | 'imaging' | 'copying' | 'pruning' | 'done' | 'failed';
export type ImageBuild = {
  id: string; phase: Phase; active: boolean; key: string; comfy: string;
  /** The server being imaged; launched: this build launched it (so it terminates it at the end). */
  from?: string; launched: boolean; region?: string;
  /** Imaged without image-prep.sh (firstboot.sh cleans up instead); the source stays a normal server. */
  asIs?: boolean;
  image?: string; copies: Record<string, string>; usedGb?: number;
  prep?: { removed: string[]; fixed: string[] };
  starts: number; errors: number; capacityMisses?: number; capacitySince?: string; started: string; updated: string; ended?: string; error?: string;
  log: { at: string; msg: string }[];
};

let current: ImageBuild | null = load();
let timer: NodeJS.Timeout | null = null;
let ticking = false;

function load(): ImageBuild | null {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}
function save() {
  if (!current) return;
  current.updated = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
}
function note(msg: string) {
  if (!current) return;
  current.log.push({ at: new Date().toISOString(), msg });
  current.log = current.log.slice(-80);
  console.log(`[image] ${msg}`);
  save();
}
function to(phase: Phase, msg?: string) {
  current!.phase = phase;
  current!.errors = 0;
  if (msg) note(msg);
  else save();
}

/** The images in every fleet region, which one each region launches from, and the build. */
export async function imageStatus() {
  const key = manifestKey();
  const m = loadManifest();
  const regions = await Promise.all(REGIONS.map(async (region) => {
    try {
      const images = await imagesIn(region);
      const use = images.find((i) => i.state === 'available' && i.key === key) ?? null;
      return { region, current: use, others: images.filter((i) => i !== use), error: null };
    } catch (e: any) {
      return { region, current: null, others: [] as FleetImage[], error: `${e.name}: ${e.message}` };
    }
  }));
  const all = regions.flatMap((r) => [r.current, ...r.others].filter(Boolean) as FleetImage[]);
  const gb = all.reduce((a, i) => a + (i.usedGb ?? 0), 0);
  return {
    key, comfy: m.comfyui.tag, models: m.models.length,
    /** Every region has an image that matches models.json. */
    ready: regions.every((r) => r.current), anywhere: regions.some((r) => r.current),
    /** Images exist, but none matches models.json any more: build a new one. */
    stale: !regions.some((r) => r.current) && all.length > 0,
    regions, costPerMonth: Math.round(gb * SNAPSHOT_PER_GB_MONTH * 100) / 100,
    disposable: loadSettings().fleet.disposable, build: current,
  };
}

/**
 * Builds a new image. from: a ready (or stopped, ready) Gen server to image as it is; otherwise one is launched and
 * installs itself first. Costs money: the server's time and the image's storage. The caller has the owner's OK.
 */
export async function startImageBuild({ from, region, asIs = false }: { from?: string; region?: string; asIs?: boolean } = {}) {
  if (asIs && !from) throw new GenError('"as is" images an existing server: give its id (from).', { status: 400 });
  if (current?.active) throw new GenError(`An image build is already running (${current.phase}, ${current.id}).`, { status: 409 });
  if (from) {
    const st = await serverStatus(from);
    if (!st.exists || st.id !== from) throw new GenError(`There is no GPU server ${from}.`, { status: 404 });
    if (st.flavor !== 'gen') throw new GenError(`${from} is a Dose Of Destruction server: image a Gen server (its install matches bootstrap.sh).`, { status: 409 });
    if (st.purpose && st.purpose !== 'image-build') throw new GenError(`${from} is a ${st.purpose} server.`, { status: 409 });
    if (asIs && !['stopped', 'running'].includes(st.state ?? '')) throw new GenError(`${from} is ${st.state}; image it once it's stopped.`, { status: 409 });
    if (serverRecord(from).imageSource) throw new GenError(`${from} was already cleaned for an image; build from a fresh install instead.`, { status: 409 });
    const ready = st.boot?.stage === 'ready' || (st.state === 'stopped' && serverRecord(from).lastBoot?.stage === 'ready');
    if (!ready) throw new GenError(`${from} hasn't finished installing (${st.boot?.stage ?? st.state}).`, { status: 409 });
  }
  // While it's being imaged, the queue gives it no jobs (fleet.ts comfyEndpoints skips servers with a purpose).
  if (from) saveServerRecord(from, { purpose: 'image-build' });
  const now = new Date().toISOString();
  current = {
    id: `img_${Date.now().toString(36)}`, phase: asIs ? 'stopping' : from ? 'preparing' : 'launching', active: true, asIs, key: manifestKey(), comfy: loadManifest().comfyui.tag,
    from, launched: false, region: from ? (await findServer(from))?.region : region, copies: {}, starts: 0, errors: 0, started: now, updated: now, log: [],
  };
  note(asIs ? `imaging ${from} as it is (no prep: servers launched from it clean up at first boot)` : from ? `building an image from ${from}` : 'building an image from a fresh install');
  schedule(0);
  return current;
}

/** Stops a build where it is (the server is left as it is; nothing is deleted). */
export function cancelImageBuild() {
  if (!current?.active) return current;
  Object.assign(current, { active: false, ended: new Date().toISOString(), error: 'cancelled' });
  if (current.from && !current.launched && !serverRecord(current.from).imageSource) saveServerRecord(current.from, { purpose: undefined });
  note(`cancelled at ${current.phase}${current.from ? ` (server ${current.from} left as it is)` : ''}`);
  if (timer) clearTimeout(timer);
  return current;
}

/** Carries on a build a restart interrupted. */
export function resumeImageBuild() {
  if (current?.active) {
    console.log(`[image] resuming the build ${current.id} at ${current.phase}`);
    schedule(5_000);
  }
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

const TRIES = 6;

async function tick() {
  if (!current?.active || ticking) return;
  ticking = true;
  let wait = 30_000;
  try {
    const next = await step(current);
    if (next === 'now') wait = 1_000;
  } catch (e: any) {
    if (e.kind === 'capacity' && !e.fatal) {
      // AWS has no machine free in the server's zone: not a failure, keep trying (a stopped server can't change zone).
      current.capacityMisses = (current.capacityMisses ?? 0) + 1;
      if (current.capacityMisses === 1 || current.capacityMisses % 15 === 0) note(`${current.phase}: AWS has no machine free in the server's zone; trying every 2 minutes (${current.capacityMisses} tries so far)`);
      else save();
      if (Date.now() - Date.parse(current.capacitySince ??= new Date().toISOString()) > 8 * 3600_000) fail(`AWS had no machine free for 8 hours: ${e.message}`);
      ticking = false;
      if (current?.active) schedule(120_000);
      return;
    }
    current.errors++;
    note(`${current.phase}: ${e.message}${current.errors < TRIES ? ` (try ${current.errors} of ${TRIES})` : ''}`);
    if (current.errors >= TRIES || e.fatal) fail(e.message);
    wait = 60_000;
  } finally {
    ticking = false;
  }
  if (current?.active) schedule(wait);
}

function fail(message: string) {
  const b = current!;
  Object.assign(b, { active: false, phase: 'failed', ended: new Date().toISOString(), error: message });
  note(`failed: ${message}${b.from ? `. Stopping the server ${b.from} (nothing is deleted).` : ''}`);
  if (!b.from) return;
  if (!b.launched && !serverRecord(b.from).imageSource) saveServerRecord(b.from, { purpose: undefined });
  void findServer(b.from).then(async (f) => {
    if (f && ['running', 'pending'].includes(f.instance.State?.Name)) await ec2(f.region).send(new StopInstancesCommand({ InstanceIds: [b.from!] }));
  }).catch((e) => console.warn(`[image] couldn't stop ${b.from}: ${e.message}`));
}
const fatal = (message: string) => Object.assign(new GenError(message), { fatal: true });

/** One step of the build. 'now': go straight on; otherwise check again in a while. */
async function step(b: ImageBuild): Promise<'now' | 'wait'> {
  switch (b.phase) {
    case 'launching': {
      const max = loadSettings().fleet.servers + 1; // A build server is temporary: it may go one over the cap.
      const r = await launchServer({ fromImage: false, purpose: 'image-build', region: b.region ?? 'auto', type: DEFAULT_TYPE, max });
      Object.assign(b, { from: r.id, region: r.region, launched: true });
      to('installing', `launched ${r.id} in ${r.zone} to install from bootstrap.sh (30-45 min)`);
      return 'wait';
    }
    case 'installing': {
      const st = await serverStatus(b.from);
      if (st.id !== b.from) throw fatal(`the build server ${b.from} is gone`);
      if (st.state === 'running' && st.boot?.stage === 'ready') {
        to('preparing', `${b.from} is ready`);
        return 'now';
      }
      if (st.state === 'stopped') return restart(b, `its install stopped (${st.unfinished?.detail ?? 'unknown'}); starting it to resume`);
      if (Date.now() - Date.parse(b.started) > 4 * 3600_000) throw fatal('the install took over 4 hours');
      if (st.boot?.detail && b.log.at(-1)?.msg !== `installing: ${st.boot.detail}`) note(`installing: ${st.boot.detail}`);
      return 'wait';
    }
    case 'preparing': {
      const st = await serverStatus(b.from);
      if (st.id !== b.from) throw fatal(`the server ${b.from} is gone`);
      if (st.state === 'stopped') return restart(b, `starting ${b.from} to clean it up (a few minutes at ~$${st.pricePerHour.toFixed(2)}/hr)`);
      if (st.state !== 'running' || st.boot?.stage !== 'ready') return 'wait';
      await prepare(b);
      to('stopping', `cleaned ${b.from} (${b.usedGb ?? '?'} GB used); stopping it`);
      return 'now';
    }
    case 'stopping': {
      const found = await findServer(b.from);
      const state = found?.instance.State?.Name;
      if (!found) throw fatal(`the server ${b.from} is gone`);
      if (state === 'stopped') {
        to('imaging', `${b.from} stopped; creating the image`);
        return 'now';
      }
      if (state === 'running' || state === 'pending') await ec2(found.region).send(new StopInstancesCommand({ InstanceIds: [b.from!] }));
      return 'wait';
    }
    case 'imaging': {
      if (!b.image) {
        const name = `hawkesgen-comfy-${b.comfy}-${b.key}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
        const tags = imageTags(b);
        const r = await ec2(b.region!).send(new CreateImageCommand({
          InstanceId: b.from, Name: name, NoReboot: true,
          Description: `Hawkes Gen GPU server: ComfyUI ${b.comfy}, core models ${b.key} (server/models.json), from ${b.from}`,
          TagSpecifications: [{ ResourceType: 'image', Tags: tags }, { ResourceType: 'snapshot', Tags: tags }],
        }));
        b.image = r.ImageId;
        b.copies[b.region!] = r.ImageId!;
        note(`creating ${r.ImageId} in ${b.region} (snapshotting ~${b.usedGb ?? '?'} GB takes a while)`);
      }
      const state = await imageState(b.region!, b.image!);
      if (state === 'available') {
        to('copying', `${b.image} is available in ${b.region}`);
        return 'now';
      }
      if (state === 'failed' || state === 'invalid' || state === 'error') throw fatal(`the image ${b.image} ${state}`);
      return 'wait';
    }
    case 'copying': {
      let pending = 0;
      for (const r of REGIONS) {
        if (!b.copies[r]) {
          const tags = imageTags(b);
          const c = await ec2(r).send(new CopyImageCommand({
            SourceImageId: b.image, SourceRegion: b.region, Name: `hawkesgen-comfy-${b.comfy}-${b.key}-${b.id}`,
            Description: `Copy of ${b.image} (${b.region})`, TagSpecifications: [{ ResourceType: 'image', Tags: tags }, { ResourceType: 'snapshot', Tags: tags }],
          }));
          b.copies[r] = c.ImageId!;
          note(`copying to ${r}: ${c.ImageId}`);
        }
        const state = await imageState(r, b.copies[r]);
        if (state === 'failed' || state === 'invalid' || state === 'error') throw fatal(`the copy ${b.copies[r]} in ${r} ${state}`);
        if (state !== 'available') pending++;
      }
      if (pending) return 'wait';
      forgetImages();
      to('pruning', `available in ${REGIONS.join(', ')}`);
      return 'now';
    }
    case 'pruning': {
      const removed = await pruneImages();
      if (removed.length) note(`deleted ${removed.length} older image(s) and their snapshots: ${removed.map((x) => `${x.id} (${x.region})`).join(', ')}`);
      if (b.launched && b.from) {
        await terminateServer(b.from).catch((e) => note(`couldn't terminate the build server ${b.from}: ${e.message}`));
        note(`terminated the build server ${b.from}`);
      } else if (b.from && b.asIs) {
        saveServerRecord(b.from, { purpose: undefined });
        note(`${b.from} is a normal server again (stopped, unchanged)`);
      } else if (b.from) {
        note(`${b.from} stays stopped as the image's source (its disk costs ~$20/month): terminating it is J's call`);
      }
      Object.assign(b, { active: false, ended: new Date().toISOString() });
      to('done', `done: new servers launch from ${Object.entries(b.copies).map(([r, id]) => `${id} (${r})`).join(', ')}`);
      return 'wait';
    }
    default:
      b.active = false;
      save();
      return 'wait';
  }
}

async function restart(b: ImageBuild, why: string) {
  if (b.starts >= 3) throw fatal(`${b.from} was started ${b.starts} times and still isn't ready`);
  if (!b.capacityMisses) note(why);
  await startServer(b.from);
  b.starts++;
  Object.assign(b, { capacityMisses: 0, capacitySince: undefined });
  note(`started ${b.from}`);
  return 'wait' as const;
}

function imageTags(b: ImageBuild) {
  return [
    { Key: 'Project', Value: PROFILES_GEN.project }, { Key: 'Role', Value: IMAGE_ROLE }, { Key: 'Name', Value: `hawkesgen-comfy-image-${b.comfy}` },
    { Key: 'ModelsKey', Value: b.key }, { Key: 'Prep', Value: b.asIs ? 'first-boot' : 'image-prep' }, { Key: 'ComfyUI', Value: b.comfy }, { Key: 'Source', Value: b.from ?? '' }, { Key: 'Build', Value: b.id },
    ...(b.usedGb ? [{ Key: 'UsedGb', Value: String(b.usedGb) }] : []),
  ];
}

async function imageState(region: string, id: string) {
  const r = await ec2(region).send(new DescribeImagesCommand({ ImageIds: [id] }));
  return r.Images?.[0]?.State ?? 'missing';
}

/** A Hugging Face file's size and sha256 (from the redirect's x-linked-* headers), without downloading it. */
export async function remoteFile(url: string) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  let size = Number(r.headers.get('x-linked-size') ?? 0);
  const sha = (r.headers.get('x-linked-etag') ?? '').replace(/"/g, '');
  if (!size) {
    const f = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    size = Number(f.headers.get('x-linked-size') ?? f.headers.get('content-length') ?? 0);
  }
  return { size, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null };
}

/** Runs image-prep.sh on the build's server and checks what it reports against models.json. */
async function prepare(b: ImageBuild) {
  const m = loadManifest();
  const info = await Promise.all(m.models.map((x) => remoteFile(x.url)));
  const unknown = m.models.filter((_, i) => !info[i].size).map((x) => x.file);
  if (unknown.length) throw new GenError(`couldn't read the size of ${unknown.join(', ')} from Hugging Face`);
  const list = m.models.map((x, i) => `${x.dir} ${x.file} ${info[i].size} ${info[i].sha256 ?? '-'} ${x.url}`).join('\n') + '\n';
  const tmp = path.join(paths.tmp, `image-models-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(tmp, list);
  try {
    await scpToServer(tmp, '/tmp/gen-image-models.txt', b.from);
    await scpToServer(path.join(paths.server, 'image-prep.sh'), '/tmp/gen-image-prep.sh', b.from);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  note(`running image-prep.sh on ${b.from} (checks ${m.models.length} core models; re-downloads any that are wrong)`);
  // The output goes to /run (memory, not imaged) too, in case SSH drops: once the prep ends, the server's authorized keys are gone.
  const out = await sshRun('sudo bash /tmp/gen-image-prep.sh /tmp/gen-image-models.txt 2>&1 | sudo tee /run/gen-image-prep.out | grep -v "^ok "', b.from, { timeoutMs: 3 * 3600_000 });
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.includes('PREP OK')) throw fatal(`image-prep.sh didn't finish: ${lines.slice(-6).join(' | ')}`);
  const comfy = lines.find((l) => l.startsWith('comfy='))?.slice(6);
  if (comfy !== m.comfyui.tag) throw fatal(`the server runs ComfyUI ${comfy}, models.json wants ${m.comfyui.tag}`);
  const nodes = new Map(lines.filter((l) => l.startsWith('node=')).map((l) => l.slice(5).split(' ') as [string, string]));
  const wrong = m.nodes.filter((n) => !(nodes.get(path.basename(n.repo, '.git')) ?? '').startsWith(n.commit)).map((n) => path.basename(n.repo, '.git'));
  if (wrong.length) throw fatal(`custom nodes not at models.json's commits: ${wrong.join(', ')}`);
  b.usedGb = Number(lines.find((l) => l.startsWith('used='))?.slice(5)) || undefined;
  b.prep = { removed: lines.filter((l) => l.startsWith('remove ')).map((l) => l.slice(7)), fixed: lines.filter((l) => l.startsWith('fixed ')).map((l) => l.slice(6)) };
  saveServerRecord(b.from!, { imageSource: b.id });
}

/**
 * Deletes fleet images (and their snapshots) that new servers no longer launch from: everything except each region's
 * newest image matching models.json, and except an image a running build is making. dryRun lists them.
 */
export async function pruneImages({ dryRun = false } = {}) {
  const key = manifestKey();
  const keepBuild = new Set(current?.active ? Object.values(current.copies) : []);
  const removed: FleetImage[] = [];
  for (const region of REGIONS) {
    const images = await imagesIn(region);
    const use = images.find((i) => i.state === 'available' && i.key === key);
    for (const img of images) {
      if (img === use || keepBuild.has(img.id) || img.state === 'pending') continue;
      removed.push(img);
      if (dryRun) continue;
      await ec2(region).send(new DeregisterImageCommand({ ImageId: img.id }));
      for (const snap of img.snapshots) await ec2(region).send(new DeleteSnapshotCommand({ SnapshotId: snap })).catch((e) => console.warn(`[image] couldn't delete ${snap}: ${e.message}`));
    }
  }
  forgetImages();
  return removed;
}
