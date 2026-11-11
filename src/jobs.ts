// The job queue: one for every project, so games never fight over the GPU.
//
// A job is one tool run: params, input files, and how many takes. Jobs wait
// in lanes by provider. The GPU lane runs one job per ready server and, to
// avoid swapping models (about a minute each time), gives a free server the
// oldest job of the family it already has loaded before anything else. API
// lanes (ElevenLabs, Claude) and the local lane run a few at once.
//
// Jobs survive a restart: one that was running goes back in the line and
// keeps the outputs it already saved. A caller can give a job a key; sending
// the same key again returns the existing job (so a game that restarts
// mid-batch doesn't pay twice), unless that job failed or was cancelled: then
// the key goes to a new job (a retry).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, parseRow, J } from './db.ts';
import { paths, loadSettings, ROOT, DATA_DIR, unityBackendOf, type PlaytestTarget } from './config.ts';
import { getTool } from './tools/index.ts';
import { validateParams } from './tools/validate.ts';
import type { RunContext, Tool, Output } from './tools/types.ts';
import { afterJob } from './lod.ts';
import { putAsset, putAssetFile, getAsset, blobPath, canUseBlob, findAllByRecipe, recipeKey, libraryShaOf, type Recipe } from './library.ts';
import { callScope } from './providers/anthropic.ts';
import { checkSubmit } from './platform.ts';
import { orgOfProject, isHouseProject } from './orgsecrets.ts';
import { recordUsage } from './usage.ts';
import { applyPreset } from './presets.ts';
import { canProject, fixedProject, projectScopeSql, type Client } from './auth.ts';
import { expandSlotRefs, fileJobOutputs } from './entities.ts';
import { expandMotionRequest, motionFile } from './motions.ts';
import { ensureInputs } from './storage.ts';
import { autoStartRound, offRound, ROUND_MS, BOOT_SECONDS, type AutoStartRound, type Backoff } from './autostart.ts';
import { comfyEndpoints, fleetStatus, startServer, launchServer, imageAvailable, syncServer, installModels, markModelsUsed, serverFreeDisk, markDiskFull, type Endpoint } from './providers/comfy/fleet.ts';
import type { ModelRef } from './workflows/convert.ts';
import { Comfy } from './providers/comfy/client.ts';
import { cloudEnabled, loadServiceMap, type CloudService } from './providers/cloudrun/services.ts';
import { gpuCandidates, triedOf, orderFor, fleetCredentialProblem } from './providers/gpu/route.ts';
import { markDown, markUp, isDown, awsRefused, COOLDOWN, lastingDown } from './providers/gpu/health.ts';
import { noGpuVerdict, waitSinceOf, type NoGpuVerdict } from './providers/gpu/nogpu.ts';
import { fleetBlocked } from './providers/gpu/egress.ts';
import { cpuRoute, cpuCloudEnabled, runCpuRemote, type CpuService } from './providers/cloudrun/cpu.ts';
import { cloudPlaytestsFor, cloudLanes, cloudLaneKey, providerDown, playtestVariantsFor } from './providers/playtester/cloudrun.ts';
import { runpodCreditProblem } from './providers/gpu/credit.ts';
import { isNativeTarget } from './providers/playtester/runners.ts';
import { cloudComfyRun, jobSeed } from './providers/cloudrun/run.ts';
import { mayPlace, noRoomReason, isDiskHeavy, retryOnDiskFull } from './placement.ts';
import { id as newId, sha256File, GenError, run } from './util.ts';
import { getUserForClient } from './users.ts';
import { quoteJobCredits, reserveJobCredits, refundJobCredits, isInternalOnlyTool, customerMayRun } from './billing.ts';
import { billedOrg, orgCreditsOn, chargeOrg, refundOrgCharge, startOrgChargeSettler, type OrgCharge } from './orgcredits.ts';

import { events } from './bus.ts';

export { events };

export type Job = {
  id: string; key: string | null; client: string; project: string; tool: string; params: Record<string, any>; inputs: Record<string, any>;
  labels: Record<string, unknown>; priority: number; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; detail: string; log: string[];
  outputs: { asset: string; seed: number | null; mime: string; kind: string; title?: string | null }[]; result: unknown; error: string | null;
  server: string | null; family: string | null; gpu_seconds: number; cost: number; graphs: string[]; resumed: number; created: number; started: number | null; finished: number | null;
};
const JSON_COLS = ['params', 'inputs', 'labels', 'log', 'outputs', 'result', 'graphs'];

export function getJob(jobId: string): Job | null {
  return parseRow<Job>(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId), JSON_COLS) ?? null;
}

