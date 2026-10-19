// GET /v1/jobs/timing: per tool, how long jobs waited in the queue and how long they ran (so Studio can show where
// the time goes), plus what is waiting right now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-timing-'));
const { db } = await import('../src/db.ts');
const { jobTimings } = await import('../src/jobs.ts');

let n = 0;
function job(project: string, tool: string, status: string, created: number, started: number | null, finished: number | null) {
  db.prepare(`INSERT INTO jobs (id, client, project, tool, params, inputs, status, created, started, finished)
              VALUES (?, 'test', ?, ?, '{}', '{}', ?, ?, ?, ?)`).run(`j_t${(n++).toString().padStart(4, '0')}`, project, tool, status, created, started, finished);
}

test('wait and run times per tool, the biggest sink first, and what waits now', () => {
  const now = 10_000_000;
  // mesh.textured: waited 60 s and 600 s, ran 500 s; one failed after 2 s.
  job('yoobaland', 'mesh.textured', 'done', now - 900_000, now - 840_000, now - 340_000);
  job('yoobaland', 'mesh.textured', 'done', now - 1_200_000, now - 600_000, now - 100_000);
  job('yoobaland', 'mesh.textured', 'failed', now - 50_000, now - 40_000, now - 38_000);
  job('yoobaland', 'mesh.textured', 'queued', now - 300_000, null, null);
  job('yoobaland', 'audio.voice', 'done', now - 10_000, now - 9_000, now - 6_000);
  job('yoobaland', 'audio.voice', 'cancelled', now - 10_000, null, now - 5_000);
  job('sickofit', 'playtest.run', 'running', now - 60_000, now - 30_000, null);
  job('yoobaland', 'image.edit', 'done', now - 99_000_000, now - 98_000_000, now - 97_000_000); // before `since`

  const all = jobTimings({ since: now - 3_600_000, now });
  assert.deepEqual(all.tools.map((t: any) => t.tool), ['mesh.textured', 'audio.voice', 'playtest.run']);
  const mesh = all.tools[0];
  assert.equal(mesh.done, 2);
  assert.equal(mesh.failed, 1);
  assert.deepEqual(mesh.wait, { avg: 223.3, p50: 60, p90: 600, max: 600 });
  assert.deepEqual(mesh.run, { avg: 334, p50: 500, p90: 500, max: 500 });
  assert.deepEqual(mesh.now, { queued: 1, running: 0, longestWait: 300 });
  const voice = all.tools[1];
  assert.equal(voice.done, 1);
  assert.deepEqual(voice.wait, { avg: 1, p50: 1, p90: 1, max: 1 });
  const pt = all.tools[2];
  assert.equal(pt.wait, null);
  assert.equal(pt.now.running, 1);

  // A caller sees only its projects.
  const mine = jobTimings({ since: now - 3_600_000, now, projects: ['sickofit'] });
  assert.deepEqual(mine.tools.map((t: any) => t.tool), ['playtest.run']);
  assert.deepEqual(jobTimings({ since: now - 3_600_000, now, project: 'sickofit', projects: ['yoobaland'] }).tools, []);
});
