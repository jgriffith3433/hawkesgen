// video.frame, video.still and media.normalize: the pure decisions (what needs normalizing, the ffmpeg arguments, the
// sizes), then real runs with ffmpeg (and Pillow for images) on files made here: a WebM with Opus at an odd size, an HEVC
// MOV, a WebP, a GIF, a CMYK JPEG, a FLAC. Skipped without ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProbeStream } from '../src/tools/media.ts';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-media-'));
const { getTool } = await import('../src/tools/index.ts');
const { validateParams } = await import('../src/tools/validate.ts');
const m = await import('../src/tools/media.ts');

const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const python = [path.join('.venv', 'Scripts', 'python.exe'), path.join('.venv', 'bin', 'python'), 'python3', 'python']
  .find((p) => (p.includes(path.sep) ? fs.existsSync(p) : spawnSync(p, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0));
const pillow = !!python && spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-src-'));
const ff = (...args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const has = (enc: string) => ffmpeg && spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout.includes(enc);

async function runTool(id: string, params: Record<string, unknown>, inputs: Record<string, unknown>) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'media-run-'));
  const tool = getTool(id)!;
  const emitted: any[] = [];
  let result: any = null;
  await tool.run({
    job: { id: 'j', client: 't', project: 't', tool: id, labels: {} }, params: validateParams(tool, params), inputs,
    done: 0, outputs: [], signal: new AbortController().signal, step: () => {}, log: () => {}, tmp: (n: string) => path.join(work, n),
    emit: async (o: any) => { emitted.push(o); }, result: (v: any) => { result = v; }, seed: () => 1, usage: () => {},
    python: async (script: string, args: string[]) => {
      const r = spawnSync(python!, [path.join('post', script), ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    },
  } as any);
  const files = emitted.map((o, i) => {
    const f = path.join(work, `out-${i}${o.ext ?? ''}`);
    fs.writeFileSync(f, o.data);
    return f;
  });
  return { emitted, result, files };
}

// ------------------------------------------------------------------------------------------------ pure

const vstream = (o: Partial<ProbeStream> = {}): ProbeStream => ({ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', ...o });
const astream = (codec = 'aac'): ProbeStream => ({ codec_type: 'audio', codec_name: codec });
const mp4 = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '4.0' };

test('normalizeCheck: a fine MP4 passes; WebM, HEVC, odd sizes, VFR, Opus, big and rotated video need it', () => {
  assert.deepEqual(m.normalizeCheck({ streams: [vstream(), astream()], format: mp4 }, '.mp4'), { kind: 'video', needed: false, reasons: [] });
  assert.equal(m.normalizeCheck({ streams: [vstream()], format: mp4 }, '.mov').needed, false, 'no sound is fine');
  const webm = m.normalizeCheck({ streams: [vstream({ codec_name: 'vp9' }), astream('opus')], format: { format_name: 'matroska,webm' } }, '.webm');
  assert.equal(webm.needed, true);
  assert.ok(webm.reasons.some((r) => /container/.test(r)) && webm.reasons.some((r) => /vp9/.test(r)) && webm.reasons.some((r) => /opus/.test(r)), webm.reasons.join('; '));
  assert.match(m.normalizeCheck({ streams: [vstream({ codec_name: 'hevc' })], format: mp4 }, '.mov').reasons.join(), /hevc/);
  assert.match(m.normalizeCheck({ streams: [vstream({ width: 641 })], format: mp4 }, '.mp4').reasons.join(), /odd size/);
  assert.match(m.normalizeCheck({ streams: [vstream({ avg_frame_rate: '2397/100', r_frame_rate: '30/1' })], format: mp4 }, '.mp4').reasons.join(), /variable frame rate/);
  assert.match(m.normalizeCheck({ streams: [vstream({ width: 3840, height: 2160 })], format: mp4 }, '.mp4').reasons.join(), /larger than 1920/);
  assert.match(m.normalizeCheck({ streams: [vstream({ pix_fmt: 'yuv422p10le' })], format: mp4 }, '.mp4').reasons.join(), /pixel format/);
  assert.match(m.normalizeCheck({ streams: [vstream({ side_data_list: [{ rotation: -90 }] })], format: mp4 }, '.mp4').reasons.join(), /rotated 270/);
});

test('normalizeCheck: PNG and RGB JPEG pass; WebP, GIF, CMYK JPEG need it; MP3/AAC/WAV pass, Opus and FLAC need it', () => {
  const img = (codec: string, fmt: string, pix = 'rgb24') => ({ streams: [{ codec_type: 'video', codec_name: codec, width: 10, height: 10, pix_fmt: pix }], format: { format_name: fmt } });
  assert.deepEqual(m.normalizeCheck(img('png', 'png_pipe'), '.png'), { kind: 'image', needed: false, reasons: [] });
  assert.equal(m.normalizeCheck(img('mjpeg', 'jpeg_pipe', 'yuvj420p'), '.jpg').needed, false);
  assert.deepEqual(m.normalizeCheck(img('mjpeg', 'jpeg_pipe', 'cmyk'), '.jpg').reasons, ['CMYK JPEG']);
  assert.deepEqual(m.normalizeCheck(img('mjpeg', 'jpeg_pipe', 'gbrap'), '.jpg').reasons, ['CMYK JPEG'], 'ffmpeg 8 decodes CMYK as gbrap');
  assert.equal(m.normalizeCheck(img('mjpeg', 'jpeg_pipe', 'gray'), '.jpg').needed, false);
  assert.equal(m.normalizeCheck(img('webp', 'webp_pipe'), '.webp').needed, true);
  assert.equal(m.normalizeCheck(img('gif', 'gif'), '.gif').kind, 'image');
  assert.equal(m.normalizeCheck(null, '.heic').kind, 'image', 'unreadable HEIC goes by its extension');
  assert.equal(m.normalizeCheck(null, '.heic').needed, true);
  const aud = (codec: string) => ({ streams: [astream(codec)], format: { format_name: 'x' } });
  assert.equal(m.normalizeCheck(aud('mp3'), '.mp3').needed, false);
  assert.equal(m.normalizeCheck(aud('pcm_s16le'), '.wav').needed, false);
  assert.equal(m.normalizeCheck(aud('opus'), '.ogg').needed, true);
  assert.equal(m.normalizeCheck(aud('flac'), '.flac').needed, true);
  // An MP3 with cover art is audio, not a video.
  assert.equal(m.mediaKind({ streams: [astream('mp3'), { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] }, '.mp3'), 'audio');
  assert.equal(m.mediaKind({ streams: [] }, '.glb'), 'other');
});

test('normalizeVideoArgs: even sides within 1920, rotation applied, constant rate, H.264 yuv420p, AAC (silence when none)', () => {
  const args = m.normalizeVideoArgs({ streams: [vstream({ codec_name: 'hevc', width: 3841, height: 2161, avg_frame_rate: '30000/1001', r_frame_rate: '60/1' })], format: mp4 }, 'in.mov', 'out.mp4');
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /^scale=1920:1080:flags=lanczos,setsar=1,fps=29\.97,format=yuv420p$/);
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'), 'silent track added');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v:0', '-map', '1:a:0']);
  for (const want of [['-c:v', 'libx264'], ['-pix_fmt', 'yuv420p'], ['-c:a', 'aac'], ['-fps_mode', 'cfr'], ['-movflags', '+faststart']]) assert.equal(args[args.indexOf(want[0]) + 1], want[1], want[0]);
  const portrait = m.normalizeVideoArgs({ streams: [vstream({ width: 1920, height: 1080, side_data_list: [{ rotation: 90 }] }), astream('opus')], format: mp4 }, 'a', 'b');
  assert.match(portrait[portrait.indexOf('-vf') + 1], /^scale=1080:1920/);
  assert.ok(!portrait.includes('anullsrc=r=48000:cl=stereo'));
  assert.deepEqual(m.evenFit(641, 361), { width: 640, height: 360 });
  assert.equal(m.cfrRate(vstream({ avg_frame_rate: '0/0', r_frame_rate: '1000/1' })), 30, 'nonsense rates fall back to 30');
  assert.equal(m.cfrRate(vstream({ avg_frame_rate: '24000/1001' })), 23.976);
});

