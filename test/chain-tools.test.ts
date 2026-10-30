// video.change and audio.revoice chain other tools as child jobs. The plans (which tools, which params) are pure; the
// runs here use a fake Gen whose children "finish" at once with files made by ffmpeg, so the parent's own work (the
// first frame, putting the original sound back, fitting the new voice's timing, the mux) runs for real. No GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-chain-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { putAsset } = await import('../src/library.ts');
const { probe } = await import('../src/tools/media.ts');
const { analyze } = await import('../src/audio/post.ts');
const c = await import('../src/tools/chain.ts');

const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-src-'));
const ff = (...args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

const info = (o: { w?: number; h?: number; rate?: string; dur?: string; audio?: boolean; rotation?: number } = {}) => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: o.w ?? 1920, height: o.h ?? 1080, r_frame_rate: o.rate ?? '30/1', avg_frame_rate: o.rate ?? '30/1', ...(o.rotation ? { side_data_list: [{ rotation: o.rotation }] } : {}) },
    ...(o.audio === false ? [] : [{ codec_type: 'audio', codec_name: 'aac' }]),
  ],
  format: { format_name: 'mov,mp4', duration: o.dur ?? '6.5' },
});

test('controlSize: the clip\'s shape, long side 1280, multiples of 32', () => {
  assert.deepEqual(c.controlSize(1920, 1080), { width: 1280, height: 736 });
  assert.deepEqual(c.controlSize(1080, 1920), { width: 736, height: 1280 });
  assert.deepEqual(c.controlSize(640, 640), { width: 1280, height: 1280 });
});

test('videoChangePlan: a mask means image.repaint, none means image.edit; then video.control over the original', () => {
  const p = validateParams(getTool('video.change')!, { prompt: 'make the car red' });
  const masked = c.videoChangePlan(info(), p, true);
  assert.equal(masked.edit.tool, 'image.repaint');
  assert.deepEqual(masked.edit.inputs, { image: '$frame', mask: '$mask' });
  assert.equal(masked.edit.params.prompt, 'make the car red');
  assert.equal(masked.control.tool, 'video.control');
  assert.deepEqual(masked.control.inputs, { control: '$video', image: '$edited' });
  assert.equal(masked.control.params.estimateDepth, true, 'plain footage: depth read from it');
  assert.equal(masked.control.params.width, 1280);
  assert.equal(masked.control.params.height, 736);
  assert.equal(masked.control.params.fps, 30);
  assert.equal(masked.control.params.seconds, 6.5);
  assert.match(String(masked.control.params.prompt), /same motion.*make the car red/);
  assert.equal(masked.hasSound, true);
  const whole = c.videoChangePlan(info({ rotation: 90, dur: '40', rate: '24000/1001', audio: false }), { ...p, seed: 7 }, false);
  assert.equal(whole.edit.tool, 'image.edit');
  assert.deepEqual(whole.edit.inputs, { images: ['$frame'] });
  assert.equal(whole.edit.params.seed, 7);
  assert.equal(whole.control.params.seed, 7);
  assert.equal(whole.control.params.width, 736, 'portrait after rotation');
  assert.equal(whole.control.params.seconds, 20, 'at most 20 s');
  assert.equal(whole.control.params.fps, 24);
  assert.equal(whole.hasSound, false);
  // Every param the plan sets is one the child tool has (else validateParams would refuse it at submit).
  for (const s of [masked.edit, masked.control, whole.edit]) {
    const t = getTool(s.tool)!;
    for (const k of Object.keys(s.params)) assert.ok(k in t.params, `${s.tool} has ${k}`);
    for (const k of Object.keys(s.inputs)) assert.ok(k in t.inputs, `${s.tool} has input ${k}`);
  }
});

test('fitTempo: speeds up or slows down at most 25%, the rest is silence or run-on', () => {
  assert.deepEqual(c.fitTempo(2.2, 2), { tempo: 1.1, seconds: 2, clamped: false });
  assert.deepEqual(c.fitTempo(1.8, 2), { tempo: 0.9, seconds: 2, clamped: false });
  const fast = c.fitTempo(4, 2);
  assert.equal(fast.tempo, 1.25);
  assert.equal(fast.seconds, 3.2);
  assert.equal(fast.clamped, true);
  assert.equal(c.fitTempo(1, 2).tempo, 0.8);
  assert.equal(c.fitTempo(0, 2).tempo, 1);
  assert.equal(c.fitFilter({ tempo: 1.1 }, 0.5, 3), 'atempo=1.1,adelay=500:all=1,apad=whole_dur=3');
  assert.equal(c.fitFilter({ tempo: 1 }, 0, null), 'anull');
});

test('audio.revoice refuses a call without a voice, with an ElevenLabs id, or without a clip', () => {
  const t = getTool('audio.revoice')!;
  assert.throws(() => t.guard!({ params: validateParams(t, {}), inputs: { audio: 'a' } }), /Describe the new voice/);
  assert.throws(() => t.guard!({ params: validateParams(t, { voice: '21m00Tcm4TlvDq8ikWAM' }), inputs: { audio: 'a' } }), /Gen voice id/);
  assert.throws(() => t.guard!({ params: validateParams(t, { description: 'a calm man' }), inputs: {} }), /audio or a video/);
  t.guard!({ params: validateParams(t, { description: 'a calm man' }), inputs: { video: 'v' } });
});

