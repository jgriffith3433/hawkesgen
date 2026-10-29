// Platform tokens from hawkesgen.ai (src/platform.ts): a JWT the portal signs, checked against its public keys, turned
// into a customer of one org. Tokens here are signed with a key made for the test, exactly as the portal signs them
// (hawkesgenwebsite cloud/functions/src/platform.ts signJwt). A scratch data folder and a random port; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-platform-'));
process.env.HAWKESGEN_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const { handle } = await import('../src/api.ts');
const { setPlatformKeys, issuer, orgProjects } = await import('../src/platform.ts');
const { saveSettings } = await import('../src/config.ts');
const { putAsset } = await import('../src/library.ts');

const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const x = (publicKey.export({ format: 'jwk' }) as any).x as string;
const kid = crypto.createHash('sha256').update(x).digest('base64url').slice(0, 16);
setPlatformKeys([{ kty: 'OKP', crv: 'Ed25519', x, kid }]);

const A = 'org_aaaaaaaa', B = 'org_bbbbbbbb';
const sign = (claims: Record<string, unknown>, o: { key?: crypto.KeyObject; kid?: string } = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const full = { iss: issuer(), aud: ['hawkesgen', 'hawkesstudio'], user: 'usr_aaaaaaaa', role: 'owner', plan: 'indie', entitlements: {}, scopes: ['generate', 'playtest'], iat: now, exp: now + 600, ...claims };
  const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: o.kid ?? kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), o.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
};
const call = (token: string, route: string, init: { body?: any; project?: string; method?: string } = {}) => fetch(base + route, {
  method: init.method ?? (init.body ? 'POST' : 'GET'),
  headers: { authorization: `Bearer ${token}`, ...(init.project ? { 'x-hawkesgen-project': init.project } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
  body: init.body ? JSON.stringify(init.body) : undefined,
});

test('a good token is a customer of its org, with the org\'s projects', async () => {
  const r = await call(sign({ org: A, project: 'usr_aaaaaaaa' }), '/v1/me');
  assert.equal(r.status, 200);
  const me = await r.json() as any;
  assert.equal(me.role, 'user');
  assert.equal(me.org, A);
  // A personal org keeps its owner's project from before orgs.
  assert.deepEqual(me.projects, [A, `${A}.*`, 'usr_aaaaaaaa']);
  // A team org doesn't take its member's own project.
  assert.deepEqual(orgProjects({ org: B, user: 'usr_aaaaaaaa', project: 'usr_aaaaaaaa' }), [B, `${B}.*`]);
});

test('bad tokens are refused, never read as keys', async () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  for (const [why, t] of [
    ['expired', sign({ org: A, exp: Math.floor(Date.now() / 1000) - 120 })],
    ['another audience', sign({ org: A, aud: ['hawkesnet'] })],
    ['another issuer', sign({ org: A, iss: 'https://evil.example' })],
    ['signed by another key', sign({ org: A }, { key: other })],
    ['an unknown key id', sign({ org: A }, { kid: 'nope' })],
    ['not an org', sign({ org: 'usr_aaaaaaaa' })],
    ['tampered', sign({ org: A }).replace(/\.([\w-]+)\./, (_m, b) => `.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), org: B })).toString('base64url')}.`)],
  ] as const) {
    assert.equal((await call(t, '/v1/me')).status, 401, why);
  }
});

test('an org reads only its own projects', async () => {
  const mine = putAsset({ data: Buffer.from('a'), ext: '.txt', client: 'x', project: `${A}.game`, tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} }, title: 'mine' });
  const theirs = putAsset({ data: Buffer.from('b'), ext: '.txt', client: 'x', project: `${B}.game`, tool: 'file.import', recipe: { tool: 'file.import', version: 1, params: {}, inputs: {} }, title: 'theirs' });
  const t = sign({ org: A });
  assert.equal((await call(t, `/v1/assets/${mine.id}`)).status, 200);
  assert.notEqual((await call(t, `/v1/assets/${theirs.id}`)).status, 200);
  // Narrowing to one of its own projects works; to another org's, the call is refused.
  assert.equal((await call(t, '/v1/me', { project: `${A}.game` })).status, 200);
  assert.equal((await call(t, '/v1/me', { project: `${B}.game` })).status, 401);
  // A customer, so the studio's machinery is closed.
  assert.equal((await call(t, '/v1/settings')).status, 403);
});

