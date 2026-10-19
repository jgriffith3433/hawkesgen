// The HTTP API (JSON, under /v1) and the dashboard (static files at /).
// docs/api.md lists every route with examples.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { paths, loadSettings, saveSettings, FLEET_MAX } from './config.ts';
import { authenticate, canProject, requireRole, createClient, listClients, setClientDisabled, type Client } from './auth.ts';
import { TOOLS, getTool, describeTool, reloadTools } from './tools/index.ts';
import { listWorkflows, getWorkflow, saveWorkflow, draftManifest } from './workflows/registry.ts';
import { objectInfo, refreshCatalog, templates, templateWorkflow, templateThumb, importWorkflow } from './workflows/catalog.ts';
import { convertUiWorkflow, checkGraph } from './workflows/convert.ts';
import { validateParams } from './tools/validate.ts';
import { estimate } from './estimate.ts';
import { submit, getJob, listJobs, cancel, rerun, clearFinished, events, summary, queue, type JobSpec } from './jobs.ts';
import { getAsset, listAssets, updateAsset, deleteAsset, putBlob, blobPath, putAsset, findByRecipe, recipeKey } from './library.ts';
import * as lib from './entities.ts';
import * as storage from './storage.ts';
import { usageSummary } from './usage.ts';
import { listPresets, getProjectPresets, saveProjectPresets } from './presets.ts';
import * as fleet from './providers/comfy/fleet.ts';
import * as fleetImage from './providers/comfy/image.ts';
import * as builder from './providers/builder/builder.ts';
import * as playtester from './providers/playtester/playtester.ts';
import { Retry } from './providers/comfy/retry.ts';
import * as eleven from './providers/elevenlabs.ts';
import * as claude from './providers/anthropic.ts';
import { GenError, sha256File, mimeOf } from './util.ts';
import { db } from './db.ts';
import { handleMcp } from './mcp-http.ts';
import { handleCollect } from './analytics/collect.ts';
import { handleAnalytics } from './analytics/routes.ts';

const VERSION = JSON.parse(fs.readFileSync(path.join(paths.server, '..', 'package.json'), 'utf8')).version;

export const retry = new Retry({ onSuccess: () => queue.pump() });
let lastFailure: any = null;
let account: { at: number; value: any } = { at: 0, value: null };

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new GenError('Request body too large', { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new GenError('The body is not JSON');
  }
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, mime = mimeOf(file), extra: Record<string, string> = {}) {
  const stat = fs.statSync(file);
  const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': mime, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...extra });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', ...extra });
  fs.createReadStream(file).pipe(res);
}

/** Fleet errors carry a kind and the attempts; remember the last launch/start failure for the dashboard. */
function fleetFail(e: any) {
  if (e instanceof GenError && e.kind && e.kind !== 'other') lastFailure = { at: Date.now(), message: e.message, kind: e.kind, attempts: e.attempts ?? [] };
  throw e;
}

function jobVisible(c: Client, j: { project: string }) {
  return canProject(c, j.project);
}

