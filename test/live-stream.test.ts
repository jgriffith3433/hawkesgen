// The app's live stream (dashboard/gen/stream.js): an HTTP error makes a browser's EventSource give up for good
// (2026-11-02, a deploy's 500s), so it is opened again with a growing wait and the page catches up once it's back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStream, retryDelay, RETRY_MAX } from '../dashboard/gen/stream.js';

class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  addEventListener(name: string, fn: (e: { data: string }) => void) { (this.listeners[name] ??= []).push(fn); }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  fail(gaveUp: boolean) { this.readyState = gaveUp ? 2 : 0; this.onerror?.(); }
  emit(name: string, data: string) { for (const fn of this.listeners[name] ?? []) fn({ data }); }
}

function harness() {
  FakeES.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const seen: any[] = [];
  let reconnects = 0;
  const s = openStream({ job: (j: any) => seen.push(j) }, {
    EventSource: FakeES, random: () => 0, onReconnect: () => reconnects++,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  });
  return { s, timers, seen, reconnects: () => reconnects };
}

test('the waits grow from 2 s to 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => retryDelay(n, () => 0)), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.ok(retryDelay(9, () => 1) <= RETRY_MAX * 1.2);
});

test('an HTTP error (the browser gave up): opened again later, and the page catches up once', async () => {
  const h = harness();
  FakeES.all[0].open();
  assert.equal(h.reconnects(), 0);
  FakeES.all[0].fail(true);
  assert.equal(FakeES.all[0].closed, true);
  assert.deepEqual(h.timers.map((t) => t.ms), [2000]);
  h.timers[0].fn();
  FakeES.all[1].fail(true);
  assert.deepEqual(h.timers.map((t) => t.ms), [2000, 4000]);
  h.timers[1].fn();
  FakeES.all[2].open();
  assert.equal(h.reconnects(), 1);
  FakeES.all[2].fail(true);
  assert.equal(h.timers.at(-1)!.ms, 2000, 'a stream that came back starts the waits over');
});

test('a dropped stream the browser is retrying itself is left to it', () => {
  const h = harness();
  FakeES.all[0].open();
  FakeES.all[0].fail(false);
  assert.equal(h.timers.length, 0);
  assert.equal(FakeES.all.length, 1);
  FakeES.all[0].open();
  assert.equal(h.reconnects(), 1);
});

test('only JSON events reach the handlers; close stops for good', () => {
  const h = harness();
  FakeES.all[0].emit('job', '<html>500 Server Error</html>');
  FakeES.all[0].emit('job', '{"id":"j_1","status":"done"}');
  assert.deepEqual(h.seen, [{ id: 'j_1', status: 'done' }]);
  h.s.close();
  FakeES.all[0].fail(true);
  assert.equal(h.timers.length, 0);
});

test('a bye (the account has too many streams): closed, opened again after the longest wait, and the page catches up', () => {
  const h = harness();
  FakeES.all[0].open();
  FakeES.all[0].emit('bye', '{"reason":"limit"}');
  assert.equal(FakeES.all[0].closed, true);
  assert.deepEqual(h.timers.map((t) => t.ms), [30000]);
  h.timers[0].fn();
  FakeES.all[1].open();
  assert.equal(h.reconnects(), 1);
});
