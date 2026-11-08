// A scene with no inspector (character, place, prop, story, world) never shows the last timeline scene's Inspector
// (its Add buttons) in the Inspect pane, and a phone hides its Inspect tab for it (Studio roadmap, Nov 7: "Character
// scene Inspect tab shows the generic Add panel").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const gen = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard/gen', f), 'utf8');

test('the panel-less scene kinds are the ones this guards', () => {
  for (const f of ['character.js', 'place.js', 'prop.js', 'story.js', 'world.js']) assert.match(gen(f), /panel: null/, f);
});

test('opening a scene with no panel replaces the Inspect pane, so no stale Add panel is left there', () => {
  const s = gen('scenes.js');
  assert.match(s, /if \(!ed\?\.panel\) \$\('#kindPanel'\)\?\.replaceChildren\(noInspector\(ed\)\)/);
  assert.match(s, /const noInspector = /);
  // It runs before the editor mounts, so an editor that has a panel (Inspector, Shot) still draws its own over it.
  assert.ok(s.indexOf('noInspector(ed)') < s.indexOf('await ed.mount(scene)'));
});

test('the phone Inspect tab hides for a scene with no panel and goes back to Edit', () => {
  const g = gen('gen.js');
  const on = g.slice(g.indexOf("bus.on('sceneActive'"));
  assert.match(on, /k\.hidden = !panel/);
  assert.match(on, /dataset\.m === 'kind'.*data-m="edit"/);
});
