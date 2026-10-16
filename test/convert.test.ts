// The UI -> API converter on real ComfyUI templates (cached from a server):
// promoted subgraph widgets, dynamic (dotted) inputs, real primitive nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convertUiWorkflow, checkGraph } from '../src/workflows/convert.ts';
import { DATA_DIR } from '../src/config.ts';

const cache = path.join(DATA_DIR, 'comfy-cache');
const have = fs.existsSync(path.join(cache, 'object_info.json')) && fs.existsSync(path.join(cache, 'templates'));
const info = have ? JSON.parse(fs.readFileSync(path.join(cache, 'object_info.json'), 'utf8')) : {};
const convert = (name: string) => convertUiWorkflow(JSON.parse(fs.readFileSync(path.join(cache, 'templates', `${name}.json`), 'utf8')), info);
const find = (g: any, type: string) => Object.values<any>(g).find((n) => n.class_type === type);

test('promoted widget values on a subgraph instance win (Marigold normals)', { skip: !have && 'no template cache' }, () => {
  assert.equal(find(convert('image_marigold_v2_surface_normal_estimation').graph, 'MarigoldV2PostProcess').inputs.prediction, 'normals');
  assert.equal(find(convert('image_marigold_v2_albedo_estimation').graph, 'MarigoldV2PostProcess').inputs.prediction, 'albedo');
});

test('link-only subgraph inputs are not mistaken for widgets (SAM 3)', { skip: !have && 'no template cache' }, () => {
  const sam = find(convert('utility_image_segment_sam3').graph, 'SAM3_Detect');
  assert.equal(sam.inputs.threshold, 0.5);
  assert.equal(sam.inputs.refine_iterations, 2);
  assert.equal(sam.inputs.positive_coords, undefined);
});

test('real primitive nodes are kept (ACE-Step seed)', { skip: !have && 'no template cache' }, () => {
  const g = convert('audio_ace_step1_5_xl_turbo').graph;
  const seedRef = find(g, 'KSampler').inputs.seed;
  assert.ok(Array.isArray(seedRef) && g[seedRef[0]]?.class_type === 'PrimitiveInt');
});

test('dynamic inputs come out dotted (SaveVideo format.codec)', { skip: !have && 'no template cache' }, () => {
  const save = find(convert('video_wan2_2_14B_t2v').graph, 'SaveVideo');
  assert.ok('format' in save.inputs && 'format.codec' in save.inputs);
});

test('at least 230 templates convert and check cleanly', { skip: !have && 'no template cache' }, () => {
  let ok = 0;
  for (const f of fs.readdirSync(path.join(cache, 'templates'))) {
    const r = convertUiWorkflow(JSON.parse(fs.readFileSync(path.join(cache, 'templates', f), 'utf8')), info);
    if (!r.problems.length && !checkGraph(r.graph, info).problems.length) ok++;
  }
  assert.ok(ok >= 230, `only ${ok} converted cleanly`);
});