test('frameArgs: first, last (the true last frame) and a time; past the end is refused', () => {
  assert.deepEqual(m.frameArgs('v.mp4', 'f.png', 'first', 3).slice(-5), ['-i', 'v.mp4', '-frames:v', '1', 'f.png']);
  assert.deepEqual(m.frameArgs('v.mp4', 'f.png', 'last', 3).slice(-7), ['-sseof', '-1', '-i', 'v.mp4', '-update', '1', 'f.png']);
  assert.deepEqual(m.frameArgs('v.mp4', 'f.png', 1.25, 3).slice(-7), ['-ss', '1.25', '-i', 'v.mp4', '-frames:v', '1', 'f.png']);
  assert.throws(() => m.frameArgs('v.mp4', 'f.png', 9, 3), /past the end/);
  assert.throws(() => m.frameArgs('v.mp4', 'f.png', -1, 3), /seconds/);
});

test('stillArgs: the image looped for the length, fitted with bars, a push-in as a zoompan, silent sound', () => {
  const a = m.stillArgs('i.png', 'o.mp4', { width: 1280, height: 720, seconds: 2, fps: 30, zoom: { from: 1, to: 1.2 } });
  assert.equal(a[a.indexOf('-frames:v') + 1], '60');
  const vf = a[a.indexOf('-vf') + 1];
  assert.match(vf, /scale=1280:720:force_original_aspect_ratio=decrease/);
  assert.match(vf, /zoompan=z='1\+0\.2\*min\(on\/59,1\)'/);
  assert.ok(a.includes('anullsrc=r=48000:cl=stereo'));
  assert.doesNotMatch(m.stillArgs('i.png', 'o.mp4', { width: 64, height: 64, seconds: 1, fps: 10 })[a.indexOf('-vf') + 1], /zoompan/);
});

