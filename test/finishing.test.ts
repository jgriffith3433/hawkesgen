// Finishing (docs/finishing.md): sound for a cut, the pace, the grade, delivery and the world export pack. The plans are
// pure and checked directly; the tools run for real on ffmpeg-made clips, with a fake Gen whose children are either the
// real CPU tools run in-process or, for the GPU ones (music, ambience beds, the final upscale), ffmpeg tones. Claude is
// mocked. No GPU, no money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-finish-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const { putAsset, getAsset } = await import('../src/library.ts');
const { probeMedia } = await import('../src/tools/compose.ts');
const { analyze } = await import('../src/audio/post.ts');
const { applyOps, newDoc } = await import('../src/timeline.ts');
const chain = await import('../src/tools/chain.ts');
const fin = await import('../src/tools/finishing.ts');
const sound = await import('../src/finishing/sound.ts');
const grade = await import('../src/finishing/grade.ts');
const del = await import('../src/finishing/deliver.ts');
const cut = await import('../src/finishing/cut.ts');
const exp = await import('../src/finishing/export.ts');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-src-'));
const ff = (...args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const PROJECT = 'usr_finish';

// ------------------------------------------------------------------------------------------------ a fake Gen

/** Runs a tool here with a fake context; outputs go into the library like a real job's. */
async function runTool(id: string, params: Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  const tool = getTool(id);
  assert.ok(tool, `no tool ${id}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `run-${id.replace('.', '-')}-`));
  const resolve = (v: unknown): unknown => Array.isArray(v) ? v.map(resolve) : typeof v === 'string' && v.startsWith('asset:') ? getAsset(v.slice(6))!.path : v;
  const outputs: { asset: string; kind: string; title?: string }[] = [];
  const logs: string[] = [];
  let result: any = null;
  await tool!.run({
    job: { id: `j_${id}`, client: 't', project: PROJECT, tool: id, labels: {} }, params: validateParams(tool!, params),
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, resolve(v)])),
    done: 0, outputs: [], signal: new AbortController().signal, step: () => {}, log: (l: string) => logs.push(l), tmp: (n: string) => path.join(work, n),
    emit: async (o: any) => {
      const a = putAsset({ data: o.data, ext: o.ext, client: 't', project: PROJECT, tool: id, title: o.title, meta: o.meta, recipe: { tool: id, version: tool!.version, params, inputs: {} } });
      outputs.push({ asset: a.id, kind: a.kind, title: o.title });
    },
    result: (v: any) => { result = v; }, seed: () => 1, usage: () => {}, python: async () => '',
  } as any);
  return { id: `j_${id}_${outputs[0]?.asset ?? 'x'}`, tool: id, status: 'done', outputs, result, logs };
}

/** GPU tools faked with ffmpeg. */
function fakeGpu(tool: string, p: any): string {
  const out = path.join(src, `${tool.replace('.', '-')}-${Math.random().toString(36).slice(2)}`);
  if (tool === 'audio.music') {
    // A pulse on every beat over a low tone, as long as asked.
    const beat = 60 / (p.bpm ?? 95);
    ff('-f', 'lavfi', '-i', `sine=f=110:d=${p.seconds}`, '-f', 'lavfi', '-i', `sine=f=880:d=${p.seconds}`, '-filter_complex', `[1:a]volume='if(lt(mod(t,${beat.toFixed(4)}),0.05),0.6,0)':eval=frame[c];[0:a]volume=0.4[b];[b][c]amix=inputs=2:normalize=0`, '-ar', '48000', `${out}.wav`);
    return `${out}.wav`;
  }
  if (tool === 'audio.sfx') {
    ff('-f', 'lavfi', '-i', `anoisesrc=c=pink:d=${p.duration}:a=0.2`, '-ar', '48000', `${out}.wav`);
    return `${out}.wav`;
  }
  throw new Error(`no fake for ${tool}`);
}

const GPU = new Set(['audio.music', 'audio.sfx', 'video.upscale', 'image.restore']);
function fakeGen() {
  const calls: { tool: string; spec: any }[] = [];
  chain._setChainClient(() => ({
    submit: async (tool: string, spec: any) => {
      calls.push({ tool, spec });
      if (tool === 'video.upscale' || tool === 'image.restore') return { id: `j_queued_${calls.length}`, tool, status: 'queued', outputs: [] };
      if (GPU.has(tool)) {
        const file = fakeGpu(tool, spec.params);
        const a = putAsset({ data: fs.readFileSync(file), ext: '.wav', client: 'gen', project: PROJECT, tool, recipe: { tool, version: 1, params: spec.params, inputs: {} } });
        return { id: `j_${calls.length}`, tool, status: 'done', outputs: [{ asset: a.id, kind: a.kind }], result: null };
      }
      return runTool(tool, spec.params, spec.inputs);
    },
    wait: async () => { throw new Error('children finish at once here'); },
  }));
  return calls;
}

fin._setFinishingAsk(async (q: any) => {
  if (/trailer/i.test(q.prompt)) {
    return { text: JSON.stringify({ title: 'The Lantern', tagline: 'Some lights should stay out.', moments: [{ start: 0.2, end: 2.2, role: 'hook' }, { start: 3.2, end: 5.4, role: 'build' }, { start: 6.3, end: 8.6, role: 'climax' }], cards: [{ after: 0, text: 'This winter' }] }), model: 'mock', usage: {}, cost: 0, billing: 'api' } as any;
  }
  return { text: JSON.stringify({ picks: [{ index: 4, why: 'a clear face', title: 'Who Is There?' }, { index: 4, why: 'duplicate' }, { index: 1, why: 'action' }] }), model: 'mock', usage: {}, cost: 0, billing: 'api' } as any;
});

// ------------------------------------------------------------------------------------------------ sound: pure

test('fitTempo: picks the whole-number tempo whose beats land on the cuts, inside the mood\'s range', () => {
  // Cuts on the half second: 120 BPM puts every one on a beat; action's range includes it.
  const fit = sound.fitTempo([{ at: 2 }, { at: 3.5 }, { at: 6 }, { at: 7.5 }, { at: 10 }], { mood: 'action' });
  assert.equal(fit.bpm, 120);
  assert.equal(fit.score, 1);
  assert.ok(fit.hits.every((h) => h.onBeat));
  assert.deepEqual(fit.hits.map((h) => h.beat), [4, 7, 12, 15, 20]);
  // A calm scene never gets an action tempo, whatever its cuts.
  const calm = sound.fitTempo([{ at: 2 }, { at: 3.5 }, { at: 6 }], { mood: 'calm' });
  assert.ok(calm.bpm >= 60 && calm.bpm <= 92, String(calm.bpm));
  // Weight decides between cuts that can't all land: the story beat (3) wins over two plain cuts.
  const w = sound.fitTempo([{ at: 4.0, weight: 3 }, { at: 4.31, weight: 1 }], { range: [100, 130] });
  assert.ok(w.hits[0].onBeat, 'the weighted beat lands');
  assert.ok(Math.abs(4.0 / (60 / w.bpm) - Math.round(4.0 / (60 / w.bpm))) * (60 / w.bpm) <= 0.06);
});

test('snapCuts and cutPointsFrom: cuts nudge to beats; story beats weigh more', () => {
  assert.deepEqual(sound.snapCuts([1.9, 3.3], 0.5), [{ from: 1.9, to: 2 }, { from: 3.3, to: 3.5 }]);
  assert.deepEqual(sound.snapCuts([1.6], 0.5, 0.05), [{ from: 1.6, to: 1.6 }], 'too far: left alone');
  const pts = sound.cutPointsFrom([{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }], [{ at: 6.1, mood: 'tense' }, { at: 8 }]);
  assert.deepEqual(pts, [{ at: 3, weight: 1 }, { at: 6, weight: 3 }, { at: 8, weight: 2 }]);
});

test('planSections: a new section on the bar nearest each mood change; short ones merge; one request per section', () => {
  // 120 BPM: a bar is 2 s.
  const s = sound.planSections(30, [{ at: 0, mood: 'mysterious' }, { at: 9.2, mood: 'tense', label: 'the chase' }, { at: 10.5, mood: 'action' }, { at: 24.1, mood: 'hopeful' }], { bpm: 120 });
  assert.deepEqual(s.map((x) => [x.start, x.end, x.mood]), [[0, 10, 'mysterious'], [10, 24, 'action'], [24, 30, 'hopeful']]);
  assert.match(s[1].prompt, /action mood, 120 BPM, instrumental/);
  const reqs = sound.musicRequests(s, { bpm: 120, crossfade: 1 });
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0].params.seconds, 12, '10 s plus the crossfade and a margin, rounded up');
  assert.equal(reqs[2].params.seconds, 10, 'at least 10 s (the music model\'s floor)');
  assert.equal(reqs[1].params.bpm, 120);
  const one = sound.planSections(20, [], { bpm: 90, mood: 'calm' });
  assert.equal(one.length, 1);
  assert.equal(sound.musicRequests(one, { bpm: 90, crossfade: 1 })[0].params.seconds, 21);
  const g = sound.stitchGraph(s, 1);
  assert.match(g, /\[0:a\]atrim=end=11,/);
  assert.match(g, /\[2:a\]atrim=end=6,/);
  assert.match(g, /acrossfade=d=1/);
  assert.match(g, /atrim=end=30,afade=t=out/);
});

test('planAmbience: consecutive shots in one place share a stretch; one bed per place', () => {
  const plan = sound.planAmbience([
    { place: 'harbor', start: 0, end: 4, description: 'a windy night harbor' }, { place: 'harbor', start: 4, end: 7 },
    { place: 'tavern', start: 7, end: 12 }, { place: 'harbor', start: 12, end: 15 },
  ]);
  assert.deepEqual(plan.spans, [{ place: 'harbor', start: 0, end: 7 }, { place: 'tavern', start: 7, end: 12 }, { place: 'harbor', start: 12, end: 15 }]);
  assert.equal(plan.beds.length, 2);
  assert.match(plan.beds[0].prompt, /windy night harbor.*no music, no voices/);
  assert.equal(plan.beds[0].seconds, 7);
  assert.equal(plan.length, 15);
  assert.match(sound.ambienceGraph(plan), /aloop=loop=-1/);
});

test('the mix: dialogue first, music and ambience ducked under it, effects not; -14 LUFS, -1 dBTP', () => {
  assert.deepEqual(sound.MIX_ORDER, ['dialogue', 'music', 'ambience', 'sfx']);
  assert.deepEqual(sound.stemTargets(['dialogue', 'music', 'ambience', 'sfx']), { dialogue: -18, music: -27, ambience: -36, sfx: -22 });
  assert.deepEqual(sound.stemTargets(['music', 'sfx']), { music: -16, sfx: -11 }, 'no dialogue: music leads');
  const g = sound.mixGraph(['dialogue', 'music', 'ambience', 'sfx'], { dialogue: 2, music: -3 });
  assert.match(g, /\[g_music\]\[key_music\]sidechaincompress=.*ratio=6/);
  assert.match(g, /\[g_ambience\]\[key_ambience\]sidechaincompress=.*ratio=3/);
  assert.doesNotMatch(g, /g_sfx\]\[key/);
  assert.match(g, /\[dia\]\[d_music\]\[d_ambience\]\[g_sfx\]amix=inputs=4/);
  const m = sound.masterFilters({ lufs: -20, truePeak: -8 });
  assert.deepEqual(m, ['volume=6.00dB', 'alimiter=limit=0.8414:level=false:attack=2:release=60']);
  assert.equal(sound.MIX.targetLufs, -14);
});

// ------------------------------------------------------------------------------------------------ grade: pure

test('gradeFilters: settings become ffmpeg filters in order; neutral is nothing', () => {
  assert.deepEqual(grade.gradeFilters({ params: {} }), []);
  assert.ok(grade.isNeutral({ params: { contrast: 1, saturation: 1 } }));
  const f = grade.gradeFilters({ params: { contrast: 1.2, saturation: 0.8, gamma: 1.1, warmth: 0.4, lift: 0.05, gain: 0.9 }, grain: 0.5, vignette: 0.4 });
  assert.deepEqual(f, [
    'colorlevels=romin=0.05:gomin=0.05:bomin=0.05:romax=0.9:gomax=0.9:bomax=0.9:rimax=1:gimax=1:bimax=1',
    'eq=contrast=1.2:saturation=0.8:gamma=1.1',
    'colorbalance=rs=0.05:bs=-0.05:rm=0.1:gm=0:bm=-0.1:rh=0.04:bh=-0.04',
    'vignette=angle=0.4',
    'noise=c0s=14:c0f=t+u',
  ]);
  // Out-of-range values are clamped, gain over 1 scales the input white point instead.
  assert.match(grade.gradeFilters({ params: { contrast: 9, gain: 1.25 } }).join(';'), /rimax=0.8.*eq=contrast=2/);
  assert.deepEqual(grade.gradeFilters({ lutFile: 'C:\\luts\\teal orange.cube' }), ["lut3d=file='C\\:/luts/teal orange.cube'"]);
  assert.deepEqual(grade.gradeFromWorld({ grade: { params: { warmth: 0.2, grain: 0.3 } } }), { params: { warmth: 0.2, grain: 0.3 }, grain: 0.3, vignette: undefined });
  assert.equal(grade.gradeFromWorld({ grade: null }), null);
  assert.deepEqual(grade.parseGrade('{"warmth":0.3}'), { params: { warmth: 0.3 }, grain: undefined, vignette: undefined });
  for (const [name, g] of Object.entries(grade.GRADE_PRESETS)) if (name !== 'natural') assert.ok(grade.gradeFilters(g).length, name);
});

// ------------------------------------------------------------------------------------------------ delivery: pure

test('planReframe: the largest crop of the ratio, panned to the subject, smoothed', () => {
  const c = del.planReframe(1920, 1080, '9:16');
  assert.equal(c.crop.w, 608);
  assert.equal(c.crop.h, 1080);
  assert.equal(c.crop.x, '656');
  assert.deepEqual(c.out, { width: 1080, height: 1920 });
  assert.equal(c.source, 'center');
  const right = del.planReframe(1920, 1080, '9:16', [{ t: 0, x: 0.95 }]);
  assert.equal(right.crop.x, '1312', 'held inside the frame');
  const sq = del.planReframe(1920, 1080, '1:1', [{ t: 0, x: 0.25 }]);
  assert.deepEqual([sq.crop.w, sq.crop.h, sq.crop.x], [1080, 1080, '0']);
  const tall = del.planReframe(1080, 1920, '16:9');
  assert.deepEqual([tall.crop.w, tall.crop.h, tall.crop.y], [1080, 608, '656']);
  assert.deepEqual(del.planReframe(1920, 1080, '4:5').crop.w, 864);
  // A moving subject: the pan is limited to 0.25 frame widths a second.
  const moving = del.planReframe(1920, 1080, '9:16', [{ t: 0, x: 0.2 }, { t: 1, x: 0.8 }]);
  assert.match(moving.crop.x, /^if\(lt\(t,0\),80,if\(lt\(t,1\),80\+\(480\)\*\(t-0\)\/1,560\)\)$/);
  assert.match(moving.filter, /^crop=608:1080:'if/);
  // A small source isn't blown up past 2x.
  assert.deepEqual(del.planReframe(640, 360, '9:16').out, { width: 404, height: 718 });
  assert.deepEqual(del.subjectFromCast([{ t: 0, xs: [0.3, 0.7] }, { t: 1, xs: [] }]), [{ t: 0, x: 0.5 }]);
  assert.throws(() => del.planReframe(1920, 1080, '3:2'));
});

test('captions, credits and thumbnails picks', () => {
  const caps = del.parseCaptions('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nWho is there?\n\n2\n00:00:03,200 --> 00:00:04,000 align:start\nOnly me.\n');
  assert.deepEqual(caps, [{ start: 1, end: 2.5, text: 'Who is there?' }, { start: 3.2, end: 4, text: 'Only me.' }]);
  assert.deepEqual(del.shiftCaptions(caps, 3, 6.5), [{ start: 4, end: 5.5, text: 'Who is there?' }, { start: 6.2, end: 6.5, text: 'Only me.' }]);
  const cr = del.planCredits({ title: 'The Lantern', world: 'Frostmoon', story: 'Smugglers', cast: [{ character: 'Maya' }, { character: 'Tomas' }], by: 'J' });
  assert.equal(cr.title, 'The Lantern');
  assert.equal(cr.subtitle, 'Smugglers · A story of Frostmoon');
  assert.deepEqual(cr.lines, ['Starring', 'Maya', 'Tomas', '', 'Created by J', '']);
  assert.equal(cr.madeWith, 'Made with Hawkes Gen');
  const ev = del.creditEvents(cr, 6);
  assert.equal(ev.length, 3);
  assert.equal(ev[0].text, 'Starring\nMaya\nTomas');
  assert.equal(ev[2].text, 'Made with Hawkes Gen');
  const ass = del.assScript(1280, 720, ev);
  assert.match(ass, /PlayResY: 720/);
  assert.match(ass, /Dialogue: 0,0:00:00.10,0:00:01.90,Credit,,0,0,0,,\{\\fad\(400,400\)\}Starring\\NMaya\\NTomas/);
  assert.deepEqual(del.settlePicks({ picks: [{ index: 4, why: 'a' }, { index: 4, why: 'dup' }, { index: 99, why: 'x' }] }, 9).map((p) => p.index), [4, 1, 7]);
  assert.deepEqual(del.candidateTimes(9, { count: 3 }), [1.5, 4.5, 7.5]);
});

test('settleTrailer: moments inside the episode, no overlaps, cut to fit the length', () => {
  const plan = del.settleTrailer({
    title: 'X', moments: [{ start: 0, end: 10 }, { start: 5, end: 12 }, { start: 20, end: 40 }, { start: 50, end: 50.3 }, { start: 55, end: 70 }],
    cards: [{ after: 0, text: 'This winter' }, { after: 9, text: 'bad' }],
  }, 60, { seconds: 30, title: 'X' });
  assert.equal(plan.moments.length, 3, 'overlap, too short dropped');
  assert.equal(plan.moments[2].end, 60, 'clamped to the episode');
  assert.equal(plan.cards.length, 1);
  assert.ok(plan.seconds <= 30.01, String(plan.seconds));
  assert.ok(plan.moments.every((m) => m.end - m.start >= 0.8));
  assert.throws(() => del.settleTrailer({ moments: [] }, 60, { seconds: 30, title: 'X' }));
});

// ------------------------------------------------------------------------------------------------ the pace: pure

test('planPace: trims air, an L-cut and a J-cut, as ops applyOps takes in one go', () => {
  const doc = newDoc('Scene');
  doc.tracks.find((t) => t.id === 'V1')!.magnetic = true;
  doc.fps = 30;
  doc.clips = [
    { id: 'c_shot1', track: 'V1', kind: 'video', asset: 'a1', start: 0, in: 0, out: 5, duration: 5 },
    { id: 'c_shot2', track: 'V1', kind: 'video', asset: 'a2', start: 5, in: 0, out: 4, duration: 4 },
    { id: 'c_shot3', track: 'V1', kind: 'video', asset: 'a3', start: 9, in: 0, out: 6, duration: 6 },
    // Line 1 starts 1.5 s into shot 1 (air), ends right at its end (an L-cut). Line 2 opens shot 3 (a J-cut).
    { id: 'c_line1', track: 'A2', kind: 'audio', asset: 'v1', start: 1.5, in: 0, out: 3.4, duration: 3.4 },
    { id: 'c_line2', track: 'A2', kind: 'audio', asset: 'v2', start: 9.1, in: 0, out: 2, duration: 2 },
  ] as any;
  const plan = cut.planPace(doc, { leadFrames: 6, maxSilent: 2.5 });
  const kinds = plan.changes.map((c) => `${c.clip}:${c.kind}`);
  assert.ok(kinds.includes('c_shot1:trim-head'), kinds.join(' '));
  assert.ok(kinds.includes('c_shot1:l-cut'), kinds.join(' '));
  assert.ok(kinds.includes('c_shot2:trim-tail'), 'a silent shot held 2.5 s');
  assert.ok(kinds.includes('c_line2:j-cut'), kinds.join(' '));
  assert.ok(kinds.includes('c_shot3:trim-tail'), 'air after the last line');
  const s1 = plan.ops.find((o) => o.op === 'trim' && o.id === 'c_shot1')!;
  assert.equal(s1.in, 1.15, 'keeps 0.35 s before the line');
  assert.equal(s1.out, 4.8, 'cut 6 frames (0.2 s) early: the line trails over shot 2');
  const r = applyOps(doc, plan.ops);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const at = (id: string) => r.doc.clips.find((c) => c.id === id)!;
  assert.equal(at('c_shot2').start, 3.65, 'shots back to back after the trims');
  assert.equal(at('c_line1').start, 0.35, 'line 1 moved with its shot');
  assert.ok(at('c_line1').start + 3.4 > at('c_shot2').start, 'and runs past the cut (L-cut)');
  assert.ok(at('c_line2').start < at('c_shot3').start, 'line 2 starts before its shot (J-cut)');
  assert.equal(Math.round((at('c_shot3').start - at('c_line2').start) * 30), 6);
  assert.ok(plan.after < plan.before);
});

test('planPace: beats that name shots put them in story order', () => {
  const doc = newDoc('Scene');
  doc.tracks.find((t) => t.id === 'V1')!.magnetic = true;
  doc.clips = [
    { id: 'c_aaa', track: 'V1', kind: 'video', asset: 'x', start: 0, in: 0, out: 2, duration: 2 },
    { id: 'c_bbb', track: 'V1', kind: 'video', asset: 'y', start: 2, in: 0, out: 2, duration: 2 },
    { id: 'c_ccc', track: 'V1', kind: 'video', asset: 'z', start: 4, in: 0, out: 2, duration: 2 },
  ] as any;
  const plan = cut.planPace(doc, { beats: [{ clip: 'c_ccc' }, { clip: 'c_aaa' }] });
  const r = applyOps(doc, plan.ops);
  assert.deepEqual(r.doc.clips.filter((x) => x.track === 'V1').sort((p, q) => p.start - q.start).map((x) => x.id), ['c_ccc', 'c_aaa', 'c_bbb']);
});

// ------------------------------------------------------------------------------------------------ the tools on real files

const shots: string[] = [];
const lines: string[] = [];
if (haveFfmpeg) {
  for (const [i, color] of ['red', 'green', 'blue'].entries()) {
    const f = path.join(src, `shot${i}.mp4`);
    ff('-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24:d=3`, '-f', 'lavfi', '-i', `sine=f=${300 + i * 100}:d=3`, '-vf', `drawbox=c=${color}@0.4:t=fill`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f);
    shots.push(f);
    const l = path.join(src, `line${i}.wav`);
    ff('-f', 'lavfi', '-i', `sine=f=${500 + i * 60}:d=1.4`, '-af', 'volume=0.3', '-ar', '48000', l);
    lines.push(l);
  }
}

