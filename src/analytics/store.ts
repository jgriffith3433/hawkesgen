// The analytics database (.data/analytics.db, apart from the main one): raw events, one row per session kept up to date
// as events arrive, and daily rollups. Raw events are kept 13 months; sessions (without their exit snapshot) and the
// rollups forever. docs/analytics.md.

import crypto from 'node:crypto';
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
  // The site's own account id (identify) and what got in the player's way (frustration events and rage clicks).
  `ALTER TABLE sessions ADD COLUMN user_id TEXT;
   ALTER TABLE sessions ADD COLUMN frustrations INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX sessions_user ON sessions (product, user_id, started) WHERE user_id IS NOT NULL;`,
  // The network a session came from as a salted one-way hash (never the IP), and J's "that was me" marks on a network
  // or a browser's anon id: the sessions they match are internal, past and future (markInternal).
  `ALTER TABLE sessions ADD COLUMN net TEXT;
   CREATE INDEX sessions_net ON sessions (net, started) WHERE net IS NOT NULL;
   CREATE INDEX sessions_anon_any ON sessions (anon);
   CREATE TABLE marks (kind TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, note TEXT, PRIMARY KEY (kind, value)) WITHOUT ROWID;`,
  // Why a session is a bot (botVerdict), the data centre or crawler it came from (datacenter.ts), and marks that say
  // "not a person" as well as "that was me".
  `ALTER TABLE sessions ADD COLUMN bot_reason TEXT;
   ALTER TABLE sessions ADD COLUMN dc TEXT;
   ALTER TABLE marks ADD COLUMN what TEXT NOT NULL DEFAULT 'me';`,
  // A person touched the page (the SDK's first_input, v3): what the cloud rule and engaged sessions go by.
  `ALTER TABLE sessions ADD COLUMN input INTEGER NOT NULL DEFAULT 0;`,
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
  /** The site's account id, when the page called identify. */
  user: string | null;
  /** The visitor's network as a salted hash (netOf), never the IP. */
  net?: string | null;
  /** The crawler or cloud whose published range the visitor came from (datacenter.ts), as kind:name. */
  dc?: string | null;
  /** Why the batch is a bot (user agent, webdriver, playtest), when it is. */
  botReason?: string | null;
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
const SESSION_COLS = ['product', 'id', 'anon', 'env', 'build', 'commit_sha', 'build_date', 'started', 'ended', 'first_t', 'last_t', 'active_ms', 'events', 'pages', 'max_progress', 'last_event', 'last_screen', 'last_level', 'level_t', 'level_open', 'load_t', 'ready', 'ready_ms', 'deaths', 'errors', 'levels_done', 'exit', 'browser', 'browser_version', 'os', 'os_version', 'device', 'screen', 'lang', 'gpu', 'country', 'region', 'city', 'tz', 'referrer', 'landing', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'bot', 'internal', 'user_id', 'frustrations', 'net', 'bot_reason', 'dc', 'input'];
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
      bot: 0, internal: 0, user_id: null, frustrations: 0, net: b.net ?? null, bot_reason: null, dc: b.dc ?? null, input: 0,
    };
    // What the first batch didn't know (the entry often comes with session_start, the GPU with perf).
    for (const [k, v] of [['build', b.build.version], ['commit_sha', b.build.commit], ['build_date', b.build.date], ['gpu', b.device.gpu], ['referrer', b.entry.referrer], ['landing', b.entry.landing], ['utm_source', b.entry.utm.source], ['utm_medium', b.entry.utm.medium], ['utm_campaign', b.entry.utm.campaign]] as const) {
      if (s[k] == null && v != null) s[k] = v;
    }
    if (b.user) s.user_id = b.user; // the latest says (signed in partway through)
    if (b.bot) {
      s.bot = 1;
      if (!s.bot_reason || !HARD.test(s.bot_reason)) s.bot_reason = b.botReason ?? 'user agent';
    }
    if (b.net && !s.net) s.net = b.net;
    if (b.dc && !s.dc) s.dc = b.dc;
    if (b.internal || sessionMark(s, 'me')) s.internal = 1;
    s.ended = Math.max(s.ended, b.at);

    for (const e of [...b.events].sort((x, y) => x.seq - y.seq)) {
      const r = insertEvent.run(b.product, b.session, e.seq, b.at, e.t, e.name, e.page, e.screen, e.level, e.active, e.ctx ? JSON.stringify(e.ctx) : null, e.props ? JSON.stringify(e.props) : null);
      if (!r.changes) continue;
      added++;
      apply(s, e);
    }
    botVerdict(s); // after the events: a person's first input on a cloud's address makes it a person
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
    case 'frustration': case 'rage_click': s.frustrations = (s.frustrations ?? 0) + 1; break;
    case 'first_input': s.input = 1; break;
    case 'session_end': case 'exit': {
      const a = num(p.active);
      if (a != null) s.active_ms = Math.max(s.active_ms, Math.round(a * 1000));
      if (e.name === 'exit') s.exit = JSON.stringify(p);
      break;
    }
  }
}