// ------------------------------------------------------------------------------------------------ real runs

const probeOf = async (f: string) => m.probe(f);

test('media.normalize: a WebM with Opus at an odd size becomes a 30 fps H.264 MP4 with AAC, even sides', async (t) => {
  if (!ffmpeg || !has('libvpx')) return t.skip('no ffmpeg with VP8/VP9');
  const src = path.join(dir, 'odd.webm');
  ff('-f', 'lavfi', '-i', 'testsrc=size=641x361:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', has('libopus') ? 'libopus' : 'libvorbis', '-shortest', src);
  const before = m.normalizeCheck(await probeOf(src), '.webm');
  assert.equal(before.needed, true);
  const r = await runTool('media.normalize', {}, { file: src });
  assert.equal(r.result.changed, true);
  const p = await probeOf(r.files[0]);
  const v = p.streams!.find((s) => s.codec_type === 'video')!;
  const a = p.streams!.find((s) => s.codec_type === 'audio')!;
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.deepEqual([v.width, v.height], [640, 360]);
  assert.equal(a.codec_name, 'aac');
  assert.equal(m.normalizeCheck(p, '.mp4').needed, false, m.normalizeCheck(p, '.mp4').reasons.join());
  // Already fine: the same bytes come back.
  const again = await runTool('media.normalize', {}, { file: r.files[0] });
  assert.equal(again.result.changed, false);
  assert.ok(again.emitted[0].data.equals(fs.readFileSync(r.files[0])));
});

test('media.normalize: an HEVC MOV with no sound gets H.264 and a silent AAC track', async (t) => {
  if (!ffmpeg || !has('libx265')) return t.skip('no ffmpeg with libx265');
  const src = path.join(dir, 'hevc.mov');
  ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', src);
  const r = await runTool('media.normalize', {}, { file: src });
  const p = await probeOf(r.files[0]);
  assert.equal(p.streams!.find((s) => s.codec_type === 'video')!.codec_name, 'h264');
  assert.equal(p.streams!.find((s) => s.codec_type === 'audio')!.codec_name, 'aac');
  assert.ok(Math.abs(Number(p.format!.duration) - 1) < 0.2, String(p.format!.duration));
});

