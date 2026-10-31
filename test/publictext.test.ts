// Customers never read what Gen is made of (J, 2026-10-30): src/publictext.ts on every job a customer sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { publicText, publicJob } = await import('../src/publictext.ts');

test('the lines customers saw, in plain words', () => {
  const cases: [string, string][] = [
    ['runpod: [Errno 28] No space left on device', 'the server ran out of room'],
    ['modal: waiting for a free modal GPU', 'waiting for a free the server GPU'],
    ['Bad params for audio.voice: direction must be JSON', 'Bad params for a step: direction must be JSON'],
    ['speaking with qwen3-tts on gen-gpu-l4', 'speaking with the model on the server'],
    ['ComfyUI rejected the workflow', 'the server rejected the workflow'],
    ['Wan 2.2 Fun Control: 16 fps', 'the model: 16 fps'],
  ];
  for (const [raw] of cases) {
    const out = publicText(raw);
    assert.doesNotMatch(out, /runpod|modal|comfy|qwen|wan 2|audio\.voice|gen-gpu|errno/i, `${raw} -> ${out}`);
  }
  assert.equal(publicText('runpod: [Errno 28] No space left on device'), 'the server ran out of room');
  assert.equal(publicText('Text to video: take 1 of 1'), 'Text to video: take 1 of 1', 'plain lines stay as they are');
});

test("a customer's job: steps, errors and logs in plain words, no server, graphs or GPU route; the owner sees it all", () => {
  const j = { id: 'j_1', tool: 'audio.voice', detail: 'modal: waiting for a free modal GPU', error: 'runpod: [Errno 28] No space left on device', log: ['speaking with qwen3-tts on gen-gpu-l4'], server: 'cloudrun:gen-gpu-l4', graphs: ['g1.json'], labels: { gpuTried: ['runpod'], gpuBackend: 'modal', scene: 'sc_1' } };
  const c = publicJob(j, true) as any;
  assert.equal(c.tool, 'audio.voice', "the tool's id stays: it's the API's own name for it");
  assert.doesNotMatch(JSON.stringify({ d: c.detail, e: c.error, l: c.log, s: c.server, g: c.graphs, lb: c.labels }), /runpod|modal|qwen|gen-gpu|cloudrun/i);
  assert.deepEqual(c.labels, { scene: 'sc_1' });
  assert.deepEqual(c.graphs, []);
  assert.equal(publicJob(j, false), j, 'the owner, admins and Studio: unchanged');
});
