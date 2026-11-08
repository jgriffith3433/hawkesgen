// The live stream hub: a user's 4th stream closes the oldest (which is told to come back), events reach only their
// owner's streams, and each event is serialised once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-hub-'));
const { addStream, streamCount, MAX_STREAMS_PER_USER } = await import('../src/eventhub.ts');
const { events } = await import('../src/bus.ts');

const mk = (id: string, projects: string[], role: any = 'user') => ({ id, name: id, role, projects });
const sink = () => { const s = { out: '', ended: false, write(c: string) { s.out += c; return true; }, end() { s.ended = true; } }; return s; };

test('a 4th stream closes the oldest with a bye, the rest stay', () => {
  const c = mk('hub-a', ['usr_a']);
  const s = [sink(), sink(), sink(), sink()];
  s.forEach((x) => addStream(c, x, { ops: false }));
  assert.equal(MAX_STREAMS_PER_USER, 3);
  assert.equal(streamCount(c), 3);
  assert.ok(s[0].ended && s[0].out.includes('event: bye') && s[0].out.includes('"limit"'));
  assert.ok(!s[1].ended && !s[2].ended && !s[3].ended);
});

test('events reach only the owner\'s streams, serialised once', () => {
  const a = mk('hub-b', ['usr_b']), b = mk('hub-c', ['usr_c']), admin = mk('hub-d', ['*'], 'admin');
  const sa = sink(), sb = sink(), sad = sink();
  addStream(a, sa, { ops: false }); addStream(b, sb, { ops: false }); addStream(admin, sad, { ops: true });
  events.emit('scene', { project: 'usr_b', id: 's_1', version: 2 });
  events.emit('machines', { at: 1 });
  assert.match(sa.out, /event: scene/);
  assert.ok(!sb.out.includes('event:'), 'another customer hears nothing');
  assert.match(sad.out, /event: scene/);
  assert.match(sad.out, /event: machines/);
  assert.ok(!sa.out.includes('machines'));
  const orig = JSON.stringify; let n = 0;
  JSON.stringify = ((...x: any[]) => { if (String((orig as any)(x[0])).includes('"s_')) n++; return (orig as any)(...x); }) as any;
  try { events.emit('scene', { project: 'usr_b', id: 's_2', version: 1 }); addStream(a, sink(), { ops: false }); events.emit('scene', { project: 'usr_b', id: 's_3', version: 1 }); } finally { JSON.stringify = orig; }
  assert.equal(n, 2, 'one serialisation per event, however many streams');
});

test('an unregistered stream hears nothing and a dead sink is dropped', () => {
  const c = mk('hub-e', ['usr_e']);
  const dead = { write() { throw new Error('closed'); }, end() {} };
  const off = addStream(c, dead, { ops: false });
  events.emit('scene', { project: 'usr_e', id: 's', version: 1 });
  assert.equal(streamCount(c), 0);
  off();
});