test('media.normalize: WebP, GIF and CMYK JPEG become PNG or JPEG; FLAC becomes MP3', async (t) => {
  if (!ffmpeg || !pillow) return t.skip('no ffmpeg or no Python with Pillow');
  const py = (code: string) => assert.equal(spawnSync(python!, ['-c', code], { encoding: 'utf8' }).status, 0);
  const webp = path.join(dir, 'a.webp');
  const gif = path.join(dir, 'a.gif');
  const cmyk = path.join(dir, 'cmyk.jpg');
  py(`from PIL import Image
Image.new('RGBA', (30, 20), (255, 0, 0, 128)).save(r'${webp}')
f = [Image.new('P', (16, 16), i) for i in range(3)]
f[0].save(r'${gif}', save_all=True, append_images=f[1:])
Image.new('CMYK', (24, 24), (0, 255, 255, 0)).save(r'${cmyk}')`);
  const w = await runTool('media.normalize', {}, { file: webp });
  assert.equal(w.emitted[0].ext, '.png', 'transparency keeps PNG');
  const g = await runTool('media.normalize', {}, { file: gif });
  assert.equal(g.result.kind, 'image');
  assert.match(g.emitted[0].ext, /\.(png|jpg)$/);
  const c = await runTool('media.normalize', {}, { file: cmyk });
  assert.equal(c.emitted[0].ext, '.jpg');
  assert.equal(c.result.changed, true);
  const cp = await probeOf(c.files[0]);
  assert.doesNotMatch(String(cp.streams![0].pix_fmt), /cmyk/);
  const flac = path.join(dir, 'a.flac');
  ff('-f', 'lavfi', '-i', 'sine=duration=1', flac);
  const a = await runTool('media.normalize', {}, { file: flac });
  assert.equal(a.emitted[0].ext, '.mp3');
  assert.equal((await probeOf(a.files[0])).streams![0].codec_name, 'mp3');
});

test('video.frame: the first, a middle and the true last frame', async (t) => {
  if (!ffmpeg) return t.skip('no ffmpeg');
  // 2 s at 10 fps: frame n is drawn with its number's brightness, so we can tell which one came back.
  const src = path.join(dir, 'count.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=black:size=64x48:rate=10:duration=2', '-vf', "geq=lum='N*12':cb=128:cr=128", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '0', src);
  const bright = (f: string) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
    return r.stdout[0];
  };
  const first = await runTool('video.frame', { at: 'first' }, { video: src });
  const mid = await runTool('video.frame', { at: '1' }, { video: src });
  const last = await runTool('video.frame', { at: 'last' }, { video: src });
  assert.equal(first.result.width, 64);
  assert.ok(bright(first.files[0]) < 20, String(bright(first.files[0])));
  assert.ok(Math.abs(bright(mid.files[0]) - 10 * 12) < 20, String(bright(mid.files[0])));
  assert.ok(bright(last.files[0]) > 19 * 12 - 20, `last frame brightness ${bright(last.files[0])}`);
  await assert.rejects(runTool('video.frame', { at: '5' }, { video: src }), /past the end/);
  const jpg = await runTool('video.frame', { at: 'last', format: 'jpg' }, { video: src });
  assert.equal(jpg.emitted[0].ext, '.jpg');
});

test('video.still: an image becomes an MP4 of the length asked, at its own even size or the size given, with a push-in', async (t) => {
  if (!ffmpeg) return t.skip('no ffmpeg');
  const img = path.join(dir, 'still.png');
  ff('-f', 'lavfi', '-i', 'testsrc=size=301x201', '-frames:v', '1', img);
  const own = await runTool('video.still', { seconds: 1.5 }, { image: img });
  const p = await probeOf(own.files[0]);
  const v = p.streams!.find((s) => s.codec_type === 'video')!;
  assert.deepEqual([v.width, v.height], [300, 200]);
  assert.equal(v.codec_name, 'h264');
  assert.ok(p.streams!.some((s) => s.codec_type === 'audio'), 'a silent track, so compose can mix it');
  assert.ok(Math.abs(Number(p.format!.duration) - 1.5) < 0.1, String(p.format!.duration));
  const sized = await runTool('video.still', { seconds: 1, width: 320, height: 180, zoom: { from: 1, to: 1.3 } }, { image: img });
  const s = (await probeOf(sized.files[0])).streams!.find((x) => x.codec_type === 'video')!;
  assert.deepEqual([s.width, s.height], [320, 180]);
  await assert.rejects(runTool('video.still', { width: 320 }, { image: img }), /both width and height/);
});