export function listJobs(q: { project?: string; status?: string; client?: string; tool?: string; limit?: number; projects?: string[] } = {}) {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (q.project) { where.push('project = :project'); args.project = q.project; }
  if (q.status) { where.push(`status IN (${q.status.split(',').map((s) => `'${s.replace(/[^a-z]/g, '')}'`).join(',')})`); }
  if (q.client) { where.push('client = :client'); args.client = q.client; }
  if (q.tool) { where.push('tool = :tool'); args.tool = q.tool; }
  if (q.projects) { const scope = projectScopeSql(q.projects); if (scope) where.push(scope); }
  const limit = Math.max(1, Math.min(500, q.limit ?? 100));
  return db.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC LIMIT ${limit}`).all(args as any).map((r) => parseRow<Job>(r, JSON_COLS));
}

type Spread = { avg: number; p50: number; p90: number; max: number };
const spread = (xs: number[]): Spread | null => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const at = (p: number) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  const r = (n: number) => Math.round(n / 100) / 10;
  return { avg: r(v.reduce((a, b) => a + b, 0) / v.length), p50: r(at(0.5)), p90: r(at(0.9)), max: r(v[v.length - 1]) };
};

/**
 * Where the time goes, per tool (seconds): `wait` is queued to started, `run` started to finished, over the jobs that
 * finished (done or failed) since `since`; `now` is what is queued or running at this moment, with the longest wait so
 * far. A job picked up again after a restart counts from its last start.
 */
export function jobTimings(q: { since: number; project?: string; projects?: string[]; now?: number }) {
  const now = q.now ?? Date.now();
  const where = ['created >= :since'];
  const args: Record<string, string | number> = { since: q.since };
  if (q.project) { where.push('project = :project'); args.project = q.project; }
  if (q.projects) { const scope = projectScopeSql(q.projects); if (scope) where.push(scope); }
  const rows = db.prepare(`SELECT tool, status, created, started, finished FROM jobs WHERE ${where.join(' AND ')}`).all(args) as { tool: string; status: string; created: number; started: number | null; finished: number | null }[];
  const by = new Map<string, { done: number; failed: number; waits: number[]; runs: number[]; queued: number; running: number; waitingNow: number[] }>();
  for (const j of rows) {
    const t = by.get(j.tool) ?? { done: 0, failed: 0, waits: [], runs: [], queued: 0, running: 0, waitingNow: [] };
    by.set(j.tool, t);
    if (j.status === 'queued') {
      t.queued += 1;
      t.waitingNow.push(now - j.created);
    } else if (j.status === 'running') t.running += 1;
    else if ((j.status === 'done' || j.status === 'failed') && j.started && j.finished) {
      if (j.status === 'done') t.done += 1;
      else t.failed += 1;
      t.waits.push(Math.max(0, j.started - j.created));
      t.runs.push(Math.max(0, j.finished - j.started));
    }
  }
  const tools = [...by].map(([tool, t]) => {
    const wait = spread(t.waits);
    const run = spread(t.runs);
    return {
      tool, done: t.done, failed: t.failed, wait, run,
      /** Seconds spent waiting and running in all, so the biggest sinks sort first. */
      total: Math.round((t.waits.reduce((a, b) => a + b, 0) + t.runs.reduce((a, b) => a + b, 0)) / 1000),
      now: { queued: t.queued, running: t.running, longestWait: t.waitingNow.length ? Math.round(Math.max(...t.waitingNow) / 1000) : 0 },
    };
  }).sort((a, b) => b.total - a.total);
  return { since: q.since, at: now, tools };
}

// A running job's log is written at most about once a second: every line used to rewrite the whole JSON column
// (up to 300 lines) and emit an event, which starved the HTTP server while playtests and builds logged.
const LOG_FLUSH_MS = 1000;
const dirtyLogs = new Map<string, Job>();
let logTimer: NodeJS.Timeout | null = null;

export function flushLogs() {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  const jobs = [...dirtyLogs.values()];
  dirtyLogs.clear();
  for (const job of jobs) {
    // Only while the job is still queued or running: a cancel through another copy of the job (getJob) may have
    // finished it since, and this copy's old status must not go out as an event.
    const r = db.prepare("UPDATE jobs SET log = :log WHERE id = :id AND status IN ('queued', 'running')").run({ id: job.id, log: J(job.log) });
    if (r.changes) events.emit('job', summary(job));
  }
}
process.on('exit', () => { try { flushLogs(); } catch { /* shutting down */ } });

export function save(job: Job, fields: (keyof Job)[]) {
  if (fields.includes('log')) {
    if (job.status === 'running' || job.status === 'queued') {
      fields = fields.filter((f) => f !== 'log');
      dirtyLogs.set(job.id, job);
      logTimer ??= setTimeout(flushLogs, LOG_FLUSH_MS);
      if (!fields.length) return;
    } else {
      dirtyLogs.delete(job.id);
    }
  }
  const sets = fields.map((f) => `${f} = :${f}`).join(', ');
  const args: Record<string, any> = { id: job.id };
  for (const f of fields) args[f] = JSON_COLS.includes(f) ? J(job[f]) : (job[f] as any);
  db.prepare(`UPDATE jobs SET ${sets} WHERE id = :id`).run(args);
  events.emit('job', summary(job));
}

/** A job without its log, for lists and events. */
export const summary = (j: Job) => ({ ...j, log: undefined, logLines: j.log.length });

// ------------------------------------------------------------------ submit

export type JobSpec = {
  tool?: string;
  /** A preset name ("enemy" in this project, or "project/name"): the project's art direction. */
  preset?: string; project: string; params?: Record<string, unknown>; inputs?: Record<string, unknown>;
  labels?: Record<string, unknown>; key?: string; priority?: number;
  /**
   * Hand back a finished job that already made exactly this recipe (same tool version, params and inputs; any seed)
   * instead of paying for it again. `exclude` lists asset ids the caller already has (other takes of a best-of-N).
   */
  reuse?: boolean | { exclude?: string[] };
  /** The entity "slot:./..." references mean (set when a job is made for one of its slots). */
  self?: string;
};

/** Turns an input reference into a local path: a path (local callers only), "asset:<id>", "blob:<sha256>" or "motion:<pack>/<clip>". */
function resolveInput(client: Client, ref: unknown): string {
  if (typeof ref !== 'string' || !ref) throw new GenError('An input must be a file path, asset:<id>, blob:<sha256> or motion:<pack>/<clip>');
  if (ref.startsWith('motion:')) return motionFile(ref);
  if (ref.startsWith('asset:')) {
    const a = getAsset(ref.slice(6));
    if (!a) throw new GenError(`No asset ${ref.slice(6)}`, { status: 404 });
    if (!canProject(client, a.project)) throw new GenError(`No access to ${ref}`, { status: 403 });
    return a.path;
  }
  if (ref.startsWith('blob:')) {
    const p = blobPath(ref.slice(5));
    if (!p || !canUseBlob(client, ref.slice(5))) throw new GenError(`No blob ${ref.slice(5)} (upload it to /v1/blobs first)`, { status: 404 });
    return p;
  }
  // Raw paths only for callers on this machine with owner rights (games running here).
  if (client.role !== 'owner') throw new GenError('Remote callers send files as blob:<sha256> (POST /v1/blobs) or asset:<id>', { status: 403 });
  const abs = path.resolve(ref);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new GenError(`No file at ${abs}`, { status: 404 });
  return abs;
}

function resolveInputs(client: Client, tool: Tool, raw: Record<string, unknown> = {}) {
  const out: Record<string, string | string[]> = {};
  for (const k of Object.keys(raw)) if (!(k in tool.inputs)) throw new GenError(`${tool.id} has no input "${k}" (it takes: ${Object.keys(tool.inputs).join(', ') || 'none'})`);
  for (const [name, spec] of Object.entries(tool.inputs)) {
    const v = raw[name];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) {
      if (spec.required) throw new GenError(`${tool.id} needs the input "${name}"`);
      continue;
    }
    if (spec.multiple) {
      const list = Array.isArray(v) ? v : [v];
      if (spec.max && list.length > spec.max) throw new GenError(`${name} takes at most ${spec.max} files`);
      out[name] = list.map((x) => resolveInput(client, x));
    } else {
      if (Array.isArray(v)) throw new GenError(`${name} takes one file`);
      out[name] = resolveInput(client, v);
    }
  }
  return out;
}

type Pending = { tool: Tool; s: JobInit };
type JobInit = { project: string; params: Record<string, any>; inputs: Record<string, any>; labels?: Record<string, unknown>; key?: string; priority?: number };

/**
 * Submits a job (presets, slots, clips, keys and reuse applied). Synchronous: a customer's Studio key whose jobs its
 * Studio balance pays for (src/orgcredits.ts) is refused here when Gen charges orgs; HTTP routes use submitJob.
 */
export function submit(client: Client, spec0: JobSpec): Job {
  const p = prepareSubmit(client, spec0);
  return 'id' in p ? p : createJob(client, p.tool, p.s);
}

/** submit, charging a customer Studio's balance first when its key's jobs are billed there (every HTTP route). */
export async function submitJob(client: Client, spec0: JobSpec): Promise<Job> {
  const p = prepareSubmit(client, spec0);
  return 'id' in p ? p : createJobCharged(client, p.tool, p.s);
}

/** Hooks that adjust a job's spec before it's checked (src/worlds.ts: a job made inside a world gets the world's look). */
// A hoisted var behind a function declaration: an import cycle (worlds.ts → jobs.ts → tools → make → worlds.ts) can
// register a hook before this module's body has run, and a const would still be in its temporal dead zone then.
var submitHooks: ((project: string, spec: JobSpec) => void)[] | undefined;
function hooks() { return (submitHooks ??= []); }
export function onSubmit(fn: (project: string, spec: JobSpec) => void) { hooks().push(fn); }

function prepareSubmit(client: Client, spec0: JobSpec): Job | Pending {
  const project0 = fixedProject(client) ?? String(spec0.project ?? '').trim();
  // A preset (the project's art direction) fills in the tool, params and inputs.
  const applied = applyPreset({ ...spec0, project: project0 }, (id) => getTool(id)?.params ?? null);
  const spec: JobSpec = { ...spec0, tool: applied.tool ?? spec0.tool, params: applied.params, inputs: applied.inputs, labels: applied.preset ? { ...(spec0.labels ?? {}), preset: applied.preset } : spec0.labels };
  if (canProject(client, project0)) for (const h of hooks()) h(project0, spec);
  // Library clips ("clips": ["Walk_Loop"]) become retarget/export ops and motion: file refs before anything else.
  const motion = expandMotionRequest(client, spec);
  if (motion) {
    spec.params = motion.params;
    spec.inputs = motion.inputs;
    spec.labels = motion.labels;
  }
  // Slot references ("slot:doseofdestruction/break/side") become the asset they mean now, in params (asset.make
  // steps) and inputs, so the recipe follows the slot; what was used is kept as the outputs' made_from.
  const expanded = expandSlotRefs(client, { params: spec.params ?? {}, inputs: spec.inputs ?? {} }, spec.self);
  if (expanded.used.length) {
    spec.params = expanded.value.params;
    spec.inputs = expanded.value.inputs;
    spec.labels = { ...(spec.labels ?? {}), madeFrom: expanded.used };
  }
  let tool = getTool(spec.tool ?? '');
  if (!tool) throw new GenError(`Unknown tool: ${spec.tool}`, { status: 404 });
  const requested = tool.id;
  if (client.role === 'user') {
    // unity.build is open to customers in customer mode only (their own repo and token, the output as an asset).
    if (isInternalOnlyTool(tool.id) && !customerMayRun(tool.id, spec.params)) {
      throw new GenError(`Tool ${tool.id} is internal-only and not available for user accounts${tool.id === 'unity.build' ? ' (except customer mode: github { repo, commit, token } with out "artifact")' : ''}`, { status: 403 });
    }
    if (tool.id === 'asset.make' && Array.isArray((spec.params as any)?.steps)) {
      for (const st of (spec.params as any).steps) {
        if (st && typeof st.tool === 'string' && isInternalOnlyTool(st.tool)) {
          throw new GenError(`Tool ${st.tool} is internal-only and not available for user accounts`, { status: 403 });
        }
      }
    }
  }
  const project = project0;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(project)) throw new GenError('project is required (letters, numbers, . _ -)');
  if (!canProject(client, project)) throw new GenError(`No access to project ${project}`, { status: 403 });
  if (spec.key) {
    const existing = db.prepare('SELECT id, status FROM jobs WHERE client = ? AND key = ?').get(client.id, String(spec.key)) as { id: string; status: string } | undefined;
    // A key never pays twice for work that is done or under way; a failed or cancelled job frees it for a retry.
    if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') return getJob(existing.id)!;
    if (existing) db.prepare('UPDATE jobs SET key = NULL WHERE id = ?').run(existing.id);
  }
  let params = validateParams(tool, spec.params ?? {});
  // A tool may hand the call to another (audio.voice -> the open-model voice tool); the job then runs and is recorded as that tool.
  const routed = tool.route?.(params);
  if (routed && routed !== tool.id) {
    const target = getTool(routed);
    if (target) {
      tool = target;
      params = validateParams(tool, params);
      spec.labels = { ...(spec.labels ?? {}), requestedTool: requested };
    }
  }
  if (tool.admit) params = tool.admit({ params, client, project, customer: !exemptCheck()({ project, client: client.id }) });
  const inputs = resolveInputs(client, tool, spec.inputs ?? {});
  tool.guard?.({ params, inputs, labels: spec.labels });
  if (spec.reuse) {
    const found = reusable(tool, project, params, inputs, typeof spec.reuse === 'object' ? spec.reuse.exclude ?? [] : []);
    if (found) {
      // Made for a slot: the takes the library hands back land in that slot too.
      if (spec.labels?.entity) fileJobOutputs({ ...found, labels: { ...found.labels, ...spec.labels } });
      return found;
    }
  }
  return { tool, s: { project, params, inputs, labels: spec.labels, key: spec.key, priority: spec.priority } };
}

// A library file's hash comes from its row (or a blob's name), not its bytes: on Cloud Run the file may not be on this
// instance yet (made by another instance, or before a restart), and checking the library for a take must not need it.
// The file itself comes back from storage before the job runs (ensureInputs). Other files are hashed as they are.
const sha256Sync = (file: string) => libraryShaOf(file) ?? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The recipe key a job with these params and inputs would give its outputs (as runJob computes it). */
export function jobRecipeKey(tool: Tool, params: Record<string, any>, inputs: Record<string, string | string[]>) {
  const hashes: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(inputs)) hashes[k] = Array.isArray(v) ? v.map(sha256Sync) : sha256Sync(v);
  return recipeKey({ tool: tool.id, version: tool.version, params, inputs: hashes, models: tool.models?.(params) } as Recipe);
}

/** A finished job in this project whose first output has this recipe and isn't one the caller already has. */
function reusable(tool: Tool, project: string, params: Record<string, any>, inputs: Record<string, string | string[]>, exclude: string[]): Job | null {
  const skip = new Set(exclude.map((x) => String(x).replace(/^asset:/, '')));
  for (const a of findAllByRecipe(jobRecipeKey(tool, params, inputs), project)) {
    if (skip.has(a.id) || !a.job) continue;
    const j = getJob(a.job);
    if (!j || j.status !== 'done' || j.outputs?.[0]?.asset !== a.id) continue;
    return { ...j, reused: true } as Job;
  }
  return null;
}

/**
 * Priority boosts (POST /v1/jobs/boost): every job carrying a label (e.g. Studio's `studioChange: c_...`, a video J is
 * waiting on) runs at this priority until the boost ends: the queued ones now, the ones submitted later as they come.
 * Studio boosts a video's work while J waits for its next version (J, 2026-10-22: GPU priority for videos waiting on me).
 */
db.exec(`CREATE TABLE IF NOT EXISTS priority_boosts (label TEXT NOT NULL, value TEXT NOT NULL, priority INTEGER NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (label, value))`);
const LABEL = /^[A-Za-z][\w.-]{0,40}$/;

/** The highest live boost among a job's labels (0 when none). */
export function boostFor(labels: Record<string, unknown> | undefined): number {
  if (!labels) return 0;
  let best = 0;
  const now = Date.now();
  for (const [k, v] of Object.entries(labels)) {
    if (!LABEL.test(k) || (typeof v !== 'string' && typeof v !== 'number')) continue;
    const r = db.prepare('SELECT priority FROM priority_boosts WHERE label = ? AND value = ? AND until > ?').get(k, String(v), now) as { priority: number } | undefined;
    if (r && r.priority > best) best = r.priority;
  }
  return best;
}

/**
 * Sets (priority > 0, for `minutes`) or ends (priority 0) a boost on a label, and re-prioritizes the queued jobs that
 * carry it. Returns how many queued jobs changed.
 */
export function boostLabel(label: string, value: string, priority: number, minutes = 120): { label: string; value: string; priority: number; until: number | null; queued: number } {
  if (!LABEL.test(label)) throw new GenError('label is a label name, e.g. studioChange');
  const v = String(value ?? '').trim();
  if (!v) throw new GenError('value is the label value to boost');
  const p = Math.max(0, Math.min(10, Math.round(Number(priority) || 0)));
  const until = Date.now() + Math.max(1, Math.min(24 * 60, Number(minutes) || 120)) * 60_000;
  if (p > 0) db.prepare('INSERT INTO priority_boosts (label, value, priority, until) VALUES (?, ?, ?, ?) ON CONFLICT(label, value) DO UPDATE SET priority = excluded.priority, until = excluded.until').run(label, v, p, until);
  else db.prepare('DELETE FROM priority_boosts WHERE label = ? AND value = ?').run(label, v);
  db.prepare('DELETE FROM priority_boosts WHERE until <= ?').run(Date.now());
  const queued = db.prepare(`SELECT id, labels, priority FROM jobs WHERE status = 'queued' AND json_extract(labels, ?) = ?`).all(`$."${label}"`, v) as { id: string; labels: string; priority: number }[];
  for (const q of queued) {
    const next = Math.max(p, boostFor(JSON.parse(q.labels || '{}')));
    if (next !== q.priority) db.prepare('UPDATE jobs SET priority = ? WHERE id = ?').run(next, q.id);
  }
  queue.pump();
  return { label, value: v, priority: p, until: p > 0 ? until : null, queued: queued.length };
}

/**
 * The org whose Studio balance pays for this job, when Gen charges orgs (src/orgcredits.ts): a customer Studio's cell
 * key with no Gen account. Null for everyone else (owner and admin keys, Gen itself, accounts, the portal, tokens).
 */
function chargedOrg(client: Client, project: string): string | null {
  if (client.role !== 'user' || !orgCreditsOn()) return null;
  return billedOrg(client, project, Boolean(getUserForClient(client)));
}

/**
 * What a customer's day of jobs has cost so far (UTC day, dollars: GPU, voice, Claude on a key; the usage table), read at
 * most every 10 seconds. `forget` is for tests.
 */
let spendCache: { at: number; day: string; usd: number } | null = null;
export function spentToday(now = Date.now(), forget = false): number {
  const day = new Date(now).toISOString().slice(0, 10);
  if (!forget && spendCache && spendCache.day === day && now - spendCache.at < 10_000) return spendCache.usd;
  const since = Date.parse(`${day}T00:00:00Z`);
  const usd = (db.prepare('SELECT SUM(cost) AS c FROM usage WHERE at >= ?').get(since) as { c: number | null }).c ?? 0;
  spendCache = { at: now, day, usd };
  return usd;
}

/**
 * Whether Gen will take one more job from this caller at all, checked first thing in createJob and before an org's
 * Studio balance is charged, so a refusal reserves and charges nothing:
 *  - a customer project may have `queue.maxQueuedPerProject` jobs waiting (429, plain words): running jobs are capped by
 *    the lanes, this caps the line behind them;
 *  - past `queue.dailyCeilingUsd` of spend in a UTC day, customers' new jobs get "busy, try again later" (503).
 * Studio's own projects, admin and owner keys, and the steps of a pipeline (`labels.parent`: their parent already
 * got in) are exempt, so the studio keeps working.
 */
export function admitJob(client: Client, project: string, labels?: Record<string, unknown>) {
  if (labels?.parent || exemptCheck()({ project, client: client.id })) return;
  const q = loadSettings().queue;
  if (q.dailyCeilingUsd > 0 && spentToday() >= q.dailyCeilingUsd) {
    throw new GenError('Hawkes Gen is busy right now. Nothing was charged: please try again later.', { status: 503, kind: 'busy' });
  }
  const waitingNow = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project = ? AND status = 'queued'").get(project) as { n: number }).n;
  if (waitingNow >= q.maxQueuedPerProject) {
    throw new GenError(`Too many jobs are waiting (${waitingNow}). Let some finish or cancel a few, then try again. Nothing was charged.`, { status: 429, kind: 'busy' });
  }
}

/** createJob after charging the org's Studio balance (402 kind 'credits' when short, refused when unreachable). */
async function createJobCharged(client: Client, tool: Tool, s: JobInit): Promise<Job> {
  const org = chargedOrg(client, s.project);
  if (!org) return createJob(client, tool, s);
  checkSubmit(client, tool.id);
  admitJob(client, s.project, s.labels);
  const id = newId('j', 6);
  const quote = quoteJobCredits({ project: s.project, tool: tool.id, params: s.params });
  const charge = await chargeOrg(org, id, quote.credits, tool.id);
  try { return createJob(client, tool, s, { id, charge }); } catch (e) {
    await refundOrgCharge(id, 'The job was not made');
    throw e;
  }
}

function createJob(client: Client, tool: Tool, s: JobInit, charged?: { id: string; charge: OrgCharge }): Job {
  // A platform token's caller: its scopes, and billing (src/platform.ts).
  checkSubmit(client, tool.id);
  // Every job a customer Studio's key makes is paid from its balance: a path that can't charge first refuses.
  if (!charged && chargedOrg(client, s.project)) {
    throw new GenError("This studio's credits can't be charged on this path; submit the job through POST /v1/jobs (or the MCP).", { status: 403, kind: 'credits' });
  }
  admitJob(client, s.project, s.labels);
  const { project, params, inputs } = s;
  // No priority asked for: a boost on one of its labels sets it (boostLabel). Customers' keys (role user) can lower
  // their own jobs but never raise them or ride an admin's boost: priority is the scheduler's business.
  const spec = { ...s, priority: client.role === 'user' ? Math.min(0, Number(s.priority) || 0) : s.priority ?? boostFor(s.labels) };
  // A Claude answer someone is watching for (labels `waiting`: the portal's Overseer) goes ahead of background work in
  // its lane, a step up and no more (tools/api.ts waitedOn gives its call the same place at Claude's gate).
  if (s.labels?.waiting && (tool.id === 'llm.text' || tool.id === 'llm.json')) spec.priority = Math.max(1, Number(spec.priority) || 0);
  const family = tool.provider === 'comfy' ? (typeof tool.family === 'function' ? tool.family(params) : tool.family) ?? null : null;
  const job: Job = {
    id: charged?.id ?? newId('j', 6), key: spec.key ? String(spec.key) : null, client: client.id, project, tool: tool.id, params, inputs,
    labels: spec.labels ?? {}, priority: Math.max(-10, Math.min(10, Math.round(Number(spec.priority) || 0))), status: 'queued', detail: 'queued',
    log: [], outputs: [], result: null, error: null, server: null, family, gpu_seconds: 0, cost: 0, graphs: [], resumed: 0, created: Date.now(), started: null, finished: null,
  };
  if (client.role === 'user') {
    const user = getUserForClient(client);
    if (user) {
      const quote = quoteJobCredits({ project, tool: tool.id, params });
      reserveJobCredits(user.id, job.id, quote.credits, `Reserved ${quote.credits} credits for ${tool.id} (${job.id})`);
      job.labels = { ...job.labels, reservedCredits: quote.credits };
    }
  }
  // Paid from a customer Studio's balance (src/orgcredits.ts): the cell sees it and doesn't charge again.
  if (charged?.charge.credits) job.labels = { ...job.labels, orgCredits: charged.charge.credits };
  try {
    db.prepare(`INSERT INTO jobs (id, key, client, project, tool, params, inputs, labels, priority, status, detail, log, outputs, result, error, server, family, gpu_seconds, cost, graphs, resumed, created)
              VALUES (:id, :key, :client, :project, :tool, :params, :inputs, :labels, :priority, :status, :detail, :log, :outputs, :result, :error, :server, :family, :gpu_seconds, :cost, :graphs, :resumed, :created)`).run({
    id: job.id, key: job.key, client: job.client, project: job.project, tool: job.tool, params: J(params), inputs: J(inputs), labels: J(job.labels),
    priority: job.priority, status: job.status, detail: job.detail, log: '[]', outputs: '[]', result: null, error: null, server: null, family: job.family,
    gpu_seconds: 0, cost: 0, graphs: '[]', resumed: 0, created: job.created,
  });
  } catch (e) {
    // The reservation was made before the row: a job that was never made gives it back (a customer Studio's charge is returned by createJobCharged).
    refundJobCredits(job.id, 'The job was not made');
    throw e;
  }
  events.emit('job', summary(job));
  queue.pump();
  return job;
}

/**
 * Whether a failed or cancelled job keeps what it was charged: a Unity build that ran and failed on the project itself
 * (a compile error, its output, its time limit) or was cancelled after running more than 2 minutes used the machine;
 * failures that are Gen's (the machine, the license, capacity, a token or the queue) are refunded (2026-10-31 review).
 */
export function keepsCharge(job: { tool: string; started?: number | null }, e: { kind?: string } | null, cancelled: boolean, now = Date.now()) {
  if (job.tool !== 'unity.build') return false;
  if (cancelled) return Boolean(job.started) && now - Number(job.started) > 2 * 60_000;
  return ['build', 'output', 'timeout', 'compile'].includes(String(e?.kind ?? ''));
}

/** A failed or cancelled job's credits back: a Gen account's reservation, and a customer Studio's charge. */
function refundJob(jobId: string, reason: string) {
  refundJobCredits(jobId, reason);
  void refundOrgCharge(jobId, reason);
}
startOrgChargeSettler((id) => (db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? null);

export function cancel(jobId: string) {
  const j = getJob(jobId);
  if (!j) throw new GenError('No such job', { status: 404 });
  // A pipeline's steps (video.change's frame and video, asset.make's takes) are jobs of their own: they stop with it, so
  // nothing keeps waiting for a GPU (or spending one) for a job nobody wants any more.
  stopChildren(jobId);
  if (j.status === 'queued') {
    Object.assign(j, { status: 'cancelled', detail: 'cancelled before it started', finished: Date.now() });
    save(j, ['status', 'detail', 'finished']);
    refundJob(j.id, 'Job cancelled before starting');
  } else if (j.status === 'running') {
    const ab = queue.aborts.get(j.id);
    if (ab) {
      ab.abort();
    } else {
      Object.assign(j, { status: 'cancelled', detail: 'cancelled', finished: Date.now() });
      save(j, ['status', 'detail', 'finished']);
      refundJob(j.id, 'Job cancelled');
      releaseOutside(j);
    }
  }
  return getJob(jobId);
}

/** The queued and running steps of a pipeline job (labels.parent), cancelled. */
export function stopChildren(parentId: string) {
  const rows = db.prepare("SELECT id FROM jobs WHERE status IN ('queued', 'running') AND json_extract(labels, '$.parent') = ?").all(parentId) as { id: string }[];
  for (const r of rows) {
    try {
      cancel(r.id);
    } catch (e: any) {
      console.warn(`[queue] couldn't stop ${r.id}, a step of ${parentId}: ${e?.message ?? e}`);
    }
  }
}

