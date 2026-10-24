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

test('a widget typed "FLOAT,INT" keeps its place (LTX-2.3 audio latent batch_size stays 1)', () => {
  const src = JSON.parse(fs.readFileSync(path.join('workflows', 'video-control', 'source.json'), 'utf8'));
  const oi = have ? info : { LTXVEmptyLatentAudio: null };
  if (!oi.LTXVEmptyLatentAudio) return;
  const n = find(convertUiWorkflow(src, oi).graph, 'LTXVEmptyLatentAudio');
  assert.equal(n.inputs.batch_size, 1);
  assert.equal(find(JSON.parse(fs.readFileSync(path.join('workflows', 'video-control', 'graph.json'), 'utf8')), 'LTXVEmptyLatentAudio').inputs.batch_size, 1);
});

test('widgets with no socket keep their saved values (ImageCropV2 crop_region, ImageCropToMask background)', () => {
  // Dropping them made ComfyUI crop the default top-left 512x512 for all four views of mesh.views3d (2026-10-23).
  const oi = {
    LoadImage: { input: { required: { image: [['a.png'], { image_upload: true }] } }, input_order: { required: ['image'] }, output: ['IMAGE', 'MASK'] },
    ImageCropV2: { input: { required: { image: ['IMAGE', {}], crop_region: ['BOUNDING_BOX', { default: { x: 0, y: 0, width: 512, height: 512 }, socketless: true }] } }, input_order: { required: ['image', 'crop_region'] }, output: ['IMAGE'] },
    ImageCropToMask: {
      input: { required: { images: ['IMAGE', {}], masks: ['MASK', {}], width: ['INT', { default: 1024 }], height: ['INT', { default: 1024 }], pad_factor: ['FLOAT', { default: 1 }], grow_mask: ['INT', { default: 0 }], background: ['COLOR', { default: '#000000', socketless: true }] } },
      input_order: { required: ['images', 'masks', 'width', 'height', 'pad_factor', 'grow_mask', 'background'] }, output: ['IMAGE'],
    },
    SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', { default: 'x' }] } }, input_order: { required: ['images', 'filename_prefix'] }, output: [], output_node: true },
  };
  const wf = {
    nodes: [
      { id: 1, type: 'LoadImage', widgets_values: ['sheet.png', 'image'], outputs: [{ type: 'IMAGE' }, { type: 'MASK' }] },
      { id: 2, type: 'ImageCropV2', inputs: [{ name: 'image', link: 1 }], widgets_values: [{ x: 1652, y: 0, width: 1492, height: 2688 }, 0, 0, 512, 512] },
      { id: 3, type: 'ImageCropToMask', inputs: [{ name: 'images', link: 2 }, { name: 'masks', link: 3 }], widgets_values: [768, 640, 1.1, 2, '#ffffff'] },
      { id: 4, type: 'SaveImage', inputs: [{ name: 'images', link: 4 }], widgets_values: ['out'] },
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 2, 0, 3, 0, 'IMAGE'], [3, 1, 1, 3, 1, 'MASK'], [4, 3, 0, 4, 0, 'IMAGE']],
  };
  const g = convertUiWorkflow(wf, oi).graph;
  assert.deepEqual(g['2'].inputs.crop_region, { x: 1652, y: 0, width: 1492, height: 2688 });
  assert.deepEqual(g['3'].inputs, { images: ['2', 0], masks: ['1', 1], width: 768, height: 640, pad_factor: 1.1, grow_mask: 2, background: '#ffffff' });
  assert.deepEqual(checkGraph(g, oi).problems, []);
});

test('the Pixal3D multi-view template keeps its four different crops', { skip: !have && 'no template cache' }, () => {
  const g = convert('3d_pixal3d_multi_views').graph;
  const crops = Object.values<any>(g).filter((n) => n.class_type === 'ImageCropV2').map((n) => n.inputs.crop_region?.x);
  assert.deepEqual(crops.sort((a, b) => a - b), [0, 1652, 3182, 4728]);
});
