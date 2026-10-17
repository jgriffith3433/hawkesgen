// The library over HTTP, through the JS client every project copies: entities, a file into a slot, picking, make
// (a local tool, so it really runs), takes filed by the queue, live events and exportSlots. A scratch data folder and
// a random port; no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-libapi-'));
const { handle } = await import('../src/api.ts');
// @ts-ignore: plain JS client
const { HawkesGen } = await import('../clients/js/hawkesgen.mjs');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
const gen = new HawkesGen({ url: `http://127.0.0.1:${port}`, key: '', project: 'doseofdestruction' }); // no key: this machine
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-libapi-files-'));
const png = path.join(tmp, 'side.png');
// A real 64x64 PNG (a gradient), so the local tools can read it.
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
  return Buffer.concat([len, Buffer.from(type), data, crc]);
};
const rows = Buffer.concat(Array.from({ length: 64 }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 * 3 }, (_, i) => (i % 3 === 0 ? y * 4 : i % 3 === 1 ? (i / 3) * 4 : 128) & 255))])));
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));

test.after(() => server.close());

test('the client: an entity, a file into a slot, pick, history, live events', async () => {
  const seen: any[] = [];
  const stop = gen.watch((ev: any) => ev.type === 'library' && seen.push(ev.data));
  await new Promise((r) => setTimeout(r, 200));

  const e = await gen.createEntity({ name: 'Break', kind: 'character', data: { canon: 'pink power armor' } });
  assert.equal(e.id, 'doseofdestruction/break');
  const v = await gen.addVersion(e.id, 'side', png, { note: 'from the concept' });
  assert.equal(v.n, 1);
  assert.equal(v.status, 'take');
  await gen.pick(v.id);
  assert.equal((await gen.current(e.id, 'side')).id, v.id);
  const h = await gen.slot(e.id, 'side');
  assert.equal(h.versions[0].file.kind, 'image');
  assert.equal(h.versions[0].note, 'from the concept');
  const bytes = await gen.bytes(h.versions[0].asset);
  assert.equal(bytes.length, fs.statSync(png).size);

  await new Promise((r) => setTimeout(r, 300));
  stop();
  assert.ok(seen.some((x) => x.type === 'version' && x.status === 'current'), JSON.stringify(seen));
  const list = await gen.entities({ kind: 'character' });
  assert.equal(list.items[0].slots.side.current.n, 1);
});

// image.tile is a local Python tool: CI has no .venv, so this one skips there.
const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].some((p) => fs.existsSync(p));

test('make: a slot recipe with a slot reference runs, and its output comes back as a take', { skip: !python && 'no .venv' }, async () => {
  const id = 'doseofdestruction/break';
  await gen.updateEntity(id, { data: { slots: { 'pose/tiled': { brief: 'a tile test', make: { tool: 'image.tile', inputs: { image: 'slot:./side' }, params: { blend: 0.2 } } } } } });
  const job = await gen.make(id, 'pose/tiled', { note: 'first try' });
  assert.equal(job.labels.entity, id);
  const done = await gen.wait(job.id, { timeoutMs: 60_000 });
  assert.equal(done.status, 'done', done.error);
  const h = await gen.slot(id, 'pose/tiled');
  assert.equal(h.versions.length, 1);
  assert.equal(h.versions[0].made_from[0].slot, 'side');
  assert.equal(h.versions[0].note, 'first try');

  const out = await gen.exportSlots(id, { side: path.join(tmp, 'out', '_side.png'), 'pose/*': path.join(tmp, 'out', 'poses', '{part}.png') });
  assert.deepEqual(out.map((x: any) => [x.slot, x.written]), [['side', true]]); // pose/tiled has no current yet
  await gen.pick(h.versions[0].id);
  const again = await gen.exportSlots(id, { side: path.join(tmp, 'out', '_side.png'), 'pose/*': path.join(tmp, 'out', 'poses', '{part}.png') });
  assert.deepEqual(again.map((x: any) => [x.slot, x.written]), [['pose/tiled', true], ['side', false]]);
  assert.ok(fs.existsSync(path.join(tmp, 'out', 'poses', 'tiled.png')));
});

test('errors say what to do', async () => {
  await assert.rejects(gen.make('doseofdestruction/break', 'voice/hi'), /Nothing says how to make/);
  await assert.rejects(gen.entity('doseofdestruction/nobody'), /No entity/);
  await assert.rejects(gen.make('doseofdestruction/break', 'clip/jab', { make: { tool: 'image.tile', inputs: { image: 'slot:./clip/run' } } }), /no current clip\/run/);
});
