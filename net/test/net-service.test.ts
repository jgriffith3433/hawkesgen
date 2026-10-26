// The Hawkes Net service end to end (net/src/hub.ts in this process): tickets from POST /v1/net/ticket, the service's own
// relay node (ws://<service>/v1/net/ws), and the client SDK (clients/js/hawkes-net.mjs) in Node: a relay room (messages,
// avatars, things, ownership, synced states, actions), an 'auto' room that starts peer to peer on the signal route and
// moves to the relay when it grows (with no reliable message lost or repeated), the public ticket door, publish, kicks,
// and usage handed on (the box sends it to Gen).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startTestHub, addKey } = await import('./helper.ts');
// @ts-ignore: plain JS SDK
const { join, lobby } = await import('../../clients/js/hawkes-net.mjs');
const hub = await startTestHub();
const { endpoint, svc } = hub;
test.after(async () => { await hub.stop(); });

const wait = async (pred: () => any, ms = 4000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const opts = (o: any = {}) => ({ project: 'netdemo', endpoint, leaveOnHide: false, log: false, ...o });

test('the service is up with its own relay node, and hands out tickets for it', async () => {
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

test("publish puts a server's world edit into the room", async () => {
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

test("usage is handed on: player-seconds and bytes per project and transport (the box sends it to Gen)", async () => {
  const a = await join('use1', opts({ transport: 'relay' }));
  const b = await join('use1', opts({ transport: 'relay' }));
  for (let i = 0; i < 30; i++) { a.pose([i, 0, 0], 0); await new Promise((r) => setTimeout(r, 40)); }
  await new Promise((r) => setTimeout(r, 1100));
  await (svc.ownNode() as any).reportUsage();
  await a.leave(); await b.leave();
  const rows = hub.usage.flatMap((u) => u.rows).filter((r: any) => r.project === 'netdemo' && r.transport === 'relay');
  assert.ok(rows.some((r: any) => r.playerSeconds > 0), JSON.stringify(rows));
  assert.ok(rows.some((r: any) => r.bytesOut > 0));
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
  const key = addKey('portal', ['usr_*']);
  const ask = (project: string, only?: string) => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(only ? { 'X-Hawkesgen-Project': only } : {}) }, body: JSON.stringify({ project, room: 'lobby', sub: 's', client: { protocols: [3] } }) });
  const ok = await ask('usr_00000000000000aa', 'usr_00000000000000aa');
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).ticket, /^hn1\./);
  assert.equal((await ask('usr_00000000000000bb', 'usr_00000000000000aa')).status, 403, "another customer's project");
  assert.equal((await ask('netdemo')).status, 403, 'a project the key has no part in');
});

