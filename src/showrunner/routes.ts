// The showrunner's routes (docs/showrunner.md, docs/api.md). A Gen key or the app's sign-in, like the rest of /v1.
//   POST /v1/showrunner/turn {messages, scene, selection, world, autoCredits, browser, production, ...the scene's own body}
//        one entry for the AI pane: small edits answered by the scene's own assistant (same shape as its route, plus
//        `role`), productions as {say, production} with the approval card
//   GET  /v1/showrunner/productions                     the caller's productions, newest first
//   GET  /v1/showrunner/productions/:id                 one, with its steps and progress
//   POST /v1/showrunner/productions/:id/approve|dismiss|pause|resume|cancel
//   POST /v1/showrunner/productions/:id/browser         the page is open with a stage (it may film action shots there)
//   POST /v1/showrunner/productions/:id/claim {step}    the stage takes a shot;  .../finish {step, asset} it filmed it
//   POST /v1/showrunner/review {scene, t, box, text}    review mode: a new take of the shot at that moment
//   POST /v1/showrunner/productions/:id/keep|undo       review mode: the new take into the cut, or back out
//   GET|PUT|DELETE /v1/showrunner/memory                what the showrunner remembers about this account

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { canProject, fixedProject, type Client } from '../auth.ts';
import { getUserForClient, getUserById } from '../users.ts';
import { orgOfProject, orgSecretInfo, isGenAccountProject } from '../orgsecrets.ts';
import { checkCanPay } from '../houseai.ts';
import { getScene } from '../scenes.ts';
import { GenError } from '../util.ts';
import { showrunnerTurn, reviewFix, type Message } from './index.ts';
import { getProduction, listProductions, publicProduction, approve, dismiss, pause, resume, cancelProduction, seenBrowser, claimShot, finishClaim, keepFix, undoFix, fixResult, advance, startRunner } from './production.ts';
import { getMemory, editMemory, forgetMemory, memorySummary } from './memory.ts';

type Send = (res: ServerResponse, status: number, body: unknown) => void;
type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;

if (process.env.HAWKESGEN_SHOWRUNNER_RUNNER !== '0') startRunner();

/** A Gen app account on the house AI pays for its turns in credits (like the AI editor); its own Claude costs nothing here. */
function payerOf(client: Client, project: string): string | null {
  const user = getUserForClient(client);
  if (!user || !isGenAccountProject(project)) return null;
  const org = orgOfProject(project);
  const own = Boolean(org && (orgSecretInfo(org, 'anthropic').set || orgSecretInfo(org, 'claude-subscription').set));
  return own ? null : user.id;
}

/** Asks one of Gen's own routes (an assistant) as the same caller, and keeps its answer. */
async function delegate(req: IncomingMessage, handle: Handle, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const data = Buffer.from(JSON.stringify(body));
  const inner = Readable.from([data]) as any;
  inner.headers = { ...req.headers, 'content-type': 'application/json', 'content-length': String(data.length) };
  delete inner.headers.origin;
  inner.url = path;
  inner.method = 'POST';
  inner.socket = req.socket;
  inner.connection = req.socket;
  let status = 200;
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res: any = {
    headersSent: false, statusCode: 200,
    setHeader: (k: string, v: unknown) => { headers[k.toLowerCase()] = v; },
    getHeader: (k: string) => headers[k.toLowerCase()],
    writeHead(s: number, h?: Record<string, unknown>) { status = s; res.statusCode = s; res.headersSent = true; Object.assign(headers, h ?? {}); return res; },
    write(c: any) { chunks.push(Buffer.from(c)); return true; },
    end(c?: any) { if (c) chunks.push(Buffer.from(c)); return res; },
    on() { return res; }, once() { return res; }, off() { return res; }, removeListener() { return res; },
  };
  await handle(inner, res);
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
  return { status: res.statusCode ?? status, body: parsed };
}

