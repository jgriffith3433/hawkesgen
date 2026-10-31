// The making loop's routes (docs/make.md, docs/api.md).
//   POST /v1/make/feedback {kind, asset | job | tool, rating?, note?, source?}   a pick, discard, redo, rating or complaint
//   GET  /v1/make/feedback?tool=&project=                                          what was said (admin)
//   POST /v1/make/quote {intent, brief, quality, ...}                              the worst case of a make.checked call, in credits
//   POST /v1/make/route {intent, inputs?, refs?, params?, allowPaid?}              which tool it would use, and what it skipped
//   GET  /v1/make/proposals?status=open                                            what the learning proposes (owner)
//   POST /v1/make/proposals/summarize {days?}                                      run the summarizer now (owner)
//   POST /v1/make/proposals/:id {approve, write?}                                  approve (applies it) or reject (owner)
//   GET  /v1/make/settings, PUT /v1/make/settings {...}                            the owner's knobs

import type { ServerResponse } from 'node:http';
import { canProject, fixedProject, requireRole, type Client } from '../auth.ts';
import { GenError } from '../util.ts';
import { getAsset } from '../library.ts';
import { recordFeedback, listFeedback, listProposals, runSummary, decideProposal } from './feedback.ts';
import { makeSettings, saveMakeSettings } from './settings.ts';
import { route } from './index.ts';
import { routing } from './routing.ts';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

/** Answers a /v1/make route; false when the route isn't one. */
export async function handleMake(client: Client, route_: string, method: string, q: (k: string) => string | undefined, res: ServerResponse, send: Send, readBody: () => Promise<any>): Promise<boolean> {
  if (!route_.startsWith('/v1/make/')) return false;
  if (route_ === '/v1/make/feedback' && method === 'POST') {
    const b = await readBody();
    const asset = b.asset ? getAsset(String(b.asset).replace(/^asset:/, '')) : null;
    if (b.asset && !asset) throw new GenError('No such asset', { status: 404 });
    const project = asset?.project ?? (typeof b.project === 'string' ? b.project : fixedProject(client)) ?? '';
    if (!project || !canProject(client, project)) throw new GenError('No access to that project', { status: 403 });
    if (b.job && !asset) {
      const { getJob } = await import('../jobs.ts');
      const j = getJob(String(b.job));
      if (!j || !canProject(client, j.project)) throw new GenError('No such job', { status: 404 });
    }
    const f = recordFeedback({ ...b, project, client: client.id, asset: asset?.id ?? null });
    return send(res, 200, f ? { id: f.id, kind: f.kind, tool: f.tool } : { skipped: 'an upload: nothing was made' }), true;
  }
  if (route_ === '/v1/make/feedback' && method === 'GET') {
    requireRole(client, 'admin');
    return send(res, 200, { items: listFeedback({ tool: q('tool'), project: q('project'), limit: Number(q('limit')) || 200 }) }), true;
  }
  if (route_ === '/v1/make/quote' && method === 'POST') {
    const b = await readBody();
    const project = (typeof b.project === 'string' ? b.project : fixedProject(client)) ?? 'sandbox';
    if (!canProject(client, project)) throw new GenError('No access to that project', { status: 403 });
    const { quoteJobCredits } = await import('../billing.ts');
    const { project: _p, ...params } = b;
    return send(res, 200, quoteJobCredits('make.checked', params, project)), true;
  }
  if (route_ === '/v1/make/route' && method === 'POST') {
    const b = await readBody();
    const { getTool } = await import('../tools/index.ts');
    const r = route({ intent: b.intent, tool: b.tool, params: b.params ?? {}, inputs: b.inputs ?? {}, refs: b.refs ?? {} }, {
      allowPaid: Boolean(b.allowPaid) && makeSettings().allowPaid,
      has: (id) => Boolean(getTool(id)), inputsOf: (id) => getTool(id)?.inputs ?? null,
    });
    return send(res, 200, { ...r, preview: routing().tools[r.tool]?.preview ?? null }), true;
  }
  if (route_ === '/v1/make/proposals' && method === 'GET') {
    requireRole(client, 'owner');
    return send(res, 200, { items: listProposals(q('status')) }), true;
  }
  if (route_ === '/v1/make/proposals/summarize' && method === 'POST') {
    requireRole(client, 'owner');
    const b = await readBody().catch(() => ({}));
    return send(res, 200, runSummary({ days: Number(b?.days) || undefined })), true;
  }
  const m = /^\/v1\/make\/proposals\/(mp_[0-9a-f]+)$/.exec(route_);
  if (m && method === 'POST') {
    requireRole(client, 'owner');
    const b = await readBody();
    if (typeof b.approve !== 'boolean') throw new GenError('Send approve: true or false');
    return send(res, 200, decideProposal(m[1], { approve: b.approve, by: client.name, write: Boolean(b.write) })), true;
  }
  if (route_ === '/v1/make/settings') {
    requireRole(client, 'owner');
    if (method === 'GET') return send(res, 200, makeSettings()), true;
    if (method === 'PUT' || method === 'POST') return send(res, 200, saveMakeSettings(await readBody())), true;
  }
  throw new GenError('Not found', { status: 404 });
}
