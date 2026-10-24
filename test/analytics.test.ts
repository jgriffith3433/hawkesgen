// Player analytics (src/analytics/, docs/analytics.md): the collect door (validation, limits, CORS, text/plain, the
// rate limit, never a 5xx), the IP never stored, user agents, GeoIP from a small .mmdb written here, the session rollup,
// retention / funnel / drop-off / levels math on fixture data, and the query filters. A scratch data folder; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-analytics-'));
process.env.HAWKESGEN_GEO = 'off';
const { handle } = await import('../src/api.ts');
const { paths } = await import('../src/config.ts');
const { parseUA } = await import('../src/analytics/ua.ts');
const { Mmdb, bufferSource } = await import('../src/analytics/mmdb.ts');
const { useGeoDb } = await import('../src/analytics/geo.ts');
const { normalize, resetRateLimits, LIMITS } = await import('../src/analytics/collect.ts');
const { ingest, adb, rollup, dayOf, DAY } = await import('../src/analytics/store.ts');
const Q = await import('../src/analytics/query.ts');

// ------------------------------------------------------------ a tiny MaxMind DB
function enc(v: any): Buffer {
  const ctrl = (type: number, size: number) => {
    const ext = type > 7;
    const head = Buffer.from([((ext ? 0 : type) << 5) | (size < 29 ? size : 29)]);
    return Buffer.concat([head, ext ? Buffer.from([type - 7]) : Buffer.alloc(0), size < 29 ? Buffer.alloc(0) : Buffer.from([size - 29])]);
  };
  if (v && v.$pointer != null) return Buffer.from([(1 << 5) | (v.$pointer >> 8), v.$pointer & 0xff]);
  if (typeof v === 'string') return Buffer.concat([ctrl(2, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === 'number' && !Number.isInteger(v)) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return Buffer.concat([ctrl(3, 8), b]);
  }
  if (typeof v === 'number') {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return Buffer.concat([ctrl(6, 4), b]);
  }
  if (Array.isArray(v)) return Buffer.concat([ctrl(11, v.length), ...v.map(enc)]);
  return Buffer.concat([ctrl(7, Object.keys(v).length), ...Object.entries(v).flatMap(([k, x]) => [enc(k), enc(x)])]);
}

function writeMmdb(entries: { bits: number[]; data: Buffer }[]): Buffer {
  type Node = { kids: (Node | number | null)[] };
  const root: Node = { kids: [null, null] };
  const datas: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    let n = root;
    for (let i = 0; i < e.bits.length - 1; i++) {
      const b = e.bits[i];
      if (!n.kids[b] || typeof n.kids[b] === 'number') n.kids[b] = { kids: [null, null] };
      n = n.kids[b] as Node;
    }
    n.kids[e.bits[e.bits.length - 1]] = off;
    datas.push(e.data);
    off += e.data.length;
  }
  const nodes: Node[] = [];
  const walk = (n: Node) => {
    nodes.push(n);
    for (const k of n.kids) if (k && typeof k === 'object') walk(k);
  };
  walk(root);
  const count = nodes.length;
  const tree = Buffer.alloc(count * 6);
  nodes.forEach((n, i) => n.kids.forEach((k, side) => {
    const v = k == null ? count : typeof k === 'number' ? count + 16 + k : nodes.indexOf(k);
    tree.writeUIntBE(v, i * 6 + side * 3, 3);
  }));
  const meta = enc({ node_count: count, record_size: 24, ip_version: 6, database_type: 'test-city', languages: ['en'] });
  return Buffer.concat([tree, Buffer.alloc(16), ...datas, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com'), meta]);
}

const bitsOf = (bytes: number[], len: number) => bytes.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1)).slice(0, len);
const ohio = enc({ city: { names: { en: 'Columbus' } }, country: { iso_code: 'US', names: { en: 'United States' } }, subdivisions: [{ names: { en: 'Ohio' } }], location: { latitude: 39.96, longitude: -83.01 } });
// The second record points at the first one's country map (a pointer into the data section).
const countryAt = ohio.indexOf(enc({ iso_code: 'US', names: { en: 'United States' } }));
const berlin = Buffer.concat([Buffer.from([(7 << 5) | 3]), enc('city'), enc({ names: { en: 'Berlin' } }), enc('country'), enc({ $pointer: countryAt }), enc('location'), enc({ time_zone: 'Europe/Berlin' })]);
const geoFile = path.join(process.env.HAWKESGEN_DATA_DIR!, 'test-city.mmdb');
fs.writeFileSync(geoFile, writeMmdb([
  { bits: [...new Array(96).fill(0), ...bitsOf([203, 0, 113], 24)], data: ohio },
  { bits: bitsOf([0x20, 0x01, 0x0d, 0xb8], 32), data: berlin },
]));
useGeoDb(geoFile);

