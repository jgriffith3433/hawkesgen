// Gaussian Splatting pipeline: splat.build tool, 32-byte .splat binary format, preview PNG, and PH Origins splat kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-splat-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { getProjectPresets, applyPreset } = await import('../src/presets.ts');
const { mimeOf, kindOf } = await import('../src/util.ts');
const { putAsset } = await import('../src/library.ts');
const L = await import('../src/entities.ts');

const python = [
  path.join('.venv', 'Scripts', 'python.exe'),
  path.join('.venv', 'bin', 'python'),
  '/srv/hawkes/hawkesgen/.venv/bin/python',
].find((p) => fs.existsSync(p));

function makeTestPng(file: string, w = 64, h = 64) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const rows = Buffer.concat(
    Array.from({ length: h }, (_, y) =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.from(
          Array.from({ length: w * 3 }, (_, i) =>
            (i % 3 === 0 ? y * 4 : i % 3 === 1 ? Math.floor(i / 3) * 4 : 140) & 255,
          ),
        ),
      ]),
    ),
  );
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

test('splat.build is registered with valid params and .splat MIME type', () => {
  const tool = getTool('splat.build');
  assert.ok(tool, 'splat.build is registered');
  assert.equal(tool!.provider, 'local');
  assert.equal(tool!.output, 'mesh');
  assert.equal(tool!.params.maxSplats.default, 180000);
  assert.equal(tool!.params.maxSplats.max, 500000);
  assert.deepEqual(tool!.params.presetScene.values, ['auto', 'subway-tunnel', 'subway-station', 'subway-car-full']);

  const validated = validateParams(tool!, { presetScene: 'subway-car-full', maxSplats: 120000 });
  assert.equal(validated.presetScene, 'subway-car-full');
  assert.equal(validated.maxSplats, 120000);
  assert.throws(() => validateParams(tool!, { maxSplats: 900000 }), /maxSplats must be between/);

  assert.equal(mimeOf('scene.splat'), 'application/x-gaussian-splat');
  assert.equal(kindOf(mimeOf('scene.splat')), 'mesh');
});

test('phorigins preset and splat entity kind wire reference and splat slots', () => {
  const pp = getProjectPresets('phorigins')!;
  assert.ok(pp.presets.splat, 'phorigins has splat preset');
  assert.equal(pp.presets.splat.tool, 'splat.build');

  const applied = applyPreset({ project: 'phorigins', preset: 'splat' }, (id) => getTool(id)?.params ?? null);
  assert.equal(applied.tool, 'splat.build');
  assert.equal(applied.params.presetScene, 'subway-car-full');
  assert.equal(applied.params.maxSplats, 180000);

  const kind = pp.kinds?.splat;
  assert.ok(kind, 'phorigins has splat kind');
  assert.ok(kind.slots.reference?.make, 'reference slot has make recipe');
  assert.equal(kind.slots.reference.make.tool, 'image.generate');
  assert.ok(kind.slots.splat?.make, 'splat slot has make recipe');
  assert.equal(kind.slots.splat.make.tool, 'splat.build');

  const owner = { id: 'test', name: 'J', role: 'owner', projects: ['*'] } as any;
  const e = L.createEntity(owner, {
    project: 'phorigins',
    name: 'Level 7 Train Splat',
    kind: 'splat',
    data: { look: 'uptown 6 subway car and station stop' },
  });
  const spec: any = L.slotJobSpec(owner, { entity: e.id, slot: 'splat' });
  assert.equal(spec.tool, 'splat.build');
  assert.deepEqual(spec.labels.slots, { splat: 'splat', preview: 'preview' });

  const splatAsset = putAsset({
    data: Buffer.alloc(32 * 10),
    ext: '.splat',
    client: 'test',
    project: 'phorigins',
    tool: 'splat.build',
    recipe: { tool: 'splat.build', version: 1, params: {}, inputs: {} } as any,
  });
  const previewAsset = putAsset({
    data: Buffer.from('png'),
    ext: '.png',
    client: 'test',
    project: 'phorigins',
    tool: 'splat.build',
    recipe: { tool: 'splat.build', version: 1, params: {}, inputs: {} } as any,
  });
  const filed = L.fileJobOutputs({
    id: 'j_splat',
    status: 'done',
    labels: spec.labels,
    outputs: [
      { asset: splatAsset.id, title: 'splat' },
      { asset: previewAsset.id, title: 'preview' },
    ],
  });
  assert.deepEqual(filed.map((v: any) => v.slot).sort(), ['preview', 'splat']);
});

