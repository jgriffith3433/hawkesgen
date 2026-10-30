// The open audio tools on a GPU provider (RunPod, Modal): no SSH, one request to the worker (server/cloudrun/worker.py)
// with `{ hawkes_audio: spec }` in place of a graph for the voices, and the Stable Audio 3 workflow for sound effects.
// A fake ctx.comfy (what cloudComfyRun gives a job elsewhere) stands in for the worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-audio-remote-'));
delete process.env.HAWKESGEN_AUDIO_MOCK;

const { synthesize, stableAudio } = await import('../src/tools/audio-open.ts');
const { modelById } = await import('../src/audio/registry.ts');
const { loadWorkflows } = await import('../src/workflows/registry.ts');
loadWorkflows();

function fake(answer: (graph: any) => { filename: string; data: Buffer }[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ctx-'));
  const graphs: any[] = [];
  const uploads: string[] = [];
  const models: any[] = [];
  const files = new Map<string, Buffer>();
  const comfy = {
    server: { id: 'cloudrun:runpod', region: 'gcp', price: 1 },
    upload: async (f: string) => { uploads.push(f); return `hawkesgen/${path.basename(f)}`; },
    uploadBuffer: async () => 'x',
    runGraph: async (g: any) => {
      graphs.push(g);
      return answer(g).map((f, i) => { const uri = `gs://b/run/${graphs.length}-${i}-${f.filename}`; files.set(uri, f.data); return { filename: f.filename, subfolder: '', type: 'output', uri }; });
    },
    download: async (f: any) => files.get(f.uri)!,
    ensureModels: async (m: any[]) => { models.push(...m); },
    timed: <T>(w: () => Promise<T>) => w(),
  };
  const steps: string[] = [];
  const ctx: any = {
    job: { id: 'j_remote', client: 'c', project: 'p', tool: 'x', labels: {} }, params: {}, inputs: {}, done: 0, outputs: [],
    signal: new AbortController().signal, step: (s: string) => steps.push(s), log() {}, tmp: (n: string) => path.join(dir, n),
    emit: async () => {}, result() {}, seed: (i: number) => 100 + i, usage() {}, comfy,
  };
  return { ctx, graphs, uploads, models, steps };
}

test('voices on a GPU provider: one hawkes_audio request with the spec, the reference uploaded, the takes and transcripts back', async () => {
  const ref = path.join(os.tmpdir(), `ref-${process.pid}.wav`);
  fs.writeFileSync(ref, 'RIFF');
  const f = fake((g) => {
    const items = g.hawkes_audio.items;
    return [
      { filename: 'result.json', data: Buffer.from(JSON.stringify({ model: g.hawkes_audio.model, items: items.map((it: any) => ({ id: it.id, seconds: 1.5 })) })) },
      ...items.map((it: any) => ({ filename: `${it.id}.wav`, data: Buffer.from('wav') })),
      ...items.map((it: any) => ({ filename: `${it.id}.asr.json`, data: Buffer.from(JSON.stringify({ text: 'hello there' })) })),
    ];
  });
  const s = await synthesize(f.ctx, { model: modelById('qwen3-tts')!, task: 'speak', items: [{ id: 'take0', text: 'Hello there.', refFile: ref, refText: 'la', seed: 5, language: 'en' }], asr: true, language: 'en' });
  assert.equal(f.graphs.length, 1);
  const spec = f.graphs[0].hawkes_audio;
  assert.equal(spec.model, 'qwen3-tts');
  assert.equal(spec.task, 'speak');
  assert.equal(spec.asr, true);
  assert.equal(spec.items[0].ref, `hawkesgen/${path.basename(ref)}`, 'the reference rides along as an input the worker fetches');
  assert.equal(spec.items[0].ref_text, 'la');
  assert.deepEqual(f.uploads, [ref]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].transcript, 'hello there');
  assert.ok(fs.existsSync(s.items[0].file));
});

test('sound effects: the Stable Audio 3 workflow, one graph per take, its models from the manifest', async () => {
  const f = fake(() => [{ filename: 'hawkesgen_sfx_00001_.flac', data: Buffer.from('fLaC') }]);
  const s = await stableAudio(f.ctx, modelById('stable-audio-3')!, [{ id: 'take0', text: 'door creak', seconds: 3, seed: 9 }, { id: 'take1', text: 'door slam', seed: 10 }]);
  assert.equal(f.graphs.length, 2);
  assert.equal(f.graphs[0]['3'].inputs.text, 'door creak');
  assert.equal(f.graphs[0]['5'].inputs.seconds, 3);
  assert.equal(f.graphs[0]['6'].inputs.seed, 9);
  assert.equal(f.graphs[1]['5'].inputs.seconds, 5, 'no duration: five seconds');
  assert.deepEqual(f.models.map((m) => m.file).sort(), ['stable_audio_3_medium.safetensors', 't5gemma_b_b_ul2.safetensors']);
  assert.ok(s.items.every((it) => it.file.endsWith('.flac') && fs.existsSync(it.file)));
});

test('a worker image without the voice models (ComfyUI refuses hawkes_audio) makes the job try the next provider', async () => {
  const f = fake(() => { throw new Error('modal: ComfyUI rejected the workflow: {"error": {"type": "missing_node_type", "message": "Node \'ID #hawkes_audio\' has no class_type."}}'); });
  await assert.rejects(
    synthesize(f.ctx, { model: modelById('qwen3-tts')!, task: 'speak', items: [{ id: 'take0', text: 'Hi.', seed: 1, language: 'en' }] }),
    (e: any) => e.unavailable === true && /without the voice models/.test(e.message),
  );
});

test('a transcriber that fails leaves the take unchecked (verifySkipped says why), not wrong', async () => {
  const f = fake((g) => [
    { filename: 'result.json', data: Buffer.from(JSON.stringify({ items: [{ id: 'take0', seconds: 1 }] })) },
    { filename: 'take0.wav', data: Buffer.from('wav') },
    { filename: 'take0.asr.json', data: Buffer.from(JSON.stringify({ text: '', error: 'exit 1: ImportError: libcudnn' })) },
  ]);
  const s = await synthesize(f.ctx, { model: modelById('qwen3-tts')!, task: 'speak', items: [{ id: 'take0', text: 'Hi.', seed: 1, language: 'en' }], asr: true });
  assert.equal(s.items[0].transcript, undefined);
  assert.match(s.verifySkipped!, /transcriber failed.*libcudnn/);
});