test("publish can put people out of a room: everyone, or those who joined as one sub; they don't come back", async () => {
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

test("the portal's rooms have no keyless door, and localhost is a door only where NET_TRUST_LOCALHOST says so", async () => {
  const r = await fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: 'https://hawkesgen.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'hawkesgenwebsite', room: 'g/g_x/edit', client: { protocols: [3] } }) });
  assert.equal(r.status, 403, 'an Origin header can be set by anyone: the portal asks with its key');
  const { originAllowed, netProject } = await import('../src/registry.ts');
  assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:5173'), true, 'on a developer machine');
  process.env.NET_TRUST_LOCALHOST = '0';
  try {
    assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:5173'), false, 'on the box: anyone can say localhost');
    assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:9088', 't-lobby'), true, "a project's test rooms take localhost pages (Studio's playtests)");
    assert.equal(originAllowed(netProject('netdemo'), 'http://127.0.0.1:9088', 't-abc/p1/level-1'), true, 'a playtest room too');
    assert.equal(originAllowed(netProject('netdemo'), 'http://localhost:9088', 'lobby'), false, 'never its live rooms');
    assert.equal(originAllowed(netProject('hawkesgenwebsite'), 'http://localhost:9088', 't-lobby'), false, 'never a project without its own sites');
  }
  finally { process.env.NET_TRUST_LOCALHOST = '1'; }
});

test('a room is open in the directory as soon as its first player is in (an invitation asked a moment later)', async () => {
  const a = await join('soon1', opts({ transport: 'auto' }));
  try {
    const info = await fetch(`${endpoint}/v1/net/room`, { method: 'POST', body: JSON.stringify({ project: 'netdemo', room: 'soon1' }) }).then((x) => x.json());
    assert.equal(info.open, true);
    assert.equal(info.players, 1);
  } finally { await a.leave(); }
});

test("a developer's own rooms, and the operator view for owner and admin keys only", async () => {
  const a = await join('mine-1', opts({ transport: 'relay' }));
  try {
    const dev = addKey('dev', ['usr_dev']);
    const listFor = (key: string, project: string) => fetch(`${endpoint}/v1/net/rooms`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ project }) });
    assert.equal((await listFor(dev, 'netdemo')).status, 403, "another project's rooms");
    const own = await (await fetch(`${endpoint}/v1/net/rooms`, { method: 'POST', body: JSON.stringify({ project: 'netdemo' }) })).json();
    assert.ok(own.rooms.some((r: any) => r.room === 'mine-1' && r.players === 1), JSON.stringify(own));
    assert.equal((await fetch(`${endpoint}/v1/net/ops`, { headers: { Authorization: `Bearer ${dev}` } })).status, 403);
    const ops = await (await fetch(`${endpoint}/v1/net/ops`)).json();
    assert.ok(ops.node && typeof ops.node.players === 'number', 'the node and its workers');
    assert.ok(ops.extra && typeof ops.extra.uptimeS === 'number', 'uptime and usage');
  } finally { await a.leave(); }
});

test("a customer's web game: the portal opens its account's door for its sites; its own key can't, and Hawkes's projects are never touched", async () => {
  const portal = addKey('portal-sites', ['usr_*']);
  const mine = addKey('acme', ['usr_acme']);
  const put = (key: string, body: any) => fetch(`${endpoint}/v1/net/sites`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const door = (origin: string, room = 'lobby', project = 'usr_acme') => fetch(`${endpoint}/v1/net/ticket`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ project, room, client: { protocols: [3] } }) });

  assert.equal((await door('https://acme.games')).status, 403, 'no door before the sites are set');
  assert.equal((await put(mine, { project: 'usr_acme', origins: ['https://acme.games'] })).status, 403, "the customer's own key can't open it");
  assert.equal((await put(portal, { project: 'sickofit', origins: ['https://acme.games'] })).status, 403, "Hawkes's own projects are the file's");
  assert.equal((await put(portal, { project: 'usr_acme', origins: ['https://acme.games/play'] })).status, 400, 'a site, not a page');
  assert.equal((await put(portal, { project: 'usr_acme', origins: ['http://acme.games'] })).status, 400, 'https only');
  assert.equal((await put(portal, { project: 'usr_acme', origins: Array.from({ length: 21 }, (_, i) => `https://s${i}.acme.games`) })).status, 400, 'at most 20');

  const set = await (await put(portal, { project: 'usr_acme', name: 'Acme Arena', origins: ['acme.games', 'https://WWW.acme.games/', 'https://acme.itch.io'] })).json();
  assert.deepEqual(set.origins, ['https://acme.games', 'https://www.acme.games', 'https://acme.itch.io'], 'cleaned: https, lower case, no slash');
  assert.equal((await door('https://acme.games')).status, 200, 'a page on its site gets a player ticket');
  assert.equal((await door('https://www.acme.games')).status, 200);
  assert.equal((await door('https://evil.example')).status, 403, 'other sites still not');
  assert.equal((await door('https://acme.games', 'lobby', 'usr_other')).status, 403, "only its own project's rooms");
  assert.equal((await door('https://acme.games', 'lobby', 'sickofit')).status, 403);

  const { originAllowed, netProject } = await import('../src/registry.ts');
  process.env.NET_TRUST_LOCALHOST = '0';
  try {
    assert.equal(originAllowed(netProject('usr_acme'), 'http://localhost:5173', 't-lobby'), true, 'its developers test on localhost in test rooms');
    assert.equal(originAllowed(netProject('usr_acme'), 'http://localhost:5173', 'lobby'), false, 'never its live rooms');
  } finally { process.env.NET_TRUST_LOCALHOST = '1'; }
  assert.equal((await fetch(`${endpoint}/v1/net/counts?project=usr_acme&rooms=lobby`)).status, 200, 'its public counts work too');

  const listed = await (await fetch(`${endpoint}/v1/net/sites`, { headers: { Authorization: `Bearer ${mine}` } })).json();
  assert.deepEqual(listed.sites.map((x: any) => [x.project, x.name]), [['usr_acme', 'Acme Arena']], 'the customer sees its own');
  const other = addKey('other', ['usr_other']);
  assert.equal((await (await fetch(`${endpoint}/v1/net/sites`, { headers: { Authorization: `Bearer ${other}` } })).json()).sites.length, 0, "and nobody else's");

  assert.equal((await put(portal, { project: 'usr_acme', origins: [] })).status, 200);
  assert.equal((await door('https://acme.games')).status, 403, 'no sites: the door closes');
});

