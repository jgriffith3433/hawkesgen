// Hawkes Net end to end in Gen: tickets from POST /v1/net/ticket, the node Gen runs itself (wss://<gen>/v1/net/ws), and
// the client SDK (clients/js/hawkes-net.mjs) in Node: a relay room (messages, avatars, things, ownership, synced states,
// actions), an 'auto' room that starts peer to peer on the signal route and moves to the relay when it grows (with no
// reliable message lost or repeated), the public ticket door, Gen's publish, and usage in Gen's usage table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-net-'));
process.env.HAWKESGEN_NET_WORKERS = '0';
const { handle } = await import('../src/api.ts');
const svc = await import('../src/net/service.ts');
const { refuse } = await import('../src/net/ws.ts');
const { usageSummary } = await import('../src/usage.ts');
// @ts-ignore: plain JS SDK
const { join } = await import('../clients/js/hawkes-net.mjs');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/v1/net/ws') return refuse(socket, 404, 'no');
  svc.embeddedNode()!.upgrade(req, socket, head);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
const endpoint = `http://127.0.0.1:${port}`;
await svc.startEmbedded();
for (let i = 0; i < 50 && !svc.status().up; i++) await new Promise((r) => setTimeout(r, 50));

test.after(async () => { await svc.stopEmbedded(); server.closeAllConnections(); server.close(); });

const wait = async (pred: () => any, ms = 4000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const opts = (o: any = {}) => ({ project: 'netdemo', endpoint, leaveOnHide: false, log: false, ...o });

test('the node inside Gen is up, and Gen hands out tickets for it', async () => {
  const st = svc.status();
  assert.ok(st.up, 'a node is up');
  const r = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'tk', sub: 'x', client: { sdk: '1', protocols: [3] } }) }).then((x) => x.json());
  assert.match(r.ticket, /^hn1\./);
  assert.equal(r.peer, 'p1');
  assert.match(r.relayUrl, /\/v1\/net\/ws$/);
  const r2 = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'tk', sub: 'y', client: { sdk: '1', protocols: [3] } }) }).then((x) => x.json());
  assert.equal(r2.peer, 'p2', 'join order counts up per room');
});

test('the public door: a page on one of the project\'s sites gets a player ticket; other sites do not', async () => {
  const ask = (origin: string, body: any = {}) => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'netdemo', room: 'door', sub: 's', client: { protocols: [3] }, ...body }) });
  assert.equal((await ask('https://hawkesgen.com')).status, 200);
  assert.equal((await ask('http://localhost:5173')).status, 200);
  assert.equal((await ask('https://evil.example')).status, 403);
  assert.equal((await ask('https://hawkesgen.com', { role: 'bot' })).status, 403, 'bots need a key');
  assert.equal((await ask('https://hawkesgen.com', { project: 'doseofdestruction', room: 'x' })).status, 403, 'only the project\'s own sites');
});

test('a relay room: messages once and in order, avatars, things only from their simulator, ownership, states, actions', async () => {
  const a = await join('relay1', opts({ name: 'Ada', transport: 'relay' }));
  const b = await join('relay1', opts({ name: 'Bo', transport: 'relay' }));
  try {
    assert.equal(a.transport, 'relay');
    assert.equal(a.host, a.id, 'the first in is the host');
    await wait(() => a.peers.has(b.id), 4000, 'A sees B');
    const got: number[] = [];
    b.on('n', (d: number) => got.push(d));
    for (let i = 0; i < 50; i++) a.send('n', i);
    await wait(() => got.length === 50, 4000, '50 messages');
    assert.deepEqual(got, [...Array(50).keys()]);
    // Avatars.
    let pose: any = null;
    b.onPose((id: string, s: any) => { if (id === a.id) pose = s; });
    a.pose([1, 2, 3], 1.5, { f: 1 });
    await wait(() => pose, 3000, 'a pose');
    assert.deepEqual(pose.p, [1, 2, 3]); assert.equal(pose.f, 1);
    // Things: the host simulates what nobody owns; B's pushes of a thing it doesn't own are dropped by its own SDK.
    const seen = new Map<string, number[]>();
    b.sync.onThing((id: string, _at: number, v: number[]) => seen.set(id, v.slice()));
    a.sync.push('ball', [4, 5, 6, 0, 0, 0, 1, 0, 0]);
    await wait(() => seen.get('ball'), 3000, 'the ball');
    assert.deepEqual(seen.get('ball')!.slice(0, 3), [4, 5, 6]);
    assert.equal(b.sync.mine('ball'), false);
    assert.equal(b.sync.claim('car', { hold: true }), true);
    await wait(() => a.sync.holder('car') === b.id, 3000, 'B holds the car');
    assert.equal(a.sync.claim('car'), false, "A can't take a held car");
    // A synced state from the host, and an action decided by the host.
    let weather: any = null;
    const sky = { rain: true, wind: 3 };
    a.sync.state('weather', { get: () => sky, set: () => {} });
    b.sync.state('weather', { get: () => ({}), set: (s: any) => { weather = s; } });
    await wait(() => weather, 4000, 'the weather');
    assert.deepEqual(weather, { rain: true, wind: 3 });
    const booms: any[] = [];
    const boomA = a.sync.action('boom', (d: any, c: any) => booms.push(['a', d, c.authoritative]));
    const boomB = b.sync.action('boom', (d: any, c: any) => booms.push(['b', d, c.authoritative]));
    boomB({ at: 1 });
    await wait(() => booms.length >= 2, 3000, 'the boom on both');
    assert.deepEqual(booms.find((x) => x[0] === 'a'), ['a', { at: 1 }, true], 'the host decides');
    assert.ok(a.stats().downBytes > 0 && b.stats().rttMs !== null, 'stats and a round trip');
    void boomA;
  } finally { await a.leave(); await b.leave(); }
});

