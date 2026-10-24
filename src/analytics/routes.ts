// The analytics query routes (Gen key, like the rest of /v1). docs/analytics.md.
//   GET /v1/analytics/products                      the registry
//   GET /v1/analytics/overview                      every product
//   GET /v1/analytics/:product                      every section at once
//   GET /v1/analytics/:product/:section             traffic | sessions | retention | funnel | dropoff | levels | deaths
//                                                   | features | engagement | frustration | feedback | errors | perf
//                                                   | accounts | builds | insights | export
//   GET /v1/analytics/:product/accounts/:user       one account: its summary and sessions
//   GET /v1/analytics/:product/sessions/list        the session list; /sessions/:id one session's timeline

import type { ServerResponse } from 'node:http';
import { canProject, type Client } from '../auth.ts';
import { GenError } from '../util.ts';
import { products } from './registry.ts';
import * as Q from './query.ts';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

// The heavy answers (the overview, every section at once, insights) are kept a minute: dashboards poll them.
const cache = new Map<string, { at: number; body: unknown }>();
function cached(key: string, make: () => unknown) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.body;
  const body = make();
  cache.set(key, { at: Date.now(), body });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return body;
}

/** Answers an /v1/analytics route; false when the route isn't one. */
export function handleAnalytics(client: Client, route: string, method: string, q: (k: string) => string | undefined, res: ServerResponse, send: Send, search = ''): boolean {
  if (!route.startsWith('/v1/analytics/') || method !== 'GET') return false;
  const parts = route.slice('/v1/analytics/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  const f = Q.parseFilters(q);
  // Keyed by the minute too, so a range like 30d moves on.
  const key = `${route}?${search}@${Math.floor(Date.now() / 60_000)}`;
  const ok = (body: unknown) => {
    send(res, 200, body);
    return true;
  };
  if (parts[0] === 'products' && parts.length === 1) {
    return ok({ products: [...products().values()].filter((p) => canProject(client, p.id)) });
  }
  if (parts[0] === 'overview' && parts.length === 1) {
    const all = cached(key, () => Q.overview(f)) as ReturnType<typeof Q.overview>;
    return ok({ ...all, products: all.products.filter((p) => canProject(client, p.product)) });
  }
  const product = parts[0];
  if (!product || !products().has(product)) throw new GenError(`No analytics product ${product}`, { status: 404 });
  if (!canProject(client, product)) throw new GenError('No access to that project', { status: 403 });
  const section = parts[1];
  if (!section) {
    return ok(cached(key, () => {
      const out: Record<string, any> = { product, from: f.from, to: f.to, env: f.env ?? 'all' };
      for (const [k, fn] of Object.entries(Q.SECTIONS)) out[k] = (fn as any)(product, f);
      return out;
    }));
  }
  if (section === 'accounts') {
    if (parts[2]) return ok({ ...Q.accounts(product, { ...f, user: parts[2] }, 1, 0), sessions: Q.sessionList(product, { ...f, user: parts[2] }, 100, 0) });
    return ok(Q.accounts(product, f, Number(q('limit')) || 100, Number(q('offset')) || 0));
  }
  if (section === 'sessions' && parts[2] === 'list') return ok(Q.sessionList(product, f, Number(q('limit')) || 50, Number(q('offset')) || 0));
  if (section === 'sessions' && parts[2]) {
    const t = Q.sessionTimeline(product, parts[2]);
    if (!t) throw new GenError('No such session', { status: 404 });
    return ok(t);
  }
  if (section === 'funnel') {
    const steps = q('steps') ? Q.parseSteps(q('steps')!) : undefined;
    return ok(Q.funnel(product, f, steps, q('by') === 'session' ? 'session' : 'player'));
  }
  if (section === 'builds') return ok(Q.builds(product, f, q('a'), q('b')));
  if (section === 'insights') return ok(cached(key, () => Q.insights(product, f)));
  if (section === 'export') {
    const what = q('what') === 'sessions' ? 'sessions' : 'events';
    const rows = Q.exportRows(product, f, what, Number(q('limit')) || 100_000);
    const name = `${product}-${what}-${new Date(f.from).toISOString().slice(0, 10)}`;
    if (q('format') === 'csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name}.csv"` });
      res.end(Q.toCsv(rows));
      return true;
    }
    return ok({ product, what, count: rows.length, rows });
  }
  const fn = (Q.SECTIONS as Record<string, any>)[section];
  if (!fn || parts.length > 2) throw new GenError(`No analytics section ${section}`, { status: 404 });
  return ok(fn(product, f));
}
