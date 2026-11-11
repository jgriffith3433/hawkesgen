// 2026-11-11: CPU playtest runners listed in settings.playtest.runners skipped the live-region cap the implicit lanes
// have (cloudrun.ts spareLiveRegion), so CPU browsers held 16 of us-east4's 20 vCPU and Studio's own server, which runs
// there, couldn't start. A listed CPU runner in the live region now plays at most LIVE_REGION_CPU_INSTANCES instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.GEN_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'gen-runnercap-'));
const { SETTINGS_DEFAULTS, cleanRunners } = await import('../src/config.ts');
const { browserService, runnerCap, runnerCandidates, resetRunners, claimRunner } = await import('../src/providers/playtester/runners.ts');
const { LIVE_REGION_CPU_INSTANCES } = await import('../src/providers/playtester/cloudrun.ts');

const LIVE_URL = 'https://gen-playtest-cpu-live-uk.a.run.app';
const AWAY_URL = 'https://gen-playtest-cpu-away-uc.a.run.app';
const cpuSpec = { variant: 'cpu', name: 'gen-playtest-cpu', region: 'us-east4', gpu: null, cpu: 4, memoryGi: 8, maxInstances: 4, tabsPerInstance: 1, slow: 2, prices: { billing: 'request', cpuPerVcpuSecond: 0.000024, memoryPerGibSecond: 0.0000025 } } as any;
const t = { ...SETTINGS_DEFAULTS.playtest, cloudrunCpu: { ...SETTINGS_DEFAULTS.playtest.cloudrunCpu, url: LIVE_URL, extra: [{ url: AWAY_URL, region: 'us-central1', maxInstances: 4 }] } } as any;
const settings = { playtest: t, unityBuild: { gcp: { liveRegion: 'us-east4' } } } as any;

test('a listed CPU runner in the live region plays one instance, whatever its own cap', () => {
  const [r] = cleanRunners([{ id: 'cpu-live', provider: 'cloudrun-cpu', url: LIVE_URL, targets: ['web'], maxConcurrent: 4 }]);
  const svc = browserService(r, settings, { cpu: cpuSpec });
  assert.equal(svc?.region, 'us-east4');
  assert.equal(svc?.maxInstances, LIVE_REGION_CPU_INSTANCES);
  assert.equal(runnerCap(r, svc, settings), LIVE_REGION_CPU_INSTANCES);
});

test('a listed CPU runner in another region keeps its own cap (its region comes from the extra entry)', () => {
  const [r] = cleanRunners([{ id: 'cpu-away', provider: 'cloudrun-cpu', url: AWAY_URL, targets: ['web'], maxConcurrent: 4 }]);
  const svc = browserService(r, settings, { cpu: cpuSpec });
  assert.equal(svc?.region, 'us-central1');
  assert.equal(svc?.maxInstances, 4);
  assert.equal(runnerCap(r, svc, settings), 4);
});

test('admission: the live-region CPU runner is full after one run, the other region is not', () => {
  resetRunners();
  const [live, away] = cleanRunners([
    { id: 'cpu-live', provider: 'cloudrun-cpu', url: LIVE_URL, targets: ['web'], maxConcurrent: 4 },
    { id: 'cpu-away', provider: 'cloudrun-cpu', url: AWAY_URL, targets: ['web'], maxConcurrent: 4 },
  ]);
  const s = { ...settings, playtest: { ...t, runners: [live, away], order: ['cloudrun-cpu'] } };
  const release = claimRunner('cpu-live');
  claimRunner('cpu-away');
  try {
    const c = runnerCandidates({ project: null }, 'web', 'studio', s, { specs: { cpu: cpuSpec } });
    assert.match(c.skipped.join('\n'), /cpu-live: full \(1 of 1 runs\)/);
    assert.doesNotMatch(c.skipped.join('\n'), /cpu-away: full/);
    assert.equal(c.choices[0].runner.id, 'cpu-away', 'the runner with room comes first');
  } finally { release(); resetRunners(); }
});
