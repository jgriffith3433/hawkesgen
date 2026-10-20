// The build server's git fetch (src/providers/builder/gitfetch.ts): a "cannot lock ref" from a racing fetch is retried
// after dropping the stale ref with --prune, instead of failing the Unity build before Unity starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fetchOrigin, fetchCommand, lockedRefs, withRepoLock } = await import('../src/providers/builder/gitfetch.ts');

const LOCKED = "FETCH-FAILED error: cannot lock ref 'refs/remotes/origin/beta': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222 ! 2222222..3333333 beta -> origin/beta (unable to update local ref)";
const DIR = 'C:\\Projects\\sickofitgame-unity';
const noWait = async () => {};

test('a locked ref is dropped and the fetch retried with --prune', async () => {
  const cmds: string[] = [];
  const answers = [LOCKED, 'fetched'];
  const logs: string[] = [];
  const tries = await fetchOrigin({ run: async (c) => (cmds.push(c), answers.shift()!), dir: DIR, slug: 'j/sickofit', log: (s) => logs.push(s), wait: noWait });
  assert.equal(tries, 2);
  assert.doesNotMatch(cmds[0], /--prune|update-ref/);
  assert.match(cmds[1], /update-ref -d 'refs\/remotes\/origin\/beta'/);
  assert.match(cmds[1], /fetch -q --prune origin/);
  assert.match(logs[0], /locked/);
  for (const c of cmds) assert.ok(!c.includes('"'), 'no double quotes over SSH');
});

test('a ref still locked after every try fails the fetch, saying why', async () => {
  let n = 0;
  await assert.rejects(
    fetchOrigin({ run: async () => (n++, LOCKED), dir: DIR, slug: 'j/sickofit', tries: 3, wait: noWait }),
    /after 3 tries.*cannot lock ref/,
  );
  assert.equal(n, 3);
});

test('other fetch failures are not retried', async () => {
  let n = 0;
  await assert.rejects(
    fetchOrigin({ run: async () => (n++, 'FETCH-FAILED fatal: Authentication failed for https://github.com/j/x.git'), dir: DIR, slug: 'j/x', wait: noWait }),
    /git fetch failed for j\/x: fatal: Authentication failed/,
  );
  assert.equal(n, 1);
});

test('a first fetch that works is one try', async () => {
  assert.match(fetchCommand(DIR, ''), /fetch -q origin/);
  assert.equal(await fetchOrigin({ run: async () => 'fetched\r\n', dir: DIR, slug: 'j/x', wait: noWait }), 1);
});

test('only remote-tracking refs are named for deletion', () => {
  assert.deepEqual(lockedRefs(LOCKED), ['refs/remotes/origin/beta']);
  assert.deepEqual(lockedRefs("cannot lock ref 'refs/heads/main': x; cannot lock ref 'refs/remotes/origin/a;rm': y"), []);
});

test('fetches in one checkout wait their turn; other checkouts do not', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = withRepoLock(DIR, async () => { order.push('a start'); await gate; order.push('a end'); });
  const b = withRepoLock(DIR.toUpperCase(), async () => { order.push('b'); });
  const c = withRepoLock('C:\\Projects\\other', async () => { order.push('c'); });
  await c;
  assert.deepEqual(order, ['a start', 'c']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a start', 'c', 'a end', 'b']);
  // A failure doesn't block the next caller.
  await assert.rejects(withRepoLock(DIR, async () => { throw new Error('boom'); }));
  assert.equal(await withRepoLock(DIR, async () => 'next'), 'next');
});

test('a rate-limited or failed visibility check means private, and only "public" is remembered', async () => {
  const { repoIsPrivate } = await import('../src/providers/builder/gitfetch.ts');
  const answer = (status: number, body?: unknown) => async () => new Response(body === undefined ? 'x' : JSON.stringify(body), { status });
  assert.equal(await repoIsPrivate('j/limited', { get: answer(403, { message: 'API rate limit exceeded' }) }), true);
  assert.equal(await repoIsPrivate('j/limited', { get: answer(200, { private: true }) }), true, 'the 403 was not cached as public');
  assert.equal(await repoIsPrivate('j/gone', { get: answer(404, { message: 'Not Found' }) }), true);
  assert.equal(await repoIsPrivate('j/down', { get: async () => { throw new Error('fetch failed'); } }), true);
  assert.equal(await repoIsPrivate('j/odd', { get: answer(200, 'not json') }), true);
  assert.equal(await repoIsPrivate('j/open', { get: answer(200, { private: false }) }), false);
  assert.equal(await repoIsPrivate('j/open', { get: async () => { throw new Error('not asked again'); } }), false);
  let auth = '';
  await repoIsPrivate('j/tok', { token: 'abc', get: async (_u: any, init: any) => ((auth = init.headers.Authorization), new Response('{}', { status: 200 })) });
  assert.equal(auth, 'Bearer abc');
});