test("'auto': peer to peer on the signal route, then the relay when a third joins; nothing reliable lost or repeated", async () => {
  const cfg = { config: { p2pMax: 2, maxPlayers: 8 } };
  const a = await join('auto1', opts({ name: 'Host', ...cfg }));
  const b = await join('auto1', opts({ name: 'Two', ...cfg }));
  const got: number[] = [];
  b.on('n', (d: number) => got.push(d));
  const moved: any[] = [];
  a.when('transport', (e: any) => moved.push(e));
  try {
    assert.equal(a.transport, 'p2p');
    assert.equal(b.transport, 'p2p');
    assert.equal(a.isHost, true);
    await wait(() => b.host === a.id, 3000, 'B knows the host');
    for (let i = 0; i < 20; i++) a.send('n', i);
    await wait(() => got.length === 20, 4000, '20 messages over p2p (signal route: Node has no WebRTC)');
    let seenBall: any = null;
    b.sync.onThing((id: string, _at: number, v: number[]) => { if (id === 'ball') seenBall = v.slice(); });
    a.sync.push('ball', [7, 8, 9]);
    await wait(() => seenBall, 3000, 'the ball over p2p');
    // A third player: past p2pMax 2, so the room moves to the relay, seeded by the host's copy of the world.
    const c = await join('auto1', opts({ name: 'Three', ...cfg }));
    try {
      await wait(() => a.transport === 'relay' && b.transport === 'relay' && c.transport === 'relay', 6000, 'everyone on the relay');
      assert.equal(moved.length, 1, 'one move');
      assert.equal(a.host, a.id, 'the host is still the host');
      for (let i = 20; i < 40; i++) a.send('n', i);
      await wait(() => got.length >= 40, 4000, '20 more messages over the relay');
      assert.deepEqual(got, [...Array(40).keys()], 'every message once, in order, across the move');
      const cBall = await wait(() => c.sync.thing('ball'), 4000, 'the newcomer gets the world the host had');
      assert.deepEqual(cBall.slice(0, 3), [7, 8, 9]);
    } finally { await c.leave(); }
  } finally { await a.leave(); await b.leave(); }
});

test("Gen's publish puts a server's world edit into the room", async () => {
  const a = await join('pub1', opts({ transport: 'relay' }));
  try {
    let ops: any = null;
    a.sync.onOps((o: any, meta: any) => { ops = { o, meta }; });
    const r = await fetch(`${endpoint}/v1/net/publish`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'pub1', ops: [{ op: 'create', entity: { id: 'tree' } }], by: 'Assistant' }) }).then((x) => x.json());
    assert.equal(r.delivered, 1);
    await wait(() => ops, 3000, 'the ops');
    assert.equal(ops.o[0].entity.id, 'tree');
    assert.equal(ops.meta.by, 'Assistant');
  } finally { await a.leave(); }
});

test("usage lands in Gen's usage table: player-minutes and GB per project and transport", async () => {
  const a = await join('use1', opts({ transport: 'relay' }));
  const b = await join('use1', opts({ transport: 'relay' }));
  for (let i = 0; i < 30; i++) { a.pose([i, 0, 0], 0); await new Promise((r) => setTimeout(r, 40)); }
  await new Promise((r) => setTimeout(r, 1100));
  await (svc.embeddedNode() as any).reportUsage();
  await a.leave(); await b.leave();
  const rows = usageSummary({ since: 0, by: 'project' }).rows.filter((r: any) => r.grp === 'netdemo' && r.provider === 'hawkesnet');
  assert.ok(rows.some((r: any) => r.unit === 'player-minute:relay' && r.amount > 0), JSON.stringify(rows));
  assert.ok(rows.some((r: any) => r.unit === 'gb:relay' && r.amount > 0));
});

test('a full room: the next join is refused with a reason', async () => {
  const a = await join('full1', opts({ transport: 'relay', config: { maxPlayers: 1 } }));
  try {
    await assert.rejects(join('full1', opts({ transport: 'relay' })), /full/);
  } finally { await a.leave(); }
});

