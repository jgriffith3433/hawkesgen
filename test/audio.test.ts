// The open audio suite: direction mapping, routing and fallback, the voice library, the install script, post-processing
// and the checks (real ffmpeg), the licences, and the whole open path through the mock (no GPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-audio-'));
process.env.HAWKESGEN_AUDIO_MOCK = '1';

const { mapDirection, parseDirection, splitTags } = await import('../src/audio/direction.ts');
const { AUDIO_MODELS, REFUSED_MODELS, selectable, modelById } = await import('../src/audio/registry.ts');
const { routeAudio, pickModel, planSpeak, speakGpuSeconds, targetLufs } = await import('../src/audio/plan.ts');
const V = await import('../src/audio/voicelib.ts');
const { wordErrorRate, intelligible } = await import('../src/audio/verify.ts');
const P = await import('../src/audio/post.ts');
const { installScript, VERIFY_PY, pinOf, installable, requiredBytes, soxScript } = await import('../src/providers/audio/install.ts');
const { planPrune } = await import('../src/providers/comfy/fleet.ts');
const { getTool, TOOLS } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { saveSettings } = await import('../src/config.ts');
const { estimate } = await import('../src/estimate.ts');
const O = await import('../src/tools/audio-open.ts');

const hasFfmpeg = P.hasFfmpeg();

test('direction: instruct models get one sentence, tags are folded in', () => {
  const m = mapDirection({ direction: 'instruct' }, '[sighs] I am eleven seconds late.', { emotion: 'tired', delivery: 'almost whispering', pace: 'slow', intensity: 0.2 });
  assert.equal(m.text, 'I am eleven seconds late.');
  assert.match(m.instruct!, /tired.*almost whispering.*slow pace.*understated.*with sighs/);
  assert.deepEqual(m.dropped, []);
  assert.equal(mapDirection({ direction: 'instruct' }, 'Hi.', undefined).instruct, null);
});

test('direction: Chatterbox maps emotion and pace to knobs, keeps its own tags, reports what it dropped', () => {
  const m = mapDirection({ direction: 'tags' }, 'Ha. [laugh] [growls] Run.', { emotion: 'furious', pace: 'fast', style: 'noir' });
  assert.ok(m.exaggeration! >= 1.1, `exaggeration ${m.exaggeration}`);
  assert.equal(m.cfgWeight, 0.3);
  assert.match(m.text, /\[laugh\]/);
  assert.doesNotMatch(m.text, /growls/);
  assert.ok(m.dropped.includes('tag [growls]') && m.dropped.some((d) => d.startsWith('style')));
  const calm = mapDirection({ direction: 'tags' }, 'Hello.', { emotion: 'calm' });
  assert.ok(calm.exaggeration! < m.exaggeration!);
});

test('direction: a model without direction says so; bad direction is refused', () => {
  const m = mapDirection({ direction: 'none' }, '[whispers] No.', 'quiet');
  assert.equal(m.text, 'No.');
  assert.deepEqual(m.dropped, ['tag [whispers]', 'direction']);
  assert.deepEqual(parseDirection('tired'), { notes: 'tired' });
  assert.throws(() => parseDirection({ pace: 'warp' }), /slow, normal or fast/);
  assert.throws(() => parseDirection({ intensity: 3 }), /between 0 and 1/);
  assert.deepEqual(splitTags('[a] x [b]').tags, ['a', 'b']);
});

test('registry: no refused model is listed, blocked ones are not selectable, every selectable one has a license note', () => {
  for (const r of REFUSED_MODELS) assert.equal(modelById(r.id), null);
  for (const m of AUDIO_MODELS) assert.ok(m.license.note && m.license.checked, m.id);
  assert.ok(AUDIO_MODELS.filter((m) => m.license.commercial === false).length === 0);
  assert.ok(!selectable('sfx', 'sfx').some((m) => m.id === 'stable-audio-3-sfx'));
  assert.ok(selectable('voice', 'speak').every((m) => !m.blocked));
  assert.equal(modelById('stable-audio-3-sfx')!.license.code, 'Stability AI Community License');
});

