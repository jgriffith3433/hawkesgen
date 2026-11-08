// /v1/health answers from a 5 s cache; ?deep=1 (owner or admin) is always fresh; the alerts script prints and creates nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-health-'));
const { db } = await import('../src/db.ts');
const { cachedHealth, resetHealthCache } = await import('../src/api.ts');

test('health is cached for 5 s and still carries version, commit, lane, queue and loop', (t) => {
  resetHealthCache();
  const a = cachedHealth();
  for (const k of ['version', 'commit', 'lane', 'queue', 'loop']) assert.ok(k in a, k);
  db.prepare(`INSERT INTO jobs (id, client, project, tool, params, inputs, status, created) VALUES ('j_h', 'test', 'p', 'image.edit', '{}', '{}', 'queued', 1)`).run();
  assert.equal(cachedHealth(), a, 'same answer inside the window');
  assert.equal(cachedHealth().queue.queued, undefined);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5100 });
  const b = cachedHealth();
  assert.notEqual(b, a);
  assert.equal(b.queue.queued, 1);
});

test('the alerts script prints four policies and creates nothing without --apply', () => {
  const r = spawnSync(process.execPath, ['tools/gen-cloudrun/alerts.mjs', '--project', 'p', '--offline'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['5xx rate', 'instance restarts', 'event-loop lag', 'queue depth']) assert.match(r.stdout, new RegExp(`Gen live: ${n}`));
  assert.match(r.stdout, /dry run/);
  assert.doesNotMatch(r.stdout, /^> gcloud/m);
  assert.match(r.stdout, /Nothing was changed/);
});
