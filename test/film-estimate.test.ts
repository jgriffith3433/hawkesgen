// Pricing a film recipe before any GPU is touched: asset.make expands into its steps, the gate into its preview renders, and a
// 13-shot trailer comes out as GPU hours and dollars. A scratch data folder (no job history, so the tools' own guesses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-film-'));
const { estimate } = await import('../src/estimate.ts');
const { cinemaPass, dialogueCloseup, vfxLayers, characterLora } = await import('../src/film/recipes.ts');
const { buildRecipe } = await import('../src/tools/film.ts');

const shot: any = {
  speaker: 1,
  characters: [
    { file: 0, height: 1.8, position: [-1.5, 0], facing: 90, beats: [{ animation: 'Walk', to: [0.5, 0], seconds: 2 }, { animation: 'Idle', seconds: 3, lookAt: 1 }] },
    { file: 1, height: 1.7, position: [2.5, 0.5], facing: -90 },
  ],
};
const item = (r: any, label: string) => ({ tool: 'asset.make', label, count: 1, params: { steps: r.steps, candidates: r.candidates, pickAt: r.pickAt, pick: r.pick } });

test('a cinema pass is priced step by step: the gate as preview renders, the look three times, the video once', () => {
  const r = cinemaPass({ shot, look: 'x', motion: 'y', refs: [2] });
  const e = estimate('sandbox', [item(r, 'wide')]);
  const by = (suffix: string) => e.lines.find((l) => l.label.endsWith(suffix))!;
  assert.match(by('(gate)').label, /step 1/);
  assert.equal(by('(gate)').tool, 'blender.render');
  assert.equal(by('(gate)').count, 2, 'one look, and a second for about half the shots');
  assert.equal(by('step 2').tool, 'blender.render');
  assert.equal(by('step 4').tool, 'image.edit');
  assert.equal(by('step 4').count, 3, 'best of three');
  assert.equal(by('step 6').tool, 'video.control');
  assert.equal(by('step 6').gpuSeconds, 150);
  assert.ok(e.lines.some((l) => l.label === 'wide · pick'));
  assert.ok(e.gpu.work > 300 && e.gpu.families.includes('ltx-2.3') && e.gpu.families.includes('blender'));
});

test('every recipe prices without error, and the work of each adds up from its steps', () => {
  const recipes = {
    wide: cinemaPass({ shot, look: 'x', motion: 'y' }),
    wan: cinemaPass({ shot, look: 'x', motion: 'y', engine: 'wan' }),
    closeup: dialogueCloseup({ shot, speaker: 1, line: 'You lied to me.', voice: 'v', look: 'x' }),
    vfx: vfxLayers({ shot, base: '$input:3', fx: 0, look: 'x', motion: 'y' }),
    lora: characterLora({ name: 'a', caption: 'b' }),
  };
  for (const [name, r] of Object.entries(recipes)) {
    const e = estimate('sandbox', [item(r, name)]);
    assert.ok(e.gpu.work > 0, name);
    assert.equal(e.gpu.work, e.lines.reduce((s, l) => s + l.gpuSeconds, 0), name);
    assert.ok(e.cost.total >= 0 && Number.isFinite(e.cost.total), name);
  }
  // Wan is the slow way (about 7 minutes a shot against 2 or 3).
  assert.ok(estimate('sandbox', [item(recipes.wan, 'wan')]).gpu.work > estimate('sandbox', [item(recipes.wide, 'wide')]).gpu.work);
});

test('a 14-shot trailer: GPU hours and dollars to approve, from the plan alone', () => {
  const wide = cinemaPass({ shot, look: 'x', motion: 'y', refs: [2] });
  const close = dialogueCloseup({ shot, speaker: 1, line: 'You lied to me, and now we both pay for it.', voice: 'v', look: 'x', refs: [2] });
  const vfx = vfxLayers({ shot, base: '$input:3', fx: 0, look: 'x', motion: 'y' });
  const items = [
    ...Array.from({ length: 9 }, (_, i) => item(wide, `wide${i + 1}`)),
    ...Array.from({ length: 4 }, (_, i) => item(close, `closeup${i + 1}`)),
    item(vfx, 'vfx1'),
  ];
  const e = estimate('sandbox', items, { servers: 1 });
  assert.equal(e.lines.filter((l) => l.tool === 'video.control').length, 10, 'nine wides and one effect layer');
  assert.equal(e.lines.filter((l) => l.tool === 'video.talk').length, 4);
  // About 2 to 3 GPU hours: single digits of dollars, not hundreds.
  assert.ok(e.gpu.hours > 1.5 && e.gpu.hours < 4, `${e.gpu.hours} h`);
  assert.ok(e.cost.total > 2 && e.cost.total < 12, `$${e.cost.total}`);
  assert.ok(e.cost.withIdleTail > e.cost.total);
});

test('film.plan builds recipes by name; unknown names say what exists', () => {
  assert.equal(buildRecipe('cinema', { shot, look: 'x', motion: 'y' }).steps[0].tool, 'film.gate');
  assert.equal(buildRecipe('lora', { name: 'a', caption: 'b' }).steps[2].tool, 'lora.train');
  assert.throws(() => buildRecipe('trailer2', {}), /cinema, dialogue, vfx, lora, trailer/);
});