test('pickModel: capability, verified first, refuses blocked and wrong kind', () => {
  assert.equal(pickModel('voice', ['speak', 'clone'], 'auto', new Set()).id, 'qwen3-tts');
  assert.equal(pickModel('voice', ['speak', 'clone'], 'auto', new Set(['chatterbox'])).id, 'chatterbox');
  assert.throws(() => pickModel('voice', ['design'], 'chatterbox'), /cannot design/);
  assert.throws(() => pickModel('voice', ['speak'], 'stable-audio-3-sfx'), /not a voice model/);
  assert.throws(() => pickModel('sfx', ['sfx'], 'stable-audio-3-sfx'), /cannot be used/);
  assert.throws(() => pickModel('voice', ['speak'], undefined, new Set(), { onlyVerified: true }), /verified/);
});

test('routing: the open suite is the default; ElevenLabs only with provider elevenlabs or an ElevenLabs voice id', () => {
  const GV = 'gv_0123456789abcdef';
  for (const verified of [[], ['qwen3-tts', 'moss-soundeffect']]) {
    saveSettings({ audio: { verified, targetLufs: {} } });
    // Unset provider: open, verified or not.
    assert.equal(routeAudio('voice', { text: 'x' }), 'audio.voice-open');
    assert.equal(routeAudio('voice', { text: 'x', voice: GV }), 'audio.voice-open');
    assert.equal(routeAudio('sfx', { text: 'boom' }), 'audio.sfx-open');
    assert.equal(routeAudio('design', { description: 'x' }), 'audio.voice-design-open');
    assert.equal(routeAudio('save', { generatedVoiceId: GV }), 'audio.voice-save-open');
    assert.equal(routeAudio('save', { generatedVoiceId: 'abc' }), 'audio.voice-save-open'); // the open tool says what to do
    assert.equal(routeAudio('delete', { voiceId: GV }), 'audio.voice-delete-open');
    assert.equal(routeAudio('list', {}), 'audio.voice-list-open');
    assert.equal(routeAudio('dialogue', { lines: [], cast: { A: GV } }), 'audio.dialogue-open');
    assert.equal(routeAudio('dialogue', { lines: [{ who: 'A', text: 'x' }] }), 'audio.dialogue-open');
    // Old content with an ElevenLabs voice id keeps working on ElevenLabs.
    assert.equal(routeAudio('voice', { text: 'x', voice: '21m00Tcm4TlvDq8ikWAM' }), null);
    assert.equal(routeAudio('dialogue', { lines: [], cast: { A: GV, B: 'elid' } }), null);
    // Explicit ElevenLabs.
    for (const t of ['voice', 'sfx', 'design', 'save', 'delete', 'list', 'dialogue'] as const) assert.equal(routeAudio(t, { provider: 'elevenlabs', voice: GV, voiceId: GV, generatedVoiceId: GV }), null, t);
    assert.equal(routeAudio('voice', { text: 'x', voice: 'abc', provider: 'open' }), 'audio.voice-open');
    assert.equal(routeAudio('list', { provider: 'open' }), 'audio.voice-list-open');
    // voice-change has no open model.
    assert.equal(routeAudio('change', {}), null);
    assert.throws(() => routeAudio('change', { provider: 'open' }), /no open model/);
    assert.throws(() => routeAudio('voice', { provider: 'both' }), /open, elevenlabs or auto/);
  }
  saveSettings({ audio: { verified: [], targetLufs: {} } });
});

test('the ElevenLabs billing message says how to continue on the open path', async () => {
  const { BILLING_MESSAGE } = await import('../src/providers/elevenlabs.ts');
  assert.match(BILLING_MESSAGE, /audio\.voice-clone/);
  assert.match(BILLING_MESSAGE, /audio\.voice-design/);
});

test('the plain audio tools describe the open suite first and expose its params', () => {
  for (const id of ['audio.voice', 'audio.sfx', 'audio.dialogue', 'audio.voice-design']) {
    const t = getTool(id)!;
    assert.match(t.description, /open models/i, id);
    assert.ok(t.description.search(/open models/i) < t.description.search(/ElevenLabs/), `${id}: open first`);
    for (const k of ['provider', 'openModel', 'direction', 'verify']) assert.ok(t.params[k], `${id} has ${k}`);
  }
});