test('splat.py builds valid 32-byte-per-splat .splat binary and preview PNG for preset scenes and image lift', { skip: !python && 'no .venv' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-run-'));
  try {
    for (const scene of ['subway-tunnel', 'subway-station', 'subway-car-full'] as const) {
      const outSplat = path.join(dir, `${scene}.splat`);
      const outPreview = path.join(dir, `${scene}.png`);
      const r = spawnSync(
        python!,
        [
          path.join('post', 'splat.py'),
          '--out-splat', outSplat,
          '--out-preview', outPreview,
          '--preset-scene', scene,
          '--max-splats', '4096',
          '--density', '0.25',
          '--seed', '7',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 0, r.stderr);
      const info = JSON.parse(r.stdout.trim().split('\n').pop()!);
      assert.equal(info.bytesPerSplat, 32);
      assert.ok(info.splats > 0 && info.splats <= 4096, `splats count ${info.splats}`);

      const buf = fs.readFileSync(outSplat);
      assert.equal(buf.length, info.splats * 32);
      assert.equal(buf.length % 32, 0);

      // Verify float32 positions and scales are finite and positive, and quaternions are normalized around 128
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < Math.min(50, info.splats); i++) {
        const off = i * 32;
        const x = dv.getFloat32(off + 0, true);
        const y = dv.getFloat32(off + 4, true);
        const z = dv.getFloat32(off + 8, true);
        const sx = dv.getFloat32(off + 12, true);
        const sy = dv.getFloat32(off + 16, true);
        const sz = dv.getFloat32(off + 20, true);
        assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'finite position');
        assert.ok(sx > 0 && sy > 0 && sz > 0 && sx < 10 && sy < 10 && sz < 10, `valid scales ${sx},${sy},${sz}`);
        const qw = ( buf[off + 28] - 128 ) / 128;
        const qx = ( buf[off + 29] - 128 ) / 128;
        const qy = ( buf[off + 30] - 128 ) / 128;
        const qz = ( buf[off + 31] - 128 ) / 128;
        const qLen = Math.hypot(qw, qx, qy, qz);
        assert.ok(Math.abs(qLen - 1.0) < 0.05, `unit quaternion ${qLen}`);
      }

      if (scene === 'subway-car-full') {
        assert.ok(info.bounds.min[0] <= 0.1 && info.bounds.max[0] >= 17.9, `car x bounds ${info.bounds.min[0]}..${info.bounds.max[0]}`);
        assert.ok(info.bounds.max[2] >= 6.0, `north station platform z bound ${info.bounds.max[2]}`);
      }

      const pngBuf = fs.readFileSync(outPreview);
      assert.ok(pngBuf.length > 1000, 'preview PNG written');
      assert.deepEqual([...pngBuf.subarray(0, 4)], [137, 80, 78, 71]);
    }

    // Test image + depth lift through splatBuildTool.run()
    const inImg = path.join(dir, 'input.png');
    const inDepth = path.join(dir, 'depth.png');
    makeTestPng(inImg, 64, 32);
    makeTestPng(inDepth, 64, 32);

    const emitted: any[] = [];
    let toolResult: any = null;
    const tool = getTool('splat.build')!;
    await tool.run({
      job: { id: 'j_test', client: 'test', project: 'phorigins', tool: 'splat.build', labels: {} },
      params: validateParams(tool, { presetScene: 'auto', maxSplats: 1500, mode: 'panorama' }),
      inputs: { image: inImg, depth: inDepth },
      done: 0,
      outputs: [],
      signal: new AbortController().signal,
      step: () => {},
      log: () => {},
      tmp: (name: string) => path.join(dir, name),
      emit: async (o) => { emitted.push(o); },
      result: (v) => { toolResult = v; },
      seed: () => 123,
      usage: () => {},
      python: async (script, args) => {
        const res = spawnSync(python!, [path.join('post', script), ...args], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
        return res.stdout;
      },
    });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].ext, '.splat');
    assert.equal(emitted[0].title, 'splat');
    assert.equal(emitted[0].data.length % 32, 0);
    assert.ok(emitted[0].data.length <= 1500 * 32);
    assert.equal(emitted[1].ext, '.png');
    assert.equal(emitted[1].title, 'preview');
    assert.equal(toolResult.bytesPerSplat, 32);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
