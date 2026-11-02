// A deploy's old copy of Gen that finds the new one holding the database (server/gen-cloudrun/standby.mjs) answers
// "restarting" instead of exiting, which made Cloud Run answer with Google's HTML error page (2026-11-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handle } from '../server/gen-cloudrun/standby.mjs';

async function ask(path: string) {
  const server = http.createServer(handle).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, type: r.headers.get('content-type') ?? '', restarting: r.headers.get('x-hawkes-restarting'), body: await r.text() };
  } finally {
    server.close();
  }
}

test('the API: 503 in Gen\'s JSON error shape, marked restarting', async () => {
  const r = await ask('/v1/assets?limit=5');
  assert.equal(r.status, 503);
  assert.match(r.type, /application\/json/);
  assert.equal(r.restarting, '1');
  assert.equal(JSON.parse(r.body).kind, 'restarting');
});

test('the event stream: a stream that tells the browser to open it again, never an error page', async () => {
  const r = await ask('/v1/events');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/event-stream/);
  assert.match(r.body, /^retry: 3000\n/);
});

test('a page: a short plain page', async () => {
  const r = await ask('/');
  assert.equal(r.status, 503);
  assert.match(r.body, /restarting/);
});
