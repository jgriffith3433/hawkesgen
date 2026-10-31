// The quality checks (src/quality, docs/bench.md): the scoring math, the brief's questions and their answers with Claude
// swapped for a stub, the fix sentence, the face script's answer, frame statistics, and a GLB's faults. No GPU, no
// Claude, no face models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-quality-'));
const q = await import('../src/quality/index.ts');
const judge = await import('../src/quality/judge.ts');
const media = await import('../src/quality/media.ts');
const ident = await import('../src/quality/identity.ts');
const faults = await import('../src/quality/faults.ts');
const mock = await import('../src/quality/mock.ts');
const synth = await import('../src/bench/synth.ts');
const { kindOfFile } = await import('../src/tools/quality-identity.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-quality-files-'));
const pic = path.join(dir, 'pic.png');
fs.writeFileSync(pic, synth.png('a picture'));

/** A stand-in for Claude: answers by what the prompt asks for, and records each call. */
function stub(answers: { questions?: string[]; yes?: (q: string) => boolean; grade?: number; faults?: string[] }) {
  const calls: any[] = [];
  judge.setQualityAsk(async (p) => {
    calls.push(p);
    let body: any;
    if (/Questions:/.test(p.prompt)) {
      const qs = [...p.prompt.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
      body = { answers: qs.map((x) => ({ q: x, yes: answers.yes ? answers.yes(x) : true, why: 'seen' })) };
    } else if (/"grade"/.test(p.prompt)) body = { grade: answers.grade ?? 8, why: 'a little warm' };
    else if (/"faults"/.test(p.prompt)) body = { faults: answers.faults ?? [] };
    else body = { questions: answers.questions ?? ['Is it night', 'Is she holding the lantern?', 'Is it night?', 'Is the lantern lit?', 'Is she outdoors?'] };
    return { text: JSON.stringify(body), model: judge.JUDGE_MODEL, usage: { input_tokens: 100, output_tokens: 20 }, cost: 0.001 };
  });
  return calls;
}
test.after(() => judge.setQualityAsk(null));

test('the brief becomes 4-8 clean questions, asked of a Sonnet-class model', async () => {
  const calls = stub({});
  const qs = await q.questionsFor('Maya holds a lit lantern outdoors at night', 'image');
  assert.deepEqual(qs, ['Is it night?', 'Is she holding the lantern?', 'Is the lantern lit?', 'Is she outdoors?'], 'question marks added, duplicates dropped');
  assert.equal(calls[0].model, 'claude-sonnet-5-5');
  assert.ok(calls[0].schema, 'structured output');
  assert.deepEqual(judge.cleanQuestions(Array.from({ length: 12 }, (_, i) => `Question number ${i}`)).length, 8);
  assert.deepEqual(await q.questionsFor('   ', 'image'), []);
});

test('the checklist: each question answered from the picture, the score is the share answered yes', async () => {
  const calls = stub({ yes: (x) => !/lit/.test(x) });
  const r = await q.checklist({ brief: 'Maya holds a lit lantern outdoors at night', kind: 'image', file: pic, refs: [pic] });
  assert.equal(r.answers.length, 4);
  assert.equal(r.score, 0.75);
  assert.equal(r.answers.find((a) => /lit/.test(a.q))!.yes, false);
  const ask = calls.find((c) => /Questions:/.test(c.prompt));
  assert.deepEqual(ask.images, [pic, pic], 'the output, then the reference');
  // Own questions skip making them.
  const own = stub({});
  const r2 = await q.checklist({ brief: 'x', kind: 'image', file: pic, questions: ['Is it red'] });
  assert.equal(own.length, 1);
  assert.deepEqual(r2.answers.map((a) => a.q), ['Is it red?']);
  // A missing answer counts as no; answers are matched by question, then by position.
  assert.deepEqual(judge.matchAnswers(['A?', 'B?', 'C?'], [{ q: 'B?', yes: true, why: '' }, { q: 'zzz', yes: true, why: 'pos' }]).map((a) => a.yes), [false, true, false]);
  assert.equal(judge.yesShare([]), 1);
});

test('a 3D model or a sound is never judged by looking: skipped, claiming nothing', async () => {
  stub({});
  const r = await q.checklist({ brief: 'A lantern', kind: 'mesh', file: pic });
  assert.equal(r.score, 1);
  assert.match(r.skipped!, /3D model/);
});

test('style: the grade out of 10 becomes a share; no look, nothing to judge', async () => {
  stub({ grade: 6 });
  const r = await q.styleScore({ kind: 'image', file: pic, words: 'cold blue, amber lights' });
  assert.equal(r.score, 0.6);
  assert.equal((await q.styleScore({ kind: 'image', file: pic })).score, 1);
  assert.equal(judge.asShare(0.7), 0.7);
  assert.equal(judge.asShare(14), 1);
  assert.equal(judge.asShare('x'), 0);
});

test('the fix sentence names what failed and what usually fixes it', () => {
  const t = q.DEFAULT_THRESHOLDS;
  const r = {
    identity: { distance: 0.31, perFrame: [0.2, 0.42], spread: 0.11, faces: 2 },
    checklist: { score: 0.5, answers: [{ q: 'Is it night?', yes: false, why: '' }, { q: 'Is she smiling?', yes: true, why: '' }] },
    faults: { ok: false, faults: ['an extra finger on the left hand'] },
    style: { score: 0.5, why: 'too saturated.' },
  };
  const v = q.verdicts(r, t);
  assert.deepEqual(v, { identity: false, checklist: false, faults: false, style: false });
  const fix = q.fixFor(r, t);
  assert.match(fix, /off-model \(distance 0\.31/);
  assert.match(fix, /drifts between frames/);
  assert.match(fix, /"Is it night" was no/);
  assert.match(fix, /extra fingers/);
  assert.match(fix, /Off the look \(50%: too saturated\)/);
  assert.equal(q.fixFor({ identity: { distance: 0.1, perFrame: [0.1], spread: 0, faces: 1 }, checklist: { score: 1, answers: [] } }, t), '');
  // No face found never fails identity: it measured nothing.
  assert.equal(q.verdicts({ identity: { distance: null, perFrame: [], spread: 0, faces: 0 } }, t).identity, true);
});

test('assess: every check, a pass or a fail with a fix, and checks that could not run listed without failing', async () => {
  q.setQualityMock(null);
  stub({ yes: () => true, grade: 9 });
  // Identity with a python that answers like the face script; faults can't read a fake file through ffmpeg here.
  const r = await q.identityScore({ file: pic, kind: 'image' }, [pic], { python: async (script, args) => {
    assert.equal(script, 'quality/identity.py');
    assert.deepEqual(args, ['--refs', pic, '--frames', pic]);
    return 'downloading...\n{"distance": 0.09, "perFrame": [0.09], "spread": 0, "faces": 1, "frames": 1, "refFaces": 1}\n';
  } });
  assert.equal(r.distance, 0.09);
  assert.equal(r.refFaces, 1);
  // A whole assess in mock mode: same shapes.
  mock.setQualityMock(true);
  const a = await q.assess({ brief: 'Maya, at night, with the lantern', kind: 'image', file: pic, identityRefs: [pic], style: { words: 'cold' } });
  assert.ok(a.identity && a.checklist && a.faults && a.style);
  assert.equal(typeof a.pass, 'boolean');
  if (!a.pass) assert.ok(a.fix);
  // The same file scores the same every time.
  assert.deepEqual(await q.assess({ brief: 'Maya, at night, with the lantern', kind: 'image', file: pic, identityRefs: [pic], style: { words: 'cold' } }), a);
  mock.setQualityMock(null);
  // A check that throws is listed, not a failure.
  judge.setQualityAsk(async () => { throw new Error('Claude is rate limited'); });
  const b = await q.assess({ brief: 'Maya', kind: 'mesh', file: path.join(dir, 'missing.glb') });
  assert.equal(b.faults!.ok, false, 'a missing file is a fault');
  assert.ok(b.checklist!.skipped);
});

test('mock checks are scoped: withQualityMock leaves other work real', async () => {
  mock.setQualityMock(null);
  assert.equal(mock.qualityMock(), false);
  assert.equal(await q.withQualityMock(async () => mock.qualityMock()), true);
  assert.equal(mock.qualityMock(), false);
  const qs = mock.mockQuestions('A fox in a scarf, reading a newspaper', 'image');
  assert.ok(qs.length >= 4 && qs.length <= 8);
});

test('the face script\'s answer: distance, frames, spread recomputed; no face is null', () => {
  const r = ident.identityFromScript({ distance: 0.1, perFrame: [0.05, 0.15], faces: 3, frames: 8, refFaces: 2 });
  assert.equal(r.distance, 0.1);
  assert.equal(r.spread, 0.05);
  assert.equal(r.frames, 8);
  assert.equal(ident.identityFromScript({ distance: null, perFrame: [], faces: 0 }).distance, null);
  assert.equal(ident.spreadOf([1]), 0);
  assert.deepEqual(media.sampleTimes(8, 4), [1, 3, 5, 7]);
  assert.deepEqual(media.sampleTimes(0, 4), [0]);
});

test('frame statistics: flat frames and flicker (a-b-a jumps), not ordinary changes', () => {
  const stats = media.parseSignalStats([
    'frame:0    pts:0', 'lavfi.signalstats.YMIN=16', 'lavfi.signalstats.YMAX=235', 'lavfi.signalstats.YAVG=100', 'lavfi.signalstats.YDIF=0',
    'frame:1    pts:1', 'lavfi.signalstats.YMIN=16', 'lavfi.signalstats.YMAX=235', 'lavfi.signalstats.YAVG=130', 'lavfi.signalstats.YDIF=30',
    'frame:2    pts:2', 'lavfi.signalstats.YMIN=16', 'lavfi.signalstats.YMAX=235', 'lavfi.signalstats.YAVG=101', 'lavfi.signalstats.YDIF=29',
    'frame:3    pts:3', 'lavfi.signalstats.YMIN=40', 'lavfi.signalstats.YMAX=45', 'lavfi.signalstats.YAVG=42', 'lavfi.signalstats.YDIF=59',
  ].join('\n'));
  assert.equal(stats.length, 4);
  assert.equal(stats[1].yavg, 130);
  assert.equal(media.isFlat(stats[3]), true);
  assert.equal(media.isFlat(stats[0]), false);
  const f = media.flickerOf(stats);
  assert.equal(f.frames, 1, 'up then back down at frame 1; frame 2 only keeps going down');
  // A steady fade is not flicker.
  const fade = Array.from({ length: 10 }, (_, i) => ({ yavg: 200 - i * 15, ymin: 0, ymax: 255, ydif: 15 }));
  assert.equal(media.flickerOf(fade).frames, 0);
});

test('a GLB\'s faults: geometry, broken positions, flat sheets, the triangle budget', async () => {
  const file = path.join(dir, 'box.glb');
  fs.writeFileSync(file, await synth.glb('a box'));
  const facts = await faults.meshFacts(file);
  assert.equal(facts.triangles, 12);
  assert.equal(facts.vertices, 8);
  assert.equal(facts.nan, 0);
  assert.deepEqual(faults.meshFaults(facts), []);
  assert.deepEqual(faults.meshFaults({ ...facts, meshes: 0, triangles: 0 }), ['the model has no geometry']);
  assert.match(faults.meshFaults({ ...facts, nan: 3 })[0], /3 vertices/);
  assert.match(faults.meshFaults({ ...facts, size: [2, 0, 2] })[0], /flat/);
  assert.match(faults.meshFaults({ ...facts, triangles: 400_000 })[0], /budget/);
  assert.deepEqual(faults.meshFaults({ ...facts, note: 'Draco-compressed' }), []);
  const r = await q.faultCheck({ kind: 'mesh', file });
  assert.deepEqual(r, { ok: true, faults: [] });
  const bad = path.join(dir, 'bad.glb');
  fs.writeFileSync(bad, 'not a model');
  assert.match((await q.faultCheck({ kind: 'mesh', file: bad })).faults[0], /doesn't open/);
});

test('a file\'s kind from its name', () => {
  assert.equal(kindOfFile('a/b.PNG'), 'image');
  assert.equal(kindOfFile('x.mp4'), 'video');
  assert.equal(kindOfFile('x.glb'), 'mesh');
  assert.equal(kindOfFile('x.wav'), 'audio');
  assert.equal(kindOfFile('x.bin', 'video'), 'video');
  assert.throws(() => kindOfFile('x.bin'));
});