export function failJob(jobId: string, errorMessage = 'Job failed') {
  const j = getJob(jobId);
  if (!j) throw new GenError('No such job', { status: 404 });
  stopChildren(jobId);
  Object.assign(j, { status: 'failed', error: errorMessage, detail: errorMessage, finished: Date.now() });
  j.log.push(`error: ${errorMessage}`);
  save(j, ['status', 'error', 'detail', 'finished', 'log']);
  refundJob(j.id, `Job failed: ${errorMessage}`);
  releaseOutside(j);
  return getJob(jobId);
}

/** What a job that ended outside its run started elsewhere is released (Tool.ended): a Unity build's queued execution
 *  would otherwise wait in Cloud Run for a machine nobody wants (2026-11-11: 77 of them in us-west1). */
function releaseOutside(j: { id: string; tool: string }) {
  const t = getTool(j.tool);
  if (!t?.ended) return;
  void t.ended(j.id).catch((e: any) => console.warn(`[queue] couldn't release what ${j.id} started: ${e?.message ?? e}`));
}

/**
 * Queues a job again with the same tool, params and inputs: a new seed unless sameSeed. params: values to change (a
 * retake with a note in the prompt); inputs: inputs to swap (asset:/blob: refs, e.g. an upscale of the new take);
 * labels: more labels; priority: else the original's (or a boost on its labels).
 */
