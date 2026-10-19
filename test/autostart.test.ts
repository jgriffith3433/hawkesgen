// Auto start against a fake fleet (no AWS): starts stopped US servers only, moves on to another zone or region when a
// start fails, leaves a failed server alone for a while, launches only with autoLaunch. Plus the settings migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-autostart-'));
const { autoStartRound, BACKOFF_MS, BACKOFF_MIN_MS, BOOT_SECONDS, backoffMs } = await import('../src/autostart.ts');
const { loadSettings, saveSettings, paths } = await import('../src/config.ts');

type S = { id: string; region: string; zone: string; state: string; purpose?: string; imageSource?: string };
const sv = (id: string, zone: string, state = 'stopped', extra: Partial<S> = {}): S => ({ id, region: zone.slice(0, -1), zone, state, ...extra });

function fakeFleet(servers: S[], fail: Record<string, string> = {}, image = true) {
  const calls = { start: [] as string[], launch: 0 };
  return {
    calls,
    fleet: {
      status: async () => servers.map((s) => ({ exists: true, pricePerHour: 1, ...s })),
      start: async (id: string) => {
        calls.start.push(id);
        if (fail[id]) throw Object.assign(new Error(`no ${fail[id]}`), { kind: fail[id] });
        servers.find((s) => s.id === id)!.state = 'pending';
      },
      launch: async () => {
        calls.launch += 1;
        return { id: 'i-new', region: 'us-west-2' };
      },
      imageAvailable: async () => image,
    },
  };
}
const opts = { servers: 4, autoLaunch: false };

test('starts one stopped server per waiting job, US only, never launches without autoLaunch', async () => {
  const f = fakeFleet([sv('i-eu', 'eu-north-1a'), sv('i-a', 'us-east-1a'), sv('i-b', 'us-east-2a'), sv('i-run', 'us-west-2a', 'running'), sv('i-pt', 'us-east-1b', 'stopped', { purpose: 'playtester' })]);
  const r = await autoStartRound(3, opts, f.fleet, new Map());
  assert.deepEqual(f.calls.start, ['i-a', 'i-b']);
  assert.equal(f.calls.launch, 0);
  assert.match(r.note, /started server i-a \(us-east-1a\) for waiting jobs/);
  assert.match(r.note, /started server i-b/);
});

test('respects fleet.servers', async () => {
  const f = fakeFleet([sv('i-1', 'us-east-1a', 'running'), sv('i-2', 'us-east-1a', 'running'), sv('i-3', 'us-east-1b'), sv('i-4', 'us-east-2a'), sv('i-5', 'us-west-2a')]);
  await autoStartRound(9, { servers: 3, autoLaunch: true }, f.fleet, new Map());
  assert.deepEqual(f.calls.start, ['i-3']);
  assert.equal(f.calls.launch, 0);
});

test('a failed start moves on to another zone or region in the same round and is left alone for a while', async () => {
  const servers = [sv('i-a', 'us-east-1a'), sv('i-a2', 'us-east-1a'), sv('i-q', 'us-east-2a'), sv('i-q2', 'us-east-2b'), sv('i-w', 'us-west-2a')];
  const f = fakeFleet(servers, { 'i-a': 'capacity', 'i-q': 'quota' });
  const backoff = new Map();
  const now = 1_000_000;
  const r = await autoStartRound(1, opts, f.fleet, backoff, now);
  // i-a2 shares the full zone, i-q2 the region without quota: both skipped.
  assert.deepEqual(f.calls.start, ['i-a', 'i-q', 'i-w']);
  assert.deepEqual(r.started.map((s) => s.id), ['i-w']);
  assert.deepEqual(r.failed.map((x) => [x.id, x.kind]), [['i-a', 'capacity'], ['i-q', 'quota']]);
  assert.deepEqual([...backoff.keys()], ['i-a', 'i-q']);

  // Next round (one more job), within the first miss's backoff: the failed ones aren't retried; the others are.
  const r2 = await autoStartRound(2, opts, f.fleet, backoff, now + 60_000);
  assert.deepEqual(f.calls.start.slice(3), ['i-a2']);
  assert.deepEqual(r2.started.map((s) => s.id), ['i-a2']);

  // After the backoff they're tried again; a second miss in a row waits twice as long.
  servers.find((s) => s.id === 'i-a2')!.state = 'stopped';
  const later = now + BACKOFF_MIN_MS + 1;
  await autoStartRound(2, opts, f.fleet, backoff, later);
  assert.equal(f.calls.start[4], 'i-a');
  assert.equal(backoff.get('i-a').until, later + 2 * BACKOFF_MIN_MS); // still full: left alone again, longer
  assert.equal(backoff.get('i-a').misses, 2);
});

