// image.transform: steps in order on a transparent sprite (Pillow; skipped without the .venv).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-transform-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');

const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const pillow = python && spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;

async function transform(input: string, ops: unknown[], format = 'png') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-run-'));
  const tool = getTool('image.transform')!;
  const emitted: any[] = [];
  let result: any = null;
  await tool.run({
    job: { id: 'j', client: 't', project: 't', tool: 'image.transform', labels: {} },
    params: validateParams(tool, { ops, format }),
    inputs: { image: input },
    done: 0, outputs: [], signal: new AbortController().signal,
    step: () => {}, log: () => {}, tmp: (n: string) => path.join(dir, n),
    emit: async (o: any) => { emitted.push(o); }, result: (v: any) => { result = v; }, seed: () => 1, usage: () => {},
    python: async (script: string, args: string[]) => {
      const r = spawnSync(python!, [path.join('post', script), ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    },
  } as any);
  return { emitted, result };
}

test('trim, pixelate, outline and pixel-perfect scale; pad to power of two; WebP out', async (t) => {
  if (!pillow) return t.skip('no .venv with Pillow');
  // A 40x60 opaque block in the middle of a transparent 200x200 canvas.
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'transform-src-')), 'sprite.png');
  const made = spawnSync(python!, ['-c', `from PIL import Image\nim = Image.new('RGBA', (200, 200), (0, 0, 0, 0))\nim.paste((200, 60, 30, 255), (80, 70, 120, 130))\nim.save(${JSON.stringify(src)})`], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);

  const a = await transform(src, [{ op: 'trim' }, { op: 'pixelate', size: 30, colors: 8 }, { op: 'outline', width: 1 }, { op: 'scale', factor: 4, pixel: true }]);
  assert.deepEqual(a.result.steps.map((s: any) => s.size), [[40, 60], [20, 30], [22, 32], [88, 128]]);
  assert.equal(a.emitted[0].ext, '.png');

  const b = await transform(src, [{ op: 'trim' }, { op: 'flip', axis: 'h' }, { op: 'pot' }], 'webp');
  assert.deepEqual([b.result.width, b.result.height], [64, 64]);
  assert.equal(b.emitted[0].ext, '.webp');

  await assert.rejects(() => transform(src, [{ op: 'explode' }]));
});
