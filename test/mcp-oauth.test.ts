// Signing in to Gen's MCP from an editor (src/mcp-oauth.ts, src/genoauth.ts) and the signed links its tools hand back
// (src/links.ts), end to end against the real routes: the 401 that tells the editor where to sign in, discovery,
// registration, the sign-in and consent pages, the code with PKCE, the token acting as the account, refresh rotation,
// disconnecting, and one-time uploads. Offline: a scratch data folder; no Google, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mcp-oauth-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
const { handle } = await import('../src/api.ts');
const { signupUser } = await import('../src/users.ts');
const links = await import('../src/links.ts');
const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

const me = signupUser({ email: 'editor@example.com', password: 'secret-123', name: 'Ed' });
const cookie = `hg_session=${me.sessionToken}`;
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const REDIRECT = 'http://127.0.0.1:53682/callback';
const mcp = (auth?: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
let clientId = '';
let access = '';
let refresh = '';

test('with no sign-in, /mcp answers 401 and names where to sign in', async () => {
  const r = await mcp();
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
  assert.equal(meta.resource, `${base}/mcp`);
  assert.deepEqual(meta.authorization_servers, [base]);
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
  assert.equal(as.token_endpoint, `${base}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('an editor registers itself; only https, loopback http or an app scheme may receive the code', async () => {
  const bad = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(bad.status, 400);
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }) });
  assert.equal(r.status, 201);
  clientId = ((await r.json()) as any).client_id;
  assert.match(clientId, /^mcp_/);
});

const authorizeQuery = () => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${base}/mcp` });

test('authorize: signed out it is the sign-in page, signed in the consent page', async () => {
  const out = await fetch(`${base}/oauth/authorize?${authorizeQuery()}`);
  assert.equal(out.status, 200);
  assert.match(await out.text(), /Sign in to Hawkes Gen/);
  const inn = await fetch(`${base}/oauth/authorize?${authorizeQuery()}`, { headers: { cookie } });
  const page = await inn.text();
  assert.match(page, /Claude Code wants to use Hawkes Gen/);
  assert.match(page, /editor@example\.com/);
  const noPkce = authorizeQuery();
  noPkce.delete('code_challenge');
  assert.equal((await fetch(`${base}/oauth/authorize?${noPkce}`, { headers: { cookie } })).status, 400);
});

test('Allow gives a code; the code with the right verifier gives an hgm_ token that is the account', async () => {
  const body = new URLSearchParams({ ...Object.fromEntries(authorizeQuery()), action: 'allow' });
  const cross = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(cross.status, 403, 'a post from another site');
  const r = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location')!);
  assert.equal(to.origin + to.pathname, REDIRECT);
  assert.equal(to.searchParams.get('state'), 'xyz');
  const code = to.searchParams.get('code')!;
  const wrong = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'nope'.repeat(11), client_id: clientId, redirect_uri: REDIRECT }) });
  assert.equal(wrong.status, 400, 'a wrong verifier (and the code is spent)');
  // A fresh code for the real exchange.
  const again = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body });
  const code2 = new URL(again.headers.get('location')!).searchParams.get('code')!;
  const t = (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }) })).json()) as any;
  assert.match(t.access_token, /^hgm_/);
  assert.match(t.refresh_token, /^hgmr_/);
  access = t.access_token;
  refresh = t.refresh_token;
  const used = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier }) });
  assert.equal(used.status, 400, 'a code works once');
  const who = (await (await fetch(`${base}/v1/users/me`, { headers: { authorization: `Bearer ${access}` } })).json()) as any;
  assert.equal(who.user.email, 'editor@example.com');
});

test('signed in, /mcp lists the friendly tools, which default to the account\'s own project', async () => {
  assert.equal((await mcp(access)).status, 200);
  const r = await mcp(access, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const text = await r.text();
  const json = JSON.parse(text.includes('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text);
  const names = json.result.tools.map((t: any) => t.name);
  for (const n of ['generate_image', 'edit_image', 'make_sprite_sheet', 'make_3d_model', 'make_texture', 'voice_line', 'upload_file', 'account', 'hawkesgen_run']) assert.ok(names.includes(n), n);
  const run = json.result.tools.find((t: any) => t.name === 'hawkesgen_run');
  assert.deepEqual(run.inputSchema.required, [], 'no project needed: the account has one');
});

test('refresh tokens rotate; disconnecting stops the token at once', async () => {
  const r1 = (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh }) })).json()) as any;
  assert.match(r1.access_token, /^hgm_/);
  const reuse = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh }) });
  assert.equal(reuse.status, 400, 'the old refresh token worked once');
  const list = (await (await fetch(`${base}/v1/users/me/connections`, { headers: { cookie } })).json()) as any;
  assert.equal(list.connections.length, 1);
  assert.equal(list.connections[0].name, 'Claude Code');
  const del = await fetch(`${base}/v1/users/me/connections/${list.connections[0].id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/v1/users/me`, { headers: { authorization: `Bearer ${r1.access_token}` } })).status, 401);
  const after = await mcp(r1.access_token);
  assert.equal(after.status, 401);
  assert.match(after.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
});

test('upload links work once and give a blob of the caller; download links are signed', async () => {
  const url = links.uploadLink(base, { id: 'c1', projects: [me.user.project] }, 'hero.png');
  const put = await fetch(url, { method: 'PUT', body: Buffer.from('fake png bytes') });
  assert.equal(put.status, 200);
  assert.match(((await put.json()) as any).blob, /^blob:[0-9a-f]{64}$/);
  assert.equal((await fetch(url, { method: 'PUT', body: Buffer.from('again') })).status, 409);
  const dl = links.downloadLink(base, 'a_0123abcd', 'thing.png');
  const route = new URL(dl).pathname;
  assert.equal(links.downloadTarget(route), 'a_0123abcd');
  assert.equal(links.downloadTarget(route.replace(/\.([\w-]+)\//, '.AAAA/')), null, 'a tampered link');
  assert.equal((await fetch(`${base}/dl/not.valid/x.png`)).status, 404);
});
