// Remote Desktop from the web UI: the requester's IP (Caddy's X-Forwarded-For), the .rdp text, the download
// when the server runs and the "start it first" answer when it doesn't, and owner-only routes. No AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rdp-'));
const { publicIpv4, requesterIp, rdpText } = await import('../src/providers/builder/rdp.ts');
const { builderRdpDownload, builderPassword } = await import('../src/providers/builder/builder.ts');
const { handle } = await import('../src/api.ts');
const { createClient } = await import('../src/auth.ts');

const fake = (headers: Record<string, string>, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } }) as any;

test('requesterIp: the last X-Forwarded-For entry behind Caddy, public IPv4 only', () => {
  assert.equal(requesterIp(fake({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })), '203.0.113.9');
  assert.equal(requesterIp(fake({}, '198.51.100.7')), '198.51.100.7');
  assert.equal(requesterIp(fake({ 'x-forwarded-for': '203.0.113.9' }, '198.51.100.7')), '198.51.100.7'); // not from Caddy: header ignored
  assert.equal(requesterIp(fake({})), undefined); // loopback with no header: this machine
  assert.equal(requesterIp(fake({ 'x-forwarded-for': '10.0.0.5' })), undefined);
  assert.equal(publicIpv4('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(publicIpv4('2001:db8::1'), null);
  assert.equal(publicIpv4('999.1.1.1'), null);
});

test('rdpText has the address and the Windows user', () => {
  const t = rdpText('203.0.113.9', 'Administrator');
  assert.match(t, /^full address:s:203\.0\.113\.9\r\nusername:s:Administrator\r\n/);
});

test('builderRdpDownload: file for a running server, Start offer for a stopped one, access refreshed either way', async () => {
  const calls: any[] = [];
  const access = async (ip?: string) => void calls.push(ip);
  const running = { instance: { InstanceId: 'i-abc', State: { Name: 'running' }, PublicIpAddress: '203.0.113.50' }, region: 'us-east-1' };
  const r = await builderRdpDownload('198.51.100.7', { find: async () => running, access });
  assert.equal(r.ready, true);
  if (r.ready) {
    assert.equal(r.filename, 'hawkes-builder.rdp');
    assert.match(r.content, /full address:s:203\.0\.113\.50/);
    assert.match(r.content, /username:s:Administrator/);
  }
  const stopped = { instance: { InstanceId: 'i-abc', State: { Name: 'stopped' } }, region: 'us-east-1' };
  const s = await builderRdpDownload('198.51.100.7', { find: async () => stopped, access });
  assert.deepEqual(s, { ready: false, state: 'stopped', id: 'i-abc' });
  assert.deepEqual(calls, ['198.51.100.7', '198.51.100.7']);
  await assert.rejects(builderRdpDownload(undefined, { find: async () => null, access }), /no build server/);
});

test('builderPassword reads the saved password; missing is an error', () => {
  assert.throws(() => builderPassword(), /isn't saved/);
  const dir = path.join(process.env.HAWKESGEN_DATA_DIR!, 'builder');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'remote-desktop-password.txt'), 'Hk#secret\n');
  assert.deepEqual(builderPassword(), { user: 'Administrator', password: 'Hk#secret' });
});

test('the routes are owner-only', async () => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try {
    const admin = createClient('rdp-admin', 'admin').key;
    const owner = createClient('rdp-owner', 'owner').key;
    const call = (route: string, method: string, key?: string) => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    for (const [route, method] of [['/v1/builder/rdp-file', 'GET'], ['/v1/builder/password', 'POST'], ['/v1/fleet/connect', 'GET']]) {
      assert.equal((await call(route, method, admin)).status, 403, route);
    }
    const pw = await call('/v1/builder/password', 'POST', owner);
    assert.equal(pw.status, 200);
    assert.equal((await pw.json()).password, 'Hk#secret');
  } finally {
    server.close();
  }
});