test('jobs: the token\'s scopes, viewers, and billing (free orgs only for now)', async () => {
  const job = { tool: 'llm.text', project: A, params: { prompt: 'hi' } };
  const notFree = await call(sign({ org: A }), '/v1/jobs', { body: job });
  assert.equal(notFree.status, 402);
  saveSettings({ platform: { issuer: '', freeOrgs: [A] } } as any);
  const ok = await call(sign({ org: A }), '/v1/jobs', { body: job });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await call(sign({ org: A, scopes: ['playtest'] }), '/v1/jobs', { body: job })).status, 403);
  assert.equal((await call(sign({ org: A, role: 'viewer' }), '/v1/jobs', { body: job })).status, 403);
  // Another org's project is refused whatever the token says it may do.
  assert.notEqual((await call(sign({ org: A }), '/v1/jobs', { body: { ...job, project: B } })).status, 200);
});

test('an org brings its own Anthropic key: owners and admins set it, nobody reads it back', async () => {
  const { orgSecret, orgOfProject } = await import('../src/orgsecrets.ts');
  const key = `sk-ant-api03-${'x'.repeat(40)}WXYZ`;
  assert.equal((await call(sign({ org: A, role: 'member' }), '/v1/org/keys/anthropic', { method: 'PUT', body: { key } })).status, 403);
  assert.equal((await call(sign({ org: A }), '/v1/org/keys/anthropic', { method: 'PUT', body: { key: 'not-a-key' } })).status, 400);
  const set = await call(sign({ org: A }), '/v1/org/keys/anthropic', { method: 'PUT', body: { key } });
  assert.equal(set.status, 200);
  const info = await set.json() as any;
  assert.deepEqual([info.set, info.last4], [true, 'WXYZ']);
  assert.ok(!JSON.stringify(info).includes(key.slice(0, 20)));
  // Members may see whether one is set; another org sees its own (none).
  assert.equal(((await (await call(sign({ org: A, role: 'member' }), '/v1/org/keys/anthropic')).json()) as any).set, true);
  assert.equal(((await (await call(sign({ org: B }), '/v1/org/keys/anthropic')).json()) as any).set, false);
  // Stored encrypted; only Gen's jobs for that org read it.
  assert.equal(orgSecret(A, 'anthropic'), key);
  assert.equal(orgSecret(B, 'anthropic'), null);
  assert.equal(orgOfProject(`${A}.game`), A);
  assert.equal(orgOfProject('usr_aaaaaaaa'), A, 'an account own project belongs to its personal org');
  assert.equal(orgOfProject('doseofdestruction'), null);
  assert.equal(((await (await call(sign({ org: A }), '/v1/org/keys/anthropic', { method: 'DELETE' })).json()) as any).set, false);
});

test('a customer\'s Claude: its own subscription works as a key does; with neither, jobs say what to do', async () => {
  const { orgSecret } = await import('../src/orgsecrets.ts');
  assert.equal((await call(sign({ org: A }), '/v1/org/keys/claude-subscription', { method: 'PUT', body: { key: `sk-ant-api03-${'x'.repeat(40)}` } })).status, 400, 'an API key is not a sign-in token');
  const sub = `sk-ant-oat01-${'y'.repeat(40)}ABCD`;
  const r = await call(sign({ org: A }), '/v1/org/keys/claude-subscription', { method: 'PUT', body: { key: sub } });
  assert.equal(r.status, 200);
  assert.equal(orgSecret(A, 'claude-subscription'), sub);
  await call(sign({ org: A }), '/v1/org/keys/claude-subscription', { method: 'DELETE' });
  // No key and no subscription: an org's Claude job fails with the way to fix it (never our key or J's plan).
  const sub_ = await (await call(sign({ org: A }), '/v1/jobs', { body: { tool: 'llm.text', project: `${A}.game`, params: { prompt: 'hi' } } })).json() as any;
  const id = sub_.jobs[0].id;
  let job: any;
  for (let i = 0; i < 50; i++) {
    job = await (await call(sign({ org: A }), `/v1/jobs/${id}`)).json();
    if (['failed', 'done'].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(job.status, 'failed');
  assert.match(String(job.error), /your own access|Anthropic API key|Claude subscription/);
});
