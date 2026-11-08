// The HTTP API (JSON, under /v1) and the dashboard (static files at /).
// docs/api.md lists every route with examples.

import { clientIp } from './analytics/collect.ts';
import { signupStats } from './signupcap.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { paths, loadSettings, saveSettings, FLEET_MAX, env } from './config.ts';
import { primePlatform } from './platform.ts';
import { authenticate, canProject, dashboardClient, KEY_COOKIE, fixedProject, requireRole, createClient, listClients, setClientDisabled, type Client } from './auth.ts';
import { publicJob, publicText } from './publictext.ts';
import { orgCreditsOn } from './orgcredits.ts';
import { DASH_COOKIE, DASH_DAYS, googleClientId, googleClientIdAny, checkGoogleToken, signSession, verifyGoogle } from './dashauth.ts';
import { TOOLS, getTool, describeTool, reloadTools } from './tools/index.ts';
import { listWorkflows, getWorkflow, saveWorkflow, draftManifest } from './workflows/registry.ts';
import { objectInfo, refreshCatalog, templates, templateWorkflow, templateThumb, importWorkflow } from './workflows/catalog.ts';
import { convertUiWorkflow, checkGraph } from './workflows/convert.ts';
import { validateParams } from './tools/validate.ts';
import { estimate } from './estimate.ts';
import { shotList, shotSource } from './tools/liveShots.ts';
import { liveSnapshot, liveFrame, isLive } from './tools/livePlay.ts';
import { submit, submitJob, getJob, listJobs, cancel, rerunJob, boostLabel, clearFinished, jobTimings, events, summary, queue, queuePosition, typicalRunSeconds, type JobSpec, type Job } from './jobs.ts';
import { getAsset, listAssets, updateAsset, deleteAsset, putBlob, blobPath, ownBlob, canUseBlob, putAsset, findByRecipe, recipeKey } from './library.ts';
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
import { genOAuth } from './genoauth.ts';
import { limit as limitRequest } from './ratelimit.ts';
import { handleUpload, downloadTarget, linkTarget, shareLink, signedFileUrl, verifyFileSig } from './links.ts';
import { handleMcp } from './mcp-http.ts';
import { handleCollect } from './analytics/collect.ts';
import { noteRoute, lagReport } from './lag.ts';
import { mockHealth } from './mockproviders.ts';
import { handleAnalytics } from './analytics/routes.ts';
import { handleBench } from './bench/routes.ts';
import { handleMake } from './make/routes.ts';
import { handleShowrunner } from './showrunner/routes.ts';
import { handleNetBridge } from './netbridge.ts';
import { handleIdentity } from './identityroutes.ts';
import { handleWorlds } from './worldroutes.ts';
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
  googleSignin,
  passwordsAllowed,
  getUserById,
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
  chargeCredits,
} from './billing.ts';
import * as house from './houseai.ts';
import { getPortfolio } from './portfolio.ts';
import { probe as probeMedia, normalizeCheck, type ProbeInfo } from './tools/media.ts';

const VERSION = JSON.parse(fs.readFileSync(path.join(paths.server, '..', 'package.json'), 'utf8')).version;

export const retry = new Retry({ onSuccess: () => queue.pump() });
let lastFailure: any = null;
let account: { at: number; value: any } = { at: 0, value: null };

/** submitJob, with a refusal written to the log (who, which tool, why): a customer's refused job otherwise left no
 *  trace (2026-10-31: a customer Studio's Unity build was refused with a 400 nobody could read). Refusals never carry
 *  a token (customer.ts never echoes one). */
async function submitLogged(client: Client, spec: JobSpec) {
  try {
    return await submitJob(client, spec);
  } catch (e: any) {
    if (e?.status && e.status < 500) console.warn(`[jobs] refused ${String((spec as any)?.tool ?? '?').slice(0, 60)} for ${client.id} (${(client.projects ?? []).slice(0, 2).join(', ')}): ${e.status} ${String(e.message ?? e).slice(0, 300)}`);
    throw e;
  }
}

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

/** Responses over this many bytes go out chunked on Cloud Run: it refuses a response with a Content-Length over 32 MiB
 *  ("Response size was too large", 2026-10-31: a 41 MB Unity build couldn't be downloaded), but streams chunked ones. */
const CHUNK_OVER = 30 * 1024 * 1024;
const onCloudRun = () => Boolean(process.env.K_SERVICE);

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, mime = mimeOf(file), extra: Record<string, string> = {}) {
  const stat = fs.statSync(file);
  const length = (n: number) => (onCloudRun() && n > CHUNK_OVER ? {} : { 'Content-Length': n });
  const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': mime, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', ...length(end - start + 1), ...extra });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': mime, ...length(stat.size), 'Accept-Ranges': 'bytes', ...extra });
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

/** Routes about the studio's own machinery (src/api.ts gate): never for customers' keys. */
/** A customer's key: role user, and only customer projects (settings.queue.projects: usr_*, u_*, org_*...). The studio's
 *  own products' user keys (DoD's devtools and the rest) keep seeing the fleet and the machines. */
export function isCustomer(c: Client) {
  if (c.role !== 'user') return false;
  const globs = loadSettings().queue.projects;
  return c.projects.length > 0 && c.projects.every((p) => p !== '*' && globs.some((g) => (g.endsWith('*') ? p.startsWith(g.slice(0, -1)) : p === g)));
}
const OPS_ROUTES = /^\/v1\/(admin|fleet|machines|builder|cpu|playtester|playtests\/live|playtest\/capacity|storage|settings|claude|gpu|comfy|templates|workflows|clients|providers\/anthropic|lods\/prune|bench|quality)(\/|$)/;

function jobVisible(c: Client, j: { project: string }) {
  return canProject(c, j.project);
}

/**
 * POST /v1/assets: does this upload need media.normalize (src/tools/media.ts normalizeCheck), and if so its job. Files
 * that aren't media (a GLB, JSON) and media that are fine answer { needsNormalize: false }. `normalize=0` checks only.
 * A failure to queue (no credits) is reported, never fails the upload.
 */