test('a 3-shot cut: scored music, a mix at -14 LUFS, a world grade, titles, captions and a 9:16 version, all through tools', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const calls = fakeGen();
  exp._setWorldSource((_p, id) => (id === 'sn_world01' ? {
    worldId: id, title: 'Frostmoon', canon: [], characters: [{ id: 'c1', title: 'Maya', description: '', refs: [] }, { id: 'c2', title: 'Tomas', description: '', refs: [] }], places: [], props: [],
    look: { style: '', negative: '', palette: [], board: [], grade: { params: { warmth: -0.3, contrast: 1.1, saturation: 0.9, vignette: 0.3 } } },
  } : null));
  try {
    // 1. The cut, graded by the world.
    // The world's grade is read at submit (compose's admit), so compose needs no library where it runs.
    const asked = { timeline: { clips: [{ clip: 0 }, { clip: 1, transition: 'crossfade', seconds: 0.5 }, { clip: 2 }] }, width: 640, height: 360, fps: 24, world: 'sn_world01', poster: false };
    const admitted = getTool('video.compose')!.admit!({ params: asked, client: { id: 't', role: 'user', projects: [PROJECT] }, project: PROJECT, customer: false });
    assert.deepEqual(admitted.grade, { params: { warmth: -0.3, contrast: 1.1, saturation: 0.9, vignette: 0.3 }, vignette: 0.3 });
    const composed = await runTool('video.compose', admitted, { clips: shots });
    assert.ok(composed.result.grade?.params?.warmth === -0.3, 'the world\'s grade');
    const spans = composed.result.clips.map((c: any) => ({ start: c.start, end: c.end }));
    const length = composed.result.duration;
    // 2. Music written to it.
    const scored = await runTool('audio.score', { spans, length, beats: [{ at: 0, mood: 'mysterious' }, { at: spans[2].start, mood: 'tense' }] });
    assert.ok(scored.result.bpm >= 40 && scored.result.bpm <= 220);
    assert.equal(scored.result.hits.cuts.length, 2);
    assert.ok(Math.abs(scored.result.seconds - length) < 0.1, `${scored.result.seconds} vs ${length}`);
    assert.ok(calls.filter((c) => c.tool === 'audio.music').every((c) => c.spec.params.bpm === scored.result.bpm), 'every section at the fitted tempo');
    // 3. Ambience per place.
    const amb = await runTool('audio.ambience', { shots: [{ place: 'harbor', start: 0, end: spans[1].end }, { place: 'tavern', start: spans[2].start, end: length }], length });
    assert.equal(calls.filter((c) => c.tool === 'audio.sfx').length, 2);
    // 4. The mix, on the cut.
    const mixed = await runTool('audio.mix', { placement: { dialogue: [{ start: 0.5 }, { start: spans[1].start + 0.3 }, { start: spans[2].start + 0.2 }] } },
      { dialogue: lines, music: `asset:${scored.outputs[0].asset}`, ambience: `asset:${amb.outputs[0].asset}`, video: `asset:${composed.outputs[0].asset}` });
    assert.ok(mixed.result.ok, mixed.result.problems.join('; '));
    assert.ok(Math.abs(mixed.result.lufs - -14) <= 1, String(mixed.result.lufs));
    assert.ok(mixed.result.truePeak <= -0.5, String(mixed.result.truePeak));
    assert.deepEqual(mixed.result.stems.map((s: any) => s.kind), ['dialogue', 'music', 'ambience']);
    const mixWav = await analyze(getAsset(mixed.outputs[0].asset)!.path);
    assert.ok(Math.abs(mixWav.lufs! - -14) <= 1);
    // 5. Titles, credits and captions.
    const titled = await runTool('video.titles', { title: 'The Lantern', world: 'sn_world01', captionList: [{ start: 0.5, end: 2, text: 'Who is there?' }], captionMode: 'both' }, { video: `asset:${mixed.outputs[1].asset}` });
    assert.deepEqual(titled.outputs.map((o) => o.title), ['master', 'captions (vtt)', 'captions (srt)']);
    assert.deepEqual(titled.result.credits.lines.slice(0, 3), ['Starring', 'Maya', 'Tomas']);
    const master = await probeMedia(getAsset(titled.outputs[0].asset)!.path);
    assert.ok(Math.abs(master.duration - (length + titled.result.titleSeconds + titled.result.creditSeconds)) < 0.3, `${master.duration}`);
    assert.match(fs.readFileSync(getAsset(titled.outputs[1].asset)!.path, 'utf8'), /00:00:04\.000 --> 00:00:05\.500\nWho is there\?/);
    // 6. The 9:16 version.
    const tall = await runTool('video.reframe', { aspects: ['9:16'] }, { video: `asset:${titled.outputs[0].asset}` });
    const t = await probeMedia(getAsset(tall.outputs[0].asset)!.path);
    assert.deepEqual([t.width, t.height], [404, 718]);
    assert.ok(t.audio);
  } finally {
    exp._setWorldSource(null);
    chain._setChainClient(null);
  }
});

