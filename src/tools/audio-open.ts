// The open-model sound suite's tools (docs/audio.md). The shared names (audio.voice, audio.sfx, audio.dialogue,
// audio.voice-design/-save/-list/-delete) hand a call to these at submit (Tool.route, src/audio/plan.ts routeAudio);
// the voice clone, process, analyze and loop tools are new.
//
// GPU tools run in the model's own venv on a fleet server (family `audio:<model>`, installed on first use, one job per
// server and the fleet's idle shutdown as for every GPU tool). HAWKESGEN_AUDIO_MOCK=1 swaps the server for ffmpeg tones
// so a spare-port Gen and the tests run the whole path (planning, post-processing, checks, the voice library) with no GPU.

import fs from 'node:fs';
import path from 'node:path';
import type { RunContext, Tool } from './types.ts';
import { GenError } from '../util.ts';
import { blenderWorkspace } from '../providers/blender/blender.ts';
import { ensureAudio } from '../providers/audio/audio.ts';
import { ASR_ID, AUDIO_ROOT, venvPython } from '../providers/audio/install.ts';
import { AUDIO_MODELS, modelById, type AudioModel } from '../audio/registry.ts';
import { OPEN, pickModel, planSpeak, speakGpuSeconds, targetLufs, type SpeakItem } from '../audio/plan.ts';
import { createVoice, deleteVoice as dropVoice, getVoice, isGenVoiceId, listVoices, publicVoice, saveVoice } from '../audio/voicelib.ts';
import { analyze, checkLoop, cut, durationOf, ff, judge, makeLoop, processAudio, type Format, type ProcessOptions } from '../audio/post.ts';
import { intelligible, wordErrorRate } from '../audio/verify.ts';
import { voiceOpenParams, referenceInput, postParams, sfxExtra, dialogueExtra, designExtra, saveExtra, listExtra, deleteExtra } from '../audio/params.ts';
import { voiceTool, dialogueTool, dialogueLines } from './api.ts';

const MOCK = process.env.HAWKESGEN_AUDIO_MOCK === '1';
/** In the mock the tools are plain CPU jobs; for real they take a GPU server. */
const provider = MOCK ? 'local' : 'comfy';
const familyOf = (model: string) => (MOCK ? undefined : `audio:${model}`);

export const formatOf = (f: unknown): Format => {
  const s = String(f ?? 'wav').toLowerCase();
  return s.startsWith('mp3') ? 'mp3' : s.startsWith('ogg') || s.startsWith('opus') ? 'ogg' : s.startsWith('flac') ? 'flac' : 'wav';
};

/** What `process` does to a take, from the call's params. */
export function postOptions(p: Record<string, any>, project: string, kind: 'voice' | 'sfx' | 'music', extra: ProcessOptions = {}): ProcessOptions {
  return {
    targetLufs: p.normalize === false ? null : targetLufs(project, kind, p.targetLufs),
    trimSilence: p.trim !== false, fadeIn: p.fade, fadeOut: p.fade, format: formatOf(p.format), sampleRate: p.sampleRate, ...extra,
  };
}

type Synth = { dir: string; items: { id: string; file: string; seconds: number; transcript?: string }[]; model: AudioModel; /** Set when verify was asked for and the transcriber could not be installed: the takes were made unchecked. */ verifySkipped?: string };

