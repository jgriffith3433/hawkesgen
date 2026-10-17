// The build server's poll answers (server/builder/poll.ps1): a Unity log with raw control characters must not stop
// Gen from following a build (it used to retry the same unreadable chunk until the job was cancelled).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parsePoll, cleanPollJson, pollLengthOf } = await import('../src/providers/builder/poll.ts');

// What an old poll.ps1 sent for the Build Report: raw tab, ESC, NUL, form feed and CR LF inside the "text" string.
const LOG = 'Build Report\r\nUncompressed usage by category:\tTextures 12.3 mb\u001b[0m\u0000\fScripts 1 mb\r\nExiting';
const rawOld = `{"started":true,"exit":0,"error":null,"length":25700,"text":"${LOG}"}\r\n`;

test('an old poll answer with raw control characters parses', () => {
  assert.throws(() => JSON.parse(rawOld.trim()));
  const p = parsePoll(rawOld);
  assert.equal(p.exit, 0);
  assert.equal(p.length, 25700);
  assert.equal(p.text, 'Build Report\r\nUncompressed usage by category:\tTextures 12.3 mb[0mScripts 1 mb\r\nExiting');
});

test('cleaning keeps escapes and whitespace outside strings', () => {
  const raw = '{\n\t"a": "x\\"\u0001y\\\\",\r\n "b": 1}';
  assert.deepEqual(JSON.parse(cleanPollJson(raw)), { a: 'x"y\\', b: 1 });
});

test('a base64 chunk decodes, and a UTF-8 character split across two chunks comes out whole', () => {
  const bytes = Buffer.from('ok \u001b é done\n', 'utf8');
  const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of é
  const decoder = new TextDecoder();
  const a = parsePoll(JSON.stringify({ started: true, exit: null, error: null, length: cut, text: '', b64: bytes.subarray(0, cut).toString('base64') }), decoder);
  const b = parsePoll(JSON.stringify({ started: true, exit: 0, error: null, length: bytes.length, text: '', b64: bytes.subarray(cut).toString('base64') }), decoder);
  assert.equal(a.text + b.text, 'ok \u001b é done\n');
  assert.equal(b.exit, 0);
});

test('an unreadable answer still says where its chunk ends, so the poll can skip it', () => {
  const broken = '{"started":true,"exit":null,"error":null,"length":524288,"text":"half a str';
  assert.throws(() => parsePoll(broken));
  assert.equal(pollLengthOf(broken), 524288);
  assert.equal(pollLengthOf('garbage'), null);
});
