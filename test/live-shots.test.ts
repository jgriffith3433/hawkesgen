// Watching a playtest while it plays: GET /v1/jobs/:id/shots (the list, ?since, the progress line) and
// /shots/:i (the JPEG from the run's tmp file, then from the filed asset). A scratch data folder, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-liveshots-'));
const { handle } = await import('../src/api.ts');
const { db } = await import('../src/db.ts');
const { putAsset } = await import('../src/library.ts');
const { startLiveShots, endLiveShots } = await import('../src/tools/liveShots.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const jobId = 'j_0000000000aa';
db.prepare(`INSERT INTO jobs (id, client, project, tool, params, inputs, status, detail, created)
            VALUES (?, 'local', 'doseofdestruction', 'playtest.run', '{}', '{}', 'running', 'smoke: arena 40%', ?)`).run(jobId, Date.now());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-liveshots-files-'));
const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, n), Buffer.from([0xff, 0xd9])]);

test('a running playtest: the list, since, the progress line and each JPEG; then the filed assets', async () => {
  const shots = startLiveShots<{ t: number; reason: string; scene?: string; file: string; peer?: number }>(jobId);
  let r = await (await fetch(`${base}/v1/jobs/${jobId}/shots`)).json();
  assert.deepEqual(r, { running: true, progress: 'smoke: arena 40%', shots: [] });

  for (const [i, s] of [{ t: 1.2, reason: 'load' }, { t: 5, reason: 'every', scene: 'arena', peer: 1 }].entries()) {
    const file = path.join(tmp, `shot-${i}.jpg`);
    fs.writeFileSync(file, jpeg(i));
    shots.push({ ...s, file });
  }
  r = await (await fetch(`${base}/v1/jobs/${jobId}/shots`)).json();
  assert.deepEqual(r.shots, [{ i: 0, t: 1.2, reason: 'load', scene: null }, { i: 1, t: 5, reason: 'every', scene: 'arena', peer: 1 }]);
  r = await (await fetch(`${base}/v1/jobs/${jobId}/shots?since=0`)).json();
  assert.deepEqual(r.shots.map((s: any) => s.i), [1]);

  let res = await fetch(`${base}/v1/jobs/${jobId}/shots/1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg(1));
  assert.equal((await fetch(`${base}/v1/jobs/${jobId}/shots/7`)).status, 404);

  // The run ends: the shots are filed as assets, the tmp files go, and the list comes from the result.
  const assets = [0, 1].map((i) => putAsset({ data: jpeg(i), ext: '.jpg', mime: 'image/jpeg', client: 'local', project: 'doseofdestruction', tool: 'playtest.run', job: jobId, recipe: { tool: 'playtest.run', version: 3, params: {}, inputs: {} } as any }));
  const result = { shots: [{ i: 0, t: 1.2, reason: 'load', scene: undefined, asset: assets[0].id }, { i: 1, t: 5, peer: 1, reason: 'every', scene: 'arena', asset: assets[1].id }] };
  endLiveShots(jobId);
  fs.rmSync(tmp, { recursive: true, force: true });
  db.prepare(`UPDATE jobs SET status = 'done', detail = 'done: 3 outputs', result = ? WHERE id = ?`).run(JSON.stringify(result), jobId);

  r = await (await fetch(`${base}/v1/jobs/${jobId}/shots?since=-1`)).json();
  assert.equal(r.running, false);
  assert.equal(r.progress, 'done: 3 outputs');
  assert.deepEqual(r.shots, [{ i: 0, t: 1.2, reason: 'load', scene: null }, { i: 1, t: 5, reason: 'every', scene: 'arena', peer: 1 }]);
  res = await fetch(`${base}/v1/jobs/${jobId}/shots/1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg(1));
  assert.equal((await fetch(`${base}/v1/jobs/j_00000000ffff/shots`)).status, 404);
});
