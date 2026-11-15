// Integration tests for the customer-facing Hawkes Gen website (/home, /public/*, and / when HAWKESGEN_PUBLIC_SAAS=1),
// the operator console at /admin, the Creator Studio web app (/app), and all referenced SaaS endpoints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// These tests make throwaway accounts with a password; the app itself is Google-only (src/users.ts passwordsAllowed).
process.env.HAWKESGEN_PASSWORD_LOGIN = '1';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-saas-ui-'));
process.env.HAWKESGEN_STARTER_CREDITS = '50';

const { handle } = await import('../src/api.ts');
const { queue } = await import('../src/jobs.ts');
(queue as any).pump = () => {};

const server = http.createServer((req, res) =>
  handle(req, res).catch((e) => {
    res.writeHead(500);
    res.end(String(e));
  }),
);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
const baseUrl = `http://127.0.0.1:${port}`;

test.after(() => server.close());

async function fetchRoute(route: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${route}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test('/home, /app, and /public/* serve valid HTML, CSS, and JS on every server', async () => {
  // 1. /home serves the public game builder landing page
  const home = await fetchRoute('/home');
  assert.equal(home.status, 200);
  assert.match(String(home.headers.get('content-type')), /text\/html/);
  assert.match(home.text, /Build Web Games with AI/);
  assert.match(home.text, /Create Games/);
  assert.match(home.text, /collaborat/i);
  assert.match(home.text, /Simple Pricing/);

  // 2. /app serves the Hawkes Play game builder
  const app = await fetchRoute('/app');
  assert.equal(app.status, 200);
  assert.match(String(app.headers.get('content-type')), /text\/html/);
  assert.match(app.text, /Hawkes Play/);
  assert.match(app.text, /Game Builder/);
  assert.match(app.text, /My Games/);

  // 3. /public/public.css and /public/app.js serve valid CSS and JS
  const css = await fetchRoute('/public/public.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers.get('content-type')), /text\/css/);
  assert.match(css.text, /--bg-obsidian/);

  const js = await fetchRoute('/public/app.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers.get('content-type')), /text\/javascript/);
  for (const toolId of [
    'image.generate',
    'image.edit',
    'image.cutout',
    'image.angles',
    'image.panorama',
    'texture.maps',
    'video.t2v',
    'video.i2v',
    'video.animate',
    'video.talk',
    'video.control',
    'video.upscale',
    'mesh.textured',
    'mesh.from-image',
    'image.viewsheet',
    'mesh.views3d',
    'mesh.rig',
    'blender.character',
    'motion.from-text',
    'audio.music',
    'audio.voice',
    'audio.voice-design',
    'audio.sfx',
    'asset.make',
  ]) {
    assert.ok(js.text.includes(toolId), `Expected /public/app.js to include tool ${toolId}`);
  }
});

test('/ is the Gen app; the operator console is /admin (its files beside it); the old landing page is /home', async () => {
  for (const saas of [undefined, '1']) {
    if (saas) process.env.HAWKESGEN_PUBLIC_SAAS = saas; else delete process.env.HAWKESGEN_PUBLIC_SAAS;
    try {
      const root = await fetchRoute('/?app');
      assert.equal(root.status, 200);
      assert.match(root.text, /Make anything\./);
      // The bare address is the front page for everyone: the visualization, nothing to click, bots sent to the app.
      const front = await fetchRoute('/');
      assert.equal(front.status, 200);
      assert.match(front.text, /location\.replace\('\/\?app'/);
      assert.doesNotMatch(front.text, /<a |<button|setInterval|setTimeout|fetch\(/);
      for (const r of ['/admin', '/admin/']) {
        const admin = await fetchRoute(r);
        assert.equal(admin.status, 200);
        assert.match(admin.text, /Generative R&amp;D for every Hawkes product/);
      }
      assert.equal((await fetchRoute('/admin/style.css')).status, 200);
      assert.match((await fetchRoute('/home')).text, /Build Web Games with AI/);
      for (const r of ['/legal', '/terms', '/privacy', '/refunds']) assert.match((await fetchRoute(r)).text, /Terms, privacy and refunds/);
    } finally {
      delete process.env.HAWKESGEN_PUBLIC_SAAS;
    }
  }
});

test('the Gen app: every element its modules look up by id is on the page, and the editor tools are wired', async () => {
  const page = (await fetchRoute('/?app')).text;
  const mods = ['gen', 'lib', 'project', 'player', 'timeline', 'media', 'tools', 'ai', 'account', 'studio', 'director', 'scenes', 'editor', 'dragdrop', 'character', 'scenedoc', 'landing', 'tour', 'guide', 'palette', 'starters', 'world', 'place', 'prop', 'story', 'worldbits'];
  let js = '';
  for (const m of mods) {
    const r = await fetchRoute(`/gen/${m}.js`);
    assert.equal(r.status, 200, `/gen/${m}.js`);
    js += r.text;
  }
  const ids = new Set([...js.matchAll(/\$\('#([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  for (const id of ids) if (!js.includes(`id: '${id}'`) && !js.includes(`id="${id}"`)) assert.match(page, new RegExp(`id="${id}"`), `#${id} is used by the app but missing from the page`);
  for (const tool of ['image.generate', 'image.edit', 'image.repaint', 'image.expand', 'image.cutout', 'video.i2v', 'video.change', 'video.replace', 'video.frame', 'video.compose', 'video.still', 'audio.music', 'audio.voice', 'audio.sfx']) assert.ok(js.includes(`'${tool}'`), tool);
});

test('all endpoints referenced by /home and /app respond properly', async () => {
  // 1. Public endpoints: /v1/portfolio, /v1/billing/packs, /v1/motions
  const portfolioRes = await fetchRoute('/v1/portfolio');
  assert.equal(portfolioRes.status, 200);
  const portfolio = JSON.parse(portfolioRes.text);
  assert.equal(portfolio.title, 'Built With Hawkes Gen');
  assert.ok(Array.isArray(portfolio.items) && portfolio.items.length >= 6);

  const packsRes = await fetchRoute('/v1/billing/packs');
  assert.equal(packsRes.status, 200);
  const packs = JSON.parse(packsRes.text);
  assert.equal(packs.packs.length, 3);

  const motionsRes = await fetchRoute('/v1/motions?q=walk&limit=10');
  assert.equal(motionsRes.status, 200);
  const motions = JSON.parse(motionsRes.text);
  assert.ok(Array.isArray(motions.items) && motions.items.length > 0);
  assert.ok(motions.total > 0);

  // 2. Unauthenticated /v1/users/me when HAWKESGEN_PUBLIC_SAAS=1 still answers 401 (API/MCP clients rely on it).
  // The web app skips this probe when hg.in is unset so a signed-out visit logs no console error.
  process.env.HAWKESGEN_PUBLIC_SAAS = '1';
  try {
    const meAnon = await fetchRoute('/v1/users/me');
    assert.equal(meAnon.status, 401);
  } finally {
    delete process.env.HAWKESGEN_PUBLIC_SAAS;
  }

  // 3. Signup & authenticated Creator Studio endpoints
  const signupRes = await fetchRoute('/v1/users/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'creator-ui@example.com', password: 'password123', name: 'Creator UI' }),
  });
  assert.equal(signupRes.status, 200);
  const signupData = JSON.parse(signupRes.text);
  const authHeaders = { Authorization: `Bearer ${signupData.apiKey}` };

  // GET /v1/users/me
  const meRes = await fetchRoute('/v1/users/me', { headers: authHeaders });
  assert.equal(meRes.status, 200);
  assert.equal(JSON.parse(meRes.text).user.credits, 50);

  // GET /v1/presets returns presets for the Creator Studio selector
  const presetsRes = await fetchRoute('/v1/presets', { headers: authHeaders });
  assert.equal(presetsRes.status, 200);
  const presetsData = JSON.parse(presetsRes.text);
  assert.ok(Array.isArray(presetsData.projects) && presetsData.projects.length > 0);

  // POST /v1/billing/quote
  const quoteRes = await fetchRoute('/v1/billing/quote', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'image.generate', params: { prompt: 'Obsidian sword', seamless: false } }),
  });
  assert.equal(quoteRes.status, 200);
  const quoteData = JSON.parse(quoteRes.text);
  assert.ok(quoteData.credits >= 5);
  assert.equal(quoteData.canAfford, true);

  // POST /v1/assets (drag-and-drop upload from Creator Studio)
  const uploadRes = await fetchRoute('/v1/assets', {
    method: 'POST',
    headers: {
      ...authHeaders,
      'X-Filename': 'concept.png',
      'Content-Type': 'image/png',
    },
    body: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  });
  assert.equal(uploadRes.status, 200);
  const uploaded = JSON.parse(uploadRes.text);
  assert.match(uploaded.id, /^a_[0-9a-f]+$/);
  assert.match(uploaded.blob, /^blob:[0-9a-f]+$/);

  // GET /v1/assets lists the uploaded asset
  const assetsRes = await fetchRoute('/v1/assets', { headers: authHeaders });
  assert.equal(assetsRes.status, 200);
  const assetsList = JSON.parse(assetsRes.text);
  assert.ok(assetsList.items.some((a: any) => a.id === uploaded.id));

  // GET /v1/billing/ledger
  const ledgerRes = await fetchRoute('/v1/billing/ledger', { headers: authHeaders });
  assert.equal(ledgerRes.status, 200);
  const ledgerData = JSON.parse(ledgerRes.text);
  assert.equal(ledgerData.credits, 50);
  assert.ok(Array.isArray(ledgerData.entries) && ledgerData.entries.length >= 1);
});