test('the backoff doubles from 2 minutes up to 15', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffMs), [2, 4, 8, 15, 15, 15].map((m) => m * 60_000));
  assert.equal(BACKOFF_MS, 15 * 60_000);
});

test('starts servers in different zones at once, one per server wanted', async () => {
  const servers = [sv('i-a', 'us-east-1c'), sv('i-a2', 'us-east-1c'), sv('i-b', 'us-east-2b'), sv('i-c', 'us-west-2a')];
  let inFlight = 0;
  let most = 0;
  const f = fakeFleet(servers);
  const start = f.fleet.start;
  f.fleet.start = async (id: string) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return start(id);
  };
  const r = await autoStartRound(3, opts, f.fleet, new Map());
  assert.equal(most, 3); // all three at the same time
  assert.deepEqual(r.started.map((s) => s.id).sort(), ['i-a', 'i-b', 'i-c']);
  assert.equal(r.expectedWait, BOOT_SECONDS);
});

test('when nothing could start, the round says when the next try is and the expected wait', async () => {
  // This afternoon (2026-10-19): every stopped server in a full zone.
  const servers = [sv('i-1', 'us-east-1c'), sv('i-2', 'us-east-1c'), sv('i-3', 'us-east-2b')];
  const f = fakeFleet(servers, { 'i-1': 'capacity', 'i-2': 'capacity', 'i-3': 'capacity' });
  const backoff = new Map();
  const now = 5_000_000;
  const r = await autoStartRound(1, opts, f.fleet, backoff, now);
  // One server wanted: one try per zone, wave after wave; i-2 shares i-1's full zone and waits for the next round.
  assert.deepEqual(f.calls.start.sort(), ['i-1', 'i-3']);
  assert.deepEqual(r.started, []);
  assert.equal(r.nextTry, now + BACKOFF_MIN_MS);
  assert.equal(r.expectedWait, BACKOFF_MIN_MS / 1000 + BOOT_SECONDS);
  assert.match(r.note, /next try in 2 min/);
  // Next round: only i-2 (not tried yet) is tried; the others are in their backoff, and the note still says when.
  const r2 = await autoStartRound(1, opts, f.fleet, backoff, now + 30_000);
  assert.deepEqual(f.calls.start.slice(2), ['i-2']);
  assert.equal(r2.nextTry, now + BACKOFF_MIN_MS);
});

test('launches from the image only with autoLaunch, and only when no stopped server is left', async () => {
  const off = fakeFleet([sv('i-run', 'us-east-1a', 'running')]);
  const r = await autoStartRound(2, opts, off.fleet, new Map());
  assert.equal(off.calls.launch, 0);
  assert.match(r.note, /launching new ones is off/);
  const on = fakeFleet([sv('i-run', 'us-east-1a', 'running')]);
  const r2 = await autoStartRound(2, { servers: 4, autoLaunch: true }, on.fleet, new Map());
  assert.equal(on.calls.launch, 1);
  assert.deepEqual(r2.launched, { id: 'i-new', region: 'us-west-2' });
});

test('settings: auto start on, launching off; old settings files are moved over once, then J\'s choice sticks', () => {
  assert.equal(loadSettings().fleet.auto, true);
  assert.equal(loadSettings().fleet.autoLaunch, false);
  fs.writeFileSync(paths.settings, JSON.stringify({ fleet: { servers: 4, auto: false, idleMinutes: 60 } }));
  assert.equal(loadSettings().fleet.auto, true);
  assert.equal(loadSettings().fleet.autoLaunch, false);
  saveSettings({ fleet: { ...loadSettings().fleet, auto: false } });
  assert.equal(loadSettings().fleet.auto, false);
  assert.equal(JSON.parse(fs.readFileSync(paths.settings, 'utf8')).fleet.autoLaunch, false);
});
