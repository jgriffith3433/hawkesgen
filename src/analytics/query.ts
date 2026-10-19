// Reading the analytics (GET /v1/analytics/...): an overview of every product, and per product traffic, sessions,
// retention, funnels, drop-off, levels, deaths, features and choices, feedback, errors, perf, two builds side by side,
// the session list and one session's timeline, exports and plain-sentence insights. docs/analytics.md has the
// definitions. Every query is bounded by product and time on an index.

import { adb, DAY, dayOf } from './store.ts';
import { products } from './registry.ts';

export type Filters = {
  from: number;
  to: number;
  /** null: every env. */
  env: string[] | null;
  build?: string;
  device?: string;
  browser?: string;
  country?: string;
  bots: boolean;
  internal: boolean;
};

const RANGES: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '14d': 14 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '180d': 180 * DAY, '365d': 365 * DAY };
const midnight = (ms: number) => Date.parse(`${dayOf(ms)}T00:00:00Z`);

function time(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d{10,}$/.test(v)) return Number(v);
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : null;
}

/** Filters from a query string: range (today | 24h | 7d | 30d | 90d...) or from/to, env (live by default; all), build,
 * device, browser, country, bots=1 and internal=1 to include them. */
export function parseFilters(q: (k: string) => string | undefined, now = Date.now()): Filters {
  const range = q('range') ?? '30d';
  let from = time(q('from'));
  let to = time(q('to'));
  if (q('to') && /^\d{4}-\d\d-\d\d$/.test(q('to')!)) to = to! + DAY; // a whole day
  if (from == null) from = range === 'today' ? midnight(now) : now - (RANGES[range] ?? 30 * DAY);
  if (to == null) to = now;
  const env = q('env') ?? 'live';
  return {
    from, to,
    env: env === 'all' ? null : env.split(',').map((s) => s.trim()).filter(Boolean),
    build: q('build') || undefined, device: q('device') || undefined, browser: q('browser') || undefined, country: q('country')?.toUpperCase() || undefined,
    bots: q('bots') === '1', internal: q('internal') === '1',
  };
}

/** The session filters (no time) as SQL on alias s. */
function sessionWhere(product: string, f: Filters, a = 's') {
  const sql = [`${a}.product = ?`];
  const args: any[] = [product];
  if (f.env) {
    sql.push(`${a}.env IN (${f.env.map(() => '?').join(', ')})`);
    args.push(...f.env);
  }
  for (const [k, col] of [['build', 'build'], ['device', 'device'], ['browser', 'browser'], ['country', 'country']] as const) {
    if (f[k]) {
      sql.push(`${a}.${col} = ?`);
      args.push(f[k]);
    }
  }
  if (!f.bots) sql.push(`${a}.bot = 0`);
  if (!f.internal) sql.push(`${a}.internal = 0`);
  return { sql: sql.join(' AND '), args };
}

/** Sessions that started in the range. */
function sessionsIn(product: string, f: Filters, cols = 's.*'): any[] {
  const w = sessionWhere(product, f);
  return adb.prepare(`SELECT ${cols} FROM sessions s WHERE ${w.sql} AND s.started >= ? AND s.started < ?`).all(...w.args, f.from, f.to) as any[];
}

/** The sessions that overlap the range and pass the filters, by id (what eventsIn keeps events of). */
function sessionMap(product: string, f: Filters): Map<string, any> {
  const w = sessionWhere(product, f);
  const rows = adb.prepare(`SELECT s.id, s.anon, s.build, s.browser, s.device, s.gpu FROM sessions s WHERE ${w.sql} AND s.ended >= ? AND s.started < ?`).all(...w.args, f.from, f.to) as any[];
  return new Map(rows.map((r) => [r.id, r]));
}

type Order = 'anon' | 'session' | 'at' | 'newest';
/** Props to read, as name -> JSON path ('$.cause'), or 'all' (the whole props and ctx). */
type Fields = Record<string, string> | 'all';
const fieldsOf = (...names: string[]) => Object.fromEntries(names.filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(n)).map((n) => [n, `$.${n}`]));
/** A bound on what one answer reads into memory (the control server is small). */
const MAX_EVENTS = 1_000_000;

/**
 * Events in the range (by when they arrived) of the sessions that pass the filters, with their session's anon, build,
 * browser and device. Filtered against a map of the sessions instead of a join: a join looks up every event's session.
 */
function eventsIn(product: string, f: Filters, names: string[] | null, order: Order = 'at', limit = 0, fields: Fields = 'all'): any[] {
  const sessions = sessionMap(product, f);
  if (!sessions.size) return [];
  const byName = names ? ` AND e.name IN (${names.map(() => '?').join(', ')})` : '';
  // Only the props an answer needs, read by SQLite (a prop, else the same key in ctx): parsing every event's JSON in
  // JS is what made big ranges slow and heavy.
  const keys = fields === 'all' ? [] : Object.entries(fields);
  const cols = fields === 'all' ? 'e.ctx, e.props' : keys.map(([, path], i) => `COALESCE(json_extract(e.props, '${path}'), json_extract(e.ctx, '${path}')) AS f${i}`).join(', ');
  const sql = `SELECT e.session, e.seq, e.at, e.t, e.name, e.page, e.screen, e.level, e.active${cols ? `, ${cols}` : ''} FROM events e
    WHERE e.product = ? AND e.at >= ? AND e.at < ?${byName} ORDER BY e.at${order === 'newest' ? ' DESC' : ''}`;
  const out: any[] = [];
  for (const r of adb.prepare(sql).iterate(product, f.from, f.to, ...(names ?? [])) as Iterable<any>) {
    const s = sessions.get(r.session);
    if (!s) continue;
    r.anon = s.anon;
    r.build = s.build;
    r.browser = s.browser;
    r.device = s.device;
    r.session_gpu = s.gpu;
    if (fields === 'all') {
      r.props = r.props ? JSON.parse(r.props) : {};
      r.ctx = r.ctx ? JSON.parse(r.ctx) : {};
    } else {
      r.props = {};
      r.ctx = {};
      keys.forEach(([k], i) => {
        if (r[`f${i}`] != null) r.props[k] = r[`f${i}`];
        delete r[`f${i}`];
      });
    }
    out.push(r);
    if (out.length >= (limit || MAX_EVENTS)) break;
  }
  const cmp = (a: any, b: any) => (a.at - b.at) || (a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq);
  if (order === 'anon') out.sort((a, b) => (a.anon < b.anon ? -1 : a.anon > b.anon ? 1 : cmp(a, b)));
  else if (order === 'session') out.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq));
  return out;
}

