// The admin dashboard is the owner's and admins' alone (J, 2026-10-30: "if you're not admin you can't see any of it
// period"): src/adminpage.ts in front of every file of it, at /admin and at the root, with a bare sign-in for the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-admin-page-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

const { handle } = await import('../src/api.ts');
const { signupUser } = await import('../src/users.ts');
const { createClient } = await import('../src/auth.ts');
const P = await import('../src/adminpage.ts');

test("the admin dashboard's files are an admin's alone; anyone else gets a bare sign-in and 404s", async () => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const person = signupUser({ email: 'not-an-admin@example.com', password: 'secret-123', name: 'P' });
    const admin = createClient('Admin key', 'admin').key;
    const user = createClient('A game', 'user', ['somegame']).key;
    const get = (route: string, h: Record<string, string> = {}) => fetch(base + route, { headers: h });
    const asPerson = { cookie: `hg_session=${person.sessionToken}` };
    const adminMarkup = /<script src="app\.js"/;

    // A signed-in account that isn't an admin: the sign-in page, never the dashboard or its code.
    for (const route of ['/admin', '/admin/', '/admin/index.html', '/index.html']) {
      const r = await get(route, asPerson);
      assert.equal(r.status, 401, route);
      const body = await r.text();
      assert.match(body, /For Hawkes Gen's admins only/, route);
      assert.doesNotMatch(body, adminMarkup, route);
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
    }
    for (const route of ['/admin/app.js', '/app.js', '/admin/style.css', '/style.css']) {
      assert.equal((await get(route, asPerson)).status, 404, route);
    }
    // A key that isn't an admin's is no better (as a Bearer and as the dashboard's key cookie).
    assert.equal((await get('/admin/app.js', { authorization: `Bearer ${user}` })).status, 404);
    assert.equal((await get('/admin', { cookie: `hg_key=${user}` })).status, 401);

    // An admin key: the dashboard and its files, never kept by a cache.
    for (const h of [{ authorization: `Bearer ${admin}` }, { cookie: `hg_key=${admin}` }] as Record<string, string>[]) {
      const page = await get('/admin', h);
      assert.equal(page.status, 200);
      assert.match(await page.text(), adminMarkup);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      assert.equal((await get('/admin/app.js', h)).status, 200);
    }
    // The public app and the favicon stay public.
    assert.equal((await get('/favicon.svg')).status, 200);
    assert.equal((await get('/admin/favicon.svg')).status, 200);
    assert.equal((await get('/', asPerson)).status, 200);
  } finally {
    server.close();
  }
});

test('nobody from outside is the owner by default, here or on Cloud Run', () => {
  const req = (h: Record<string, string> = {}, ip = '203.0.113.9') => ({ headers: h, socket: { remoteAddress: ip } }) as any;
  assert.equal(P.isAdminViewer(req()), false, 'a stranger');
  assert.equal(P.isAdminRoute('/admin/whatever.js'), true);
  assert.equal(P.isAdminRoute('/public/app.js'), false);
  assert.equal(P.isAdminRoute('/gen/index.html'), false);
});