type RerunOpts = { sameSeed?: boolean; params?: Record<string, unknown>; inputs?: Record<string, unknown>; labels?: Record<string, unknown>; priority?: number };
export function rerun(client: Client, jobId: string, o: RerunOpts = {}) {
  const p = prepareRerun(client, jobId, o);
  return createJob(client, p.tool, p.s);
}
/** rerun, charging a customer Studio's balance first (POST /v1/jobs/:id/rerun). */
export async function rerunJob(client: Client, jobId: string, o: RerunOpts = {}) {
  const p = prepareRerun(client, jobId, o);
  return createJobCharged(client, p.tool, p.s);
}
function prepareRerun(client: Client, jobId: string, { sameSeed = false, params: over, inputs: swap, labels, priority }: RerunOpts): Pending {
  const j = getJob(jobId);
  if (!j) throw new GenError('No such job', { status: 404 });
  const tool = getTool(j.tool);
  if (!tool) throw new GenError(`${j.tool} is no longer a tool`);
  let params: Record<string, any> = { ...j.params, ...(over ?? {}) };
  if (!sameSeed) delete params.seed;
  else params.seed = j.outputs[0]?.seed ?? params.seed;
  if (over && Object.keys(over).length) params = validateParams(tool, params);
  // The same checks against the caller as a submit (playtest.run: a customer's build is its own, its URL public).
  if (tool.admit) params = tool.admit({ params, client, project: j.project, customer: !exemptCheck()({ project: j.project, client: client.id }) });
  const inputs: Record<string, any> = { ...j.inputs };
  for (const [k, v] of Object.entries(swap ?? {})) {
    const spec = tool.inputs[k];
    if (!spec) throw new GenError(`${tool.id} has no input "${k}"`);
    inputs[k] = spec.multiple ? (Array.isArray(v) ? v : [v]).map((x) => resolveInput(client, x)) : resolveInput(client, v);
  }
  const lab = { ...j.labels, ...(labels ?? {}), rerunOf: j.id };
  return { tool, s: { project: j.project, params, inputs, labels: lab, priority: priority ?? Math.max(j.priority, boostFor(lab)) } };
}

export function clearFinished(project?: string) {
  const r = project
    ? db.prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND project = ?").run(project)
    : db.prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled')").run();
  return Number(r.changes);
}

// ------------------------------------------------------------------- queue

