// Screen capture for one run: one ffmpeg reading the X display (x11grab) with three outputs:
// - the run's video (mp4, H.264: NVENC when the self-test found it, else libx264)
// - JPEG frames for the live view, screenshots and Gen's AI player (image2pipe on fd 1)
// - tiny gray frames (64x36 at 2 fps on fd 3) for the black-screen and frozen-screen checks (display.mjs frameStats)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { GRAY_W, GRAY_H } from './display.mjs';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** Splits a stream of concatenated JPEGs into whole images (ffmpeg's entropy-coded data never holds FFD9). */
export class JpegSplitter {
  constructor(onImage, max = 8 * 1024 * 1024) {
    this.buf = Buffer.alloc(0);
    this.onImage = onImage;
    this.max = max;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) { this.buf = Buffer.alloc(0); return; }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        if (this.buf.length > this.max) this.buf = Buffer.alloc(0);
        return;
      }
      this.onImage(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}

/** The H.264 encoder arguments: NVENC or libx264. */
export const encoderArgs = (nvenc) => (nvenc ? ['h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0'] : ['libx264', '-preset', 'veryfast', '-crf', '28']);

/**
 * Starts recording. opts: { display, width, height, file, fps (30), liveFps (5), liveWidth (960), nvenc, onJpeg(buf),
 * onGray(buf) }. Returns { stop(): Promise<{ file, encoder, bytes, error }>, proc }.
 */
export function startCapture(opts) {
  const { display, width, height, file, fps = 30, liveFps = 5, liveWidth = 960, nvenc = false, onJpeg = () => {}, onGray = () => {} } = opts;
  const enc = encoderArgs(nvenc);
  const lw = Math.min(width, Math.max(160, Math.round(liveWidth / 2) * 2));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', display,
    '-filter_complex', `[0:v]split=3[v][l][g];[l]fps=${liveFps},scale=${lw}:-2[lo];[g]fps=2,scale=${GRAY_W}:${GRAY_H},format=gray[go]`,
    '-map', '[v]', '-c:v', ...enc, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file,
    '-map', '[lo]', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '7', 'pipe:1',
    '-map', '[go]', '-f', 'rawvideo', 'pipe:3',
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
  proc.stdin.on('error', () => {});
  const split = new JpegSplitter(onJpeg);
  proc.stdout.on('data', (d) => split.push(d));
  let gray = Buffer.alloc(0);
  const frame = GRAY_W * GRAY_H;
  proc.stdio[3].on('data', (d) => {
    gray = gray.length ? Buffer.concat([gray, d]) : d;
    while (gray.length >= frame) {
      onGray(Buffer.from(gray.subarray(0, frame)));
      gray = gray.subarray(frame);
    }
  });
  const closed = new Promise((r) => proc.on('close', (code, signal) => r({ code, signal })));
  return {
    proc,
    async stop(ms = 20_000) {
      if (proc.exitCode === null) {
        try { proc.stdin.write('q'); proc.stdin.end(); } catch { /* gone */ }
      }
      const done = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), ms))]);
      if (!done) proc.kill('SIGKILL');
      const bytes = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
      return { file, encoder: enc[0], bytes, error: bytes ? null : (err.trim().split('\n').slice(-3).join(' ') || `ffmpeg ${JSON.stringify(done)}`).slice(0, 500) };
    },
  };
}
