import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('phone: two fingers on the stage zoom the picture, one finger still moves an object, a mouse never pinches', () => {
  const js = read('dashboard/gen/player.js');
  assert.match(js, /stagePinch\(\$\('#viewer'\)\)/, 'the viewer listens for the pinch');
  assert.match(js, /if \(e\.pointerType !== 'touch'\) return;/, 'only touches start a pinch');
  assert.match(js, /Math\.min\(5, Math\.max\(1,/, 'zoom stays between 1x and 5x');
  assert.match(js, /stageView\.stopDrag\?\.\(\)/, 'a second finger ends an object drag');
  assert.match(js, /addEventListener\('pointercancel', up\)/, 'a cancelled touch ends the drag');
  assert.match(js, /stage\.offsetWidth/, 'handles measure the stage unscaled');
  const css = read('dashboard/gen/gen.css');
  assert.match(css, /\.viewer, \.viewer \.stage, \.viewer \.stage > canvas\.comp \{ touch-action: none; \}/);
});

test('phone: a clip drag follows only its own finger, and trim edges are finger-sized but leave a short clip a middle', () => {
  const js = read('dashboard/gen/timeline.js');
  assert.match(js, /if \(ev\.pointerId !== e\.pointerId\) return;\n    const dx = ev\.clientX - x0;/);
  assert.match(js, /addEventListener\('pointerdown', second, true\)/);
  assert.match(read('dashboard/gen/gen.css'), /\.clip \.h-l, \.clip \.h-r \{ width: min\(22px, 30%\); \}/);
});

test('phone: the bar clears the notch and the tabs clear the home indicator', () => {
  const css = read('dashboard/gen/gen.css');
  assert.match(css, /--bar: calc\(50px \+ env\(safe-area-inset-top\)\)/);
  assert.match(css, /padding-top: env\(safe-area-inset-top\)/);
  assert.match(css, /--tabs: calc\(58px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(read('dashboard/gen/index.html'), /viewport-fit=cover/);
});