test('existing callers: an old audio.voice / audio.sfx call validates to exactly the params it had before (recipes stay current)', () => {
  const v = validateParams(getTool('audio.voice')!, { text: 'Hi', voice: 'abc123' });
  assert.deepEqual(Object.keys(v).sort(), ['count', 'format', 'model', 'text', 'voice']);
  assert.equal(v.model, 'eleven_v4');
  const s = validateParams(getTool('audio.sfx')!, { text: 'boom' });
  assert.deepEqual(Object.keys(s).sort(), ['count', 'format', 'influence', 'loop', 'model', 'text']);
  const d = validateParams(getTool('audio.dialogue')!, { lines: [{ voice: 'a', text: 'x' }] });
  assert.deepEqual(Object.keys(d).sort(), ['count', 'format', 'lines', 'model', 'stems']);
  assert.equal(getTool('audio.voice')!.version, 1);
  assert.equal(getTool('audio.voice')!.provider, 'elevenlabs');
});

test('every routed twin accepts everything its shared name accepts (a routed call never fails validation)', () => {
  const pairs: [string, string][] = [['audio.voice', 'audio.voice-open'], ['audio.sfx', 'audio.sfx-open'], ['audio.dialogue', 'audio.dialogue-open'], ['audio.voice-design', 'audio.voice-design-open'], ['audio.voice-save', 'audio.voice-save-open'], ['audio.voice-list', 'audio.voice-list-open'], ['audio.voice-delete', 'audio.voice-delete-open']];
  for (const [a, b] of pairs) {
    const ta = getTool(a)!;
    const tb = getTool(b)!;
    assert.ok(tb, b);
    for (const k of Object.keys(ta.params)) assert.ok(k in tb.params, `${b} lacks ${k} from ${a}`);
    for (const k of Object.keys(ta.inputs)) assert.ok(k in tb.inputs, `${b} lacks input ${k}`);
  }
});

test('every new tool is listed with full params', () => {
  for (const id of ['audio.voice-open', 'audio.voice-design-open', 'audio.voice-save-open', 'audio.voice-list-open', 'audio.voice-delete-open', 'audio.voice-clone', 'audio.sfx-open', 'audio.dialogue-open', 'audio.process', 'audio.analyze', 'audio.music-loop'])
    assert.ok(TOOLS.find((t) => t.id === id), id);
  for (const t of TOOLS.filter((t) => t.id.startsWith('audio.') && t.id.endsWith('-open')))
    for (const [k, spec] of Object.entries(t.params)) assert.ok(spec.type, `${t.id}.${k}`);
});

test('voice library: create, clone reference kept, save, list per project, delete removes the clip', () => {
  const v = V.createVoice({ project: 'doseofdestruction', name: 'candidate 1', status: 'candidate', description: 'gravelly boxer', model: 'qwen3-tts', recipe: { seed: 5 }, refAudio: Buffer.from('RIFF'), refExt: '.wav', refText: 'hello' });
  assert.match(v.id, /^gv_[0-9a-f]{16}$/);
  assert.ok(V.isGenVoiceId(v.id) && !V.isGenVoiceId('21m00Tcm4TlvDq8ikWAM'));
  assert.ok(V.refPath(v) && fs.existsSync(V.refPath(v)!));
  assert.equal(V.listVoices({ project: 'doseofdestruction', status: 'saved' }).length, 0);
  const saved = V.saveVoice(v.id, { name: 'Exit Punk', elevenlabsId: 'el123' });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.elevenlabsId, 'el123');
  assert.equal(V.listVoices({ project: 'doseofdestruction', status: 'saved' }).length, 1);
  assert.equal(V.listVoices({ project: 'other' }).length, 0);
  assert.equal(V.publicVoice(saved).hasReference, true);
  const ref = V.refPath(saved)!;
  V.deleteVoice(v.id);
  assert.equal(V.getVoice(v.id), null);
  assert.ok(!fs.existsSync(ref));
  assert.throws(() => V.requireVoice(v.id), /No voice/);
});

