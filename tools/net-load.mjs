// Hawkes Net load test: how many players one relay node holds (docs/net.md "Hosting").
//
//   node tools/net-load.mjs --players 2000 --room 32 --workers 4 --seconds 30
//
// Starts a relay node here (src/net/node.ts with N worker processes and a test key) unless --url is given, then
// simulated players in separate generator processes (so the generator isn't what's measured), in rooms of --room.
// Every player sends its avatar 15 times a second; each room's first player also simulates --things moving things at
// 10 a second (the portal's measured scene is ~120). Reports delivery latency (p50/p99/max), dropped connections,
// bytes per player, and the node's event-loop delay and CPU, then the verdict against p99 < 100 ms.
import { fork } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []));
const here = path.dirname(fileURLToPath(import.meta.url));

if (args.child) await child();
else await main();

async function main() {
  const players = Number(args.players ?? 1000);
  const roomSize = Number(args.room ?? 32);
  const workers = Number(args.workers ?? Math.max(1, Math.min(4, os.availableParallelism() - 4)));
  const seconds = Number(args.seconds ?? 30);
  const things = Number(args.things ?? 60);
  const procs = Number(args.procs ?? Math.max(2, Math.min(8, os.availableParallelism() - workers)));
  const ramp = Number(args.ramp ?? 10);
  const core = await import('../clients/js/hawkes-net-core.mjs');
  const { NetNode } = await import('../src/net/node.ts');
  const T = await import('../src/net/tickets.ts');
  const key = T.newKeyPair('kload');
  const link = { keys: async () => [{ kid: key.kid, pub: T.exportPublic(key.publicKey) }], heartbeat: async () => {}, room: async () => {}, usage: async () => {} };
  const node = new NetNode({ id: 'load', url: 'ws://x', link, workers, capacity: 100000, log: () => {} });
  await node.start();
  const server = http.createServer((req, res) => void node.http(req, res, new URL(req.url, 'http://x').pathname));
  server.on('upgrade', (req, socket, head) => node.upgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  console.log(`node: ${workers} worker processes on :${port}; ${args.hz ?? 30} Hz; ${players} players in rooms of ${roomSize}, ${things} things per room, ${procs} generator processes, ${seconds} s (+${ramp} s ramp)`);
  // Tickets for everyone, made here (the generators don't hold the key).
  const now = Math.floor(Date.now() / 1000);
  const lim = { ...core.DEFAULT_LIMITS, playersPerRoom: 1000, msgsPerSec: 200, innerPerSec: 4000 };
  const tickets = [];
  for (let i = 0; i < players; i++) {
    const room = `load-${Math.floor(i / roomSize)}`;
    const ord = (i % roomSize) + 1;
    tickets.push({ room, ord, host: ord === 1, t: T.signToken(T.TICKET_PREFIX, { v: 1, kid: key.kid, prj: 'load', room, peer: `p${ord}`, ord, sub: `s${i}`, nm: `P${i}`, role: 'player', tr: ['relay'], want: 'relay', node: 'load', epoch: 1, lim, cfg: { topology: 'star', profile: 'medium', maxPlayers: 1000, p2pMax: 8, interest: core.DEFAULT_INTEREST, sendHz: Number(args.hz ?? 30) }, iat: now, exp: now + 3600, jti: crypto.randomBytes(8).toString('hex') }, key.privateKey) });
  }
  const per = Math.ceil(players / procs);
  const results = [];
  const kids = [];
  for (let p = 0; p < procs; p++) {
    const mine = tickets.slice(p * per, (p + 1) * per);
    if (!mine.length) continue;
    const k = fork(fileURLToPath(import.meta.url), ['--child', '1'], { execArgv: ['--disable-warning=ExperimentalWarning'] });
    kids.push(k);
    k.send({ url: `ws://127.0.0.1:${port}/v3`, tickets: mine, seconds, ramp, things });
    results.push(new Promise((res) => k.on('message', (m) => { if (m.done) res(m); })));
  }
  // The node's own numbers while it runs.
  const samples = [];
  const sampler = setInterval(async () => { samples.push(await node.stats()); }, 2000);
  const out = await Promise.all(results);
  clearInterval(sampler);
  for (const k of kids) k.kill();
  const lat = out.flatMap((r) => r.lat).sort((a, b) => a - b);
  const pct = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : NaN);
  const connected = out.reduce((s, r) => s + r.connected, 0);
  const dropped = out.reduce((s, r) => s + r.dropped, 0);
  const failed = out.reduce((s, r) => s + r.failed, 0);
  const bytes = out.reduce((s, r) => s + r.bytes, 0);
  const steady = samples.slice(Math.ceil(ramp / 2));
  const lagP99 = Math.max(0, ...steady.flatMap((s) => (s.workers || []).map((w) => w.lagP99 || 0)));
  const lagMax = Math.max(0, ...steady.flatMap((s) => (s.workers || []).map((w) => w.lagMax || 0)));
  const cpu = Math.max(0, ...steady.flatMap((s) => (s.workers || []).map((w) => w.cpu || 0)));
  const rep = {
    players, connected, failed, dropped, workers, roomSize, things,
    latencyMs: { p50: Math.round(pct(0.5)), p90: Math.round(pct(0.9)), p99: Math.round(pct(0.99)), max: Math.round(lat[lat.length - 1] ?? NaN), samples: lat.length },
    perPlayerKBs: Math.round((bytes / Math.max(1, connected) / seconds / 1024) * 10) / 10,
    nodeWorkerLagP99Ms: Math.round(lagP99 * 10) / 10, nodeWorkerLagMaxMs: Math.round(lagMax * 10) / 10, nodeBusiestWorkerCpu: Math.round(cpu * 100) / 100,
    pass: failed === 0 && dropped === 0 && pct(0.99) < 100,
  };
  console.log(JSON.stringify(rep, null, 2));
  node.stop();
  server.closeAllConnections();
  server.close();
  process.exit(rep.pass ? 0 : 1);
}

