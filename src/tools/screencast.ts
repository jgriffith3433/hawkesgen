// Playtest video from a CDP screencast: Chromium sends a JPEG each time it draws a new frame, the runner acks it no
// faster than 30 a second (AckPacer) and keeps a 30 fps clock, writing the frame on screen at each tick into an MJPEG stream (no encoding while the
// game plays). After the run, ffmpeg turns the stream into the mp4 on the machine that recorded it (remoteEncodeScript,
// over SSH), or here if that fails. Playwright's recordVideo also screencasts, but encodes VP8 at 25 fps while the
// game plays; this keeps up with 30 fps even with two playtests on the playtester's 4 vCPUs. Measurements:
// docs/playtest-video.md.
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

/**
 * When to ack a screencast frame. Chromium captures and JPEG-encodes the next frame only after the ack, so acking at
 * once made it encode every frame the game drew (54 to 59 a second for a 60 fps game) while the clock keeps 30: half
 * the playtester's capture work and the frames' trip to this machine went to frames that were thrown away. Acking no
 * sooner than one tick after the previous ack caps it at the video's rate without touching a slower game: a game that
 * draws 30 or fewer frames a second has its frames acked at once, as before.
 */
export class AckPacer {
  /** When the latest ack went out or is due. */
  private due = -Infinity;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  readonly interval: number;
  private now: () => number;
  private later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  constructor(fps: number, now: () => number = () => performance.now(), later = (fn: () => void, ms: number) => setTimeout(fn, ms)) {
    this.interval = 1000 / fps;
    this.now = now;
    this.later = later;
  }

  /** Acks now, or one interval after the previous ack. Every frame gets its ack (Chromium may have more than one out). */
  frame(ack: () => void) {
    const now = this.now();
    this.due = Math.max(now, this.due + this.interval);
    const wait = this.due - now;
    if (wait <= 0) return ack();
    const t = this.later(() => {
      this.timers.delete(t);
      ack();
    }, wait);
    this.timers.add(t);
  }

  /** Nothing pending any more (the screencast stopped). */
  cancel() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** Records a Playwright page (Chromium) through a CDP screencast into an MJPEG file at a constant 30 fps. */
export class ScreencastRecorder {
  file: string;
  width: number;
  height: number;
  clock: FrameClock;
  startedAt = 0;
  /** The newest frame (JPEG) and when it arrived (ms since the epoch): what the live view shows (livePlay.ts). */
  latest: Buffer | null = null;
  latestAt = 0;
  private cdp: any = null;
  private stream: fs.WriteStream;
  private lastTs = 0;
  private stopped = false;
  private pacer = new AckPacer(SCREENCAST_FPS);

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
        // Chromium sends the next frame only after the ack: paced to the video's rate (AckPacer).
        if (!this.stopped) this.pacer.frame(() => { if (!this.stopped) this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
        if (this.stopped) return;
        const ts = f.metadata?.timestamp ?? Date.now() / 1000;
        this.lastTs = ts;
        const frame = Buffer.from(f.data, 'base64');
        this.latest = frame;
        this.latestAt = Date.now();
        this.clock.push(frame, ts);
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
      this.pacer.cancel();
      await this.cdp?.send('Page.stopScreencast').catch(() => {});
      this.cdp?.detach().catch(() => {});
      // The last frame stays up until now (the browser's clock is another machine's, so no more than a second on).
      this.clock.end(this.lastTs ? Math.min(Date.now() / 1000, this.lastTs + 1) : 0);
    }
    await new Promise<void>((resolve) => (this.stream.closed ? resolve() : this.stream.end(() => resolve())));
    return { file: this.file, frames: this.clock.frames, written: this.clock.written, seconds: this.clock.written / SCREENCAST_FPS };
  }
}

/** The scale and pad filter: the viewport's size (even), the frame centred. */
export function sizeFilter({ width, height }: { width: number; height: number }) {
  const w = Math.ceil(width / 2) * 2;
  const h = Math.ceil(height / 2) * 2;
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

/** ffmpeg arguments for the MJPEG stream -> H.264 mp4 at the viewport's size (even), 30 fps. */
export function mjpegToMp4Args(input: string, out: string, viewport: { width: number; height: number }) {
  return ['-y', '-loglevel', 'error', '-f', 'mjpeg', '-framerate', String(SCREENCAST_FPS), '-i', input,
    '-vf', sizeFilter(viewport),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}

/**
 * A bash script that encodes on the machine that recorded the video (the playtester or a GPU server): the MJPEG comes
 * in on stdin, the mp4 goes out on stdout, what happened on stderr ("encoder: <name>" first). NVENC when the GPU has
 * it (the T4 does), else libx264 at the same settings as here; ffmpeg is installed once if it's missing. Run niced so
 * a game still playing in the other lane keeps its frame rate. Exits non-zero on failure (the caller encodes here).
 */
export function remoteEncodeScript(viewport: { width: number; height: number }) {
  const common = `-y -loglevel error -f mjpeg -framerate ${SCREENCAST_FPS} -i pipe:0 -vf '${sizeFilter(viewport)}'`;
  return [
    'set -o pipefail',
    '[ -d /var/lib/hawkes ] && sudo -n touch /var/lib/hawkes/last_busy 2>/dev/null',
    'apt() { sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -y -q "$@" </dev/null >&2; }',
    'command -v ffmpeg >/dev/null || apt install ffmpeg || { apt update && apt install ffmpeg; } || { echo "no ffmpeg" >&2; exit 3; }',
    'enc="libx264 -preset veryfast -crf 28"',
    'ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=256x256:d=0.2 -c:v h264_nvenc -f null - </dev/null >/dev/null 2>&1 && enc="h264_nvenc -preset p4 -rc vbr -cq 28 -b:v 0"',
    'echo "encoder: ${enc%% *}" >&2',
    'd=$(mktemp -d) || exit 4',
    'trap "rm -rf $d" EXIT',
    `nice -n 10 ffmpeg ${common} -c:v $enc -pix_fmt yuv420p -movflags +faststart "$d/out.mp4" || exit 5`,
    'cat "$d/out.mp4"',
  ].join('\n');
}
