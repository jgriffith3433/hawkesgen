// keyedRedraw (dashboard/gen/lib.js): lists redraw in place, so a tile that didn't change keeps its element (its picture or
// clip doesn't reload). J, 2026-11-01: "On the media panel of HG I noticed that it refreshes a lot."

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { keyedRedraw } = await import('../dashboard/gen/lib.js') as any;

// Just enough of a DOM element for keyedRedraw: children, insertBefore, remove, dataset.
class El {
  dataset: Record<string, string> = {};
  parent: Box | null = null;
  name: string;
  constructor(name: string) { this.name = name; }
  remove() { if (!this.parent) return; this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; }
}
class Box {
  kids: El[] = [];
  inserts = 0;
  get children() { return this.kids; }
  get lastElementChild() { return this.kids[this.kids.length - 1] ?? null; }
  insertBefore(el: El, ref: El | null) {
    this.inserts++;
    el.remove();
    const at = ref ? this.kids.indexOf(ref) : this.kids.length;
    this.kids.splice(at < 0 ? this.kids.length : at, 0, el);
    el.parent = this;
  }
}

const rows = (list: [string, string][], made: string[]) => list.map(([key, sig]) => ({ key, sig, make: () => { made.push(key); return new El(key); } }));

test('unchanged rows keep their elements and nothing moves', () => {
  const box = new Box();
  const made: string[] = [];
  keyedRedraw(box, rows([['a', '1'], ['b', '1'], ['c', '1']], made));
  const first = [...box.kids];
  box.inserts = 0;
  keyedRedraw(box, rows([['a', '1'], ['b', '1'], ['c', '1']], made));
  assert.deepEqual(made, ['a', 'b', 'c']);
  assert.equal(box.inserts, 0);
  assert.deepEqual(box.kids, first);
});

test('a new row at the top is the only one made and the only one inserted', () => {
  const box = new Box();
  const made: string[] = [];
  keyedRedraw(box, rows([['a', '1'], ['b', '1']], made));
  const [a, b] = box.kids;
  made.length = 0;
  box.inserts = 0;
  keyedRedraw(box, rows([['n', '1'], ['a', '1'], ['b', '1']], made));
  assert.deepEqual(made, ['n']);
  assert.equal(box.inserts, 1);
  assert.deepEqual(box.kids.map((x) => x.name), ['n', 'a', 'b']);
  assert.equal(box.kids[1], a);
  assert.equal(box.kids[2], b);
});

test('a changed row is made again, a gone row is removed, and update runs on every row', () => {
  const box = new Box();
  const made: string[] = [];
  keyedRedraw(box, rows([['a', '1'], ['b', '1'], ['c', '1']], made));
  const c = box.kids[2];
  made.length = 0;
  const seen: string[] = [];
  keyedRedraw(box, rows([['b', '2'], ['c', '1']], made).map((r) => ({ ...r, update: (el: El) => seen.push(el.name) })));
  assert.deepEqual(made, ['b']);
  assert.deepEqual(box.kids.map((x) => x.name), ['b', 'c']);
  assert.equal(box.kids[1], c);
  assert.deepEqual(seen, ['b', 'c']);
});

test('anything else in the box (an empty note) goes', () => {
  const box = new Box();
  box.insertBefore(new El('note'), null);
  keyedRedraw(box, rows([['a', '1']], []));
  assert.deepEqual(box.kids.map((x) => x.name), ['a']);
});