const STATIC: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// The SDK versions callers send. js and py share CLIENT_VERSION; Unity has its package version.
const SDK_CURRENT = { js: Number(/CLIENT_VERSION = (\d+)/.exec(fs.readFileSync(path.join(paths.server, '..', 'clients', 'js', 'hawkesgen.mjs'), 'utf8'))?.[1] ?? 0), ui: Number(/UI_VERSION = (\d+)/.exec(fs.readFileSync(path.join(paths.server, '..', 'clients', 'js', 'hawkesgen-ui.mjs'), 'utf8'))?.[1] ?? 0), unity: JSON.parse(fs.readFileSync(path.join(paths.server, '..', 'clients', 'unity', 'com.hawkes.gen', 'package.json'), 'utf8')).version as string };
const SDK_MIN = { js: 4 };
const clientsSeen = new Map<string, { agent: string; version: string; from: string; behind: boolean; at: number }>();
function noteClient(req: IncomingMessage) {
  const v = String(req.headers['x-hawkes-client'] ?? '');
  const m = /^(js|py|unity)\/([\d.]+)$/.exec(v);
  if (!m) return;
  const from = String(req.headers.origin ?? req.headers['user-agent'] ?? '').slice(0, 80);
  const behind = m[1] === 'unity' ? m[2] !== SDK_CURRENT.unity : Number(m[2]) < SDK_CURRENT.js;
  clientsSeen.set(`${v} ${from}`, { agent: m[1], version: m[2], from, behind, at: Date.now() });
  if (clientsSeen.size > 200) clientsSeen.delete(clientsSeen.keys().next().value!);
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const method = req.method ?? 'GET';

  // Player analytics from every product's pages: public, with its own CORS for the registered origins (src/analytics/).
  if (route === '/v1/analytics/collect') return handleCollect(req, res);

  // CORS: games' dev servers (other localhost ports) call the API from the browser.
  const origin = String(req.headers.origin ?? '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hawkesgen-Key, X-Filename, X-Hawkes-Client');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (method === 'OPTIONS') return void res.writeHead(204).end();

  // MCP over HTTP (src/mcp-http.ts), with its own key check.
  if (route === '/mcp' || route.startsWith('/mcp/')) return handleMcp(req, res, route);

  // The JS client and the UI kit (clients/js), for pages that load them from Gen instead of keeping a copy.
  const kit = /^\/client\/(hawkesgen(?:-ui)?\.mjs)$/.exec(route);
  if (kit && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return void fs.createReadStream(path.join(paths.server, '..', 'clients', 'js', kit[1])).pipe(res);
  }

  // Dashboard.
  if (!route.startsWith('/v1/')) {
    const rel = route === '/' ? 'index.html' : route.slice(1);
    const file = path.join(paths.dashboard, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(paths.dashboard) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': STATIC[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return void fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // Which SDK each caller runs (X-Hawkes-Client: js/6, py/6, unity/0.2.0): /v1/health lists the ones behind.
  noteClient(req);

  try {
    if (route === '/v1/health') {
      return send(res, 200, {
        ok: true, name: 'hawkesgen', version: VERSION,
        providers: {
          aws: (() => { try { fleet.awsConfig(); return true; } catch { return false; } })(),
          elevenlabs: eleven.configured(),
          anthropic: claude.configured(),
          claude: claude.backend(),
          python: fs.existsSync(path.join(paths.post, '..', '.venv')),
        },
        queue: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status").all() as any[]).map((r) => [r.status, r.n])),
        // Unity builds and tests on the build server: the one kind of job a restart of Gen would leave half done
        // (the deploy script waits for these only; everything else resumes after a restart).
        building: (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND tool IN ('unity.build', 'unity.test')").get() as any).n,
        client: { current: SDK_CURRENT, min: SDK_MIN, behind: [...clientsSeen.values()].filter((c) => c.behind) },
      });
    }

    const client = authenticate(req);
    if (!client) return send(res, 401, { error: 'Send an API key (Authorization: Bearer hg_...)' });

    if (route === '/v1/me') return send(res, 200, client);

    // ------------------------------------------------------------ analytics
    // Reading what players did (src/analytics/routes.ts, docs/analytics.md).
    if (handleAnalytics(client, route, method, q, res, send, url.search)) return;

    // ---------------------------------------------------------------- tools
    if (route === '/v1/tools' && method === 'GET') return send(res, 200, { tools: TOOLS.map(describeTool) });
    let m = /^\/v1\/tools\/([\w.-]+)$/.exec(route);
    if (m && method === 'GET') {
      const t = getTool(m[1]);
      if (!t) throw new GenError(`Unknown tool: ${m[1]}`, { status: 404 });
      return send(res, 200, describeTool(t));
    }

    // ----------------------------------------------------------------- jobs
    if (route === '/v1/jobs' && method === 'POST') {
      const body = await readJson(req);
      const specs: JobSpec[] = Array.isArray(body.jobs) ? body.jobs : [body];
      return send(res, 200, { jobs: specs.map((s) => submit(client, s)).map(summary) });
    }
    if (route === '/v1/run' && method === 'POST') {
      // Submit and wait (up to timeout seconds, default 10 minutes). Handy for scripts and quick tools.
      const body = await readJson(req);
      const job = submit(client, body);
      const until = Date.now() + Math.max(1, Math.min(3600, Number(body.timeout) || 600)) * 1000;
      const final = await new Promise<any>((resolve) => {
        const check = () => {
          const j = getJob(job.id)!;
          if (['done', 'failed', 'cancelled'].includes(j.status) || Date.now() > until) {
            events.off('job', onJob);
            clearInterval(timer);
            resolve(j);
          }
        };
        const onJob = (j: any) => j.id === job.id && check();
        const timer = setInterval(check, 2000);
        events.on('job', onJob);
        check();
      });
      return send(res, 200, final);
    }
    if (route === '/v1/jobs' && method === 'GET') {
      if (q('project') && !canProject(client, q('project')!)) throw new GenError('No access to that project', { status: 403 });
      return send(res, 200, { jobs: listJobs({ project: q('project'), status: q('status'), tool: q('tool'), limit: Number(q('limit')) || 100, projects: client.projects }).map(summary) });
    }
    if (route === '/v1/jobs/clear' && method === 'POST') {
      requireRole(client, 'admin');
      const { project } = await readJson(req);
      return send(res, 200, { removed: clearFinished(project) });
    }
    m = /^\/v1\/jobs\/(j_[0-9a-f]+)(?:\/(cancel|rerun|graphs\/[\w.-]+))?$/.exec(route);
    if (m) {
      const j = getJob(m[1]);
      if (!j || !jobVisible(client, j)) throw new GenError('No such job', { status: 404 });
      if (!m[2] && method === 'GET') return send(res, 200, j);
      if (m[2] === 'cancel' && method === 'POST') return send(res, 200, cancel(j.id));
      if (m[2] === 'rerun' && method === 'POST') return send(res, 200, rerun(client, j.id, { sameSeed: (await readJson(req)).sameSeed === true }));
      if (m[2]?.startsWith('graphs/') && method === 'GET') {
        const name = m[2].slice(7);
        if (!j.graphs.includes(name)) throw new GenError('No such graph', { status: 404 });
        return serveFile(req, res, path.join(paths.graphs, name), 'application/json', { 'Content-Disposition': `attachment; filename="${name}"` });
      }
    }

    // --------------------------------------------------------------- events
    if (route === '/v1/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      const onJob = (j: any) => jobVisible(client, j) && res.write(`event: job\ndata: ${JSON.stringify(j)}\n\n`);
      // Library changes (src/entities.ts): an entity edited, a take filed, picked or discarded.
      const onLibrary = (e: any) => canProject(client, String(e.entity).split('/')[0]) && res.write(`event: library\ndata: ${JSON.stringify(e)}\n\n`);
      events.on('job', onJob);
      events.on('library', onLibrary);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        events.off('job', onJob);
        events.off('library', onLibrary);
        clearInterval(ping);
      });
      return;
    }

    // --------------------------------------------------------------- library: entities, slots, versions
    // src/entities.ts and docs/library.md. A slot name can have slashes (pose/air), so it is the rest of the path.
    if (route === '/v1/entities' && method === 'GET') {
      return send(res, 200, lib.listEntities(client, { project: q('project'), kind: q('kind'), text: q('q'), tag: q('tag'), archived: q('archived') === '1', limit: Number(q('limit')) || 100, offset: Number(q('offset')) || 0 }));
    }
    if (route === '/v1/entities' && method === 'POST') return send(res, 200, lib.createEntity(client, await readJson(req)));
    m = /^\/v1\/versions\/(v_[0-9a-f]+)$/.exec(route);
    if (m && method === 'PATCH') return send(res, 200, lib.updateVersion(client, m[1], await readJson(req)));
    m = /^\/v1\/entities\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9-]*)(?:\/slots\/(.+?))?(?:\/(versions|make|revise))?$/i.exec(route);
    if (m) {
      const entityId = `${m[1]}/${m[2]}`;
      const slot = m[3] ? decodeURIComponent(m[3]) : null;
      const action = m[4] ?? null;
      if (!slot && !action && method === 'GET') return send(res, 200, lib.getEntity(client, entityId));
      if (!slot && !action && method === 'PATCH') return send(res, 200, lib.updateEntity(client, entityId, await readJson(req)));
      if (slot && !action && method === 'GET') return send(res, 200, lib.slotHistory(client, entityId, slot, { discarded: q('discarded') !== '0' }));
      if (slot && action === 'versions' && method === 'POST') {
        // A file into the slot: an asset already in the library, or an uploaded blob (POST /v1/blobs first).
        const b = await readJson(req);
        let assetId = typeof b.asset === 'string' ? b.asset.replace(/^asset:/, '') : null;
        const file = typeof b.file === 'string' ? b.file : null;
        if (!assetId && file?.startsWith('asset:')) assetId = file.slice(6);
        if (!assetId && file?.startsWith('blob:')) {
          const p = blobPath(file.slice(5));
          if (!p) throw new GenError(`No blob ${file.slice(5)}`, { status: 404 });
          const e = lib.getEntity(client, entityId);
          const ext = path.extname(p).toLowerCase();
          assetId = putAsset({
            data: fs.readFileSync(p), ext: ext || undefined, client: client.id, project: e.project, tool: 'file.import',
            recipe: { tool: 'file.import', version: 1, params: { title: b.title ?? null, ...(typeof b.prompt === 'string' ? { prompt: b.prompt.slice(0, 8000) } : {}) }, inputs: { file: file.slice(5) } },
            labels: { entity: entityId, slot }, title: typeof b.title === 'string' ? b.title.slice(0, 200) : `${entityId} ${slot}`,
            meta: b.meta && typeof b.meta === 'object' ? b.meta : undefined,
          }).id;
        }
        if (!assetId) throw new GenError('Send asset (an asset id) or file (blob:<sha256> or asset:<id>)');
        return send(res, 200, lib.addVersion(client, { entity: entityId, slot, asset: assetId, status: b.status, note: b.note, by: client.name }));
      }
      if (slot && (action === 'make' || action === 'revise') && method === 'POST') {
        const b = await readJson(req);
        const spec = action === 'make'
          ? lib.slotJobSpec(client, { entity: entityId, slot, make: b.make, feedback: b.feedback, count: b.count, params: b.params, note: b.note })
          : lib.reviseJobSpec(client, { entity: entityId, slot, feedback: b.feedback, version: b.version, count: b.count, references: b.references });
        const job = submit(client, { ...spec, labels: { ...spec.labels, by: client.name }, priority: b.priority, reuse: b.reuse ?? false } as JobSpec);
        return send(res, 200, job);
      }
    }

    // --------------------------------------------------------------- assets
    if (route === '/v1/assets' && method === 'GET') {
      if (q('project') && !canProject(client, q('project')!)) throw new GenError('No access to that project', { status: 403 });
      return send(res, 200, listAssets({ project: q('project'), kind: q('kind'), tool: q('tool'), text: q('q'), job: q('job'), starred: q('starred') === '1', limit: Number(q('limit')) || 60, offset: Number(q('offset')) || 0, projects: client.projects }));
    }
    m = /^\/v1\/(assets|files)\/(a_[0-9a-f]+)$/.exec(route);
    if (m) {
      const a = getAsset(m[2]);
      if (!a || !canProject(client, a.project)) throw new GenError('No such asset', { status: 404 });
      if (m[1] === 'files' && method === 'GET') {
        // Not on this disk (a new server): from S3, the first time it's asked for.
        if (!fs.existsSync(a.path) && !(await storage.ensureLocal(a))) throw new GenError(`${a.id}'s file is missing here and not in the library's S3 bucket`, { status: 404 });
        const name = `${a.project}-${a.tool}-${a.id}${path.extname(a.path)}`;
        return serveFile(req, res, a.path, a.mime, q('download') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {});
      }
      if (method === 'GET') return send(res, 200, a);
      if (method === 'PATCH') return send(res, 200, updateAsset(a.id, await readJson(req)));
      if (method === 'DELETE') {
        requireRole(client, 'admin');
        return send(res, 200, { deleted: deleteAsset(a.id) });
      }
    }
    if (route === '/v1/blobs' && method === 'POST') {
      const data = await readBody(req, 2 * 1024 * 1024 * 1024);
      if (!data.length) throw new GenError('Send the file as the request body');
      const ext = path.extname(String(req.headers['x-filename'] ?? '')).toLowerCase().replace(/[^.a-z0-9]/g, '');
      return send(res, 200, { blob: `blob:${putBlob(data, ext)}`, bytes: data.length });
    }
    // The library's files in S3 (src/storage.ts): what's backed up, back up the rest, bring missing files back.
    if (route === '/v1/storage' && method === 'GET') return send(res, 200, storage.status());
    if (route === '/v1/storage/backfill' && method === 'POST') {
      requireRole(client, 'admin');
      if (!storage.bucket()) throw new GenError('No bucket: set settings.storage.bucket (or HAWKESGEN_LIBRARY_BUCKET) first', { status: 409 });
      const added = storage.backfill();
      return send(res, 200, { ...storage.status(), added });
    }
    if (route === '/v1/storage/restore' && method === 'POST') {
      requireRole(client, 'admin');
      if (!storage.bucket()) throw new GenError('No bucket set', { status: 409 });
      return send(res, 200, await storage.restoreAll());
    }
    if (route === '/v1/estimate' && method === 'POST') {
      // What a batch would cost before anyone pays for it (src/estimate.ts).
      const body = await readJson(req);
      const project = String(body.project ?? '');
      if (!canProject(client, project)) throw new GenError(`No access to project ${project}`, { status: 403 });
      let running = 0;
      try {
        running = (await fleet.comfyEndpoints()).length;
      } catch {}
      return send(res, 200, estimate(project, body.items, { servers: body.servers, running }));
    }
    if (route === '/v1/recipes/check' && method === 'POST') {
      // Is there an asset made from exactly this tool version, params and inputs (any seed)?
      const body = await readJson(req);
      const t = getTool(body.tool);
      if (!t) throw new GenError(`Unknown tool: ${body.tool}`, { status: 404 });
      const params = validateParams(t, body.params ?? {});
      const inputs: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries<any>(body.inputs ?? {})) {
        const one = async (ref: string) => {
          if (ref.startsWith('blob:')) return ref.slice(5);
          if (ref.startsWith('asset:')) return getAsset(ref.slice(6))?.sha256 ?? 'missing';
          return sha256File(ref);
        };
        inputs[k] = Array.isArray(v) ? await Promise.all(v.map(one)) : await one(v);
      }
      const key = recipeKey({ tool: t.id, version: t.version, params, inputs, models: t.models?.(params) });
      const asset = findByRecipe(key, body.project);
      return send(res, 200, { status: asset ? 'current' : 'missing', key, asset });
    }

    // ---------------------------------------------------------------- fleet
    if (route === '/v1/fleet' && method === 'GET') {
      let servers: any[] = [];
      let error: string | null = null;
      try {
        servers = await fleet.fleetStatus();
      } catch (e: any) {
        error = e.message;
      }
      if (Date.now() - account.at > 5 * 60 * 1000 && !error) {
        account = { at: Date.now(), value: await fleet.checkAccount().catch((e) => ({ error: e.message })) };
      }
      const busy = Object.fromEntries([...queue.busy.entries()]);
      return send(res, 200, {
        servers, error, settings: { ...loadSettings().fleet, max: FLEET_MAX }, retry: retry.state, lastFailure, account: account.value,
        busy, autoStart: queue.autoStartState(), families: Object.fromEntries(queue.families), types: fleet.TYPES, regions: fleet.REGIONS, defaultType: fleet.DEFAULT_TYPE, diskPerMonth: fleet.DISK_PER_MONTH,
      });
    }
    if (route === '/v1/fleet/settings' && method === 'POST') {
      requireRole(client, 'admin');
      const body = await readJson(req);
      const s = saveSettings({ fleet: { ...loadSettings().fleet, ...body } });
      queue.pump();
      return send(res, 200, { ok: true, settings: s.fleet });
    }
    // The machine image new servers launch from (src/providers/comfy/image.ts).
    if (route === '/v1/fleet/image' && method === 'GET') return send(res, 200, await fleetImage.imageStatus());
    m = /^\/v1\/fleet\/image\/(build|prune|cancel)$/.exec(route);
    if (m && method === 'POST') {
      const body = await readJson(req);
      // Building launches or starts a server and stores an image; pruning deletes images. Both are the owner's, confirmed.
      requireRole(client, m[1] === 'cancel' ? 'admin' : 'owner');
      if (m[1] === 'cancel') return send(res, 200, { ok: true, build: fleetImage.cancelImageBuild() });
      if (m[1] === 'prune' && body.dryRun === true) return send(res, 200, { ok: true, dryRun: true, removed: await fleetImage.pruneImages({ dryRun: true }) });
      if (body.confirm !== true) throw new GenError(`image ${m[1]} needs { "confirm": true }`);
      if (m[1] === 'prune') return send(res, 200, { ok: true, removed: await fleetImage.pruneImages() });
      const from = typeof body.from === 'string' && /^i-[0-9a-f]+$/.test(body.from) ? body.from : undefined;
      return send(res, 200, { ok: true, build: await fleetImage.startImageBuild({ from, region: typeof body.region === 'string' ? body.region : undefined, asIs: body.asIs === true }) });
    }
    if (route === '/v1/fleet/regions' && method === 'GET') return send(res, 200, { regions: await fleet.regionsInfo({ force: q('refresh') === '1' }) });
    if (route === '/v1/fleet/capacity' && method === 'GET') return send(res, 200, { scores: await fleet.capacityScores(Object.keys(fleet.TYPES)) });
    if (route === '/v1/fleet/health' && method === 'GET') return send(res, 200, await fleet.serverHealth(q('id')));
    if (route === '/v1/fleet/log' && method === 'GET') return send(res, 200, { log: await fleet.serverLog(Number(q('lines')) || 40, q('id')) });
    if (route === '/v1/fleet/quota' && method === 'GET') return send(res, 200, await fleet.quotaStatus(q('region') || 'us-east-1'));
    if (route === '/v1/fleet/quota' && method === 'POST') {
      requireRole(client, 'owner');
      const { region, value } = await readJson(req);
      return send(res, 200, { ok: true, ...(await fleet.requestQuota(region, value)) });
    }
    // --------------------------------------------------------- build server
    if (route === '/v1/builder' && method === 'GET') return send(res, 200, await builder.builderStatus());
    m = /^\/v1\/builder\/(launch|start|stop|terminate|access|rdp|idle|ssh|github)$/.exec(route);
    if (m && method === 'POST') {
      const act = m[1];
      const body = await readJson(req);
      const costly = ['launch', 'start', 'terminate', 'ssh'].includes(act);
      requireRole(client, costly || act === 'rdp' ? 'owner' : 'admin');
      if (costly && body.confirm !== true) throw new GenError(`${act} needs { "confirm": true }`);
      if (act === 'launch') return send(res, 200, { ok: true, ...(await builder.launchBuilder({ type: body.type || undefined, region: body.region || undefined, idleMinutes: Number(body.idleMinutes) || 30, unity: body.unity || undefined })) });
      if (act === 'start') return send(res, 200, { ok: true, ...(await builder.startBuilder()) });
      if (act === 'stop') return send(res, 200, { ok: true, ...(await builder.stopBuilder()) });
      if (act === 'terminate') return send(res, 200, { ok: true, ...(await builder.terminateBuilder()) });
      if (act === 'access') return send(res, 200, { ok: true, ...(await builder.builderAccess()) });
      if (act === 'github') return send(res, 200, { ok: true, keys: await builder.builderGitHubAccess(Array.isArray(body.repos) && body.repos.length ? body.repos.map(String) : ['jgriffith3433/sickofitgame-unity', 'jgriffith3433/YoobaLand']) });
      if (act === 'rdp') return send(res, 200, { ok: true, ...(await builder.builderRdp()) });
      if (act === 'idle') return send(res, 200, { ok: true, ...(await builder.setBuilderIdle(Number(body.minutes))) });
      if (act === 'ssh') return send(res, 200, { ok: true, output: await builder.ssh(String(body.command ?? ''), { timeoutMs: Math.min(600_000, Number(body.timeoutMs) || 120_000) }) });
    }

    // ------------------------------------------------- playtester (T4 GPU)
    if (route === '/v1/playtester' && method === 'GET') return send(res, 200, await playtester.playtesterStatus());
    m = /^\/v1\/playtester\/(launch|start|ensure|stop|terminate|access|idle|ssh)$/.exec(route);
    if (m && method === 'POST') {
      const act = m[1];
      const body = await readJson(req);
      const costly = ['launch', 'start', 'ensure', 'terminate', 'ssh'].includes(act);
      requireRole(client, costly ? 'owner' : 'admin');
      if (costly && body.confirm !== true) throw new GenError(`${act} needs { "confirm": true }`);
      if (act === 'launch') return send(res, 200, { ok: true, ...(await playtester.launchPlaytester({ type: body.type || undefined, region: body.region || undefined, idleMinutes: Number(body.idleMinutes) || 20 })) });
      if (act === 'start') return send(res, 200, { ok: true, ...(await playtester.startPlaytester()) });
      if (act === 'ensure') return send(res, 200, { ok: true, ...(await playtester.ensurePlaytester()) });
      if (act === 'stop') {
        // ifIdle: leave it running while a playtest is still using it (its idle stop follows).
        if (body.ifIdle && listJobs({ status: 'running', limit: 500 }).some((j) => j.tool === 'playtest.run')) return send(res, 200, { ok: true, skipped: 'a playtest is still running; it stops itself when idle' });
        return send(res, 200, { ok: true, ...(await playtester.stopPlaytester()) });
      }
      if (act === 'terminate') return send(res, 200, { ok: true, ...(await playtester.terminatePlaytester()) });
      if (act === 'access') return send(res, 200, { ok: true, ...(await playtester.playtesterAccess()) });
      if (act === 'idle') return send(res, 200, { ok: true, ...(await playtester.setPlaytesterIdle(Number(body.minutes))) });
      if (act === 'ssh') return send(res, 200, { ok: true, output: await playtester.ssh(String(body.command ?? ''), { timeoutMs: Math.min(600_000, Number(body.timeoutMs) || 120_000) }) });
    }

    m = /^\/v1\/fleet\/(launch|start|stop|terminate|access|scale|stop-all|sync|fix|retry-stop|adopt)$/.exec(route);
    if (m && method === 'POST') {
      const act = m[1];
      const body = await readJson(req);
      // Anything that costs money, deletes a server or changes one is the owner's, and must be confirmed.
      const costly = ['launch', 'start', 'terminate', 'scale', 'sync', 'fix', 'adopt'].includes(act);
      requireRole(client, costly ? 'owner' : 'admin');
      if (costly && body.confirm !== true) throw new GenError(`${act} needs { "confirm": true }`);
      const instanceId = typeof body.id === 'string' && /^i-[0-9a-f]+$/.test(body.id) ? body.id : undefined;
      const s = loadSettings().fleet;
      const opts = {
        idleMinutes: Math.max(10, Math.min(240, Number(body.idleMinutes) || s.idleMinutes)),
        region: typeof body.region === 'string' ? body.region : 'auto',
        type: body.type === 'auto' || fleet.TYPES[body.type] ? body.type : fleet.DEFAULT_TYPE,
        max: s.servers,
        fallbackLaunch: body.fallbackLaunch === true,
      };
      if ((act === 'launch' || act === 'start') && body.keepTrying) {
        lastFailure = null;
        return send(res, 200, { ok: true, retry: retry.start({ action: act, opts, minutes: Number(body.keepTrying.minutes) || 60, every: Number(body.keepTrying.every) || 180 }) });
      }
      try {
        if (act === 'launch') return send(res, 200, { ok: true, ...(await fleet.launchServer(opts)) });
        if (act === 'start') {
          // Nothing to start (disposable servers are terminated when idle): with the image, launch one instead (ready in minutes).
          const startable = (await fleet.listServers()).some((f) => ['stopped', 'running', 'pending'].includes(f.instance.State?.Name) && !fleet.serverRecord(f.instance.InstanceId).imageSource);
          if (!instanceId && !startable && (await fleet.imageAvailable())) return send(res, 200, { ok: true, launched: true, ...(await fleet.launchServer(opts)) });
          return send(res, 200, { ok: true, ...(await fleet.startServer(instanceId)) });
        }
        if (act === 'stop') return send(res, 200, { ok: true, ...(await fleet.stopServer(instanceId)) });
        if (act === 'terminate') return send(res, 200, { ok: true, ...(await fleet.terminateServer(instanceId)) });
        if (act === 'access') return send(res, 200, { ok: true, ...(await fleet.refreshAccess()) });
        if (act === 'fix') return send(res, 200, { ok: true, health: await fleet.fixServer(instanceId) });
        if (act === 'retry-stop') {
          retry.stop();
          return send(res, 200, { ok: true });
        }
        if (act === 'adopt') {
          // Takes over servers another project launched, with their tokens and SSH keys.
          const from = String(body.from ?? '');
          if (!from || !fs.existsSync(path.join(from, 'server.json'))) throw new GenError('adopt needs { "from": "<folder with server.json and the .pem keys>" }');
          return send(res, 200, { ok: true, ...fleet.adoptState(from) });
        }
        if (act === 'sync') {
          const families = Array.isArray(body.families) ? body.families.map(String) : undefined;
          return send(res, 200, { ok: true, ...(await fleet.syncServer(instanceId, { families })) });
        }
        if (act === 'stop-all') {
          const stopped: string[] = [];
          for (const st of (await fleet.fleetStatus()).filter((x) => ['running', 'pending'].includes(x.state!))) {
            await fleet.stopServer(st.id);
            stopped.push(st.id!);
          }
          retry.stop();
          return send(res, 200, { ok: true, stopped });
        }
        if (act === 'scale') {
          const count = Math.max(1, Math.min(s.servers, Math.round(Number(body.count) || s.servers)));
          const all = await fleet.fleetStatus();
          const up = all.filter((st) => ['running', 'pending'].includes(st.state!)).length;
          const started: string[] = [];
          const failed: any[] = [];
          for (const st of all.filter((x) => x.state === 'stopped' && !x.imageSource && !x.purpose).slice(0, Math.max(0, count - up))) {
            try {
              await fleet.startServer(st.id);
              started.push(st.id!);
            } catch (e: any) {
              failed.push({ id: st.id, region: st.region, message: e.message, kind: e.kind ?? 'other' });
            }
          }
          // Disposable servers aren't kept stopped: with the image, the rest are launched from it (ready in minutes).
          if (up + started.length < count && (await fleet.imageAvailable())) {
            for (let k = up + started.length; k < count; k++) {
              try {
                const r = await fleet.launchServer(opts);
                started.push(r.id);
              } catch (e: any) {
                failed.push({ region: e.attempts?.at(-1)?.region, message: e.message, kind: e.kind ?? 'other' });
                break;
              }
            }
          }
          return send(res, 200, { ok: true, started, failed, running: up + started.length, short: Math.max(0, count - up - started.length) });
        }
      } catch (e) {
        fleetFail(e);
      }
    }

    // -------------------------------------------------------------- presets
    if (route === '/v1/presets' && method === 'GET') return send(res, 200, { projects: listPresets().filter((p) => canProject(client, p.project)) });
    m = /^\/v1\/presets\/([\w.-]+)$/.exec(route);
    if (m) {
      if (!canProject(client, m[1])) throw new GenError('No access to that project', { status: 403 });
      if (method === 'GET') {
        const p = getProjectPresets(m[1]);
        if (!p) throw new GenError(`No presets for ${m[1]}`, { status: 404 });
        return send(res, 200, p);
      }
      if (method === 'PUT') {
        requireRole(client, 'admin');
        const body = await readJson(req);
        return send(res, 200, saveProjectPresets({ ...body, project: m[1] }));
      }
    }

    // ------------------------------------------------------------ workflows
    if (route === '/v1/workflows' && method === 'GET') {
      return send(res, 200, { workflows: listWorkflows().map((w) => ({ ...w.manifest, folder: path.basename(w.dir) })) });
    }
    if (route === '/v1/workflows/import' && method === 'POST') {
      requireRole(client, 'owner');
      const body = await readJson(req);
      const r = await importWorkflow({ template: body.template, workflow: body.workflow, id: String(body.id ?? ''), title: body.title, description: body.description, family: body.family, overwrite: body.overwrite === true });
      reloadTools();
      return send(res, 200, r);
    }
    if (route === '/v1/workflows/reload' && method === 'POST') {
      requireRole(client, 'admin');
      return send(res, 200, { tools: reloadTools().length });
    }
    m = /^\/v1\/workflows\/([\w.-]+)$/.exec(route);
    if (m) {
      const w = getWorkflow(m[1]);
      if (!w) throw new GenError(`No workflow tool ${m[1]}`, { status: 404 });
      if (method === 'GET') {
        const info = await objectInfo().catch(() => ({}));
        return send(res, 200, { manifest: w.manifest, graph: w.graph, folder: path.basename(w.dir), check: Object.keys(info).length ? checkGraph(w.graph, info) : null });
      }
      if (method === 'PUT') {
        requireRole(client, 'owner');
        const { manifest } = await readJson(req);
        if (!manifest || manifest.id !== w.manifest.id) throw new GenError('Send { manifest } with the same id');
        saveWorkflow(path.basename(w.dir), manifest, w.graph);
        reloadTools();
        return send(res, 200, { ok: true, manifest });
      }
      if (method === 'DELETE') {
        requireRole(client, 'owner');
        if ((await readJson(req)).confirm !== true) throw new GenError('delete needs { "confirm": true }');
        fs.rmSync(w.dir, { recursive: true, force: true });
        reloadTools();
        return send(res, 200, { ok: true });
      }
    }
    if (route === '/v1/comfy/templates' && method === 'GET') {
      const text = (q('q') ?? '').toLowerCase();
      const list = templates().filter((t) => !text || `${t.name} ${t.title} ${t.description} ${t.tags.join(' ')} ${t.category}`.toLowerCase().includes(text));
      return send(res, 200, { templates: list });
    }
    if (route === '/v1/comfy/refresh' && method === 'POST') {
      requireRole(client, 'admin');
      return send(res, 200, await refreshCatalog());
    }
    m = /^\/v1\/comfy\/templates\/([\w.-]+)(\/thumb)?$/.exec(route);
    if (m && method === 'GET') {
      if (m[2]) {
        const f = await templateThumb(m[1]);
        if (!f) return send(res, 404, { error: 'No thumbnail' });
        return serveFile(req, res, f, mimeOf(f), { 'Cache-Control': 'max-age=86400' });
      }
      // A dry run of the import: the converted graph, the draft manifest and any problems.
      const info = await objectInfo();
      const conv = convertUiWorkflow(await templateWorkflow(m[1]), info);
      const check = checkGraph(conv.graph, info);
      const t = templates().find((x) => x.name === m![1]);
      return send(res, 200, { template: t, problems: [...conv.problems, ...check.problems], models: conv.models, draft: draftManifest(`draft.${m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, t?.title ?? m[1], t?.description ?? '', conv.graph, conv.models, info) });
    }
    if (route === '/v1/fleet/models' && method === 'GET') {
      const instanceId = q('id');
      if (!instanceId) throw new GenError('Give ?id=<server id>');
      const have = await fleet.serverModels(instanceId, { force: q('refresh') === '1' });
      const usedBy = new Map<string, string[]>();
      for (const t of TOOLS) for (const mm of t.workflow?.models ?? []) usedBy.set(`${mm.dir}/${mm.file}`, [...(usedBy.get(`${mm.dir}/${mm.file}`) ?? []), t.id]);
      const core = new Set(fleet.loadManifest().models.map((mm) => `${mm.dir}/${mm.file}`));
      return send(res, 200, { free: have.free, models: [...have.files.entries()].map(([file, bytes]) => ({ file, bytes, core: core.has(file), usedBy: usedBy.get(file) ?? [] })).sort((a, b) => b.bytes - a.bytes) });
    }
    if (route === '/v1/fleet/models/install' && method === 'POST') {
      requireRole(client, 'owner');
      const body = await readJson(req);
      if (body.confirm !== true) throw new GenError('install needs { "confirm": true }');
      const t = getTool(String(body.tool ?? ''));
      if (!t?.workflow) throw new GenError('Give a workflow tool whose models to install');
      return send(res, 200, { installed: await fleet.installModels(String(body.id), t.workflow.models) });
    }
    if (route === '/v1/fleet/models/prune' && method === 'POST') {
      requireRole(client, 'owner');
      const body = await readJson(req);
      if (body.confirm !== true) throw new GenError('prune needs { "confirm": true }');
      if (!Array.isArray(body.files) || !body.files.length) throw new GenError('Give the model files to remove ("dir/file")');
      return send(res, 200, { removed: await fleet.pruneModels(String(body.id), body.files.map(String)) });
    }

    // ------------------------------------------------------- usage, providers
    if (route === '/v1/usage' && method === 'GET') {
      const since = q('since') ? Number(q('since')) : Date.now() - 30 * 24 * 3600 * 1000;
      return send(res, 200, usageSummary({ since, by: (q('by') as any) ?? 'project' }));
    }
    if (route === '/v1/providers/elevenlabs/voices' && method === 'GET') return send(res, 200, { voices: await eleven.voices({ force: q('refresh') === '1' }) });
    if (route === '/v1/providers/anthropic/models' && method === 'GET') return send(res, 200, { models: claude.MODELS, default: claude.DEFAULT_MODEL });

    // ------------------------------------------------------ settings, clients
    if (route === '/v1/settings' && method === 'GET') return send(res, 200, loadSettings());
    if (route === '/v1/settings' && method === 'POST') {
      requireRole(client, 'owner');
      return send(res, 200, saveSettings(await readJson(req)));
    }
    if (route === '/v1/clients' && method === 'GET') {
      requireRole(client, 'owner');
      return send(res, 200, { clients: listClients() });
    }
    if (route === '/v1/clients' && method === 'POST') {
      requireRole(client, 'owner');
      const { name, role, projects } = await readJson(req);
      if (!String(name ?? '').trim()) throw new GenError('A client needs a name');
      return send(res, 200, createClient(String(name).trim(), role ?? 'user', Array.isArray(projects) && projects.length ? projects.map(String) : ['*']));
    }
    m = /^\/v1\/clients\/(c_[0-9a-f]+)\/(disable|enable)$/.exec(route);
    if (m && method === 'POST') {
      requireRole(client, 'owner');
      setClientDisabled(m[1], m[2] === 'disable');
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: `No route ${method} ${route}` });
  } catch (e: any) {
    if (e instanceof GenError) return send(res, e.status, { error: e.message, kind: e.kind, attempts: e.attempts });
    console.error(`[api] ${method} ${route}:`, e);
    return send(res, 500, { error: e.message ?? String(e) });
  }
}
