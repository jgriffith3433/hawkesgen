import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import * as eleven from '../src/providers/elevenlabs.ts';

process.env.ELEVENLABS_API_KEY = 'test-key';

let calls = 0;
let reply: { status: number; body: string } = { status: 200, body: 'audio' };
const realRequest = https.request;
(https as any).request = (_url: any, _opts: any, cb: any) => {
  const req: any = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    calls++;
    const res: any = new EventEmitter();
    res.statusCode = reply.status;
    res.headers = {};
    cb(res);
    res.emit('data', Buffer.from(reply.body));
    res.emit('end');
  };
  return req;
};
test.after(() => { (https as any).request = realRequest; });

const PAYMENT = { status: 401, body: JSON.stringify({ detail: { status: 'payment_issue', message: 'unpaid invoice' } }) };
const voice = 'abcdefgh1234';
let now = 1_000_000;

test('payment_issue sets the block, and calls fail fast without reaching ElevenLabs', async () => {
  eleven._testReset(() => now);
  calls = 0;
  reply = PAYMENT;
  await assert.rejects(eleven.speak({ text: 'hi', voice }), /unpaid invoice/);
  assert.equal(calls, 1);
  assert.equal(eleven.billingState().blocked, true);
  reply = { status: 200, body: 'audio' };
  await assert.rejects(eleven.soundEffect({ text: 'boom' }), /Do not retry/);
  await assert.rejects(eleven.designVoice({ description: 'x' }), /Do not retry/);
  assert.equal(calls, 1);
});

test('402 also blocks', async () => {
  eleven._testReset(() => now);
  reply = { status: 402, body: '{}' };
  await assert.rejects(eleven.speak({ text: 'hi', voice }));
  assert.equal(eleven.billingState().blocked, true);
});

test('after 30 minutes one probe goes through: success clears the block', async () => {
  eleven._testReset(() => now);
  reply = PAYMENT;
  await assert.rejects(eleven.speak({ text: 'hi', voice }));
  now += 29 * 60_000;
  calls = 0;
  await assert.rejects(eleven.speak({ text: 'hi', voice }), /Do not retry/);
  assert.equal(calls, 0);
  now += 2 * 60_000;
  assert.equal((eleven.billingState() as any).probeDue, true);
  reply = { status: 200, body: 'audio' };
  await eleven.speak({ text: 'hi', voice });
  assert.equal(calls, 1);
  assert.equal(eleven.billingState().blocked, false);
});

test('a failed probe renews the block for another 30 minutes', async () => {
  eleven._testReset(() => now);
  reply = PAYMENT;
  await assert.rejects(eleven.speak({ text: 'hi', voice }));
  now += 31 * 60_000;
  await assert.rejects(eleven.speak({ text: 'hi', voice }), /unpaid invoice/);
  const st: any = eleven.billingState();
  assert.equal(st.blocked, true);
  assert.equal(st.until, now + 30 * 60_000);
  calls = 0;
  await assert.rejects(eleven.speak({ text: 'hi', voice }), /Do not retry/);
  assert.equal(calls, 0);
});
