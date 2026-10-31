// The 🐞 button on Gen's beta app (src/studioreport.ts): the page gets Studio's widget on the beta lane only, and the
// widget's requests reach Studio with this host and Studio's own sign-in cookie alone (never Gen's session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const R = await import('../src/studioreport.ts');

test('the page: the widget (and the WebGL hook) on the beta lane only', () => {
  const page = '<!doctype html><html><head><title>Hawkes Gen</title></head><body><main></main></body></html>';
  delete process.env.HAWKESGEN_LANE;
  assert.equal(R.withReportButton(page, '1.10.0'), page, 'live: unchanged');
  process.env.HAWKESGEN_LANE = 'beta';
  const out = R.withReportButton(page, '1.10.0');
  assert.match(out, /<head><script data-hawkes-report>/);
  assert.match(out, /<script src="\/dev\/__studio\/report\.js" data-hawkes='[^']*"product":"hawkesgen"[^']*Gen beta 1\.10\.0[^']*' defer><\/script><\/body>/);
  assert.equal(R.withReportButton(out, '1.10.0'), out, 'once');
});

test("Studio gets the widget's requests with this host and its own cookie, never Gen's", async () => {
  process.env.HAWKESGEN_LANE = 'beta';
  assert.equal(R.studioCookies('hg_session=gen-secret; hawkes_session=studio; _ga=x; hawkes_pass=p'), 'hawkes_session=studio; hawkes_pass=p');
  const seen: any[] = [];
  const studio = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, method: req.method, host: req.headers['x-forwarded-host'], cookie: req.headers.cookie, origin: req.headers.origin, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => studio.listen(0, '127.0.0.1', () => r()));
  process.env.HAWKESGEN_REPORT_STUDIO = `http://127.0.0.1:${(studio.address() as any).port}`;
  const gen = http.createServer((req, res) => { void R.toStudio(req, res, new URL(req.url!, 'http://x').pathname).then((done) => { if (!done) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((r) => gen.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(gen.address() as any).port}`;
  try {
    const r = await fetch(`${base}/dev/__studio/report`, {
      method: 'POST', body: JSON.stringify({ text: 'broken', state: '{"scene":{"id":"sc_1"}}' }),
      headers: { 'content-type': 'application/json', origin: 'https://beta.hawkesgen.ai', 'x-forwarded-host': 'beta.hawkesgen.ai', cookie: 'hg_session=gen-secret; hawkes_session=studio' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(seen[0], { url: '/dev/__studio/report', method: 'POST', host: 'beta.hawkesgen.ai', cookie: 'hawkes_session=studio', origin: 'https://beta.hawkesgen.ai', body: '{"text":"broken","state":"{\\"scene\\":{\\"id\\":\\"sc_1\\"}}"}' });
    assert.equal((await fetch(`${base}/dev/__studio/report.js`, { headers: { 'x-forwarded-host': 'beta.hawkesgen.ai' } })).status, 200);
    delete process.env.HAWKESGEN_LANE;
    assert.equal((await fetch(`${base}/dev/__studio/report.js`)).status, 404, 'live Gen: not there at all');
  } finally {
    gen.close();
    studio.close();
    delete process.env.HAWKESGEN_REPORT_STUDIO;
  }
});
