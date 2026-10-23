// Integration tests for the customer-facing Hawkes Gen website (/home, /public/*, and / when HAWKESGEN_PUBLIC_SAAS=1),
// the operator console at /admin, the Creator Studio web app (/app), and all referenced SaaS endpoints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

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

test('HAWKESGEN_PUBLIC_SAAS=1 serves landing page at / and keeps operator console at /admin', async () => {
  // Default (HAWKESGEN_PUBLIC_SAAS unset): / is the operator console
  delete process.env.HAWKESGEN_PUBLIC_SAAS;
  const rootDefault = await fetchRoute('/');
  assert.equal(rootDefault.status, 200);
  assert.match(rootDefault.text, /Generative R&amp;D for every Hawkes product/);

  // When HAWKESGEN_PUBLIC_SAAS=1: / is the customer-facing landing page, and /admin is the operator console
  process.env.HAWKESGEN_PUBLIC_SAAS = '1';
  try {
    const rootPublic = await fetchRoute('/');
    assert.equal(rootPublic.status, 200);
    assert.match(rootPublic.text, /Build Web Games with AI/);
    assert.match(rootPublic.text, /Create Games/);

    const admin = await fetchRoute('/admin');
    assert.equal(admin.status, 200);
    assert.match(admin.text, /Generative R&amp;D for every Hawkes product/);
  } finally {
    delete process.env.HAWKESGEN_PUBLIC_SAAS;
  }
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

  // 2. Unauthenticated /v1/users/me when HAWKESGEN_PUBLIC_SAAS=1 returns 401
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