test('film.plan (the tool): a trailer plan has each shot\'s recipe and price, the cut, and the total', async () => {
  const { filmPlanTool } = await import('../src/tools/film.ts');
  let out: any;
  const ctx: any = { job: { project: 'sandbox' }, params: { recipe: 'trailer', estimate: true, options: {
    music: true,
    shots: [
      { id: 'w1', kind: 'wide', options: { shot, look: 'x', motion: 'y', seconds: 4 } },
      { id: 'c1', kind: 'closeup', options: { shot, speaker: 1, line: 'You lied to me.', voice: 'v', look: 'x', seconds: 2 } },
      { id: 'w2', kind: 'wide', options: { shot, look: 'x', motion: 'y', seconds: 3 } },
    ],
  } }, result: (v: unknown) => (out = v) };
  await filmPlanTool.run(ctx);
  assert.deepEqual(out.shots.map((s: any) => s.id), ['w1', 'c1', 'w2']);
  assert.ok(out.shots.every((s: any) => s.estimate.gpuSeconds > 0 && s.recipe.steps.length >= 4));
  assert.deepEqual(out.cut.inputs.clips, ['shot:w1', 'shot:c1', 'shot:w2']);
  assert.ok(out.cut.inputs.audio.includes('voice:c1') && out.cut.inputs.audio.includes('music:trailer'));
  assert.ok(out.estimate.gpu.hours > 0 && out.estimate.cost.total > 0);
  // One recipe, with the lint of its shot: a face hidden behind someone is reported before any render.
  const hidden = { speaker: 1, characters: [{ file: 0, position: [0, -1.5], height: 1.8, facing: 180 }, { file: 1, position: [0, 0], height: 1.8 }], camera: { target: 1, distance: 4, height: 1.6 } };
  await filmPlanTool.run({ job: { project: 'sandbox' }, params: { recipe: 'cinema', estimate: false, options: { shot: hidden, look: 'x', motion: 'y' } }, result: (v: unknown) => (out = v) } as any);
  assert.ok(out.lint.some((i: any) => i.check === 'occlusion' && i.level === 'error'));
  assert.equal(out.estimate, null);
  await assert.rejects(() => filmPlanTool.run({ job: { project: 'sandbox' }, params: { recipe: 'trailer', estimate: false, options: { shots: [{ id: 'a', kind: 'montage', options: {} }] } }, result: () => {} } as any), /wide, closeup or vfx/);
});

test('film.gate preview: four stills from a render job become one contact sheet, with where everyone stood', async (t) => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('no ffmpeg');
  const { previewRender } = await import('../src/tools/film.ts');
  const { putAsset } = await import('../src/library.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sheet-'));
  const outputs = ['red', 'green', 'blue', 'white'].map((c, i) => {
    const f = `${dir}/s${i}.png`;
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=64x36`, '-frames:v', '1', f]);
    const a = putAsset({ data: fs.readFileSync(f), ext: '.png', job: 'j_fake', client: 'test', project: 'sandbox', tool: 'blender.render', seed: null, recipe: { tool: 'blender.render', version: 2, params: { i, c }, inputs: {}, models: [], seed: null } as any });
    return { asset: a.id, title: `still ${i + 1}` };
  }).reverse(); // out of order on purpose
  const calls: any[] = [];
  const gen = {
    async submit(tool: string, opts: any) { calls.push({ tool, opts }); return { id: 'j_prev', status: 'done', outputs, result: { stills: [0, 0.33, 0.66, 1].map((t) => ({ t, characters: [{ index: 0, x: 0, y: 0, facing: 0 }] })), characters: [{ index: 0, segments: [{ animation: 'Walk', ground: 1.4, playback: 0.8, slide: 1 }] }] } }; },
    async wait() { throw new Error('the job was already done'); },
  };
  const steps: string[] = [];
  const r = await previewRender(gen, { job: { id: 'j_gate' }, step: (s) => steps.push(s), tmp: (n) => `${dir}/${n}`, signal: new AbortController().signal }, { shot, frames: 121, fps: 24, width: 640, height: 352, engine: 'eevee', files: ['/x/0.glb'] }, 0);
  assert.equal(calls[0].tool, 'blender.render');
  assert.deepEqual(calls[0].opts.params.stills, [0, 0.33, 0.66, 1]);
  assert.deepEqual(calls[0].opts.params.passes, []);
  assert.equal(calls[0].opts.reuse, true, 'a look the library already has is not rendered again');
  assert.equal(r.stills.length, 4);
  assert.equal(r.characters![0].segments![0].slide, 1);
  // 2 x 2 tiles of 64 x 36, in order: top-left is still 1 (red), bottom-right is still 4 (white).
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.sheet], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '128,72');
  const px = (x: number, y: number) => spawnSync('ffmpeg', ['-v', 'error', '-i', r.sheet, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  assert.ok(px(5, 5)[0] > 200 && px(5, 5)[1] < 60, 'top-left is red');
  assert.ok(px(120, 60)[0] > 200 && px(120, 60)[1] > 200, 'bottom-right is white');
  fs.rmSync(dir, { recursive: true, force: true });
});
