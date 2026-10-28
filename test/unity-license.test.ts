// The Unity cloud build's license step (server/unity-cloudrun/entrypoint.sh, HAWKES_LICENSE_CHECK=1) against a fake
// Unity Licensing Client and editor: Personal activation by email and password, the older flag spelling, and the plain
// reasons for 2FA, a bad password and a seat limit. The secrets never reach the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ENTRY = path.resolve(import.meta.dirname, '..', 'server', 'unity-cloudrun', 'entrypoint.sh');
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

const CLIENT = `#!/usr/bin/env bash
echo "$1" >> "$FAKE_DIR/calls"
case "$FAKE_MODE:$1" in
  *:--return-ulf) echo returned; exit 0;;
  ok:--activate-ulf) echo "Successfully activated the entitlement license"; exit 0;;
  oldflag:--activate-ulf) echo "Unrecognized option --activate-ulf"; exit 64;;
  oldflag:--activate-all) echo "activated"; exit 0;;
  tfa:*) echo "Error: Two-factor authentication required for this account"; exit 1;;
  bad:*) echo "Login failed"; exit 2;;
  seat:*) echo "Found 3 entitlement groups and 0 free entitlements"; exit 1;;
esac
exit 1
`;
const EDITOR = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do if [ "$1" = -logFile ]; then echo "\${FAKE_EDITOR_LOG:-opened}" > "$2"; fi; shift; done
exit 0
`;

function run(mode: string, extra: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkes-lic-'));
  const client = path.join(dir, 'client');
  const editor = path.join(dir, 'unity');
  fs.writeFileSync(client, CLIENT, { mode: 0o755 });
  fs.writeFileSync(editor, EDITOR, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'calls'), '');
  const work = path.join(dir, 'work');
  const toBash = (p: string) => p.replace(/\\/g, '/');
  const r = spawnSync('bash', [toBash(ENTRY)], {
    encoding: 'utf8',
    env: {
      ...process.env, FAKE_DIR: toBash(dir), FAKE_MODE: mode, HAWKES_LICENSE_CHECK: '1', HAWKES_WORK: toBash(work), HOME: toBash(work),
      UNITY_BIN: toBash(editor), UNITY_LICENSING_CLIENT_PATH: toBash(client), UNITY_EMAIL: 'build@example.com', UNITY_PASSWORD: 's3cret-pw', ...extra,
    },
  });
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls };
}

test('Personal activation with email and password, then the license is returned', { skip: !hasBash }, () => {
  const r = run('ok');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /license: activated \(personal\)/);
  assert.match(r.out, /license: OK, the editor opened a project licensed/);
  assert.deepEqual(r.calls, ['--activate-ulf', '--return-ulf']);
  assert.doesNotMatch(r.out, /s3cret-pw/);
});

test('the other flag spelling (--activate-all) is tried when the first is unknown', { skip: !hasBash }, () => {
  const r = run('oldflag');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, ['--activate-ulf', '--activate-all', '--return-ulf']);
});

test('2FA, a bad password and a seat limit fail with plain reasons', { skip: !hasBash }, () => {
  const tfa = run('tfa');
  assert.equal(tfa.code, 1);
  assert.match(tfa.out, /two-factor or device verification/);
  const bad = run('bad');
  assert.match(bad.out, /Unity refused the email or password \(secrets unity-email, unity-password\)/);
  const seat = run('seat');
  assert.match(seat.out, /no free Personal activation \(seat limit\)/);
  for (const r of [tfa, bad, seat]) assert.doesNotMatch(r.out, /s3cret-pw/);
});

test('no account secrets fails at once', { skip: !hasBash }, () => {
  const r = run('ok', { UNITY_EMAIL: '', UNITY_PASSWORD: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /secrets unity-email and unity-password .* are empty/);
  assert.deepEqual(r.calls, []);
});

test('an editor that still says unlicensed fails the check (and returns the seat)', { skip: !hasBash }, () => {
  const r = run('ok', { FAKE_EDITOR_LOG: 'No valid Unity Editor license found' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED when opening a project/);
  assert.deepEqual(r.calls, ['--activate-ulf', '--return-ulf']);
});