/** Answers a /v1/showrunner route; false when the route isn't one. */
export async function handleShowrunner(req: IncomingMessage, res: ServerResponse, client: Client, route: string, method: string, readJson: (req: IncomingMessage) => Promise<any>, send: Send, handle: Handle): Promise<boolean> {
  if (!route.startsWith('/v1/showrunner/')) return false;
  const user = getUserForClient(client);
  const projectOf = (asked?: unknown) => {
    const p = fixedProject(client) ?? (typeof asked === 'string' && asked ? asked : user?.project ?? '');
    if (!p || !canProject(client, p)) throw new GenError('Name a project you can use', { status: 403 });
    return p;
  };
  const canSee = (p: string) => canProject(client, p);

  if (route === '/v1/showrunner/turn' && method === 'POST') {
    const b = await readJson(req);
    const messages: Message[] = (Array.isArray(b.messages) ? b.messages : []).filter((m: any) => m && typeof m.text === 'string').map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text }));
    if (!messages.length) throw new GenError('Say something to the AI', { status: 400 });
    const scene = typeof b.scene === 'string' && b.scene ? getScene(b.scene, canSee) : null;
    const project = scene?.project ?? projectOf(b.project);
    const payer = payerOf(client, project);
    if (payer) checkCanPay(getUserById(payer)?.credits ?? 0);
    const production = typeof b.production === 'string' ? getProduction(b.production, project) : null;
    const { messages: _m, scene: _s, production: _p, world: _w, autoCredits: _a, browser: _b, project: _pr, ...forward } = b;
    const out = await showrunnerTurn({
      client, project, payer, messages, selection: b.selection, world: typeof b.world === 'string' ? b.world : null,
      scene: scene ? { id: scene.id, kind: scene.kind, doc: b.doc && typeof b.doc === 'object' ? b.doc : scene.doc } : null,
      autoCredits: Math.max(0, Number(b.autoCredits ?? 40)), browser: Boolean(b.browser), production, forward,
      delegate: (path, body) => delegate(req, handle, path, body),
    });
    send(res, out.status, out.body);
    return true;
  }

  if (route === '/v1/showrunner/productions' && method === 'GET') {
    send(res, 200, { items: listProductions(projectOf(new URL(req.url ?? '/', 'http://x').searchParams.get('project'))).map(publicProduction) });
    return true;
  }
  const pm = /^\/v1\/showrunner\/productions\/(pr_[0-9a-f]{12})(?:\/(approve|dismiss|pause|resume|cancel|browser|claim|finish|keep|undo))?$/.exec(route);
  if (pm) {
    const p = getProduction(pm[1], canSee);
    if (!p) throw new GenError('No such production', { status: 404 });
    if (!pm[2] && method === 'GET') { if (p.out.fix) fixResult(p); send(res, 200, publicProduction(p)); return true; }
    if (pm[2] && method === 'POST') {
      const b = await readJson(req);
      switch (pm[2]) {
        case 'approve': {
          const payer = p.payer ?? (user && isGenAccountProject(p.project) ? user.id : null);
          approve(p, { credits: payer ? getUserById(payer)?.credits ?? 0 : null });
          await advance(p.id);
          break;
        }
        case 'dismiss': dismiss(p); break;
        case 'pause': pause(p); break;
        case 'resume': resume(p); await advance(p.id); break;
        case 'cancel': { const r = cancelProduction(p); send(res, 200, { ...publicProduction(r.production), uncharged: r.uncharged }); return true; }
        case 'browser': seenBrowser(p, Math.min(600, Math.max(30, Number(b.seconds) || 120))); break;
        case 'claim': send(res, 200, { step: claimShot(p, String(b.step ?? '')) }); return true;
        case 'finish': finishClaim(p, String(b.step ?? ''), String(b.asset ?? '')); await advance(p.id); break;
        case 'keep': keepFix(p); break;
        case 'undo': undoFix(p); break;
      }
      send(res, 200, publicProduction(getProduction(p.id)!));
      return true;
    }
  }

  if (route === '/v1/showrunner/review' && method === 'POST') {
    const b = await readJson(req);
    const scene = getScene(String(b.scene ?? ''), canSee);
    if (scene.kind !== 'video') throw new GenError('Review mode works on a video scene', { status: 400 });
    const payer = payerOf(client, scene.project);
    if (payer) checkCanPay(getUserById(payer)?.credits ?? 0);
    const box = b.box && typeof b.box === 'object' ? { x: Number(b.box.x) || 0, y: Number(b.box.y) || 0, w: Number(b.box.w) || 0, h: Number(b.box.h) || 0 } : null;
    const text = String(b.text ?? '').trim();
    if (!text) throw new GenError('Say what is wrong with this moment', { status: 400 });
    send(res, 200, await reviewFix({ client, project: scene.project, payer, scene: { id: scene.id, doc: scene.doc }, t: Number(b.t) || 0, box, text, autoCredits: Math.max(0, Number(b.autoCredits ?? 40)) }));
    return true;
  }

  if (route === '/v1/showrunner/memory') {
    // An account's memory is its own: always the caller's own project, never one named in the request.
    const project = fixedProject(client) ?? user?.project;
    if (!project) throw new GenError('Memory belongs to a Gen account', { status: 403 });
    if (method === 'GET') { send(res, 200, { memory: getMemory(project), summary: memorySummary(project) }); return true; }
    if (method === 'PUT' || method === 'POST') { const m = editMemory(project, await readJson(req)); send(res, 200, { memory: m, summary: memorySummary(project) }); return true; }
    if (method === 'DELETE') { send(res, 200, { memory: forgetMemory(project), summary: '' }); return true; }
  }
  throw new GenError(`No showrunner route ${method} ${route}`, { status: 404 });
}
