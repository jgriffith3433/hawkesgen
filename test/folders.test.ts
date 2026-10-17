// Folders <-> the library (clients/js/hawkesgen-folders.mjs): a product's folders come in as entities, slots and
// versions; a second import changes nothing; the library's picks stand; export writes them back. HTTP on a random port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-folders-'));
const { handle } = await import('../src/api.ts');
// @ts-ignore: plain JS client
const { HawkesGen } = await import('../clients/js/hawkesgen.mjs');
// @ts-ignore: plain JS module
const F = await import('../clients/js/hawkesgen-folders.mjs');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const gen = new HawkesGen({ url: `http://127.0.0.1:${(server.address() as any).port}`, key: '', project: 'testgame' });
test.after(() => server.close());

// A DoD-like fighter folder.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-chars-'));
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
put('DJWontRead/concept.png', 'concept');
put('DJWontRead/anims/_side.png', 'side B');
put('DJWontRead/anims/_side-1.png', 'side A');
put('DJWontRead/anims/_side-1.json', JSON.stringify({ prompt: 'side view, facing right', seed: 1 }));
put('DJWontRead/anims/_side-2.png', 'side B');
put('DJWontRead/poses/air.png', 'air');
put('DJWontRead/anims/jab.mp4', 'jab v2');
put('DJWontRead/anims/_old/jab-100.mp4', 'jab v1');
put('_shared/ignored.png', 'skip me');
const mapFile = path.join(root, 'map.json');
fs.writeFileSync(mapFile, JSON.stringify({
  project: 'testgame', kind: 'fighter', root: '.', skip: ['_*'],
  slots: [
    { slot: 'concept', current: '*.png' },
    { slot: 'side', current: 'anims/_side.png', takes: 'anims/_side-*.png', recipe: '{file}.json' },
    { slot: 'pose/{name}', current: 'poses/{name}.png' },
    { slot: 'clip/{name}', current: 'anims/{name}.mp4', old: 'anims/_old/{name}-*.mp4' },
  ],
}));
const m = F.loadMapping(mapFile);

test('slugs and patterns', () => {
  assert.equal(F.slugOf('DJWontRead'), 'dj-wont-read');
  assert.equal(F.slugOf('EvilBlueBird'), 'evil-blue-bird');
  assert.ok(F.patternRegex('*.{jpg,png}').test('a.png'));
  assert.ok(!F.patternRegex('*.{jpg,png}').test('anims/a.png'));
  assert.equal(F.patternRegex('poses/_takes/{name}-*.png').exec('poses/_takes/air-12.png')?.groups?.name, 'air');
  assert.equal(F.currentPath(m, 'pose/air'), 'poses/{name}.png'.replace('{name}', 'air'));
  assert.equal(F.currentPath(m, 'concept'), null); // a wildcard can't be written back
});

test('import brings folders in; again changes nothing; the library\'s pick stands; export writes it back', async () => {
  const first = await F.importFolders(gen, m);
  assert.deepEqual(F.entityFolders(m), ['DJWontRead']);
  const e = await gen.entity('testgame/dj-wont-read');
  assert.equal(e.data.folder, 'DJWontRead');
  assert.equal(e.slots.side.versions, 2, 'side B is a take and the current: stored once');
  assert.equal(e.slots.side.current.n, 2);
  assert.equal(e.slots['clip/jab'].versions, 2);
  assert.equal(e.slots['clip/jab'].current.n, 2);
  const side = await gen.slot(e.id, 'side');
  assert.equal(side.versions.find((v: any) => v.n === 1).file.prompt, 'side view, facing right');
  assert.ok(first.some((r: any) => r.action === 'created'));

  const again = await F.importFolders(gen, m);
  assert.ok(again.every((r: any) => r.action === 'same'), JSON.stringify(again.filter((r: any) => r.action !== 'same')));

  // Pick side A in the library: a re-import reports the folder differs and leaves the pick.
  const a = side.versions.find((v: any) => v.n === 1);
  await gen.pick(a.id);
  const third = await F.importFolders(gen, m);
  assert.deepEqual(third.filter((r: any) => r.action !== 'same').map((r: any) => [r.slot, r.action]), [['side', 'differs']]);
  assert.equal((await gen.current(e.id, 'side')).n, 1);

  // Export writes the pick into the folder.
  const out = await F.exportFolders(gen, m);
  assert.deepEqual(out.filter((r: any) => r.action !== 'same').map((r: any) => [r.slot, r.action]), [['side', 'written']]);
  assert.equal(fs.readFileSync(path.join(root, 'DJWontRead/anims/_side.png'), 'utf8'), 'side A');
  assert.ok((await F.exportFolders(gen, m)).every((r: any) => r.action === 'same'));

  // adopt: the folder wins.
  put('DJWontRead/anims/_side.png', 'side C');
  await F.importFolders(gen, m, { adopt: true });
  assert.equal((await gen.current(e.id, 'side')).n, 3);
});
