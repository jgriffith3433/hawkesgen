// No polling (J, 2026-11-02: "Please stop implementing polling if at all possible it causes all the problems"): pages hear
// about scenes, productions, machines and bench runs on GET /v1/events and fetch the rest on open or on an action. This
// checks the stream carries those events (and is never held back on the way), that jobwatch.js hands them to pages, that
// the gen-edge Worker streams it through as it comes, and that no dashboard file asks on a timer again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import worker from '../server/gen-edge/src/index.ts';
import { createJobWatch } from '../dashboard/gen/jobwatch.js';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-nopoll-'));
const { handle } = await import('../src/api.ts');
const { events } = await import('../src/bus.ts');
const { streamCount } = await import('../src/eventhub.ts');

test('GET /v1/events carries scene, machines and bench events, unbuffered, with keep-alive', async () => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try {
    const got: string[] = [];
    const res: http.IncomingMessage = await new Promise((ok) => http.get({ port, host: '127.0.0.1', path: '/v1/events' }, ok));
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.match(String(res.headers['cache-control']), /no-transform/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
    res.setEncoding('utf8');
    res.on('data', (d) => got.push(d));
    const until = async (re: RegExp) => { for (let i = 0; i < 100 && !re.test(got.join('')); i++) await new Promise((r) => setTimeout(r, 20)); };
    await until(/: hello/);
    assert.match(got.join(''), /^retry: 5000\n: hello/);
    events.emit('scene', { id: 'sn_1', project: 'doseofdestruction', kind: 'image', version: 4 });
    events.emit('machines', { at: 1 });
    events.emit('bench', { run: 'br_1' });
    await until(/event: bench/);
    const text = got.join('');
    assert.match(text, /event: scene\ndata: \{"id":"sn_1".*"version":4\}\n\n/);
    assert.match(text, /event: machines\ndata: \{"at":1\}\n\n/);
    assert.match(text, /event: bench\ndata: \{"run":"br_1"\}\n\n/);
    res.destroy();
    await new Promise((r) => setTimeout(r, 50));
    // The hub (src/eventhub.ts) holds one listener per event name for every stream; a closed one leaves none of its own.
    assert.equal(streamCount(), 0, 'a closed stream is forgotten');
    assert.equal(events.listenerCount('scene'), 1);
  } finally {
    server.close();
  }
});

test('jobwatch.on: scene and production events reach the page that asked, and the stream closes with the last one', async () => {
  let handlers: any = null, opts: any = null, opens = 0, closes = 0;
  const w = createJobWatch({
    fetchJob: async () => ({}),
    openStream: (h: any, o: any) => { handlers = h; opts = o; opens++; return { close() { closes++; } }; },
    hidden: () => false,
    onVisible: () => {},
  });
  const scenes: any[] = [], prods: any[] = [];
  let reconnects = 0;
  const stopScene = w.on('scene', (e: any) => scenes.push(e), () => { reconnects++; });
  const stopProd = w.on('production', (e: any) => prods.push(e));
  assert.equal(opens, 1, 'one stream for every listener');
  handlers.scene({ id: 'sn_1', version: 2 });
  handlers.production({ id: 'p_1', status: 'running' });
  assert.deepEqual(scenes, [{ id: 'sn_1', version: 2 }]);
  assert.deepEqual(prods, [{ id: 'p_1', status: 'running' }]);
  opts.onReconnect();
  assert.equal(reconnects, 1);
  stopScene();
  assert.equal(closes, 0);
  stopProd();
  assert.equal(closes, 1, 'nothing listens: the stream is closed');
});

test('gen-edge streams /v1/events through as it comes (no buffering), a comment at a time', async () => {
  const enc = new TextEncoder();
  let push!: (s: string) => void, end!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(enc.encode(s)); end = () => c.close(); } });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform' } })) as typeof fetch;
  try {
    const res = await worker.fetch(new Request('https://hawkesgen.ai/v1/events', { headers: { Accept: 'text/event-stream' } }), { GEN_ORIGIN: 'https://gen.run.app' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    push(': hello\n\n');
    const first = await reader.read(); // arrives while the stream is still open
    assert.equal(new TextDecoder().decode(first.value), ': hello\n\n');
    push('event: scene\ndata: {}\n\n');
    const second = await reader.read();
    assert.equal(new TextDecoder().decode(second.value), 'event: scene\ndata: {}\n\n');
    end();
    assert.equal((await reader.read()).done, true);
  } finally {
    globalThis.fetch = real;
  }
});

// A timer that fetches is a poll. These files hold the only timers that are not (each with its reason); anything new
// that fetches on a timer needs its reason written in AGENTS.md's rule and here.
const OK_INTERVALS: Record<string, string> = {
  'dashboard/gen/frames.js': 'a stall watchdog for a video being sampled in the browser; no request',
  'dashboard/gen/player.js': 'reports export progress from the playhead; no request',
  'dashboard/gen/playtest/hawkes-perf.js': 'the playtest contract\'s own frame sampling inside the page being played; no request to Gen',
};
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? files(p) : /\.(js|html)$/.test(d.name) ? [p] : [];
  });
}

test('no dashboard page asks on a timer: setInterval only where it makes no request', () => {
  const bad: string[] = [];
  for (const f of files('dashboard')) {
    const rel = f.split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    if (/\bsetInterval\s*\(/.test(text) && !OK_INTERVALS[rel]) bad.push(rel);
  }
  assert.deepEqual(bad, [], 'use GET /v1/events or an on-demand fetch (AGENTS.md: No polling)');
  for (const rel of ['dashboard/gen/project.js', 'dashboard/gen/review.js', 'dashboard/gen/scenedoc.js', 'dashboard/gen/world.js', 'dashboard/bench.js', 'dashboard/app.js']) {
    const text = fs.readFileSync(rel, 'utf8');
    assert.doesNotMatch(text, /setInterval\s*\(/, rel);
    assert.doesNotMatch(text, /\.poll\b|follow\.t\b|R\.timer/, `${rel}: a leftover poll timer`);
  }
});