test('planSpeak: a designed voice is spoken by the model that designed it; a reference lets any cloning model; direction needs the capability', () => {
  const designed = V.createVoice({ project: 'p', name: 'D', description: 'a tired mechanic', model: 'voxcpm2' });
  const plan = planSpeak({ text: 'Hello there.', voice: designed.id, direction: 'tired', count: 2 }, { seed: (n) => 10 + n });
  assert.equal(plan.model.id, 'voxcpm2');
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items.map((i) => i.seed), [10, 11]);
  assert.match(plan.items[0].description!, /mechanic/);
  const cloned = planSpeak({ text: 'Hello.' }, { reference: '/tmp/x.wav', seed: () => 1 });
  assert.equal(cloned.model.id, 'qwen3-tts');
  const cb = planSpeak({ text: 'Hello.', openModel: 'chatterbox', direction: { emotion: 'angry' } }, { reference: '/tmp/x.wav', seed: () => 1 });
  assert.equal(cb.model.id, 'chatterbox');
  assert.ok(cb.items[0].exaggeration! > 0.9 && cb.items[0].instruct === null);
  assert.throws(() => planSpeak({ text: 'x', voice: '21m00Tcm4TlvDq8ikWAM' }, { seed: () => 1 }), /not a Gen voice id/);
  assert.throws(() => planSpeak({ text: 'x', voice: 'gv_ffffffffffffffff' }, { seed: () => 1 }), /No voice/);
  assert.throws(() => planSpeak({ text: '' }, { seed: () => 1 }), /text is required/);
});

test('price: speech GPU seconds grow with text and takes; the estimate prices a routed call as the open tool', () => {
  const m = modelById('qwen3-tts')!;
  assert.ok(speakGpuSeconds(m, 300, 1) > speakGpuSeconds(m, 30, 1));
  assert.ok(speakGpuSeconds(m, 300, 3) > speakGpuSeconds(m, 300, 1));
  const e = estimate('doseofdestruction', [{ tool: 'audio.voice', params: { text: 'x'.repeat(150), provider: 'open' }, count: 4 }]) as any;
  assert.equal(e.lines[0].tool, 'audio.voice-open');
  assert.ok(e.lines[0].gpuSeconds > 0);
  const el = estimate('doseofdestruction', [{ tool: 'audio.voice', params: { text: 'x', voice: 'abc' }, count: 1 }]) as any;
  assert.equal(el.lines[0].tool, 'audio.voice');
  assert.equal(el.lines[0].gpuSeconds, 0);
});

test('targetLufs: project and kind beat the default', () => {
  saveSettings({ audio: { verified: [], targetLufs: { 'sickofit:sfx': -20, yoobaland: -18 } } });
  assert.equal(targetLufs('sickofit', 'sfx'), -20);
  assert.equal(targetLufs('yoobaland', 'voice'), -18);
  assert.equal(targetLufs('other', 'sfx'), -18);
  assert.equal(targetLufs('other', 'voice'), -16);
  assert.equal(targetLufs('other', 'voice', -23), -23);
  assert.equal(targetLufs('other', 'voice', null), null);
  saveSettings({ audio: { verified: [], targetLufs: {} } });
});

test('install: resumable and verified, Python 3.11 from deadsnakes, pins keep models apart', () => {
  for (const m of AUDIO_MODELS.filter(installable)) {
    const s = installScript(m.id);
    assert.match(s, /deadsnakes/);
    assert.match(s, /READY/);
    assert.match(s, /verify\.py/);
    assert.match(s, new RegExp(`${m.id}/venv`));
    // READY is written only after verification.
    assert.ok(s.indexOf('verify.py') < s.indexOf('printf %s "$MARK"'));
  }
  assert.match(installScript('qwen3-tts'), /qwen-tts/);
  assert.match(installScript('asr'), /faster-whisper/);
  assert.notEqual(pinOf(modelById('qwen3-tts')!), pinOf(modelById('chatterbox')!));
  assert.match(VERIFY_PY, /\.incomplete/);
  assert.throws(() => installScript('stable-audio-3-sfx'), /cannot be installed/);
});

test('verify: word error rate ignores case, punctuation and tags', () => {
  assert.equal(wordErrorRate('[sighs] Eleven seconds late!', 'eleven seconds late'), 0);
  assert.equal(wordErrorRate('one two three four', 'one two tree four'), 0.25);
  assert.ok(intelligible(0.2) && !intelligible(0.5));
  assert.equal(wordErrorRate('', ''), 0);
});

