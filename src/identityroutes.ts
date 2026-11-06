// The identity routes (docs/identity.md): a character's pack (make, describe, lock, unlock, its LoRA), and the
// director's prompts and first-frame job with every cast member's pack in them, and the identity check on a first
// frame. One dispatch line in src/api.ts sends these here.
//
//   GET  /v1/scenes/:id/identity               the pack, the "Make their look" plan, the LoRA offer
//   POST /v1/scenes/:id/identity/describe      Claude writes the fixed description (50-80 words); saved as a draft lock
//   POST /v1/scenes/:id/identity/lock          {description?, sheet?}: the person approves the pack
//   POST /v1/scenes/:id/identity/unlock        back to a draft (the sheet and words stay to redo)
//   POST /v1/scenes/:id/identity/lora[?quote=1]  "Keep <name> consistent everywhere": prices, then trains (lora.train)
//   POST /v1/director/prompts                  {doc, shot?, look?, camera?, screen?, loraReady?, strong?}: prompts + firstFrame
//   POST /v1/director/identity-check           {asset, shot? | doc}: assess (src/quality) against each known face

import type { IncomingMessage, ServerResponse } from 'node:http';
import { canProject, fixedProject, type Client } from './auth.ts';
import { db } from './db.ts';
import { GenError } from './util.ts';
import { getAsset } from './library.ts';
import { submit, type JobSpec } from './jobs.ts';
import { quoteJobCredits, chargeCredits } from './billing.ts';
import { getUserForClient, getUserById } from './users.ts';
import * as house from './houseai.ts';
import { ask, callScope } from './providers/anthropic.ts';
import { orgOfProject, isGenAccountProject, isHouseProject, orgSecretInfo } from './orgsecrets.ts';
import { identityPack, lookPlan, loraOffer, loraPlan, describeRequest, parseDescription, normalizeLock } from './identity.ts';
import { assess, type QualityReport } from './quality/index.ts';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

