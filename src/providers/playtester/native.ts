// The conductor's side of the runner session protocol (hawkesstudio docs/platform-plan.md 3.3; the protocol is
// docs/playtest-runners.md, "The session protocol"). Gen opens one WebSocket to a native runner (hawkes-play-native:
// Linux, Proton, later Windows) per playtest, says `start` with the build's signed URL, and collects what comes back:
// steps, log lines, the contract's state and events, crashes, perf, live frames, then the files (video, shots, logs,
// dumps, the report) and the `result`. Runners get no cloud credentials: one run token and the build's link.
//
// Frames: binary messages whose first byte is 1 (a JPEG). File bytes: binary messages whose first byte is 2, between a
// `file` and its `fileEnd` (one file at a time).
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { PlaytestTarget } from '../../config.ts';
import type { FetchableBuild } from './intake.ts';

export const SESSION_VERSION = 1;
export const SESSION_PATH = '/session';
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_TOTAL_BYTES = 4 * 1024 ** 3;
const MAX_LOG_LINES = 5000;

export type StartMessage = {
  type: 'start'; v: number; job: string; project: string; target: PlaytestTarget; build: Omit<FetchableBuild, 'source'>;
  exe: string | null; args: string[]; scenario: string; mode: string; options: unknown; seed: number; speed: number;
  timeout: number; bootTimeout: number; width: number; height: number; shotEvery: number; liveFps: number;
};

export type Crash = { t: number; kind: 'exit' | 'signal' | 'exception' | 'hang' | string; code?: number | null; signal?: string | null; message: string; stack?: string | null; dump?: string | null };
export type Perf = {
  fps?: { average: number | null; worst: number | null; p1?: number | null };
  frameTimes?: { p50?: number; p95?: number; p99?: number; max?: number };
  cpu?: { average?: number; max?: number }; gpu?: { average?: number; max?: number };
  memoryMB?: { average?: number; max?: number }; vramMB?: { average?: number; max?: number };
  source?: string;
};
export type SessionFile = { name: string; kind: 'video' | 'shot' | 'log' | 'dump' | 'report' | string; mime: string; path: string; bytes: number; sha256: string; t?: number; reason?: string; scene?: string };

export type SessionResult = {
  accepted: Record<string, unknown> | null;
  result: Record<string, any> | null;
  crashes: Crash[];
  logs: { t: number; stream: string; line: string }[];
  perf: Perf | null;
  perfSamples: (Perf & { t: number })[];
  states: any[];
  events: any[];
  files: SessionFile[];
  closed: { code: number; reason: string } | null;
};

export type SessionHandlers = {
  step?(text: string): void;
  frame?(jpeg: Buffer): void;
  state?(s: any): void;
  log?(line: string): void;
};

/** A runner refused the run or couldn't be reached before it accepted: try the next one (and cool this one down). */
export class RunnerUnavailable extends Error {
  retry: boolean;
  constructor(message: string, retry = true) {
    super(message);
    this.retry = retry;
  }
}

export const sessionUrl = (url: string) => `${url.replace(/^http/, 'ws').replace(/\/+$/, '')}${SESSION_PATH}`;

/**
 * Plays one run on a native runner. Resolves with everything the runner sent once it closes after `result` (or the
 * watchdog stops it: then `result` is null and the caller reports the run stuck with what came). Rejects with
 * RunnerUnavailable when the runner refuses or can't be reached before it accepts.
 */