test('post: parsers read ffmpeg output', () => {
  const e = P.parseEbur128('Summary:\n  Integrated loudness:\n    I:         -23.4 LUFS\n  Loudness range:\n    LRA:         5.1 LU\n  True peak:\n    Peak:       -1.2 dBFS');
  assert.deepEqual(e, { lufs: -23.4, loudnessRange: 5.1, truePeak: -1.2 });
  assert.deepEqual(P.parseSilence('[silencedetect] silence_start: 0\n[silencedetect] silence_end: 0.4 | silence_duration: 0.4\n[silencedetect] silence_start: 3.2'), [{ start: 0, end: 0.4 }, { start: 3.2, end: null }]);
  const bad = P.judge({ seconds: 2, lufs: -30, truePeak: 0, loudnessRange: 3, peakDb: 0, clippedSamples: 40, clipped: true, leadingSilence: 1, trailingSilence: 0, silent: false }, { targetLufs: -16 });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3);
  assert.match(P.loopGraph(10, 2), /amix=inputs=2/);
  assert.throws(() => P.loopGraph(3, 2), /third/);
  const click = new Float32Array(44100).map((_, i) => Math.sin(i / 40) * 0.5 + 0.4 * (i / 44100));
  assert.equal(P.checkLoopSamples(click, 44100).ok, false);
  const clean = new Float32Array(44100).map((_, i) => Math.sin((2 * Math.PI * 441 * i) / 44100) * 0.5);
  assert.equal(P.checkLoopSamples(clean, 44100).ok, true);
});

test('post (ffmpeg): normalise to a target, trim silence, loop passes the loop-point check', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-post-'));
  const src = path.join(dir, 'in.wav');
  // 0.5 s silence + 2 s tone + 0.5 s silence, quiet.
  await P.ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-af', 'volume=0.05,adelay=500:all=1,apad=pad_dur=0.5', '-ar', '44100', '-ac', '1', src]);
  const before = await P.analyze(src);
  assert.ok(before.leadingSilence >= 0.4, `lead ${before.leadingSilence}`);
  assert.ok(before.lufs! < -28);
  const out = path.join(dir, 'out.wav');
  const r = await P.processAudio(src, out, { targetLufs: -16, trimSilence: true, format: 'wav' });
  assert.ok(Math.abs(r.after.lufs! - -16) < 1.5, `lufs ${r.after.lufs}`);
  assert.ok(r.after.leadingSilence < 0.15 && r.after.trailingSilence < 0.15, JSON.stringify(r.after));
  assert.ok(r.after.seconds < before.seconds - 0.5);
  const mp3 = path.join(dir, 'out.mp3');
  await P.processAudio(src, mp3, { targetLufs: -16, format: 'mp3', sampleRate: 22050 });
  assert.ok(fs.statSync(mp3).size > 1000);
  // A pad of drifting noise loops after the crossfade.
  const bed = path.join(dir, 'bed.wav');
  await P.ff(['-y', '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=pink:r=44100:a=0.2', '-af', 'afade=t=in:d=2,afade=t=out:st=6:d=2', '-ac', '1', bed]);
  const loop = path.join(dir, 'loop.wav');
  const info = await P.makeLoop(bed, loop, { crossfade: 1.5 });
  assert.ok(Math.abs(info.seconds - 6.5) < 0.1);
  assert.ok(Math.abs((await P.durationOf(loop)) - 6.5) < 0.1, `real length ${await P.durationOf(loop)}`);
  const chk = await P.checkLoop(loop);
  assert.equal(chk.ok, true, JSON.stringify(chk));
});

function fakeCtx(params: Record<string, any>, inputs: Record<string, any> = {}, project = 'testproj') {
  const outputs: any[] = [];
  let result: any;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ctx-'));
  let n = 0;
  const ctx: any = {
    job: { id: 'j_test', client: 'c', project, tool: 'x', labels: {} }, params, inputs, done: 0, outputs: [], signal: new AbortController().signal,
    step() {}, log() {}, tmp: (name: string) => path.join(tmpDir, name), emit: async (o: any) => { outputs.push(o); },
    result: (v: any) => { result = v; }, seed: (i: number) => 1000 + i + n++ * 0, usage() {}, python: async () => '',
  };
  return { ctx, outputs, get result() { return result; } };
}

