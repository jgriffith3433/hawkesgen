import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSheet } from '../src/tools/sheet.ts';

test('planSheet stacks every view in one row', () => {
  const g = planSheet(4, 512, 'ffffff');
  assert.match(g, /hstack=inputs=4\[out\]/);
  assert.equal((g.match(/scale=512:512/g) ?? []).length, 4);
});

test('planSheet output is a valid ffmpeg graph', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
  const ins: string[] = [];
  for (const [i, size] of ['64x128', '100x50', '80x80'].entries()) {
    const f = path.join(dir, `v${i}.png`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${size}`, '-frames:v', '1', f]);
    assert.equal(r.status, 0);
    ins.push('-i', f);
  }
  const out = path.join(dir, 'sheet.png');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...ins, '-filter_complex', planSheet(3, 256, 'ffffff'), '-map', '[out]', '-frames:v', '1', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(p.stdout.trim(), '768,256');
});
