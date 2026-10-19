// The Machines monitor (src/machines.ts): reading the probes' answers, the idle clock, what needs action, and the
// history. No AWS, no SSH: a scratch data folder and canned answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-machines-'));
const M = await import('../src/machines.ts');

const NET = (rx: number, tx: number) => [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  `    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0`,
  `  ens5: ${rx} 100 0 0 0 0 0 0 ${tx} 80 0 0 0 0 0 0`,
].join('\n');

const queue = (running: number) => JSON.stringify({ queue_running: Array(running).fill([1, 'x', {}]), queue_pending: [] });

function gpuAnswer({ comfy = queue(0), stage = 'ready', last = 1_700_000_000 } = {}) {
  return [
    '@now', '1700000600',
    '@uptime', '3600.52 7000.10',
    '@stat1', 'cpu  100 0 100 800 0 0 0 0 0 0',
    '@net1', NET(1000, 2000),
    '@stat2', 'cpu  150 0 150 900 0 0 0 0 0 0',
    '@net2', NET(6000, 2500),
    '@mem', 'MemTotal:       32000000 kB', 'MemAvailable:   8000000 kB',
    '@disk', ' 268435456000 241591910400 26843545600',
    '@gpu', '87, 30000, 46068, 71',
    '@last', String(last), String(last - 100),
    '@idlemin', '60',
    '@stage', stage,
    '@comfy', comfy,
    '@browser', '0', '0',
  ].join('\n');
}

test('a GPU server\'s answer becomes numbers', () => {
  const at = 1_700_000_600_000;
  const m = M.parseLinux(gpuAnswer(), 'gpu', at);
  assert.equal(m.cpu, 50); // 100 busy of 200 ticks
  assert.equal(m.memTotal, 32000000 * 1024);
  assert.equal(m.memUsed, 24000000 * 1024);
  assert.equal(m.gpu, 87);
  assert.equal(m.vramTotal, 46068 * 1048576);
  assert.equal(m.temp, 71);
  assert.equal(m.diskSize, 268435456000);
  assert.equal(m.diskFree, 26843545600);
  assert.equal(m.netIn, 5000); // loopback left out
  assert.equal(m.netOut, 500);
  assert.equal(m.uptime, 3600.52);
  assert.equal(m.idleMinutes, 60);
  assert.equal(m.lastActive, 1_700_000_000_000);
  assert.equal(m.service, 'up');
  assert.equal(m.busy, false);
  assert.equal(M.parseLinux(gpuAnswer({ comfy: queue(1) }), 'gpu', at).busy, true);
  assert.equal(M.parseLinux(gpuAnswer({ comfy: '' }), 'gpu', at).service, 'down');
  assert.equal(M.parseLinux(gpuAnswer({ comfy: '', stage: 'installing' }), 'gpu', at).service, null);
});

test('the playtester is busy while a browser is connected, down when nothing listens', () => {
  const text = gpuAnswer().replace('@browser\n0\n0', '@browser\n2\n1');
  const m = M.parseLinux(text, 'playtester', 1_700_000_600_000);
  assert.equal(m.busy, true);
  assert.equal(m.service, 'up');
  assert.equal(M.parseLinux(gpuAnswer(), 'playtester').service, 'down');
});

test('the build server\'s PowerShell answer becomes numbers', () => {
  const at = Date.parse('2026-10-19T12:00:00Z');
  const json = JSON.stringify({ now: at / 1000, boot: '2026-10-19T10:00:00.0000000Z', cpu: 12, memTotal: 32e9, memFree: 20e9, diskUsed: 273e9, diskFree: 27e9, rx: 1234, tx: 99, last: '2026-10-19T11:30:00.0000000Z\r\n', idleMinutes: '30\r\n', busy: false });
  const m = M.parseWindows(`#< CLIXML\r\n${json}\r\n`, at);
  assert.equal(m.cpu, 12);
  assert.equal(m.memUsed, 12e9);
  assert.equal(m.diskSize, 300e9);
  assert.equal(m.netIn, 1234);
  assert.equal(m.uptime, 7200);
  assert.equal(m.lastActive, Date.parse('2026-10-19T11:30:00Z'));
  assert.equal(m.idleMinutes, 30);
  assert.equal(m.gpu, null);
  // No last-activity file yet: the clock starts at boot.
  assert.equal(M.parseWindows(JSON.stringify({ now: at / 1000, boot: '2026-10-19T10:00:00Z', last: null }), at).lastActive, Date.parse('2026-10-19T10:00:00Z'));
});