test('video.compose finalPass queues the upscale and poster restore after the cut, without waiting', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const calls = fakeGen();
  try {
    const r = await runTool('video.compose', { width: 320, height: 180, grade: 'noir', finalPass: 'upscale' }, { clips: [shots[0]] });
    assert.ok(r.result.finalPass.upscale);
    assert.ok(r.result.finalPass.restore);
    assert.deepEqual(calls.map((c) => c.tool), ['video.upscale', 'image.restore']);
    assert.equal(calls[0].spec.key, `j_video.compose:final-upscale`);
  } finally { chain._setChainClient(null); }
});

test('video.grade, video.thumbnails (Claude mocked), edit.pace on a scene document', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const g = await runTool('video.grade', { grade: { params: { warmth: 0.5 } }, grain: 0.2 }, { video: shots[0] });
  assert.ok(g.result.filters.some((f: string) => f.startsWith('colorbalance')));
  assert.ok(g.result.filters.some((f: string) => f.startsWith('noise')));
  const th = await runTool('video.thumbnails', {}, { video: shots[1] });
  assert.equal(th.outputs.length, 3);
  assert.equal(th.result.picks[0].title, 'Who Is There?');
  const png = getAsset(th.outputs[0].asset)!;
  assert.equal(png.kind, 'image');
  const pace = await runTool('edit.pace', { timeline: { v: 2, title: 'x', width: 1280, height: 720, fps: 30, tracks: [{ id: 'V1', name: 'Video', role: 'main', magnetic: true }], clips: [{ id: 'c_one', track: 'V1', kind: 'video', asset: 'a', start: 0, in: 0, out: 9, duration: 9 }] }, maxSilent: 4 });
  assert.deepEqual(pace.result.ops, [{ op: 'trim', id: 'c_one', out: 4 }]);
});

