// sprite.sheet: a clip on flat green becomes a transparent atlas, its frame JSON and a GIF (ffmpeg; skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sprite-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { spriteGrid, pickFrames, keyFilter } = await import('../src/tools/local.ts');

test('grid and frame picking', () => {
  assert.deepEqual(spriteGrid(8), { cols: 4, rows: 2 });
  assert.deepEqual(spriteGrid(9), { cols: 3, rows: 3 });
  assert.deepEqual(spriteGrid(12), { cols: 4, rows: 3 });
  assert.deepEqual(spriteGrid(7), { cols: 4, rows: 2 });
  assert.deepEqual(spriteGrid(8, 4), { cols: 4, rows: 2 });
  assert.deepEqual(spriteGrid(3, 10), { cols: 3, rows: 1 });
  assert.deepEqual(pickFrames(33, 8), [0, 5, 9, 14, 18, 23, 27, 32]);
  assert.deepEqual(pickFrames(4, 8), [0, 1, 2, 3]);
  // A 33-frame loop: 8 frames over the 32-frame cycle, and never the repeated last one.
  assert.deepEqual(pickFrames(33, 8, true), [0, 4, 8, 12, 16, 20, 24, 28]);
  assert.match(keyFilter('00ff00', 0.3, 0.1), /^colorkey=0x00ff00:0.3:0.1,despill=type=green/);
  assert.match(keyFilter('0000ff', 0.3, 0.1), /despill=type=blue/);
  assert.equal(keyFilter('ff00ff', 0.3, 0.1), 'colorkey=0xff00ff:0.3:0.1');
});

test('a green-screen clip becomes a transparent sheet, its JSON and a preview', async (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('ffmpeg not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-run-'));
  const clip = path.join(dir, 'clip.mp4');
  // A white square moving across flat green, 2 s at 16 fps.
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=128x128:d=2:r=16', '-vf', "drawbox=x='t*40':y=40:w=32:h=48:color=white:t=fill", '-pix_fmt', 'yuv420p', clip]);
  assert.equal(made.status, 0, String(made.stderr));

  const emitted: any[] = [];
  let result: any = null;
  const tool = getTool('sprite.sheet')!;
  await tool.run({
    job: { id: 'j_test', client: 'test', project: 'test', tool: 'sprite.sheet', labels: {} },
    params: validateParams(tool, { frames: 6, columns: 3, cell: 64, key: '00ff00' }),
    inputs: { video: clip },
    done: 0,
    outputs: [],
    signal: new AbortController().signal,
    step: () => {},
    log: () => {},
    tmp: (name: string) => path.join(dir, name),
    emit: async (o: any) => { emitted.push(o); },
    result: (v: any) => { result = v; },
    seed: () => 1,
    usage: () => {},
    python: async () => '',
  } as any);

  assert.deepEqual(emitted.map((o) => o.ext), ['.png', '.json', '.gif']);
  assert.deepEqual([result.columns, result.rows, result.count, result.frameWidth, result.frameHeight], [3, 2, 6, 64, 64]);
  const json = JSON.parse(emitted[1].data.toString());
  assert.deepEqual(json.frames.frame_04.frame, { x: 64, y: 64, w: 64, h: 64 });
  assert.equal(json.animations.frame.length, 6);

  // The atlas is 192x128 and the green is gone: the top-left pixel is transparent.
  const png = path.join(dir, 'check.png');
  fs.writeFileSync(png, emitted[0].data);
  const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', png], { encoding: 'utf8' }).stdout);
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [192, 128]);
  assert.match(probe.streams[0].pix_fmt, /rgba/);
  const px = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'crop=1:1:0:0,format=rgba', '-f', 'rawvideo', '-'], { encoding: 'buffer' }).stdout;
  assert.equal(px[3], 0, 'keyed background is transparent');
});
