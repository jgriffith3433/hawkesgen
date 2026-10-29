// The two sides of a desktop playtest agree (docs/playtest-runners.md, "The session protocol"): Gen's conductor
// (src/providers/playtester/native.ts runSession) talks to the runner's Gen adapter (server/play-native/genproto.mjs)
// through an in-memory socket. The runner's Run itself needs Linux, a display and a GPU, so its side here is what the Run
// sends (statuses, a log line, state, a frame) and what it hands over at the end (its report and files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runSession } = await import('../src/providers/playtester/native.ts');
// @ts-ignore: plain JS module of the runner image
const G = await import('../server/play-native/genproto.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-native-proto-'));
const video = path.join(tmpDir, 'video.mp4');
fs.writeFileSync(video, crypto.randomBytes(700_000)); // more than two chunks
const logFile = path.join(tmpDir, 'logs.txt');
fs.writeFileSync(logFile, 'Player.log: NullReferenceException at Boss.Update\n');

/** A socket pair: the conductor's WebSocket (what runSession constructs) wired to the runner's ws side. */
function fakeSocket(runnerPlays: (runner: any, start: any) => Promise<void>, seen: { headers?: any; start?: any }) {
  return class FakeWS {
    onopen?: () => void; onmessage?: (e: any) => void; onclose?: (e: any) => void; onerror?: () => void;
    readyState = 1;
    constructor(_url: string, opts: any) {
      seen.headers = opts?.headers;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data: string) {
      const m = JSON.parse(data);
      if (m.type !== 'start') return;
      seen.start = m;
      const self = this;
      const runner = {
        readyState: 1, bufferedAmount: 0,
        send(d: any) {
          const data = typeof d === 'string' ? d : (d as Buffer).buffer.slice((d as Buffer).byteOffset, (d as Buffer).byteOffset + (d as Buffer).length);
          self.onmessage?.({ data });
        },
      };
      void runnerPlays(runner, m).then(() => self.onclose?.({ code: 1000, reason: 'done' }));
    }
    close() { this.readyState = 3; }
  };
}

const start = {
  job: 'j_test', project: 'org_aaaaaaaa.game', target: 'proton' as const, build: { url: 'https://storage.example/build.zip?sig=1', kind: 'archive' as const },
  exe: 'Game.exe', args: [], scenario: 'smoke', mode: 'auto', options: null, seed: 1, speed: 1, timeout: 120, bootTimeout: 60, width: 1280, height: 720, shotEvery: 5, liveFps: 2,
};

test('a desktop run: accepted, steps, logs, state, frames, a crash, perf, files with checksums, the result', async () => {
  const seen: any = {};
  const steps: string[] = [];
  let frames = 0;
  const WS = fakeSocket(async (ws, m) => {
    assert.ok(G.isGenStart(m));
    const rs = G.runStart(m);
    assert.equal(rs.target, 'proton');
    assert.equal(rs.build.url, start.build.url);
    assert.equal(rs.inband, true);
    const g = G.genIo(ws, { log() {} }, { selftest: { gpu: { name: 'RTX A4000' } } });
    g.accepted();
    g.io.send({ type: 'status', phase: 'launching', t: 1 });
    g.io.send({ type: 'status', phase: 'launching', t: 1.5 }); // repeated: one step
    g.io.send({ type: 'log', source: 'game', line: 'Boss spawned', t: 3 });
    g.io.send({ type: 'state', state: { scene: 'Level 1', progress: 0.4 }, t: 4 });
    g.io.sendFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    g.io.send({ type: 'exit', code: 139, signal: null, t: 9 }); // left to the result
    await G.finishGen(g, {
      crashed: true, outcome: 'error', exitCode: 139, signal: null, exitAt: 9, seconds: 10, firstFrameSeconds: 2.5,
      error: 'exit code 139', output: ['at Boss.Update ()', 'Segmentation fault'], hello: null, events: [], logs: [],
      problems: [{ severity: 'bug', message: 'the game stopped' }], exe: 'Game.exe', target: 'proton',
      perf: { frameTimes: { fpsAvg: 58.2, fps1Low: 31, frameTimeP99Ms: 33, frameTimeMaxMs: 80 }, cpuPctAvg: 40, memoryMBMax: 900 },
      machine: { software: false, vulkan: 'NVIDIA RTX A4000' },
    }, [
      { name: 'video.mp4', kind: 'video', mime: 'video/mp4', path: video },
      { name: 'logs.txt', kind: 'log', mime: 'text/plain', path: logFile },
    ]);
  }, seen);

  const r = await runSession({ url: 'https://runner.example', token: 'tok', gatewayKey: 'rp_key', id: 'native-test' }, start, {
    limitMs: 60_000, tmp: (n: string) => path.join(tmpDir, `got-${n}`), WebSocket: WS,
    handlers: { step: (t: string) => steps.push(t), frame: () => { frames++; } },
  });

  // What Gen sent: its keys, and a v1 start the runner understood.
  assert.equal(seen.headers.Authorization, 'Bearer rp_key');
  assert.equal(seen.headers['X-Hawkes-Token'], 'tok');
  assert.equal(seen.start.v, 1);
  // What came back.
  assert.ok(r.accepted);
  assert.match(steps[0], /playing on .*RTX A4000/);
  assert.equal(steps.filter((s) => s === 'launching').length, 1);
  assert.deepEqual(r.logs.map((l: any) => [l.stream, l.line]), [['player', 'Boss spawned']]);
  assert.equal(r.states[0].scene, 'Level 1');
  assert.equal(frames, 1);
  assert.equal(r.crashes.length, 1);
  assert.equal(r.crashes[0].code, 139);
  assert.match(String(r.crashes[0].stack), /Segmentation fault/);
  assert.equal(r.perf?.fps?.average, 58.2);
  assert.deepEqual(r.files.map((f: any) => f.name), ['video.mp4', 'logs.txt']);
  const got = r.files[0];
  assert.equal(got.bytes, 700_000);
  assert.equal(got.sha256, crypto.createHash('sha256').update(fs.readFileSync(video)).digest('hex'));
  assert.deepEqual(fs.readFileSync(got.path), fs.readFileSync(video));
  assert.equal(r.result?.outcome, 'crashed');
  assert.equal(r.result?.loadSeconds, 2.5);
});

test('a start the runner refuses comes back as "refused", so Gen tries the next runner', async () => {
  const WS = fakeSocket(async (ws) => {
    const g = G.genIo(ws, { log() {} }, {});
    g.io.send({ type: 'error', error: 'target is linux or proton' });
  }, {});
  await assert.rejects(
    runSession({ url: 'https://runner.example', token: null, id: 'native-test' }, { ...start, target: 'windows' as any }, { limitMs: 10_000, tmp: (n: string) => path.join(tmpDir, n), WebSocket: WS }),
    /refused the run: target is linux or proton/,
  );
});
