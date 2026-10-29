// Gen's session protocol, version 1 (docs/playtest-runners.md, "The session protocol"; Gen's side is
// src/providers/playtester/native.ts). The runner's own messages (server.mjs header) came first; this turns a Gen start
// into one the Run understands and the Run's messages into Gen's: `accepted` first, steps, logs by stream, state and
// events flat, `crash` for an early exit, a final `perf`, every file back over the session (`file`, binary chunks with
// type byte 2, `fileEnd`), live frames with type byte 1, then `result` in Gen's shape. A start without `v` keeps the
// runner's own protocol (signed upload URLs), as the local test conductor uses it.

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

export const isGenStart = (m) => m && m.type === 'start' && m.v === 1;

/** A Gen start as the Run's start: same build and target; limits, live view and no upload targets (files go in-band). */
export function runStart(m) {
  return {
    type: 'start', target: m.target, build: { url: m.build?.url, ...(m.build?.sha256 ? { sha256: m.build.sha256 } : {}) },
    exe: m.exe ?? undefined, args: Array.isArray(m.args) ? m.args : [], scenario: m.scenario || 'smoke', options: m.options ?? undefined,
    limits: { seconds: Number(m.timeout) || undefined, bootSeconds: Number(m.bootTimeout) || undefined, shotEvery: Number(m.shotEvery) || undefined },
    live: { fps: Number(m.liveFps) || 2, width: Math.min(1280, Number(m.width) || 960), frames: true },
    inband: true,
  };
}

const STREAMS = { runner: 'stdout', game: 'player', sdk: 'sdk', stderr: 'stderr', stdout: 'stdout' };
const CHUNK = 256 * 1024;

/**
 * The session's io for a Gen conductor: wraps the socket's `out` (JSON) and raw binary send. Returns { io, accepted }.
 * `send(obj)` translates; `sendFrame(jpeg)` prefixes byte 1; `sendFile(meta, path)` streams one file.
 */
export function genIo(ws, base, ctx) {
  const json = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  let lastPhase = '';
  const io = {
    log: base.log,
    sendFrame(jpeg) {
      if (ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(Buffer.concat([Buffer.from([1]), jpeg]), { binary: true });
    },
    async sendFile(meta, file) {
      if (!file || !fs.existsSync(file)) return;
      const bytes = fs.statSync(file).size;
      json({ type: 'file', name: meta.name, kind: meta.kind, mime: meta.mime, bytes, ...(meta.t != null ? { t: meta.t } : {}), ...(meta.reason ? { reason: meta.reason } : {}), ...(meta.scene ? { scene: meta.scene } : {}) });
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
          const n = fs.readSync(fd, buf, 0, CHUNK, null);
          if (!n) break;
          const chunk = buf.subarray(0, n);
          hash.update(chunk);
          if (ws.readyState !== 1) return;
          ws.send(Buffer.concat([Buffer.from([2]), chunk]), { binary: true });
          // Don't outrun the socket: wait while a lot is buffered.
          while (ws.readyState === 1 && ws.bufferedAmount > 8 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        fs.closeSync(fd);
      }
      json({ type: 'fileEnd', name: meta.name, sha256: hash.digest('hex') });
    },
    send(m) {
      const t = m.t ?? 0;
      switch (m.type) {
        case 'status':
          if (m.phase && m.phase !== lastPhase) { lastPhase = m.phase; json({ type: 'step', text: String(m.phase) }); }
          return;
        case 'first-frame': return json({ type: 'step', text: `first frame after ${m.seconds} s` });
        case 'log': return json({ type: 'log', t, stream: STREAMS[m.source] ?? 'stdout', line: m.line });
        case 'hello': return json({ type: 'event', t, kind: 'hello', ...m.hello });
        case 'state': return json({ type: 'state', t, ...(m.state ?? {}) });
        case 'event': return json({ type: 'event', t, ...(m.event ?? {}) });
        case 'problem': return json({ type: 'event', t, kind: 'problem', severity: m.severity, message: m.message });
        case 'smoke-input': return json({ type: 'event', t, kind: 'input', input: m.input });
        case 'exit': return; // the result says whether it was a crash (an exit at the end of a run is not one)
        case 'ack': return json(m);
        case 'error': return json({ type: 'refused', reason: m.error, retry: false });
        case 'result': return; // sent by finishGen, after the files
        default: return json(m);
      }
    },
  };
  const accepted = () => json({
    type: 'accepted', runner: os.hostname(), machine: process.env.RUNPOD_POD_ID ?? null,
    gpu: ctx.selftest?.gpu?.name ?? (ctx.selftest?.software ? 'software' : null), os: 'linux',
  });
  return { io, accepted, json };
}

/** After the Run built its report: the crash (an early exit), the final perf, every file, then Gen's result. */
export async function finishGen(g, report, files) {
  if (report.crashed) {
    g.json({
      type: 'crash', t: report.exitAt ?? report.seconds, kind: report.signal ? 'signal' : report.exitCode != null ? 'exit' : 'hang',
      code: report.exitCode ?? null, signal: report.signal ?? null, message: String(report.error ?? 'the game stopped before the run ended').slice(0, 2000),
      stack: (report.output ?? []).filter((l) => /error|exception|fault|fatal|abort|segmentation|unhandled|at /i.test(l)).slice(-30).join('\n') || null,
      dump: files.find((f) => f.kind === 'dump')?.name ?? null,
    });
  }
  const p = report.perf ?? {};
  const ft = p.frameTimes;
  const fpsAvg = ft?.fpsAvg ?? p.gameFps?.avg ?? null;
  g.json({
    type: 'perf', final: true, t: report.seconds,
    fps: { average: fpsAvg, worst: p.gameFps?.min ?? null, p1: ft?.fps1Low ?? null },
    frameTimes: ft ? { p99: ft.frameTimeP99Ms ?? undefined, max: ft.frameTimeMaxMs ?? undefined } : undefined,
    cpu: { average: p.cpuPctAvg ?? undefined, max: p.cpuPctMax ?? undefined }, gpu: { average: p.gpuUtilAvg ?? undefined },
    memoryMB: { max: p.memoryMBMax ?? undefined }, vramMB: { max: p.gpuMemMBMax ?? undefined }, source: ft ? 'mangohud' : 'runner',
  });
  for (const f of files) await g.io.sendFile(f, f.path);
  const outcome = report.crashed ? 'crashed' : report.outcome ?? 'done';
  g.json({
    type: 'result', outcome, seconds: report.seconds, loadSeconds: report.firstFrameSeconds ?? null,
    contract: Boolean(report.hello), scenarios: report.hello?.scenarios ?? null,
    report: { metrics: report.report?.metrics ?? {}, events: report.events ?? [], log: report.logs?.slice?.(-50) ?? [] },
    problems: (report.problems ?? []).map((x) => ({ severity: x.severity, message: x.message, source: 'runner' })),
    software: Boolean(report.machine?.software), ...(report.machine?.software ? { softwareBecause: 'no GPU path on this worker' } : {}),
    renderer: report.machine?.vulkan ?? report.machine?.gl ?? null, exe: report.exe, target: report.target,
  });
}
