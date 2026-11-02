// Hawkes Gen's pages never zoom (J, 2026-11-02): every page's viewport tag says so and loads /gen/nozoom.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const pages = ['dashboard/gen/index.html', 'dashboard/gen/legal.html', 'dashboard/index.html', 'dashboard/public/app.html',
  'dashboard/public/game-editor.html', 'dashboard/public/index.html', 'dashboard/public/landing.html', 'dashboard/public/player.html',
  'src/adminpage.ts', 'src/genoauth.ts', 'src/mcp-oauth.ts'];

test('every page has a viewport that cannot be scaled and loads the no-zoom script', () => {
  for (const p of pages) {
    const text = fs.readFileSync(path.join(root, p), 'utf8');
    const m = /<meta name="viewport" content="([^"]*)"/.exec(text);
    assert.ok(m, `${p}: viewport tag`);
    assert.match(m[1], /initial-scale=1/, p);
    assert.match(m[1], /maximum-scale=1/, p);
    assert.match(m[1], /user-scalable=no/, p);
    assert.ok(text.includes('/gen/nozoom.js'), `${p}: loads nozoom.js`);
  }
});

test('nozoom.js stops gestures and ctrl+wheel without stopping propagation', () => {
  const js = fs.readFileSync(path.join(root, 'dashboard/gen/nozoom.js'), 'utf8');
  assert.match(js, /gesturestart/);
  assert.match(js, /e\.ctrlKey/);
  assert.match(js, /touch-action: manipulation/);
  assert.doesNotMatch(js, /stopPropagation|stopImmediatePropagation/);
});

test('nozoom.js also gives the app feel: no overscroll, no tap flash, chrome not selectable, inputs selectable', () => {
  const js = fs.readFileSync(path.join(root, 'dashboard/gen/nozoom.js'), 'utf8');
  assert.match(js, /overscroll-behavior: none/);
  assert.match(js, /-webkit-tap-highlight-color: transparent/);
  assert.match(js, /user-select: none/);
  assert.match(js, /input, textarea[^)]*\) \{ -webkit-user-select: text/);
});