/** Events of the product in the range, of these names, from sessions that pass the filters (SQL, on alias e). */
function eventWhere(product: string, f: Filters, names: string[]) {
  const w = sessionWhere(product, f);
  return {
    sql: `e.product = ? AND e.name IN (${names.map(() => '?').join(', ')}) AND e.at >= ? AND e.at < ? AND e.session IN (SELECT s.id FROM sessions s WHERE ${w.sql} AND s.ended >= ? AND s.started < ?)`,
    args: [product, ...names, f.from, f.to, ...w.args, f.from, f.to],
  };
}

/** Rows grouped by a key and a session in SQL (n each), counted per key with their players. */
function tally(rows: any[], key: (r: any) => string | null, anonOf: Map<string, any>) {
  const m = new Map<string, { n: number; players: Set<string> }>();
  for (const r of rows) {
    const k = key(r) ?? '(none)';
    let x = m.get(k);
    if (!x) m.set(k, (x = { n: 0, players: new Set() }));
    x.n += r.n;
    x.players.add(anonOf.get(r.session)?.anon ?? r.session);
  }
  return [...m.entries()].map(([value, x]) => ({ value, count: x.n, players: x.players.size })).sort((a, b) => b.count - a.count);
}

export function quantile(xs: number[], q: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo);
}
export const median = (xs: number[]) => quantile(xs, 0.5);
const round = (v: number | null, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const rate = (n: number, of: number) => (of ? round(n / of, 3) : null);
const distinct = (xs: any[]) => new Set(xs).size;

function countBy<T>(rows: T[], key: (r: T) => string | null | undefined, unit?: (r: T) => string) {
  const m = new Map<string, { n: number; units: Set<string> }>();
  for (const r of rows) {
    const k = key(r) ?? '(none)';
    let x = m.get(k);
    if (!x) m.set(k, (x = { n: 0, units: new Set() }));
    x.n++;
    if (unit) x.units.add(unit(r));
  }
  return [...m.entries()].map(([value, x]) => ({ value, count: x.n, ...(unit ? { players: x.units.size } : {}) })).sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------------------ overview

const ACTIVE_NOW = 5 * 60_000;

function period(product: string, f: Filters, from: number, to: number) {
  const rows = sessionsIn(product, { ...f, from, to }, 's.anon, s.active_ms');
  return { sessions: rows.length, visitors: distinct(rows.map((r) => r.anon)) };
}
const trend = (cur: number, prev: number) => (prev ? round((cur - prev) / prev, 3) : null);

/** Every product: active now, visitors and sessions today / 7d / 30d with the trend, a daily series and the headline KPIs. */
export function overview(f: Filters, now = Date.now()) {
  const out: any[] = [];
  for (const p of products().values()) {
    const w = sessionWhere(p.id, f);
    const activeNow = (adb.prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE ${w.sql} AND s.ended >= ?`).get(...w.args, now - ACTIVE_NOW) as any).n;
    const periods: Record<string, any> = {};
    for (const [k, len, start] of [['today', now - midnight(now), midnight(now)], ['7d', 7 * DAY, now - 7 * DAY], ['30d', 30 * DAY, now - 30 * DAY]] as const) {
      const cur = period(p.id, f, start, now);
      const prev = period(p.id, f, start - len, start);
      periods[k] = { ...cur, previous: prev, trend: { sessions: trend(cur.sessions, prev.sessions), visitors: trend(cur.visitors, prev.visitors) } };
    }
    const f30 = { ...f, from: now - 30 * DAY, to: now };
    const rows = sessionsIn(p.id, f30, 's.anon, s.started, s.active_ms, s.errors');
    const series = new Map<string, { sessions: number; visitors: Set<string> }>();
    for (let d = midnight(now - 29 * DAY); d <= now; d += DAY) series.set(dayOf(d), { sessions: 0, visitors: new Set() });
    for (const r of rows) {
      const x = series.get(dayOf(r.started));
      if (x) {
        x.sessions++;
        x.visitors.add(r.anon);
      }
    }
    const nr = newReturning(p.id, f30);
    const ret = retention(p.id, { ...f, from: now - 60 * DAY, to: now }, now);
    const drop = dropoff(p.id, f30, now);
    const fb = feedback(p.id, f30);
    out.push({
      product: p.id, name: p.name, activeNow, ...periods,
      daily: [...series.entries()].map(([day, x]) => ({ day, sessions: x.sessions, visitors: x.visitors.size })),
      newVisitors: nr.new, returningVisitors: nr.returning,
      medianActiveSeconds: round(median(rows.map((r) => r.active_ms / 1000)), 0),
      retention: { d1: ret.total.d1, d7: ret.total.d7 },
      biggestDropoff: drop.biggest,
      errorRate: rate(rows.filter((r) => r.errors > 0).length, rows.length),
      rating: fb.rating,
    });
  }
  return { from: f.from, to: f.to, env: f.env ?? 'all', products: out };
}

/** Visitors in the range who were first seen in it (new) or before it (returning). */
function newReturning(product: string, f: Filters) {
  const anons = new Set(sessionsIn(product, f, 's.anon').map((r) => r.anon));
  const w = sessionWhere(product, { ...f, build: undefined });
  const firsts = adb.prepare(`SELECT s.anon, MIN(s.started) AS first FROM sessions s WHERE ${w.sql} AND s.anon IN (SELECT DISTINCT anon FROM sessions WHERE product = ? AND started >= ? AND started < ?) GROUP BY s.anon`).all(...w.args, product, f.from, f.to) as any[];
  let fresh = 0;
  for (const r of firsts) if (anons.has(r.anon) && r.first >= f.from) fresh++;
  return { new: fresh, returning: anons.size - fresh };
}

// ------------------------------------------------------------------ traffic, sessions

export function traffic(product: string, f: Filters) {
  const rows = sessionsIn(product, f);
  const top = (key: (r: any) => string | null) => countBy(rows, key, (r) => r.anon).slice(0, 25).map((x) => ({ value: x.value, sessions: x.count, visitors: x.players }));
  return {
    sessions: rows.length,
    visitors: distinct(rows.map((r) => r.anon)),
    referrers: top((r) => (r.referrer ? r.referrer.split('/')[0] : '(direct)')),
    referrerPages: top((r) => r.referrer ?? '(direct)'),
    utmSource: top((r) => r.utm_source), utmMedium: top((r) => r.utm_medium), utmCampaign: top((r) => r.utm_campaign),
    landing: top((r) => r.landing),
    countries: top((r) => r.country), regions: top((r) => (r.region ? `${r.region}, ${r.country}` : null)), cities: top((r) => (r.city ? `${r.city}, ${r.country}` : null)),
    browsers: top((r) => `${r.browser}${r.browser_version ? ` ${r.browser_version.split('.')[0]}` : ''}`),
    os: top((r) => `${r.os}${r.os_version ? ` ${r.os_version}` : ''}`),
    devices: top((r) => r.device), screens: top((r) => r.screen), languages: top((r) => r.lang), timezones: top((r) => r.tz),
  };
}

const LENGTHS: [string, number][] = [['<10s', 10], ['10-30s', 30], ['30s-1m', 60], ['1-3m', 180], ['3-10m', 600], ['10-30m', 1800], ['30m+', Infinity]];

export function sessionStats(product: string, f: Filters) {
  const rows = sessionsIn(product, f, 's.anon, s.active_ms, s.events, s.pages');
  const lengths = LENGTHS.map(([label]) => ({ label, sessions: 0 }));
  for (const r of rows) lengths[LENGTHS.findIndex(([, max]) => r.active_ms / 1000 < max)].sessions++;
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.anon, (per.get(r.anon) ?? 0) + 1);
  const buckets: [string, number, number][] = [['1', 1, 1], ['2', 2, 2], ['3-5', 3, 5], ['6-10', 6, 10], ['11+', 11, Infinity]];
  return {
    sessions: rows.length,
    players: per.size,
    medianActiveSeconds: round(median(rows.map((r) => r.active_ms / 1000)), 0),
    p90ActiveSeconds: round(quantile(rows.map((r) => r.active_ms / 1000), 0.9), 0),
    medianEvents: median(rows.map((r) => r.events)),
    length: lengths,
    sessionsPerPlayer: buckets.map(([label, lo, hi]) => ({ label, players: [...per.values()].filter((n) => n >= lo && n <= hi).length })),
  };
}

// ------------------------------------------------------------------ retention

const weekOf = (ms: number) => {
  const d = new Date(midnight(ms));
  return dayOf(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY); // the Monday
};

/**
 * Rolling retention by first-seen week: Dn = of the players first seen in the cohort whose day n has come, the share
 * who came back on day n or later (UTC days after their first day).
 */
export function retention(product: string, f: Filters, now = Date.now()) {
  const w = sessionWhere(product, { ...f, build: undefined });
  const firsts = adb.prepare(`SELECT s.anon, MIN(s.started) AS first FROM sessions s WHERE ${w.sql} GROUP BY s.anon HAVING first >= ? AND first < ?`).all(...w.args, f.from, f.to) as any[];
  const last = new Map<string, number>();
  for (const r of adb.prepare(`SELECT s.anon, MAX(s.started) AS last FROM sessions s WHERE ${w.sql} AND s.started >= ? GROUP BY s.anon`).all(...w.args, f.from) as any[]) last.set(r.anon, r.last);
  const today = midnight(now);
  const cohorts = new Map<string, any>();
  const blank = () => ({ eligible: 0, returned: 0, rate: null as number | null });
  const total = { players: 0, d1: blank(), d7: blank(), d30: blank() };
  for (const r of firsts) {
    const week = weekOf(r.first);
    let c = cohorts.get(week);
    if (!c) cohorts.set(week, (c = { week, players: 0, d1: blank(), d7: blank(), d30: blank() }));
    c.players++;
    total.players++;
    const firstDay = midnight(r.first);
    const lastDay = midnight(last.get(r.anon) ?? r.first);
    for (const n of [1, 7, 30] as const) {
      if (firstDay + n * DAY > today) continue;
      const k = `d${n}` as 'd1' | 'd7' | 'd30';
      c[k].eligible++;
      total[k].eligible++;
      if (lastDay >= firstDay + n * DAY) {
        c[k].returned++;
        total[k].returned++;
      }
    }
  }
  const fin = (x: any) => {
    for (const k of ['d1', 'd7', 'd30']) x[k].rate = rate(x[k].returned, x[k].eligible);
    return x;
  };
  return { total: fin(total), cohorts: [...cohorts.values()].sort((a, b) => a.week.localeCompare(b.week)).map(fin) };
}

// ------------------------------------------------------------------ funnel

export type Step = { name: string; where: Record<string, string>; label: string };

/** "level_start:level=2" -> { name: level_start, where: { level: 2 } }. A list is comma separated (or a JSON array). */
export function parseSteps(v: string | string[]): Step[] {
  const list = Array.isArray(v) ? v : v.trim().startsWith('[') ? JSON.parse(v) : v.split(',');
  return list.map((s: string) => String(s).trim()).filter(Boolean).slice(0, 20).map((s: string) => {
    const [name, ...conds] = s.split(':');
    return { name, where: Object.fromEntries(conds.map((c) => c.split('=')).map(([k, ...x]) => [k, x.join('=')])), label: s };
  });
}

function matches(e: any, st: Step) {
  if (e.name !== st.name) return false;
  for (const [k, v] of Object.entries(st.where)) {
    const got = k === 'level' ? e.level : k === 'screen' ? e.screen ?? e.props?.name : e.props?.[k] ?? e.ctx?.[k];
    if (String(got) !== v) return false;
  }
  return true;
}

/** The props a funnel's steps compare (level and screen are columns; a screen step also looks at screen's name). */
function funnelFields(list: Step[]) {
  const keys = list.flatMap((st) => Object.keys(st.where));
  return fieldsOf(...keys.filter((k) => k !== 'level' && k !== 'screen'), ...(keys.includes('screen') ? ['name'] : []));
}

/** The product's progression: its registry levels, else the levels players started (most played first), else progress steps. */
export function defaultSteps(product: string, f: Filters): Step[] {
  const reg = products().get(product)?.levels;
  const w = sessionWhere(product, f);
  const ready = adb.prepare(`SELECT 1 FROM sessions s WHERE ${w.sql} AND s.ready = 1 AND s.ended >= ? AND s.started < ? LIMIT 1`).get(...w.args, f.from, f.to);
  const head = ready ? ['game_ready'] : [];
  if (reg?.length) return parseSteps([...head, ...reg.map((l) => `level_start:level=${l}`)]);
  // Only the order comes from here, so it skips the session filters (a join per event).
  const levels = adb.prepare(`SELECT level, COUNT(DISTINCT session) AS n, MIN(at) AS first FROM events
    WHERE product = ? AND name = 'level_start' AND level IS NOT NULL AND at >= ? AND at < ? GROUP BY level ORDER BY n DESC, first LIMIT 15`).all(product, f.from, f.to) as any[];
  if (levels.length) return parseSteps([...head, ...levels.map((l) => `level_start:level=${l.level}`)]);
  const steps = (eventsIn(product, f, ['progress'], 'at', 0, fieldsOf('step')).map((e) => Number(e.props.step)).filter(Number.isFinite));
  return parseSteps([...head, ...[...new Set(steps)].sort((a, b) => a - b).slice(0, 15).map((s) => `progress:step=${s}`)]);
}

/** Players (or sessions, by=session) who did each step after the ones before it, in order, in the range. */
export function funnel(product: string, f: Filters, steps?: Step[], by: 'player' | 'session' = 'player') {
  const list = steps?.length ? steps : defaultSteps(product, f);
  if (!list.length) return { by, steps: [], biggestLoss: null };
  const events = eventsIn(product, f, [...new Set(list.map((s) => s.name))], by === 'player' ? 'anon' : 'session', 0, funnelFields(list));
  const reached = new Array(list.length).fill(0);
  let unit: string | null = null;
  let at = 0;
  const flush = () => {
    for (let i = 0; i < at; i++) reached[i]++;
  };
  for (const e of events) {
    const u = by === 'player' ? e.anon : e.session;
    if (u !== unit) {
      flush();
      unit = u;
      at = 0;
    }
    if (at < list.length && matches(e, list[at])) at++;
  }
  flush();
  const out = list.map((s, i) => ({ step: s.label, count: reached[i], fromPrevious: i ? rate(reached[i], reached[i - 1]) : 1, fromStart: rate(reached[i], reached[0]) }));
  let biggestLoss: any = null;
  for (let i = 1; i < out.length; i++) {
    const lost = reached[i - 1] - reached[i];
    if (lost > 0 && (!biggestLoss || lost > biggestLoss.lost)) biggestLoss = { after: out[i - 1].step, before: out[i].step, lost, of: reached[i - 1], rate: rate(lost, reached[i - 1]) };
  }
  return { by, steps: out, biggestLoss };
}

// ------------------------------------------------------------------ drop-off

/** Where sessions end (ones still active in the last 5 minutes aren't counted): before the game was ready (with how
 * long they waited), else by the last level (and how far into it), screen and event. */
export function dropoff(product: string, f: Filters, now = Date.now()) {
  const rows = sessionsIn(product, f).filter((r) => r.ended < now - ACTIVE_NOW);
  const loaded = rows.filter((r) => r.load_t != null);
  const early = loaded.filter((r) => !r.ready);
  const played = rows.filter((r) => r.ready || r.load_t == null);
  const group = (key: (r: any) => string | null, depth?: (r: any) => number | null) => {
    const m = new Map<string, any[]>();
    for (const r of played) {
      const k = key(r);
      if (k == null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()].map(([value, rs]) => ({
      value, sessions: rs.length, share: rate(rs.length, rows.length),
      ...(depth ? { medianSecondsIn: round(median(rs.map(depth).filter((x): x is number => x != null)), 0) } : {}),
    })).sort((a, b) => b.sessions - a.sessions).slice(0, 25);
  };
  const byLevel = group((r) => r.last_level, (r) => (r.level_open && r.level_t != null && r.last_t != null ? (r.last_t - r.level_t) / 1000 : null));
  const beforeReady = {
    sessions: early.length, share: rate(early.length, rows.length), ofLoads: rate(early.length, loaded.length),
    medianWaitSeconds: round(median(early.map((r) => (r.last_t - r.load_t) / 1000)), 1),
    p90WaitSeconds: round(quantile(early.map((r) => (r.last_t - r.load_t) / 1000), 0.9), 1),
  };
  const candidates = [
    ...(early.length ? [{ where: 'before the game was ready', sessions: early.length, share: beforeReady.share, medianWaitSeconds: beforeReady.medianWaitSeconds }] : []),
    ...byLevel.slice(0, 1).map((x) => ({ where: `level ${x.value}`, sessions: x.sessions, share: x.share, medianSecondsIn: x.medianSecondsIn })),
  ];
  return {
    sessions: rows.length,
    beforeReady,
    byLevel,
    byScreen: group((r) => r.last_screen),
    byEvent: group((r) => r.last_event),
    biggest: candidates.sort((a, b) => b.sessions - a.sessions)[0] ?? null,
  };
}

// ------------------------------------------------------------------ levels, deaths

export function levels(product: string, f: Filters, now = Date.now()) {
  const events = eventsIn(product, f, ['level_start', 'level_end'], 'anon', 0, fieldsOf('result', 'duration'));
  const m = new Map<string, any>();
  const lv = (k: string) => {
    let x = m.get(k);
    if (!x) m.set(k, (x = { level: k, attempts: 0, players: new Set(), completes: 0, deaths: 0, quits: 0, restarts: 0, abandoned: 0, durations: [] as number[], tries: new Map<string, number>(), firstWin: new Map<string, number>() }));
    return x;
  };
  for (const e of events) {
    if (e.level == null) continue;
    const x = lv(e.level);
    if (e.name === 'level_start') {
      x.attempts++;
      x.players.add(e.anon);
      if (!x.firstWin.has(e.anon)) x.tries.set(e.anon, (x.tries.get(e.anon) ?? 0) + 1);
    } else {
      const r = e.props.result;
      if (r === 'complete') {
        x.completes++;
        const d = Number(e.props.duration);
        if (Number.isFinite(d)) x.durations.push(d);
        if (!x.firstWin.has(e.anon)) x.firstWin.set(e.anon, x.tries.get(e.anon) ?? 1);
      } else if (r === 'quit') x.quits++;
      else if (r === 'restart') x.restarts++;
    }
  }
  const dw = eventWhere(product, f, ['death']);
  for (const r of adb.prepare(`SELECT e.level AS level, COUNT(*) AS n FROM events e WHERE ${dw.sql} AND e.level IS NOT NULL GROUP BY e.level`).all(...dw.args) as any[]) lv(r.level).deaths += r.n;
  // Sessions that ended inside a level (no level_end) count as quits too.
  for (const r of sessionsIn(product, f, 's.last_level, s.level_open, s.ended')) if (r.level_open && r.last_level != null && r.ended < now - ACTIVE_NOW && m.has(r.last_level)) m.get(r.last_level).abandoned++;
  const order = products().get(product)?.levels;
  return [...m.values()].map((x) => ({
    level: x.level, attempts: x.attempts, players: x.players.size, completes: x.completes,
    completionRate: rate(x.completes, x.attempts), quitRate: rate(x.quits + x.abandoned, x.attempts), quits: x.quits, abandoned: x.abandoned, restarts: x.restarts,
    deaths: x.deaths, deathsPerAttempt: x.attempts ? round(x.deaths / x.attempts, 2) : null,
    medianSeconds: round(median(x.durations), 0),
    medianRetriesBeforeFirstWin: x.firstWin.size ? median([...x.firstWin.values()].map((n: number) => n - 1)) : null,
    winners: x.firstWin.size, neverWon: x.players.size - x.firstWin.size,
  })).sort((a, b) => (order ? order.indexOf(a.level) - order.indexOf(b.level) : 0) || b.players - a.players || a.level.localeCompare(b.level, undefined, { numeric: true }));
}

export function deaths(product: string, f: Filters) {
  const w = eventWhere(product, f, ['death']);
  // A named spot, else x,y in 5-unit cells.
  const cell = (k: string) => `CAST(ROUND(COALESCE(json_extract(e.props, '$.${k}'), json_extract(e.props, '$.where.${k}')) / 5.0) * 5 AS INTEGER)`;
  const rows = adb.prepare(`SELECT e.level AS level, json_extract(e.props, '$.cause') AS cause,
      COALESCE(CASE WHEN json_type(e.props, '$.where') = 'text' THEN json_extract(e.props, '$.where') END, ${cell('x')} || ',' || ${cell('y')}) AS spot,
      e.session AS session, COUNT(*) AS n
    FROM events e WHERE ${w.sql} GROUP BY 1, 2, 3, 4`).all(...w.args) as any[];
  const sessions = sessionMap(product, f);
  return {
    deaths: rows.reduce((a, r) => a + r.n, 0),
    players: distinct(rows.map((r) => sessions.get(r.session)?.anon ?? r.session)),
    byCause: tally(rows, (r) => r.cause, sessions).slice(0, 30),
    byLevel: tally(rows, (r) => r.level, sessions).slice(0, 30),
    byWhere: tally(rows, (r) => (r.level != null ? `${r.level} @ ${r.spot ?? '?'}` : r.spot), sessions).slice(0, 50),
    byLevelAndCause: tally(rows, (r) => `${r.level ?? '?'} / ${r.cause ?? '?'}`, sessions).slice(0, 30),
  };
}

// ------------------------------------------------------------------ features and choices

export function features(product: string, f: Filters) {
  const sessions = sessionsIn(product, f, 's.id, s.active_ms');
  const active = new Map(sessions.map((x) => [x.id, x.active_ms / 1000]));
  const anons = sessionMap(product, f);
  const w = eventWhere(product, f, ['feature', 'choice']);
  const rows = adb.prepare(`SELECT e.name AS kind, json_extract(e.props, '$.name') AS name, json_extract(e.props, '$.node') AS node, json_extract(e.props, '$.option') AS option, e.session AS session, COUNT(*) AS n
    FROM events e WHERE ${w.sql} GROUP BY 1, 2, 3, 4, 5`).all(...w.args) as any[];
  const anon = (r: any) => anons.get(r.session)?.anon ?? r.session;
  const feat = new Map<string, { count: number; players: Set<string>; sessions: Set<string> }>();
  for (const r of rows.filter((x) => x.kind === 'feature')) {
    const k = String(r.name ?? '(unnamed)');
    let x = feat.get(k);
    if (!x) feat.set(k, (x = { count: 0, players: new Set(), sessions: new Set() }));
    x.count += r.n;
    x.players.add(anon(r));
    x.sessions.add(r.session);
  }
  const choices = new Map<string, Map<string, Set<string>>>();
  for (const r of rows.filter((x) => x.kind === 'choice')) {
    const node = String(r.node ?? '(node)');
    const opt = String(r.option ?? '(option)');
    if (!choices.has(node)) choices.set(node, new Map());
    const c = choices.get(node)!;
    if (!c.has(opt)) c.set(opt, new Set());
    c.get(opt)!.add(anon(r));
  }
  return {
    features: [...feat.entries()].map(([name, x]) => {
      const used = [...x.sessions].map((id) => active.get(id)).filter((v): v is number => v != null);
      const not = sessions.filter((y) => !x.sessions.has(y.id)).map((y) => y.active_ms / 1000);
      return { name, uses: x.count, players: x.players.size, sessions: x.sessions.size, shareOfSessions: rate(x.sessions.size, sessions.length), medianActiveSecondsWith: round(median(used), 0), medianActiveSecondsWithout: round(median(not), 0) };
    }).sort((a, b) => b.uses - a.uses),
    choices: [...choices.entries()].map(([node, opts]) => {
      const total = [...opts.values()].reduce((a, x) => a + x.size, 0);
      return { node, players: total, options: [...opts.entries()].map(([option, x]) => ({ option, players: x.size, share: rate(x.size, total) })).sort((a, b) => b.players - a.players) };
    }).sort((a, b) => b.players - a.players),
  };
}

// ------------------------------------------------------------------ feedback

export function feedback(product: string, f: Filters, limit = 100) {
  const rows = eventsIn(product, f, ['feedback'], 'newest');
  const thumbs = { up: 0, down: 0 };
  const stars: number[] = [];
  for (const e of rows) {
    const r = e.props.rating;
    if (r === 'up' || r === true || r === 1 && e.props.scale === 'thumbs') thumbs.up++;
    else if (r === 'down' || r === false || r === 0 && e.props.scale === 'thumbs') thumbs.down++;
    else if (Number.isFinite(Number(r)) && Number(r) >= 1 && Number(r) <= 5) stars.push(Number(r));
  }
  const dist = [1, 2, 3, 4, 5].map((n) => ({ stars: n, count: stars.filter((s) => Math.round(s) === n).length }));
  return {
    count: rows.length,
    rating: { average: round(stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null, 2), ratings: stars.length, thumbsUp: thumbs.up, thumbsDown: thumbs.down, upShare: rate(thumbs.up, thumbs.up + thumbs.down) },
    stars: dist,
    comments: rows.filter((e) => typeof e.props.text === 'string' && e.props.text.trim()).slice(0, limit).map((e) => ({
      at: e.at, rating: e.props.rating ?? null, text: e.props.text, context: e.props.context ?? null, level: e.level, screen: e.screen, ctx: e.ctx, build: e.build, session: e.session,
    })),
  };
}

// ------------------------------------------------------------------ errors

/** What makes two errors the same: the message without numbers, ids and URLs, plus the top stack frame. */
export function errorSignature(message: string, stack = '') {
  const norm = (s: string) => s.replace(/https?:\/\/[^\s)]+\/([^\s/):]+)/g, '$1').replace(/0x[0-9a-f]+/gi, 'X').replace(/\b[0-9a-f]{8,}\b/gi, 'H').replace(/\d+/g, 'N').replace(/(["']).*?\1/g, '$1…$1').trim().slice(0, 200);
  const frame = stack.split('\n').map((l) => l.trim()).find((l) => /^at |@/.test(l)) ?? '';
  return `${norm(message || '(no message)')}${frame ? ` | ${norm(frame)}` : ''}`;
}

export function errors(product: string, f: Filters) {
  const sessions = sessionsIn(product, f, 's.id');
  const rows = eventsIn(product, f, ['error'], 'at', 0, fieldsOf('message', 'stack', 'source'));
  const m = new Map<string, any>();
  for (const e of rows) {
    const sig = errorSignature(String(e.props.message ?? ''), String(e.props.stack ?? ''));
    let x = m.get(sig);
    if (!x) m.set(sig, (x = { signature: sig, count: 0, sessions: new Set(), players: new Set(), browsers: new Map(), builds: new Map(), sources: new Map(), first: e.at, last: e.at, message: e.props.message ?? null, stack: e.props.stack ?? null }));
    x.count++;
    x.sessions.add(e.session);
    x.players.add(e.anon);
    for (const [map, k] of [[x.browsers, e.browser], [x.builds, e.build ?? '(none)'], [x.sources, e.props.source ?? '(none)']]) map.set(k, (map.get(k) ?? 0) + 1);
    x.first = Math.min(x.first, e.at);
    x.last = Math.max(x.last, e.at);
  }
  const obj = (mp: Map<string, number>) => Object.fromEntries([...mp.entries()].sort((a, b) => b[1] - a[1]));
  const withErrors = new Set(rows.map((e) => e.session));
  return {
    errors: rows.length, sessionsWithErrors: withErrors.size, sessions: sessions.length, errorRate: rate(withErrors.size, sessions.length),
    groups: [...m.values()].map((x) => ({ ...x, sessions: x.sessions.size, players: x.players.size, browsers: obj(x.browsers), builds: obj(x.builds), sources: obj(x.sources) })).sort((a, b) => b.sessions - a.sessions || b.count - a.count).slice(0, 50),
  };
}

// ------------------------------------------------------------------ perf

export function perf(product: string, f: Filters) {
  const rows = sessionsIn(product, f, 's.device, s.gpu, s.ready, s.ready_ms, s.load_t');
  const loads = rows.filter((r) => r.load_t != null);
  const byDevice = new Map<string, number[]>();
  for (const r of rows) {
    if (r.ready_ms == null) continue;
    if (!byDevice.has(r.device)) byDevice.set(r.device, []);
    byDevice.get(r.device)!.push(r.ready_ms);
  }
  // fps per session (its average over its perf minutes) in SQL; then the median over sessions per device and GPU.
  const w = eventWhere(product, f, ['perf']);
  const per = adb.prepare(`SELECT e.session AS session, COUNT(*) AS n,
      AVG(COALESCE(json_extract(e.props, '$.fps'), json_extract(e.props, '$.fps_median'))) AS fps,
      AVG(COALESCE(json_extract(e.props, '$.fps_p10'), json_extract(e.props, '$.p10'))) AS p10,
      AVG(json_extract(e.props, '$.memory')) AS memory, MAX(json_extract(e.props, '$.gpu')) AS gpu
    FROM events e WHERE ${w.sql} GROUP BY e.session`).all(...w.args) as any[];
  const sessions = sessionMap(product, f);
  const group = (key: (r: any) => string) => {
    const m = new Map<string, any[]>();
    for (const r of per) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()].map(([value, rs]) => ({
      value, samples: rs.reduce((a, r) => a + r.n, 0), sessions: rs.length, players: distinct(rs.map((r) => sessions.get(r.session)?.anon ?? r.session)),
      fpsMedian: round(median(rs.map((r) => r.fps ?? NaN)), 1),
      fpsP10: round(median(rs.map((r) => r.p10 ?? NaN)), 1),
      memoryMb: round(median(rs.map((r) => r.memory ?? NaN)), 0),
    })).sort((a, b) => b.samples - a.samples).slice(0, 30);
  };
  return {
    loads: loads.length,
    readyRate: rate(loads.filter((r) => r.ready).length, loads.length),
    readyMs: { p50: round(median(rows.map((r) => r.ready_ms).filter((x) => x != null)), 0), p90: round(quantile(rows.map((r) => r.ready_ms).filter((x) => x != null), 0.9), 0) },
    readyMsByDevice: [...byDevice.entries()].map(([device, xs]) => ({ device, sessions: xs.length, p50: round(median(xs), 0), p90: round(quantile(xs, 0.9), 0) })),
    fpsByDevice: group((r) => sessions.get(r.session)?.device ?? '(unknown)'),
    fpsByGpu: group((r) => String(r.gpu ?? sessions.get(r.session)?.gpu ?? '(unknown)')),
  };
}

// ------------------------------------------------------------------ builds side by side

export function kpis(product: string, f: Filters, now = Date.now()) {
  const rows = sessionsIn(product, f);
  const lw = eventWhere(product, f, ['level_start', 'level_end']);
  const tot = adb.prepare(`SELECT SUM(e.name = 'level_start') AS attempts, SUM(e.name = 'level_end' AND json_extract(e.props, '$.result') = 'complete') AS completes FROM events e WHERE ${lw.sql}`).get(...lw.args) as any;
  const attempts = tot?.attempts ?? 0;
  const completes = tot?.completes ?? 0;
  const fb = feedback(product, f, 0);
  const pf = perf(product, f);
  const loads = rows.filter((r) => r.load_t != null);
  return {
    sessions: rows.length,
    players: distinct(rows.map((r) => r.anon)),
    medianActiveSeconds: round(median(rows.map((r) => r.active_ms / 1000)), 0),
    readyRate: rate(loads.filter((r) => r.ready).length, loads.length),
    medianReadyMs: pf.readyMs.p50,
    errorRate: rate(rows.filter((r) => r.errors > 0).length, rows.length),
    levelCompletionRate: rate(completes, attempts),
    deathsPerSession: rows.length ? round(rows.reduce((a, r) => a + r.deaths, 0) / rows.length, 2) : null,
    medianMaxProgress: median(rows.map((r) => r.max_progress).filter((x) => x != null)),
    rating: fb.rating.average,
    upShare: fb.rating.upShare,
    fpsMedian: median(pf.fpsByDevice.map((x) => x.fpsMedian).filter((x): x is number => x != null)),
  };
}

/** Every KPI for two builds side by side (by default the two newest in the range). */
export function builds(product: string, f: Filters, a?: string, b?: string, now = Date.now()) {
  const w = sessionWhere(product, { ...f, build: undefined });
  const list = adb.prepare(`SELECT s.build AS build, MIN(s.started) AS first, MAX(s.commit_sha) AS commit_sha, MAX(s.build_date) AS date, COUNT(*) AS sessions FROM sessions s WHERE ${w.sql} AND s.started >= ? AND s.started < ? AND s.build IS NOT NULL GROUP BY s.build ORDER BY first DESC`).all(...w.args, f.from, f.to) as any[];
  const B = b ?? list[0]?.build;
  const A = a ?? list.find((x) => x.build !== B)?.build;
  const side = (v?: string) => (v ? { build: v, ...list.find((x) => x.build === v), kpis: kpis(product, { ...f, build: v }, now) } : null);
  return { builds: list, a: side(A), b: side(B) };
}

// ------------------------------------------------------------------ sessions, timeline, export

export function sessionList(product: string, f: Filters, limit = 50, offset = 0) {
  const w = sessionWhere(product, f);
  const total = (adb.prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE ${w.sql} AND s.started >= ? AND s.started < ?`).get(...w.args, f.from, f.to) as any).n;
  const items = adb.prepare(`SELECT s.id, s.anon, s.env, s.build, s.started, s.ended, s.active_ms, s.events, s.pages, s.ready, s.ready_ms, s.deaths, s.errors, s.levels_done, s.max_progress,
      s.last_level, s.last_screen, s.last_event, s.device, s.browser, s.os, s.country, s.city, s.referrer, s.bot, s.internal
    FROM sessions s WHERE ${w.sql} AND s.started >= ? AND s.started < ? ORDER BY s.started DESC LIMIT ? OFFSET ?`).all(...w.args, f.from, f.to, Math.min(500, limit), offset);
  return { total, items };
}

export function sessionTimeline(product: string, id: string) {
  const s: any = adb.prepare('SELECT * FROM sessions WHERE product = ? AND id = ?').get(product, id);
  if (!s) return null;
  if (s.exit) s.exit = JSON.parse(s.exit);
  const events = (adb.prepare('SELECT seq, at, t, name, page, screen, level, active, ctx, props FROM events WHERE product = ? AND session = ? ORDER BY seq LIMIT 5000').all(product, id) as any[]).map((e) => ({
    ...e, offsetMs: s.first_t != null ? e.t - s.first_t : null, ctx: e.ctx ? JSON.parse(e.ctx) : null, props: e.props ? JSON.parse(e.props) : null,
  }));
  return { session: s, events };
}

const csvCell = (v: any) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: any[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/** Raw rows for a spreadsheet or a notebook: events or sessions, at most 100,000. */
export function exportRows(product: string, f: Filters, what: 'events' | 'sessions', limit = 100_000): any[] {
  const n = Math.min(100_000, Math.max(1, limit));
  if (what === 'sessions') {
    const w = sessionWhere(product, f);
    return adb.prepare(`SELECT s.* FROM sessions s WHERE ${w.sql} AND s.started >= ? AND s.started < ? ORDER BY s.started LIMIT ?`).all(...w.args, f.from, f.to, n) as any[];
  }
  return eventsIn(product, f, null, 'at', n).map((e) => ({
    at: e.at, session: e.session, anon: e.anon, seq: e.seq, t: e.t, name: e.name, page: e.page, screen: e.screen, level: e.level, active: e.active, build: e.build, device: e.device, browser: e.browser, ctx: e.ctx, props: e.props,
  }));
}

// ------------------------------------------------------------------ insights

export const MIN_SAMPLE = { sessions: 30, attempts: 20, funnel: 20, errorSessions: 5 };

const pct = (x: number | null) => (x == null ? '?' : `${Math.round(x * 100)}%`);
const secs = (x: number | null) => (x == null ? '?' : x >= 120 ? `${Math.round(x / 60)} min` : `${Math.round(x)} s`);

/**
 * The biggest changes against the previous period of the same length and the worst drop-offs, as sentences with their
 * numbers and sample sizes. Nothing under the minimum sample is said, so agents don't chase noise.
 */
export function insights(product: string, f: Filters, now = Date.now()) {
  const len = f.to - f.from;
  const prevF = { ...f, from: f.from - len, to: f.from };
  const out: { kind: string; text: string; weight: number; n: number; data: any }[] = [];
  const cur = kpis(product, f, now);
  const prev = kpis(product, prevF, now);
  const enough = cur.sessions >= MIN_SAMPLE.sessions && prev.sessions >= MIN_SAMPLE.sessions;
  if (enough) {
    const change = (cur.sessions - prev.sessions) / prev.sessions;
    if (Math.abs(change) >= 0.2) out.push({ kind: 'traffic', weight: Math.abs(change), n: cur.sessions + prev.sessions, data: { now: cur.sessions, before: prev.sessions }, text: `Sessions ${change > 0 ? 'rose' : 'fell'} ${pct(Math.abs(change))}: ${cur.sessions} against ${prev.sessions} in the period before.` });
    if (cur.medianActiveSeconds != null && prev.medianActiveSeconds) {
      const c = (cur.medianActiveSeconds - prev.medianActiveSeconds) / prev.medianActiveSeconds;
      if (Math.abs(c) >= 0.2) out.push({ kind: 'engagement', weight: Math.abs(c), n: cur.sessions, data: { now: cur.medianActiveSeconds, before: prev.medianActiveSeconds }, text: `The median session ${c > 0 ? 'grew' : 'shrank'} from ${secs(prev.medianActiveSeconds)} to ${secs(cur.medianActiveSeconds)} of active play (${cur.sessions} sessions).` });
    }
    for (const [k, label] of [['readyRate', 'reached the game'], ['errorRate', 'hit an error']] as const) {
      const a = cur[k];
      const b = prev[k];
      if (a != null && b != null && Math.abs(a - b) >= 0.05) out.push({ kind: k, weight: Math.abs(a - b) * 4, n: cur.sessions, data: { now: a, before: b }, text: `${pct(a)} of sessions ${label}, against ${pct(b)} before (${cur.sessions} vs ${prev.sessions} sessions).` });
    }
  }
  const lvNow = levels(product, f, now);
  const lvPrev = new Map(levels(product, prevF, now).map((x) => [x.level, x]));
  for (const x of lvNow) {
    const p = lvPrev.get(x.level);
    if (p && x.attempts >= MIN_SAMPLE.attempts && p.attempts >= MIN_SAMPLE.attempts && x.completionRate != null && p.completionRate != null && Math.abs(x.completionRate - p.completionRate) >= 0.1) {
      out.push({ kind: 'level', weight: Math.abs(x.completionRate - p.completionRate) * 3, n: x.attempts, data: { level: x.level, now: x.completionRate, before: p.completionRate }, text: `Level ${x.level} completion ${x.completionRate > p.completionRate ? 'rose' : 'fell'} to ${pct(x.completionRate)} from ${pct(p.completionRate)} (${x.attempts} attempts vs ${p.attempts}).` });
    }
    if (x.attempts >= MIN_SAMPLE.attempts && x.quitRate != null && x.quitRate >= 0.3) out.push({ kind: 'quit', weight: x.quitRate * 2, n: x.attempts, data: x, text: `${pct(x.quitRate)} of level ${x.level} attempts end in a quit (${x.quits + x.abandoned} of ${x.attempts}; ${x.deaths} deaths, completion ${pct(x.completionRate)}).` });
  }
  const drop = dropoff(product, f, now);
  if (drop.sessions >= MIN_SAMPLE.sessions) {
    if (drop.beforeReady.sessions && (drop.beforeReady.share ?? 0) >= 0.1) out.push({ kind: 'load', weight: (drop.beforeReady.share ?? 0) * 3, n: drop.sessions, data: drop.beforeReady, text: `${pct(drop.beforeReady.share)} of ${drop.sessions} sessions left before the game was ready (median wait ${secs(drop.beforeReady.medianWaitSeconds)}).` });
    const top = drop.byLevel[0];
    if (top && (top.share ?? 0) >= 0.15) out.push({ kind: 'dropoff', weight: (top.share ?? 0) * 2, n: drop.sessions, data: top, text: `${pct(top.share)} of ${drop.sessions} sessions ended in level ${top.value}${top.medianSecondsIn != null ? ` (median ${secs(top.medianSecondsIn)} into it)` : ''}.` });
  }
  const fn = funnel(product, f);
  if (fn.biggestLoss && fn.biggestLoss.of >= MIN_SAMPLE.funnel && (fn.biggestLoss.rate ?? 0) >= 0.2) out.push({ kind: 'funnel', weight: fn.biggestLoss.rate, n: fn.biggestLoss.of, data: fn.biggestLoss, text: `The funnel loses the most between ${fn.biggestLoss.after} and ${fn.biggestLoss.before}: ${fn.biggestLoss.lost} of ${fn.biggestLoss.of} players (${pct(fn.biggestLoss.rate)}).` });
  const er = errors(product, f);
  const topErr = er.groups[0];
  if (topErr && topErr.sessions >= MIN_SAMPLE.errorSessions && er.sessions >= MIN_SAMPLE.sessions) out.push({ kind: 'error', weight: (topErr.sessions / er.sessions) * 3, n: er.sessions, data: { signature: topErr.signature, sessions: topErr.sessions, browsers: topErr.browsers, builds: topErr.builds }, text: `"${String(topErr.message ?? topErr.signature).slice(0, 100)}" hit ${topErr.sessions} of ${er.sessions} sessions (${pct(topErr.sessions / er.sessions)}), mostly on ${Object.keys(topErr.browsers)[0]}.` });
  out.sort((a, b) => b.weight - a.weight);
  return { from: f.from, to: f.to, sessions: cur.sessions, minimumSample: MIN_SAMPLE, insights: out.map(({ weight, ...x }) => x) };
}

export const SECTIONS = { traffic, sessions: sessionStats, retention, funnel, dropoff, levels, deaths, features, feedback, errors, perf } as const;