test('the lobby (the standard layer for web games): room names by where the page runs, the next shard when full, handlers kept across rooms', async () => {
  const lo = (url: string, o: any = {}) => lobby({ ...opts({ transport: 'relay' }), liveHosts: ['mygame.com'], url, ...o });
  assert.equal(lo('https://mygame.com/play').nameFor('level-1'), 'level-1', 'live');
  assert.equal(lo('https://mygame.com/play').nameFor('level-1', 3), 'level-1.3', 'a shard');
  assert.equal(lo('https://beta.mygame.dev/').nameFor('level-1'), 't-level-1', 'anywhere else: the test rooms');
  assert.equal(lo('http://localhost:9088/?playtest=x&room=abc123').nameFor('level-1'), 't-abc123/level-1', "a playtest's own room");
  assert.equal(lo('https://mygame.com/?room=../x').nameFor('lobby'), 'lobby', 'a bad room id is ignored');
  assert.equal(lo('https://mygame.com/', { prefix: 'p2/' }).nameFor('lobby'), 'p2/lobby', 'the prefix');

  const url = `http://localhost/?room=lob${Date.now() % 100000}`;
  const a = lo(url, { name: 'Ada', config: { maxPlayers: 1 } });
  const b = lo(url, { name: 'Bo', config: { maxPlayers: 1 } });
  const statuses: string[] = [];
  b.when('status', (x: any) => statuses.push(x.status));
  try {
    a.join('lobby');
    await wait(() => a.ready, 4000, 'a in the lobby');
    assert.match(a.roomName, /^t-lob\d+\/lobby$/);
    b.join('lobby');
    await wait(() => b.ready, 6000, 'b in a room');
    assert.equal(b.shard, 2, 'the first was full: the next shard');
    assert.equal(b.roomName, `${a.roomName}.2`);
    assert.ok(!statuses.includes('offline'), `a full room is not an error (${statuses.join(' ')})`);

  } finally { a.leave(); b.leave(); }

  // Handlers subscribed once keep working when the lobby moves rooms (another area, a rejoin).
  const u2 = `http://localhost/?room=msg${Date.now() % 100000}`;
  const l = lo(u2, { name: 'Lu' });
  const got: string[] = [];
  l.on('hi', (text: string) => got.push(text));
  try {
    for (const area of ['town', 'field']) {
      l.join(area);
      await wait(() => l.ready && l.area === area, 6000, `the lobby in ${area}`);
      const page = await join(l.roomName, opts({ transport: 'relay', name: 'Pa' }));
      try {
        await wait(() => l.peers.size >= 1, 3000, 'the page seen');
        page.send('hi', area);
        await wait(() => got.includes(area), 3000, `the message in ${area}`);
      } finally { await page.leave(); }
    }
    assert.deepEqual(got, ['town', 'field'], 'one handler, two rooms, each message once');
    l.send('ignored', 1); // in a room: goes; nothing to check but that it doesn't throw
    l.leave();
    l.send('dropped', 1);
    l.pose([0, 0, 0], 0);
    assert.equal(l.status, 'off', 'left: off, and sends are dropped quietly');
  } finally { l.leave(); }
});