/** A fake Gen: each child is "done" at once, its output made by make(tool, spec). */
function fakeGen(make: (tool: string, spec: any) => { file?: string; ext?: string; result?: unknown }) {
  const calls: { tool: string; spec: any }[] = [];
  c._setChainClient(() => ({
    submit: async (tool: string, spec: any) => {
      calls.push({ tool, spec });
      const m = make(tool, spec);
      const outputs = m.file ? [(() => {
        const a = putAsset({ data: fs.readFileSync(m.file), ext: m.ext ?? path.extname(m.file), client: 'gen', project: 'usr_test', tool, recipe: { tool, version: 1, params: {}, inputs: {} } as any });
        return { asset: a.id, kind: a.kind };
      })()] : [];
      return { id: `j_${calls.length}`, tool, status: 'done', outputs, result: m.result ?? null };
    },
    wait: async () => { throw new Error('children finish at once here'); },
  }));
  return calls;
}

async function runTool(id: string, params: Record<string, unknown>, inputs: Record<string, unknown>) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-'));
  const tool = getTool(id)!;
  const emitted: any[] = [];
  let result: any = null;
  await tool.run({
    job: { id: 'j_parent', client: 't', project: 'usr_test', tool: id, labels: {} }, params: validateParams(tool, params), inputs,
    done: 0, outputs: [], signal: new AbortController().signal, step: () => {}, log: () => {}, tmp: (n: string) => path.join(work, n),
    emit: async (o: any) => { emitted.push(o); }, result: (v: any) => { result = v; }, seed: () => 1, usage: () => {}, python: async () => '',
  } as any);
  const files = emitted.map((o, i) => {
    const f = path.join(work, `out-${i}${o.ext ?? ''}`);
    fs.writeFileSync(f, o.data);
    return f;
  });
  return { emitted, result, files };
}

test('video.change runs: first frame, the masked edit, video.control on the original, the original sound put back', async (t) => {
  if (!ffmpeg) return t.skip('no ffmpeg');
  const video = path.join(dir, 'orig.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video);
  const mask = path.join(dir, 'mask.png');
  ff('-f', 'lavfi', '-i', 'color=c=white:size=32x32', '-frames:v', '1', mask);
  const edited = path.join(dir, 'edited.png');
  ff('-f', 'lavfi', '-i', 'color=c=red:size=320x240', '-frames:v', '1', edited);
  const made = path.join(dir, 'made.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', made);
  const calls = fakeGen((tool) => (tool === 'video.control' ? { file: made } : { file: edited }));
  try {
    const r = await runTool('video.change', { prompt: 'make it red' }, { video, mask });
    assert.deepEqual(calls.map((x) => x.tool), ['image.repaint', 'video.control']);
    const [edit, ctl] = calls;
    assert.ok(fs.existsSync(edit.spec.inputs.image) && /\.png$/.test(edit.spec.inputs.image), 'the first frame, taken here');
    assert.equal(edit.spec.inputs.mask, mask);
    assert.equal(edit.spec.labels.parent, 'j_parent');
    assert.equal(edit.spec.key, 'j_parent:frame');
    assert.equal(edit.spec.reuse, true);
    assert.equal(ctl.spec.inputs.control, video);
    assert.match(ctl.spec.inputs.image, /^asset:a_/);
    assert.equal(ctl.spec.params.fps, 24);
    assert.equal(r.emitted[0].title, 'video');
    assert.equal(r.emitted[1].title, 'first frame');
    assert.equal(r.result.keptSound, true);
    const p = await probe(r.files[0]);
    assert.ok(p.streams!.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), 'the original sound is on it');
    assert.ok(p.streams!.some((s) => s.codec_type === 'video'));
  } finally {
    c._setChainClient(null);
  }
});

test('audio.revoice runs: transcribe, speak in the described voice, fit to the original\'s timing, put it on the video', async (t) => {
  if (!ffmpeg) return t.skip('no ffmpeg');
  // The original: 1 s of quiet, then 2 s of "speech", then 0.5 s of quiet; on a 3.5 s video.
  const video = path.join(dir, 'talk.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=3.5', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=2', '-filter_complex', '[1:a]adelay=1000:all=1,apad=whole_dur=3.5[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video);
  // The new take: 2.4 s of speech with a little silence around it.
  const take = path.join(dir, 'take.wav');
  ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=2.4', '-af', 'adelay=200:all=1,apad=pad_dur=0.3', take);
  const calls = fakeGen((tool) => (tool === 'audio.transcribe' ? { result: { text: 'Hello there, friend.' } } : { file: take }));
  try {
    const r = await runTool('audio.revoice', { description: 'a cheerful young woman' }, { video });
    assert.deepEqual(calls.map((x) => x.tool), ['audio.transcribe', 'audio.voice']);
    assert.equal(calls[1].spec.params.text, 'Hello there, friend.');
    assert.equal(calls[1].spec.params.description, 'a cheerful young woman');
    assert.equal(calls[1].spec.params.provider, 'open');
    assert.ok(r.result.tempo > 1.1 && r.result.tempo < 1.3, `tempo ${r.result.tempo}`);
    assert.equal(r.emitted[0].title, 'video');
    assert.equal(r.emitted[1].title, 'voice');
    const voice = await analyze(r.files[1]);
    assert.ok(Math.abs(voice.leadingSilence - 1) < 0.15, `starts where the original did (${voice.leadingSilence})`);
    assert.ok(Math.abs(voice.seconds - 3.5) < 0.15, `as long as the original (${voice.seconds})`);
    const p = await probe(r.files[0]);
    assert.ok(Math.abs(Number(p.format!.duration) - 3.5) < 0.2, String(p.format!.duration));
    // With text given, nothing is transcribed.
    calls.length = 0;
    await runTool('audio.revoice', { voice: 'gv_abc', text: 'Hi.' }, { video });
    assert.deepEqual(calls.map((x) => x.tool), ['audio.voice']);
    assert.equal(calls[0].spec.params.voice, 'gv_abc');
  } finally {
    c._setChainClient(null);
  }
});