const machine = (patch: any = {}): any => ({
  id: 'i-abc', kind: 'gpu', name: 'GPU server i-abc', state: 'running', region: 'us-east-1', type: 'g6e.xlarge', pricePerHour: 1.86,
  launched: null, disposable: false, purpose: null, jobs: [], idle: null, metrics: null, error: null, ...patch,
});

test('idle time counts from the last activity, unless it is busy or running a job', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const metrics: any = { busy: false, lastActive: now - 55 * 60_000, idleMinutes: 60 };
  assert.deepEqual(M.idleOf(metrics, false, false, now), { minutes: 55, busy: false, action: 'stops', stopsAt: now + 5 * 60_000 });
  assert.equal(M.idleOf(metrics, true, false, now)!.action, 'is terminated');
  assert.equal(M.idleOf(metrics, false, true, now)!.minutes, 0);
  assert.equal(M.idleOf({ ...metrics, busy: true }, false, false, now)!.busy, true);
  assert.equal(M.idleOf(null, false), null);
});

test('alerts: unreachable first, then full disks, idle machines, heat', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const metrics: any = { uptime: 7200, diskUsed: 91, diskSize: 100, diskFree: 9e9, temp: 70, memUsed: 1, memTotal: 2, idleMinutes: 60, service: 'up' };
  const list = [
    machine({ metrics, idle: { minutes: 55, busy: false, action: 'stops', stopsAt: now + 5 * 60_000 } }),
    machine({ id: 'builder', kind: 'builder', name: 'Build server', metrics: { ...metrics, diskUsed: 50 }, idle: { minutes: 3, busy: false, action: 'stops', stopsAt: null } }),
    machine({ id: 'playtester', kind: 'playtester', name: 'Playtester', error: 'ssh failed: timed out', launched: new Date(now - 3600_000).toISOString() }),
    machine({ id: 'i-off', state: 'stopped', error: 'old' }),
  ];
  const a = M.alertsFor(list, now);
  assert.deepEqual(a.map((x) => x.level), ['bad', 'warn', 'warn']);
  assert.match(a[0].text, /^Playtester not answering: ssh failed/);
  assert.equal(a[1].text, 'GPU server i-abc disk 91% (9 GB free)');
  assert.equal(a[2].text, 'GPU server i-abc idle 55 min, $1.86/hr (stops in about 5 min)');
  assert.deepEqual(M.alertsFor([machine({ error: 'ssh failed', launched: new Date(now - 60_000).toISOString() })], now), []); // still booting
  const down = M.alertsFor([machine({ kind: 'playtester', name: 'Playtester', metrics: { ...metrics, diskUsed: 10, service: 'down' } })], now);
  assert.equal(down[0].text, 'Playtester down: its browser server isn\'t listening');
  assert.deepEqual(M.alertsFor([machine({ metrics: { ...metrics, diskUsed: 10 } })], now), []);
});

test('history is kept per machine and averaged into buckets', () => {
  const now = Date.now();
  const base: any = M.parseLinux(gpuAnswer(), 'gpu', now);
  for (let i = 0; i < 10; i++) M.recordSample('i-hist', 'gpu', { ...base, at: now - (10 - i) * 60_000, cpu: i * 10 });
  M.recordSample('i-old', 'gpu', { ...base, at: now - 2 * 86400_000 });
  const h = M.history({ id: 'i-hist', hours: 1, points: 60, now });
  assert.equal(h.machines['i-hist'].length, 10);
  assert.equal(h.machines['i-hist'][9].cpu, 90);
  assert.equal(h.machines['i-hist'][0].disk, 90);
  const all = M.history({ hours: 24, now });
  assert.ok(all.machines['i-hist']);
  assert.equal(all.machines['i-old'], undefined);
  assert.ok(M.history({ hours: 72, now }).machines['i-old']);
});
