// The Hawkes Net box (src/net/hub.ts) as its own process against a Gen: it checks keys with Gen (whoami, kept a minute),
// issues tickets and runs rooms from its own data folder, sends usage to Gen's usage table, and Gen, told a box serves,
// sends Hawkes Net requests there (308) and runs no relay itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-hub-gen-'));
process.env.HAWKESGEN_NET_EMBEDDED = '0';
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { usageSummary } = await import('../src/usage.ts');
// @ts-ignore: plain JS SDK
const { join } = await import('../clients/js/hawkes-net.mjs');

const gen = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => gen.listen(0, '127.0.0.1', () => r()));
const genUrl = `http://127.0.0.1:${(gen.address() as any).port}`;
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

const nodeKey = createClient('net box', 'user', ['hawkesnet']).key;
const portalKey = createClient('portal', 'user', ['usr_*']).key;
const otherKey = createClient('someone', 'user', ['games-x']).key;
const port = await freePort();
const hubUrl = `http://127.0.0.1:${port}`;
let hub: ChildProcess;
const logs: string[] = [];
test.before(async () => {
  hub = spawn(process.execPath, [fileURLToPath(new URL('../src/net/hub.ts', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', NET_PORT: String(port), NET_HOST: '127.0.0.1', NET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hg-hub-')), NET_GEN_URL: genUrl, NET_GEN_KEY: nodeKey, NET_PUBLIC_URL: `ws://127.0.0.1:${port}/v1/net/ws`, NET_WORKERS: '1', NET_USAGE_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout!.on('data', (d) => logs.push(String(d)));
  hub.stderr!.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${hubUrl}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the box did not start: ${logs.join('')}`);
});
test.after(async () => {
  if (hub && hub.exitCode === null) { hub.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); if (hub.exitCode === null) hub.kill('SIGKILL'); }
  gen.closeAllConnections(); gen.close();
  delete process.env.HAWKESGEN_NET_HUB;
});
const wait = async (pred: () => any, ms = 5000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
const post = (p: string, body: any, headers: Record<string, string> = {}) => fetch(`${hubUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the box checks keys with Gen: the portal narrowed to a customer gets tickets in that project, other keys and no key do not', async () => {
  const ok = await post('/v1/net/ticket', { project: 'usr_00000000000000aa', room: 'lobby', client: { protocols: [3] } }, { Authorization: `Bearer ${portalKey}`, 'X-Hawkesgen-Project': 'usr_00000000000000aa' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const t = await ok.json();
  assert.match(t.ticket, /^hn1\./);
  assert.equal(t.relayUrl, `ws://127.0.0.1:${port}/v1/net/ws`, 'the relay on the box');
  assert.equal((await post('/v1/net/ticket', { project: 'usr_00000000000000bb', room: 'lobby', client: { protocols: [3] } }, { Authorization: `Bearer ${portalKey}`, 'X-Hawkesgen-Project': 'usr_00000000000000aa' })).status, 403);
  assert.equal((await post('/v1/net/ticket', { project: 'usr_00000000000000aa', room: 'lobby', client: { protocols: [3] } }, { Authorization: `Bearer ${otherKey}` })).status, 403);
  assert.equal((await post('/v1/net/ticket', { project: 'usr_00000000000000aa', room: 'lobby', client: { protocols: [3] } }, { Authorization: 'Bearer hg_not_a_key' })).status, 401);
  assert.equal((await post('/v1/net/ticket', { project: 'hawkesgenwebsite', room: 'g/x/edit', client: { protocols: [3] } }, { Origin: 'http://localhost:5173' })).status, 403, 'localhost is no door on the box');
});

test('players play on the box, and their usage reaches Gen', async () => {
  const ticket = (name: string) => async () => (await post('/v1/net/ticket', { project: 'usr_00000000000000aa', room: 'match-1', name, transport: 'relay', client: { protocols: [3] } }, { Authorization: `Bearer ${portalKey}`, 'X-Hawkesgen-Project': 'usr_00000000000000aa' })).json();
  const a = await join('match-1', { ticket: ticket('Ada'), transport: 'relay', leaveOnHide: false, log: false });
  const b = await join('match-1', { ticket: ticket('Bo'), transport: 'relay', leaveOnHide: false, log: false });
  try {
    const got: any[] = [];
    b.on('hi', (d: any) => got.push(d));
    a.send('hi', { n: 1 });
    await wait(() => got.length, 5000, 'the message');
    assert.deepEqual(got[0], { n: 1 });
    // (The directory hears the count from the node within a few seconds.)
    const room = await wait(async () => { const j = await (await post('/v1/net/room', { project: 'usr_00000000000000aa', room: 'match-1' }, { Authorization: `Bearer ${portalKey}`, 'X-Hawkesgen-Project': 'usr_00000000000000aa' })).json(); return j.players === 2 ? j : null; }, 15_000, 'the directory to count both');
    assert.equal(room.open, true);
  } finally { await a.leave(); await b.leave(); }
  // The node reports usage (every 500 ms here, a minute on the box) and the box sends it on; Gen files it under the customer.
  await wait(() => usageSummary({ since: 0 }).rows.some((r: any) => r.grp === 'usr_00000000000000aa' && r.provider === 'hawkesnet' && String(r.unit).startsWith('player-minute:relay')), 15_000, `usage in Gen (${logs.join('').slice(-300)})`);
});

test('Gen, told a box serves, sends Hawkes Net there and keeps whoami and usage', async () => {
  process.env.HAWKESGEN_NET_HUB = 'https://net.example';
  const r = await fetch(`${genUrl}/v1/net/ticket?x=1`, { method: 'POST', redirect: 'manual', body: '{}' });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), 'https://net.example/v1/net/ticket?x=1');
  const who = await fetch(`${genUrl}/v1/net/whoami`, { headers: { Authorization: `Bearer ${portalKey}`, 'X-Hawkesgen-Project': 'usr_00000000000000aa' } });
  assert.equal(who.status, 200);
  assert.deepEqual((await who.json()).client.projects, ['usr_00000000000000aa'], 'narrowed like every Gen call');
  const svc = await import('../src/net/service.ts');
  assert.equal(await svc.startEmbedded(), null, 'no relay in Gen');
});