export function runSession(
  runner: { url: string; token: string | null; id: string },
  start: Omit<StartMessage, 'type' | 'v'>,
  { handlers = {}, signal, limitMs, acceptMs = 5 * 60_000, tmp, WebSocket: WS = (globalThis as any).WebSocket }: {
    handlers?: SessionHandlers; signal?: AbortSignal; limitMs: number; acceptMs?: number;
    /** A scratch path for a file the runner sends. */ tmp: (name: string) => string; WebSocket?: any;
  },
): Promise<SessionResult> {
  const out: SessionResult = { accepted: null, result: null, crashes: [], logs: [], perf: null, perfSamples: [], states: [], events: [], files: [], closed: null };
  const ws = new WS(sessionUrl(runner.url), { headers: { ...(runner.token ? { 'X-Hawkes-Token': runner.token } : {}), 'X-Hawkes-Job': start.job } });
  ws.binaryType = 'arraybuffer';
  return new Promise<SessionResult>((resolve, reject) => {
    let settled = false;
    let total = 0;
    let file: { meta: Omit<SessionFile, 'path' | 'sha256' | 'bytes'> & { bytes: number }; path: string; fd: number; got: number; hash: crypto.Hash } | null = null;
    const timers: NodeJS.Timeout[] = [];
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', onAbort);
      if (file) { try { fs.closeSync(file.fd); } catch { /* closed */ } file = null; }
      try { ws.close(1000); } catch { /* closed */ }
      if (err) reject(err);
      else resolve(out);
    };
    const stop = (reason: string) => {
      try { ws.send(JSON.stringify({ type: 'stop', reason })); } catch { /* closed */ }
      // Give it a moment to send what it has; then it's over.
      timers.push(setTimeout(() => finish(), 60_000));
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => { if (!out.accepted) finish(new RunnerUnavailable(`${runner.id} didn't accept the run within ${Math.round(acceptMs / 1000)} s`)); }, acceptMs));
    timers.push(setTimeout(() => stop(`the run went past its ${Math.round(limitMs / 1000)} s limit`), limitMs));

    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', v: SESSION_VERSION, ...start }));
    ws.onerror = () => { if (!out.accepted) finish(new RunnerUnavailable(`couldn't reach ${runner.id}`)); };
    ws.onclose = (e: any) => {
      out.closed = { code: Number(e?.code ?? 0), reason: String(e?.reason ?? '') };
      if (!out.accepted) return finish(new RunnerUnavailable(`${runner.id} closed the session before accepting (${out.closed.code} ${out.closed.reason})`.trim()));
      finish();
    };
    ws.onmessage = (e: any) => {
      try {
        if (typeof e.data !== 'string') {
          const b = Buffer.from(e.data as ArrayBuffer);
          if (b[0] === 1) return handlers.frame?.(b.subarray(1));
          if (b[0] === 2 && file) {
            const chunk = b.subarray(1);
            file.got += chunk.length;
            total += chunk.length;
            if (file.got > Math.min(file.meta.bytes || MAX_FILE_BYTES, MAX_FILE_BYTES) || total > MAX_TOTAL_BYTES) throw new Error(`${runner.id} sent more of ${file.meta.name} than it said (or more than ${MAX_FILE_BYTES} bytes)`);
            file.hash.update(chunk);
            fs.writeSync(file.fd, chunk);
          }
          return;
        }
        const m = JSON.parse(e.data);
        const t = Number(m.t ?? 0);
        switch (m.type) {
          case 'accepted': out.accepted = m; handlers.step?.(`playing on ${m.runner ?? runner.id}${m.gpu ? ` (${m.gpu})` : ''}${m.os ? `, ${m.os}` : ''}`); break;
          case 'refused': return finish(new RunnerUnavailable(`${runner.id} refused the run: ${String(m.reason ?? 'no reason').slice(0, 300)}`, m.retry !== false));
          case 'step': handlers.step?.(String(m.text ?? '').slice(0, 400)); break;
          case 'log':
            if (out.logs.length < MAX_LOG_LINES) out.logs.push({ t, stream: String(m.stream ?? 'stdout').slice(0, 20), line: String(m.line ?? '').slice(0, 2000) });
            break;
          case 'state': out.states.push({ t, ...m, type: undefined }); if (out.states.length > 2000) out.states.shift(); handlers.state?.(m); break;
          case 'event': if (out.events.length < 2000) out.events.push({ t, ...m, type: undefined }); break;
          case 'crash': out.crashes.push(cleanCrash(m)); handlers.log?.(`crash: ${String(m.message ?? m.kind).slice(0, 200)}`); break;
          case 'perf':
            if (m.final) out.perf = cleanPerf(m);
            else if (out.perfSamples.length < 3600) out.perfSamples.push({ t, ...cleanPerf(m) });
            break;
          case 'file': {
            if (file) throw new Error(`${runner.id} started ${m.name} before ending ${file.meta.name}`);
            const name = String(m.name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
            const path = tmp(`native-${out.files.length}-${name}`);
            file = { meta: { name, kind: String(m.kind ?? 'log'), mime: String(m.mime ?? 'application/octet-stream').slice(0, 80), bytes: Number(m.bytes) || 0, t: m.t, reason: m.reason, scene: m.scene }, path, fd: fs.openSync(path, 'w'), got: 0, hash: crypto.createHash('sha256') };
            break;
          }
          case 'fileEnd': {
            if (!file) break;
            fs.closeSync(file.fd);
            const sha = file.hash.digest('hex');
            if (m.sha256 && m.sha256 !== sha) handlers.log?.(`${file.meta.name}: checksum differs from the runner's (kept, marked)`);
            out.files.push({ ...file.meta, path: file.path, bytes: file.got, sha256: sha });
            file = null;
            break;
          }
          case 'result': out.result = m; break;
          default: break; // newer runners may send more; ignore what we don't know
        }
      } catch (err: any) {
        stop(`protocol error: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    };
  });
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pair = (o: any) => (o && typeof o === 'object' ? { average: num(o.average), max: num(o.max) } : undefined);

export function cleanCrash(m: any): Crash {
  return {
    t: Number(m.t ?? 0), kind: String(m.kind ?? 'exit').slice(0, 20), code: num(m.code) ?? null, signal: m.signal ? String(m.signal).slice(0, 20) : null,
    message: String(m.message ?? '').slice(0, 2000), stack: m.stack ? String(m.stack).slice(0, 20_000) : null, dump: m.dump ? String(m.dump).slice(0, 120) : null,
  };
}

export function cleanPerf(m: any): Perf {
  const ft = m.frameTimes && typeof m.frameTimes === 'object' ? { p50: num(m.frameTimes.p50), p95: num(m.frameTimes.p95), p99: num(m.frameTimes.p99), max: num(m.frameTimes.max) } : undefined;
  return {
    fps: m.fps && typeof m.fps === 'object' ? { average: num(m.fps.average) ?? null, worst: num(m.fps.worst) ?? null, p1: num(m.fps.p1) ?? null } : undefined,
    frameTimes: ft, cpu: pair(m.cpu), gpu: pair(m.gpu), memoryMB: pair(m.memoryMB), vramMB: pair(m.vramMB),
    source: m.source ? String(m.source).slice(0, 40) : undefined,
  };
}

/** Crashes grouped by what they say (the first line of the stack, else the message): "crashed 3 times: …". */
export function groupCrashes(crashes: Crash[]) {
  const groups = new Map<string, { signature: string; count: number; first: Crash }>();
  for (const c of crashes) {
    const sig = (c.stack?.split('\n').find((l) => l.trim()) ?? c.message ?? c.kind).trim().slice(0, 200);
    const g = groups.get(sig);
    if (g) g.count++;
    else groups.set(sig, { signature: sig, count: 1, first: c });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