// ------------------------------------------------------------------ a generator process: players
async function child() {
  const core = await import('../clients/js/hawkes-net-core.mjs');
  const job = await new Promise((r) => process.once('message', r));
  const { url, tickets, seconds, ramp, things } = job;
  const lat = [];
  let connected = 0, dropped = 0, failed = 0, bytes = 0, measuring = false;
  const clients = [];
  const start = Date.now();
  for (let i = 0; i < tickets.length; i++) {
    const tk = tickets[i];
    // Spread the joins over the ramp.
    const at = start + (i / tickets.length) * ramp * 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
    const ws = new WebSocket(`${url}?t=${encodeURIComponent(tk.t)}&want=relay`, ['hawkes-net.v3']);
    ws.binaryType = 'arraybuffer';
    // One in eight players decodes what it gets and measures latency; the rest only count bytes (a real page decodes,
    // but here the generator's CPU would be measured instead of the node's).
    const c = { ws, enc: new core.Codec(), dec: new core.Codec(), ok: false, x: Math.random() * 200, z: Math.random() * 200, a: Math.random() * 6.28, host: tk.host, probe: i % 8 === 0 };
    ws.onopen = () => { c.ok = true; connected++; };
    ws.onerror = () => {};
    ws.onclose = () => { if (c.ok && !c.leaving) dropped++; else if (!c.ok) failed++; };
    ws.onmessage = (e) => {
      const u8 = new Uint8Array(e.data);
      if (measuring) bytes += u8.length;
      if (u8[0] !== 0 || !c.probe) return;
      const t = Date.now();
      let msgs;
      try { msgs = c.dec.read(u8, true).msgs; } catch { return; }
      if (!measuring) return;
      for (const m of msgs) if (m.t === 'me' && typeof m.s?.t === 'number' && lat.length < 400_000) lat.push(t - m.s.t);
    };
    clients.push(c);
  }
  const thingState = Array.from({ length: things }, (_, i) => ({ id: `th${i}`, x: Math.random() * 200, z: Math.random() * 200, a: Math.random() * 6.28 }));
  let tick = 0;
  const timer = setInterval(() => {
    const t = Date.now();
    tick++;
    for (const c of clients) {
      if (!c.ok || c.ws.readyState !== 1) continue;
      const msgs = [];
      if (tick % 2 === 0) { // ~15 a second
        c.a += (Math.random() - 0.5) * 0.4; c.x += Math.cos(c.a) * 0.3; c.z += Math.sin(c.a) * 0.3;
        msgs.push({ t: 'me', at: t, s: { p: [c.x, 1, c.z], y: c.a, t } });
      }
      if (c.host && tick % 3 === 0) { // 10 a second
        const x = thingState.map((s) => { s.a += 0.05; s.x += Math.cos(s.a) * 0.4; s.z += Math.sin(s.a) * 0.4; return [s.id, 0b111000111, s.x, 1, s.z, 0, s.a, 0, Math.cos(s.a) * 4, 0, Math.sin(s.a) * 4]; });
        msgs.push({ t: 'xf', at: t, x });
      }
      if (msgs.length) c.ws.send(c.enc.bundle(msgs, t, true));
    }
  }, 33);
  await new Promise((r) => setTimeout(r, Math.max(0, start + ramp * 1000 - Date.now()) + 2000));
  measuring = true;
  await new Promise((r) => setTimeout(r, seconds * 1000));
  measuring = false;
  clearInterval(timer);
  for (const c of clients) { c.leaving = true; try { c.ws.close(); } catch {} }
  process.send({ done: true, lat, connected, dropped, failed, bytes });
}