// ---------------------------------------------------------------- networks and "that was me"

let salt: string | null = null;
/**
 * The visitor's network as a salted one-way hash, so a player's sessions group across sites, private windows and
 * browsers without the IP being kept. IPv4: the address; IPv6: its /64 (a phone's privacy addresses rotate inside it).
 * The salt lives only in this database.
 */
export function netOf(ip: string | null): string | null {
  if (!ip) return null;
  const a = ip.replace(/^::ffff:/i, '').trim();
  let key = a;
  if (a.includes(':')) {
    const [head, tail] = a.split('::');
    const left = head ? head.split(':') : [];
    const right = tail != null ? (tail ? tail.split(':') : []) : [];
    const groups = tail != null ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
    key = groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':') + '::/64';
  }
  if (!salt) {
    adb.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('net_salt', ?)").run(crypto.randomBytes(24).toString('base64url'));
    salt = (adb.prepare("SELECT v FROM meta WHERE k = 'net_salt'").get() as { v: string }).v;
  }
  return 'n_' + crypto.createHmac('sha256', salt).update(key).digest('base64url').slice(0, 16);
}

export type MarkKind = 'net' | 'anon';
/** What a mark says: the sessions are J's own ("that was me"), or not a person ("not a person"). */
export type MarkWhat = 'me' | 'bot';
let marks: Map<string, MarkWhat> | null = null;
const markMap = () => (marks ??= new Map((adb.prepare('SELECT kind, value, what FROM marks').all() as any[]).map((r) => [`${r.kind}:${r.value}`, r.what])));
/** What a network's or browser's mark says, if it has one. */
export const markOf = (kind: MarkKind, value: string | null | undefined): MarkWhat | undefined => (value ? markMap().get(`${kind}:${value}`) : undefined);
const sessionMark = (s: { anon: string; net?: string | null }, what: MarkWhat) => markOf('anon', s.anon) === what || markOf('net', s.net) === what;
export const listMarks = () => adb.prepare('SELECT kind, value, what, at, note FROM marks ORDER BY at DESC').all() as { kind: MarkKind; value: string; what: MarkWhat; at: number; note: string | null }[];

// ---------------------------------------------------------------- the bot verdict

/** Reasons that stay whatever the session does next (declared bots, automation, J's "not a person"). */
const HARD = /^(user agent|webdriver|playtest|automation|crawler|marked)/;

/**
 * Whether a session is a bot, and why (docs/analytics.md, "Bots"): a bot user agent, navigator.webdriver, Studio's
 * playtest, automation left on the page, a crawler's published range, J's "not a person" mark: always. A cloud's
 * range (datacenter.ts): unless a person touched the page (the SDK's first_input: a trusted click, tap, key, wheel or
 * mouse move), so someone on a VPN still counts; pages on an older SDK never send it, so their cloud visits are bots.
 * Sessions from before reasons were kept stay as they were.
 */
export function botVerdict(s: any): void {
  if (sessionMark(s, 'bot')) {
    s.bot = 1;
    if (!s.bot_reason || !HARD.test(s.bot_reason)) s.bot_reason = 'marked';
    return;
  }
  if (s.bot_reason && HARD.test(s.bot_reason) && s.bot_reason !== 'marked') return;
  if (s.bot && !s.bot_reason) return; // from before reasons were kept
  const [kind, ...rest] = String(s.dc ?? '').split(':');
  const name = rest.join(':');
  if (kind === 'crawler') {
    s.bot = 1;
    s.bot_reason = `crawler (${name})`;
  } else if (kind === 'cloud' && !s.input) {
    s.bot = 1;
    s.bot_reason = `data centre (${name})`;
  } else {
    s.bot = 0;
    s.bot_reason = null;
  }
}

/** Days (UTC) of the sessions a mark matches, for the rollups. */
const daysOf = (kind: MarkKind, value: string) => (adb.prepare(`SELECT DISTINCT started FROM sessions WHERE ${kind} = ?`).all(value) as any[]).map((r) => dayOf(r.started));