test('video.trailer: Claude picks the moments, then a scored edit with cards and a title', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const calls = fakeGen();
  try {
    const episode = path.join(src, 'episode.mp4');
    ff('-i', shots[0], '-i', shots[1], '-i', shots[2], '-filter_complex', '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', episode);
    const r = await runTool('video.trailer', { title: 'The Lantern', seconds: 15 }, { video: episode });
    assert.equal(r.outputs[0].title, 'trailer');
    assert.equal(r.result.plan.moments.length, 3);
    assert.equal(r.result.plan.cards.length, 1);
    assert.deepEqual(calls.map((c) => c.tool), ['audio.score', 'audio.music', 'video.compose']);
    const t = await probeMedia(getAsset(r.outputs[0].asset)!.path);
    assert.ok(t.duration > 8 && t.duration < 16, String(t.duration));
  } finally { chain._setChainClient(null); }
});

test('video.deliver: the master, the aspect ratios, thumbnails and the delivery sheet in one job', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const calls = fakeGen();
  try {
    const r = await runTool('video.deliver', { title: 'The Lantern', formats: ['16:9', '9:16', '1:1'], captionList: [{ start: 0.5, end: 2, text: 'Hello' }], cast: ['Maya'] }, { video: shots[2] });
    assert.deepEqual(calls.map((c) => c.tool), ['video.titles', 'video.reframe', 'video.thumbnails']);
    assert.deepEqual(calls[1].spec.params.aspects, ['9:16', '1:1'], 'the cut is already 16:9');
    const kinds = r.result.files.map((f: any) => f.kind);
    assert.deepEqual(kinds, ['master', 'aspect', 'aspect', 'captions', 'captions', 'thumbnail', 'thumbnail', 'thumbnail']);
    assert.ok(r.result.files.every((f: any) => f.asset));
    assert.equal(r.outputs[0].title, 'delivery sheet');
  } finally { chain._setChainClient(null); }
});