const PYTHON = [
  path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  path.join(ROOT, '.venv', 'bin', 'python'),
  path.join(paths.projects, 'hawkesgen', '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3');

/**
 * The job a GPU server that has to switch models takes (a load costs minutes): among the waiting jobs at the top
 * priority (`open` is in queue order: priority, then age), one of the family with the most work waiting, the oldest
 * job's family on a tie. One load then serves as many jobs as it can, instead of a lone job of another family that
 * sends the server back again (a batch of asset.make chains alternates five families).
 */
export function switchTo<T extends { family: string | null; priority?: number | null }>(open: T[]): T | null {
  if (!open.length) return null;
  const top = open[0].priority ?? 0;
  const first = open.filter((j) => (j.priority ?? 0) >= top);
  const waitingOf = new Map<string, number>();
  for (const j of first) waitingOf.set(j.family ?? '', (waitingOf.get(j.family ?? '') ?? 0) + 1);
  return first.reduce((best, j) => ((waitingOf.get(j.family ?? '') ?? 0) > (waitingOf.get(best.family ?? '') ?? 0) ? j : best));
}

/** A GPU job as fair sharing sees it. `exempt`: Studio's own projects and admin/owner keys (no cap, never made to wait for a turn). */
export type FairJob = { id: string; project: string; family: string | null; priority: number; created: number; exempt: boolean };

/**
 * Fair sharing between customer projects on the GPU. `open` is in queue order (priority, then age); `running` is each
 * project's GPU jobs running now. A project's n-th waiting job has turn `running + n`: the queue sorts by priority, then
 * turn, then age, so two projects with ten jobs each alternate and a project with one job is served in the first turn.
 * A job whose turn is at or past `cap` waits (`ok: false`): the project already has its share on the GPU. Exempt jobs
 * are always turn 0.
 */
export function fairOrder<T extends FairJob>(open: T[], running: Map<string, number>, cap: number): (T & { turn: number; ok: boolean })[] {
  const seen = new Map<string, number>();
  const out = open.map((j) => {
    if (j.exempt) return { ...j, turn: 0, ok: true };
    const n = seen.get(j.project) ?? 0;
    seen.set(j.project, n + 1);
    const turn = (running.get(j.project) ?? 0) + n;
    return { ...j, turn, ok: turn < cap };
  });
  return out.sort((a, b) => b.priority - a.priority || a.turn - b.turn || a.created - b.created);
}

/** The jobs of the head's priority and turn: the ones a server may choose between by model family without costing anyone their turn. */
export function sameTurn<T extends { priority: number; turn: number }>(sorted: T[]): T[] {
  return sorted.length ? sorted.filter((j) => j.priority === sorted[0].priority && j.turn === sorted[0].turn) : [];
}

/** How many restarts a running job is picked up again after before it stops with a reason (start()). */
export const MAX_RESUMES = 5;
/**
 * Restarts that Hawkes Gen announced (a deploy or a stop: the job carries `labels.drained`) don't use up MAX_RESUMES, which is
 * for crashes; they have their own, much higher limit. 2026-11-07: seven 10-minute playtests were stopped "interrupted 5 times"
 * by the day's deploys (five merges in two hours), not by crashes.
 */
export const MAX_DRAIN_RESUMES = 25;

class Queue {
  /** Server id -> job id running on it. */
  busy = new Map<string, string>();
  /** Provider -> running job ids (API and local lanes). */
  lanes = new Map<string, Set<string>>();
  aborts = new Map<string, AbortController>();
  /** Server id -> the model family it last loaded. */
  families = new Map<string, string>();
  /** Job id -> servers it failed on with a full disk (it is retried once elsewhere). */
  diskAvoid = new Map<string, Set<string>>();
  /** Cloud Run service -> job ids running on it (each one instance; at most the service's max instances). */
  cloud = new Map<string, Set<string>>();
  /** Server id -> content hash -> uploaded name. */
  uploads = new Map<string, Map<string, string>>();
  pumping = false;
  again = false;
  timer: NodeJS.Timeout | null = null;
  lastAutoStart = 0;
  /** The last auto start round, and the servers it leaves alone for now (a start failed). */
  autoRound: AutoStartRound | null = null;
  autoBackoff: Backoff = new Map();
  waitReason = '';
  /** The last error working out the playtest lanes (logged once). */
  laneError = '';
  /** Whether a GPU server was ready for playtest browsers, checked at most every 30 s. */
  gpuSeen = { at: 0, ready: false, limit: 3 };
  /** Running playtests' browser tabs (their players), for the playtest lane. */
  tabs = new Map<string, number>();
  /** Running API and local jobs' projects, for fair sharing of those lanes between customers. */
  laneProject = new Map<string, string>();
  /** Browser tabs the running playtests use, and the most the lane admits now. */
  /** The playtest lanes the last fill used (key -> tabs it admits): the Cloud Run, RunPod, Modal or runner lanes. */
  playtestLanes = new Map<string, number>();
  tabsInUse() {
    // The lanes playtests really wait on when the last fill used any (2026-11-10: this said "1 of 1" from the AWS
    // playtesters while the runs played on RunPod's 8 browsers), else the playtesters' or fleet's.
    const cloud = [...this.playtestLanes.values()].reduce((a, n) => a + n, 0);
    return { used: [...this.tabs.values()].reduce((a, n) => a + n, 0), limit: cloud > 0 ? cloud : this.gpuSeen.ready ? this.gpuSeen.limit : 1 };
  }

  /** Set while Hawkes Gen is stopping: nothing new starts, the jobs running finish (drain). */
  draining = false;

  /**
   * Stop taking new jobs (they stay queued for the next start) and wait for the running ones to finish, at most `maxMs`.
   * Event-driven: it looks again when a job's status changes (no polling). Jobs still running at the cap are marked as cut
   * off by a planned stop, so the next start picks them up without counting a crash. -> how many were left running.
   */
  async drain(maxMs: number): Promise<number> {
    this.draining = true;
    const left = () => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get() as { n: number }).n;
    if (left() > 0 && maxMs > 0) {
      await new Promise<void>((resolve) => {
        let t: NodeJS.Timeout;
        const done = () => { clearTimeout(t); events.off('job', check); resolve(); };
        const check = () => { if (left() === 0) done(); };
        t = setTimeout(done, maxMs);
        events.on('job', check);
      });
    }
    const n = left();
    if (n) {
      for (const j of listJobs({ status: 'running', limit: 500 })) {
        j.labels = { ...j.labels, drained: Date.now() };
        j.log.push('Hawkes Gen is restarting: this job will be picked up again');
        save(j, ['labels', 'log']);
      }
      flushLogs();
    }
    return n;
  }

  start() {
    // Jobs that were running when Hawkes Gen stopped go back in the line, at most MAX_RESUMES times: a job that keeps
    // being cut off (or keeps breaking the service) stops with a reason instead of starting over forever.
    for (const j of listJobs({ status: 'running', limit: 500 })) {
      const planned = Boolean(j.labels?.drained);
      if (planned) {
        const n = Number(j.labels?.drainResumes ?? 0);
        if (n >= MAX_DRAIN_RESUMES) {
          failJob(j.id, `This job was cut off by ${n} planned restarts of Hawkes Gen, so it was stopped instead of starting over again. Its credits were returned. Please run it again.`);
          continue;
        }
        const { drained: _d, ...rest } = j.labels ?? {};
        j.labels = { ...rest, drainResumes: n + 1 };
        j.status = 'queued';
        j.detail = `picked up again after a planned restart (${j.outputs.length} done)`;
        j.log.push(j.detail);
        const { gpuWaitSince: _g, ...labels } = j.labels;
        j.labels = labels;
        save(j, ['status', 'detail', 'log', 'labels']);
        continue;
      }
      if (j.resumed >= MAX_RESUMES) {
        j.log.push(`picked up again after ${j.resumed} restarts already: stopped instead`);
        save(j, ['log']);
        flushLogs();
        failJob(j.id, `This job was interrupted ${j.resumed} times by Hawkes Gen restarting, so it was stopped instead of starting over again. Its credits were returned. Please run it again.`);
        continue;
      }
      j.status = 'queued';
      j.resumed += 1;
      j.detail = `picked up again after a restart (${j.outputs.length} done)`;
      j.log.push(j.detail);
      // A GPU job's wait for a GPU starts again: it had one when it was cut off.
      const { gpuWaitSince: _w, ...labels } = j.labels ?? {};
      j.labels = labels;
      save(j, ['status', 'resumed', 'detail', 'log', 'labels']);
    }
    this.pump();
  }

  /** A GPU job that no GPU can run (nogpu.ts): failed with the plain reason, the providers' reasons in its log. */
  failNoGpu(j: Job, v: Extract<NoGpuVerdict, { fail: true }>) {
    console.warn(`[queue] ${j.id} (${j.tool}): ${v.log}`);
    j.log.push(v.log);
    save(j, ['log']);
    flushLogs();
    failJob(j.id, v.error);
  }

  /** A GPU job with nowhere to run: fails, or waits with its clock kept in its labels. -> whether it still waits. */
  noGpu(j: Job, blockers: { reason: string; lasting: boolean }[], waitMinutes: number): string | null {
    const v = noGpuVerdict(blockers, waitSinceOf(j.labels), waitMinutes);
    if (v.fail) {
      this.failNoGpu(j, v);
      return null;
    }
    if (waitSinceOf(j.labels) !== v.since) {
      j.labels = { ...j.labels, gpuWaitSince: v.since };
      save(j, ['labels']);
    }
    return v.detail;
  }

  queued() {
    return db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created").all().map((r) => parseRow<Job>(r, JSON_COLS));
  }

  pump() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    this.again = false;
    void this.fill().finally(() => {
      this.pumping = false;
      if (this.again) this.pump();
    });
  }

  async fill() {
    if (this.draining) return;
    const waiting = this.queued();
    if (!waiting.length) return;
    const settings = loadSettings();
    const toolOf = (j: Job) => getTool(j.tool)!;
    // Playtests count browser tabs (a multiplayer run is one per player). They fit in the playtesters' lanes (each
    // playtester's by its type, every one that exists: a full or stopped one is started by the run), else three on a GPU
    // fleet server; on this PC or in software, one (playtest.run also keeps the local browser to one at a time itself).
    const playtestLimit = async (j: Job) => {
      if (process.platform === 'win32' || j.params.gpu === 'off') return 1;
      if (Date.now() - this.gpuSeen.at > 30_000) {
        const { playtesterCapacity } = await import('./providers/playtester/playtester.ts');
        const cap = await playtesterCapacity().catch(() => ({ machines: 0, lanes: 0 }));
        const fleet = cap.machines ? false : (await comfyEndpoints().catch(() => [])).length > 0;
        this.gpuSeen = { at: Date.now(), ready: cap.machines > 0 || fleet, limit: cap.machines ? cap.lanes : 3 };
      }
      return this.gpuSeen.ready ? this.gpuSeen.limit : 1;
    };
    const tabsOf = (j: Job) => (j.tool === 'playtest.run' ? Math.max(1, Math.min(4, Number(j.params.peers) || 1)) : 1);
    // The lane of the Cloud Run playtest service this job's project plays on first (the L4's or the CPU service's) and
    // the browser tabs it plays at once; else null.
    const cloudPlaytestLanes = (j: Job, s: typeof settings) => {
      // Runners from settings.playtest.runners (src/providers/playtester/runners.ts), and every desktop target: one lane per
      // kind (browser, native) of the runs those runners play at once.
      // As runnersFor (runners.ts) routes them: a web run uses the listed runners only when one of them plays web pages;
      // otherwise today's browser services play it (a desktop-only runner never takes websites' lane down to one).
      const target = (j.params.target ?? 'web') as PlaytestTarget;
      const runners = s.playtest.runners ?? [];
      if (isNativeTarget(target) || runners.some((r) => r.targets.includes(target))) {
        const native = isNativeTarget(target);
        const limit = s.playtest.runners.filter((r) => r.enabled && r.targets.includes(target)).reduce((n, r) => n + r.maxConcurrent, 0);
        return { key: native ? 'playtest-native' : 'playtest-runners', limit: Math.max(1, limit) };
      }
      // The same rule playtest.run follows for a GPU browser: gpu require, or auto anywhere but this PC (Windows).
      const gpuHost = j.params.gpu === 'require' || (j.params.gpu !== 'off' && process.platform !== 'win32');
      // No browser service for this project: the order the run itself follows (playtestVariantsFor: a project's own
      // backend, else settings.playtest.order, Studio's provider order, else the default backend). Checking only the
      // backend left runs that Studio's order sends to RunPod in the generic lane of one while the default backend was
      // ec2 and the AWS playtesters were gone: one playtest at a time on an endpoint with 8 browsers (2026-11-10).
      if (!gpuHost || !playtestVariantsFor(j.project, s.playtest).length) return null;
      try {
        // The lane holds the tabs of every region of the first service's kind (the CPU service may run in several).
        // A GPU provider the run will skip (RunPod out of credit, a provider cooling down after a refusal) doesn't set
        // the lane: the next one in the order plays the run, so its tabs are the ones counted.
        const listed = cloudPlaytestsFor(j.project, s);
        const usable = listed.filter((x) => !(x.variant === 'runpod' && runpodCreditProblem()) && !(x.variant !== 'cpu' && providerDown(x)));
        const all = usable.length ? usable : listed;
        const c = all[0];
        return c ? { key: cloudLaneKey(c), limit: all.filter((x) => x.variant === c.variant).reduce((n, x) => n + cloudLanes(x), 0) } : null;
      } catch (e: any) {
        // The generic lane (one at a time without playtesters) until this is fixed: say so, once per message.
        const msg = String(e?.message ?? e);
        if (msg !== this.laneError) console.warn(`[queue] playtest lanes: ${msg}; playtests wait in the generic lane`);
        this.laneError = msg;
        return null;
      }
    };

    // API and local lanes, shared fairly between customers like the GPU (fairOrder): a customer's n-th waiting job
    // comes after every other customer's earlier turns, and one customer holds at most queue.perProjectLane slots of a
    // lane (playtests count tabs), so nobody fills every playtest, Claude or CPU slot. Studio's projects and admin keys
    // are exempt, as on the GPU.
    const laneExempt = exemptCheck();
    const runningBy = new Map<string, number>();
    for (const p of this.laneProject.values()) runningBy.set(p, (runningBy.get(p) ?? 0) + 1);
    const lanesOrder = fairOrder(waiting.filter((x) => toolOf(x).provider !== 'comfy').map((x) => ({ ...x, exempt: laneExempt(x) })), runningBy, Infinity);
    const seenLanes = new Map<string, number>();
    for (const j of lanesOrder) {
      const provider = toolOf(j).provider as 'elevenlabs' | 'anthropic' | 'local' | 'builder' | 'playtest' | 'pipeline';
      // A pipeline that is a step of another job (asset.make's image.viewsheet) runs in its own lane, never behind the
      // cap: its parent already holds a pipeline slot and waits for it. Queued behind the cap, six asset.make jobs held
      // every slot while their own view-sheet steps waited for one, and nothing ever finished (2026-10-23, the starter pack).
      const nested = provider === 'pipeline' && Boolean(j.labels?.parent);
      // A tool with a lane of its own (asset.lod: the LOD system's work, src/lod.ts) waits while the lanes it yields to
      // have anything running or waiting, so customers' CPU jobs never share the CPU with it.
      const own = toolOf(j).lane;
      if (own?.yieldTo?.some((l) => (this.lanes.get(l)?.size ?? 0) > 0 || waiting.some((x) => x.id !== j.id && !toolOf(x).lane && toolOf(x).provider === l))) {
        this.wait(j, `waiting: ${own.yieldTo.join(', ')} jobs go first`);
        continue;
      }
      // Unity builds on Cloud Run (settings.unityBuild, docs/unity-cloudrun.md) have a lane of their own: one machine per build.
      // Builds on a project's VM (one VM per project) take their own lane, one at a time.
      const unityBackend = provider === 'builder' ? unityBackendOf(j.params, settings.unityBuild) : null;
      const cloudBuild = unityBackend === 'cloudrun';
      // So do playtests on Cloud Run (settings.playtest, docs/playtest-cloudrun.md): max instances x tabs per instance.
      const cloudPlay = provider === 'playtest' ? cloudPlaytestLanes(j, settings) : null;
      if (cloudPlay) seenLanes.set(cloudPlay.key, cloudPlay.limit);
      // So does the CPU suite on Cloud Run (settings.cpu, docs/cpu-cloudrun.md): this machine's CPU isn't what limits it.
      const cpuCloud = provider === 'local' && !own && cpuCloudEnabled(settings) ? cpuRoute(j.tool, settings).service : null;
      const key = own ? own.name : nested ? 'pipeline-step' : cloudBuild ? 'builder-cloud' : unityBackend === 'vm' ? 'builder-vm' : cloudPlay ? cloudPlay.key : cpuCloud ? 'local-cloud' : provider;
      const lane = this.lanes.get(key) ?? new Set();
      this.lanes.set(key, lane);
      // One build server. Pipelines only wait on other jobs, so several can run.
      const limit = own ? own.limit() : nested ? Infinity : cloudBuild ? settings.unityBuild.concurrency : cloudPlay ? cloudPlay.limit : cpuCloud ? settings.cpu.cloudrun.concurrent : provider === 'builder' ? 1 : provider === 'playtest' ? await playtestLimit(j) : provider === 'pipeline' ? settings.concurrency.pipeline : settings.concurrency[provider];
      // Playtests by tabs: an empty lane always takes one, so a run with more players than the lanes still plays.
      const weight = provider === 'playtest' ? tabsOf(j) : 1;
      const used = provider === 'playtest' ? [...lane].reduce((a, id) => a + (this.tabs.get(id) ?? 1), 0) : lane.size;
      if (used >= limit || (used > 0 && used + weight > limit)) {
        this.wait(j, provider === 'playtest' ? `waiting: ${used} of ${limit} playtest browser tabs in use` : `waiting: ${lane.size} ${key} jobs already running`);
        continue;
      }
      if (!j.exempt && !nested && !own) {
        const mine = [...lane].filter((id) => this.laneProject.get(id) === j.project).reduce((a, id) => a + (provider === 'playtest' ? (this.tabs.get(id) ?? 1) : 1), 0);
        if (mine > 0 && mine + weight > settings.queue.perProjectLane) {
          this.wait(j, `waiting: this project already has ${mine} ${provider === 'playtest' ? 'playtest tabs' : `${key} jobs`} running (its share)`);
          continue;
        }
      }
      // A Gen deploy is waiting for the build server to be free (hawkesstudio/deploy/hawkes-pull.mjs drops this file):
      // don't start another build until it's done, so the deploy gets its moment.
      if (provider === 'builder' && fs.existsSync(path.join(DATA_DIR, 'deploy-pending'))) {
        this.wait(j, 'waiting: Hawkes Gen is about to update (a few minutes)');
        continue;
      }
      lane.add(j.id);
      this.laneProject.set(j.id, j.project);
      if (provider === 'playtest') this.tabs.set(j.id, weight);
      const { turn: _turn, ok: _ok, exempt: _exempt, ...job } = j;
      void this.runJob(job, null, null, cpuCloud).finally(() => {
        lane.delete(j.id);
        this.laneProject.delete(j.id);
        this.tabs.delete(j.id);
        this.pump();
      });
    }

    if (seenLanes.size) this.playtestLanes = seenLanes;

    // The GPU lane (docs/gpu-providers.md). Each job's providers come in order (settings.gpu.order / familyOrder; with
    // none set, the old rule: its family's Cloud Run service when settings send it there, else the fleet). It takes the
    // first one with room: an endpoint or Cloud Run service goes to fillCloud, the fleet to the servers below.
    const allGpu = waiting.filter((x) => toolOf(x).provider === 'comfy');
    if (!allGpu.length) return;
    const routes = new Map<string, CloudService>();
    const stuck = new Map<string, string>();
    const ordered = !!settings.gpu.order.length || Object.keys(settings.gpu.familyOrder).length > 0;
    let map: ReturnType<typeof loadServiceMap> | null = null;
    if (cloudEnabled(settings) || ordered) {
      try {
        map = loadServiceMap();
      } catch (e: any) {
        console.warn(`[queue] server/cloudrun/services.json: ${e.message}; GPU jobs stay on the fleet`);
      }
    }
    // Fleet unreachable from here (Cloud Run without a fixed address) or AWS refusing us: the fleet cools down quietly.
    const blocked = fleetBlocked(settings.fleet);
    if (blocked && !isDown('fleet')) markDown('fleet', blocked, COOLDOWN.auth);
    const room = new Map<string, number>();
    const hasRoom = (svc: CloudService) => {
      const lane = svc.lane ?? svc.name;
      const used = (this.cloud.get(lane)?.size ?? 0) + (room.get(lane) ?? 0);
      return used < svc.maxInstances;
    };
    // Jobs that could also run on a service (a full one): the fleet's having no server doesn't strand them.
    const elsewhere = new Set<string>();
    const failed = new Set<string>();
    for (const j of allGpu) {
      const { choices, blockers } = gpuCandidates(j, toolOf(j), settings, map);
      if (!choices.length) {
        // Every provider was tried or is cooling down: forget what this job tried, so it tries them again once one is back.
        if (triedOf(j).length) {
          j.labels = { ...j.labels, gpuTried: [] };
          save(j, ['labels']);
        }
        // Nowhere to run: it fails now when nothing will come back by itself, else waits at most queue.gpuWaitMinutes.
        const waiting = this.noGpu(j, blockers, settings.queue.gpuWaitMinutes);
        if (waiting === null) failed.add(j.id);
        else stuck.set(j.id, waiting);
        continue;
      }
      const pick = choices.find((c) => c.kind === 'fleet' || hasRoom(c.service)) ?? choices[0];
      if (choices.some((c) => c.kind === 'service')) elsewhere.add(j.id);
      if (pick.kind === 'fleet') continue;
      const lane = pick.service.lane ?? pick.service.name;
      room.set(lane, (room.get(lane) ?? 0) + 1);
      routes.set(j.id, pick.service);
    }
    for (const j of allGpu) {
      const why = stuck.get(j.id);
      if (why) this.wait(j, why);
    }
    if (stuck.size) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.pump(), 60_000);
    }
    if (routes.size) this.fillCloud(allGpu.filter((j) => routes.has(j.id)), routes, settings);
    const gpu = allGpu.filter((j) => !routes.has(j.id) && !stuck.has(j.id) && !failed.has(j.id));
    if (!gpu.length) return;
    let endpoints: Endpoint[] = [];
    // With no order set the fleet is the only place left, so only an unreachable fleet is skipped (the old behaviour otherwise).
    const fleetDown = ordered || blocked ? isDown('fleet') : null;
    if (fleetDown) {
      this.waitReason = `the AWS fleet is skipped for now: ${fleetDown.reason}`;
    } else {
      try {
        endpoints = await comfyEndpoints();
        markUp('fleet');
        this.waitReason = endpoints.length ? '' : 'no GPU server is ready. Start one (dashboard Fleet tab, or `hawkesgen fleet start`).';
      } catch (e: any) {
        this.waitReason = e.message;
        // AWS refusing our credentials (invalid, expired, the account suspended): one quiet cooldown, not an error a job.
        if (awsRefused(e.message) || e.kind === 'auth' || e.kind === 'egress') {
          markDown('fleet', `AWS refused Gen: ${e.message}`, COOLDOWN.auth);
          if (ordered) this.timer ??= setTimeout(() => { this.timer = null; this.pump(); }, 1000);
        }
      }
    }
    const cap = settings.fleet.servers;
    let free = endpoints.filter((ep) => !this.busy.has(ep.id)).slice(0, Math.max(0, cap - this.busy.size));
    const taken = new Set<string>();
    // Fair sharing: each customer project has a cap of GPU jobs at once, and projects take turns (see fairOrder).
    const share = settings.queue.perProjectGpu;
    const running = this.gpuRunning();
    const exemptOf = exemptCheck();
    const byId = new Map(gpu.map((j) => [j.id, j]));
    const fair = () => fairOrder(gpu.filter((j) => !taken.has(j.id)).map((j) => ({ id: j.id, project: j.project, family: j.family, priority: j.priority, created: j.created, exempt: exemptOf(j) })), running, share).filter((j) => j.ok);
    // Disk-heavy jobs (renders, rigs) skip a server with under 10 GB free, and one they already failed on with a full disk.
    const free_ = new Map<string, number>();
    if (gpu.some(isDiskHeavy)) {
      await Promise.all(endpoints.map(async (ep) => {
        const f = await serverFreeDisk(ep.id);
        if (f !== null) free_.set(ep.id, f);
      }));
    }
    const avoidOf = (j: { id: string }) => this.diskAvoid.get(j.id) ?? new Set<string>();
    const fits = (j: { id: string; tool: string; family?: string | null }, ep: Endpoint) => mayPlace(j, ep.id, free_, avoidOf(j));
    const take = (f: { id: string }, ep: Endpoint) => {
      const j = byId.get(f.id)!;
      taken.add(j.id);
      if (!exemptOf(j)) running.set(j.project, (running.get(j.project) ?? 0) + 1);
      void this.runOn(j, ep);
    };
    // A server keeps its models loaded between jobs: give each free server the next job of the family it already has,
    // from the projects whose turn it is (the head's priority and turn), so grouping by model never costs a project its turn.
    for (const ep of [...free]) {
      const fam = this.families.get(ep.id);
      const next = sameTurn(fair()).find((j) => j.family === fam && fits(byId.get(j.id)!, ep));
      if (!next) continue;
      free = free.filter((x) => x !== ep);
      take(next, ep);
    }
    // A server that has to switch models (a load costs minutes) switches to the family with the most work waiting among
    // the jobs whose turn it is, the oldest job's family on a tie: one load then serves as many jobs as it can.
    for (const ep of free) {
      const next = switchTo(sameTurn(fair()).filter((j) => fits(byId.get(j.id)!, ep)));
      if (!next) break;
      take(next, ep);
    }
    const eligible = new Set(fair().map((j) => j.id));
    const left = gpu.filter((j) => !taken.has(j.id));
    // While servers auto start booted in the last 10 minutes come up, the jobs say so.
    const r = this.autoRound;
    const booting = r && (r.started.length || r.launched) && Date.now() - r.at < 600_000 ? `${r.note} (booting, a few minutes)` : '';
    // No server could start: say when auto start tries again and about when a server could take the job.
    const stopFails = r?.failed.some((f) => f.id !== 'launch');
    const retrying = !booting && stopFails && r?.nextTry && r.nextTry > Date.now() - ROUND_MS && Date.now() - r.at < 1_800_000
      ? `no stopped GPU server could start (AWS had no machine free, or no quota); next try in ${Math.max(1, Math.round((r.nextTry - Date.now()) / 60_000))} min (a server in about ${Math.max(1, Math.round((r.nextTry - Date.now()) / 60_000 + BOOT_SECONDS / 60))} min if one is free then)`
      : '';
    // With auto start on, the last round says why nothing runs yet; with it off, the old "start one" hint.
    const why = !booting && !retrying && r && r.note && (r.want > 0 || !loadSettings().fleet.auto) && Date.now() - r.at < 1_800_000 ? r.note : '';
    // The fleet as it stands after this look (AWS may have refused us just now).
    const fleetNow = isDown('fleet');
    for (const j of left) {
      if (!eligible.has(j.id)) { this.wait(j, `waiting: this project already has ${share} GPU jobs running (its next job goes when one finishes)`); continue; }
      const noRoom = isDiskHeavy(j) ? noRoomReason(endpoints.map((e) => e.id), free_, avoidOf(j)) : '';
      if (noRoom) { this.wait(j, noRoom); continue; }
      if (endpoints.length) { this.wait(j, `waiting for a free GPU server (${this.busy.size} of ${Math.min(cap, endpoints.length)} busy)`); continue; }
      const reason = booting || retrying || why || this.waitReason || 'no GPU server is ready';
      // No fleet server at all, and no service it could also run on: nowhere to run (nogpu.ts). AWS refusing Gen (no
      // keys, the account suspended) won't clear by itself; servers booting or AWS out of machines might.
      if (!elsewhere.has(j.id)) {
        const waiting = this.noGpu(j, [{ reason: `the AWS fleet: ${reason}`, lasting: !booting && !!fleetNow && lastingDown(fleetNow) }], settings.queue.gpuWaitMinutes);
        if (waiting === null) { failed.add(j.id); continue; }
        this.wait(j, waiting);
        continue;
      }
      this.wait(j, `waiting: ${reason}`);
    }
    if (left.some((j) => !failed.has(j.id))) {
      const wanting = left.filter((j) => eligible.has(j.id) && !failed.has(j.id)).length;
      if (wanting && !fleetDown && endpoints.length < Math.min(cap, wanting + this.busy.size)) void this.autoStart(wanting + this.busy.size);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.pump(), endpoints.length ? 10_000 : 30_000);
    }
  }

  /** Each project's GPU jobs running now, on the fleet and on Cloud Run (fair sharing counts both). */
  gpuRunning() {
    const running = new Map<string, number>();
    const ids = [...this.busy.values(), ...[...this.cloud.values()].flatMap((s) => [...s])];
    for (const id of ids) {
      const p = getJob(id)?.project;
      if (p) running.set(p, (running.get(p) ?? 0) + 1);
    }
    return running;
  }

  /**
   * GPU jobs routed to Cloud Run: in fair order (projects take turns, as on the fleet), each service running at most its
   * max instances at once (concurrency 1 per instance), so Cloud Run never has to queue or refuse a request of ours.
   */
  fillCloud(jobs: Job[], routes: Map<string, CloudService>, settings: ReturnType<typeof loadSettings>) {
    const share = settings.queue.perProjectGpu;
    const running = this.gpuRunning();
    const exemptOf = exemptCheck();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const order = fairOrder(jobs.map((j) => ({ id: j.id, project: j.project, family: j.family, priority: j.priority, created: j.created, exempt: exemptOf(j) })), running, share);
    for (const f of order) {
      const j = byId.get(f.id)!;
      const svc = routes.get(j.id)!;
      if (!f.ok) { this.wait(j, `waiting: this project already has ${share} GPU jobs running (its next job goes when one finishes)`); continue; }
      const laneId = svc.lane ?? svc.name;
      const lane = this.cloud.get(laneId) ?? new Set<string>();
      this.cloud.set(laneId, lane);
      const where = svc.provider && svc.provider !== 'cloudrun' ? svc.provider : 'Cloud Run';
      if (lane.size >= svc.maxInstances) { this.wait(j, `waiting for a ${where} GPU (${svc.name}: ${lane.size} of ${svc.maxInstances} running)`); continue; }
      lane.add(j.id);
      if (!f.exempt) running.set(j.project, (running.get(j.project) ?? 0) + 1);
      void this.runJob(j, null, svc).finally(() => {
        lane.delete(j.id);
        this.pump();
      });
    }
  }

  wait(j: Job, detail: string) {
    if (j.detail === detail) return;
    j.detail = detail;
    save(j, ['detail']);
  }

  /**
   * With auto start on (fleet.auto): starts stopped servers until there is one per job (src/autostart.ts: US regions,
   * a failed start moves on to another zone or region and is left alone for a while). It launches from the fleet image
   * only with fleet.autoLaunch. At most every two minutes. What it did goes in the waiting jobs' logs and GET /v1/fleet.
   */
  async autoStart(want: number) {
    const fleet = loadSettings().fleet;
    if (!fleet.auto) {
      if (!this.autoRound || this.autoRound.want !== 0) this.report(offRound());
      return;
    }
    if (Date.now() - this.lastAutoStart < ROUND_MS) return;
    this.lastAutoStart = Date.now();
    try {
      const round = await autoStartRound(want, fleet, {
        status: () => fleetStatus(),
        start: (id) => startServer(id),
        launch: () => launchServer({ idleMinutes: fleet.idleMinutes, type: fleet.launchType || 'g6e.xlarge' }),
        imageAvailable,
      }, this.autoBackoff);
      this.report(round);
    } catch (e: any) {
      console.warn(`[queue] auto start: ${e.message}`);
      this.report({ at: Date.now(), want, started: [], failed: [], launched: null, nextTry: null, expectedWait: null, imageStale: null, note: `auto start couldn't check the fleet: ${e.message}` });
    }
  }

  /** Keeps the round for the fleet status, and logs its note to the waiting GPU jobs when it changes (or something started). */
  report(round: AutoStartRound) {
    const changed = round.note !== this.autoRound?.note;
    this.autoRound = round;
    if (!changed && !round.started.length && !round.launched) return;
    console.log(`[queue] auto start: ${round.note}`);
    const line = `${new Date(round.at).toISOString().slice(11, 19)} ${round.note}`;
    for (const j of this.queued().filter((x) => getTool(x.tool)?.provider === 'comfy')) {
      j.log.push(line);
      j.log = j.log.slice(-300);
      save(j, ['log']);
    }
  }

  /** Auto start's state for the fleet status. */
  autoStartState() {
    const s = loadSettings().fleet;
    return {
      auto: s.auto, autoLaunch: s.autoLaunch, last: this.autoRound, reason: this.autoRound?.note ?? null, imageStale: this.autoRound?.imageStale ?? null,
      backoff: [...this.autoBackoff].filter(([, b]) => b.until > Date.now()).map(([id, b]) => ({ id, until: b.until, reason: b.reason, misses: b.misses ?? 1 })),
      // For Studio: when auto start tries a stopped server again, and about how many seconds until one takes jobs.
      nextTry: this.autoRound?.nextTry ?? null,
      expectedWait: this.autoRound?.expectedWait == null ? null : Math.max(0, this.autoRound.expectedWait - Math.round((Date.now() - this.autoRound.at) / 1000)),
    };
  }

  async runOn(job: Job, ep: Endpoint) {
    if (this.busy.has(ep.id)) return;
    this.busy.set(ep.id, job.id);
    try {
      await this.runJob(job, ep);
    } finally {
      this.busy.delete(ep.id);
      this.pump();
    }
  }

  /**
   * Runs a job. Whatever breaks, the job ends failed or goes back in the line: nothing may leave it "running" with
   * nothing running it (2026-11-02: a missing input threw before the run's own error handling, so jobs sat at "starting"
   * until the next restart picked them up and the same thing happened again).
   */
  async runJob(job: Job, ep: Endpoint | null, cloud: CloudService | null = null, cpu: CpuService | null = null) {
    try {
      await this.runJobInner(job, ep, cloud, cpu);
    } catch (e: any) {
      console.error(`[queue] ${job.id} (${job.tool}) broke outside its run: ${e?.stack ?? e}`);
      this.aborts.get(job.id)?.abort();
      this.aborts.delete(job.id);
      try {
        if (getJob(job.id)?.status === 'running') failJob(job.id, `Something went wrong starting this job: ${e?.message ?? e}`);
      } catch (e2: any) {
        console.error(`[queue] couldn't fail ${job.id}: ${e2?.message ?? e2}`);
      }
    }
  }

  async runJobInner(job: Job, ep: Endpoint | null, cloud: CloudService | null, cpu: CpuService | null) {
    const tool = getTool(job.tool)!;
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    const tmpDir = path.join(paths.tmp, job.id);
    fs.mkdirSync(tmpDir, { recursive: true });
    // Instance seconds this attempt used on Cloud Run (and the cold starts it paid for), for its cost.
    const cloudUse = { seconds: 0, startup: 0, runs: 0, cold: 0 };
    Object.assign(job, {
      status: 'running', started: Date.now(), server: cloud ? `${cloud.provider && cloud.provider !== 'cloudrun' ? cloud.provider : 'cloudrun'}:${cloud.name}` : cpu ? `cloudrun:${cpu.name}` : ep?.id ?? null,
      detail: cloud ? `starting on Cloud Run (${cloud.name}, ${cloud.gpu})` : cpu ? `starting on Cloud Run (${cpu.name})` : ep ? `connecting to the GPU server in ${ep.region}` : 'starting',
    });
    // On a fleet server it has a GPU: its wait for one is over (a later wait starts a new clock).
    if (ep && waitSinceOf(job.labels)) {
      const { gpuWaitSince: _w, ...labels } = job.labels;
      job.labels = labels;
      save(job, ['labels']);
    }
    save(job, ['status', 'started', 'server', 'detail']);
    const step = (detail: string) => {
      job.detail = detail;
      job.log.push(`${new Date().toISOString().slice(11, 19)} ${detail}`);
      job.log = job.log.slice(-300);
      save(job, ['detail', 'log']);
    };
    // The recipe parts that don't change between outputs (the inputs' hashes once they are on this disk, in the run below).
    const inputHashes: Record<string, string | string[]> = {};
    const baseRecipe: Omit<Recipe, 'seed'> = { tool: tool.id, version: tool.version, params: job.params, inputs: inputHashes, models: tool.models?.(job.params) };

    const assetOf = (out: Omit<Output, 'data'>) => ({
      mime: out.mime, ext: out.ext, job: job.id, client: job.client, project: job.project, tool: tool.id,
      seed: out.seed ?? null, recipe: { ...baseRecipe, params: { ...job.params, seed: out.seed ?? job.params.seed } }, labels: job.labels, title: out.title, meta: out.meta,
    });
    const keep = (asset: ReturnType<typeof putAsset>) => {
      job.outputs.push({ asset: asset.id, seed: asset.seed, mime: asset.mime, kind: asset.kind, title: asset.title });
      save(job, ['outputs']);
    };
    const ctx: RunContext = {
      job: { id: job.id, client: job.client, project: job.project, tool: job.tool, labels: job.labels },
      params: job.params,
      inputs: job.inputs,
      done: job.outputs.length,
      outputs: job.outputs,
      signal: abort.signal,
      step,
      log: (line) => {
        job.log.push(line);
        save(job, ['log']);
      },
      tmp: (name) => path.join(tmpDir, name),
      emit: async (out: Output) => keep(putAsset({ ...assetOf(out), data: out.data })),
      emitFile: async (out) => keep(await putAssetFile({ ...assetOf(out), file: out.file })),
      result: (value) => {
        job.result = value;
        save(job, ['result']);
      },
      // On Cloud Run a job without a seed gets seeds derived from its id, so a job picked up again after a restart
      // rebuilds the same graphs (the same run keys) and takes the answers its runs already left in the bucket.
      seed: (n) => (job.params.seed ? Number(job.params.seed) + n : cloud || cpu ? jobSeed(job.id, n) : crypto.randomInt(1, 2 ** 31)),
      usage: (u) => {
        recordUsage({ client: job.client, project: job.project, job: job.id, ...u });
        job.cost = Math.round((job.cost + (u.cost ?? 0)) * 10000) / 10000;
        save(job, ['cost']);
      },
      python: (script, args) => run(PYTHON, [path.join(paths.post, script), ...args], { signal: abort.signal }),
    };

    try {
      // Library files this job reads that aren't on this disk (a new server) come back from storage first. One that
      // can't (an upload that only lived on a disk that is gone) fails the job in plain words.
      await ensureInputs(job.inputs);
      for (const [k, v] of Object.entries(job.inputs)) {
        for (const f of Array.isArray(v) ? v : [v]) {
          if (typeof f === 'string' && !fs.existsSync(f)) {
            job.log.push(`input ${k} is missing: ${f}`);
            throw new GenError(`The ${k} file this job uses is no longer available. Add it again and run the job again.`);
          }
        }
        inputHashes[k] = Array.isArray(v) ? await Promise.all(v.map(sha256File)) : await sha256File(v);
      }
      if (ep) ctx.comfy = await this.comfyRun(job, ep, step, abort.signal);
      if (cloud) {
        ctx.comfy = cloudComfyRun(job, cloud, {
          step,
          progress: (d) => { job.detail = d; events.emit('job', summary(job)); },
          keepGraph: (graph) => {
            const name = `${job.id}-${job.graphs.length + 1}.json`;
            fs.writeFileSync(path.join(paths.graphs, name), JSON.stringify(graph, null, 1));
            job.graphs.push(name);
            save(job, ['graphs']);
          },
          addSeconds: (seconds, startup) => {
            cloudUse.seconds += seconds + startup;
            cloudUse.startup += startup;
            cloudUse.runs += 1;
            if (startup) cloudUse.cold += 1;
            job.gpu_seconds = Math.round((job.gpu_seconds + seconds) * 10) / 10;
            save(job, ['gpu_seconds']);
          },
          signal: abort.signal,
        });
      }
      // The CPU suite on Cloud Run: the same tool code runs there; if the service can't take the job, it runs here.
      const remote = cpu
        ? await runCpuRemote(job, tool, ctx, cpu, {
          addSeconds: (seconds, cold, startup) => {
            cloudUse.seconds += seconds + startup;
            cloudUse.startup += startup;
            cloudUse.runs += 1;
            if (cold) cloudUse.cold += 1;
          },
        })
        : false;
      if (!remote) {
        if (cpu) Object.assign(job, { server: null });
        // A customer's job never spends J's Max plan (providers/anthropic.ts callScope).
        await callScope.run({ customer: !exemptCheck()(job), org: orgOfProject(job.project), house: isHouseProject(job.project) }, () => tool.run(ctx));
      }
      if (cloud) markUp(cloud.lane ?? cloud.name);
      Object.assign(job, { status: 'done', finished: Date.now(), detail: `done: ${job.outputs.length} output${job.outputs.length === 1 ? '' : 's'}${job.result ? ' and a result' : ''}` });
      // The LOD system: low copies this job made are linked to their models, and its images and models get their
      // levels made (src/lod.ts; a low-priority CPU job of Gen's own, never charged).
      try {
        afterJob(job);
      } catch (e: any) {
        job.log.push(`couldn't queue the levels of detail: ${e.message}`);
      }
      try {
        const filed = fileJobOutputs(job);
        if (filed.length) job.log.push(`filed ${filed.length} take${filed.length === 1 ? '' : 's'} in ${job.labels.entity} ${filed.map((v) => `${v.slot} v${v.n}`).join(', ')}`);
      } catch (e: any) {
        job.log.push(`couldn't file the outputs in ${job.labels.entity}: ${e.message}`);
      }
    } catch (e: any) {
      const cancelled = abort.signal.aborted || e.message === 'Cancelled';
      // A provider that can't take it now (unreachable, no GPU free, our key refused): it cools down and the job goes back
      // in the line for the next provider in its order (docs/gpu-providers.md).
      // With no order set (the old rule) there is no next provider: the job fails as it always did.
      if (cloud && e.unavailable && !cancelled && orderFor(loadSettings(), job.family).length) {
        const lane = cloud.lane ?? cloud.name;
        markDown(lane, e.message, e.auth ? COOLDOWN.auth : e.capacity ? COOLDOWN.capacity : COOLDOWN.unreachable);
        Object.assign(job, { status: 'queued', started: null, server: null, error: null, detail: `${e.message}; trying the next GPU provider`, labels: { ...job.labels, gpuTried: [...new Set([...triedOf(job), lane])] } });
        job.log.push(`error: ${e.message}`, job.detail);
        save(job, ['labels']);
        return;
      }
      // A graph that ran past Cloud Run's request limit goes back in the line once, for the fleet (no time limit there).
      // Not when the fleet can't start (no AWS credentials): the job would only fail later as "no GPU" (beta 2026-11-10).
      if (cloud && e.overLimit && !cancelled && job.labels.gpuBackend !== 'fleet' && !fleetCredentialProblem()) {
        Object.assign(job, { status: 'queued', started: null, server: null, error: null, detail: `${e.message}; running it on the fleet instead`, labels: { ...job.labels, gpuBackend: 'fleet' } });
        job.log.push(`error: ${e.message}`, job.detail);
        save(job, ['labels']);
        return;
      }
      // A full disk is the server's fault: the job goes back in the line once, to another server.
      const avoid = this.diskAvoid.get(job.id) ?? new Set<string>();
      if (ep && retryOnDiskFull(e.message, avoid, cancelled)) {
        avoid.add(ep.id);
        this.diskAvoid.set(job.id, avoid);
        markDiskFull(ep.id);
        Object.assign(job, { status: 'queued', started: null, server: null, error: null, detail: `${ep.id} ran out of disk; trying another server` });
        job.log.push(`error: ${e.message}`, job.detail);
        return;
      }
      Object.assign(job, { status: cancelled ? 'cancelled' : 'failed', finished: Date.now(), error: cancelled ? null : e.message, detail: cancelled ? 'cancelled' : e.message });
      job.log.push(`error: ${e.message}`);
      if (tool.provider === 'pipeline') stopChildren(job.id);
      if (keepsCharge(job, e, cancelled)) job.log.push(`credits kept: ${cancelled ? 'cancelled after the build had run for a while' : `the build itself failed (${e.kind})`}`);
      else refundJob(job.id, cancelled ? 'Job cancelled' : `Job failed: ${e.message}`);
    } finally {
      if (ep && job.gpu_seconds) {
        const cost = (job.gpu_seconds / 3600) * ep.price;
        recordUsage({ client: job.client, project: job.project, job: job.id, provider: 'aws-gpu', unit: 'gpu_seconds', amount: job.gpu_seconds, cost, detail: ep.region });
        job.cost = Math.round((job.cost + cost) * 10000) / 10000;
      }
      // Cloud Run bills the instance (GPU, vCPUs and memory) per second: the seconds its runs took, plus the cold start
      // when this job's request started the instance. The idle minutes before Cloud Run scales an instance down aren't
      // any one job's; docs/cloudrun.md says how to read them from the billing export.
      // The CPU services bill vCPUs and memory while a request runs (request-based billing), and the start of an
      // instance the request had to wait for.
      if (cpu && cloudUse.seconds) {
        const cost = cloudUse.seconds * cpu.pricePerSecond;
        recordUsage({
          client: job.client, project: job.project, job: job.id, provider: 'gcp-cpu', unit: 'instance_seconds', amount: Math.round(cloudUse.seconds * 10) / 10, cost,
          detail: `${cpu.name}${cloudUse.cold ? `, cold start (${Math.round(cloudUse.startup)} s)` : ''}`,
        });
        job.cost = Math.round((job.cost + cost) * 10000) / 10000;
      }
      if (cloud && cloudUse.seconds) {
        const cost = cloudUse.seconds * cloud.pricePerSecond;
        recordUsage({
          client: job.client, project: job.project, job: job.id, provider: cloud.provider && cloud.provider !== 'cloudrun' ? `${cloud.provider}-gpu` : 'gcp-gpu', unit: 'instance_seconds', amount: Math.round(cloudUse.seconds * 10) / 10, cost,
          detail: `${cloud.name} ${cloud.gpu}, ${cloudUse.runs} run${cloudUse.runs === 1 ? '' : 's'}${cloudUse.cold ? `, ${cloudUse.cold} cold start (${Math.round(cloudUse.startup)} s)` : ''}`,
        });
        job.cost = Math.round((job.cost + cost) * 10000) / 10000;
      }
      this.aborts.delete(job.id);
      removeLater(tmpDir);
      save(job, ['status', 'started', 'server', 'finished', 'error', 'detail', 'log', 'gpu_seconds', 'cost']);
    }
  }

  /** What a ComfyUI tool gets: uploads (cached per server), graph runs (kept and timed), downloads. */
  async comfyRun(job: Job, ep: Endpoint, step: (d: string) => void, signal: AbortSignal) {
    const comfy = new Comfy(ep);
    // A server started from stopped is listed ready (its last boot's status) while ComfyUI still loads: wait for it.
    await comfy.ready({ signal, onWait: () => step(`waiting for ComfyUI to come up on ${ep.id}`) });
    const fam = job.family ?? 'other';
    if (this.families.get(ep.id) !== fam) {
      step(`unloading the last models to make room for ${fam}`);
      await comfy.free().catch(() => undefined);
    }
    this.families.set(ep.id, fam);
    const cache = this.uploads.get(ep.id) ?? new Map<string, string>();
    this.uploads.set(ep.id, cache);
    const uploadBuffer = async (data: Buffer, name: string) => {
      const h = crypto.createHash('sha256').update(data).digest('hex');
      const hit = cache.get(h);
      if (hit) return hit;
      const remote = await comfy.upload(data, `${h.slice(0, 16)}${path.extname(name)}`);
      cache.set(h, remote);
      return remote;
    };
    return {
      comfy,
      server: { id: ep.id, region: ep.region, price: ep.price },
      upload: (file: string) => uploadBuffer(fs.readFileSync(file), file),
      uploadBuffer,
      runGraph: async (graph: any) => {
        const name = `${job.id}-${job.graphs.length + 1}.json`;
        fs.writeFileSync(path.join(paths.graphs, name), JSON.stringify(graph, null, 1));
        job.graphs.push(name);
        save(job, ['graphs']);
        const t = Date.now();
        const onProgress = (d: string) => { job.detail = d; events.emit('job', summary(job)); };
        try {
          try {
            return (await comfy.run(graph, { signal, onProgress })).files;
          } catch (e: any) {
            // ComfyUI crashed mid-run and came back without the graph: once more (its uploads are still on the server's disk).
            if (!e.lost || signal.aborted) throw e;
            step(`${e.message}; waiting for it and running the graph once more`);
            await comfy.ready({ signal });
            return (await comfy.run(graph, { signal, onProgress })).files;
          }
        } catch (e: any) {
          if (e.missingModels?.length) {
            throw new GenError(`${e.message}\nThis server doesn't have every model yet. Run "hawkesgen fleet sync" (or Sync models in the dashboard) to download them.`);
          }
          throw e;
        } finally {
          job.gpu_seconds = Math.round((job.gpu_seconds + (Date.now() - t) / 1000) * 10) / 10;
          save(job, ['gpu_seconds']);
        }
      },
      download: (file: any) => comfy.download(file),
      timed: async <T>(work: () => Promise<T>) => {
        const t = Date.now();
        try {
          return await work();
        } finally {
          job.gpu_seconds = Math.round((job.gpu_seconds + (Date.now() - t) / 1000) * 10) / 10;
          save(job, ['gpu_seconds']);
        }
      },
      ensureModels: async (models: ModelRef[]) => {
        const installed = await installModels(ep.id, models, step);
        markModelsUsed(ep.id, models);
        if (installed.length) {
          step(`installed ${installed.length} model${installed.length > 1 ? 's' : ''} on ${ep.id}`);
          comfy.info = null;
        }
      },
    };
  }
}

