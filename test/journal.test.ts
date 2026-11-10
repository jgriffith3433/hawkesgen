// The save journal (dashboard/gen/journal.js): replay picks the newest op on the server's version, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, ordered, nextSeq, append, pending, clear } from '../dashboard/gen/journal.js';

const op = (seq: number, base: number, scene = 's1') => ({ seq, scene, base, doc: { n: seq } });

test('replay takes the newest op made on this version or later, and none once the server is past them', () => {
  const ops = [op(3, 4), op(1, 4), op(2, 4), op(9, 2, 's2')];
  assert.equal(replay(ops, 's1', 4)?.seq, 3);
  assert.equal(replay(ops, 's1', 5), null);
  assert.equal(replay(ops, 's2', 2)?.seq, 9);
});

test('ops keep the order they were made in, even across reloads', () => {
  const a = nextSeq(), b = nextSeq(), c = nextSeq();
  assert.ok(a < b && b < c);
  assert.deepEqual(ordered([op(c, 1), op(a, 1), op(b, 1)]).map((o) => o.seq), [a, b, c]);
});

test('without IndexedDB the journal still keeps and clears an op', async () => {
  await append(op(10, 1, 'mem'));
  assert.equal((await pending('mem')).length, 1);
  await clear('mem', 10);
  assert.equal((await pending('mem')).length, 0);
});
