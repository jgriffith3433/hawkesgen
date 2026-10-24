// While a running job logs hundreds of lines, /v1/health and POST /v1/analytics/collect still answer fast, and the
// log is written in batches (not once per line). No sleeps: the batch is flushed by calling flushLogs(), which is what
// the 1 s timer in jobs.ts calls, so nothing here depends on how fast the CI runner is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-loop-'));
const { db } = await import('../src/db.ts');
const { handle } = await import('../src/api.ts');
const { save, flushLogs } = await import('../src/jobs.ts');

const storedLog = (id: string) => JSON.parse((db.prepare('SELECT log FROM jobs WHERE id = ?').get(id) as any).log) as string[];
const insert = (id: string, status: string) =>
  db.prepare(`INSERT INTO jobs (id, client, project, tool, params, inputs, status, created) VALUES (?, 'test', 'p', 'image.edit', '{}', '{}', ?, 1)`).run(id, status);

test('a running job\'s log lines are saved together, and a finished job\'s at once', () => {
  insert('j_batch', 'running');
  const job: any = { id: 'j_batch', status: 'running', log: [], detail: '' };
  for (let i = 0; i < 50; i++) { job.log.push(`line ${i}`); save(job, ['log']); }
  assert.deepEqual(storedLog('j_batch'), [], 'no write per line');
  flushLogs();
  assert.equal(storedLog('j_batch').length, 50, 'one flush writes them all');
  job.log.push('last');
  job.status = 'done';
  save(job, ['status', 'log']);
  assert.equal(storedLog('j_batch').length, 51, 'the final save writes the log at once');
});

test('a pending log flush does not overwrite a job cancelled through another copy', () => {
  insert('j_cancel', 'queued');
  const job: any = { id: 'j_cancel', status: 'queued', log: ['waiting'], detail: '' };
  save(job, ['log']);
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = 'j_cancel'").run();
  flushLogs();
  assert.deepEqual(storedLog('j_cancel'), []);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'j_cancel'").get() as any).status, 'cancelled');
});

test('collect and health stay fast while a job logs hundreds of lines', async () => {
  insert('j_loop', 'running');
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
  try {
    // Warm up both routes (the first collect opens analytics.db and creates its tables).
    await call('GET', '/v1/health');
    await call('POST', '/v1/analytics/collect', '{}');
    const times: number[] = [];
    for (let i = 0; i < 600; i++) {
      job.log.push(`line ${i}`);
      job.log = job.log.slice(-300);
      save(job, ['log']);
      if (i % 50 === 0) times.push(await call('GET', '/v1/health'), await call('POST', '/v1/analytics/collect', '{}'));
    }
    assert.deepEqual(storedLog('j_loop'), [], '600 log lines, no write per line');
    flushLogs();
    assert.equal(storedLog('j_loop').length, 300);
    const health: any = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
    assert.equal(typeof health.loop.maxMs, 'number');
    assert.ok(Array.isArray(health.loop.blocks));
    // Typically a few ms each; before the fix this was 25-50 s. Only the median is held (to well under 100 ms): a
    // shared CI runner can pause any one call.
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`health and collect while logging: median ${median.toFixed(1)} ms, slowest ${sorted[sorted.length - 1].toFixed(1)} ms`);
    assert.ok(median < 100, `median ${median.toFixed(1)} ms of ${sorted.map((t) => t.toFixed(0)).join(', ')}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
