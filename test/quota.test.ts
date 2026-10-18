// GPU quota requests (POST /v1/fleet/quota, MCP hawkesgen_fleet request-quota): what gets refused before AWS is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { quotaRequestProblem } = await import('../src/providers/comfy/fleet.ts');
const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

test('a bigger quota in a fleet region can be requested', () => {
  assert.equal(quotaRequestProblem('us-east-1', 16, 8, [], REGIONS), null);
  assert.equal(quotaRequestProblem('us-east-1', '16', null, [{ value: 8, status: 'APPROVED' }, { value: 12, status: 'DENIED' }], REGIONS), null);
});

test('an unknown region or a silly size is refused', () => {
  assert.match(quotaRequestProblem('mars-1', 16, 8, [], REGIONS)!, /Not a region/);
  assert.match(quotaRequestProblem('us-east-1', 2, 0, [], REGIONS)!, /between 4 and 64/);
  assert.match(quotaRequestProblem('us-east-1', 128, 8, [], REGIONS)!, /between 4 and 64/);
  assert.match(quotaRequestProblem('us-east-1', 'lots', 8, [], REGIONS)!, /between 4 and 64/);
});

test('asking for no more than the current quota is refused', () => {
  assert.match(quotaRequestProblem('us-east-1', 8, 8, [], REGIONS)!, /already allows 8/);
});

test('a request AWS is still working on blocks another', () => {
  assert.match(quotaRequestProblem('us-east-1', 16, 8, [{ value: 16, status: 'PENDING' }], REGIONS)!, /already has a quota request open \(16 vCPUs, PENDING\)/);
  assert.match(quotaRequestProblem('us-east-1', 24, 8, [{ value: 16, status: 'CASE_OPENED' }], REGIONS)!, /open/);
});
