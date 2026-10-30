// The visitor's address for analytics (src/analytics/collect.ts clientIp): behind Caddy, on Cloud Run straight, and on
// Cloud Run through the hawkesgen.ai Worker on Cloudflare. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../src/analytics/collect.ts';

const req = (sock: string, headers: Record<string, string>) => ({ socket: { remoteAddress: sock }, headers }) as any;

test('behind Caddy: the last X-Forwarded-For entry from a loopback socket', () => {
  delete process.env.K_SERVICE;
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })), '9.9.9.9');
  assert.equal(clientIp(req('5.6.7.8', { 'x-forwarded-for': '1.2.3.4' })), '5.6.7.8', 'a header from elsewhere is not believed');
});

test('on Cloud Run: the address that reached Google, or the visitor the Worker names when Cloudflare reached it', () => {
  process.env.K_SERVICE = 'gen';
  try {
    assert.equal(clientIp(req('169.254.1.1', { 'x-forwarded-for': '81.2.69.160' })), '81.2.69.160', 'straight to Cloud Run');
    assert.equal(clientIp(req('169.254.1.1', { 'x-forwarded-for': '162.158.10.20', 'x-hawkes-client-ip': '81.2.69.160' })), '81.2.69.160', 'through the Worker');
    assert.equal(clientIp(req('169.254.1.1', { 'x-forwarded-for': '2606:4700::1', 'x-hawkes-client-ip': '2001:db8::7' })), '2001:db8::7', 'IPv6 edge');
    assert.equal(clientIp(req('169.254.1.1', { 'x-forwarded-for': '81.2.69.160', 'x-hawkes-client-ip': '6.6.6.6' })), '81.2.69.160', 'the header from outside Cloudflare is ignored');
    assert.equal(clientIp(req('169.254.1.1', { 'x-forwarded-for': '162.158.10.20', 'x-hawkes-client-ip': 'not an ip' })), '162.158.10.20');
  } finally { delete process.env.K_SERVICE; }
});
