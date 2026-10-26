// What Gen does for Hawkes Net, which runs on its own box (src/netbridge.ts): says who a key is (narrowed like every Gen
// call), files the box's usage in Gen's usage table with what the relay costs, and sends everything else to the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-netbridge-'));
process.env.HAWKESGEN_NET_URL = 'https://net.example';
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');
const { usageSummary } = await import('../src/usage.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const gen = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

const portal = createClient('portal', 'user', ['usr_*']).key;
const box = createClient('net box', 'user', ['hawkesnet']).key;

test('whoami: the calling key, narrowed by X-Hawkesgen-Project; an unknown key is refused', async () => {
  const r = await fetch(`${gen}/v1/net/whoami`, { headers: { Authorization: `Bearer ${portal}`, 'X-Hawkesgen-Project': 'usr_00000000000000aa' } });
  assert.equal(r.status, 200);
  const c = (await r.json()).client;
  assert.equal(c.role, 'user');
  assert.deepEqual(c.projects, ['usr_00000000000000aa']);
  assert.equal((await fetch(`${gen}/v1/net/whoami`, { headers: { Authorization: 'Bearer hg_nope' } })).status, 401);
});

test("usage from the box lands in Gen's usage table: relay GB priced, peer to peer and test rooms free; only a hawkesnet key may send it", async () => {
  const rep = { node: 'net-1', rows: [
    { project: 'usr_00000000000000aa', transport: 'relay', playerSeconds: 600, bytesOut: 2e9, bytesIn: 1e8 },
    { project: 'usr_00000000000000aa', transport: 'p2p', playerSeconds: 120, bytesOut: 1e6 },
    { project: 'netdemo', transport: 'relay', playerSeconds: 60, bytesOut: 1e9, test: true },
  ] };
  const send = (key: string) => fetch(`${gen}/v1/net/usage`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rep) });
  assert.equal((await send(portal)).status, 403, 'the portal key is not the box');
  assert.equal((await send(box)).status, 200);
  const rows = usageSummary({ since: 0, by: 'project' }).rows.filter((r: any) => r.provider === 'hawkesnet');
  const row = (grp: string, unit: string) => rows.find((r: any) => r.grp === grp && r.unit === unit);
  assert.equal(row('usr_00000000000000aa', 'player-minute:relay')?.amount, 10);
  assert.ok(Math.abs(row('usr_00000000000000aa', 'gb:relay')?.cost - 0.18) < 1e-9, 'relay GB at $0.09');
  assert.equal(row('usr_00000000000000aa', 'gb:p2p')?.cost, 0, 'peer to peer costs us nothing');
  assert.equal(row('netdemo', 'gb:relay')?.cost, 0, 'test rooms are free');
});

test('everything else goes to the box: a 308 keeping method, path and query; a preflight is answered here; no relay in Gen', async () => {
  const r = await fetch(`${gen}/v1/net/ticket?x=1`, { method: 'POST', redirect: 'manual', body: '{}' });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), 'https://net.example/v1/net/ticket?x=1');
  const sdk = await fetch(`${gen}/sdk/hawkes-net@1.mjs`, { redirect: 'manual' });
  assert.equal(sdk.status, 308);
  assert.equal(sdk.headers.get('location'), 'https://net.example/sdk/hawkes-net@1.mjs');
  const pre = await fetch(`${gen}/v1/net/ticket`, { method: 'OPTIONS', headers: { Origin: 'https://game.example' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://game.example');
  // Gen takes no WebSocket upgrades at all now.
  const up = await new Promise<number | string>((resolve) => {
    const req = http.request(`${gen}/v1/net/ws`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', () => resolve('upgraded'));
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', () => resolve('closed'));
    req.end();
  });
  assert.notEqual(up, 'upgraded');
});
