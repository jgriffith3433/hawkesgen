// The analytics database (.data/analytics.db, apart from the main one): raw events, one row per session kept up to date
// as events arrive, and daily rollups. Raw events are kept 13 months; sessions (without their exit snapshot) and the
// rollups forever. docs/analytics.md.

import { DatabaseSync } from 'node:sqlite';
import { paths } from '../config.ts';
import type { Geo } from './geo.ts';
import type { Agent } from './ua.ts';

export const adb = new DatabaseSync(paths.analytics);
adb.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

const MIGRATIONS: string[] = [
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     product TEXT NOT NULL,
     session TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     t INTEGER NOT NULL,
     name TEXT NOT NULL,
     page TEXT,
     screen TEXT,
     level TEXT,
     active INTEGER,
     ctx TEXT,
     props TEXT
   );
   CREATE UNIQUE INDEX events_seq ON events (product, session, seq);
   CREATE INDEX events_time ON events (product, at);
   CREATE INDEX events_at ON events (at);
   CREATE INDEX events_name ON events (product, name, at);
   CREATE INDEX events_level ON events (product, level, at) WHERE level IS NOT NULL;

   CREATE TABLE sessions (
     product TEXT NOT NULL,
     id TEXT NOT NULL,
     anon TEXT NOT NULL,
     env TEXT NOT NULL,
     build TEXT,
     commit_sha TEXT,
     build_date TEXT,
     started INTEGER NOT NULL,
     ended INTEGER NOT NULL,
     first_t INTEGER,
     last_t INTEGER,
     active_ms INTEGER NOT NULL DEFAULT 0,
     events INTEGER NOT NULL DEFAULT 0,
     pages INTEGER NOT NULL DEFAULT 0,
     max_progress REAL,
     last_event TEXT,
     last_screen TEXT,
     last_level TEXT,
     level_t INTEGER,
     level_open INTEGER NOT NULL DEFAULT 0,
     load_t INTEGER,
     ready INTEGER NOT NULL DEFAULT 0,
     ready_ms INTEGER,
     deaths INTEGER NOT NULL DEFAULT 0,
     errors INTEGER NOT NULL DEFAULT 0,
     levels_done INTEGER NOT NULL DEFAULT 0,
     exit TEXT,
     browser TEXT, browser_version TEXT, os TEXT, os_version TEXT, device TEXT,
     screen TEXT, lang TEXT, gpu TEXT,
     country TEXT, region TEXT, city TEXT, tz TEXT,
     referrer TEXT, landing TEXT,
     utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
     bot INTEGER NOT NULL DEFAULT 0,
     internal INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (product, id)
   ) WITHOUT ROWID;
   CREATE INDEX sessions_started ON sessions (product, started);
   CREATE INDEX sessions_ended ON sessions (product, ended);
   CREATE INDEX sessions_anon ON sessions (product, anon, started);

   CREATE TABLE daily (
     product TEXT NOT NULL,
     day TEXT NOT NULL,
     env TEXT NOT NULL,
     build TEXT NOT NULL,
     traffic TEXT NOT NULL,
     name TEXT NOT NULL,
     events INTEGER NOT NULL,
     sessions INTEGER NOT NULL,
     players INTEGER NOT NULL,
     PRIMARY KEY (product, day, env, build, traffic, name)
   ) WITHOUT ROWID;

   CREATE TABLE names (product TEXT NOT NULL, name TEXT NOT NULL, first INTEGER NOT NULL, PRIMARY KEY (product, name)) WITHOUT ROWID;`,
];

adb.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
{
  const version = Number((adb.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v?: string } | undefined)?.v ?? 0);
  for (let i = version; i < MIGRATIONS.length; i++) {
    adb.exec('BEGIN');
    try {
      adb.exec(MIGRATIONS[i]);
      adb.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(i + 1));
      adb.exec('COMMIT');
    } catch (e) {
      adb.exec('ROLLBACK');
      throw e;
    }
  }
}

/** A batch after validation (collect.ts): what the store keeps. No IP anywhere in it. */
export type Batch = {
  product: string;
  env: string;
  anon: string;
  session: string;
  build: { version: string | null; commit: string | null; date: string | null };
  device: { screen: string | null; lang: string | null; gpu: string | null; tz: string | null; touch: number };
  entry: { referrer: string | null; landing: string | null; utm: Record<string, string | null> };
  agent: Agent;
  geo: Geo | null;
  bot: boolean;
  internal: boolean;
  at: number;
  events: Ev[];
};
export type Ev = { name: string; seq: number; t: number; page: string | null; screen: string | null; level: string | null; active: number | null; ctx: Record<string, any> | null; props: Record<string, any> | null };

/** Housekeeping events that don't count as "the last thing the player did". */
const QUIET = new Set(['session_end', 'exit', 'perf']);

const insertEvent = adb.prepare('INSERT OR IGNORE INTO events (product, session, seq, at, t, name, page, screen, level, active, ctx, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const getSession = adb.prepare('SELECT * FROM sessions WHERE product = ? AND id = ?');
const SESSION_COLS = ['product', 'id', 'anon', 'env', 'build', 'commit_sha', 'build_date', 'started', 'ended', 'first_t', 'last_t', 'active_ms', 'events', 'pages', 'max_progress', 'last_event', 'last_screen', 'last_level', 'level_t', 'level_open', 'load_t', 'ready', 'ready_ms', 'deaths', 'errors', 'levels_done', 'exit', 'browser', 'browser_version', 'os', 'os_version', 'device', 'screen', 'lang', 'gpu', 'country', 'region', 'city', 'tz', 'referrer', 'landing', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'bot', 'internal'];
const putSession = adb.prepare(`INSERT OR REPLACE INTO sessions (${SESSION_COLS.join(', ')}) VALUES (${SESSION_COLS.map(() => '?').join(', ')})`);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Stores a batch and brings its session up to date. Returns how many events were new (retries are ignored by seq). */
export function ingest(b: Batch): number {
  let added = 0;
  adb.exec('BEGIN');
  try {
    const row: any = getSession.get(b.product, b.session);
    const s: any = row ? { ...row } : {
      product: b.product, id: b.session, anon: b.anon, env: b.env,
      build: b.build.version, commit_sha: b.build.commit, build_date: b.build.date,
      started: b.at, ended: b.at, first_t: null, last_t: null, active_ms: 0, events: 0, pages: 0,
      max_progress: null, last_event: null, last_screen: null, last_level: null, level_t: null, level_open: 0,
      load_t: null, ready: 0, ready_ms: null, deaths: 0, errors: 0, levels_done: 0, exit: null,
      browser: b.agent.browser, browser_version: b.agent.browserVersion, os: b.agent.os, os_version: b.agent.osVersion,
      device: b.device.touch > 1 && b.agent.os === 'macOS' ? 'tablet' : b.agent.device,
      screen: b.device.screen, lang: b.device.lang, gpu: b.device.gpu,
      country: b.geo?.country ?? null, region: b.geo?.region ?? null, city: b.geo?.city ?? null, tz: b.geo?.tz ?? b.device.tz,
      referrer: b.entry.referrer, landing: b.entry.landing,
      utm_source: b.entry.utm.source ?? null, utm_medium: b.entry.utm.medium ?? null, utm_campaign: b.entry.utm.campaign ?? null, utm_term: b.entry.utm.term ?? null, utm_content: b.entry.utm.content ?? null,
      bot: 0, internal: 0,
    };
    // What the first batch didn't know (the entry often comes with session_start, the GPU with perf).
    for (const [k, v] of [['build', b.build.version], ['commit_sha', b.build.commit], ['build_date', b.build.date], ['gpu', b.device.gpu], ['referrer', b.entry.referrer], ['landing', b.entry.landing], ['utm_source', b.entry.utm.source], ['utm_medium', b.entry.utm.medium], ['utm_campaign', b.entry.utm.campaign]] as const) {
      if (s[k] == null && v != null) s[k] = v;
    }
    if (b.bot) s.bot = 1;
    if (b.internal) s.internal = 1;
    s.ended = Math.max(s.ended, b.at);

    for (const e of [...b.events].sort((x, y) => x.seq - y.seq)) {
      const r = insertEvent.run(b.product, b.session, e.seq, b.at, e.t, e.name, e.page, e.screen, e.level, e.active, e.ctx ? JSON.stringify(e.ctx) : null, e.props ? JSON.stringify(e.props) : null);
      if (!r.changes) continue;
      added++;
      apply(s, e);
    }
    putSession.run(...SESSION_COLS.map((k) => s[k] ?? null));
    adb.exec('COMMIT');
  } catch (e) {
    adb.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/** One event's effect on its session row. Events of a batch arrive in seq order; batches may come late or twice. */
export function apply(s: any, e: Ev) {
  const p = e.props ?? {};
  s.events++;
  if (s.first_t == null || e.t < s.first_t) s.first_t = e.t;
  const latest = s.last_t == null || e.t >= s.last_t;
  if (latest) s.last_t = e.t;
  if (e.active != null) s.active_ms = Math.max(s.active_ms, e.active);
  if (latest && e.screen) s.last_screen = e.screen;
  if (latest && !QUIET.has(e.name)) s.last_event = e.name;
  if (latest && e.level != null) s.last_level = e.level;
  switch (e.name) {
    case 'page_view': s.pages++; break;
    case 'screen': if (latest && typeof p.name === 'string') s.last_screen = p.name; break;
    case 'game_load_start': if (s.load_t == null) s.load_t = e.t; break;
    case 'game_ready':
      if (!s.ready) {
        s.ready = 1;
        s.ready_ms = num(p.ms) ?? (s.load_t != null ? e.t - s.load_t : null);
      }
      break;
    case 'level_start': if (latest) { s.level_t = e.t; s.level_open = 1; } break;
    case 'level_end':
      if (latest && e.level === s.last_level) s.level_open = 0;
      if (p.result === 'complete') s.levels_done++;
      break;
    case 'progress': case 'checkpoint': {
      const v = num(p.step) ?? num(p.value);
      if (v != null) s.max_progress = Math.max(s.max_progress ?? v, v);
      break;
    }
    case 'death': s.deaths++; break;
    case 'error': s.errors++; break;
    case 'session_end': case 'exit': {
      const a = num(p.active);
      if (a != null) s.active_ms = Math.max(s.active_ms, Math.round(a * 1000));
      if (e.name === 'exit') s.exit = JSON.stringify(p);
      break;
    }
  }
}

/** Custom event names a product has used (capped per product in the registry). */
const names = new Map<string, Set<string>>();
export function knownNames(product: string): Set<string> {
  let set = names.get(product);
  if (!set) {
    set = new Set((adb.prepare('SELECT name FROM names WHERE product = ?').all(product) as any[]).map((r) => r.name));
    names.set(product, set);
  }
  return set;
}
export function addName(product: string, name: string) {
  knownNames(product).add(name);
  adb.prepare('INSERT OR IGNORE INTO names (product, name, first) VALUES (?, ?, ?)').run(product, name, Date.now());
}

export const DAY = 24 * 3600 * 1000;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const RAW_KEEP = 396 * DAY; // 13 months

/** Recomputes the daily rollups for these UTC days (idempotent). */
export function rollup(days: string[]) {
  const traffic = "CASE WHEN s.bot = 1 THEN 'bot' WHEN s.internal = 1 THEN 'internal' ELSE 'human' END";
  for (const day of new Set(days)) {
    const from = Date.parse(`${day}T00:00:00Z`);
    const to = from + DAY;
    adb.exec('BEGIN');
    try {
      adb.prepare('DELETE FROM daily WHERE day = ?').run(day);
      adb.prepare(`INSERT INTO daily (product, day, env, build, traffic, name, events, sessions, players)
        SELECT e.product, ?, s.env, COALESCE(s.build, ''), ${traffic}, e.name, COUNT(*), COUNT(DISTINCT e.session), COUNT(DISTINCT s.anon)
        FROM events e JOIN sessions s ON s.product = e.product AND s.id = e.session
        WHERE e.at >= ? AND e.at < ? GROUP BY e.product, s.env, COALESCE(s.build, ''), ${traffic}, e.name`).run(day, from, to);
      // name '*': the sessions that started that day, their players and active minutes (events = active seconds).
      adb.prepare(`INSERT INTO daily (product, day, env, build, traffic, name, events, sessions, players)
        SELECT s.product, ?, s.env, COALESCE(s.build, ''), ${traffic}, '*', SUM(s.active_ms) / 1000, COUNT(*), COUNT(DISTINCT s.anon)
        FROM sessions s WHERE s.started >= ? AND s.started < ? GROUP BY s.product, s.env, COALESCE(s.build, ''), ${traffic}`).run(day, from, to);
      adb.exec('COMMIT');
    } catch (e) {
      adb.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Raw events older than 13 months go (their days rolled up first); sessions stay, without the exit snapshot. */
export function purge(now = Date.now()) {
  const cutoff = now - RAW_KEEP;
  const old = adb.prepare('SELECT MIN(at) AS a FROM events').get() as any;
  if (old?.a == null || old.a >= cutoff) return 0;
  const days: string[] = [];
  for (let d = Date.parse(`${dayOf(old.a)}T00:00:00Z`); d < cutoff; d += DAY) days.push(dayOf(d));
  rollup(days);
  let removed = 0;
  for (;;) {
    const r = adb.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE at < ? LIMIT 5000)').run(cutoff);
    removed += Number(r.changes);
    if (!r.changes) break;
  }
  adb.prepare('UPDATE sessions SET exit = NULL WHERE ended < ? AND exit IS NOT NULL').run(cutoff);
  return removed;
}

let timer: NodeJS.Timeout | null = null;
/** Every 10 minutes: today's and yesterday's rollups; once a day, the purge. */
export function startMaintenance() {
  if (timer) return;
  let lastPurge = 0;
  const tick = () => {
    try {
      const now = Date.now();
      rollup([dayOf(now - DAY), dayOf(now)]);
      if (now - lastPurge > DAY) {
        lastPurge = now;
        purge(now);
      }
    } catch (e: any) {
      console.warn(`[analytics] maintenance: ${e.message}`);
    }
  };
  timer = setInterval(tick, 10 * 60_000);
  timer.unref();
  setTimeout(tick, 30_000).unref();
}
