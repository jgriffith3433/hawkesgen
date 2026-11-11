// Offline checks for the stuck-execution clear tool: CPU parse, age, job filter, plan (what to cancel and freed vCPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  parseCpu, ageMinutes, isTargetJob, planClear, JOB_PREFIXES,
} from '../tools/clear-stuck-executions.mjs';

test('parseCpu reads whole vCPU and millicores', () => {
  assert.equal(parseCpu('8'), 8);
  assert.equal(parseCpu('4'), 4);
  assert.equal(parseCpu('1000m'), 1);
  assert.equal(parseCpu('2000m'), 2);
  assert.equal(parseCpu(''), 1);
  assert.equal(parseCpu(undefined), 1);
});

test('ageMinutes is whole minutes from create time', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(ageMinutes('2026-11-11T10:30:00Z', now), 90);
  assert.equal(ageMinutes('2026-11-11T11:59:00Z', now), 1);
  assert.equal(ageMinutes('2026-11-11T12:00:00Z', now), 0);
  assert.equal(ageMinutes('', now), 0);
});

test('isTargetJob only unity-build and cell-agent families', () => {
  assert.ok(isTargetJob('hawkes-unity-build'));
  assert.ok(isTargetJob('hawkes-unity-build-customer'));
  assert.ok(isTargetJob('hawkes-unity-build-customer-m'));
  assert.ok(isTargetJob('studio-cell-agent'));
  assert.ok(isTargetJob('studio-cell-agent-beta'));
  assert.equal(isTargetJob('gen'), false);
  assert.equal(isTargetJob('studio'), false);
  assert.equal(isTargetJob('hawkes-unity'), false);
  assert.ok(JOB_PREFIXES.includes('hawkes-unity-build'));
  assert.ok(JOB_PREFIXES.includes('studio-cell-agent'));
});

test('planClear lists all incomplete, cancels only those at/over the threshold, freed vCPU equals their sum', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const rows = [
    { name: 'u-old', job: 'hawkes-unity-build', createTime: '2026-11-11T10:00:00Z', startTime: '2026-11-11T10:01:00Z', vcpu: 8 },
    { name: 'u-new', job: 'hawkes-unity-build', createTime: '2026-11-11T11:30:00Z', startTime: '', vcpu: 8 },
    { name: 'a-old', job: 'studio-cell-agent', createTime: '2026-11-11T09:00:00Z', startTime: '2026-11-11T09:05:00Z', vcpu: 2 },
    { name: 'a-mid', job: 'studio-cell-agent', createTime: '2026-11-11T10:30:00Z', startTime: '', vcpu: 2 },
  ];
  const plan = planClear(rows, { olderThanMin: 90, nowMs: now });
  assert.equal(plan.listed.length, 4);
  assert.deepEqual(plan.listed.map((r) => r.name), ['a-old', 'u-old', 'a-mid', 'u-new']);
  assert.equal(plan.listed.find((r) => r.name === 'u-old')!.ageMin, 120);
  assert.equal(plan.listed.find((r) => r.name === 'a-mid')!.ageMin, 90);
  assert.deepEqual(plan.cancel.map((r) => r.name).sort(), ['a-mid', 'a-old', 'u-old']);
  assert.equal(plan.freedVcpu, 8 + 2 + 2);
  assert.equal(plan.freedVcpu, plan.cancel.reduce((s, r) => s + r.vcpu, 0));
  // Under threshold stays listed but not cancelled
  assert.ok(!plan.cancel.some((r) => r.name === 'u-new'));
});

test('dry-run script with --offline cancels nothing and prints the default threshold', () => {
  const r = spawnSync(process.execPath, [
    'tools/clear-stuck-executions.mjs', '--project', 'hawkes-staging', '--region', 'us-east4', '--offline',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Threshold: 90 min/);
  assert.match(r.stdout, /No incomplete|Incomplete/);
  assert.match(r.stdout, /freed vCPU: 0 \(dry run/);
  assert.match(r.stdout, /Nothing was changed/);
  assert.doesNotMatch(r.stdout, /^> gcloud/m);
});
