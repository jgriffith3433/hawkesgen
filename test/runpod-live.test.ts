// GET /v1/fleet's RunPod block (src/providers/gpu/runpodLive.ts): balance, spend per hour, each endpoint's workers and
// the last 24 hours' spend by endpoint, read from RunPod with fakes here. No key: null. A RunPod error: `error`, no throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRunpodLive, resetRunpodLive, spendBy } from '../src/providers/gpu/runpodLive.ts';

const keyed = (k: string) => (k === 'RUNPOD_API_KEY' ? 'rp_secret' : undefined);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('spendBy sums billing records per endpoint, biggest first, and names them', () => {
  const rows = spendBy([
    { endpointId: 'a', amount: 1.2, timeBilledMs: 3600_000, time: '2026-11-10T07:00:00Z' },
    { endpointId: 'b', amount: 4.01, timeBilledMs: 7200_000, time: '2026-11-10T08:00:00Z' },
    { endpointId: 'a', amount: 0.3, timeBilledMs: 600_000, time: '2026-11-10T09:00:00Z' },
    { endpointId: 'c', amount: 0 },
  ], 'endpointId', { a: 'hawkes-gen-gpu' });
  assert.deepEqual(rows, [
    { id: 'b', name: null, usd: 4.01, seconds: 7200, lastHour: '2026-11-10T08:00:00Z' },
    { id: 'a', name: 'hawkes-gen-gpu', usd: 1.5, seconds: 4200, lastHour: '2026-11-10T09:00:00Z' },
  ]);
});

test('no RunPod key: nothing is read', async () => {
  resetRunpodLive();
  let calls = 0;
  assert.equal(await readRunpodLive(() => undefined, (async () => { calls++; return json({}); }) as any), null);
  assert.equal(calls, 0);
});

test('reads balance, spend per hour, workers and the last 24 hours', async () => {
  resetRunpodLive();
  const fetcher = (async (url: string) => {
    if (url.includes('graphql')) return json({ data: { myself: { clientBalance: 2.5, currentSpendPerHr: 1.75 } } });
    if (url.includes('/serverless')) return json({ endpoints: [{ id: 'e1', name: 'hawkes-gen-gpu', type: 'LOAD_BALANCER', workers: { max: 3 } }] });
    if (url.endsWith('/e1/health')) return json({ jobs: { inProgress: 0 }, workers: { running: 3, idle: 0 } });
    if (url.includes('/billing/endpoints')) return json([{ endpointId: 'e1', amount: 5.7, timeBilledMs: 10_800_000, time: '2026-11-10T05:00:00Z' }]);
    if (url.includes('/billing/pods')) return json([]);
    return json({}, 404);
  }) as any;
  const r = await readRunpodLive(keyed, fetcher);
  assert.equal(r?.balance, 2.5);
  assert.equal(r?.spendPerHour, 1.75);
  assert.deepEqual(r?.endpoints, [{ id: 'e1', name: 'hawkes-gen-gpu', type: 'LOAD_BALANCER', workersMax: 3, workers: { running: 3, idle: 0 } }]);
  assert.equal(r?.last24h?.totalUsd, 5.7);
  assert.equal(r?.last24h?.endpoints[0].name, 'hawkes-gen-gpu');
  assert.equal(r?.error, null);
});

test('a RunPod error comes back as error, without the key', async () => {
  resetRunpodLive();
  const fetcher = (async (url: string) => (url.includes('graphql') ? json({ data: { myself: { clientBalance: -0.06, currentSpendPerHr: 0 } } }) : json({ error: 'bad key rp_secret' }, 401))) as any;
  const r = await readRunpodLive(keyed, fetcher);
  assert.equal(r?.balance, -0.06);
  assert.equal(r?.last24h, null);
  assert.match(r?.error ?? '', /401/);
  assert.doesNotMatch(r?.error ?? '', /rp_secret/);
});
