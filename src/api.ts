// The HTTP API (JSON, under /v1) and the dashboard (static files at /).
// docs/api.md lists every route with examples.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { paths, loadSettings, saveSettings, FLEET_MAX, env } from './config.ts';
import { authenticate, canProject, dashboardClient, KEY_COOKIE, fixedProject, requireRole, createClient, listClients, setClientDisabled, type Client } from './auth.ts';
import { DASH_COOKIE, DASH_DAYS, googleClientId, signSession, verifyGoogle } from './dashauth.ts';
import { TOOLS, getTool, describeTool, reloadTools } from './tools/index.ts';
import { listWorkflows, getWorkflow, saveWorkflow, draftManifest } from './workflows/registry.ts';
import { objectInfo, refreshCatalog, templates, templateWorkflow, templateThumb, importWorkflow } from './workflows/catalog.ts';
import { convertUiWorkflow, checkGraph } from './workflows/convert.ts';
import { validateParams } from './tools/validate.ts';
import { estimate } from './estimate.ts';
import { shotList, shotSource } from './tools/liveShots.ts';
import { liveSnapshot, liveFrame, isLive } from './tools/livePlay.ts';
import { submit, getJob, listJobs, cancel, rerun, boostLabel, clearFinished, jobTimings, events, summary, queue, queuePosition, type JobSpec } from './jobs.ts';
import { getAsset, listAssets, updateAsset, deleteAsset, putBlob, blobPath, putAsset, findByRecipe, recipeKey } from './library.ts';
import { motionRecord, motionsForQuery, searchMotions, allClips } from './motions.ts';
import * as lib from './entities.ts';
import * as storage from './storage.ts';
import { lodSummary, lodSummaries, pickLod, queueLods, backfillLods, pruneLods, lodStatus } from './lod.ts';
import { usageSummary } from './usage.ts';
import { listPresets, getProjectPresets, saveProjectPresets } from './presets.ts';
import * as fleet from './providers/comfy/fleet.ts';
import * as fleetImage from './providers/comfy/image.ts';
import * as builder from './providers/builder/builder.ts';
import { requesterIp } from './providers/builder/rdp.ts';
import * as cloudrun from './providers/builder/cloudrun.ts';
import * as cloudCache from './providers/builder/cache.ts';
import { cpuStatus } from './providers/cloudrun/cpu.ts';
import * as playtester from './providers/playtester/playtester.ts';
import * as machines from './machines.ts';
import * as games from './games.ts';
import * as billing from './billing.ts';
import { listTemplates, getTemplate } from './templates.ts';
import * as assistant from './assistant.ts';
import { Retry } from './providers/comfy/retry.ts';
import * as eleven from './providers/elevenlabs.ts';
import { AUDIO_MODELS, REFUSED_MODELS } from './audio/registry.ts';
import * as claude from './providers/anthropic.ts';
import { configured as xaiConfigured } from './providers/xai.ts';
import { GenError, sha256File, mimeOf, extOf } from './util.ts';
import { db } from './db.ts';
import { handleMcp } from './mcp-http.ts';
import { handleCollect } from './analytics/collect.ts';
import { noteRoute, lagReport } from './lag.ts';
import { handleAnalytics } from './analytics/routes.ts';
import { handleNetBridge } from './netbridge.ts';
import {
  authenticateRequest,
  isPublicSaas,
  signupUser,
  loginUser,
  deleteSession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
  getUserForClient,
  getUserProfile,
  rotateUserApiKey,
} from './users.ts';
import {
  listCreditPacks,
  quoteJobCredits,
  createStripeCheckoutSession,
  handleStripeWebhook,
  getUserLedger,
  isInternalOnlyTool,
  getStripeStatus,
  saveStripeConfig,
} from './billing.ts';
import { getPortfolio } from './portfolio.ts';

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

const cdnField = (sha: string) => { const cdn = storage.cdnUrl(sha); return cdn ? { cdn } : {}; };

