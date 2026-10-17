// video.compose: the timeline plan (frame-exact lengths, transitions, anchors, captions), then real cuts of small
// synthetic clips made here with ffmpeg (lavfi color and sine): length, streams, size and rate, the crossfade's
// length and blend, ducking, captions and the poster. The ffmpeg part skips where ffmpeg isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planCompose, toVtt, composeTool, type Probe } from '../src/tools/compose.ts';
import type { Output } from '../src/tools/types.ts';

const opts = { width: 640, height: 360, fps: 24, fit: 'pad' as const, color: '000000', burn: false };
const clip = (duration: number, audio = true): Probe => ({ duration, video: true, audio });

test('planCompose: a crossfade overlaps the clips by its length; a cut adds them', () => {
  const x = planCompose({ clips: [{ clip: 0, transition: 'crossfade', seconds: 0.5 }, { clip: 1 }] }, [clip(3), clip(2)], [], opts);
  assert.equal(x.duration, 4.5);
  assert.equal(x.frames, 108);
  assert.deepEqual(x.clips.map((c) => [c.start, c.end]), [[0, 3], [2.5, 4.5]]);
  assert.match(x.filter, /xfade=transition=fade:duration=0\.5:offset=2\.5/);
  const cut = planCompose({}, [clip(3), clip(2)], [], opts);
  assert.equal(cut.duration, 5);
  assert.match(cut.filter, /concat=n=2:v=1:a=0/);
  // The crossfade shorthand, trims, and a clip used twice.
  const t = planCompose({ clips: [{ clip: 1, in: 0.5, crossfade: 1 }, { clip: 0, out: 2 }, { clip: 1 }] }, [clip(3), clip(4)], [], opts);
  assert.equal(t.duration, 3.5 + 2 - 1 + 4);
  assert.equal(t.inputs.length, 3);
});

test('planCompose: lengths snap to frames; bad timelines say what is wrong', () => {
  const x = planCompose({}, [clip(1.01)], [], { ...opts, fps: 10 });
  assert.equal(x.duration, 1);
  assert.throws(() => planCompose({ clips: [{ clip: 0, crossfade: 2 }, { clip: 1 }] }, [clip(3), clip(1.5)], [], opts), /longer than the next clip/);
  assert.throws(() => planCompose({ clips: [{ clip: 0, transition: 'spin' }, { clip: 1 }] }, [clip(3), clip(3)], [], opts), /transition is cut or crossfade/);
  assert.throws(() => planCompose({ clips: [{ clip: 2 }] }, [clip(3)], [], opts), /no clip 2/);
  assert.throws(() => planCompose({ clips: [{ clip: 0, in: 3 }] }, [clip(3)], [], opts), /leave nothing/);
  assert.throws(() => planCompose({ audio: [{ audio: 0 }] }, [clip(3)], [], opts), /no audio 0/);
});

test('planCompose: tracks and captions anchor to a clip; music ducks around dialogue', () => {
  const x = planCompose({
    clips: [{ clip: 0, crossfade: 1 }, { clip: 1 }],
    audio: [{ audio: 0, loop: true, volume: 0.4, duck: true }, { audio: 1, clip: 1, start: 0.5, dialogue: true }],
    captions: [{ clip: 1, start: 0.5, end: 1.5, text: 'Who is there?' }, { start: 99, text: 'after the end' }],
  }, [clip(3), clip(3)], [{ duration: 2, video: false, audio: true }, { duration: 1, video: false, audio: true }], opts);
  assert.equal(x.duration, 5);
  assert.deepEqual(x.captions, [{ start: 2.5, end: 3.5, text: 'Who is there?' }]);
  assert.match(x.notes.join(' '), /caption 1 is outside the cut/);
  assert.match(x.filter, /adelay=delays=2500:all=1\[ta1\]/);
  assert.match(x.filter, /volume='\(1-0\.7\*clip/);
  assert.deepEqual(x.inputs.map((i) => [i.kind, i.loop]), [['clip', false], ['clip', false], ['audio', true], ['audio', false]]);
  assert.equal(toVtt(x.captions), 'WEBVTT\n\n1\n00:00:02.500 --> 00:00:03.500\nWho is there?\n');
  const tr = planCompose({ audio: [{ audio: 0, start: 1 }, { audio: 0, start: 9 }], captions: [{ track: 0, text: 'a line' }, { track: 1, text: 'too late' }] }, [clip(3)], [{ duration: 1.2, video: false, audio: true }], opts);
  assert.deepEqual(tr.captions, [{ start: 1, end: 2.2, text: 'a line' }]);
  assert.throws(() => planCompose({ captions: [{ track: 0, text: 'x' }] }, [clip(3)], [], opts), /no track 0/);
  const sc = planCompose({ audio: [{ audio: 0, duck: 'sidechain' }, { audio: 1, dialogue: true }] }, [clip(3)], [{ duration: 3, video: false, audio: true }, { duration: 1, video: false, audio: true }], opts);
  assert.match(sc.filter, /sidechaincompress=/);
});

// ---- Live: real cuts with ffmpeg ----

const haveFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const ff = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const probe = (f: string) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt', '-of', 'json', f], { encoding: 'utf8' }).stdout);
/** The average color of a 16x16 patch in the middle of the frame at time t. */
const pixel = (f: string, t: number) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'crop=16:16,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 }).stdout];
/** Mean loudness (dB) of the sound from t for d seconds. */
const loudness = (f: string, t: number, d: number) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(t), '-t', String(d), '-i', f, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? NaN);
};

