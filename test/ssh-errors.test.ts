import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sshFailure } from '../src/providers/comfy/fleet.ts';

const ctx = { id: 'i-abc', ip: '1.2.3.4', keyFile: 'hawkesgen-comfy.pem', platform: 'linux' };

test('a rejected key is not called a file-permission problem', () => {
  const m = sshFailure('Warning: Permanently added x\nubuntu@1.2.3.4: Permission denied (publickey).', 255, ctx);
  assert.match(m, /key rejected by i-abc \(1\.2\.3\.4\), key hawkesgen-comfy\.pem/);
  assert.doesNotMatch(m, /icacls|file's permissions/);
  assert.match(m, /Permission denied \(publickey\)/);
});

test('real unprotected-key errors get chmod advice on Linux and icacls on Windows', () => {
  const err = '@ WARNING: UNPROTECTED PRIVATE KEY FILE! @\nPermissions 0644 for k are too open.\nbad permissions';
  assert.match(sshFailure(err, 255, ctx), /chmod 600/);
  assert.doesNotMatch(sshFailure(err, 255, ctx), /icacls/);
  assert.match(sshFailure(err, 255, { ...ctx, platform: 'win32' }), /icacls/);
});

test('other failures keep ssh\'s real last lines', () => {
  const m = sshFailure('ssh: connect to host 1.2.3.4 port 22: Connection timed out', 255, ctx);
  assert.match(m, /Connection timed out/);
  assert.match(m, /i-abc/);
  assert.match(sshFailure('', 7, ctx), /exit 7/);
});

test('the Blender character script captures names before objects are removed', () => {
  const py = fs.readFileSync(new URL('../post/blender/hawkes_character.py', import.meta.url), 'utf8');
  assert.doesNotMatch(py, /\{o\.name for o in objs\}/);
  assert.equal((py.match(/action_label\([^)]*obj_names\)/g) ?? []).length, 2);
});
