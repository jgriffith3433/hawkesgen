// Pure phone load-budget helpers: Slow 4G constants, byte rollup, gameplay cutoff, fpsDipAt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOW_4G,
  PHONE_CPU_RATE,
  PHONE_DPR,
  createTransferLog,
  rollupTransfers,
  gameplayCutoffSeconds,
  fpsDipAt,
  buildPhoneResult,
  applyPhoneMetrics,
  transferPath,
} from '../src/tools/playtest-phone.ts';

test('Slow 4G and phone throttle constants match the brief', () => {
  assert.equal(PHONE_CPU_RATE, 4);
  assert.equal(PHONE_DPR, 2);
  assert.equal(SLOW_4G.offline, false);
  assert.equal(SLOW_4G.latency, 150);
  // 1.6 Mbps and 750 Kbps as bytes/s.
  assert.equal(SLOW_4G.downloadThroughput, Math.round((1.6 * 1024 * 1024) / 8));
  assert.equal(SLOW_4G.uploadThroughput, Math.round((750 * 1024) / 8));
  assert.ok(SLOW_4G.downloadThroughput > 100_000);
  assert.ok(SLOW_4G.uploadThroughput > 50_000);
});

test('transferPath keeps pathname and query', () => {
  assert.equal(transferPath('https://cdn.example/game/Build.wasm?v=2'), '/game/Build.wasm?v=2');
  assert.equal(transferPath('not a url'), 'not a url');
});

test('createTransferLog rolls encodedDataLength per URL', () => {
  let t = 0;
  const log = createTransferLog(() => t);
  log.onResponseReceived({ requestId: 'a', response: { url: 'https://x/a.js' } });
  log.onResponseReceived({ requestId: 'b', response: { url: 'https://x/b.wasm' } });
  t = 1.2;
  log.onLoadingFinished({ requestId: 'a', encodedDataLength: 500_000 });
  t = 2.5;
  log.onLoadingFinished({ requestId: 'b', encodedDataLength: 2_500_000 });
  t = 3;
  log.onResponseReceived({ requestId: 'c', response: { url: 'https://x/a.js' } });
  log.onLoadingFinished({ requestId: 'c', encodedDataLength: 100_000 });
  assert.equal(log.hits.length, 3);
  const rolled = rollupTransfers(log.hits, 2.5, 5);
  // a.js at 1.2 + b.wasm at 2.5; a.js at 3 is after cutoff.
  assert.equal(rolled.totalBytes, 3_000_000);
  assert.equal(rolled.mbBeforeGameplay, 3);
  assert.equal(rolled.assets[0].path, '/b.wasm');
  assert.equal(rolled.assets[0].bytes, 2_500_000);
  assert.equal(rolled.assets.length, 2);
});

test('rollupTransfers returns the top assets by size (at least 5 when present)', () => {
  const hits = Array.from({ length: 8 }, (_, i) => ({
    url: `https://cdn/asset-${i}.bin`,
    bytes: (8 - i) * 1000,
    t: 1,
  }));
  const rolled = rollupTransfers(hits, null, 5);
  assert.equal(rolled.assets.length, 5);
  assert.equal(rolled.assets[0].path, '/asset-0.bin');
  assert.equal(rolled.assets[4].path, '/asset-4.bin');
  assert.equal(rolled.mbBeforeGameplay, Math.round((hits.reduce((a, h) => a + h.bytes, 0) / 1e6) * 10) / 10);
});

test('gameplayCutoffSeconds prefers milestone event, then metrics, then loadSeconds', () => {
  assert.equal(gameplayCutoffSeconds({
    events: [{ type: 'milestone', detail: 'gameplay', t: 12.34 }],
    metrics: { 'ftue.secondsToGameplay': 99 },
    loadSeconds: 2,
  }), 12.3);
  assert.equal(gameplayCutoffSeconds({
    events: [{ type: 'milestone', detail: 'menu', t: 1 }],
    metrics: { 'ftue.secondsToGameplay': 8.2 },
    loadSeconds: 2,
  }), 8.2);
  assert.equal(gameplayCutoffSeconds({
    metrics: { 'milestone.gameplay': 7 },
    loadSeconds: 2,
  }), 7);
  assert.equal(gameplayCutoffSeconds({ loadSeconds: 4.56 }), 4.6);
  assert.equal(gameplayCutoffSeconds({}), null);
});

test('fpsDipAt is the run-second of the p5 sample after loading', () => {
  // 12 one-second samples: first two are "loading", then play dips to 20 at second 6 (index 5 → t=6).
  const samples = [60, 58, 55, 54, 52, 20, 50, 49, 48, 47, 46, 45];
  assert.equal(fpsDipAt(samples, 2), 6);
  // Without loadSeconds, skip first two the same way summarizeFps does.
  assert.equal(fpsDipAt(samples, null), 6);
  assert.equal(fpsDipAt([], null), null);
  assert.equal(fpsDipAt([60, 60], 5), null);
});

test('buildPhoneResult + applyPhoneMetrics fill the Studio contract', () => {
  const phone = buildPhoneResult({
    hits: [
      { url: 'https://g/Build.data', bytes: 4_200_000, t: 3 },
      { url: 'https://g/Build.wasm', bytes: 1_100_000, t: 4 },
      { url: 'https://g/late.png', bytes: 900_000, t: 20 },
    ],
    events: [{ type: 'milestone', detail: 'gameplay', t: 10 }],
    metrics: {},
    loadSeconds: 2.1,
    fpsSamples: [40, 40, 38, 37, 10, 36, 35, 34],
    fpsP5: 10,
  });
  assert.deepEqual(phone.throttling, { cpu: 4, network: 'slow-4g', dpr: 2 });
  assert.equal(phone.secondsToGameplay, 10);
  assert.equal(phone.mbBeforeGameplay, 5.3);
  assert.equal(phone.fpsP5, 10);
  assert.equal(phone.fpsDipAt, 5);
  assert.ok(phone.assets.length >= 2);
  assert.equal(phone.assets[0].path, '/Build.data');
  const metrics = applyPhoneMetrics({ other: 1 }, phone);
  assert.equal(metrics['phone.mbBeforeGameplay'], 5.3);
  assert.equal(metrics['phone.secondsToGameplay'], 10);
  assert.equal(metrics['phone.fpsP5'], 10);
  assert.equal(metrics.other, 1);
});
