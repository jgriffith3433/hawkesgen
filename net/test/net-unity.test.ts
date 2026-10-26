// The Unity package's WebGL bridge (clients/unity/com.hawkes.net/Runtime/Plugins/WebGL/HawkesNet.jslib) run as Unity
// would run it, with Emscripten's helpers stubbed (UTF8ToString, SendMessage, _malloc), against the real SDK and the
// Hawkes Net service (in this process): join, the ready event with the peers, a peer arriving, messages both ways as
// JSON, poses read once a frame, leaving. The C# side (HawkesNet.cs) parses exactly these events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { startTestHub } = await import('./helper.ts');
const hub = await startTestHub();
const endpoint = hub.endpoint;
test.after(async () => { for (const h of Object.keys((globalThis as any).__hawkesNet?.rooms ?? {})) lib.HawkesNet_Leave(Number(h)); await hub.stop(); });

// Emscripten as Unity's WebGL build gives a jslib: strings are pointers into the heap; here a pointer is an index.
const heap: (string | null)[] = [null];
const ptr = (s: string) => (heap.push(s), heap.length - 1);
const got: any[] = [];
const lib: Record<string, Function> = {};
const env = {
  mergeInto: (_l: unknown, fns: Record<string, Function>) => Object.assign(lib, fns),
  LibraryManager: { library: {} },
  UTF8ToString: (p: number) => heap[p] ?? '',
  SendMessage: (to: string, method: string, json: string) => { assert.equal(to, 'HawkesNet'); assert.equal(method, 'OnNet'); got.push(JSON.parse(json)); },
  lengthBytesUTF8: (s: string) => Buffer.byteLength(s),
  _malloc: () => heap.push(null) - 1,
  stringToUTF8: (s: string, p: number) => { heap[p] = s; },
};
const src = fs.readFileSync(new URL('../../clients/unity/com.hawkes.net/Runtime/Plugins/WebGL/HawkesNet.jslib', import.meta.url), 'utf8');
new Function(...Object.keys(env), src)(...Object.values(env));
(globalThis as any).window = globalThis;

const wait = async (pred: () => any, ms = 5000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const sdkUrl = new URL('../../clients/js/hawkes-net.mjs', import.meta.url).href;
const opts = (name: string) => JSON.stringify({ project: 'netdemo', endpoint, name, transport: 'relay', sdkUrl, leaveOnHide: false, log: false, ticketUrl: '', role: 'player' });

test('a Unity game joins through the bridge: ready, peers, messages as JSON both ways, poses once a frame, leave', async () => {
  lib.HawkesNet_Join(1, ptr('unity1'), ptr(opts('Ada')), ptr('HawkesNet'));
  const ready1 = await wait(() => got.find((e) => e.h === 1 && e.e === 'ready'), 5000, 'room 1 ready');
  assert.equal(ready1.transport, 'relay');
  assert.ok(ready1.peer, 'its own peer id');
  assert.deepEqual(JSON.parse(ready1.data), [], 'nobody else yet');

  lib.HawkesNet_Join(2, ptr('unity1'), ptr(opts('Bo')), ptr('HawkesNet'));
  const ready2 = await wait(() => got.find((e) => e.h === 2 && e.e === 'ready'), 5000, 'room 2 ready');
  assert.deepEqual(JSON.parse(ready2.data).map((p: any) => p.name), ['Ada'], 'the peers already there');
  const joined = await wait(() => got.find((e) => e.h === 1 && e.e === 'join'), 5000, 'Ada hears Bo');
  assert.equal(joined.name, 'Bo');
  assert.equal(joined.peer, ready2.peer);

  assert.equal(lib.HawkesNet_Send(1, ptr('chat'), ptr('{"text":"hello"}'), 1, ptr('')), 1);
  const msg = await wait(() => got.find((e) => e.h === 2 && e.e === 'msg' && e.kind === 'chat'), 5000, 'Bo gets the chat');
  assert.deepEqual(JSON.parse(msg.data), { text: 'hello' });
  assert.equal(msg.peer, ready1.peer);
  assert.equal(lib.HawkesNet_Send(9, ptr('chat'), ptr(''), 1, ptr('')), 0, 'no such room');

  lib.HawkesNet_Pose(1, 1.5, 2, -3.25, 1.25); // yaw in radians on the wire (HawkesNet.cs takes degrees)
  const poses = await wait(() => { const p = lib.HawkesNet_Poses(2); return p ? heap[p] : null; }, 5000, 'a pose for Bo');
  const [id, ...xyz] = String(poses).split(';')[0].split(',');
  assert.equal(id, ready1.peer);
  assert.deepEqual(xyz.map(Number), [1.5, 2, -3.25, 1.25]);
  assert.equal(lib.HawkesNet_Poses(2), null, 'nothing new since the last read');
  assert.ok(lib.HawkesNet_Now(1) > 0);

  lib.HawkesNet_Leave(1);
  const left = await wait(() => got.find((e) => e.h === 2 && e.e === 'leave'), 5000, 'Bo hears Ada leave');
  assert.equal(left.peer, ready1.peer);
  lib.HawkesNet_Leave(2);
});

test('a refused join reaches the game as an error event, never a throw', async () => {
  lib.HawkesNet_Join(3, ptr('bad room!'), ptr(opts('Cy')), ptr('HawkesNet'));
  const err = await wait(() => got.find((e) => e.h === 3 && e.e === 'error'), 5000, 'the error');
  assert.ok(err.data, 'with a reason');
});