test("an engine on raw messages (the portal's play/net.js): its own shapes both ways, and a hello to start from", async () => {
  const gotA: any[] = [];
  const gotB: any[] = [];
  const a = await join('raw1', opts({ transport: 'relay', name: 'A', onRaw: (m: any) => gotA.push(m) }));
  const b = await join('raw1', opts({ transport: 'relay', name: 'B', onRaw: (m: any) => gotB.push(m) }));
  try {
    assert.equal(gotA[0].t, 'hello');
    assert.equal(gotA[0].you, a.id);
    await wait(() => gotA.some((m) => m.t === 'join' && m.c === b.id), 3000, "A's raw join of B");
    a.raw.send({ t: 'xf', at: a.now(), x: [['crate', 0b111, 1, 2, 3]] });
    a.raw.send({ t: 'me', at: a.now(), s: { p: [4, 5, 6], y: 1, f: 1 } });
    a.raw.send({ t: 'ev', name: 'boom', data: { r: 2 } });
    a.raw.send({ t: 'own', id: 'car', on: true, lock: 1 });
    await wait(() => gotB.some((m) => m.t === 'xf') && gotB.some((m) => m.t === 'me') && gotB.some((m) => m.t === 'ev' && m.name === 'boom') && gotB.some((m) => m.t === 'own'), 3000, 'all four on B');
    assert.deepEqual(gotB.find((m) => m.t === 'xf').x[0], ['crate', 7, 1, 2, 3]);
    assert.equal(gotB.find((m) => m.t === 'me').s.f, 1);
    assert.equal(gotB.find((m) => m.t === 'own').c, a.id);
  } finally { await a.leave(); await b.leave(); }
});

test("publish to every room under a prefix, and ask whether a room is open", async () => {
  const a = await join('g1/edit', opts({ transport: 'relay' }));
  const b = await join('g1/play/x1', opts({ transport: 'relay' }));
  try {
    const got: string[] = [];
    a.sync.onOps(() => got.push('a'));
    b.sync.onOps(() => got.push('b'));
    await new Promise((r) => setTimeout(r, 1200)); // a room count reaches the directory each second
    const r = await fetch(`${endpoint}/v1/net/publish`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'g1/*', ops: [{ op: 'delete', id: 'x' }] }) }).then((x) => x.json());
    assert.equal(r.rooms, 2);
    await wait(() => got.length === 2, 3000, 'both rooms');
    const info = await fetch(`${endpoint}/v1/net/room`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'g1/edit' }) }).then((x) => x.json());
    assert.equal(info.open, true);
    assert.equal(info.players, 1);
    const none = await fetch(`${endpoint}/v1/net/room`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'nobody/here' }) }).then((x) => x.json());
    assert.equal(none.open, false);
  } finally { await a.leave(); await b.leave(); }
});

test("the portal's key, narrowed to one customer, issues tickets in that customer's project and no other", async () => {
  const { createClient } = await import('../src/auth.ts');
  const { key } = createClient('portal-test', 'user', ['usr_*']);
  const ask = (project: string, only?: string) => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(only ? { 'X-Hawkesgen-Project': only } : {}) }, body: JSON.stringify({ project, room: 'lobby', sub: 's', client: { protocols: [3] } }) });
  const ok = await ask('usr_00000000000000aa', 'usr_00000000000000aa');
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).ticket, /^hn1\./);
  assert.equal((await ask('usr_00000000000000bb', 'usr_00000000000000aa')).status, 403, "another customer's project");
  assert.equal((await ask('netdemo')).status, 403, 'a project the key has no part in');
});

test("Gen's publish can put people out of a room: everyone, or those who joined as one sub; they don't come back", async () => {
  const a = await join('kick1', opts({ name: 'Ada', transport: 'relay', sub: 'u-ada' }));
  const b = await join('kick1', opts({ name: 'Bo', transport: 'relay', sub: 'u-bo' }));
  try {
    await wait(() => a.peers.has(b.id), 4000, 'A sees B');
    const problems: string[] = [];
    b.when('problem', (p: any) => problems.push(p.code));
    const r = await svc.publish({ id: 'local', name: 't', role: 'owner', projects: ['*'] } as any, { project: 'netdemo', room: 'kick1', kick: { sub: 'u-bo' } });
    assert.equal(r.kicked, 1, 'only Bo');
    await wait(() => b.status === 'closed', 4000, 'Bo is out');
    assert.ok(problems.includes('refused'), 'told why');
    await wait(() => !a.peers.has(b.id), 4000, 'A sees Bo leave');
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(b.status, 'closed', 'and does not come back by itself');
    assert.equal(a.status, 'online', 'Ada stays');
  } finally { await a.leave(); await b.leave(); }
});

test("the portal's rooms have no keyless door, and localhost is a door only where Gen is open to its own machine", async () => {
  const r = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: 'https://hawkesgen.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'hawkesgenwebsite', room: 'g/g_x/edit', client: { protocols: [3] } }) });
  assert.equal(r.status, 403, 'an Origin header can be set by anyone: the portal asks with its key');
  const { originAllowed, netProject } = await import('../src/net/registry.ts');
  const { loadSettings, saveSettings } = await import('../src/config.ts');
  assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:5173'), true, 'on this machine');
  const was = loadSettings();
  saveSettings({ ...was, localOpen: false });
  try { assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:5173'), false, 'on the server: anyone can say localhost'); }
  finally { saveSettings(was); }
});
