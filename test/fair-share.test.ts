// Fair sharing of the GPU between customer projects (jobs.ts fairOrder, sameTurn, queuePosition).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-fair-'));
const { fairOrder, sameTurn, queuePosition, submit, getJob, queue } = await import('../src/jobs.ts');
const { createClient } = await import('../src/auth.ts');
(queue as any).pump = () => {};

const mk = (project: string, n: number, t0: number, exempt = false) =>
  Array.from({ length: n }, (_, i) => ({ id: `${project}${i}`, project, family: 'f', priority: 0, created: t0 + i * 10 + (project === 'usr_b' ? 1 : 0), exempt }));

test('two projects with ten jobs each alternate; a third with one job starts within the first turn', () => {
  const open = [...mk('usr_a', 10, 0), ...mk('usr_b', 10, 0), { id: 'c0', project: 'usr_c', family: 'f', priority: 0, created: 500, exempt: false }]
    .sort((x, y) => x.created - y.created);
  const order = fairOrder(open, new Map(), 99).map((j) => j.project);
  const first = order.slice(0, 4);
  assert.ok(first.includes('usr_c'), 'the lone project is in the first turn');
  const ab = order.filter((p) => p !== 'usr_c');
  ab.forEach((p, i) => assert.equal(p, i % 2 ? 'usr_b' : 'usr_a'));
});

test('the cap holds: running jobs count, and a project at its cap waits while another goes', () => {
  const open = [...mk('usr_a', 5, 0), ...mk('usr_b', 1, 100)];
  const o = fairOrder(open, new Map([['usr_a', 2]]), 2);
  assert.deepEqual(o.filter((j) => j.ok).map((j) => j.id), ['usr_b0']);
  const o2 = fairOrder(open, new Map([['usr_a', 1]]), 2);
  assert.deepEqual(o2.filter((j) => j.ok).map((j) => j.id).sort(), ['usr_a0', 'usr_b0']);
});

test('exempt jobs ignore the cap', () => {
  const o = fairOrder(mk('hawkesgen', 6, 0, true), new Map([['hawkesgen', 9]]), 2);
  assert.equal(o.filter((j) => j.ok).length, 6);
});

test('a priority boost still goes first, and sameTurn keeps one turn so model grouping cannot skip a project', () => {
  const open = [{ id: 'a0', project: 'usr_a', family: 'x', priority: 0, created: 1, exempt: false }, { id: 'a1', project: 'usr_a', family: 'y', priority: 0, created: 2, exempt: false },
    { id: 'b0', project: 'usr_b', family: 'y', priority: 0, created: 3, exempt: false }, { id: 'v', project: 'usr_b', family: 'z', priority: 5, created: 9, exempt: false }];
  const o = fairOrder(open, new Map(), 9);
  assert.equal(o[0].id, 'v');
  const o2 = fairOrder(open.slice(0, 3), new Map(), 9);
  assert.deepEqual(sameTurn(o2).map((j) => j.id), ['a0', 'b0']);
});

test('a queued job reports ahead (fair order) and etaMinutes', () => {
  const user = createClient('customer', 'user', ['usr_*']).client as any;
  const a = Array.from({ length: 4 }, (_, i) => submit(user, { tool: 'image.generate', project: 'usr_a', params: { prompt: `a${i}` } }));
  const b = submit(user, { tool: 'image.generate', project: 'usr_b', params: { prompt: 'b' } });
  const qa = queuePosition(getJob(a[3].id)!)!;
  const qb = queuePosition(getJob(b.id)!)!;
  assert.equal(qb.ahead, 1, 'b waits behind only the first of a');
  assert.equal(qa.ahead, 4, 'a3 is behind a0, a1, a2 and the newcomer b (turn 0)');
  assert.ok(qb.etaMinutes >= 1);
});
