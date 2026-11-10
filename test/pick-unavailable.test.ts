// asset.make keeps its first candidate when Claude is out of reach for the pick (src/tools/pipeline.ts pickUnavailable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-pick-unavailable-'));
const { pickUnavailable } = await import('../src/tools/pipeline.ts');
const { GenError } = await import('../src/util.ts');

test('a rate limit, plan limit or outage lets the pick fall back; anything else still fails the job', () => {
  assert.ok(pickUnavailable(new GenError('Claude (Max plan) is rate limited: weekly limit', { status: 429, kind: 'throttled' })));
  assert.ok(pickUnavailable(new GenError('Bedrock is rate limited', { status: 429, kind: 'throttled' })));
  assert.ok(pickUnavailable(new GenError('Claude is not set up', { status: 503 })));
  assert.ok(!pickUnavailable(new GenError('Claude needs your own access', { status: 402, kind: 'auth' })));
  assert.ok(!pickUnavailable(new GenError('bad schema', { status: 400 })));
  assert.ok(!pickUnavailable(new Error('boom')));
});
