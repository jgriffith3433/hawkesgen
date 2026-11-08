import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A signed-out first visit logs no console error: Gen answers "who am I?" with nobody, and only a refused key is a 401.
test('signed out: /v1/users/me answers nobody before the 401 gate, a sent key still 401s', () => {
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const quiet = api.indexOf("route === '/v1/users/me' && method === 'GET' && !req.headers.authorization) return send(res, 200, { user: null })");
  const gate = api.indexOf("if (!client) return send(res, 401");
  assert.ok(quiet > 0 && gate > quiet, 'the signed-out answer comes before the 401');
});

test('signed out: the landing buttons centre their labels and the playtest checks the answer', () => {
  const css = readFileSync(new URL('../dashboard/gen/gen.css', import.meta.url), 'utf8');
  assert.match(css, /\.ld-cta button \{[^}]*justify-content: center/);
  const pt = readFileSync(new URL('../dashboard/gen/playtest.js', import.meta.url), 'utf8');
  assert.match(pt, /t\.metric\('meStatus'/);
});