test('world.export: a zip and world.json from a mocked world, every file with its recipe', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const put = (data: Buffer, ext: string, tool: string, meta: Record<string, unknown> = {}) => putAsset({ data, ext, client: 't', project: PROJECT, tool, meta, recipe: { tool, version: 3, params: { prompt: `${tool} prompt` }, inputs: {} } }).id;
  const panoFile = path.join(src, 'pano.png');
  ff('-f', 'lavfi', '-i', 'color=c=navy:s=256x128', '-frames:v', '1', panoFile);
  const pano = put(fs.readFileSync(panoFile), '.png', 'image.panorama', { width: 256, height: 128 });
  const view = put(fs.readFileSync(panoFile), '.png', 'image.generate', { width: 128, height: 128 });
  const glb = (name: string) => put(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, name.length)]), '.glb', 'mesh.rig');
  const heroModel = glb('hero');
  const sheet = put(fs.readFileSync(panoFile), '.png', 'image.viewsheet', { width: 256, height: 128 });
  const voice = put(fs.readFileSync(lines[0]), '.wav', 'audio.voice');
  const ambience = put(fs.readFileSync(lines[1]), '.wav', 'audio.ambience');
  const lantern = glb('lantern');
  const lut = put(Buffer.from('TITLE "teal"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'), '.cube', 'upload');
  exp._setWorldSource((_p, id) => (id !== 'sn_world02' ? null : {
    worldId: id, title: 'Frostmoon', canon: ['The moon is always red.'],
    characters: [{ id: 'c_maya', title: 'Maya', description: 'A smuggler with a scar.', refs: [sheet, heroModel, voice] }, { id: 'c_missing', title: 'Ghost', description: '', refs: ['a_doesnotexist'] }],
    places: [{ id: 'p_harbor', title: 'The Harbor', description: 'A frozen harbor.', refs: [pano, view, ambience] }],
    props: [{ id: 'pr_lantern', title: 'Lantern', description: 'A red lantern.', refs: [lantern, view] }],
    look: { style: 'painterly, cold blues', negative: 'blurry', palette: ['#0b1d3a', '#c0392b', 'nope'], board: [view], grade: { lut, params: { warmth: -0.2 } } },
  }));
  try {
    const r = await runTool('world.export', { world: 'sn_world02' });
    assert.equal(r.outputs[0].kind, 'file');
    const files = exp.unzip(fs.readFileSync(getAsset(r.outputs[0].asset)!.path));
    const names = [...files.keys()].sort();
    for (const n of ['frostmoon/world.json', 'frostmoon/README.md', 'frostmoon/look/palette.gpl', 'frostmoon/look/grade.cube', 'frostmoon/characters/maya/model.glb', 'frostmoon/characters/maya/pictures/picture-1.png', 'frostmoon/characters/maya/voice/sample-1.wav', 'frostmoon/places/the-harbor/skybox.png', 'frostmoon/places/the-harbor/ambience.wav', 'frostmoon/places/the-harbor/views/view-1.png', 'frostmoon/props/lantern/model.glb']) {
      assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
    }
    const m = JSON.parse(files.get('frostmoon/world.json')!.toString());
    assert.equal(m.format, 'hawkes.world/1');
    assert.deepEqual(m.world, { id: 'sn_world02', name: 'Frostmoon', canon: ['The moon is always red.'] });
    assert.equal(m.characters[0].model, 'characters/maya/model.glb');
    assert.deepEqual(m.characters[0].voice.samples, ['characters/maya/voice/sample-1.wav']);
    assert.equal(m.places[0].skybox, 'places/the-harbor/skybox.png', 'the 2:1 picture is the skybox');
    assert.equal(m.props[0].model, 'props/lantern/model.glb');
    assert.equal(m.look.grade.lut, 'look/grade.cube');
    assert.ok(m.missing.some((x: string) => x.includes('a_doesnotexist')), 'what could not be found is listed');
    // Every file carries its recipe, and the manifest's paths are what's in the zip.
    for (const f of m.files) {
      assert.ok(files.has(`frostmoon/${f.path}`), f.path);
      assert.ok(f.recipe.tool && f.sha256 && f.asset, f.path);
      assert.equal(files.get(`frostmoon/${f.path}`)!.length, f.bytes);
    }
    assert.equal(m.files.find((f: any) => f.path.endsWith('model.glb')).recipe.params.prompt, 'mesh.rig prompt');
    assert.match(files.get('frostmoon/look/palette.gpl')!.toString(), /GIMP Palette[\s\S]*192\s+57\s+43\t#c0392b/);
    assert.match(files.get('frostmoon/README.md')!.toString(), /Import World Pack/);
    // The web loader reads the same manifest.
    // @ts-ignore: plain JS client
    const { worldPack } = await import('../clients/js/hawkes-world.mjs');
    const wp = worldPack(m, 'https://game.example/worlds/frostmoon/');
    assert.equal(wp.url(wp.character('maya').model), 'https://game.example/worlds/frostmoon/characters/maya/model.glb');
    assert.equal(wp.place('p_harbor').skybox, 'places/the-harbor/skybox.png');
    assert.deepEqual(wp.palette(), [0x0b1d3a, 0xc0392b]);
    assert.equal(wp.file(wp.prop('Lantern').model).recipe.tool, 'mesh.rig');
    assert.throws(() => worldPack({ format: 'other' }));
  } finally { exp._setWorldSource(null); }
});