/**
 * Removes a job's scratch folder. On Windows a browser or ffmpeg can still hold a file for a moment after a job
 * ends, so a failed removal is retried later instead of throwing (an uncaught error here once took the service down).
 */
function removeLater(dir: string, tries = 0) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e: any) {
    if (tries < 10) setTimeout(() => removeLater(dir, tries + 1), 30_000).unref();
    else console.warn(`[jobs] couldn't remove ${dir}: ${e.code ?? e.message}`);
  }
}

/** Whether a job is exempt from fair sharing: not a customer project (settings.queue.projects), or made with an admin/owner key. */
function exemptCheck(): (j: { project: string; client: string }) => boolean {
  const globs = loadSettings().queue.projects;
  const roles = new Map<string, string | null>();
  const roleOf = (id: string) => {
    // A platform token's caller (src/platform.ts: client id org:<org>:<user>) is always a customer: it has no key row.
    if (!roles.has(id)) roles.set(id, id.startsWith('org:') ? 'user' : (db.prepare('SELECT role FROM clients WHERE id = ?').get(id) as { role: string } | undefined)?.role ?? null);
    return roles.get(id);
  };
  return (j) => !globs.some((g) => (g.endsWith('*') ? j.project.startsWith(g.slice(0, -1)) : j.project === g)) || roleOf(j.client) !== 'user';
}