/** The sessions a mark matches, brought up to date: internal from "me" marks, bot from the verdict. */
function settle(kind: MarkKind, value: string): number {
  let changed = 0;
  for (const r of adb.prepare(`SELECT product, id, anon, net, dc, input, bot, bot_reason, internal FROM sessions WHERE ${kind} = ?`).all(value) as any[]) {
    const s: any = { ...r };
    s.internal = sessionMark(s, 'me') ? 1 : markOf(kind, value) === 'bot' ? 0 : r.internal;
    botVerdict(s);
    if (s.internal !== r.internal || s.bot !== r.bot || s.bot_reason !== r.bot_reason) {
      adb.prepare('UPDATE sessions SET internal = ?, bot = ?, bot_reason = ? WHERE product = ? AND id = ?').run(s.internal, s.bot, s.bot_reason, r.product, r.id);
      changed++;
    }
  }
  return changed;
}

/**
 * J's marks from the players list: "that was me" (what 'me': every session it matches is internal, past and future) or
 * "not a person" (what 'bot': every session is a bot). Marking a network also marks the anon ids seen on it, so those
 * browsers keep the mark on other networks. A mark replaces the other kind on the same network or browser. Returns how
 * many sessions changed.
 */
export function mark(kind: MarkKind, value: string, what: MarkWhat = 'me', note: string | null = null, now = Date.now()): { sessions: number; anons: number } {
  const all: [MarkKind, string][] = [[kind, value]];
  if (kind === 'net') for (const r of adb.prepare('SELECT DISTINCT anon FROM sessions WHERE net = ?').all(value) as any[]) all.push(['anon', r.anon]);
  for (const [k, v] of all) {
    adb.prepare('INSERT INTO marks (kind, value, what, at, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET what = excluded.what, at = excluded.at, note = excluded.note')
      .run(k, v, what, now, k === kind ? note : `with net ${value}`);
  }
  marks = null;
  let changed = 0;
  adb.exec('BEGIN');
  try {
    for (const [k, v] of all) changed += settle(k, v);
    adb.exec('COMMIT');
  } catch (e) {
    adb.exec('ROLLBACK');
    throw e;
  }
  rollup(all.flatMap(([k, v]) => daysOf(k, v)));
  return { sessions: changed, anons: all.length - 1 };
}

/** "That was me", kept for callers that only know that one. */
export const markInternal = (kind: MarkKind, value: string, note: string | null = null, now = Date.now()) => mark(kind, value, 'me', note, now);

/**
 * Takes a mark back (with the anon marks that came with a network's). Its sessions are judged again without it: they
 * count unless another mark or the bot verdict says otherwise. A browser's own ?hawkes-internal=1 flag isn't kept
 * apart, so those sessions count again too.
 */
export function unmark(kind: MarkKind, value: string): { sessions: number } {
  const all: [MarkKind, string][] = [[kind, value]];
  if (kind === 'net') for (const r of adb.prepare("SELECT value FROM marks WHERE kind = 'anon' AND note = ?").all(`with net ${value}`) as any[]) all.push(['anon', r.value]);
  for (const [k, v] of all) adb.prepare('DELETE FROM marks WHERE kind = ? AND value = ?').run(k, v);
  marks = null;
  let changed = 0;
  adb.exec('BEGIN');
  try {
    for (const [k, v] of all) {
      // Unmarked: "me" sessions lose internal unless another "me" mark holds them; "bot" ones are judged again.
      for (const r of adb.prepare(`SELECT product, id, anon, net, dc, input, bot, bot_reason, internal FROM sessions WHERE ${k} = ?`).all(v) as any[]) {
        const s: any = { ...r };
        s.internal = sessionMark(s, 'me') ? 1 : 0;
        if (s.bot_reason === 'marked') s.bot_reason = null;
        if (r.bot && r.bot_reason === 'marked') s.bot = 0;
        botVerdict(s);
        if (s.internal !== r.internal || s.bot !== r.bot || s.bot_reason !== r.bot_reason) {
          adb.prepare('UPDATE sessions SET internal = ?, bot = ?, bot_reason = ? WHERE product = ? AND id = ?').run(s.internal, s.bot, s.bot_reason, r.product, r.id);
          changed++;
        }
      }
    }
    adb.exec('COMMIT');
  } catch (e) {
    adb.exec('ROLLBACK');
    throw e;
  }
  rollup(all.flatMap(([k, v]) => daysOf(k, v)));
  return { sessions: changed };
}
export const unmarkInternal = unmark;

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
