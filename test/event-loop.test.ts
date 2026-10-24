// While a running job logs hundreds of lines, /v1/health and POST /v1/analytics/collect still answer fast, and the
// log is written in batches (not once per line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-loop-'));
const { db } = await import('../src/db.ts');
const { handle } = await import('../src/api.ts');
const { save } = await import('../src/jobs.ts');

test('collect and health stay fast while a job logs hundreds of lines', async () => {
  db.prepare(`INSERT INTO jobs (id, client, project, tool, params, inputs, status, created) VALUES ('j_loop', 'test', 'p', 'image.edit', '{}', '{}', 'running', 1)`).run();
  const job: any = { id: 'j_loop', status: 'running', log: [], detail: '' };
  const server = http.createServer((req, res) => { handle(req, res).catch(() => res.end()); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const call = async (method: string, p: string, body?: string) => {
    const t = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, body, headers: { 'Content-Type': 'application/json' } });
    await r.text();
    return performance.now() - t;
  };
  await call('GET', '/v1/health'); // warm up
  let rows = 0;
  const lagSlowest: number[] = [];
  for (let i = 0; i < 600; i++) {
    job.log.push(`line ${i}`);
    job.log = job.log.slice(-300);
    save(job, ['log']);
    if (i % 100 === 0) lagSlowest.push(await call('GET', '/v1/health'), await call('POST', '/v1/analytics/collect', '{}'));
  }
  assert.ok(Math.max(...lagSlowest) < 100, `slowest ${Math.max(...lagSlowest)} ms`);
  rows = JSON.parse((db.prepare("SELECT log FROM jobs WHERE id = 'j_loop'").get() as any).log).length;
  assert.ok(rows < 600, 'log was not written line by line');
  const health: any = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
  assert.equal(typeof health.loop.maxMs, 'number');
  job.status = 'done';
  save(job, ['status', 'log']);
  assert.equal(JSON.parse((db.prepare("SELECT log FROM jobs WHERE id = 'j_loop'").get() as any).log).length, 300);
  server.close();
});