/**
 * Average run time of a tool's recent finished jobs, in seconds (a minute when it has none). Kept a minute per tool:
 * queuePosition asks once per job ahead on every poll of a queued job, and uncached (before the jobs_tool_done index)
 * each ask scanned the whole jobs table: Gen's event loop sat blocked 1-3 s at a time (2026-10-25).
 */
const runSeconds = new Map<string, { at: number; seconds: number }>();
function recentRunSeconds(tool: string): number {
  const hit = runSeconds.get(tool);
  if (hit && Date.now() - hit.at < 60_000) return hit.seconds;
  const rows = db.prepare("SELECT started, finished FROM jobs WHERE tool = ? AND status = 'done' AND started IS NOT NULL AND finished IS NOT NULL ORDER BY finished DESC LIMIT 20").all(tool) as { started: number; finished: number }[];
  const xs = rows.map((r) => (r.finished - r.started) / 1000).filter((x) => x > 0);
  const seconds = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 60;
  runSeconds.set(tool, { at: Date.now(), seconds });
  return seconds;
}

/** How long a run of this tool usually takes (seconds, the mean of its last 20 finished jobs; 60 when none): the app's "about 40 s". */
export function typicalRunSeconds(tool: string): number { return Math.round(recentRunSeconds(tool)); }

