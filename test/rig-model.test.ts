// mesh.rig's model choice and the install script. The models themselves run on a GPU server; CI checks the pins,
// the licenses, and that the shell the server runs is valid bash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { beamsForVram, chooseBackend, installScript, MIA_COMMIT, RIG_LICENSES, SKIN_COMMIT } from '../src/providers/rig/install.ts';
import { rigJobScript } from '../src/tools/rig.ts';

test('chooseBackend: humanoids use Make-It-Animatable; auto falls back to SkinTokens', () => {
  assert.equal(chooseBackend('humanoid', true), 'mia');
  assert.equal(chooseBackend('humanoid', false), 'mia');
  assert.equal(chooseBackend('auto', true), 'mia');
  assert.equal(chooseBackend('auto', false), 'skin');
  assert.equal(chooseBackend('auto', true, true), 'skin');
  assert.throws(() => chooseBackend('creature', true), /humanoid or auto/);
});

test('beamsForVram: fewer beams on a smaller GPU', () => {
  assert.equal(beamsForVram(48_000), 10);
  assert.equal(beamsForVram(24_000), 4);
  assert.equal(beamsForVram(16_000), 2);
});

test('licenses: both models that run are cleared for commercial use; UniRig is not installed', () => {
  const byId = Object.fromEntries(RIG_LICENSES.map((l) => [l.id, l]));
  assert.equal(byId['make-it-animatable'].commercial, true);
  assert.equal(byId['make-it-animatable'].weights, 'Apache-2.0');
  assert.equal(byId.skintokens.commercial, true);
  assert.equal(byId.skintokens.weights, 'MIT');
  assert.match(installScript(), new RegExp(MIA_COMMIT));
  assert.match(installScript(), new RegExp(SKIN_COMMIT));
  assert.equal(byId['hunyuan3d-2.1-shapevae'].commercial, true);
  assert.equal(byId.unirig.commercial, true);
  assert.equal(byId.unirig.use, 'not installed');
});

test('install script pins the commits, skips Auto-Rig Pro, and refuses a full disk', () => {
  const sh = installScript();
  assert.match(sh, new RegExp(MIA_COMMIT));
  assert.match(sh, new RegExp(SKIN_COMMIT));
  assert.match(sh, /Make-It-Animatable/);
  assert.match(sh, /SkinTokens/);
  assert.match(sh, /util\/Hunyuan3D_21/);
  assert.doesNotMatch(sh, /auto_rig_pro/);
  assert.match(sh, /32212254720|30 GB/);
  assert.match(sh, /output\/best\/v2/);
  assert.match(sh, /make_template.py/);
  assert.doesNotMatch(sh, /--recursive/);
});

test('job script is valid bash and routes humanoid and auto', () => {
  for (const kind of ['humanoid', 'auto'] as const) {
    const sh = rigJobScript({ kind, keepTextures: true, fps: 24, frames: 48 });
    const r = spawnSync('bash', ['-n'], { input: sh, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(sh, /mia_run.py/);
    assert.match(sh, /demo.py/);
    assert.match(sh, /hawkes_rig.py -- finish.json/);
    assert.match(sh, /--use_transfer/);
    assert.match(sh, /20000/);
    assert.match(sh, /res\/walk.mp4/);
    if (kind === 'humanoid') assert.match(sh, /KIND=humanoid/);
    else assert.match(sh, /classify.json/);
  }
  const bare = rigJobScript({ kind: 'auto', keepTextures: false, fps: 24, frames: 8, preview: false });
  assert.match(bare, /\[ "0" = 1 \]/);
  assert.doesNotMatch(bare, /walk\.mp4/);
  assert.equal(spawnSync('bash', ['-n'], { input: bare, encoding: 'utf8' }).status, 0);
});