async function compose(dir: string, params: Record<string, unknown>, inputs: { clips: string[]; audio?: string[] }) {
  const defaults = Object.fromEntries(Object.entries(composeTool.params).filter(([, s]) => s.default !== undefined).map(([k, s]) => [k, s.default]));
  const outs: Output[] = [];
  let result: any;
  const work = fs.mkdtempSync(path.join(dir, 'job-'));
  await composeTool.run({
    job: { id: 'test', client: 'test', project: 'test', tool: composeTool.id, labels: {} },
    params: { ...defaults, ...params }, inputs, done: 0, outputs: [], signal: new AbortController().signal,
    step() {}, log() {}, tmp: (n) => path.join(work, n), emit: async (o) => { outs.push(o); }, result: (v) => { result = v; },
    seed: () => 0, usage() {}, python: async () => '',
  });
  const files = Object.fromEntries(outs.map((o) => {
    const f = path.join(dir, `${path.basename(work)}-${o.title}${o.ext}`);
    fs.writeFileSync(f, o.data);
    return [o.title!, f];
  }));
  return { result, files, outs };
}

test('video.compose: mixed sizes and rates, a 1 s crossfade, the clip\'s own sound, captions and a poster', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
  const red = path.join(dir, 'red.mp4');
  const blue = path.join(dir, 'blue.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);

  const { result, files } = await compose(dir, {
    width: 480, height: 270, fps: 25,
    timeline: { clips: [{ clip: 0, transition: 'crossfade', seconds: 1 }, { clip: 1 }], captions: [{ clip: 1, start: 0.2, end: 1.5, text: 'Blue now' }] },
  }, { clips: [red, blue] });

  assert.deepEqual(Object.keys(files).sort(), ['captions', 'cut', 'poster']);
  const p = probe(files.cut);
  const v = p.streams.find((s: any) => s.codec_type === 'video');
  const a = p.streams.find((s: any) => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.deepEqual([v.width, v.height, v.r_frame_rate], [480, 270, '25/1']);
  assert.equal(a.codec_name, 'aac');
  // 3 s + 2 s - the 1 s crossfade.
  assert.ok(Math.abs(Number(p.format.duration) - 4) < 0.1, `duration ${p.format.duration}`);
  assert.ok(Math.abs(result.duration - 4) < 0.1);
  assert.deepEqual([result.width, result.height, result.fps], [480, 270, 25]);
  // Red until 2 s, blending from 2 to 3 s, blue after.
  const [r1, , b1] = pixel(files.cut, 1);
  assert.ok(r1 > 200 && b1 < 40, `at 1 s ${[r1, b1]}`);
  const [r25, , b25] = pixel(files.cut, 2.5);
  assert.ok(r25 > 70 && r25 < 190 && b25 > 70 && b25 < 190, `mid-crossfade ${[r25, b25]}`);
  const [r35, , b35] = pixel(files.cut, 3.5);
  assert.ok(r35 < 40 && b35 > 200, `at 3.5 s ${[r35, b35]}`);
  // The red clip's tone plays, and fades out across the crossfade; the blue clip has no sound.
  assert.ok(loudness(files.cut, 0.5, 1) > -30);
  assert.ok(loudness(files.cut, 3.2, 0.7) < -60);
  assert.match(fs.readFileSync(files.captions, 'utf8'), /00:00:02\.200 --> 00:00:03\.500\nBlue now/);
  assert.ok(fs.statSync(files.poster).size > 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('video.compose: looped music ducks under a voice line; burned captions; sidechain ducking runs', { skip: !haveFfmpeg && 'no ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
  const shot = path.join(dir, 'shot.mp4');
  const music = path.join(dir, 'music.wav');
  const voice = path.join(dir, 'voice.wav');
  ff(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', shot]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', music]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', voice]);

  // The voice is silent here (volume 0), so the dip measured is the music's own.
  const { result, files } = await compose(dir, {
    width: 320, height: 180, fps: 24, poster: false,
    timeline: { audio: [{ audio: 0, loop: true, volume: 0.5, duck: true, duckTo: 0.25 }, { audio: 1, start: 2, volume: 0, dialogue: true }] },
  }, { clips: [shot], audio: [music, voice] });
  assert.ok(Math.abs(result.duration - 4) < 0.1, `duration ${result.duration}`);
  const open = loudness(files.cut, 0.5, 1);
  const under = loudness(files.cut, 2.35, 0.3);
  const after = loudness(files.cut, 3.5, 0.4);
  assert.ok(open > -40, `music ${open} dB`);
  assert.ok(open - under > 9 && open - under < 15, `ducked by ${open - under} dB`);
  assert.ok(Math.abs(open - after) < 2, `back up after the line: ${after} dB`);

  const burned = await compose(dir, {
    width: 320, height: 180, fps: 24, captions: 'burn', poster: false,
    timeline: { audio: [{ audio: 0, loop: true, duck: 'sidechain' }, { audio: 1, start: 1, dialogue: true }], captions: [{ start: 0, end: 3, text: 'Burned in' }], fadeIn: 0.5, fadeOut: 0.5 },
  }, { clips: [shot], audio: [music, voice] });
  assert.deepEqual(burned.outs.map((o) => o.title), ['cut']);
  assert.ok(Math.abs(burned.result.duration - 4) < 0.1);
  fs.rmSync(dir, { recursive: true, force: true });
});