export const queue = new Queue();

/** Downloads models a family needs onto a server (exposed for the fleet sync action). */
export const syncModels = syncServer;

/** A queued job's place in line: how many queued jobs in its lane (the GPU, or its provider) will be served before it
 *  (a higher priority, or the same priority and older). Jobs already running aren't in line: they are on servers of
 *  their own, so counting them said "10 ahead" to a job that was next. `running` says how busy the lane is.
 *  Counts only, so a customer learns nothing about anyone else's work. */
export function queuePosition(j: Job): { ahead: number; running: number; lane: string; etaMinutes: number } | null {
  if (j.status !== 'queued') return null;
  const tool = getTool(j.tool);
  if (!tool) return null;
  const lane = tool.provider === 'comfy' ? 'gpu' : tool.provider;
  const rows = db.prepare("SELECT id, client, project, tool, status, family, priority, created FROM jobs WHERE status IN ('queued', 'running') AND id != ?").all(j.id) as (Pick<Job, 'id' | 'client' | 'project' | 'tool' | 'status' | 'family' | 'priority' | 'created'>)[];
  let running = 0;
  const open: (Pick<Job, 'id' | 'client' | 'project' | 'tool' | 'family' | 'priority' | 'created'>)[] = [];
  const busyBy = new Map<string, number>();
  for (const r of rows) {
    const t = getTool(r.tool);
    if (!t || (t.provider === 'comfy' ? 'gpu' : t.provider) !== lane) continue;
    if (r.status === 'running') { running++; busyBy.set(r.project, (busyBy.get(r.project) ?? 0) + 1); continue; }
    open.push(r);
  }
  open.push(j);
  open.sort((a, b) => b.priority - a.priority || a.created - b.created);
  // On the GPU the order is the fair one (projects take turns), so a project with a pile of jobs is not "ahead" of a newcomer.
  const exempt = exemptCheck();
  const order = lane === 'gpu'
    ? fairOrder(open.map((r) => ({ id: r.id, project: r.project, family: r.family, priority: r.priority ?? 0, created: r.created, exempt: exempt(r) })), busyBy, loadSettings().queue.perProjectGpu).map((r) => r.id)
    : open.map((r) => r.id);
  const ids = order.slice(0, order.indexOf(j.id));
  const byId = new Map(open.map((r) => [r.id, r]));
  const slots = lane === 'gpu' ? Math.max(1, loadSettings().fleet.servers) : lane === 'builder' ? 1 : Math.max(1, (loadSettings().concurrency as Record<string, number>)[lane] ?? 1);
  const seconds = [...ids.map((id) => byId.get(id)!.tool), j.tool].reduce((a, t) => a + recentRunSeconds(t), 0);
  return { ahead: ids.length, running, lane, etaMinutes: Math.max(1, Math.ceil(seconds / slots / 60)) };
}