test('mock path: design -> save -> speak with direction and verify -> table read -> sfx variants and a loop -> clone -> process', { skip: !hasFfmpeg }, async () => {
  const run = async (id: string, params: Record<string, any>, inputs: Record<string, any> = {}) => {
    const tool = getTool(id)!;
    const f = fakeCtx(validateParams(tool, params), inputs);
    await tool.run(f.ctx);
    return f;
  };
  // Design three candidates and keep one.
  const design = await run('audio.voice-design-open', { description: 'a gravelly old boxer', openModel: 'qwen3-tts' });
  assert.equal(design.result.candidates.length, 3);
  assert.equal(design.outputs.length, 3);
  const save = await run('audio.voice-save-open', { generatedVoiceId: design.result.candidates[0], name: 'Boxer', description: 'a gravelly old boxer', elevenlabsId: 'el_old' });
  const voiceId = save.result.voiceId;
  assert.equal(V.getVoice(voiceId)!.status, 'saved');
  // Speak with direction; the mock "transcribes" the text, so verify passes.
  const say = await run('audio.voice-open', { text: '[sighs] I was eleven seconds late.', voice: voiceId, direction: { emotion: 'tired', pace: 'slow' }, verify: true, count: 2, format: 'wav' });
  assert.equal(say.outputs.length, 2);
  assert.equal(say.result.model, 'qwen3-tts');
  assert.equal(say.result.takes[0].wer, 0);
  assert.match(say.result.applied.instruct, /tired.*slow pace.*sighs/);
  assert.ok(Math.abs(say.result.takes[0].lufs - -16) < 2, `lufs ${say.result.takes[0].lufs}`);
  // A table read.
  const read = await run('audio.dialogue-open', { lines: [{ who: 'Boxer', text: 'You are late.' }, { who: 'Kid', text: 'I know. Eleven seconds.', direction: 'out of breath' }], cast: { Boxer: voiceId, Kid: voiceId }, format: 'wav', stems: true });
  assert.equal(read.outputs.length, 3);
  const seg = read.result.segments;
  assert.equal(seg.length, 2);
  assert.ok(seg[1].start >= seg[0].end + 0.2, JSON.stringify(seg));
  // SFX: variants, then a loop.
  const sfx = await run('audio.sfx-open', { text: 'footstep on gravel', variants: ['heavy', 'light', 'dragging'], duration: 1, format: 'wav', openModel: 'moss-soundeffect' });
  assert.equal(sfx.outputs.length, 3);
  assert.equal(sfx.result.model, 'moss-soundeffect');
  const loop = await run('audio.sfx-open', { text: 'engine hum bed', duration: 6, loop: true, format: 'wav', crossfade: 1 });
  assert.equal(loop.result.takes[0].loop.crossfade, 1);
  assert.ok(Math.abs(loop.result.takes[0].seconds - 6) < 0.3, `len ${loop.result.takes[0].seconds}`);
  // Clone from a sample, then analyze and process it.
  const sample = fakeCtx({}).ctx.tmp('sample.wav');
  await P.ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=5', '-af', 'volume=0.3', sample]);
  const clone = await run('audio.voice-clone', { name: 'Sample', referenceText: 'la la la' }, { reference: sample });
  assert.ok(V.isGenVoiceId(clone.result.voiceId));
  const short = fakeCtx({ name: 'x' }, { reference: sample.replace('sample', 'short') });
  await P.ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1', short.ctx.inputs.reference]);
  await assert.rejects(() => getTool('audio.voice-clone')!.run(short.ctx), /3 to 10 seconds/);
  const an = await run('audio.analyze', { loop: true }, { audio: sample });
  assert.equal(typeof an.result.lufs, 'number');
  const pr = await run('audio.process', { kind: 'sfx', format: 'ogg', trim: true }, { audio: sample });
  assert.equal(pr.outputs[0].ext, '.ogg');
  // Music: intro + loop.
  const music = fakeCtx({}).ctx.tmp('music.wav');
  await P.ff(['-y', '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:r=44100:a=0.2', '-ac', '1', music]);
  const ml = await run('audio.music-loop', { mode: 'intro-loop', introSeconds: 4, crossfade: 2, format: 'wav' }, { audio: music });
  assert.deepEqual(ml.result.parts, ['intro', 'loop']);
  assert.equal(ml.result.check.ok, true, JSON.stringify(ml.result.check));
  // The Gen voice list and delete.
  const list = await run('audio.voice-list-open', { project: '*' });
  assert.ok(list.result.voices.some((v: any) => v.id === voiceId));
  const del = await run('audio.voice-delete-open', { voiceId });
  assert.equal(del.result.deleted, true);
});

