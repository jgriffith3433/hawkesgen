// A Claude job someone is waiting on (labels `waiting`, the portal's Overseer): its call runs as that project's turn
// (`who`), so Claude's gate puts it ahead of Gen's own calls and bounds its wait (src/aigate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { waitedOn } = await import('../src/tools/api.ts');
const { callScope } = await import('../src/providers/anthropic.ts');

const ctx = (labels: Record<string, unknown>) => ({ job: { id: 'j_1', client: 'c', project: 'u_p', tool: 'llm.text', labels } }) as any;

test('a job labelled waiting asks as its project\'s turn; others are Gen\'s own calls', async () => {
  const scope = { customer: true, org: null, house: true };
  const seen = await callScope.run(scope, () => waitedOn(ctx({ waiting: 'player' }), async () => callScope.getStore()));
  assert.deepEqual(seen, { ...scope, who: 'u_p' });
  const plain = await callScope.run(scope, () => waitedOn(ctx({}), async () => callScope.getStore()));
  assert.equal(plain?.who, undefined);
});