// ------------------------------------------------------------ the server
const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const LIVE = 'https://sickofitgame.com';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

function post(body: any, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/analytics/collect`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: LIVE, 'User-Agent': CHROME, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
let n = 0;
const ids = () => ({ anon: `anon_${++n}_xxxxxxxx`, session: `sess_${n}_xxxxxxxx` });
const batch = (o: any, events: any[]) => ({ product: 'sickofit', build: { version: '1.4.2', commit: 'abc1234', date: '2026-10-18' }, ...o, events: events.map((e, i) => ({ seq: i, t: 1_760_000_000_000 + i * 1000, page: '/Game/', ...e })) });

test('user agents: browser, OS, device and bots', () => {
  assert.deepEqual(parseUA(CHROME), { browser: 'Chrome', browserVersion: '141', os: 'Windows', osVersion: '10/11', device: 'desktop', bot: false });
  const ip = parseUA(IPHONE);
  assert.equal(ip.browser, 'Safari'); assert.equal(ip.os, 'iOS'); assert.equal(ip.osVersion, '18.1'); assert.equal(ip.device, 'phone');
  const ipad = parseUA('Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1');
  assert.equal(ipad.browser, 'Chrome'); assert.equal(ipad.os, 'iPadOS'); assert.equal(ipad.device, 'tablet');
  const edge = parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71');
  assert.equal(edge.browser, 'Edge'); assert.equal(edge.os, 'macOS'); assert.equal(edge.osVersion, '10.15');
  const fx = parseUA('Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0');
  assert.equal(fx.browser, 'Firefox'); assert.equal(fx.os, 'Android'); assert.equal(fx.device, 'phone');
  assert.equal(parseUA('Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36').device, 'tablet');
  assert.equal(parseUA('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36').browser, 'Samsung Internet');
  for (const bot of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36', 'curl/8.5.0', 'facebookexternalhit/1.1', '']) assert.equal(parseUA(bot).bot, true, bot);
});

test('GeoIP: the mmdb reader finds IPv4 and IPv6 records (and follows pointers)', () => {
  const db = new Mmdb(bufferSource(fs.readFileSync(geoFile)));
  assert.equal(db.get('203.0.113.9').city.names.en, 'Columbus');
  assert.equal(db.get('::ffff:203.0.113.9')?.city?.names?.en ?? db.get('203.0.113.9').city.names.en, 'Columbus');
  const b = db.get('2001:db8::1');
  assert.equal(b.city.names.en, 'Berlin');
  assert.equal(b.country.iso_code, 'US'); // through the pointer
  assert.equal(b.location.time_zone, 'Europe/Berlin');
  assert.equal(db.get('198.51.100.1'), null);
  assert.equal(db.get('not an ip'), null);
});

test('validation and limits: names, seq, props trimmed, pages without queries, custom event cap', () => {
  const meta = { origin: LIVE, ua: CHROME, ip: null, now: Date.now() };
  const long = 'x'.repeat(5000);
  const props: Record<string, any> = { text: long, cause: long, 'bad key': 1, nested: { a: { b: { c: { d: 1 } } } }, list: new Array(80).fill(1), nan: NaN };
  for (let i = 0; i < 40; i++) props[`k${i}`] = i;
  const r = normalize(batch(ids(), [
    { name: 'feedback', props, page: 'https://sickofitgame.com/Game/?email=a@b.c#x' },
    { name: 'Level Start' },
    { name: 'level_start', seq: -1 },
    { name: 'level_start', seq: 'x' },
    { name: 'my_custom', props: { level: 3 } },
  ]), meta);
  assert.ok(r.batch);
  assert.equal(r.accepted, 2);
  assert.equal(r.dropped, 3);
  const fb = r.batch!.events[0];
  assert.equal(fb.page, '/Game/');
  assert.equal(Object.keys(fb.props!).length <= LIMITS.propKeys + 1, true);
  // Trimmed to the byte cap: the nested values go, plain ones stay short.
  assert.ok(JSON.stringify(fb.props).length <= LIMITS.propsBytes + 2000);
  assert.ok(!('bad key' in fb.props!));
  assert.equal(r.batch!.events[1].level, '3');

  const small = normalize(batch(ids(), [{ name: 'error', props: { message: 'm'.repeat(5000), stack: 's'.repeat(9000), deep: { a: { b: { c: 1 } } } } }]), meta).batch!.events[0].props!;
  assert.equal(small.message.length, LIMITS.longStrings.message);
  assert.equal(small.stack.length, LIMITS.longStrings.stack);
  assert.deepEqual(small.deep, { a: {} });

  const tooMany = normalize(batch(ids(), new Array(250).fill({ name: 'progress' }).map((e, i) => ({ ...e, seq: i }))), meta);
  assert.equal(tooMany.accepted, LIMITS.events);
  assert.equal(tooMany.dropped, 50);

  // Custom names: at most customEvents (50) distinct per product.
  for (let i = 0; i < 60; i++) normalize(batch(ids(), [{ name: `custom_${i}` }]), meta);
  assert.equal(normalize(batch(ids(), [{ name: 'custom_59' }]), meta).accepted, 0);
  assert.equal(normalize(batch(ids(), [{ name: 'custom_1' }]), meta).accepted, 1);

  for (const [body, reason] of [[{ ...batch(ids(), [{ name: 'page_view' }]), product: 'nope' }, 'unknown product'], [{ ...batch(ids(), [{ name: 'page_view' }]), anon: 'x' }, 'anon']] as const) {
    assert.match(normalize(body, meta).reason!, new RegExp(reason));
  }
  assert.match(normalize(batch(ids(), [{ name: 'page_view' }]), { ...meta, origin: 'https://evil.example' }).reason!, /origin/);
});

test('envs from the origin: live, beta, preview (/c/), local', () => {
  const meta = { ua: CHROME, ip: null, now: Date.now() };
  const env = (origin: string, page = '/') => normalize(batch(ids(), [{ name: 'page_view', page }]), { ...meta, origin }).batch?.env;
  assert.equal(env('https://sickofitgame.com'), 'live');
  assert.equal(env('https://www.sickofitgame.com'), 'live');
  assert.equal(env('https://sickofit.hawkesgen.com'), 'beta');
  assert.equal(env('https://sickofit.hawkesgen.com', '/c/c_0123abcd/Game/'), 'preview');
  assert.equal(env('http://localhost:5173'), 'local');
  assert.equal(env('https://dod.hawkesgen.com'), undefined); // another product's beta
});

test('collect over HTTP: text/plain, CORS for registered origins only, 64 KB cap, never a 5xx, rate limit', async () => {
  resetRateLimits();
  const pre = await fetch(`${base}/v1/analytics/collect`, { method: 'OPTIONS', headers: { Origin: LIVE, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), LIVE);
  const evil = await fetch(`${base}/v1/analytics/collect`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const r = await post(batch(ids(), [{ name: 'session_start' }, { name: 'page_view' }]));
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('access-control-allow-origin'), LIVE);
  assert.deepEqual(await r.json(), { ok: true, accepted: 2, dropped: 0 });

  const bad = await post(batch(ids(), [{ name: 'page_view' }]), { Origin: 'https://evil.example' });
  assert.equal(bad.status, 202);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal((await bad.json()).accepted, 0);

  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ product: 'sickofit', events: [{ name: 'x'.repeat(70_000) }] })).status, 413);
  assert.equal((await post('null')).status, 202);
  assert.equal((await post({ ...batch(ids(), [{ name: 'page_view' }]), events: 'nope' })).status, 202);

  resetRateLimits();
  let last = 0;
  for (let i = 0; i < LIMITS.perMinute.batches + 2; i++) last = (await post(batch(ids(), [{ name: 'page_view' }]))).status;
  assert.equal(last, 429);
  resetRateLimits();
});

test('the IP is used for the place and never stored', async () => {
  resetRateLimits();
  const id = ids();
  const r = await post(batch(id, [{ name: 'session_start' }]), { 'X-Forwarded-For': '203.0.113.77' });
  assert.equal((await r.json()).accepted, 1);
  const s: any = adb.prepare('SELECT * FROM sessions WHERE id = ?').get(id.session);
  assert.equal(s.country, 'US');
  assert.equal(s.region, 'Ohio');
  assert.equal(s.city, 'Columbus');
  adb.exec('PRAGMA wal_checkpoint(FULL)');
  for (const f of [paths.analytics, `${paths.analytics}-wal`]) {
    if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes('203.0.113.77'), `${f} holds the IP`);
  }
  for (const t of ['events', 'sessions', 'daily', 'names']) assert.ok(!JSON.stringify(adb.prepare(`SELECT * FROM ${t}`).all()).includes('203.0.113'), t);
});

test('the session rollup: active time, pages, ready, level, deaths, progress, exit; retries ignored', () => {
  const id = ids();
  const at = Date.parse('2026-10-10T10:00:00Z');
  const t0 = at;
  const b = (events: any[], extra: any = {}) => normalize({ ...batch(id, []), events, ...extra }, { origin: LIVE, ua: IPHONE, ip: null, now: at }).batch!;
  const first = b([
    { seq: 0, name: 'session_start', t: t0, active: 0 },
    { seq: 1, name: 'page_view', t: t0 + 100, active: 100 },
    { seq: 2, name: 'game_load_start', t: t0 + 200, active: 200 },
    { seq: 3, name: 'game_ready', t: t0 + 4200, active: 4200, props: { ms: 4000 } },
  ], { entry: { referrer: 'https://www.reddit.com/r/games/?utm=x', landing: '/Game/', utm: { source: 'reddit', campaign: 'launch' } }, device: { screen: '390x844', lang: 'en-US', tz: 'America/New_York', touch: 5 } });
  assert.equal(ingest(first), 4);
  const second = b([
    { seq: 4, name: 'level_start', t: t0 + 5000, active: 5000, ctx: { level: '1' } },
    { seq: 5, name: 'death', t: t0 + 20000, active: 20000, ctx: { level: '1' }, props: { cause: 'imp' } },
    { seq: 6, name: 'progress', t: t0 + 25000, active: 25000, props: { step: 3 } },
    { seq: 7, name: 'level_end', t: t0 + 30000, active: 30000, props: { level: '1', result: 'complete', duration: 25 } },
    { seq: 8, name: 'level_start', t: t0 + 31000, active: 31000, ctx: { level: '2' } },
    { seq: 9, name: 'exit', t: t0 + 71000, active: 61000, props: { active: 61, recent: [{ name: 'level_start' }], state: { hp: 3 } } },
  ]);
  assert.equal(ingest(second), 6);
  assert.equal(ingest(second), 0); // a retried beacon
  const s: any = adb.prepare('SELECT * FROM sessions WHERE id = ?').get(id.session);
  assert.equal(s.events, 10);
  assert.equal(s.pages, 1);
  assert.equal(s.active_ms, 61000);
  assert.equal(s.ready, 1);
  assert.equal(s.ready_ms, 4000);
  assert.equal(s.deaths, 1);
  assert.equal(s.levels_done, 1);
  assert.equal(s.max_progress, 3);
  assert.equal(s.last_level, '2');
  assert.equal(s.level_open, 1);
  assert.equal(s.last_t - s.level_t, 40000);
  assert.equal(s.last_event, 'level_start'); // exit is housekeeping
  assert.deepEqual(JSON.parse(s.exit).state, { hp: 3 });
  assert.equal(s.referrer, 'reddit.com/r/games/');
  assert.equal(s.utm_source, 'reddit');
  assert.equal(s.device, 'phone');
  assert.equal(s.os, 'iOS');
  assert.equal(s.tz, 'America/New_York');
  assert.equal(s.build, '1.4.2');
  assert.equal(s.commit_sha, 'abc1234');
  assert.equal(s.env, 'live');

  rollup([dayOf(at)]);
  const d: any = adb.prepare("SELECT * FROM daily WHERE product = 'sickofit' AND day = ? AND name = 'level_start' AND traffic = 'human'").get(dayOf(at));
  assert.equal(d.events, 2);
  assert.equal(d.sessions, 1);
});

// ------------------------------------------------------------ fixture data for the math: product phorigins
const NOW = Date.parse('2026-10-18T12:00:00Z');
const PH = 'https://phorigins.com';
let seqs = new Map<string, number>();
function play(anon: string, session: string, at: number, events: any[], o: { origin?: string; ua?: string; flags?: any; device?: any; build?: string } = {}) {
  const seq0 = seqs.get(session) ?? 0;
  const evs = events.map((e, i) => ({ seq: seq0 + i, t: at + (e.dt ?? i * 1000), page: '/play/', ...e }));
  seqs.set(session, seq0 + events.length);
  const r = normalize({ product: 'phorigins', anon, session, build: { version: o.build ?? '2.0' }, flags: o.flags, device: o.device, events: evs }, { origin: o.origin ?? PH, ua: o.ua ?? CHROME, ip: null, now: at });
  assert.ok(r.batch, r.reason);
  ingest(r.batch!);
}
const day = (d: number, h = 10) => Date.parse(`${dayOf(NOW + d * DAY)}T${String(h).padStart(2, '0')}:00:00Z`);
const L = (level: string, name = 'level_start', props: any = {}, dt?: number) => ({ name, ctx: { level }, props, ...(dt != null ? { dt } : {}) });

// P1: comes back on day 1 and day 8, plays through level 2 (one death and a retry in level 1).
play('player_one_xx', 'p1_session_a', day(-10), [{ name: 'game_load_start' }, { name: 'game_ready' }, L('1'), L('1', 'death', { cause: 'drone', where: 'lab' }), L('1', 'level_end', { result: 'death' }), L('1'), L('1', 'level_end', { result: 'complete', duration: 60 }), L('2'), L('2', 'level_end', { result: 'complete', duration: 90 }), { name: 'feature', props: { name: 'rewind' } }], { device: { screen: '1920x1080' } });
play('player_one_xx', 'p1_session_b', day(-9), [{ name: 'game_load_start' }, { name: 'game_ready' }, { name: 'feedback', props: { rating: 5, text: 'love the lab' } }]);
play('player_one_xx', 'p1_session_c', day(-2), [{ name: 'game_load_start' }, { name: 'game_ready' }]);
// P2: one session, quits inside level 1 forty seconds in.
play('player_two_xx', 'p2_session_a', day(-10), [{ name: 'game_load_start' }, { name: 'game_ready' }, L('1', 'level_start', {}, 5000), L('1', 'death', { cause: 'drone', where: 'lab' }, 45000)]);
// P3: ready, sits on the menu, comes back on day 7.
play('player_three_x', 'p3_session_a', day(-10), [{ name: 'game_load_start' }, { name: 'game_ready' }, { name: 'screen', screen: 'menu', props: { name: 'menu' } }, { name: 'feedback', props: { rating: 3 } }]);
play('player_three_x', 'p3_session_b', day(-3), [{ name: 'game_load_start' }, { name: 'game_ready' }]);
// P4: first seen yesterday, never ready, gives up after 12 seconds of loading.
play('player_four_xx', 'p4_session_a', day(-1), [{ name: 'game_load_start', dt: 0 }, { name: 'page_view', dt: 12000 }]);
// Not counted by default: a bot, an internal device, a beta session.
play('bot_player_xxx', 'bot_session_a', day(-5), [{ name: 'game_load_start' }, { name: 'game_ready' }], { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36' });
play('webdriver_xxxx', 'wd_session_a', day(-5), [{ name: 'game_ready' }], { flags: { webdriver: true } });
play('j_own_device_x', 'j_session_a', day(-5), [{ name: 'game_ready' }], { flags: { internal: true } });
play('beta_player_xx', 'beta_session_a', day(-5), [{ name: 'game_ready' }], { origin: 'https://phorigins.hawkesgen.com', build: '2.1' });

const F = (q: Record<string, string> = {}) => Q.parseFilters((k) => q[k] ?? (k === 'range' ? '30d' : undefined), NOW);

test('query filters: env live by default, bots and internal excluded, build / device / browser / country', () => {
  const ids = (f: any) => Q.sessionList('phorigins', f, 100).items.map((s: any) => s.id).sort();
  assert.equal(ids(F()).length, 7);
  assert.ok(!ids(F()).includes('bot_session_a'));
  assert.ok(ids(F({ bots: '1' })).includes('bot_session_a'));
  assert.ok(ids(F({ bots: '1' })).includes('wd_session_a'));
  assert.ok(ids(F({ internal: '1' })).includes('j_session_a'));
  assert.deepEqual(ids(F({ env: 'beta' })), ['beta_session_a']);
  assert.equal(ids(F({ env: 'all' })).length, 8);
  assert.deepEqual(ids(F({ env: 'beta', build: '2.1' })), ['beta_session_a']);
  assert.equal(ids(F({ device: 'phone' })).length, 0);
  assert.equal(ids(F({ browser: 'Chrome' })).length, 7);
  assert.deepEqual(ids(F({ range: '7d' })), ['p1_session_c', 'p3_session_b', 'p4_session_a']);
});

test('retention: rolling D1/D7 by first-seen week, only for players whose day has come', () => {
  const r = Q.retention('phorigins', F(), NOW);
  assert.equal(r.total.players, 4);
  assert.deepEqual(r.total.d1, { eligible: 4, returned: 2, rate: 0.5 });
  assert.deepEqual(r.total.d7, { eligible: 3, returned: 2, rate: 0.667 });
  assert.deepEqual(r.total.d30, { eligible: 0, returned: 0, rate: null });
  assert.equal(r.cohorts.reduce((a: number, c: any) => a + c.players, 0), 4);
});

test('segments: who sticks around, by their first session, and retention with and without each feature', () => {
  const s = Q.segments('phorigins', F(), NOW);
  assert.equal(s.total.players, 4);
  assert.deepEqual(s.total.d1, { eligible: 4, returned: 2, rate: 0.5 });
  assert.deepEqual(s.by.device.map((g: any) => [g.value, g.players]), [['desktop', 4]]);
  assert.deepEqual(s.by.entry.map((g: any) => g.value), ['(unknown)']);
  assert.equal(s.by.played[0].value, 'under 1 min');
  // P1 used rewind in their first session and came back; of the three who didn't, one came back by day 1 (P3).
  const rewind = s.features.find((x: any) => x.name === 'rewind')!;
  assert.deepEqual([rewind.with.players, rewind.with.d1.rate, rewind.without.players, rewind.without.d1.rate], [1, 1, 3, 0.333]);
  assert.equal(rewind.d1Lift, 0.667);
});

test('funnel: ordered steps per player, the default from the levels, the biggest loss', () => {
  const f = Q.funnel('phorigins', F(), Q.parseSteps('game_ready,level_start:level=1,level_start:level=2'));
  assert.deepEqual(f.steps.map((s: any) => s.count), [3, 2, 1]);
  assert.equal(f.steps[1].fromPrevious, 0.667);
  assert.deepEqual(f.biggestLoss, { after: 'game_ready', before: 'level_start:level=1', lost: 1, of: 3, rate: 0.333 });
  const d = Q.funnel('phorigins', F());
  assert.deepEqual(d.steps.map((s: any) => s.step), ['game_ready', 'level_start:level=1', 'level_start:level=2']);
  // Out of order doesn't count: level 2 before ready isn't a step 2.
  assert.deepEqual(Q.funnel('phorigins', F(), Q.parseSteps('level_start:level=2,game_load_start')).steps.map((s: any) => s.count), [1, 1]);
  assert.equal(Q.funnel('phorigins', F(), Q.parseSteps('game_ready'), 'session').steps[0].count, 6);
});

test('drop-off: before ready with the wait, by level with how far in', () => {
  const d = Q.dropoff('phorigins', F(), NOW);
  assert.equal(d.sessions, 7);
  assert.equal(d.beforeReady.sessions, 1);
  assert.equal(d.beforeReady.medianWaitSeconds, 12);
  const l1: any = d.byLevel.find((x: any) => x.value === '1');
  assert.equal(l1.sessions, 1);
  assert.equal(l1.medianSecondsIn, 40);
  assert.ok(d.byScreen.some((x: any) => x.value === 'menu'));
  assert.ok(d.biggest);
});

test('levels, deaths, features, feedback, perf, builds, insights (minimum sample)', () => {
  const lv = Q.levels('phorigins', F(), NOW);
  const l1: any = lv.find((x: any) => x.level === '1');
  assert.equal(l1.attempts, 3);
  assert.equal(l1.players, 2);
  assert.equal(l1.completes, 1);
  assert.equal(l1.completionRate, 0.333);
  assert.equal(l1.deaths, 2);
  assert.equal(l1.abandoned, 1);
  assert.equal(l1.medianRetriesBeforeFirstWin, 1);
  assert.equal(l1.medianSeconds, 60);
  assert.equal(l1.neverWon, 1);
  const de = Q.deaths('phorigins', F());
  assert.deepEqual(de.byCause[0], { value: 'drone', count: 2, players: 2 });
  const fe = Q.features('phorigins', F());
  assert.equal(fe.features[0].name, 'rewind');
  const fb = Q.feedback('phorigins', F());
  assert.equal(fb.rating.average, 4);
  assert.equal(fb.comments[0].text, 'love the lab');
  const pf = Q.perf('phorigins', F());
  assert.equal(pf.loads, 7);
  assert.equal(pf.readyRate, 0.857);
  const b = Q.builds('phorigins', F({ env: 'all' }), undefined, undefined, NOW);
  assert.equal(b.b.build, '2.1');
  assert.equal(b.a.build, '2.0');
  assert.equal(b.a.kpis.sessions, 7);
  // Seven sessions is under the minimum sample: nothing to say.
  assert.deepEqual(Q.insights('phorigins', F(), NOW).insights, []);
  const tl = Q.sessionTimeline('phorigins', 'p2_session_a')!;
  assert.equal(tl.events.length, 4);
  assert.equal(tl.events[3].offsetMs, 45000);
});

test('error signatures group the same error across numbers and URLs', () => {
  const a = Q.errorSignature('Cannot read properties of undefined (reading \'x\') at 12', 'TypeError\n    at foo (https://sickofitgame.com/Game/Build/game.js?v=1:10:5)');
  const b = Q.errorSignature('Cannot read properties of undefined (reading \'y\') at 99', 'TypeError\n    at foo (https://sickofitgame.com/Game/Build/game.js?v=1:44:9)');
  assert.equal(a, b);
});

test('the query API over HTTP: overview, a section, export as CSV, unknown product', async () => {
  const ov = await (await fetch(`${base}/v1/analytics/overview?env=all`)).json();
  assert.ok(ov.products.some((p: any) => p.product === 'phorigins'));
  const lv = await (await fetch(`${base}/v1/analytics/sickofit/levels?range=90d&from=2026-10-01`)).json();
  assert.ok(Array.isArray(lv));
  const csv = await fetch(`${base}/v1/analytics/sickofit/export?what=sessions&format=csv&from=2026-10-01`);
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.match(await csv.text(), /^product,id,anon/);
  assert.equal((await fetch(`${base}/v1/analytics/nope/levels`)).status, 404);
  assert.equal((await fetch(`${base}/v1/analytics/sickofit/nope`)).status, 404);
  const all = await (await fetch(`${base}/v1/analytics/phorigins?from=2026-09-01&to=2026-10-18`)).json();
  for (const k of ['traffic', 'sessions', 'retention', 'segments', 'funnel', 'dropoff', 'levels', 'deaths', 'features', 'feedback', 'errors', 'perf']) assert.ok(k in all, k);
});

test("a site's registry funnel is its default funnel (Hawkes Gen: visit, play, fun, sign up, build, share, buy)", () => {
  const steps = Q.defaultSteps('hawkesgen', F());
  assert.deepEqual(steps.map((s: any) => s.name), ['page_view', 'game_ready', 'first_fun', 'progress', 'signup', 'game_create', 'feature', 'game_share', 'purchase']);
  assert.deepEqual(steps[3].where, { step: '5' });
  assert.deepEqual(steps[6].where, { name: 'build_edit' });
});