test('fallback: auto falls back to ElevenLabs when the open path fails; open does not', async () => {
  // A call on an ElevenLabs voice that was routed open (verified model) but whose model is not wired.
  const tool = getTool('audio.voice-open')!;
  const f = fakeCtx(validateParams(tool, { text: 'Hi', voice: 'el_voice_id', openModel: 'qwen3-tts' }));
  // planSpeak refuses an ElevenLabs id, which is the open path being unavailable for this voice: ElevenLabs gets it.
  const calls: string[] = [];
  const real = getTool('audio.voice')!.run;
  getTool('audio.voice')!.run = async (ctx) => { calls.push(String(ctx.params.voice)); };
  try {
    await tool.run(f.ctx);
  } finally {
    getTool('audio.voice')!.run = real;
  }
  assert.deepEqual(calls, ['el_voice_id']);
  const strict = fakeCtx(validateParams(tool, { text: 'Hi', voice: 'el_voice_id', provider: 'open' }));
  await assert.rejects(() => tool.run(strict.ctx), /not a Gen voice id/);
});

test('the Python runner and the ASR check at least compile', async (t) => {
  const { spawnSync } = await import('node:child_process');
  // A real Python: on Windows `python3` is often the Store's placeholder, which fails without running anything.
  const py = [['python3'], ['py', '-3'], ['python']].find(([cmd, ...a]) => spawnSync(cmd, [...a, '-c', 'import sys; sys.exit(0)']).status === 0);
  if (!py) return t.skip('no Python here');
  const [cmd, ...pre] = py;
  for (const f of ['run.py', 'asr.py']) {
    const r = spawnSync(cmd, [...pre, '-c', `import ast,sys;ast.parse(open(sys.argv[1], encoding='utf-8').read())`, path.join(import.meta.dirname, '..', 'post', 'audio', f)]);
    assert.equal(r.status, 0, String(r.stderr));
  }
});

test('install: the disk requirement is per component, from the real sizes, and the script checks that figure', () => {
  const GB = 1024 ** 3;
  assert.ok(requiredBytes('asr') < 8 * GB);
  assert.ok(requiredBytes('qwen3-tts') > modelById('qwen3-tts')!.sizeGb * GB);
  assert.ok(requiredBytes('qwen3-tts') < 30 * GB, 'no longer the flat 30 GB');
  assert.ok(requiredBytes('qwen3-tts') > requiredBytes('asr'));
  assert.ok(requiredBytes('qwen3-tts') > requiredBytes('chatterbox'));
  assert.ok(installScript('asr').includes(`-lt ${requiredBytes('asr')} ]`));
  assert.ok(installScript('qwen3-tts').includes(`-lt ${requiredBytes('qwen3-tts')} ]`));
});

test('install: sox is installed non-interactively with a clear error, and the model install runs it (not asr)', () => {
  const sox = soxScript();
  assert.match(sox, /command -v sox/);
  assert.match(sox, /DEBIAN_FRONTEND=noninteractive apt-get/);
  assert.match(sox, /install -y sox libsox-fmt-all/);
  assert.match(sox, /could not install sox/);
  assert.match(installScript('qwen3-tts'), /install -y sox libsox-fmt-all/);
  assert.doesNotMatch(installScript('asr'), /sox/);
});

test('prune: least recently used first, never the kept ones, and says when it cannot free enough', () => {
  const files = new Map([['a/old.safetensors', 10], ['a/mid.safetensors', 10], ['a/new.safetensors', 10], ['a/core.safetensors', 50], ['a/never.safetensors', 5]]);
  const used = { 'a/old.safetensors': 1, 'a/mid.safetensors': 2, 'a/new.safetensors': 3 };
  const keep = new Set(['a/core.safetensors']);
  assert.deepEqual(planPrune(files, keep, used, 15), { remove: ['a/never.safetensors', 'a/old.safetensors'], freed: 15 });
  assert.deepEqual(planPrune(files, keep, used, 4).remove, ['a/never.safetensors']);
  const all = planPrune(files, keep, used, 1000);
  assert.equal(all.freed, 35);
  assert.ok(!all.remove.includes('a/core.safetensors'));
  assert.deepEqual(planPrune(files, keep, used, 0).remove, []);
});