test('zip: round trip, stored and deflated entries', () => {
  const z = exp.zip([{ name: 'a/b.txt', data: Buffer.from('hello hello hello hello') }, { name: 'c.png', data: Buffer.from([1, 2, 3]) }]);
  const back = exp.unzip(z);
  assert.equal(back.get('a/b.txt')!.toString(), 'hello hello hello hello');
  assert.deepEqual([...back.get('c.png')!], [1, 2, 3]);
  assert.throws(() => exp.zip([{ name: 'x', data: Buffer.alloc(1) }, { name: 'x', data: Buffer.alloc(1) }]));
  assert.equal(exp.slug('The Harbor!'), 'the-harbor');
});

test('every finishing tool is registered and its child steps use real params', () => {
  for (const t of fin.FINISHING_TOOLS) assert.equal(getTool(t.id), t);
  // The params the tools pass their children exist on those tools.
  assert.ok('bpm' in getTool('audio.music')!.params && 'seconds' in getTool('audio.music')!.params);
  for (const k of ['text', 'duration', 'loop', 'provider']) assert.ok(k in getTool('audio.sfx')!.params, k);
  for (const k of ['timeline', 'grade', 'world', 'finalPass']) assert.ok(k in getTool('video.compose')!.params, k);
  assert.ok('lut' in getTool('video.compose')!.inputs);
});