/** Runs a job's items on a GPU server (or the mock) and brings the WAVs back. */
async function synthesize(ctx: RunContext, o: { model: AudioModel; task: 'speak' | 'design' | 'sfx'; items: Record<string, any>[]; refs?: Record<string, string>; asr?: boolean; language?: string }): Promise<Synth> {
  const out = ctx.tmp(`audio-${o.task}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  if (MOCK) {
    // A tone per item, long enough for its text: the shape of the real thing without a GPU.
    const items: Synth['items'] = [];
    for (const it of o.items) {
      const secs = Math.max(0.6, Math.min(30, it.seconds ?? String(it.text ?? '').length / 15));
      const file = path.join(out, `${it.id}.wav`);
      await ff(['-y', '-f', 'lavfi', '-i', `sine=frequency=${220 + (Number(it.seed) % 200)}:duration=${secs}`, '-af', 'volume=0.4,afade=t=in:d=0.02,afade=t=out:st=' + Math.max(0, secs - 0.05) + ':d=0.05', '-ar', String(o.model.sampleRate), '-ac', '1', file], { signal: ctx.signal });
      items.push({ id: it.id, file, seconds: secs, transcript: o.asr ? String(it.text ?? '') : undefined });
    }
    return { dir: out, items, model: o.model };
  }
  const c = ctx.comfy!;
  await ensureAudio(c.server.id, o.model.id, ctx.step, ctx.signal);
  let asr = Boolean(o.asr);
  let verifySkipped: string | undefined;
  if (asr) {
    try {
      await ensureAudio(c.server.id, ASR_ID, ctx.step, ctx.signal);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      asr = false;
      verifySkipped = `verify was skipped: the transcriber (asr) could not be installed on ${c.server.id} (${e instanceof Error ? e.message : String(e)}); the takes were not checked against the text`;
      ctx.log(`warning: ${verifySkipped}`);
      ctx.step('making the takes without verification (the transcriber is not available)');
    }
  }
  const ws = await blenderWorkspace(c.server.id, ctx.job.id);
  try {
    const put: Record<string, string> = {};
    const items = o.items.map((it): Record<string, any> => {
      if (!it.refFile) return { ...it, ref: null };
      const name = `in/ref-${path.basename(it.refFile).replace(/[^\w.-]/g, '_')}`;
      put[name] = it.refFile;
      return { ...it, ref: name };
    });
    await ws.put(put);
    const spec = { task: o.task, model: o.model.id, items: items.map((it) => ({ id: it.id, text: it.text, instruct: it.instruct, exaggeration: it.exaggeration, cfg_weight: it.cfgWeight, speed: it.speed, ref: it.ref, ref_text: it.refText, description: it.description, seconds: it.seconds, loop: it.loop, seed: it.seed, language: it.language })) };
    await ws.write({ 'spec.json': JSON.stringify(spec) });
    const script = [
      'set -euo pipefail',
      `export HF_HOME=${AUDIO_ROOT}/hf HF_HUB_ENABLE_HF_TRANSFER=0 HF_HUB_OFFLINE=1`,
      `cd ${ws.dir}`,
      `${venvPython(o.model.id)} ${AUDIO_ROOT}/run.py spec.json`,
      ...(asr ? [`for f in out/*.wav; do ${venvPython(ASR_ID)} ${AUDIO_ROOT}/asr.py "$f" ${o.language ?? 'en'} > "\${f%.wav}.asr.json" || echo '{"text":""}' > "\${f%.wav}.asr.json"; done`] : []),
    ].join('\n');
    ctx.step(`${o.task === 'sfx' ? 'making sounds' : 'speaking'} with ${o.model.id}`);
    await c.timed(() => ws.run(script, { signal: ctx.signal, timeoutMs: 40 * 60_000, onLine: (l) => { const [w, ...r] = l.split(' '); if (w === 'step') ctx.step(r.join(' ')); } }));
    await ws.get('out', out);
  } finally {
    await ws.clean();
  }
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
  return {
    dir: out, model: o.model, verifySkipped,
    items: meta.items.map((r: any) => {
      const asrFile = path.join(out, `${r.id}.asr.json`);
      return { id: r.id, file: path.join(out, `${r.id}.wav`), seconds: r.seconds, transcript: fs.existsSync(asrFile) ? JSON.parse(fs.readFileSync(asrFile, 'utf8')).text : undefined };
    }),
  };
}

/** Post-processes one take and returns the bytes, its analysis and verdict. */
async function finish(ctx: RunContext, file: string, name: string, kind: 'voice' | 'sfx' | 'music', p: Record<string, any>, extra: ProcessOptions = {}) {
  const opts = postOptions(p, ctx.job.project, kind, extra);
  const outFile = ctx.tmp(`${name}.${opts.format}`);
  const r = await processAudio(file, outFile, opts, ctx.signal);
  return { data: fs.readFileSync(outFile), ext: `.${opts.format}`, analysis: r.after, verdict: judge(r.after, { targetLufs: opts.targetLufs ?? undefined }), opts };
}

const licenseNotes = (m: AudioModel) => (m.license.commercial === 'verify' ? [`${m.id}: commercial license not confirmed (${m.license.note})`] : []);

/** The ElevenLabs tool's run, only for a speak or dialogue call that carries an ElevenLabs voice id (old content) when the open path is unavailable. */
async function fallback(ctx: RunContext, el: Tool, why: unknown) {
  const p = ctx.params;
  if (p.provider === 'open') throw why;
  ctx.log(`open path unavailable (${why instanceof Error ? why.message : String(why)}); falling back to ElevenLabs`);
  await el.run(ctx);
}

// ---- audio.voice-open ------------------------------------------------------------------------------------------

export const voiceOpenTool: Tool = {
  id: OPEN.voice, version: 1, title: 'Speak a line (open models)',
  description: 'Speaks a line on an open model on the Gen GPU fleet (MOSS-TTS, Qwen3-TTS, VoxCPM2, Chatterbox): with DIRECTION (emotion, delivery, pace, style), in a saved Gen voice (voice: gv_...), cloned from a 3-10 s sample (input reference), or from a description. This is the default for audio.voice (the same tool: ElevenLabs only with provider "elevenlabs" or an ElevenLabs voice id). Loudness-normalised, silence-trimmed; verify: true transcribes each take and checks it says the text.',
  provider, server: 'ssh', family: (p) => `audio:${planModelId(p)}`, output: 'audio',
  inputs: referenceInput,
  params: {
    text: { type: 'text', required: true },
    voice: { type: 'string', description: 'A Gen voice id (gv_..., from audio.voice-design / audio.voice-clone / audio.voice-list).' },
    model: { type: 'string', default: 'eleven_v4', description: 'ElevenLabs model (ignored by the open path; use openModel).', advanced: true },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true, description: 'mp3_..., wav, ogg or flac; the open path converts from the format name.' },
    settings: { type: 'json', description: 'ElevenLabs voice_settings (ignored by the open path).', advanced: true },
    count: { type: 'integer', min: 1, max: 4, default: 1, description: 'Takes.' },
    ...voiceOpenParams,
  },
  models: (p) => [`audio:${planModelId(p)}`],
  gpuSeconds: (p) => speakGpuSeconds(modelById(planModelId(p)) ?? AUDIO_MODELS[1], String(p.text ?? '').length || 60, Number(p.count) || 1, p.verify === true),
  async run(ctx) {
    try {
      const p = ctx.params;
      const plan = planSpeak(p, { reference: ctx.inputs.reference ?? null, referenceText: p.referenceText ?? null, seed: (n) => ctx.seed(n) });
      for (const w of plan.warnings) ctx.log(`warning: ${w}`);
      const s = await synthesize(ctx, { model: plan.model, task: 'speak', items: plan.items, asr: p.verify === true, language: plan.items[0].language });
      const takes: any[] = [];
      for (const [i, it] of s.items.entries()) {
        const f = await finish(ctx, it.file, `take-${i}`, 'voice', p);
        const wer = it.transcript !== undefined ? wordErrorRate(plan.items[i].text, it.transcript) : null;
        const t = { take: i, seed: plan.items[i].seed, seconds: f.analysis.seconds, lufs: f.analysis.lufs, ok: f.verdict.ok && (wer === null || intelligible(wer)), problems: f.verdict.problems, transcript: it.transcript ?? null, wer };
        takes.push(t);
        if (i >= ctx.done) await ctx.emit({ data: f.data, ext: f.ext, seed: plan.items[i].seed, title: i ? `take ${i + 1}` : 'voice', meta: { model: plan.model.id, voice: p.voice ?? null, ...t } });
      }
      ctx.result({ provider: 'open', model: plan.model.id, voice: p.voice ?? null, takes, dropped: plan.items[0].dropped, applied: { instruct: plan.items[0].instruct, exaggeration: plan.items[0].exaggeration, cfgWeight: plan.items[0].cfgWeight }, warnings: plan.warnings, ...(s.verifySkipped ? { verified: false, verifySkipped: s.verifySkipped } : {}) });
    } catch (e) {
      if (!ctx.params.voice || isGenVoiceId(ctx.params.voice)) throw e;
      await fallback(ctx, voiceTool, e);
    }
  },
};

function safeModel(kind: 'voice' | 'sfx', needs: any[], wanted?: string) {
  try { return pickModel(kind, needs, wanted).id; } catch { return kind === 'voice' ? 'qwen3-tts' : 'moss-soundeffect'; }
}

/** The model a call will use, for the family and the price (before the voice is looked up). */
export function planModelId(p: Record<string, any>): string {
  try {
    const voice = isGenVoiceId(p.voice) ? getVoice(p.voice) : null;
    const wanted = p.openModel && p.openModel !== 'auto' ? p.openModel : !voice?.refFile && voice?.model && modelById(voice.model) ? voice.model : undefined;
    const needs: any[] = ['speak'];
    if (p.direction != null && p.direction !== '') needs.push('direction');
    if (voice?.refFile) needs.push('clone');
    return pickModel('voice', needs, wanted).id;
  } catch {
    return 'qwen3-tts';
  }
}

// ---- audio.voice-design-open / save / list / delete / clone -----------------------------------------------------

const SAMPLE = 'The door was open when we got there, and nobody was inside. Somebody had been in a hurry.';

export const voiceDesignOpenTool: Tool = {
  id: OPEN.design, version: 1, title: 'Design a voice (open models)',
  description: 'Designs voices from a description on an open model (Qwen3-TTS or VoxCPM2): candidates (default 3), each saved in the Gen voice library as a candidate with its recipe and its preview clip as the reference, so it can be recreated and spoken by any cloning model. No slot cap. audio.voice-save (a gv_ id) names the one you keep.',
  provider, server: 'ssh', family: (p) => `audio:${safeModel('voice', ['design'], p.openModel)}`, guard: ({ params }) => void pickModel('voice', ['design'], params.openModel), output: 'audio', inputs: {},
  params: {
    description: { type: 'text', required: true, description: 'Age, tone, accent, attitude, recording quality.' },
    text: { type: 'text', description: 'What the previews say. Empty: a short neutral passage.' },
    model: { type: 'string', default: 'eleven_ttv_v3', advanced: true, description: 'ElevenLabs model (ignored by the open path).' },
    ...designExtra,
    ...voiceOpenParams,
  },
  gpuSeconds: (p) => speakGpuSeconds(modelById(safeModel('voice', ['design'], p.openModel))!, String(p.text || SAMPLE).length, Number(p.candidates) || 3),
  async run(ctx) {
    try {
      const p = ctx.params;
      const model = pickModel('voice', ['design'], p.openModel);
      const text = String(p.text || SAMPLE);
      const n = Number(p.candidates) || 3;
      const items: SpeakItem[] = Array.from({ length: n }, (_, i) => ({ id: `cand${i}`, text, instruct: planSpeak({ text, direction: p.direction, openModel: model.id }, { seed: () => 1 }).items[0].instruct, exaggeration: null, cfgWeight: null, speed: null, description: p.description, refFile: null, refText: null, language: p.language ?? 'en', seed: ctx.seed(i), dropped: [] }));
      const s = await synthesize(ctx, { model, task: 'design', items });
      const ids: string[] = [];
      for (const [i, it] of s.items.entries()) {
        const f = await finish(ctx, it.file, `cand-${i}`, 'voice', { ...p, format: 'wav' });
        const raw = fs.readFileSync(it.file);
        const v = createVoice({ project: ctx.job.project, name: `candidate ${ctx.job.id}-${i + 1}`, status: 'candidate', description: p.description, model: model.id, language: p.language ?? 'en', recipe: { kind: 'design', model: model.id, seed: items[i].seed, text, direction: p.direction ?? null }, refAudio: raw, refExt: '.wav', refText: text });
        ids.push(v.id);
        if (i >= ctx.done) await ctx.emit({ data: f.data, ext: f.ext, seed: items[i].seed, title: `candidate ${i + 1}`, meta: { generatedVoiceId: v.id, model: model.id } });
      }
      ctx.result({ provider: 'open', model: model.id, text, candidates: ids, warnings: licenseNotes(model) });
    } catch (e) {
      throw e;
    }
  },
};

const localProvider = 'local' as const;

export const voiceSaveOpenTool: Tool = {
  id: OPEN.save, version: 1, title: 'Save a designed voice (Gen library)',
  description: 'Keeps an open-model candidate (generatedVoiceId: gv_...) in the Gen voice library under a name. Result { voiceId } for audio.voice. No slot cap; link an existing ElevenLabs id with elevenlabsId so a character has both.',
  provider: localProvider, output: 'json', inputs: {},
  params: {
    generatedVoiceId: { type: 'string', required: true },
    name: { type: 'string', required: true, description: 'e.g. "Exit Punk".' },
    description: { type: 'text', required: true },
    ...saveExtra,
  },
  async run(ctx) {
    const p = ctx.params;
    if (!isGenVoiceId(p.generatedVoiceId)) throw new GenError('generatedVoiceId must be a Gen voice id (gv_..., from audio.voice-design); an ElevenLabs candidate id needs provider: "elevenlabs"');
    const v = saveVoice(p.generatedVoiceId, { name: p.name, description: p.description, elevenlabsId: p.elevenlabsId ?? null });
    ctx.result({ voiceId: v.id, voice: publicVoice(v) });
  },
};

export const voiceListOpenTool: Tool = {
  id: OPEN.list, version: 1, title: 'List Gen voices',
  description: 'The voices in the Gen voice library (open models): id, name, status, description, model, recipe, whether it has a reference clip, and its linked ElevenLabs id. project defaults to the caller\'s; "*" lists all.',
  provider: localProvider, output: 'json', inputs: {},
  params: {
    includePremade: { type: 'boolean', default: false, description: 'Unused by the open path.', advanced: true },
    ...listExtra,
  },
  async run(ctx) {
    const project = ctx.params.project === '*' ? undefined : ctx.params.project ?? ctx.job.project;
    const list = listVoices({ project }).filter((v) => ctx.params.candidates === true || v.status === 'saved').map(publicVoice);
    ctx.result({ count: list.length, voices: list });
  },
};

export const voiceDeleteOpenTool: Tool = {
  id: OPEN.delete, version: 1, title: 'Delete a Gen voice',
  description: 'Deletes a voice from the Gen voice library (its recipe and reference clip). Noted in the job log.',
  provider: localProvider, output: 'json', inputs: {},
  params: { voiceId: { type: 'string', required: true }, confirm: { type: 'boolean', default: false, advanced: true }, ...deleteExtra },
  async run(ctx) {
    if (!isGenVoiceId(ctx.params.voiceId)) throw new GenError('voiceId must be a Gen voice id (gv_..., from audio.voice-list); an ElevenLabs voice id needs provider: "elevenlabs"');
    const v = dropVoice(String(ctx.params.voiceId));
    ctx.log(`deleted Gen voice ${v.id} "${v.name}" (${JSON.stringify(v.recipe)})`);
    ctx.result({ deleted: true, voiceId: v.id, name: v.name, description: v.description });
  },
};

export const voiceCloneTool: Tool = {
  id: 'audio.voice-clone', version: 1, title: 'Clone a voice from a sample',
  description: 'Saves a 3 to 10 second sample as a voice in the Gen voice library (input reference; referenceText is what it says, better for quality). The clip is cleaned to 24 kHz mono and kept as the voice\'s reference; any cloning model (Qwen3-TTS, VoxCPM2, Chatterbox, MOSS-TTS) then speaks in it with audio.voice (voice: gv_...). Only clone voices you have the rights to. No GPU.',
  provider: localProvider, output: 'json', inputs: { reference: { kind: 'audio', required: true, description: 'The sample (3 to 10 seconds, one speaker, clean).' } },
  params: {
    name: { type: 'string', required: true },
    description: { type: 'text', description: 'Who it is.' },
    referenceText: { type: 'string', description: 'What the sample says.' },
    language: { type: 'string', description: 'Language code (default en).', advanced: true },
    elevenlabsId: { type: 'string', advanced: true, description: 'Link an ElevenLabs voice id for fallback.' },
  },
  async run(ctx) {
    const p = ctx.params;
    const src = ctx.inputs.reference as string;
    const len = await durationOf(src, ctx.signal);
    if (len < 2.5) throw new GenError(`The sample is ${len.toFixed(1)} s; a clone needs 3 to 10 seconds`);
    const out = ctx.tmp('reference.wav');
    await ff(['-y', '-i', src, '-t', '12', '-ac', '1', '-ar', '24000', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1', '-c:a', 'pcm_s16le', out], { signal: ctx.signal });
    const a = await analyze(out, { signal: ctx.signal });
    const verdict = judge(a);
    if (a.silent || a.clipped) throw new GenError(`The sample is not usable: ${verdict.problems.join('; ')}`);
    const v = createVoice({ project: ctx.job.project, name: p.name, description: p.description ?? '', model: 'clone', language: p.language ?? 'en', recipe: { kind: 'clone', seconds: a.seconds }, refAudio: fs.readFileSync(out), refExt: '.wav', refText: p.referenceText ?? '', elevenlabsId: p.elevenlabsId ?? null });
    ctx.result({ voiceId: v.id, voice: publicVoice(v), sample: { seconds: a.seconds, lufs: a.lufs }, problems: verdict.problems });
  },
};

// ---- audio.sfx-open --------------------------------------------------------------------------------------------

export const sfxOpenTool: Tool = {
  id: OPEN.sfx, version: 1, title: 'Sound effect (open models)',
  description: 'A sound effect on an open model (MOSS-SoundEffect; Stable Audio 3 Small-SFX when its ComfyUI template is imported). duration: seconds (empty: the model decides). loop: a seamless bed (made a little longer, crossfaded, loop point checked). count: takes; variants: a list of different prompts for one game event (e.g. six footsteps), each a take. Normalised, trimmed, converted. This is the default for audio.sfx (ElevenLabs only with provider "elevenlabs").',
  provider, server: 'ssh', family: (p) => `audio:${safeModel('sfx', ['sfx'], p.openModel)}`, guard: ({ params }) => void pickModel('sfx', params.loop ? ['sfx', 'loop'] : ['sfx'], params.openModel), output: 'audio', inputs: {},
  params: {
    text: { type: 'text', required: true },
    duration: { type: 'number', min: 0.5, max: 30, description: 'Seconds (empty: the model decides).' },
    loop: { type: 'boolean', default: false },
    influence: { type: 'number', min: 0, max: 1, default: 0.55, description: 'ElevenLabs only.', advanced: true },
    model: { type: 'string', default: 'eleven_text_to_sound_v2', advanced: true, description: 'ElevenLabs model (ignored by the open path).' },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    count: { type: 'integer', min: 1, max: 4, default: 1, description: 'Takes.' },
    ...voiceOpenParams,
    ...sfxExtra,
  },
  gpuSeconds: (p) => {
    const m = modelById(safeModel('sfx', ['sfx'], p.openModel))!;
    const takes = Array.isArray(p.variants) ? p.variants.length : Number(p.count) || 1;
    return Math.round(m.gpuLoadSeconds + 30 + (Number(p.duration) || 4) * m.gpuPerAudioSecond * takes);
  },
  async run(ctx) {
    try {
      const p = ctx.params;
      const model = pickModel('sfx', p.loop ? ['sfx', 'loop'] : ['sfx'], p.openModel);
      const prompts: string[] = Array.isArray(p.variants) && p.variants.length ? p.variants.map(String) : Array.from({ length: p.count }, () => String(p.text));
      if (prompts.length > 12) throw new GenError('variants: up to 12');
      const xf = p.crossfade ?? 1;
      // A loop is made longer by its crossfade, which is then eaten by the join.
      const items = prompts.map((t, i) => ({ id: `take${i}`, text: Array.isArray(p.variants) ? `${p.text}, ${t}` : t, seconds: p.duration ? p.duration + (p.loop ? xf : 0) : undefined, loop: p.loop === true, seed: ctx.seed(i), language: 'en' }));
      const s = await synthesize(ctx, { model, task: 'sfx', items });
      const takes: any[] = [];
      for (const [i, it] of s.items.entries()) {
        let file = it.file;
        let loopInfo: any = null;
        if (p.loop) {
          const looped = ctx.tmp(`loop-${i}.wav`);
          loopInfo = { ...(await makeLoop(file, looped, { crossfade: xf }, ctx.signal)) };
          file = looped;
          loopInfo.check = await checkLoop(file, ctx.signal);
        }
        const f = await finish(ctx, file, `sfx-${i}`, 'sfx', p, p.loop ? { trimSilence: false } : {});
        const t = { take: i, prompt: items[i].text, seed: items[i].seed, seconds: f.analysis.seconds, lufs: f.analysis.lufs, ok: f.verdict.ok && (loopInfo?.check.ok ?? true), problems: [...f.verdict.problems, ...(loopInfo?.check.problems ?? [])], loop: loopInfo };
        takes.push(t);
        if (i >= ctx.done) await ctx.emit({ data: f.data, ext: f.ext, seed: items[i].seed, title: prompts.length > 1 ? `variant ${i + 1}` : 'sfx', meta: { model: model.id, ...t } });
      }
      ctx.result({ provider: 'open', model: model.id, takes, warnings: licenseNotes(model) });
    } catch (e) {
      throw e; // no silent ElevenLabs for sound effects: say provider "elevenlabs" to use it
    }
  },
};

// ---- audio.dialogue-open ---------------------------------------------------------------------------------------

export const dialogueOpenTool: Tool = {
  id: OPEN.dialogue, version: 1, title: "Table read (open models)",
  description: "A scene's dialogue on an open model: every line in its character's Gen voice (cast { who: gv_... }), each line with its own direction ({ who, text, direction }), laid on one track with gaps (gapMs; a line's pauseMs overrides) and returned with each line as its own clip and when it starts and ends, the shape audio.dialogue returns. Lines are spoken one by one (no overlap); [interrupting] and other ElevenLabs-only timing is not modelled.",
  provider, server: 'ssh', family: (p) => `audio:${safeModel('voice', ['speak'], p.openModel)}`, guard: ({ params }) => void pickModel('voice', ['speak'], params.openModel), output: 'audio', inputs: {},
  params: {
    lines: { type: 'json', required: true, description: '[{ who, text, direction?, pauseMs? }] in order', example: [{ who: 'The Mechanic', text: "You're late." }, { who: 'Exit Punk', text: "I'm eleven seconds late.", direction: 'out of breath' }] },
    cast: { type: 'json', description: '{ "Exit Punk": "gv_..." }', example: { 'The Mechanic': 'gv_voice', 'Exit Punk': 'gv_voice' } },
    stems: { type: 'boolean', default: true, description: 'Also each line as its own clip' },
    model: { type: 'string', default: 'eleven_v3', advanced: true, description: 'ElevenLabs model (ignored by the open path).' },
    format: { type: 'string', default: 'mp3_44100_128', advanced: true },
    count: { type: 'integer', min: 1, max: 3, default: 1, description: 'Takes (each a different read)' },
    ...voiceOpenParams,
    ...dialogueExtra,
  },
  gpuSeconds: (p) => {
    const chars = Array.isArray(p.lines) ? p.lines.reduce((n: number, l: any) => n + String(l?.text ?? '').length, 0) : 200;
    return speakGpuSeconds(modelById(safeModel('voice', ['speak'], p.openModel))!, chars, Number(p.count) || 1, p.verify === true);
  },
  async run(ctx) {
    try {
      const p = ctx.params;
      const lines = dialogueLines(p.lines, p.cast);
      const bad = lines.find((l) => !isGenVoiceId(l.voice));
      if (bad) throw new GenError(`line "${bad.text.slice(0, 30)}": ${bad.voice} is an ElevenLabs voice; the open table read needs Gen voices (gv_...). Use provider: "elevenlabs" for this scene.`);
      const sr = p.sampleRate ?? 44100;
      const takes: any[] = [];
      let verifySkipped: string | undefined;
      for (let t = ctx.done; t < p.count; t++) {
        const plans = lines.map((l, k) => planSpeak({ text: l.text, voice: l.voice, direction: (p.lines[k] as any)?.direction ?? p.direction, openModel: p.openModel, language: p.language }, { seed: (n) => ctx.seed(t * 100 + k + n) }));
        // One model per job: the first line's. A voice without a reference clip belongs to its own model, so mixed casts must share one.
        const model = plans[0].model;
        if (plans.some((x) => x.model.id !== model.id)) throw new GenError(`The cast needs different models (${[...new Set(plans.map((x) => x.model.id))].join(', ')}); give openModel or clone the voices from samples`);
        const items = plans.map((x, k) => ({ ...x.items[0], id: `line${k}` }));
        const s = await synthesize(ctx, { model, task: 'speak', items, asr: p.verify === true });
        verifySkipped ??= s.verifySkipped;
        const files: string[] = [];
        const segments: any[] = [];
        let at = 0;
        for (const [k, it] of s.items.entries()) {
          const clip = ctx.tmp(`d${t}-${k}.wav`);
          const post = await processAudio(it.file, clip, postOptions({ ...p, format: 'wav', sampleRate: sr }, ctx.job.project, 'voice'), ctx.signal);
          const len = post.after.seconds;
          const pause = ((p.lines[k] as any)?.pauseMs ?? p.gapMs ?? 250) / 1000;
          segments.push({ line: k, who: lines[k].who, text: lines[k].text, start: Math.round(at * 1000) / 1000, end: Math.round((at + len) * 1000) / 1000, wer: it.transcript !== undefined ? wordErrorRate(items[k].text, it.transcript) : null });
          files.push(clip);
          at += len + (k < lines.length - 1 ? pause : 0);
        }
        // The track: each clip followed by its gap, joined.
        const listFile = ctx.tmp(`d${t}.txt`);
        const parts: string[] = [];
        for (const [k, f] of files.entries()) {
          parts.push(`file '${f}'`);
          const pause = ((p.lines[k] as any)?.pauseMs ?? p.gapMs ?? 250) / 1000;
          if (k < files.length - 1 && pause > 0) {
            const sil = ctx.tmp(`d${t}-sil${k}.wav`);
            await ff(['-y', '-f', 'lavfi', '-i', `anullsrc=r=${sr}:cl=mono`, '-t', String(pause), '-c:a', 'pcm_s16le', sil], { signal: ctx.signal });
            parts.push(`file '${sil}'`);
          }
        }
        fs.writeFileSync(listFile, parts.join('\n'));
        const fmt = formatOf(p.format);
        const track = ctx.tmp(`dialogue-${t}.${fmt}`);
        await ff(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', fmt === 'mp3' ? 'libmp3lame' : fmt === 'ogg' ? 'libvorbis' : fmt === 'flac' ? 'flac' : 'pcm_s16le', ...(fmt === 'mp3' ? ['-q:a', '2'] : []), track], { signal: ctx.signal });
        const length = await durationOf(track, ctx.signal);
        await ctx.emit({ data: fs.readFileSync(track), ext: `.${fmt}`, title: t ? `dialogue (take ${t + 1})` : 'dialogue', meta: { seconds: length, segments, model: model.id } });
        if (p.stems) for (const sgm of segments) {
          const out = ctx.tmp(`line-${t}-${sgm.line}.${fmt}`);
          await cut(track, out, Math.max(0, sgm.start - 0.05), sgm.end + 0.08, { format: fmt }, ctx.signal);
          await ctx.emit({ data: fs.readFileSync(out), ext: `.${fmt}`, title: `line ${sgm.line + 1}: ${sgm.who}${t ? ` (take ${t + 1})` : ''}`, meta: { line: sgm.line, who: sgm.who, text: sgm.text, start: sgm.start, end: sgm.end } });
        }
        takes.push({ seconds: length, segments, model: model.id });
      }
      ctx.result({ provider: 'open', takes, seconds: takes[0]?.seconds, segments: takes[0]?.segments, ...(verifySkipped ? { verified: false, verifySkipped } : {}) });
    } catch (e) {
      const cast = Object.values((ctx.params.cast ?? {}) as Record<string, string>);
      if (!cast.length || cast.every(isGenVoiceId) || ctx.params.provider === 'open') throw e;
      await fallback(ctx, dialogueTool, e);
    }
  },
};

// ---- local tools: process, analyze, music loops ------------------------------------------------------------------

export const audioProcessTool: Tool = {
  id: 'audio.process', version: 1, title: 'Process audio (loudness, trim, fade, convert)',
  description: 'Post-processes a clip on the control server (ffmpeg, free): trim silence at both ends, fade in/out, loudness-normalise to a target (default: the product\'s from settings.audio.targetLufs, kind voice/sfx/music), resample, convert to wav / mp3 / ogg / flac. Returns the clip and the before and after measurements.',
  provider: localProvider, output: 'audio', inputs: { audio: { kind: 'audio', required: true } },
  params: {
    kind: { type: 'enum', values: ['voice', 'sfx', 'music'], default: 'voice', description: 'Picks the loudness target.' },
    format: { type: 'enum', values: ['wav', 'mp3', 'ogg', 'flac'], default: 'wav' },
    ...postParams,
    quality: { type: 'integer', min: 0, max: 9, description: 'mp3 -q:a / ogg -q:a.', advanced: true },
    fadeIn: { type: 'number', min: 0, max: 10, description: 'Fade in only, seconds.', advanced: true },
    fadeOut: { type: 'number', min: 0, max: 10, description: 'Fade out only, seconds.', advanced: true },
    channels: { type: 'integer', min: 1, max: 2, advanced: true },
  },
  async run(ctx) {
    const p = ctx.params;
    const o = postOptions({ ...p, trim: p.trim === true }, ctx.job.project, p.kind, { quality: p.quality, channels: p.channels, fadeIn: p.fadeIn ?? p.fade, fadeOut: p.fadeOut ?? p.fade });
    const out = ctx.tmp(`out.${o.format}`);
    const r = await processAudio(ctx.inputs.audio, out, o, ctx.signal);
    await ctx.emit({ data: fs.readFileSync(out), ext: `.${o.format}`, title: 'audio', meta: { before: r.before, after: r.after } });
    ctx.result({ before: r.before, after: r.after, options: o });
  },
};

export const audioAnalyzeTool: Tool = {
  id: 'audio.analyze', version: 1, title: 'Check audio (LUFS, clipping, silence, loop)',
  description: 'The automatic gate for generated audio, on the control server (free): integrated loudness (LUFS), true peak, clipping, leading and trailing silence, length; loop: true also checks the loop point (click and level jump from the end to the start). Returns the measurements and a verdict { ok, problems }.',
  provider: localProvider, output: 'json', inputs: { audio: { kind: 'audio', required: true } },
  params: {
    targetLufs: { type: 'number', min: -40, max: -5, description: 'Fails when the loudness is further than tolerance from this.' },
    tolerance: { type: 'number', min: 0.5, max: 10, default: 2, advanced: true },
    maxSilence: { type: 'number', min: 0.05, max: 10, default: 0.6, advanced: true, description: 'Seconds of silence at either end that count as a problem.' },
    loop: { type: 'boolean', default: false },
  },
  async run(ctx) {
    const p = ctx.params;
    const a = await analyze(ctx.inputs.audio, { signal: ctx.signal });
    const verdict = judge(a, { targetLufs: p.targetLufs, toleranceLufs: p.tolerance, maxSilence: p.maxSilence });
    const loop = p.loop ? await checkLoop(ctx.inputs.audio, ctx.signal) : null;
    const problems = [...verdict.problems, ...(loop?.problems ?? [])];
    ctx.result({ ...a, loop, ok: !problems.length, problems });
  },
};

export const musicLoopTool: Tool = {
  id: 'audio.music-loop', version: 1, title: 'Music: seamless loop, or intro + loop',
  description: 'Turns a music clip (audio.music) into game-ready parts on the control server (free). mode loop: the tail is crossfaded into the head so the clip repeats without a click (length shrinks by the crossfade), with the loop-point check. mode intro-loop: the first introSeconds become the intro, the rest the seamless loop. mode check: only reports how well the clip loops as it is. Instrumental vs lyrics is chosen at audio.music (its lyrics param). Stems and cover/edit need the ACE-Step workflows (docs/audio.md "Music").',
  provider: localProvider, output: 'audio', inputs: { audio: { kind: 'audio', required: true } },
  params: {
    mode: { type: 'enum', values: ['loop', 'intro-loop', 'check'], default: 'loop' },
    crossfade: { type: 'number', min: 0.2, max: 8, default: 2, description: 'Crossfade seconds.' },
    introSeconds: { type: 'number', min: 1, max: 120, description: 'intro-loop: where the intro ends.' },
    format: { type: 'enum', values: ['wav', 'mp3', 'ogg', 'flac'], default: 'wav' },
    normalize: postParams.normalize,
  },
  async run(ctx) {
    const p = ctx.params;
    const src = ctx.inputs.audio as string;
    if (p.mode === 'check') return ctx.result({ loop: await checkLoop(src, ctx.signal) });
    let body = src;
    let intro: string | null = null;
    if (p.mode === 'intro-loop') {
      if (!p.introSeconds) throw new GenError('introSeconds is required for intro-loop');
      intro = ctx.tmp('intro.wav');
      body = ctx.tmp('body.wav');
      await cut(src, intro, 0, p.introSeconds, { format: 'wav' }, ctx.signal);
      await cut(src, body, p.introSeconds, null, { format: 'wav' }, ctx.signal);
    }
    const looped = ctx.tmp('loop.wav');
    const info = await makeLoop(body, looped, { crossfade: p.crossfade }, ctx.signal);
    const check = await checkLoop(looped, ctx.signal);
    const o = postOptions({ ...p, trim: false }, ctx.job.project, 'music');
    const done = async (file: string, name: string) => {
      const out = ctx.tmp(`${name}-final.${o.format}`);
      await processAudio(file, out, o, ctx.signal);
      return fs.readFileSync(out);
    };
    if (intro) await ctx.emit({ data: await done(intro, 'intro'), ext: `.${o.format}`, title: 'intro' });
    await ctx.emit({ data: await done(looped, 'loop'), ext: `.${o.format}`, title: 'loop', meta: { ...info, check } });
    ctx.result({ mode: p.mode, ...info, check, parts: intro ? ['intro', 'loop'] : ['loop'] });
  },
};

/** Every open-audio tool (src/tools/index.ts adds these). */
export const AUDIO_OPEN_TOOLS: Tool[] = [voiceOpenTool, voiceDesignOpenTool, voiceSaveOpenTool, voiceListOpenTool, voiceDeleteOpenTool, voiceCloneTool, sfxOpenTool, dialogueOpenTool, audioProcessTool, audioAnalyzeTool, musicLoopTool];