/** How many stage scenes cast this character. */
export function shotsWith(character: string, project: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM scenes WHERE project = ? AND kind = 'stage' AND doc LIKE ?`).get(project, `%"character":"${character}"%`) as { n: number };
  return Number(r?.n ?? 0);
}

/** The pictures the description is written from (local paths): the front, then the newest sheet. */
function describeImages(doc: any): string[] {
  const front = doc.pictures.find((p: any) => p.role === 'front' && p.asset);
  const sheet = [...doc.pictures].reverse().find((p: any) => p.role === 'sheet' && p.asset);
  return [front, sheet].filter(Boolean).map((p: any) => getAsset(p.asset)?.path).filter(Boolean) as string[];
}
const newestSheet = (doc: any) => [...doc.pictures].reverse().find((p: any) => p.role === 'sheet' && p.asset)?.asset ?? null;

/**
 * Checks a first frame against every known character's pictures (src/quality assess, identity refs). Pass when every
 * face that should be someone is them; `distance` is the worst one (null when nothing was measured).
 */
export async function identityCheck(file: string, checks: { cast: number; name: string; refs: string[] }[], brief: string, assessFn = assess) {
  const reports: { cast: number; name: string; report: QualityReport }[] = [];
  for (const c of checks) {
    const refs = c.refs.map((a) => getAsset(a)?.path).filter(Boolean) as string[];
    if (!refs.length) continue;
    reports.push({ cast: c.cast, name: c.name, report: await assessFn({ brief, kind: 'image', file, identityRefs: refs }) });
  }
  const ds = reports.map((r) => r.report.identity?.distance).filter((d): d is number => typeof d === 'number');
  return { pass: reports.every((r) => r.report.pass), distance: ds.length ? Math.max(...ds) : null, checked: reports.length, reports };
}

export async function handleIdentity(client: Client, route: string, method: string, q: (k: string) => string | undefined, req: IncomingMessage, res: ServerResponse, send: Send, readJson: (req: IncomingMessage) => Promise<any>): Promise<boolean> {
  const cm = /^\/v1\/scenes\/(sn_[0-9a-f]{6,24})\/identity(?:\/(describe|lock|unlock|lora))?$/.exec(route);
  const isDirector = route === '/v1/director/prompts' || route === '/v1/director/identity-check';
  if (!cm && !isDirector) return false;
  const sc = await import('./scenes.ts');
  await import('./editor.ts');
  const dr = await import('./director.ts');
  await import('./scenekinds.ts');
  const canSee = (p: string) => canProject(client, p);
  const user = getUserForClient(client);

  if (isDirector) {
    if (method !== 'POST') throw new GenError(`No director route ${method} ${route}`, { status: 404 });
    const b = await readJson(req);
    let project: string, doc: any;
    if (typeof b.shot === 'string' && /^sh_[0-9a-f]{6,24}$/.test(b.shot)) {
      const sh = dr.getShot(b.shot, canSee);
      project = sh.project;
      doc = b.doc ? dr.normalizeShot(b.doc) : sh.doc;
    } else {
      project = fixedProject(client) ?? (typeof b.project === 'string' && b.project ? b.project : user?.project ?? '');
      if (!project || !canSee(project)) project = '';
      doc = dr.normalizeShot(b.doc);
    }
    if (project) dr.castFromCharacters(doc, project);
    const packs = project ? dr.shotPacks(doc, project) : [];
    if (route === '/v1/director/prompts') {
      const p = dr.filmPrompts(doc, packs);
      const opts: any = {};
      if (typeof b.look === 'string' && b.look.trim()) opts.look = b.look.trim().slice(0, 3000);
      if (typeof b.camera === 'boolean') opts.camera = b.camera;
      if (b.screen && typeof b.screen === 'object') opts.screen = Object.fromEntries(Object.entries(b.screen).filter(([k, v]) => /^\d$/.test(k) && ['left', 'center', 'right'].includes(String(v))));
      if (b.loraReady) opts.loraReady = true;
      if (b.strong) opts.strong = true;
      const firstFrame = dr.firstFrameFor(doc, packs, { look: opts.look ?? p.look, ...opts });
      return send(res, 200, { ...p, firstFrame, packs: packs.map((x) => ({ cast: x.cast, name: x.name, locked: Boolean(x.locked), refs: x.refs.length, lora: Boolean(x.lora), described: Boolean(x.description) })) }), true;
    }
    const a = getAsset(String(b.asset ?? ''));
    if (!a || !canSee(a.project)) throw new GenError('No such file', { status: 404 });
    const checks = dr.firstFrameFor(doc, packs).checks;
    return send(res, 200, await identityCheck(a.path, checks, String(doc.look ?? ''))), true;
  }

  const id = cm![1];
  const cur = sc.getScene(id, canSee);
  if (cur.kind !== 'character') throw new GenError('Only characters have an identity pack', { status: 400 });
  const doc: any = cur.doc;
  const shots = shotsWith(cur.id, cur.project);
  const reply = (s: any, extra: Record<string, unknown> = {}) => send(res, 200, { scene: { ...s, uses: sc.usedBy(s, canSee) }, pack: identityPack(s.doc), lora: loraOffer(s.doc, shots), ...extra });

  if (!cm![2] && method === 'GET') return send(res, 200, { pack: identityPack(doc), plan: lookPlan(doc), lora: loraOffer(doc, shots) }), true;
  if (method !== 'POST') throw new GenError(`No identity route ${method} ${route}`, { status: 404 });
  const b = await readJson(req).catch(() => ({}));

  if (cm![2] === 'describe') {
    const own = orgOfProject(cur.project);
    const ownAi = Boolean(own && (orgSecretInfo(own, 'anthropic').set || orgSecretInfo(own, 'claude-subscription').set));
    const payer = user && isGenAccountProject(cur.project) && !ownAi ? user : null;
    if (payer) house.checkCanPay(getUserById(payer.id)?.credits ?? 0);
    const r = await callScope.run({ customer: true, org: own, house: isHouseProject(cur.project) }, () => ask(describeRequest(doc, describeImages(doc))));
    const description = parseDescription(r.text);
    if (!description) throw new GenError('No description came back. Try again.', { status: 502 });
    const housePaid = !['byok', 'subscription'].includes(r.billing);
    const aiCharge = payer && housePaid ? chargeCredits(payer.id, house.turnCredits(r.cost ?? 0), 'ai_turn', `Their look: ${cur.title}`) : null;
    const saved = sc.saveScene(cur, { ...doc, lock: { sheet: newestSheet(doc) ?? doc.lock?.sheet ?? null, description, at: null } });
    return reply(saved, { description, ...(aiCharge ? { aiCredits: aiCharge.charged } : {}) }), true;
  }
  if (cm![2] === 'lock') {
    const sheet = typeof b.sheet === 'string' ? b.sheet : doc.lock?.sheet ?? newestSheet(doc);
    const description = typeof b.description === 'string' && b.description.trim() ? b.description : doc.lock?.description ?? '';
    const lock = normalizeLock({ sheet, description, at: Date.now() });
    if (!lock?.sheet) throw new GenError('Make their look first: locking needs their sheet', { status: 400 });
    if (!lock.description) throw new GenError('Their look needs its words first (Make their look writes them)', { status: 400 });
    if (!doc.pictures.some((p: any) => p.asset === lock.sheet)) throw new GenError('The sheet must be one of their pictures', { status: 400 });
    return reply(sc.saveScene(cur, { ...doc, lock })), true;
  }
  if (cm![2] === 'unlock') {
    if (!doc.lock) return reply(cur), true;
    return reply(sc.saveScene(cur, { ...doc, lock: { ...doc.lock, at: null } })), true;
  }
  if (cm![2] === 'lora') {
    const offer = loraOffer(doc, shots);
    if (!offer.eligible && !(offer.state === 'failed' && normalizeLock(doc.lock)?.at)) throw new GenError(offer.why, { status: 400 });
    const plan = loraPlan(doc);
    const quote = quoteJobCredits({ project: cur.project, tool: plan.tool, params: plan.params } as any);
    if (q('quote') === '1') return send(res, 200, { quote, images: plan.images, trigger: plan.trigger }), true;
    const job = submit(client, { project: cur.project, tool: plan.tool, params: plan.params, inputs: plan.inputs, labels: { by: client.name, scene: cur.id, title: `${cur.title}: learning their look` } } as JobSpec);
    return reply(sc.saveScene(cur, { ...doc, lora: { trigger: plan.trigger, state: 'training', pending: job.id } }), { job: job.id, quote }), true;
  }
  throw new GenError(`No identity route ${method} ${route}`, { status: 404 });
}
