// Playtest video from a CDP screencast: Chromium sends a JPEG each time it draws a new frame, the runner acks it at
// once and keeps a 30 fps clock, writing the frame on screen at each tick into an MJPEG stream (no encoding while the
// game plays). ffmpeg turns the stream into the mp4 afterwards. Playwright's recordVideo also screencasts, but encodes
// VP8 at 25 fps on the browser's machine; this moves the encoding off the playtester and keeps up with 30 fps even
// with two playtests on its 4 vCPUs. Measurements: docs/playtest-video.md.
//
// The CDP session belongs to the page, so it follows navigations (site crawls, a game that reloads).
// No dependencies on the rest of Hawkes Gen, so it can be tried on a playtester by itself.

import fs from 'node:fs';

export const SCREENCAST_FPS = 30;
const QUALITY = 60;
/** The longest gap filled with the last frame (a frozen screen still counts, a clock jump doesn't write hours). */
const MAX_GAP_SECONDS = 600;

/** Holds each frame until the next one arrives and writes it once per tick it was on screen: a constant frame rate. */
export class FrameClock {
  fps: number;
  out: (frame: Buffer) => void;
  frames = 0;
  written = 0;
  private prev: Buffer | null = null;
  /** Tick n is at start + n / fps (counted, not summed, so the rate doesn't drift). */
  private start = 0;
  private tick = 0;

  constructor(fps: number, out: (frame: Buffer) => void) {
    this.fps = fps;
    this.out = out;
  }

  /** A frame that went on screen at `ts` (seconds). */
  push(frame: Buffer, ts: number) {
    this.frames++;
    if (!this.prev) this.start = ts;
    else this.fill(ts);
    this.prev = frame;
  }

  /** The end: the last frame stays on screen until `ts` (at least one tick). */
  end(ts: number) {
    if (!this.prev) return;
    this.fill(Math.max(ts, this.at(this.tick) + 1e-6));
  }

  private at(tick: number) {
    return this.start + tick / this.fps;
  }

  private fill(until: number) {
    const stop = Math.min(until, this.at(this.tick) + MAX_GAP_SECONDS);
    while (this.at(this.tick) < stop - 1e-9) {
      this.out(this.prev!);
      this.written++;
      this.tick++;
    }
    // After a capped gap, carry on from the new frame.
    if (stop < until) this.tick = Math.ceil((until - this.start) * this.fps - 1e-9);
  }
}

/** Records a Playwright page (Chromium) through a CDP screencast into an MJPEG file at a constant 30 fps. */
export class ScreencastRecorder {
  file: string;
  width: number;
  height: number;
  clock: FrameClock;
  startedAt = 0;
  private cdp: any = null;
  private stream: fs.WriteStream;
  private lastTs = 0;
  private stopped = false;

  constructor(file: string, { width, height }: { width: number; height: number }) {
    this.file = file;
    this.width = width;
    this.height = height;
    this.stream = fs.createWriteStream(file);
    this.clock = new FrameClock(SCREENCAST_FPS, (f) => this.stream.write(f));
  }

  /** Starts the screencast. Null when it works, else why not. */
  async start(context: any, page: any): Promise<string | null> {
    try {
      this.cdp = await context.newCDPSession(page);
      this.cdp.on('Page.screencastFrame', (f: any) => {
        // Ack first: Chromium sends the next frame only after the ack.
        this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        if (this.stopped) return;
        const ts = f.metadata?.timestamp ?? Date.now() / 1000;
        this.lastTs = ts;
        this.clock.push(Buffer.from(f.data, 'base64'), ts);
      });
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 });
      this.startedAt = Date.now();
      return null;
    } catch (e: any) {
      this.stopped = true;
      return e?.message?.split('\n')[0] ?? String(e);
    }
  }

  /** Stops and closes the file. What was written is usable even if the browser died; the caller limits the wait. */
  async stop() {
    if (!this.stopped) {
      this.stopped = true;
      await this.cdp?.send('Page.stopScreencast').catch(() => {});
      this.cdp?.detach().catch(() => {});
      // The last frame stays up until now (the browser's clock is another machine's, so no more than a second on).
      this.clock.end(this.lastTs ? Math.min(Date.now() / 1000, this.lastTs + 1) : 0);
    }
    await new Promise<void>((resolve) => (this.stream.closed ? resolve() : this.stream.end(() => resolve())));
    return { file: this.file, frames: this.clock.frames, written: this.clock.written, seconds: this.clock.written / SCREENCAST_FPS };
  }
}

/** ffmpeg arguments for the MJPEG stream -> H.264 mp4 at the viewport's size (even), 30 fps. */
export function mjpegToMp4Args(input: string, out: string, { width, height }: { width: number; height: number }) {
  const w = Math.ceil(width / 2) * 2;
  const h = Math.ceil(height / 2) * 2;
  return ['-y', '-loglevel', 'error', '-f', 'mjpeg', '-framerate', String(SCREENCAST_FPS), '-i', input,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}
