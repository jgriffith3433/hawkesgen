// Every workflow folder loads, its manifest points at real graph nodes, and its
// graph passes the node-definition check (with the cached /object_info).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflows, listWorkflows } from '../src/workflows/registry.ts';
import { checkGraph } from '../src/workflows/convert.ts';
import { DATA_DIR } from '../src/config.ts';

const infoFile = path.join(DATA_DIR, 'comfy-cache', 'object_info.json');

test('workflow folders load', () => {
  loadWorkflows();
  assert.ok(listWorkflows().length >= 10, `only ${listWorkflows().length} workflows loaded`);
});

test('workflow graphs match the server node definitions', { skip: !fs.existsSync(infoFile) && 'no cached object_info' }, () => {
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  loadWorkflows();
  for (const w of listWorkflows()) {
    const { problems } = checkGraph(w.graph, info);
    assert.deepEqual(problems, [], `${w.manifest.id}: ${problems.join('; ')}`);
    for (const mm of w.manifest.models) assert.match(mm.url, /^https:\/\//, `${w.manifest.id}: ${mm.file} has no download link`);
  }
});

test('an optional input left out leaves the graph: its load node goes, a guide in a chain is skipped', async () => {
  const { pruneMissing } = await import('../src/workflows/tool.ts');
  loadWorkflows();
  const wf = (id: string) => listWorkflows().find((w) => w.manifest.id === id)!;
  // video.scene without a second and third voice or a third character: their slots go, the rest stay.
  const scene = wf('video.scene');
  const g1 = structuredClone(scene.graph);
  for (const name of ['audio2', 'audio3', 'image3']) pruneMissing(g1, scene.manifest.inputs[name] as any);
  assert.equal(g1['152'], undefined);
  assert.deepEqual(Object.keys(g1['136'].inputs).filter((k) => k.startsWith('ref_audios.') || k.startsWith('ref_images.')).sort(), ['ref_audios.ref_audio_0', 'ref_images.ref_image_0', 'ref_images.ref_image_1', 'ref_images.ref_image_2']);
  // video.keyframes without frame2: the next guide takes the first guide's conditioning.
  const kf = wf('video.keyframes');
  const g2 = structuredClone(kf.graph);
  pruneMissing(g2, kf.manifest.inputs.frame2 as any);
  assert.equal(g2['162'], undefined);
  assert.equal(g2['159'], undefined);
  assert.deepEqual(g2['169'].inputs.positive, ['147', 0]);
  pruneMissing(g2, kf.manifest.inputs.frame3 as any);
  assert.deepEqual(g2['126'].inputs.conditioning, ['147', 0], 'the guider now reads the only guide left');
});

test("the critic's answer is kept in bounds: scores 1-10, notes inside the video, known asks, a best take in range", async () => {
  const { settle } = await import('../src/tools/review-video.ts');
  const s = settle({ pass: true, score: 12, summary: 'ok', scores: { story: 0, pacing: 7 }, notes: [{ at: 2, to: 5, ask: 'lipsync', note: 'mouth late' }, { at: 125, ask: 'cut', note: 'past the end' }, { at: 80, to: 99, ask: 'nope', note: 'runs over' }], best: 7 }, 3, 8, 90.8);
  assert.equal(s.score, 10);
  assert.equal(s.scores.story, 1);
  assert.deepEqual(s.notes.map((n: any) => [n.at, n.to, n.ask]), [[2, 5, 'lipsync'], [80, 90.8, 'redo']]);
  assert.equal(s.best, 0);
});
