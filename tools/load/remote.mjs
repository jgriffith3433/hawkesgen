#!/usr/bin/env node
// Hawkes Gen load harness, remote mode (docs/load.md): hold /v1/events streams and sign in test accounts on BETA only.
//
//   GEN_TEST_SIGNIN_SECRET=tss_... node tools/load/remote.mjs --accounts 30 --tabs 3
//
// Nothing paid runs: no tool, provider or GPU is touched. The "load" is sign-ins (POST /v1/users/test-session, project
// load-NNNN: no starter grant, not counted against the sign-up caps), held GET /v1/events streams (--tabs per account),
// and POST /v1/estimate (a free route: it only reads the job history) in place of job submits. Limiter-aware: a 429 waits
// its Retry-After, and the first 429 of each route is reported. Accounts are deleted at the end (and on Ctrl+C or error)
// with their own token. The secret comes from the environment, is never printed, and only https://beta.hawkesgen.ai is
// accepted (the health must say lane "beta").  Exit 0: every check passed; 1: one failed; 2: refused or aborted.
import crypto from 'node:crypto';
import fs from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : (process.argv[i + 1] ?? true); };
const OPT = {
  url: String(arg('url', 'https://beta.hawkesgen.ai')).replace(/\/+$/, ''),
  accounts: Math.max(1, Number(arg('accounts', 30))),
  tabs: Math.min(3, Math.max(1, Number(arg('tabs', 3)))), // the server keeps 3 streams per account
  duration: Number(arg('duration', 60)),                   // seconds of estimate calls while the streams are held
  rate: Number(arg('rate', 0.2)),                          // estimates per second per account
  hold: Number(arg('hold', 20)),                           // seconds to hold the streams before the load starts
  min: Number(arg('min-streams', 81)),                     // "more than 80" proves the Cloud Run concurrency
  p95: Number(arg('p95-ms', 2000)),
  keep: process.argv.includes('--keep'),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[load]', ...a);
const die = (m) => { console.error(`[load] ABORT: ${m}`); process.exit(2); };
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(OPT.url); // a local copy, to try the harness itself
if (OPT.url !== 'https://beta.hawkesgen.ai' && !LOCAL) die(`${OPT.url} is not https://beta.hawkesgen.ai: remote mode runs on beta only`);
const SECRET = process.env.GEN_TEST_SIGNIN_SECRET ?? '';
if (!/^tss_[\w-]{20,}$/.test(SECRET)) die('GEN_TEST_SIGNIN_SECRET is not set (it is beta\'s test sign-in secret, tss_...)');

const stats = new Map(); const first429 = new Map();
const norm = (p) => p.split('?')[0];
function note(route, ms, status) {
  const s = stats.get(route) ?? { ms: [], codes: {}, netErr: 0 }; stats.set(route, s);
  if (status === 0) s.netErr++; else s.ms.push(ms);
  s.codes[status] = (s.codes[status] ?? 0) + 1;
  if (status === 429 && !first429.has(route)) first429.set(route, Object.values(s.codes).reduce((a, v) => a + v, 0));
}
const pct = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.ceil((p / 100) * b.length) - 1)]; };
const token = (project) => {
  const exp = Math.floor(Date.now() / 1000) + 300, nonce = crypto.randomBytes(12).toString('hex');
  return { project, exp, nonce, sig: crypto.createHmac('sha256', SECRET).update(`${project}.${exp}.${nonce}`).digest('base64url') };
};
async function call(u, method, route, body, { retry = false } = {}) {
  for (;;) {
    const t = performance.now(); let status = 0, json = null, ra = 0;
    try {
      const r = await fetch(OPT.url + route, { method, headers: { ...(u?.cookie ? { cookie: u.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      status = r.status; ra = Number(r.headers.get('retry-after')) || 0;
      const sc = r.headers.get('set-cookie'); if (sc && u) u.cookie = sc.split(';')[0];
      json = await r.json().catch(() => null);
    } catch { status = 0; }
    note(`${method} ${norm(route)}`, performance.now() - t, status);
    if (status === 429 && retry && !stopping) { await sleep((ra || 5) * 1000 + 250); continue; } // the limiter says wait: wait
    return { status, json };
  }
}

const users = Array.from({ length: OPT.accounts }, (_, i) => ({ i, project: `load-${String(i).padStart(4, '0')}`, cookie: null, id: null, ok: false }));
let stopping = false, open = 0, peak = 0, opened = 0, dropped = 0, byes = 0;
const aborts = [];
const health = { rss: 0, heap: 0, lag: 0, samples: 0, pids: new Set(), bad: null, last: null };
async function sampleHealth() {
  try {
    const h = await (await fetch(`${OPT.url}/v1/health`)).json();
    health.samples++; health.last = h; health.pids.add(h.process?.pid);
    health.rss = Math.max(health.rss, h.process?.rssMb ?? 0); health.heap = Math.max(health.heap, h.process?.heapMb ?? 0); health.lag = Math.max(health.lag, h.loop?.maxMs ?? 0);
    if (h.lane !== 'beta' && !(LOCAL && h.lane === 'local')) health.bad = `health says lane ${h.lane}`;
  } catch {}
}

async function holdStream(u) {
  const ac = new AbortController(); aborts.push(ac);
  let counted = false;
  try {
    const r = await fetch(`${OPT.url}/v1/events`, { headers: { cookie: u.cookie }, signal: ac.signal });
    note('GET /v1/events (open)', 0, r.status);
    if (r.status !== 200) return;
    counted = true; open++; opened++; peak = Math.max(peak, open);
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c, { stream: true }); if (buf.includes('event: bye')) { byes++; buf = ''; } if (buf.length > 1e5) buf = ''; }
  } catch {}
  if (counted) { open--; if (!stopping) dropped++; }
}

async function deleteAll() {
  let gone = 0, left = 0;
  for (const u of users) {
    if (!u.ok && !u.tried) continue;
    const r = await call(null, 'POST', '/v1/users/test-session/delete', token(u.project), { retry: true });
    if (r.status === 200) gone++; else left++;
  }
  return { gone, left };
}
async function shutdown() { stopping = true; for (const a of aborts) a.abort(); }
let cleaned = null;
async function cleanup() { if (OPT.keep || cleaned) return; cleaned = await deleteAll().catch(() => ({ gone: 0, left: users.length })); }
process.on('SIGINT', async () => { await shutdown(); await cleanup(); process.exit(130); });

async function main() {
  const h0 = await (await fetch(`${OPT.url}/v1/health`)).json().catch(() => null);
  if (!h0) die('beta health did not answer');
  if (h0.lane !== 'beta' && !(LOCAL && h0.lane === 'local')) die(`health says lane ${h0.lane}: refusing to run`);
  log(`beta ok: commit ${String(h0.commit ?? '?').slice(0, 7)}, rss ${h0.process?.rssMb} MB; ${OPT.accounts} accounts x ${OPT.tabs} tabs = ${OPT.accounts * OPT.tabs} streams wanted`);
  await sampleHealth();
  const ticker = setInterval(sampleHealth, 5000);
  let signedIn = 0;
  const t0 = performance.now();
  try {
    // 1. sign in, one at a time (sign-in is a strict route: 15 a minute per address, so a 429 waits its Retry-After)
    for (const u of users) {
      u.tried = true;
      const r = await call(u, 'POST', '/v1/users/test-session', token(u.project), { retry: true });
      if (r.status === 200 && u.cookie) { u.ok = true; u.id = r.json?.user?.id; signedIn++; if (r.json?.notice) log('notice on sign-in:', r.json.notice); }
      else log(`sign-in for ${u.project} gave ${r.status}`);
      // open this account's tabs straight away, so the streams are held while the rest sign in
      if (u.ok) for (let t = 0; t < OPT.tabs; t++) holdStream(u);
      if (u.i % 10 === 9) log(`${signedIn} signed in, ${open} streams open`);
    }
    log(`signed in ${signedIn}/${users.length} in ${Math.round((performance.now() - t0) / 1000)} s; ${open} streams open (peak ${peak})`);
    await sleep(OPT.hold * 1000);
    const heldAtLoad = open;
    log(`holding ${heldAtLoad} streams; free estimates at ${OPT.rate}/s per account for ${OPT.duration} s`);
    // 2. the free route in place of job submits (POST /v1/estimate reads history only)
    const end = Date.now() + OPT.duration * 1000, gap = 1000 / Math.max(0.01, OPT.rate);
    await Promise.all(users.filter((u) => u.ok).map(async (u) => {
      await sleep(Math.random() * gap);
      for (; Date.now() < end; ) {
        await call(u, 'POST', '/v1/estimate', { project: u.id, items: [{ tool: 'image.generate', params: { prompt: 'load', width: 512, height: 512 } }] });
        await sleep(gap);
      }
    }));
    const stillOpen = open;
    await sampleHealth();
    clearInterval(ticker);
    await shutdown();
    await cleanup();
    report({ signedIn, heldAtLoad, stillOpen });
  } catch (e) { clearInterval(ticker); await shutdown(); await cleanup(); throw e; }
}

function report({ signedIn, heldAtLoad, stillOpen }) {
  const rows = []; let failed = 0;
  const check = (name, ok, detail) => { rows.push({ name, ok, detail }); if (!ok) failed++; };
  const lines = [];
  lines.push('route'.padEnd(34) + 'n'.padStart(7) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + '  429'.padStart(6) + '  5xx'.padStart(6) + '  err'.padStart(6));
  let n5xx = 0, nErr = 0;
  for (const [route, s] of [...stats].sort()) {
    const c5 = Object.entries(s.codes).filter(([k]) => +k >= 500).reduce((a, [, v]) => a + v, 0);
    n5xx += c5; nErr += s.netErr;
    const o = route.endsWith('(open)'), n = Object.values(s.codes).reduce((a, v) => a + v, 0);
    lines.push(route.padEnd(34) + String(n).padStart(7) + String(o ? '-' : Math.round(pct(s.ms, 50))).padStart(8) + String(o ? '-' : Math.round(pct(s.ms, 95))).padStart(8) + String(o ? '-' : Math.round(pct(s.ms, 99))).padStart(8) + String(s.codes[429] ?? 0).padStart(6) + String(c5).padStart(6) + String(s.netErr).padStart(6));
  }
  const p95 = (r) => Math.round(pct(stats.get(r)?.ms ?? [], 95));
  const wanted = signedIn * OPT.tabs;
  check(`all ${OPT.accounts} accounts signed in`, signedIn === OPT.accounts, `${signedIn}`);
  check(`more than 80 streams open at once (need ${OPT.min}; wanted ${wanted})`, peak >= OPT.min && heldAtLoad >= Math.min(OPT.min, wanted), `peak ${peak}, ${heldAtLoad} when the load began, ${stillOpen} at its end`);
  check('streams stayed open (no drops)', dropped === 0, `${dropped} dropped, ${byes} bye`);
  check('no 5xx responses', n5xx === 0, `${n5xx}`);
  check('no connection errors', nErr === 0, `${nErr}`);
  check(`estimate p95 under ${OPT.p95} ms`, p95('POST /v1/estimate') <= OPT.p95, `${p95('POST /v1/estimate')} ms`);
  check('no unplanned restart on beta', health.pids.size <= 1, `${health.pids.size} pid(s) seen`);
  check('beta health stayed on the beta lane', !health.bad, health.bad ?? 'ok');
  check('accounts removed', OPT.keep || (cleaned && cleaned.left === 0), OPT.keep ? 'kept (--keep)' : `${cleaned?.gone ?? 0} deleted, ${cleaned?.left ?? '?'} left`);
  const out = [];
  out.push(...lines, '', `first 429 (count of calls on that route when it came): ${[...first429].map(([r, n]) => `${r} #${n}`).join(', ') || 'none'}`,
    `beta server: peak rss ${health.rss} MB (heap ${health.heap} MB), worst event-loop lag ${health.lag} ms, ${health.samples} health samples`, '',
    'check'.padEnd(66) + 'result'.padEnd(8) + 'detail', ...rows.map((r) => r.name.padEnd(65) + (r.ok ? 'pass' : 'FAIL').padEnd(8) + r.detail), '',
    `${failed ? 'FAIL' : 'PASS'}: ${rows.length - failed} of ${rows.length} checks passed. No tool, provider or GPU ran.`);
  console.log('\n' + out.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Load test on beta (${OPT.accounts} accounts x ${OPT.tabs} tabs)\n\`\`\`\n${out.join('\n')}\n\`\`\`\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('[load] error:', String(e?.message ?? e).replaceAll(SECRET, '***')); process.exit(2); });
