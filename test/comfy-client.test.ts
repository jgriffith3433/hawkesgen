// The ComfyUI client waits out a ComfyUI that is starting or restarting behind the server's nginx (502s), instead of
// failing the job, and notices when a restart lost the graph it was running (2026-10-19: half of Yooba Land's
// mesh.textured jobs failed on "ComfyUI /upload/image: 502" right after a server started).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { Comfy } = await import('../src/providers/comfy/client.ts');

/** A fake ComfyUI behind nginx: `down` requests answer 502 first, then `handle` answers. */
async function fake(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void, { down = 0 } = {}) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      if (down > 0) {
        down -= 1;
        res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html><title>502 Bad Gateway</title></html>');
        return;
      }
      handle(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}
const json = (res: http.ServerResponse, v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));

test('an upload waits out 502s while ComfyUI starts', async () => {
  const f = await fake((_req, res) => json(res, { name: 'abc.png', subfolder: 'hawkesgen' }), { down: 2 });
  try {
    const c = new Comfy({ url: f.url, headers: {} }, { waitMs: 5000, pauseMs: 10 });
    assert.equal(await c.upload(Buffer.from('png'), 'abc.png'), 'hawkesgen/abc.png');
    assert.equal(f.seen.length, 3);
  } finally {
    await f.close();
  }
});

test('a ComfyUI that stays down fails with a plain reason, not nginx\'s HTML', async () => {
  const f = await fake(() => undefined, { down: 1e9 });
  try {
    const c = new Comfy({ url: f.url, headers: {} }, { waitMs: 60, pauseMs: 10 });
    await assert.rejects(c.upload(Buffer.from('png'), 'abc.png'), (e: any) => /\/upload\/image: 502 .*isn't answering/.test(e.message) && !/<html>/.test(e.message));
  } finally {
    await f.close();
  }
});

test('other errors fail at once', async () => {
  const f = await fake((_req, res) => res.writeHead(400).end('bad image'));
  try {
    const c = new Comfy({ url: f.url, headers: {} }, { waitMs: 5000, pauseMs: 10 });
    await assert.rejects(c.upload(Buffer.from('png'), 'abc.png'), /400 bad image/);
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

test('ready() waits for ComfyUI and says so once', async () => {
  const f = await fake((_req, res) => json(res, { system: {} }), { down: 3 });
  try {
    const c = new Comfy({ url: f.url, headers: {} }, { pauseMs: 10 });
    let told = 0;
    await c.ready({ timeoutMs: 5000, onWait: () => (told += 1) });
    assert.equal(told, 1);
    assert.equal(f.seen.length, 4);
  } finally {
    await f.close();
  }
});

test('a graph a restart lost is reported as lost, not waited on for an hour', async () => {
  const f = await fake((req, res) => {
    if (req.url === '/object_info') return json(res, { SaveImage: { input: { required: {} } } });
    if (req.url === '/prompt') return json(res, { prompt_id: 'p1', node_errors: {} });
    if (req.url?.startsWith('/history/')) return json(res, {});
    if (req.url === '/queue') return json(res, { queue_running: [], queue_pending: [] });
    res.writeHead(404).end();
  });
  try {
    const c = new Comfy({ url: f.url, headers: {} }, { pauseMs: 10 });
    const t = Date.now();
    await assert.rejects(c.run({ 1: { class_type: 'SaveImage', inputs: {} } }), (e: any) => e.lost === true && /restarted/.test(e.message));
    assert.ok(Date.now() - t < 15_000);
  } finally {
    await f.close();
  }
});