async function uploadNormalize(client: Client, project: string, asset: { id: string; path?: string }, ext: string, ctype: string, flag: string | null | undefined) {
  const mediaLike = /^(image|video|audio)\//.test(ctype) || /^\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ts|mts|m2ts|ogv|png|jpe?g|jfif|webp|gif|bmp|tiff?|heic|heif|avif|mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|aiff?|amr|weba)$/.test(ext);
  if (!mediaLike || !asset.path) return { needsNormalize: false };
  let info: ProbeInfo | null = null;
  try { info = await probeMedia(asset.path, AbortSignal.timeout(20_000)); } catch { /* unreadable by ffprobe: the extension decides */ }
  const check = normalizeCheck(info, ext);
  if (!check.needed || check.kind === 'other') return { needsNormalize: false };
  const out: Record<string, unknown> = { needsNormalize: true, normalizeReasons: check.reasons };
  if (/^(0|false|off|no)$/i.test(flag ?? '')) return out;
  try {
    const job = await submitJob(client, { tool: 'media.normalize', project, inputs: { file: `asset:${asset.id}` }, labels: { normalizeOf: asset.id }, key: `normalize:${asset.id}` });
    out.normalizeJob = job.id;
  } catch (e) {
    out.normalizeError = e instanceof Error ? e.message : String(e);
  }
  return out;
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

  // The request limiter (src/ratelimit.ts): a token bucket per caller and class of route, before any routing.
  // /v1/health and the Stripe webhook are never limited.
  const wait = limitRequest(req, method, route);
  if (wait !== null) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(wait), 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ error: `That's a lot at once: wait ${wait} second${wait === 1 ? '' : 's'}, then try again.`, retryAfter: wait }));
  }

  // Signing in to the MCP from an editor (src/genoauth.ts, src/mcp-oauth.ts): discovery, registration, the consent page
  // and tokens. Before the CORS below: these carry their own.
  if (route.startsWith('/oauth/') || route.startsWith('/.well-known/oauth-') || route === '/.well-known/openid-configuration') {
    if (await genOAuth.handle(req, res, route)) return;
  }
  // Signed links for MCP editors (src/links.ts): a one-time upload, and a download that needs no credential for a day.
  if (route.startsWith('/up/') && (await handleUpload(req, res, route))) return;
  if (route.startsWith('/dl/') && (method === 'GET' || method === 'HEAD')) {
    const link = linkTarget(route);
    const a = link ? getAsset(link.asset) : null;
    if (!a) return send(res, 404, { error: 'This link is invalid or expired' });
    if (!fs.existsSync(a.path) && !(await storage.ensureLocal({ path: a.path, sha256: a.sha256 } as any))) return send(res, 404, { error: 'The file is missing' });
    // A share link (the app's Share) plays in the browser; an editor's download link downloads.
    return serveFile(req, res, a.path, a.mime, { 'Cache-Control': 'private, max-age=300', 'Content-Disposition': `${link!.view ? 'inline' : 'attachment'}; filename="${route.split('/').pop()}"` });
  }

  // A signed file link (src/links.ts signedFileUrl): /v1/files/<id>?exp=&sig= opens in a browser with no session. Bound to
  // that one asset and its expiry; a bad or expired signature is 401. Without ?sig the normal credential check applies.
  const sf = (method === 'GET' || method === 'HEAD') && url.searchParams.has('sig') ? /^\/v1\/files\/(a_[0-9a-f]+)$/.exec(route) : null;
  if (sf) {
    if (!verifyFileSig(sf[1], q('exp'), q('sig'))) return send(res, 401, { error: 'This link is invalid or expired: ask for a new one' });
    const a = getAsset(sf[1]);
    if (!a) return send(res, 404, { error: 'No such asset' });
    if (!fs.existsSync(a.path) && !(await storage.ensureLocal({ path: a.path, sha256: a.sha256 } as any))) return send(res, 404, { error: 'The file is missing' });
    return serveFile(req, res, a.path, a.mime, { 'Cache-Control': 'private, max-age=300' });
  }

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

  // Dashboard and customer-facing SaaS web app (/cdn/ is the CDN's origin, below).
  if (!route.startsWith('/v1/') && !route.startsWith('/cdn/')) {
    // The 🐞 button's widget and posts on the beta lane: Studio's (src/studioreport.ts).
    const reports = await import('./studioreport.ts');
    if (await reports.toStudio(req, res, route)) return;
    // The admin dashboard: the owner's and admins' alone, every file of it (src/adminpage.ts).
    const adminPage = await import('./adminpage.ts');
    const adminFile = adminPage.isAdminRoute(route);
    if (adminFile && !adminPage.isAdminViewer(req)) {
      if (!adminPage.isAdminPage(route)) return send(res, 404, { error: 'Not found' });
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
      return void res.end(adminPage.ADMIN_SIGNIN);
    }
    const publicSaas = isPublicSaas(req);
    let rel: string;
    if (route === '/legal' || route === '/terms' || route === '/privacy' || route === '/refunds') {
      // Gen's terms, privacy and refunds (dashboard/gen/legal.html); /terms, /privacy and /refunds land on the same page.
      rel = 'gen/legal.html';
    } else if (route === '/home' || route === '/home/' || route === '/public' || route === '/public/') {
      rel = 'public/landing.html';
    } else if (route === '/app' || route === '/app/') {
      rel = 'public/game-editor.html';
    } else if (route === '/play' || route === '/play/') {
      rel = 'public/player.html';
    } else if (route === '/admin' || route === '/admin/') {
      // The admin dashboard (owner and admin keys, Google for the listed emails); its files sit beside it.
      rel = 'index.html';
    } else if (route.startsWith('/admin/')) {
      rel = route.slice('/admin/'.length);
    } else if (route === '/') {
      // Hawkes Gen, the app (dashboard/gen/): create, library, editor, on Gen's own accounts.
      rel = 'gen/index.html';
    } else {
      rel = route.slice(1);
    }
    const file = path.join(paths.dashboard, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(paths.dashboard) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      // The app's page on the beta lane carries the 🐞 button.
      if (rel === 'gen/index.html' && reports.reportsOn()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return void res.end(reports.withReportButton(fs.readFileSync(file, 'utf8'), VERSION));
      }
      // The admin dashboard's files are never kept by a cache in front of Gen (they're one admin's answer).
      res.writeHead(200, { 'Content-Type': STATIC[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': adminFile ? 'private, no-store' : 'no-cache' });
      return void fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // Which SDK each caller runs (X-Hawkes-Client: js/6, py/6, unity/0.2.1): /v1/health lists the ones behind.
  noteClient(req);

  try {
    // The CDN's origin (server/gen-cdn: cdn.hawkesgen.ai caches each file a year at Cloudflare's edge): one library file
    // by its content hash, read from the bucket with Gen's own identity (no key anywhere). Exact sha256 keys only: no
    // listing, nothing else in the bucket. A hash names its bytes, so it's immutable.
    const cdn = /^\/cdn\/sha256\/([0-9a-f]{64})$/.exec(route);
    if (cdn && (method === 'GET' || method === 'HEAD')) {
      const st = await import('./storage.ts');
      const b = st.bucket();
      if (!b || st.provider() !== 'gcs') return send(res, 404, { error: 'No CDN origin here' });
      // On Cloud Run only the cdn.hawkesgen.ai Worker may call this (Cloudflare's edge is the last hop), so nobody skips
      // the cache to wake Gen; and only files of projects storage.cdnProjects lets out (never customers' by default).
      const { CLOUDFLARE_EDGE } = await import('./analytics/collect.ts');
      const { inCidrs } = await import('./analytics/datacenter.ts');
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (process.env.K_SERVICE && !inCidrs(hops[hops.length - 1] ?? '', CLOUDFLARE_EDGE)) return send(res, 403, { error: 'Use https://cdn.hawkesgen.ai' });
      if (!st.cdnAllowed(cdn[1])) return send(res, 404, { error: 'Not found' });
      const { gcs } = await import('./providers/gcp/gcs.ts');
      const r = await gcs().media(`gs://${b}/${st.keyOf(cdn[1])}`);
      if (!r) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': st.safeMime(r.headers.get('content-type')),
        ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length')! } : {}),
        'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
      });
      if (method === 'HEAD' || !r.body) { await r.body?.cancel().catch(() => {}); return res.end(); }
      const { Readable } = await import('node:stream');
      Readable.fromWeb(r.body as any).pipe(res);
      return;
    }
    if (route === '/v1/health') {
      return send(res, 200, {
        // commit: what this deploy runs (CI sets it), for Hawkes Studio's beta and go-live checks (its versionPath).
        ok: true, name: 'hawkesgen', version: VERSION, commit: process.env.HAWKESGEN_COMMIT || null, lane: process.env.HAWKESGEN_LANE || 'live',
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
        // Customers' Studios' jobs charged to their balance here (src/orgcredits.ts): their cells then don't charge again.
        orgCredits: orgCreditsOn(),
        // New accounts and starter grants refused by the caps today and in total (src/signupcap.ts).
        signups: signupStats(),
        queue: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status").all() as any[]).map((r) => [r.status, r.n])),
        // Unity builds and tests on the build server: the one kind of job a restart of Gen would leave half done
        // (the deploy script waits for these only; everything else resumes after a restart).
        building: (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND tool IN ('unity.build', 'unity.test')").get() as any).n,
        client: { current: SDK_CURRENT, min: SDK_MIN, behind: [...clientsSeen.values()].filter((c) => c.behind) },
        // Event-loop lag: the worst delay seen and the recent blocks over 500 ms, with the requests around them.
        loop: lagReport(),
        // HAWKESGEN_MOCK_PROVIDERS (src/mockproviders.ts): whether providers are stand-ins, and any real spend since boot.
        mock: mockHealth(),
        process: { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), rssMb: Math.round(process.memoryUsage().rss / 1048576), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) },
      });
    }

    // --------------------------------------------------- public SaaS routes
    if (route === '/v1/portfolio' && method === 'GET') {
      return send(res, 200, getPortfolio());
    }
    // The plans, for anyone (the app shows them before sign-in); the defaults are seeded on first ask (subscriptions.ts).
    if (route === '/v1/subscriptions/plans' && method === 'GET') {
      (await import('./subscriptions.ts')).seedPlans();
      return send(res, 200, { plans: billing.listSubscriptionPlans(), stripe: { configured: getStripeStatus().configured } });
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
    // Continue with Google (users.ts googleSignin): the app's sign-in. The client id is the one the admin dashboard uses.
    if (route === '/v1/users/google' && method === 'GET') return send(res, 200, { clientId: googleClientIdAny(), passwords: passwordsAllowed() });
    // Hawkes Studio's playtests signed in (src/testsignin.ts): beta only, a token signed with the project's secret.
    if (route === '/v1/users/test-session' && method === 'POST') {
      const ts = await import('./testsignin.ts');
      const project = ts.checkTestToken(await readJson(req));
      const result = googleSignin(ts.testAccountOf(project), clientIp(req));
      setSessionCookie(res, req, result.sessionToken);
      return send(res, 200, { user: { id: result.user.id, email: result.user.email }, created: result.created, notice: result.notice });
    }
    if (route === '/v1/users/test-session/github' && method === 'POST') {
      // A GitHub Actions run of an allowed repo, as its test account, on beta only (src/githubsignin.ts).
      const gh = await import('./githubsignin.ts');
      const project = await gh.checkGitHubToken((await readJson(req))?.token);
      const ts = await import('./testsignin.ts');
      const result = googleSignin(ts.testAccountOf(project), clientIp(req));
      setSessionCookie(res, req, result.sessionToken);
      return send(res, 200, { user: { id: result.user.id, email: result.user.email }, created: result.created, notice: result.notice });
    }
    if (route === '/v1/users/google' && method === 'POST') {
      const { credential } = await readJson(req);
      let who;
      try { who = await checkGoogleToken(String(credential ?? '')); } catch (e: any) { return send(res, 401, { error: e.message }); }
      const result = googleSignin(who, clientIp(req));
      setSessionCookie(res, req, result.sessionToken);
      return send(res, 200, { user: result.user, created: result.created, notice: result.notice });
    }
    if ((route === '/v1/users/signup' || route === '/v1/users/login') && method === 'POST' && !passwordsAllowed()) {
      return send(res, 410, { error: 'Sign in with Google.', code: 'google_only' });
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

    await primePlatform(req);
    const client = authenticateRequest(req);
    if (!client) return send(res, 401, { error: 'Send an API key (Authorization: Bearer hg_...) or sign in' });
    // The editors connected to this account's MCP (src/genoauth.ts): listed, and disconnected one at a time.
    if (route === '/v1/users/me/connections' && method === 'GET') {
      if (!client.userId) return send(res, 400, { error: 'Connections belong to a Gen account (sign in to the app)' });
      return send(res, 200, { connections: genOAuth.connections(client.userId) });
    }
    const conn = /^\/v1\/users\/me\/connections\/(conn_[\w-]+)$/.exec(route);
    if (conn && method === 'DELETE') {
      if (!client.userId) return send(res, 400, { error: 'Connections belong to a Gen account (sign in to the app)' });
      return genOAuth.revoke(client.userId, conn[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such connection' });
    }

    if (route === '/v1/me') return send(res, 200, client);
    // An org's own Claude access (orgsecrets.ts): its Anthropic API key or its Claude subscription's sign-in token. Its
    // owners and admins set them with a platform token; Gen's owner for any org (?org=). Never returned: whether one is
    // set and its last 4 characters.
    const ok_ = /^\/v1\/org\/keys\/(anthropic|claude-subscription)$/.exec(route);
    if (ok_) {
      const org = client.org ?? (client.role === 'owner' ? String(q('org') ?? '') : '');
      if (!org) throw new GenError('Use a hawkesgen.ai platform token for your org', { status: 403 });
      if (method !== 'GET' && client.org && !['owner', 'admin'].includes(String(client.orgRole))) throw new GenError("Only the org's owners and admins can change its keys", { status: 403 });
      const os_ = await import('./orgsecrets.ts');
      const kind = ok_[1] as 'anthropic' | 'claude-subscription';
      if (method === 'GET') return send(res, 200, os_.orgSecretInfo(org, kind));
      if (method === 'PUT' || method === 'POST') return send(res, 200, os_.setOrgSecret(org, kind, String((await readJson(req)).key ?? ''), client.name));
      if (method === 'DELETE') return send(res, 200, os_.deleteOrgSecret(org, kind));
    }
    // The studio's machinery is for admins: customers' keys (role user) never see the fleet, machines, settings, storage,
    // Claude logins, workflows or everyone's live playtests, whatever each route below checks itself.
    if (isCustomer(client) && OPS_ROUTES.test(route)) return send(res, 403, { error: 'This needs the admin role' });

    // --------------------------------------------------- user & billing routes
    if (route === '/v1/users/me' && method === 'GET') {
      return send(res, 200, getUserProfile(client));
    }
    // A Gen account's own AI (the editor's AI runs on it, never ours): its Anthropic API key or its Claude subscription's
    // token, in the same encrypted store as orgs' (orgsecrets.ts genAccountOrg). Only "set" and the last 4 come back.
    const ai_ = /^\/v1\/users\/me\/ai(?:\/(anthropic|claude-subscription))?$/.exec(route);
    if (ai_) {
      const user = getUserForClient(client);
      if (!user) throw new GenError('Sign in with your Gen account', { status: 403 });
      const os_ = await import('./orgsecrets.ts');
      const org = os_.genAccountOrg(user.project);
      if (!ai_[1]) {
        if (method !== 'GET') throw new GenError('Name what to set: /v1/users/me/ai/anthropic or /claude-subscription', { status: 405 });
        // house: the AI Gen gives every account (src/houseai.ts); the app asks nothing of the person while it's ready.
        return send(res, 200, { anthropic: os_.orgSecretInfo(org, 'anthropic'), claudeSubscription: os_.orgSecretInfo(org, 'claude-subscription'), house: { ready: house.houseReady(), minCredits: house.houseSettings().minCredits } });
      }
      const kind = ai_[1] as 'anthropic' | 'claude-subscription';
      if (method === 'GET') return send(res, 200, os_.orgSecretInfo(org, kind));
      if (method === 'PUT' || method === 'POST') return send(res, 200, os_.setOrgSecret(org, kind, String((await readJson(req)).key ?? ''), user.email));
      if (method === 'DELETE') return send(res, 200, os_.deleteOrgSecret(org, kind));
    }

    // --------------------------------------------------------------- /admin: the house AI and accounts (owner only)
    if (route.startsWith('/v1/admin/')) {
      requireRole(client, 'owner');
      const by = client.name ?? 'owner';
      if (route === '/v1/admin/ai' && method === 'GET') return send(res, 200, house.houseStatus());
      if (route === '/v1/admin/ai' && (method === 'PUT' || method === 'POST')) {
        const b = await readJson(req);
        return send(res, 200, house.saveHouseSettings({ source: b.source, markup: b.markup, minCredits: b.minCredits }));
      }
      if (route === '/v1/admin/ai/key' && (method === 'PUT' || method === 'POST')) return send(res, 200, house.setHouseKey(String((await readJson(req)).key ?? ''), by));
      if (route === '/v1/admin/ai/key' && method === 'DELETE') return send(res, 200, house.clearHouseKey());
      // The secret Hawkes Studio's test sign-ins are signed with (src/testsignin.ts; Studio's project page shows it).
      if (route === '/v1/admin/test-signin' && method === 'GET') return send(res, 200, (await import('./testsignin.ts')).testSignInStatus());
      if (route === '/v1/admin/test-signin' && (method === 'PUT' || method === 'POST')) return send(res, 200, (await import('./testsignin.ts')).setTestSignInSecret((await readJson(req)).secret));
      // The app's 🐞 script: a Studio project's report line (src/studioreport.ts).
      if (route === '/v1/admin/report-script' && method === 'GET') return send(res, 200, { script: (await import('./studioreport.ts')).reportScript() });
      if (route === '/v1/admin/report-script' && (method === 'PUT' || method === 'POST')) return send(res, 200, (await import('./studioreport.ts')).setReportScript((await readJson(req)).script));
      if (route === '/v1/admin/test-signin' && method === 'DELETE') return send(res, 200, (await import('./testsignin.ts')).setTestSignInSecret(''));
      const acc = await import('./accounts.ts');
      if (route === '/v1/admin/accounts' && method === 'GET') return send(res, 200, { ...acc.listGenAccounts({ q: q('q') ?? '', limit: Number(q('limit') ?? 100), offset: Number(q('offset') ?? 0) }), overview: acc.accountsOverview() });
      const am = /^\/v1\/admin\/accounts\/(u_[0-9a-f]+)(?:\/(gift|credits|disable|enable))?$/.exec(route);
      if (am && !am[2] && method === 'GET') return send(res, 200, acc.genAccount(am[1]));
      // Deleting an account for good: owner only, with the account's email typed as the confirmation (accounts.ts).
      if (am && !am[2] && method === 'DELETE') { requireRole(client, 'owner'); return send(res, 200, await acc.deleteAccount(am[1], String((await readJson(req)).confirm ?? ''), by)); }
      if (am && am[2] && method === 'POST') {
        const b = await readJson(req);
        if (am[2] === 'gift') return send(res, 200, acc.giftCredits(am[1], Number(b.credits), String(b.note ?? '')));
        if (am[2] === 'credits') return send(res, 200, acc.adjustCredits(am[1], Number(b.delta), String(b.note ?? '')));
        return send(res, 200, acc.setDisabled(am[1], am[2] === 'disable', String(b.note ?? ''), by));
      }
      throw new GenError(`No admin route ${method} ${route}`, { status: 404 });
    }

    // A character's identity pack, and the director's prompts and first frames with the cast's packs (src/identityroutes.ts).
    if (await handleIdentity(client, route, method, q, req, res, send, readJson)) return;
    // Worlds (src/worldroutes.ts): /v1/worlds, /v1/stories and the world kinds' AI.
    if (await handleWorlds({ req, res, route, method, client, send, readJson })) return;

    // --------------------------------------------------------------- scenes (src/scenes.ts): every kind, plug and play
    if (route === '/v1/scenes' || route.startsWith('/v1/scenes/')) {
      const sc = await import('./scenes.ts');
      await import('./editor.ts');
      const dr = await import('./director.ts');
      await import('./scenekinds.ts');
      const user = getUserForClient(client);
      const canSee = (p: string) => canProject(client, p);
      const projectOf = (asked?: unknown) => {
        const p = fixedProject(client) ?? (typeof asked === 'string' && asked ? asked : user?.project ?? '');
        if (!p || !canProject(client, p)) throw new GenError('Name a project you can use', { status: 403 });
        return p;
      };
      // A scene as the app gets it: with the scenes it uses (what plugs in, and whether they changed since), and a stage's sequence.
      const full = (x: import('./scenes.ts').Scene) => ({ ...x, uses: sc.usedBy(x, canSee), ...(x.kind === 'stage' ? { sequenceInfo: dr.sequenceSummary(x.doc.sequence, x.project) } : {}) });
      const open = (id: string) => (sc.getScene(id, canSee).kind === 'stage' ? dr.getShot(id, canSee) : sc.getScene(id, canSee));
      if (route === '/v1/scenes' && method === 'GET') {
        const kind = q('kind');
        if (kind && !sc.KIND_IDS.includes(kind as any)) throw new GenError(`No kind of scene "${kind}"`, { status: 400 });
        return send(res, 200, { items: sc.listScenes(projectOf(q('project')), kind ?? null, Math.min(500, Number(q('limit') ?? 200) || 200)) });
      }
      if (route === '/v1/scenes' && method === 'POST') {
        const b = await readJson(req);
        const kind = String(b.kind ?? '');
        if (!sc.KIND_IDS.includes(kind as any)) throw new GenError(`kind: ${sc.KIND_IDS.join(', ')}`, { status: 400 });
        const project = projectOf(b.project);
        const k = sc.kindOf(kind);
        const doc = b.doc ?? k.blank(typeof b.title === 'string' && b.title.trim() ? b.title.trim() : 'Untitled');
        const made = kind === 'stage' ? dr.createShot(project, doc) : sc.createScene(project, kind as any, doc, kind === 'video' ? 'ep' : 'sn');
        return send(res, 200, full(made));
      }
      const xm = /^\/v1\/scenes\/((?:sn|ep|sh)_[0-9a-f]{6,24})(?:\/(render|assistant|apply|duplicate))?$/.exec(route);
      if (!xm) throw new GenError(`No scene route ${method} ${route}`, { status: 404 });
      const id = xm[1];
      if (!xm[2] && method === 'GET') return send(res, 200, full(open(id)));
      if (!xm[2] && method === 'PUT') {
        const b = await readJson(req);
        const cur = sc.getScene(id, canSee);
        try {
          if (cur.kind === 'stage') {
            const saved = dr.saveShot(cur as any, b.doc, b.version == null ? undefined : Number(b.version));
            dr.shareAcross(saved);
            return send(res, 200, full(saved));
          }
          return send(res, 200, full(sc.saveScene(cur, b.doc, b.version == null ? undefined : Number(b.version))));
        } catch (e: any) {
          if (e.status === 409) return send(res, 409, { error: e.message, scene: e.scene ? full(e.scene) : null });
          throw e;
        }
      }
      if (!xm[2] && method === 'DELETE') { sc.deleteScene(id, canSee); return send(res, 200, { ok: true }); }
      if (xm[2] === 'duplicate' && method === 'POST') {
        const cur = open(id);
        const doc = { ...cur.doc, title: `${cur.title} copy`, render: null, ...(cur.kind === 'stage' ? { sequence: null, order: 0 } : {}) };
        return send(res, 200, full(cur.kind === 'stage' ? dr.createShot(cur.project, doc) : sc.createScene(cur.project, cur.kind, doc, cur.kind === 'video' ? 'ep' : 'sn')));
      }
      if (xm[2] === 'render' && method === 'PUT') {
        // A scene's output (the film, the picture, the mixdown): it must be a file the caller can see.
        const b = await readJson(req);
        const a = getAsset(String(b.asset ?? ''));
        if (!a || !canSee(a.project)) throw new GenError('No such file', { status: 404 });
        return send(res, 200, full(sc.setRender(sc.getScene(id, canSee), { asset: a.id, kind: (b.kind ?? a.kind) as any })));
      }
      if ((xm[2] === 'assistant' || xm[2] === 'apply') && method === 'POST') {
        // The AI for image, audio and character scenes (src/sceneai.ts); video and stage have their own (editor, director).
        const ai = await import('./sceneai.ts');
        const b = await readJson(req);
        let cur = sc.getScene(id, canSee);
        if (b.doc && xm[2] === 'assistant') cur = sc.saveScene(cur, b.doc);
        const submitHere = (spec: { tool: string; params: Record<string, any>; inputs: Record<string, any>; label?: string }) =>
          submit(client, { project: cur.project, tool: spec.tool, params: spec.params, inputs: spec.inputs, labels: { by: client.name, scene: cur.id, ...(spec.label ? { title: spec.label } : {}) } } as JobSpec);
        const quote = (tool: string, params: Record<string, any>) => { try { return Number((quoteJobCredits({ project: cur.project, tool, params }) as any)?.credits ?? 0); } catch { return 0; } };
        if (xm[2] === 'apply') {
          const r = ai.applyScene(cur, { doc: b.doc ?? cur.doc, jobs: Array.isArray(b.jobs) ? b.jobs : [] }, { submit: submitHere, quote, autoCredits: 0, confirm: true });
          return send(res, 200, { scene: full(sc.saveScene(cur, r.doc)), started: r.started, errors: r.errors });
        }
        const messages = (Array.isArray(b.messages) ? b.messages : []).filter((m: any) => m && typeof m.text === 'string').map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, text: m.text }));
        if (!messages.length) throw new GenError('Say something to the AI', { status: 400 });
        const { isGenAccountProject, orgOfProject: orgOf, orgSecretInfo: secretInfo } = await import('./orgsecrets.ts');
        const ownOrg = orgOf(cur.project);
        const ownAi = Boolean(ownOrg && (secretInfo(ownOrg, 'anthropic').set || secretInfo(ownOrg, 'claude-subscription').set));
        const payer = user && isGenAccountProject(cur.project) && !ownAi ? user : null;
        if (payer) house.checkCanPay(getUserById(payer.id)?.credits ?? 0);
        const ed = await import('./editor.ts');
        const library = listAssets({ project: cur.project, limit: 40, playtest: false, projects: client.projects }).items
          .filter((a: any) => ['image', 'video', 'audio', 'mesh'].includes(a.kind))
          .map((a: any) => ({ id: a.id, kind: a.kind, title: a.title ?? null, prompt: a.recipe?.params?.prompt ?? a.recipe?.params?.text ?? null }));
        const scenes = sc.listScenes(cur.project, null, 60).filter((x) => x.id !== cur.id).map((x) => ({ id: x.id, kind: x.kind, title: x.title }));
        const turn = await ai.sceneTurn({ scene: cur, messages, selection: b.selection, library, scenes, voices: await ed.editorVoices() });
        const aiCharge = payer && turn.house ? chargeCredits(payer.id, house.turnCredits(turn.cost), 'ai_turn', `AI (${cur.kind}): ${String(messages[messages.length - 1].text).slice(0, 80)}`) : null;
        const r = ai.applyScene(cur, turn.answer, { submit: submitHere, quote, autoCredits: Math.max(0, Number(b.autoCredits ?? 40)) });
        const saved = r.proposed ? cur : sc.saveScene(cur, r.doc);
        return send(res, 200, { say: turn.answer.say, scene: full(saved), started: r.started, errors: r.errors, ...(r.proposed ? { proposed: r.proposed } : {}), model: turn.model, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}) });
      }
      throw new GenError(`No scene route ${method} ${route}`, { status: 404 });
    }

    // --------------------------------------------------------------- the director (src/director.ts)
    if (route.startsWith('/v1/director/')) {
      const dr = await import('./director.ts');
      const user = getUserForClient(client);
      const canSee = (p: string) => canProject(client, p);
      const projectOf = (asked?: unknown) => {
        const p = fixedProject(client) ?? (typeof asked === 'string' && asked ? asked : user?.project ?? '');
        if (!p || !canProject(client, p)) throw new GenError('Name a project you can use', { status: 403 });
        return p;
      };
      if (route === '/v1/director/shots' && method === 'GET') return send(res, 200, { items: dr.listShots(projectOf(q('project'))) });
      if (route === '/v1/director/shots' && method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, dr.createShot(projectOf(b.project), b.doc ?? (b.title ? { title: b.title } : undefined)));
      }
      // A shot comes with its sequence's summary (the strip of shots), and a save carries what the sequence shares.
      const withScene = (x: import('./director.ts').ShotRow) => ({ ...x, sequenceInfo: dr.sequenceSummary(x.doc.sequence, x.project) });
      const sm = /^\/v1\/director\/sequences\/((?:sq|sc)_[0-9a-f]{8})$/.exec(route);
      if (sm) {
        const p = projectOf(q('project'));
        const info = dr.sequenceSummary(sm[1], p);
        if (!info) throw new GenError('No such sequence', { status: 404 });
        if (method === 'GET') return send(res, 200, info);
        if (method === 'PUT') {
          const b = await readJson(req);
          if (typeof b.title === 'string') dr.renameSequence(sm[1], p, b.title);
          if (Array.isArray(b.order)) dr.reorderSequence(sm[1], p, b.order.map(String));
          return send(res, 200, dr.sequenceSummary(sm[1], p));
        }
      }
      const dm = /^\/v1\/director\/shots\/((?:sh|sn)_[0-9a-f]+)(?:\/(assistant|blender|next))?$/.exec(route);
      if (dm) {
        const id = dm[1];
        if (!dm[2] && method === 'GET') return send(res, 200, withScene(dr.getShot(id, canSee)));
        if (dm[2] === 'next' && method === 'POST') return send(res, 200, withScene(dr.addShotAfter(dr.getShot(id, canSee))));
        if (!dm[2] && method === 'PUT') {
          const b = await readJson(req);
          try {
            const saved = dr.saveShot(dr.getShot(id, canSee), b.doc, b.version == null ? undefined : Number(b.version));
            dr.shareAcross(saved);
            return send(res, 200, withScene(saved));
          } catch (e: any) {
            if (e.status === 409) return send(res, 409, { error: e.message, shot: e.shot });
            throw e;
          }
        }
        if (!dm[2] && method === 'DELETE') { dr.deleteShot(id, canSee); return send(res, 200, { ok: true }); }
        if (dm[2] === 'assistant' && method === 'POST') {
          // The AI director: the conversation and the shot in, the changed shot out (saved). Like the AI editor, a Gen
          // account without its own Claude runs on the house AI and pays in credits.
          const b = await readJson(req);
          let sh = dr.getShot(id, canSee);
          if (b.doc) sh = dr.saveShot(sh, b.doc);
          const messages = (Array.isArray(b.messages) ? b.messages : []).filter((m: any) => m && typeof m.text === 'string').map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, text: m.text }));
          if (!messages.length) throw new GenError('Say something to the director', { status: 400 });
          const { isGenAccountProject, orgOfProject: orgOf, orgSecretInfo: secretInfo } = await import('./orgsecrets.ts');
          const ownOrg = orgOf(sh.project);
          const ownAi = Boolean(ownOrg && (secretInfo(ownOrg, 'anthropic').set || secretInfo(ownOrg, 'claude-subscription').set));
          const payer = user && isGenAccountProject(sh.project) && !ownAi ? user : null;
          if (payer) house.checkCanPay(getUserById(payer.id)?.credits ?? 0);
          const library = listAssets({ project: sh.project, limit: 60, playtest: false, projects: client.projects }).items
            .filter((a: any) => a.kind === 'mesh' || (a.kind === 'image' && a.tool === 'image.panorama'))
            .map((a: any) => ({ id: a.id, kind: a.kind, title: a.title ?? null, prompt: a.recipe?.params?.prompt ?? null }));
          const seqInfo = dr.sequenceSummary(sh.doc.sequence, sh.project);
          const sequence = seqInfo ? { title: seqInfo.title, shots: dr.sequenceShots(sh.doc.sequence!, sh.project).map((x) => ({ ...x.doc, shotId: x.id })) } : null;
          const ed = await import('./editor.ts');
          const sc = await import('./scenes.ts');
          const characters = sc.listScenes(sh.project, 'character', 40).map((x) => ({ id: x.id, name: x.title, description: '' }));
          const turn = await dr.directorTurn({ project: sh.project, shot: sh.doc, shotId: sh.id, sequence, characters, voices: await ed.editorVoices(), messages, library, selection: b.selection && typeof b.selection === 'object' ? b.selection : undefined });
          const aiCharge = payer && turn.house ? chargeCredits(payer.id, house.turnCredits(turn.cost), 'ai_turn', `Director: ${String(messages[messages.length - 1].text).slice(0, 80)}`) : null;
          const shown = dr.applyDirector(sh.project, sh, turn.answer);
          return send(res, 200, { say: turn.answer.say, shot: withScene(dr.getShot(shown.id, canSee)), model: turn.model, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}) });
        }
        if (dm[2] === 'blender' && method === 'POST') {
          // Films the shot with Gen's Blender pipeline (cinemaPass) as one asset.make job. ?quote=1 prices it only.
          const sh = dr.getShot(id, canSee);
          const { recipe, files } = dr.blenderRecipe(sh.doc, dr.shotPacks(sh.doc, sh.project));
          const params = { steps: recipe.steps, candidates: recipe.candidates, pickAt: recipe.pickAt, pick: recipe.pick, ...(recipe.refs ? { refs: recipe.refs } : {}), ...(recipe.canon ? { canon: recipe.canon } : {}) };
          if (q('quote') === '1') return send(res, 200, { quote: quoteJobCredits({ project: sh.project, tool: 'asset.make', params } as any), notes: recipe.notes });
          const job = await submitJob(client, { project: sh.project, tool: 'asset.make', params, inputs: { files }, labels: { by: client.name, director: sh.id, title: `Shot: ${sh.doc.title}` } } as JobSpec);
          return send(res, 200, { job: summary(job), notes: recipe.notes });
        }
      }
      throw new GenError(`No director route ${method} ${route}`, { status: 404 });
    }

    // --------------------------------------------------------------- the editor (src/editor.ts)
    if (route.startsWith('/v1/editor/')) {
      const ed = await import('./editor.ts');
      const user = getUserForClient(client);
      const canSee = (p: string) => canProject(client, p);
      const projectOf = (asked?: unknown) => {
        const p = fixedProject(client) ?? (typeof asked === 'string' && asked ? asked : user?.project ?? '');
        if (!p || !canProject(client, p)) throw new GenError('Name a project you can use', { status: 403 });
        return p;
      };
      const submitFor = (project: string, editorId: string): import('./editor.ts').Submit => (spec) =>
        submit(client, { project, tool: spec.tool, params: spec.params, inputs: spec.inputs, labels: { by: client.name, editor: editorId, ...(spec.label ? { title: spec.label } : {}) } } as JobSpec);
      if (route === '/v1/editor/tools' && method === 'GET') return send(res, 200, { tools: ed.availableEditorTools(), tracks: ed.TRACKS });
      if (route === '/v1/editor/voices' && method === 'GET') return send(res, 200, { voices: await ed.editorVoices() });
      if (route === '/v1/editor/catalog' && method === 'GET') {
        const { isDown } = await import('./providers/gpu/health.ts');
        const noAws = (() => { try { fleet.awsConfig(); return false; } catch { return true; } })();
        const list = client.role === 'user' ? TOOLS.filter((t) => !isInternalOnlyTool(t.id)) : TOOLS;
        return send(res, 200, { tools: await ed.catalog(describeTool, list, noAws || Boolean(isDown('fleet')), loadSettings()) });
      }
      if (route === '/v1/editor/projects' && method === 'GET') return send(res, 200, { items: ed.listProjects(projectOf(q('project'))) });
      if (route === '/v1/editor/projects' && method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, ed.createProject(projectOf(b.project), b.doc ?? (b.title ? { title: b.title } : undefined)));
      }
      const pm = /^\/v1\/editor\/projects\/((?:ep|sn)_[0-9a-f]{12})(?:\/(apply|assistant))?$/.exec(route);
      if (pm) {
        const [, id, action] = pm;
        if (!action && method === 'GET') return send(res, 200, ed.getProject(id, canSee));
        if (!action && method === 'DELETE') { ed.deleteProject(id, canSee); return send(res, 200, { ok: true }); }
        if (!action && method === 'PUT') {
          const b = await readJson(req);
          try {
            return send(res, 200, ed.saveDoc(ed.getProject(id, canSee), b.doc, b.version == null ? undefined : Number(b.version)));
          } catch (e: any) {
            if (e.status === 409) return send(res, 409, { error: e.message, project: e.project });
            throw e;
          }
        }
        if (action === 'apply' && method === 'POST') {
          const b = await readJson(req);
          const p = ed.getProject(id, canSee);
          const r = ed.applyOps(p.doc, Array.isArray(b.ops) ? b.ops : [], submitFor(p.project, id), ed.timelineKind(p.kind));
          return send(res, 200, { project: ed.saveDoc(p, r.doc), results: r.results });
        }
        if (action === 'assistant' && method === 'POST') {
          // The AI editor: the person's words, their selection and (optionally) their latest document in; the answer's
          // words and edits out, already applied. Generating that costs more than the auto limit comes back as
          // `proposed` for one tap (POST .../apply with those ops).
          const b = await readJson(req);
          let p = ed.getProject(id, canSee);
          if (b.doc) {
            try { p = ed.saveDoc(p, b.doc, b.version == null ? undefined : Number(b.version)); } catch (e: any) {
              if (e.status === 409) return send(res, 409, { error: e.message, project: e.project });
              throw e;
            }
          }
          const messages = (Array.isArray(b.messages) ? b.messages : []).filter((m: any) => m && typeof m.text === 'string').map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }));
          if (!messages.length) throw new GenError('Say something to the AI editor', { status: 400 });
          const library = listAssets({ project: p.project, limit: 40, playtest: false, projects: client.projects }).items
            .filter((a: any) => ['image', 'video', 'audio', 'mesh'].includes(a.kind))
            .map((a: any) => ({ id: a.id, kind: a.kind, title: a.title ?? null, prompt: a.recipe?.params?.prompt ?? a.recipe?.params?.text ?? null, duration: a.meta?.duration ?? null }));
          // A Gen app account without its own Claude runs on the house AI and pays for it in credits (src/houseai.ts).
          const { isGenAccountProject, orgOfProject: orgOf, orgSecretInfo: secretInfo } = await import('./orgsecrets.ts');
          const ownOrg = orgOf(p.project);
          const ownAi = Boolean(ownOrg && (secretInfo(ownOrg, 'anthropic').set || secretInfo(ownOrg, 'claude-subscription').set));
          const payer = user && isGenAccountProject(p.project) && !ownAi ? user : null;
          if (payer) house.checkCanPay(getUserById(payer.id)?.credits ?? 0);
          const turn = await ed.assistantTurn({ project: p.project, doc: p.doc, selection: b.selection ?? {}, messages, library, voices: await ed.editorVoices(), kind: ed.timelineKind(p.kind) });
          const aiCharge = payer && turn.house ? chargeCredits(payer.id, house.turnCredits(turn.cost), 'ai_turn', `AI editor: ${String(messages[messages.length - 1].text).slice(0, 80)}`) : null;
          const auto = Math.max(0, Number(b.autoCredits ?? 40));
          const now: typeof turn.ops = [];
          const proposed: typeof turn.ops = [];
          let spend = 0;
          for (const op of turn.ops) {
            if (op.op !== 'generate') { now.push(op); continue; }
            let credits = 0;
            try { credits = Number((quoteJobCredits({ project: p.project, tool: String(op.tool), params: op.params ?? {} }) as any)?.credits ?? 0); } catch { /* unknown tool: applyOps says so */ }
            op.credits = credits;
            if (proposed.length || spend + credits > auto) proposed.push(op); else { spend += credits; now.push(op); }
          }
          const r = ed.applyOps(p.doc, now, submitFor(p.project, id), ed.timelineKind(p.kind));
          const saved = ed.saveDoc(p, r.doc);
          return send(res, 200, {
            say: turn.say, project: saved, results: r.results, model: turn.model, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}),
            ...(proposed.length ? { proposed: { ops: proposed, credits: proposed.reduce((s, o) => s + (o.credits ?? 0), 0) } } : {}),
          });
        }
      }
      throw new GenError('No such editor route', { status: 404 });
    }
    // Canned AI answers for the test account (src/aimock.ts): HAWKESGEN_AI_MOCK=1 and a test sign-in session only.
    if (route === '/v1/test/ai-mock') {
      const am = await import('./aimock.ts');
      const user = getUserForClient(client);
      if (!am.aiMockOn() || !user || !am.isTestUser(user.id)) return send(res, 404, { error: 'No such route' });
      if (method === 'GET') return send(res, 200, am.mockStatus(user.id));
      if (method === 'DELETE') return send(res, 200, am.clearAnswers(user.id));
      if (method === 'POST') { const b = await readJson(req); return send(res, 200, am.queueAnswers(user.id, Array.isArray(b?.answers) ? b.answers : [b])); }
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
      const checkout = await createStripeCheckoutSession(user, body, origin || 'https://hawkesgen.ai');
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
    // Subscribing (subscriptions.ts): a plan's Stripe checkout, cancel and resume at the period's end, the billing portal.
    if (route === '/v1/subscriptions/checkout' && method === 'POST') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('Sign in to subscribe', { status: 403 });
      const S = await import('./subscriptions.ts');
      return send(res, 200, await S.subscriptionCheckout(user, String((await readJson(req)).planId ?? ''), origin || 'https://hawkesgen.ai'));
    }
    if ((route === '/v1/subscriptions/cancel' || route === '/v1/subscriptions/resume') && method === 'POST') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('Sign in first', { status: 403 });
      const S = await import('./subscriptions.ts');
      return send(res, 200, { subscription: await S.setCancelAtPeriodEnd(user, route.endsWith('cancel')) });
    }
    if (route === '/v1/billing/portal' && method === 'POST') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('Sign in first', { status: 403 });
      const S = await import('./subscriptions.ts');
      return send(res, 200, await S.billingPortal(user, origin || 'https://hawkesgen.ai'));
    }
    if (route === '/v1/subscriptions/me' && method === 'GET') {
      const user = getUserForClient(client);
      if (!user) throw new GenError('Subscriptions are for user accounts only', { status: 403 });
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
    // Gen Bench and the quality checks (src/bench/routes.ts, docs/bench.md): admins only.
    if (await handleBench(client, route, method, () => readJson(req), res, send)) return;

    // The making loop: feedback, quotes, routing, the learning's proposals, the owner's knobs (src/make/routes.ts, docs/make.md).
    if (await handleMake(client, route, method, q, res, send, () => readJson(req))) return;

    // The showrunner: one AI for every scene, and productions on the server (src/showrunner/, docs/showrunner.md).
    if (await handleShowrunner(req, res, client, route, method, readJson, send, handle)) return;

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
        { client, project: user.project, payerId: user.id },
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
      const user = getUserForClient(client);
      const code = await assistant.getCodeSuggestions({ client, project: user?.project ?? client.projects.find((p) => p !== '*') ?? '', payerId: user?.id ?? null }, {
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
    // What Gen knows about a tool (src/knowledge.ts): its craft notes, models, every node and setting.
    m = /^\/v1\/knowledge\/tools\/([\w.-]+)$/.exec(route);
    if (m && method === 'GET') {
      if (client.role === 'user' && isInternalOnlyTool(m[1])) throw new GenError(`No tool ${m[1]}`, { status: 404 });
      const { toolCard } = await import('./knowledge.ts');
      const card = toolCard(m[1]);
      if (!card) throw new GenError(`No tool ${m[1]}`, { status: 404 });
      // A customer reads the craft in plain words, without the models, the graph's nodes or where it came from (J,
      // 2026-10-30: nothing that says what Gen is made of).
      if (isCustomer(client)) {
        const plain = (v: any): any => (typeof v === 'string' ? publicText(v) : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
        const { models: _m, nodes: _n, source: _s, ...rest } = card as any;
        return send(res, 200, { ...plain(rest), id: (card as any).id, pairsWith: (card as any).pairsWith, nodes: [], models: [] });
      }
      return send(res, 200, card);
    }
    if (route === '/v1/knowledge/map' && method === 'GET') {
      const { toolMap } = await import('./knowledge.ts');
      const { aiCanUse } = await import('./editor.ts');
      return send(res, 200, { map: toolMap(client.role === 'user' ? aiCanUse : undefined) });
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
      const made: Job[] = [];
      for (const s of specs) made.push(await submitLogged(client, s));
      return send(res, 200, { jobs: made.map(summary).map((j) => publicJob(j, isCustomer(client))) });
    }
    if (route === '/v1/run' && method === 'POST') {
      // Submit and wait (up to timeout seconds, default 10 minutes). Handy for scripts and quick tools.
      const body = await readJson(req);
      const job = await submitLogged(client, body);
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
      return send(res, 200, publicJob(final, isCustomer(client)));
    }
    if (route === '/v1/jobs' && method === 'GET') {
      if (q('project') && !canProject(client, q('project')!)) throw new GenError('No access to that project', { status: 403 });
      const projectFilter = fixedProject(client) ?? q('project');
      return send(res, 200, { jobs: listJobs({ project: projectFilter, status: q('status'), tool: q('tool'), limit: Number(q('limit')) || 100, projects: client.projects }).map(summary).map((j) => publicJob(j, isCustomer(client))) });
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
      if (!m[2] && method === 'GET') return send(res, 200, publicJob({ ...j, queue: queuePosition(j), ...(j.status === 'queued' || j.status === 'running' ? { estimateSeconds: typicalRunSeconds(j.tool) } : {}) }, isCustomer(client)));
      if (m[2] === 'cancel' && method === 'POST') return send(res, 200, cancel(j.id));
      if (m[2] === 'rerun' && method === 'POST') {
        const b = await readJson(req);
        // Changing priority is the scheduler's business: admins and up (Studio), like boosts.
        if (b.priority !== undefined) requireRole(client, 'admin');
        return send(res, 200, await rerunJob(client, j.id, { sameSeed: b.sameSeed === true, params: b.params, inputs: b.inputs, labels: b.labels, priority: b.priority === undefined ? undefined : Number(b.priority) }));
      }
      // A playtest's live state (every step, the players, problems, the timeline); null after the run (the job has the result).
      if (m[2] === 'live' && method === 'GET') return send(res, 200, { job: j.id, status: j.status, detail: isCustomer(client) ? publicText(j.detail ?? null) : j.detail ?? null, live: liveSnapshot(j.id, { full: true }) });
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
      // A job's ComfyUI graphs are the studio's own (they say what Gen is made of): never a customer's.
      if (m[2]?.startsWith('graphs/') && method === 'GET') {
        if (isCustomer(client)) throw new GenError('No such graph', { status: 404 });
        const name = m[2].slice(7);
        if (!j.graphs.includes(name)) throw new GenError('No such graph', { status: 404 });
        return serveFile(req, res, path.join(paths.graphs, name), 'application/json', { 'Content-Disposition': `attachment; filename="${name}"` });
      }
    }

    // --------------------------------------------------------------- events
    if (route === '/v1/events' && method === 'GET') {
      // No buffering anywhere on the way (the gen-edge Worker streams it through, Cloud Run too): no-transform and
      // X-Accel-Buffering keep proxies from holding events back; the 20 s ping below keeps idle connections open.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n: hello\n\n');
      const onJob = (j: any) => jobVisible(client, j) && res.write(`event: job\ndata: ${JSON.stringify(publicJob(j, isCustomer(client)))}\n\n`);
      // Library changes (src/entities.ts): an entity edited, a take filed, picked or discarded.
      const onLibrary = (e: any) => canProject(client, String(e.entity).split('/')[0]) && res.write(`event: library\ndata: ${JSON.stringify(e)}\n\n`);
      events.on('job', onJob);
      events.on('library', onLibrary);
      // Productions (src/showrunner/production.ts): progress, and "done" when one finishes.
      const onProduction = (e: any) => canProject(client, String(e.project)) && res.write(`event: production
data: ${JSON.stringify(e)}

`);
      events.on('production', onProduction);
      // A scene saved (src/scenes.ts): an open editor, character sheet or world picks up edits made elsewhere (the AI, MCP,
      // another tab) and fills in finished jobs without asking on a timer. Only ids and versions; the page reads the scene.
      const onScene = (e: any) => canProject(client, String(e.project)) && res.write(`event: scene\ndata: ${JSON.stringify(e)}\n\n`);
      events.on('scene', onScene);
      // The studio's machinery (admins only): a machines reading was taken, or a bench run moved on. The page reads what it shows.
      const ops = !isCustomer(client);
      const onMachines = (e: any) => res.write(`event: machines\ndata: ${JSON.stringify(e)}\n\n`);
      const onBench = (e: any) => res.write(`event: bench\ndata: ${JSON.stringify(e)}\n\n`);
      if (ops) { events.on('machines', onMachines); events.on('bench', onBench); }
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        events.off('job', onJob);
        events.off('library', onLibrary);
        events.off('production', onProduction);
        events.off('scene', onScene);
        events.off('machines', onMachines);
        events.off('bench', onBench);
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
          if (!p || !canUseBlob(client, file.slice(5))) throw new GenError(`No blob ${file.slice(5)}`, { status: 404 });
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
        const job = await submitJob(client, { ...spec, labels: { ...spec.labels, by: client.name }, priority: b.priority, reuse: b.reuse ?? false } as JobSpec);
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
      ownBlob(sha, client);
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
      // A video, image or sound that the editor's tools or a browser can't use as it is (WebM, HEVC, variable frame rate,
      // WebP, HEIC, CMYK JPEG, Opus...) gets a media.normalize job queued, unless ?normalize=0. The upload itself is kept
      // as sent; the app waits for the job and uses its output instead (docs/api.md, "Uploads").
      const norm = await uploadNormalize(client, targetProject, asset, ext, ctype, q('normalize'));
      return send(res, 200, { ...asset, asset, blob: `blob:${sha}`, ...norm });
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
      // Share (the app): a link anyone can open for a week, that shows the file in their browser.
      if (m[1] === 'assets' && !m[3] && method === 'POST' && q('share') != null) {
        if (!canProject(client, a.project)) throw new GenError('No access to that asset', { status: 403 });
        const title = String(q('name') || a.title || a.id).replace(/[^\w .-]+/g, '').trim() || a.id;
        return send(res, 200, { url: shareLink('', a.id, `${title}${path.extname(a.path)}`), expires: Date.now() + 7 * 24 * 3600 * 1000 });
      }
      // A signed link to the file for a browser with no session (Studio's playtest videos and screenshots): ?ttl= days (max 30).
      if (m[1] === 'assets' && !m[3] && method === 'POST' && q('sign') != null) {
        if (!canProject(client, a.project)) throw new GenError('No access to that asset', { status: 403 });
        return send(res, 200, signedFileUrl('', a.id, Number(q('ttl') || 7) * 24 * 3600 * 1000));
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
      const sha = putBlob(data, ext);
      ownBlob(sha, client);
      return send(res, 200, { blob: `blob:${sha}`, bytes: data.length });
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
        // Only what this caller may use: its blobs and assets it can see. Raw paths only for owner keys (games on
        // this machine), as for job inputs: a customer must not learn what files exist on the server.
        const one = async (ref: string) => {
          if (ref.startsWith('blob:')) return canUseBlob(client, ref.slice(5)) ? ref.slice(5) : 'missing';
          if (ref.startsWith('asset:')) {
            const a = getAsset(ref.slice(6));
            return a && canProject(client, a.project) ? a.sha256 : 'missing';
          }
          if (client.role !== 'owner') throw new GenError('Send inputs as blob:<sha256> or asset:<id>', { status: 403 });
          return sha256File(ref);
        };
        inputs[k] = Array.isArray(v) ? await Promise.all(v.map(one)) : await one(v);
      }
      const key = recipeKey({ tool: t.id, version: t.version, params, inputs, models: t.models?.(params) });
      if (body.project && !canProject(client, String(body.project))) throw new GenError(`No access to project ${body.project}`, { status: 403 });
      const asset = findByRecipe(key, body.project, client.projects);
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

    // ------------------------------------------------- Studio's playtest capacity setting (docs/playtest-runpod.md, "Capacity")
    // GET: browsers at once (the RunPod lane), the most the account allows, every provider in order with why it can't
    // play now. PUT (or POST): { browsers?, providers?, modal?, runpod?: { workerQuota } }. The studio's own key (owner)
    // only for changes; customers' keys never reach it (OPS_ROUTES).
    if (route === '/v1/playtest/capacity' && method === 'GET') {
      requireRole(client, 'admin');
      const { playtestCapacity } = await import('./providers/playtester/capacity.ts');
      return send(res, 200, await playtestCapacity(loadSettings()));
    }
    if (route === '/v1/playtest/capacity' && (method === 'PUT' || method === 'POST')) {
      requireRole(client, 'owner');
      const { setPlaytestCapacity, CapacityError } = await import('./providers/playtester/capacity.ts');
      try {
        return send(res, 200, await setPlaytestCapacity(await readJson(req), loadSettings()));
      } catch (e: any) {
        if (e instanceof CapacityError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }

    // ------------------------------------------------- playtests on Cloud Run (docs/playtest-cloudrun.md)
    // The settings, the lanes and the price; ?selftest=1 also asks the service how WebGL reaches its GPU (that may start
    // an instance: about $0.03 for its cold start and test, plus its idle tail). fresh=1 reruns it, all=1 tries every path.
    // ?variant=cpu: the CPU service (gen-playtest-cpu, software WebGL; its self-test also times a WebGL loop).
    // ?variant=runpod: the RunPod endpoint (docs/playtest-runpod.md; a self-test there starts a worker, about $0.01).
    if (route === '/v1/playtester/cloud' && method === 'GET') {
      requireRole(client, 'owner');
      const pc = await import('./providers/playtester/cloudrun.ts');
      const s = loadSettings();
      const project = url.searchParams.get('project');
      const v = url.searchParams.get('variant');
      const variant = v === 'cpu' ? 'cpu' : v === 'runpod' ? 'runpod' : v === 'modal' ? 'modal' : 'gpu';
      // One service: the variant asked for (?variant=modal: the Modal endpoint; a self-test there starts a container, about $0.02).
      const c = pc.cloudPlaytestFor(project, { playtest: { ...s.playtest, projects: {}, disabled: [], order: variant === 'modal' ? ['modal'] : [], backend: variant === 'cpu' ? 'cloudrun-cpu' : variant === 'runpod' ? 'runpod' : 'cloudrun' } });
      const out: any = { settings: s.playtest, backendFor: project ? pc.playtestBackendOf(project, s.playtest) : s.playtest.backend, deployed: Boolean(c) };
      if (c) Object.assign(out, { service: c.name, variant: c.variant, region: c.region, lanes: pc.cloudLanes(c), pricePerHour: Math.round(c.pricePerSecond * 3600 * 100) / 100, perTabMinute: Math.round(pc.tabCost(c, 60) * 10_000) / 10_000 });
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
    if (route === '/v1/presets' && method === 'GET') return send(res, 200, { projects: listPresets().filter((p) => canProject(client, p.project) || p.project === 'shared') });
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
      // Customers see their own projects' usage only; the whole studio's is for admins.
      return send(res, 200, usageSummary({ since, by: (q('by') as any) ?? 'project', projects: client.role === 'user' ? client.projects : ['*'] }));
    }
    if (route === '/v1/providers/elevenlabs/voices' && method === 'GET') return send(res, 200, { voices: await eleven.voices({ force: q('refresh') === '1' }) });
    // The open audio models: licence, size, what each can do, and which the `auto` provider trusts (docs/audio.md).
    if (route === '/v1/audio/models' && method === 'GET') {
      const verified = new Set(loadSettings().audio.verified);
      return send(res, 200, { models: AUDIO_MODELS.map((m) => ({ ...m, verified: verified.has(m.id), selectable: !m.blocked && m.license.commercial !== false })), refused: REFUSED_MODELS, verified: [...verified], targetLufs: loadSettings().audio.targetLufs });
    }
    // A house voice's sample (src/audio/house.ts): its saved reference clip, the app's voice preview.
    const hv = /^\/v1\/audio\/house\/(hv_[a-z0-9_]+)\/preview$/.exec(route);
    if (hv && method === 'GET') {
      const { houseReference } = await import('./audio/house.ts');
      const { refPath } = await import('./audio/voicelib.ts');
      const v = houseReference(hv[1]);
      const file = v ? refPath(v) : null;
      if (!file || !fs.existsSync(file)) throw new GenError('This house voice has no sample yet', { status: 404 });
      return serveFile(req, res, file, mimeOf(file), { 'Cache-Control': 'private, max-age=3600' });
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
      if (route === '/v1/claude/token' && method === 'POST') { const b = await readJson(req); return send(res, 200, ca.addToken(String(b.token ?? ''), String(b.label ?? ''), client.name)); }
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
