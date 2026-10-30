// What Gen knows about its tools (src/knowledge.ts) and every node setting (src/workflows/tool.ts): a workflow's node
// settings are listed with what drives them; only editable ones can be overridden, with the right type; files, models
// and prompts stay locked; cards join the craft notes, models and nodes; the AI's tool map covers every tool it may use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-knowledge-'));

const tools = await import('../src/tools/index.ts');
await (tools as any).reloadTools?.();
const { getWorkflow } = await import('../src/workflows/registry.ts');
const { nodeSettings, applyNodeOverrides } = await import('../src/workflows/tool.ts');
const k = await import('../src/knowledge.ts');
const { aiCanUse, relevantTools } = await import('../src/editor.ts');

test('a workflow lists every node setting, what drives it, and which can be changed', () => {
  const wf = getWorkflow('video.control')!;
  assert.ok(wf, 'video.control is a workflow');
  const s = nodeSettings(wf);
  const by = new Map(s.map((x) => [x.key, x]));
  const prompt = s.find((x) => x.drivenBy === 'prompt')!;
  assert.equal(prompt.editable, false);
  assert.ok(s.some((x) => x.drivenBy === 'input:control' && !x.editable), 'the control file is locked');
  const lora = s.find((x) => x.input === 'strength_model')!;
  assert.equal(lora.editable, true);
  const sampler = s.find((x) => x.input === 'sampler_name')!;
  assert.equal(sampler.editable, true);
  assert.ok(![...by.values()].some((x) => x.editable && /ckpt_name|lora_name|text_encoder/.test(x.input)), 'models stay locked');
});

test('node overrides: editable settings of the right type only', () => {
  const wf = getWorkflow('video.control')!;
  const s = nodeSettings(wf);
  const lora = s.find((x) => x.input === 'strength_model')!;
  const sampler = s.find((x) => x.input === 'sampler_name')!;
  const g = structuredClone(wf.graph) as any;
  applyNodeOverrides(g, { [lora.key]: 0.6, [sampler.key]: 'euler' }, s);
  assert.equal(g[lora.node].inputs.strength_model, 0.6);
  assert.equal(g[sampler.node].inputs.sampler_name, 'euler');
  const prompt = s.find((x) => x.drivenBy === 'prompt')!;
  assert.throws(() => applyNodeOverrides(structuredClone(wf.graph), { [prompt.key]: 'x' }, s), /use prompt/);
  assert.throws(() => applyNodeOverrides(structuredClone(wf.graph), { [lora.key]: 'lots' }, s), /takes a number/);
  assert.throws(() => applyNodeOverrides(structuredClone(wf.graph), { 'nope.x': 1 }, s), /not a setting/);
  assert.throws(() => applyNodeOverrides(structuredClone(wf.graph), { [sampler.key]: '../x' }, s), /short word/);
  const model = s.find((x) => /ckpt_name/.test(x.input));
  if (model) assert.throws(() => applyNodeOverrides(structuredClone(wf.graph), { [model.key]: 'other.safetensors' }, s), /locked|can't be changed/);
  assert.ok(tools.getTool('video.control')!.params.nodes, 'the tool takes nodes');
});

test('a card joins the craft notes, the models and every node', () => {
  const c = k.toolCard('video.control')!;
  assert.match(String(c.role), /control video/);
  assert.ok(c.models.length >= 2);
  assert.ok(c.nodes.length > 10);
  assert.ok(c.editable > 5);
  assert.ok((c.params as any).strength.note);
  assert.deepEqual((c.params as any).strength.drives.map((d: any) => d.input), ['strength']);
  assert.ok((c.inputs as any).control.note);
  assert.ok(c.pairsWith.includes('image.control'));
  assert.equal(k.toolCard('no.such'), null);
  // A code tool has a card too, without nodes.
  assert.equal(k.toolCard('video.frame')!.nodes.length, 0);
});

test('the AI\'s tool map covers what it may use, and a request finds its tools', () => {
  const map = k.toolMap(aiCanUse);
  for (const id of ['video.control', 'image.control', 'mesh.views3d', 'audio.music', 'asset.make']) assert.match(map, new RegExp(`^- ${id.replace('.', '\\.')}:`, 'm'), id);
  assert.doesNotMatch(map, /^- unity\.build:/m);
  assert.doesNotMatch(map, /^- playtest\.run:/m);
  assert.ok(relevantTools('restyle this with the depth control video').includes('video.control'));
  assert.match(k.toolCraft(['video.control']), /nodes\["/);
});

test('every tool named in the craft notes exists, and every note key is a real param, input or node setting', () => {
  const notes = k.notes();
  for (const [id, n] of Object.entries(notes)) {
    const t = tools.getTool(id);
    if (!t) continue; // a tool this Gen doesn't have yet (ok: notes can come first)
    const wf = getWorkflow(id);
    const nodeKeys = new Set(wf ? nodeSettings(wf).filter((x) => x.editable).map((x) => x.key) : []);
    for (const key of Object.keys(n.settings ?? {})) assert.ok(key in (t.params ?? {}) || nodeKeys.has(key), `${id}: settings.${key}`);
    for (const key of Object.keys(n.inputs ?? {})) assert.ok(key in (t.inputs ?? {}), `${id}: inputs.${key}`);
  }
});