/** A library list with each asset's levels of detail inline (src/lod.ts), so callers need no request per asset. */
function withLods<T extends { items: any[] }>(list: T): T {
  const lods = lodSummaries(list.items.map((a) => a.id));
  return { ...list, items: list.items.map((a) => ({ ...a, inS3: storage.inS3(a.sha256), ...cdnField(a.sha256), ...(lods[a.id] ? { lods: lods[a.id] } : {}) })) };
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

/**
 * A live playtest's video (tools/livePlay.ts): the newest frame of a player once, or as an MJPEG stream at about `fps`
 * (1 to 15) frames a second, only new frames, never more than about 2 MB waiting for a slow viewer. The stream ends
 * with the run, when the viewer goes, or after an hour.
 */
function liveVideo(req: IncomingMessage, res: ServerResponse, job: string, kind: string, player: number, fps: number) {
  const read = () => {
    const f = liveFrame(job, Math.max(0, Math.min(3, player)));
    if (!f) return null;
    if ('jpeg' in f) return f;
    try {
      return { jpeg: fs.readFileSync(f.file), at: fs.statSync(f.file).mtimeMs };
    } catch {
      return null;
    }
  };
  if (kind === 'frame') {
    const f = read();
    if (!f) throw new GenError('No frame yet', { status: 404 });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': f.jpeg.length, 'Cache-Control': 'no-store' });
    return void res.end(f.jpeg);
  }
  const rate = Math.max(1, Math.min(15, fps));
  const B = 'hawkesframe';
  res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${B}`, 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  let last = -1;
  let closed = false;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (closed) return;
    if (!isLive(job) || Date.now() - started > 3_600_000) return void res.end();
    const f = read();
    if (f && f.at !== last && res.writableLength < 2_000_000) {
      last = f.at;
      res.write(`--${B}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.jpeg.length}\r\n\r\n`);
      res.write(f.jpeg);
      res.write('\r\n');
    }
    timer = setTimeout(tick, 1000 / rate);
  };
  req.on('close', () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
  tick();
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

let sdkCache: { mtime: number; body: Buffer; etag: string } | null = null;
function analyticsSdk() {
  const file = path.join(paths.server, '..', 'clients', 'js', 'hawkes-analytics.js');
  const mtime = fs.statSync(file).mtimeMs;
  if (sdkCache?.mtime !== mtime) {
    const body = fs.readFileSync(file);
    sdkCache = { mtime, body, etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 20)}"` };
  }
  return sdkCache;
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const method = req.method ?? 'GET';
  noteRoute(method, route);

  // Player analytics from every product's pages: public, with its own CORS for the registered origins (src/analytics/).
  if (route === '/v1/analytics/collect') return handleCollect(req, res);
  // ...and from a site's own server passing on pages that can't send themselves (a Gen key; collect.ts relayed).
  if (route === '/v1/analytics/relay' && method === 'POST') return handleCollect(req, res, { relay: true });
  // Hawkes Net runs on its own box (net/, docs/net.md): Gen checks keys for it, files its usage and sends the rest there.
  if (route.startsWith('/v1/net/') || route.startsWith('/sdk/net') || route.startsWith('/sdk/hawkes-net')) return handleNetBridge(req, res, route);

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

  // The analytics SDK (clients/js/hawkes-analytics.js, docs/analytics.md): public, cached, revalidated by ETag.
  // @1 is the major version pages pin; plain analytics.js follows the newest and is cached for less.
  const sdkFile = /^\/sdk\/analytics(@1)?\.js$/.exec(route);
  if (sdkFile && (method === 'GET' || method === 'HEAD')) {
    const sdk = analyticsSdk();
    const headers = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': sdkFile[1] ? 'public, max-age=3600, stale-while-revalidate=86400' : 'public, max-age=300, stale-while-revalidate=86400', ETag: sdk.etag, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
    if (req.headers['if-none-match'] === sdk.etag) return void res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, 'Content-Length': sdk.body.length });
    return void res.end(method === 'HEAD' ? undefined : sdk.body);
  }

  // Dashboard and customer-facing SaaS web app.
  if (!route.startsWith('/v1/')) {
    const publicSaas = isPublicSaas(req);
    let rel: string;
    if (route === '/home' || route === '/home/' || route === '/public' || route === '/public/') {
      rel = 'public/landing.html';
    } else if (route === '/app' || route === '/app/') {
      rel = 'public/game-editor.html';
    } else if (route === '/play' || route === '/play/') {
      rel = 'public/player.html';
    } else if (route === '/admin' || route === '/admin/') {
      rel = 'index.html';
    } else if (route === '/') {
      rel = publicSaas ? 'public/landing.html' : 'index.html';
    } else {
      rel = route.slice(1);
    }
    const file = path.join(paths.dashboard, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(paths.dashboard) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': STATIC[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return void fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // Which SDK each caller runs (X-Hawkes-Client: js/6, py/6, unity/0.2.1): /v1/health lists the ones behind.
  noteClient(req);

  try {
    if (route === '/v1/health') {
      return send(res, 200, {
        ok: true, name: 'hawkesgen', version: VERSION,
        providers: {
          aws: (() => { try { fleet.awsConfig(); return true; } catch { return false; } })(),
          elevenlabs: eleven.configured() && !eleven.billingState().blocked,
          anthropic: claude.configured(),
          claude: claude.backend(),
          xai: xaiConfigured(),
          brain: loadSettings().brain,
          python: fs.existsSync(path.join(paths.post, '..', '.venv')),
        },
        elevenlabsBilling: eleven.billingState(),
        queue: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status").all() as any[]).map((r) => [r.status, r.n])),
        // Unity builds and tests on the build server: the one kind of job a restart of Gen would leave half done
        // (the deploy script waits for these only; everything else resumes after a restart).
        building: (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND tool IN ('unity.build', 'unity.test')").get() as any).n,
        client: { current: SDK_CURRENT, min: SDK_MIN, behind: [...clientsSeen.values()].filter((c) => c.behind) },
        // Event-loop lag: the worst delay seen and the recent blocks over 500 ms, with the requests around them.
        loop: lagReport(),
      });
    }

    // --------------------------------------------------- public SaaS routes
    if (route === '/v1/portfolio' && method === 'GET') {
      return send(res, 200, getPortfolio());
    }
    if (route === '/v1/billing/packs' && method === 'GET') {
      const st = getStripeStatus();
      return send(res, 200, {
        packs: listCreditPacks(),
        stripe: { configured: st.configured, publishableKey: st.publishableKey, mode: st.mode },
      });
    }
    if (route === '/v1/motions' && method === 'GET') {
      const queryText = q('q') ?? '';
      const packFilter = q('pack') ?? '';
      const tagFilter = q('tag') ?? '';
      const limit = Math.max(1, Math.min(200, Number(q('limit')) || 120));
      const offset = Math.max(0, Number(q('offset')) || 0);
      const searched = searchMotions(queryText, { limit: 200, offset: 0 });
      const filtered = searched.items.filter((it) => {
        if (packFilter && it.meta?.pack !== packFilter) return false;
        if (tagFilter && !it.tags?.includes(tagFilter)) return false;
        return true;
      });
      const clips = allClips().filter((c) => {
        if (packFilter && c.pack !== packFilter) return false;
        if (tagFilter && !c.tags.includes(tagFilter)) return false;
        if (queryText) {
          const words = queryText.toLowerCase().split(/\s+/).filter(Boolean);
          const hay = `${c.pack} ${c.packTitle} ${c.name} ${c.tags.join(' ')}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      });
      return send(res, 200, {
        items: filtered.slice(offset, offset + limit),
        clips: clips.slice(offset, offset + limit),
        total: filtered.length,
      });
    }
    if (route === '/v1/billing/webhook' && method === 'POST') {
      const rawBody = await readBody(req);
      const sig = String(req.headers['stripe-signature'] ?? '');
      return send(res, 200, handleStripeWebhook(rawBody, sig));
    }
    if (route === '/v1/users/signup' && method === 'POST') {
      const body = await readJson(req);
      const result = signupUser(body);
      setSessionCookie(res, req, result.sessionToken);
      return send(res, 200, { user: result.user, apiKey: result.apiKey });
    }
    if (route === '/v1/users/login' && method === 'POST') {
      const body = await readJson(req);
      const result = loginUser(body);
      setSessionCookie(res, req, result.sessionToken);
      return send(res, 200, { user: result.user });
    }
    if (route === '/v1/users/logout' && method === 'POST') {
      deleteSession(getSessionToken(req));
      clearSessionCookie(res, req);
      return send(res, 200, { ok: true });
    }

    // The dashboard's sign-in: an owner or admin key, kept in an HttpOnly cookie (auth.ts KEY_COOKIE) for 30 days.
    if (route === '/v1/dashboard/signin' && method === 'POST') {
      const { key } = await readJson(req);
      const who = dashboardClient(String(key ?? ''));
      if (!who) return send(res, 401, { error: 'That key isn\'t an owner or admin key of this Gen.' });
      const secure = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https' || process.env.K_SERVICE ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${KEY_COOKIE}=${encodeURIComponent(String(key).trim())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secure}`);
      return send(res, 200, { name: who.name, role: who.role });
    }
    if (route === '/v1/dashboard/signout' && method === 'POST') {
      res.setHeader('Set-Cookie', [`${KEY_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, `${DASH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`]);
      return send(res, 200, { ok: true });
    }
    // "Continue with Google" (dashauth.ts): the client id for the button, then the ID token Google gave the page.
    if (route === '/v1/dashboard/google' && method === 'GET') return send(res, 200, { clientId: googleClientId() });
    if (route === '/v1/dashboard/google' && method === 'POST') {
      const { credential } = await readJson(req);
      let email: string;
      try { email = await verifyGoogle(String(credential ?? '')); } catch (e: any) { return send(res, 401, { error: e.message }); }
      const secure = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https' || process.env.K_SERVICE ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${DASH_COOKIE}=${signSession(email)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASH_DAYS * 86400}${secure}`);
      return send(res, 200, { email });
    }
    // The GPU workers' storage broker (src/providers/gpu/broker.ts): the run token is the credential, not a Gen key.
    if (route === '/v1/gpu/broker') {
      const { handleBroker } = await import('./providers/gpu/brokerRoute.ts');
      return handleBroker(req, res, url);
    }

    const client = authenticateRequest(req);
    if (!client) return send(res, 401, { error: 'Send an API key (Authorization: Bearer hg_...) or sign in' });

    if (route === '/v1/me') return send(res, 200, client);

    // --------------------------------------------------- user & billing routes
    if (route === '/v1/users/me' && method === 'GET') {
      return send(res, 200, getUserProfile(client));
    }
    if (route === '/v1/users/api-key' && method === 'POST') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('User account required', { status: 403 });
      return send(res, 200, rotateUserApiKey(user.id));
    }
    if (route === '/v1/billing/quote' && method === 'POST') {
      const body = await readJson(req);
      const user = getUserForClient(client);
      const project = fixedProject(client) ?? String(body.project || 'sandbox');
      const qResult = quoteJobCredits({ project, tool: body.tool, preset: body.preset, params: body.params ?? {}, count: body.count });
      return send(res, 200, {
        ...qResult,
        userCredits: user ? user.credits : null,
        canAfford: user ? user.credits >= qResult.credits : true,
      });
    }
    if (route === '/v1/billing/checkout' && method === 'POST') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('Sign in with a user account to buy credits', { status: 403 });
      const body = await readJson(req);
      const checkout = await createStripeCheckoutSession(user, body, origin || 'https://gen.hawkesgen.ai');
      return send(res, 200, checkout);
    }
    if (route === '/v1/billing/ledger' && method === 'GET') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('User account required', { status: 403 });
      return send(res, 200, getUserLedger(user.id, Number(q('limit')) || 100));
    }
    if (route === '/v1/billing/config' && method === 'GET') {
      requireRole(client, 'owner');
      return send(res, 200, getStripeStatus());
    }
    if (route === '/v1/billing/config' && method === 'POST') {
      requireRole(client, 'owner');
      const body = await readJson(req);
      saveStripeConfig(body);
      return send(res, 200, getStripeStatus());
    }

    // ---------------------------------------------------------- subscriptions
    if (route === '/v1/subscriptions/plans' && method === 'GET') {
      return send(res, 200, { plans: billing.listSubscriptionPlans() });
    }
    if (route === '/v1/subscriptions/plans' && method === 'POST') {
      requireRole(client, 'owner');
      const body = await readJson(req);
      const plan = billing.createSubscriptionPlan(body);
      return send(res, 200, plan);
    }
    if (route === '/v1/subscriptions/me' && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Subscriptions are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const sub = billing.getUserSubscription(user.id);
      return send(res, 200, sub ? { subscription: sub } : { subscription: null });
    }

    // --------------------------------------------------------------- games
    if (route === '/v1/games' && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const body = await readJson(req);
      if (!body.name || !body.slug) throw new GenError('name and slug are required');
      const game = games.createGame(user.id, body);
      return send(res, 200, game);
    }
    if (route === '/v1/games' && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const result = games.listUserGames(user.id, { limit: Number(q('limit')) || 50, offset: Number(q('offset')) || 0 });
      return send(res, 200, result);
    }
    let m = /^\/v1\/games\/(game_[0-9a-z]+)$/.exec(route);
    if (m && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canAccessGame(game.id, user.id)) throw new GenError('No access to this game', { status: 403 });
      return send(res, 200, game);
    }
    if (m && method === 'PATCH') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.isGameOwner(game.id, user.id)) throw new GenError('Only the game owner can update settings', { status: 403 });
      const body = await readJson(req);
      const updated = games.updateGame(game.id, body);
      return send(res, 200, updated);
    }
    if (m && method === 'DELETE') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.isGameOwner(game.id, user.id)) throw new GenError('Only the game owner can delete the game', { status: 403 });
      games.deleteGame(game.id);
      return send(res, 200, { deleted: true });
    }
    m = /^\/v1\/games\/(game_[0-9a-z]+)\/members$/.exec(route);
    if (m && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canAccessGame(game.id, user.id)) throw new GenError('No access to this game', { status: 403 });
      const members = games.listGameMembers(game.id);
      return send(res, 200, { members });
    }
    if (m && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.isGameOwner(game.id, user.id)) throw new GenError('Only the game owner can invite members', { status: 403 });
      const body = await readJson(req);
      if (!body.userId || !body.role) throw new GenError('userId and role are required');
      const member = games.addGameMember(game.id, body.userId, body.role, user.id);
      return send(res, 200, member);
    }
    m = /^\/v1\/games\/(game_[0-9a-z]+)\/members\/(u_[0-9a-z]+)$/.exec(route);
    if (m && method === 'DELETE') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.isGameOwner(game.id, user.id) && m[2] !== user.id) {
        throw new GenError('Only the game owner or the member themselves can remove a member', { status: 403 });
      }
      games.removeGameMember(game.id, m[2]);
      return send(res, 200, { removed: true });
    }
    m = /^\/v1\/games\/(game_[0-9a-z]+)\/files$/.exec(route);
    if (m && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canAccessGame(game.id, user.id)) throw new GenError('No access to this game', { status: 403 });
      const files = games.listGameFiles(game.id);
      return send(res, 200, { files });
    }
    if (m && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canEditGame(game.id, user.id)) throw new GenError('No edit access to this game', { status: 403 });
      const body = await readJson(req);
      if (!body.path || typeof body.content !== 'string') throw new GenError('path and content are required');
      const file = games.saveGameFile(game.id, body.path, body.content, user.id);
      return send(res, 200, file);
    }
    m = /^\/v1\/games\/(game_[0-9a-z]+)\/files\/(.+)$/.exec(route);
    if (m && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canAccessGame(game.id, user.id)) throw new GenError('No access to this game', { status: 403 });
      const filePath = decodeURIComponent(m[2]);
      const file = games.getGameFile(game.id, filePath);
      if (!file) throw new GenError('File not found', { status: 404 });
      return send(res, 200, file);
    }
    if (m && method === 'DELETE') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canEditGame(game.id, user.id)) throw new GenError('No edit access to this game', { status: 403 });
      const filePath = decodeURIComponent(m[2]);
      games.deleteGameFile(game.id, filePath);
      return send(res, 200, { deleted: true });
    }
    m = /^\/v1\/games\/(game_[0-9a-z]+)\/releases$/.exec(route);
    if (m && method === 'GET') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.canAccessGame(game.id, user.id)) throw new GenError('No access to this game', { status: 403 });
      const result = games.listGameReleases(game.id, { limit: Number(q('limit')) || 20, offset: Number(q('offset')) || 0 });
      return send(res, 200, result);
    }
    if (m && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Games are for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const game = games.getGame(m[1]);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!games.isGameOwner(game.id, user.id)) throw new GenError('Only the game owner can create releases', { status: 403 });
      const body = await readJson(req);
      if (!body.version) throw new GenError('version is required');
      const release = games.createGameRelease(game.id, body.version, body.notes || '', user.id);
      return send(res, 200, release);
    }

    // ---------------------------------------------------------- play routes
    // Load a published game by subdomain or a release
    m = /^\/v1\/play\/([a-z0-9-]+)$/.exec(route);
    if (m && method === 'GET') {
      const subdomain = m[1];
      const game = games.getGameBySubdomain(subdomain);
      if (!game) throw new GenError('Game not found', { status: 404 });
      if (!game.published) throw new GenError('Game is not published', { status: 403 });
      const files = games.listGameFiles(game.id);
      return send(res, 200, { ...game, files });
    }
    m = /^\/v1\/releases\/(release_[0-9a-z]+)$/.exec(route);
    if (m && method === 'GET') {
      const release = games.getGameRelease(m[1]);
      if (!release) throw new GenError('Release not found', { status: 404 });
      const game = games.getGame(release.gameId);
      if (!game) throw new GenError('Game not found', { status: 404 });
      // Convert files object to array format expected by player
      const filesArray = Object.entries(release.files).map(([path, content]) => ({
        path,
        content,
        gameId: release.gameId,
      }));
      return send(res, 200, { ...game, files: filesArray });
    }

    // ------------------------------------------------------------ analytics
    // Reading what players did (src/analytics/routes.ts, docs/analytics.md).
    if (handleAnalytics(client, route, method, q, res, send, url.search, route === '/v1/analytics/marks' && method === 'POST' ? await readJson(req) : undefined)) return;

    // ----------------------------------------------------------- templates
    if (route === '/v1/templates' && method === 'GET') {
      return send(res, 200, { templates: listTemplates() });
    }
    m = /^\/v1\/templates\/([\w-]+)$/.exec(route);
    if (m && method === 'GET') {
      const template = getTemplate(m[1]);
      if (!template) throw new GenError('Template not found', { status: 404 });
      return send(res, 200, template);
    }

    // ------------------------------------------------------------ assistant
    if (route === '/v1/assistant/chat' && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Assistant is for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const body = await readJson(req);
      if (!body.message) throw new GenError('message is required');
      const response = await assistant.processMessage(
        user.id,
        body.gameContext || {},
        body.history || [],
        body.message
      );
      return send(res, 200, response);
    }
    if (route === '/v1/assistant/generate' && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Assistant is for user accounts only', { status: 403 });
      const user = getUserForClient(client);
      if (!user) throw new GenError('User session required', { status: 401 });
      const body = await readJson(req);
      if (!body.type || !body.prompt) throw new GenError('type and prompt are required');
      const result = await assistant.generateAsset(client, user.id, body.type, body.prompt, body.params || {});
      return send(res, 200, result);
    }
    if (route === '/v1/assistant/code-suggestions' && method === 'POST') {
      if (client.role !== 'user') throw new GenError('Assistant is for user accounts only', { status: 403 });
      const body = await readJson(req);
      if (!body.intent) throw new GenError('intent is required');
      const code = await assistant.getCodeSuggestions({
        intent: body.intent,
        currentCode: body.currentCode
      });
      return send(res, 200, { code });
    }

    // ---------------------------------------------------------------- tools
    if (route === '/v1/tools' && method === 'GET') {
      const list = client.role === 'user' ? TOOLS.filter((t) => !isInternalOnlyTool(t.id)) : TOOLS;
      return send(res, 200, { tools: list.map(describeTool) });
    }
    m = /^\/v1\/tools\/([\w.-]+)$/.exec(route);
    if (m && method === 'GET') {
      if (client.role === 'user' && isInternalOnlyTool(m[1])) {
        throw new GenError(`Tool ${m[1]} is internal-only and not available for user accounts`, { status: 403 });
      }
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
      const projectFilter = fixedProject(client) ?? q('project');
      return send(res, 200, { jobs: listJobs({ project: projectFilter, status: q('status'), tool: q('tool'), limit: Number(q('limit')) || 100, projects: client.projects }).map(summary) });
    }
    if (route === '/v1/jobs/timing' && method === 'GET') {
      const since = q('since') ? Number(q('since')) : Date.now() - (Number(q('days')) || 7) * 24 * 3600 * 1000;
      return send(res, 200, jobTimings({ since, project: q('project'), projects: client.projects }));
    }
    if (route === '/v1/jobs/clear' && method === 'POST') {
      requireRole(client, 'admin');
      const { project } = await readJson(req);
      return send(res, 200, { removed: clearFinished(project) });
    }
    // Every playtest playing or waiting to, with what each is doing (Studio's Playtests page; tools/livePlay.ts).
    if (route === '/v1/playtests/live' && method === 'GET') {
      const visible = (status: string) => listJobs({ tool: 'playtest.run', status, limit: 100, projects: client.projects }).filter((j) => jobVisible(client, j));
      const running = visible('running');
      const playing = running.map((j) => liveSnapshot(j.id) ?? { job: j.id, project: j.project, live: false, step: j.detail ?? 'starting', startedAt: j.started ?? j.created });
      const { playtesterCapacity } = await import('./providers/playtester/playtester.ts');
      return send(res, 200, {
        at: Date.now(), playing, capacity: await playtesterCapacity().catch(() => null), lanes: queue.tabsInUse(),
        waiting: visible('queued').map((j) => ({ job: j.id, project: j.project, created: j.created, detail: j.detail ?? null, url: j.params?.url ?? null, scenario: j.params?.scenario ?? null, peers: Number(j.params?.peers) || 1, device: j.params?.mobile ? 'phone' : 'desktop' })),
      });
    }
    if (route === '/v1/jobs/boost' && method === 'POST') {
      requireRole(client, 'admin');
      const b = await readJson(req);
      return send(res, 200, boostLabel(String(b.label ?? ''), String(b.value ?? ''), Number(b.priority ?? 0), Number(b.minutes ?? 120)));
    }
    m = /^\/v1\/jobs\/(j_[0-9a-f]+)(?:\/(cancel|rerun|live|live\.mjpeg|frame|shots(?:\/\d+)?|graphs\/[\w.-]+))?$/.exec(route);
    if (m) {
      const j = getJob(m[1]);
      if (!j || !jobVisible(client, j)) throw new GenError('No such job', { status: 404 });
      if (!m[2] && method === 'GET') return send(res, 200, { ...j, queue: queuePosition(j) });
      if (m[2] === 'cancel' && method === 'POST') return send(res, 200, cancel(j.id));
      if (m[2] === 'rerun' && method === 'POST') {
        const b = await readJson(req);
        // Changing priority is the scheduler's business: admins and up (Studio), like boosts.
        if (b.priority !== undefined) requireRole(client, 'admin');
        return send(res, 200, rerun(client, j.id, { sameSeed: b.sameSeed === true, params: b.params, inputs: b.inputs, labels: b.labels, priority: b.priority === undefined ? undefined : Number(b.priority) }));
      }
      // A playtest's live state (every step, the players, problems, the timeline); null after the run (the job has the result).
      if (m[2] === 'live' && method === 'GET') return send(res, 200, { job: j.id, status: j.status, detail: j.detail ?? null, live: liveSnapshot(j.id, { full: true }) });
      // A player's newest frame once (frame), or a live MJPEG stream (live.mjpeg: multipart/x-mixed-replace, for an <img>).
      if ((m[2] === 'frame' || m[2] === 'live.mjpeg') && method === 'GET') return liveVideo(req, res, j.id, m[2], Number(q('player')) || 0, Number(q('fps')) || 8);
      // A playtest's screenshots, while it plays (tmp files) and after (the filed assets).
      if (m[2] === 'shots' && method === 'GET') return send(res, 200, shotList(j, Number.isFinite(Number(q('since') ?? 'x')) ? Number(q('since')) : -1));
      if (m[2]?.startsWith('shots/') && method === 'GET') {
        const src = shotSource(j, Number(m[2].slice(6)));
        if (src && 'file' in src && fs.existsSync(src.file)) return serveFile(req, res, src.file, 'image/jpeg', { 'Cache-Control': 'no-cache' });
        const a = src && 'asset' in src ? getAsset(src.asset) : null;
        if (!a || (!fs.existsSync(a.path) && !(await storage.ensureLocal(a)))) throw new GenError('No such screenshot', { status: 404 });
        return serveFile(req, res, a.path, a.mime, { 'Cache-Control': 'private, max-age=86400, immutable' });
      }
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
      const entityProject = q('project') ?? fixedProject(client) ?? undefined;
      return send(res, 200, lib.listEntities(client, { project: entityProject, kind: q('kind'), text: q('q'), tag: q('tag'), archived: q('archived') === '1', limit: Number(q('limit')) || 100, offset: Number(q('offset')) || 0 }));
    }
    if (route === '/v1/entities' && method === 'POST') {
      const body = await readJson(req);
      if (!body.project && fixedProject(client)) body.project = fixedProject(client);
      return send(res, 200, lib.createEntity(client, body));
    }
    m = /^\/v1\/versions\/(v_[0-9a-f]+)$/.exec(route);
    if (m && method === 'PATCH') return send(res, 200, lib.updateVersion(client, m[1], await readJson(req)));
    m = /^\/v1\/entities\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9-]*)(?:\/slots\/(.+?))?(?:\/(versions|make|revise))?$/i.exec(route);
    if (m) {
      if (client.role === 'user' && !canProject(client, m[1])) throw new GenError(`No access to project ${m[1]}`, { status: 403 });
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
        queueLods([assetId]);
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
    if ((route === '/v1/assets' || route === '/v1/library') && method === 'POST') {
      const targetProject = fixedProject(client) ?? (q('project') || 'sandbox');
      if (!canProject(client, targetProject)) throw new GenError('No access to that project', { status: 403 });
      const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
      let buf: Buffer;
      let filename = String(req.headers['x-filename'] ?? q('filename') ?? '').trim();
      let title = q('title') ?? '';
      if (ctype.includes('application/json')) {
        const b = await readJson(req);
        filename = String(b.filename ?? filename ?? '').trim();
        title = String(b.title ?? title ?? filename).trim();
        const rawData = String(b.data ?? '');
        if (!rawData) throw new GenError('Send { data } (base64 or data URL) or raw file bytes');
        const base64Part = rawData.includes(',') ? rawData.slice(rawData.indexOf(',') + 1) : rawData;
        buf = Buffer.from(base64Part, 'base64');
      } else {
        buf = await readBody(req, 2 * 1024 * 1024 * 1024);
        if (!title) title = filename;
      }
      if (!buf.length) throw new GenError('Send the file as the request body');
      const rawExt = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '');
      const ext = rawExt || (ctype && !ctype.includes('json') && !ctype.includes('octet-stream') ? extOf(ctype.split(';')[0].trim()) : '.png');
      const sha = putBlob(buf, ext);
      const asset = putAsset({
        data: buf,
        ext,
        client: client.id,
        project: targetProject,
        tool: 'file.import',
        recipe: { tool: 'file.import', version: 1, params: { title: title || null }, inputs: { file: sha } },
        title: (title || filename || 'Uploaded file').slice(0, 200),
      });
      // An uploaded image or model gets its levels of detail like a made one (src/lod.ts).
      queueLods([asset.id]);
      return send(res, 200, { ...asset, asset, blob: `blob:${sha}` });
    }
    if ((route === '/v1/assets' || route === '/v1/library') && method === 'GET') {
      if (q('project') && !canProject(client, q('project')!)) throw new GenError('No access to that project', { status: 403 });
      const limit = Number(q('limit')) || 60;
      const offset = Number(q('offset')) || 0;
      const playtest = q('playtest') === '1' || q('playtest') === 'true';
      if (client.role === 'user') {
        if (q('tool') === 'motion.library') {
          return send(res, 200, motionsForQuery({ text: q('q'), tool: q('tool'), kind: q('kind'), job: q('job'), starred: q('starred') === '1', limit, offset }));
        }
        const assets = listAssets({ project: fixedProject(client) ?? q('project'), kind: q('kind'), tool: q('tool'), text: q('q'), job: q('job'), starred: q('starred') === '1', playtest: false, limit, offset, projects: client.projects });
        return send(res, 200, withLods(assets));
      }
      const motions = playtest ? { items: [], total: 0 } : motionsForQuery({ text: q('q'), tool: q('tool'), kind: q('kind'), job: q('job'), starred: q('starred') === '1', limit, offset });
      if (q('tool') === 'motion.library') return send(res, 200, motions);
      const assets = withLods(listAssets({ project: q('project'), kind: q('kind'), tool: q('tool'), text: q('q'), job: q('job'), starred: q('starred') === '1', playtest, limit, offset, projects: client.projects }));
      if (!motions.total) return send(res, 200, assets);
      return send(res, 200, { items: [...motions.items, ...assets.items].slice(0, limit), total: motions.total + assets.total });
    }
    if (route.startsWith('/v1/assets/motion:') && method === 'GET') return send(res, 200, motionRecord(decodeURIComponent(route.slice('/v1/assets/'.length))));
    m = /^\/v1\/(assets|files)\/(a_[0-9a-f]+)(?:\/(file))?$/.exec(route);
    if (m) {
      const a = getAsset(m[2]);
      const isFileRoute = m[1] === 'files' || m[3] === 'file';
      const allowed = a && (canProject(client, a.project) || a.project === 'public');
      if (!a || !allowed) throw new GenError('No such asset', { status: 404 });
      if (isFileRoute && method === 'GET') {
        // ?lod=<n>: the level of detail for n (px for images, triangles for models; src/lod.ts pickLod), else the original.
        const lod = q('lod') ? pickLod(a.id, Number(q('lod'))) : null;
        const file = lod ?? { path: a.path, mime: a.mime, sha256: a.sha256, level: null };
        // Not on this disk (a new server): from S3, the first time it's asked for.
        if (!fs.existsSync(file.path) && !(await storage.ensureLocal(file))) throw new GenError(`${a.id}'s file is missing here and not in the library's S3 bucket`, { status: 404 });
        // Content-addressed: the ETag is the file's hash, and a link that names it (?v=<hash prefix>) never changes.
        const etag = `"${file.sha256}"`;
        const v = q('v');
        const cache: Record<string, string> = { ETag: etag, 'Cache-Control': v && v.length >= 8 && file.sha256.startsWith(v) ? 'public, max-age=31536000, immutable' : 'private, max-age=300' };
        if (lod) cache['X-Lod-Level'] = String(lod.level);
        if (String(req.headers['if-none-match'] ?? '') === etag) { res.writeHead(304, cache); return void res.end(); }
        const name = `${a.project}-${a.tool}-${a.id}${lod ? `.lod${lod.level}` : ''}${path.extname(file.path)}`;
        return serveFile(req, res, file.path, file.mime, { ...cache, ...(q('download') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}) });
      }
      if (method === 'GET') return send(res, 200, { ...a, inS3: storage.inS3(a.sha256), ...cdnField(a.sha256), lods: lodSummary(a.id) });
      if (method === 'PATCH') {
        if (!canProject(client, a.project)) throw new GenError('No access to that asset', { status: 403 });
        return send(res, 200, updateAsset(a.id, await readJson(req)));
      }
      if (method === 'DELETE') {
        requireRole(client, 'admin');
        return send(res, 200, { deleted: deleteAsset(a.id) });
      }
    }
    // ---------------------------------------------------------- levels of detail (src/lod.ts)
    // The levels of many assets at once (a game's bundle, a library page): one request, not one per asset. Assets that
    // should have levels and have none yet (made before the LOD system) are queued on the way.
    if (route === '/v1/lods' && method === 'GET') {
      const ids = String(q('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => /^a_[0-9a-f]+$/.test(s)).slice(0, 500);
      const mine = ids.filter((id) => { const x = getAsset(id); return x && (canProject(client, x.project) || x.project === 'public'); });
      const lods = lodSummaries(mine);
      // (Asked for by id means used: even in-between work, or levels cleared by the prune, are made.)
      const queued = queueLods(mine.filter((id) => !lods[id] || lods[id].state === 'pruned'), { asked: true });
      return send(res, 200, { lods, queued });
    }
    if (route === '/v1/lods/status' && method === 'GET') return send(res, 200, lodStatus());
    if (route === '/v1/lods/backfill' && method === 'POST') {
      requireRole(client, 'admin');
      const b = await readJson(req);
      const kind = b.kind === 'image' || b.kind === 'mesh' ? b.kind : undefined;
      return send(res, 200, { ...backfillLods({ project: typeof b.project === 'string' ? b.project : undefined, kind, limit: Number(b.limit) || undefined, dryRun: b.dryRun === true }), ...lodStatus() });
    }
    if (route === '/v1/lods/prune' && method === 'POST') {
      requireRole(client, 'admin');
      const b = await readJson(req);
      // (Its own numbers, then the status under `status`: both have assets, levels and bytes.)
      return send(res, 200, { ...(await pruneLods({ project: typeof b.project === 'string' ? b.project : undefined, dryRun: b.dryRun === true, limit: Number(b.limit) || undefined })), status: lodStatus() });
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
    if (route === '/v1/storage/metadata' && method === 'POST') {
      requireRole(client, 'admin');
      if (!storage.bucket()) throw new GenError('No bucket set', { status: 409 });
      const b: any = await readJson(req);
      return send(res, 200, await storage.fixMetadata({ apply: b.apply === true, limit: Math.min(1000, Number(b.limit) || 200), after: String(b.after ?? '') }));
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
        disks: machines.lastDisks(),
      });
    }
    // ------------------------------------------------- machines (monitor)
    if (route === '/v1/machines' && method === 'GET') return send(res, 200, await machines.machines({ live: q('live') === '1' }));
    if (route === '/v1/machines/history' && method === 'GET') return send(res, 200, machines.history({ id: q('id') || undefined, hours: Number(q('hours')) || 1, points: Number(q('points')) || 120 }));
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
    // Remote Desktop from the browser (owner): the .rdp as a download for the server's current address, with the caller's IP let in on 3389.
    if (route === '/v1/builder/rdp-file' && method === 'GET') {
      requireRole(client, 'owner');
      const r = await builder.builderRdpDownload(requesterIp(req));
      if (!r.ready) return send(res, 409, { error: `The build server is ${r.state}. Start it first.`, ready: false, state: r.state });
      res.writeHead(200, { 'Content-Type': 'application/x-rdp', 'Content-Disposition': `attachment; filename="${r.filename}"`, 'Cache-Control': 'no-store' });
      return void res.end(r.content);
    }
    // The CPU suite (docs/cpu-cloudrun.md): every CPU tool, where it runs now (here or a Cloud Run service) and why,
    // the services' sizes and prices, and the last requests (latency, cold starts, failures).
    if (route === '/v1/cpu' && method === 'GET') return send(res, 200, cpuStatus(loadSettings()));
    // GPU providers (docs/gpu-providers.md): the order jobs try them in, each one's setup, cooldown, last error and price.
    if (route === '/v1/gpu/providers' && method === 'GET') {
      requireRole(client, 'admin');
      const { gpuStatus } = await import('./providers/gpu/status.ts');
      const { loadServiceMap } = await import('./providers/cloudrun/services.ts');
      let map: ReturnType<typeof loadServiceMap> | null = null;
      try { map = loadServiceMap(); } catch { /* no services.json: Cloud Run shows as not set up */ }
      return send(res, 200, gpuStatus(loadSettings(), map));
    }
    // Unity cloud builds (docs/unity-cloudrun.md): the settings, the Library caches, and "clear cache".
    if (route === '/v1/builder/cloud' && method === 'GET') {
      const u = loadSettings().unityBuild;
      return send(res, 200, { backend: u.backend, projects: u.projects, timeoutMinutes: u.timeoutMinutes, cleanAfterFailures: u.cleanAfterFailures, concurrency: u.concurrency, gcp: u.gcp, state: cloudCache.loadCacheState() });
    }
    if (route === '/v1/builder/caches' && method === 'GET') {
      requireRole(client, 'admin');
      return send(res, 200, { caches: await cloudrun.listCaches() });
    }
    if (route === '/v1/builder/caches/clear' && method === 'POST') {
      requireRole(client, 'admin');
      const body = await readJson(req);
      if (body.confirm !== true) throw new GenError('clearing a cache needs { "confirm": true } (the next build of that project is a full import)');
      if (!body.repo) throw new GenError('repo is required (the project folder, e.g. breakingthrough or YoobaLand/YoobaLand)');
      return send(res, 200, { ok: true, ...(await cloudrun.clearCache(String(body.repo), body.key ? cloudCache.cacheName(String(body.key)) : undefined)) });
    }
    // The password is returned only here, on demand, and never logged.
    if (route === '/v1/builder/password' && method === 'POST') {
      requireRole(client, 'owner');
      return send(res, 200, { ok: true, ...builder.builderPassword() });
    }
    // The GPU servers are Linux (SSH only): the ssh command, after letting the caller's IP in.
    if (route === '/v1/fleet/connect' && method === 'GET') {
      requireRole(client, 'owner');
      await fleet.refreshAccess(requesterIp(req));
      return send(res, 200, await fleet.sshCommand(q('id')));
    }
    m = /^\/v1\/builder\/(launch|start|stop|terminate|access|rdp|idle|ssh|github)$/.exec(route);
    if (m && method === 'POST') {
      const act = m[1];
      const body = await readJson(req);
      const costly = ['launch', 'start', 'terminate', 'ssh'].includes(act);
      requireRole(client, costly || act === 'rdp' ? 'owner' : 'admin');
      if (costly && body.confirm !== true) throw new GenError(`${act} needs { "confirm": true }`);
      if (act === 'launch') return send(res, 200, { ok: true, ...(await builder.launchBuilder({ type: body.type || undefined, region: body.region || undefined, idleMinutes: Number(body.idleMinutes) || 30, unity: body.unity || undefined })) });
      if (act === 'start') return send(res, 200, { ok: true, ...(await builder.startBuilder(requesterIp(req))) });
      if (act === 'stop') return send(res, 200, { ok: true, ...(await builder.stopBuilder()) });
      if (act === 'terminate') return send(res, 200, { ok: true, ...(await builder.terminateBuilder()) });
      if (act === 'access') return send(res, 200, { ok: true, ...(await builder.builderAccess(requesterIp(req))) });
      if (act === 'github') return send(res, 200, { ok: true, keys: await builder.builderGitHubAccess(Array.isArray(body.repos) && body.repos.length ? body.repos.map(String) : ['jgriffith3433/sickofitgame-unity', 'jgriffith3433/YoobaLand']) });
      if (act === 'rdp') return send(res, 200, { ok: true, ...(await builder.builderRdp()) });
      if (act === 'idle') return send(res, 200, { ok: true, ...(await builder.setBuilderIdle(Number(body.minutes))) });
      if (act === 'ssh') return send(res, 200, { ok: true, output: await builder.ssh(String(body.command ?? ''), { timeoutMs: Math.min(600_000, Number(body.timeoutMs) || 120_000) }) });
    }

    // ------------------------------------------------- playtests on Cloud Run (docs/playtest-cloudrun.md)
    // The settings, the lanes and the price; ?selftest=1 also asks the service how WebGL reaches its GPU (that may start
    // an instance: about $0.03 for its cold start and test, plus its idle tail). fresh=1 reruns it, all=1 tries every path.
    if (route === '/v1/playtester/cloud' && method === 'GET') {
      requireRole(client, 'owner');
      const pc = await import('./providers/playtester/cloudrun.ts');
      const s = loadSettings();
      const project = url.searchParams.get('project');
      const c = pc.cloudPlaytestFor(project, { playtest: { ...s.playtest, backend: 'cloudrun' } });
      const out: any = { settings: s.playtest, backendFor: project ? pc.playtestBackendOf(project, s.playtest) : s.playtest.backend, deployed: Boolean(c) };
      if (c) Object.assign(out, { service: c.name, region: c.region, lanes: pc.cloudLanes(c), pricePerHour: Math.round(c.pricePerSecond * 3600 * 100) / 100, perTabMinute: Math.round(pc.tabCost(c, 60) * 10_000) / 10_000 });
      if (c && url.searchParams.get('selftest') === '1') out.selftest = await pc.cloudSelfTest(c, { fresh: url.searchParams.get('fresh') === '1', all: url.searchParams.get('all') === '1' });
      return send(res, 200, out);
    }

    // ------------------------------------------------- playtester (T4 GPU)
    // The first playtester's status as before, plus every playtester (machines) and their lanes.
    if (route === '/v1/playtester' && method === 'GET') {
      const all = await playtester.playtestersStatus();
      return send(res, 200, { ...(all.machines[0] ?? (await playtester.playtesterStatus())), machines: all.machines, max: all.max, lanes: all.lanes, inUse: all.inUse });
    }
    m = /^\/v1\/playtester\/(launch|start|ensure|stop|terminate|access|idle|ssh)$/.exec(route);
    if (m && method === 'POST') {
      const act = m[1];
      const body = await readJson(req);
      const costly = ['launch', 'start', 'ensure', 'terminate', 'ssh'].includes(act);
      requireRole(client, costly ? 'owner' : 'admin');
      if (costly && body.confirm !== true) throw new GenError(`${act} needs { "confirm": true }`);
      if (act === 'launch') return send(res, 200, { ok: true, ...(await playtester.launchPlaytester({ type: body.type || undefined, region: body.region || undefined, idleMinutes: Number(body.idleMinutes) || 20 })) });
      // Which playtester (start, ensure, stop, terminate, idle, ssh): the first one, or every one for stop and idle, without it.
      const id = typeof body.id === 'string' && /^i-[0-9a-f]+$/.test(body.id) ? body.id : undefined;
      if (act === 'start') return send(res, 200, { ok: true, ...(await playtester.startPlaytester(id)) });
      if (act === 'ensure') return send(res, 200, { ok: true, ...(await playtester.ensurePlaytester(() => {}, 15 * 60_000, id)) });
      if (act === 'stop') {
        // ifIdle: leave it running while a playtest is still using it (its idle stop follows).
        if (body.ifIdle && listJobs({ status: 'running', limit: 500 }).some((j) => j.tool === 'playtest.run')) return send(res, 200, { ok: true, skipped: 'a playtest is still running; it stops itself when idle' });
        return send(res, 200, { ok: true, ...(await playtester.stopPlaytester(id)) });
      }
      if (act === 'terminate') return send(res, 200, { ok: true, ...(await playtester.terminatePlaytester(id)) });
      if (act === 'access') return send(res, 200, { ok: true, ...(await playtester.playtesterAccess()) });
      if (act === 'idle') return send(res, 200, { ok: true, ...(await playtester.setPlaytesterIdle(Number(body.minutes), id)) });
      if (act === 'ssh') return send(res, 200, { ok: true, output: await playtester.ssh(String(body.command ?? ''), { id, timeoutMs: Math.min(600_000, Number(body.timeoutMs) || 120_000) }) });
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
    if (route === '/v1/presets' && method === 'GET') return send(res, 200, { projects: listPresets().filter((p) => canProject(client, p.project) || p.project === 'shared' || client.role === 'user') });
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
    // The open audio models: licence, size, what each can do, and which the `auto` provider trusts (docs/audio.md).
    if (route === '/v1/audio/models' && method === 'GET') {
      const verified = new Set(loadSettings().audio.verified);
      return send(res, 200, { models: AUDIO_MODELS.map((m) => ({ ...m, verified: verified.has(m.id), selectable: !m.blocked && m.license.commercial !== false })), refused: REFUSED_MODELS, verified: [...verified], targetLufs: loadSettings().audio.targetLufs });
    }
    if (route === '/v1/providers/anthropic/models' && method === 'GET') return send(res, 200, { models: claude.MODELS, default: claude.DEFAULT_MODEL });

    // ------------------------------------------------------ settings, clients
    if (route === '/v1/settings' && method === 'GET') return send(res, 200, loadSettings());
    if (route === '/v1/settings' && method === 'POST') {
      requireRole(client, 'owner');
      return send(res, 200, saveSettings(await readJson(req)));
    }
    // Claude accounts (src/claude-accounts.ts): the Max-plan logins Gen's Claude calls run with. Owner only; tokens never
    // leave the server (the list shows a label and the last 4 characters).
    if (route.startsWith('/v1/claude/')) {
      requireRole(client, 'owner');
      const ca = await import('./claude-accounts.ts');
      if (route === '/v1/claude/accounts' && method === 'GET') return send(res, 200, ca.listAccounts());
      if (route === '/v1/claude/signin' && method === 'POST') return send(res, 200, await ca.startSignin(String((await readJson(req)).label ?? ''), client.name));
      if (route === '/v1/claude/signin/code' && method === 'POST') return send(res, 200, await ca.finishSignin(String((await readJson(req)).code ?? '')));
      if (route === '/v1/claude/signin/cancel' && method === 'POST') return send(res, 200, ca.cancelSignin());
      const am = /^\/v1\/claude\/accounts\/(ca_[0-9a-f]+)(?:\/(use|check|rename))?$/.exec(route);
      if (am && method === 'POST' && am[2] === 'use') return send(res, 200, ca.useAccount(am[1]));
      if (am && method === 'POST' && am[2] === 'check') return send(res, 200, { check: await ca.checkAccount(am[1]), ...ca.listAccounts() });
      if (am && method === 'POST' && am[2] === 'rename') return send(res, 200, ca.renameAccount(am[1], String((await readJson(req)).label ?? '')));
      if (am && method === 'DELETE' && !am[2]) return send(res, 200, ca.removeAccount(am[1]));
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
