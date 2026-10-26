// Placement by free disk, and the one retry after "No space left on device" (src/placement.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayPlace, noRoomReason, isDiskHeavy, isDiskFullError, retryOnDiskFull, MIN_FREE_BYTES } from '../src/placement.ts';

const GB = 1e9;
const free = new Map([['full', 0], ['roomy', 120 * GB], ['tight', 9 * GB]]);
const render = { tool: 'blender.render', family: 'blender' };
const image = { tool: 'image.generate', family: 'sdxl' };

test('disk-heavy tools are recognised', () => {
  assert.ok(isDiskHeavy(render));
  assert.ok(isDiskHeavy({ tool: 'x', family: 'rig' }));
  assert.ok(!isDiskHeavy(image));
});

test('a render skips a full or tight server and takes one with room', () => {
  assert.equal(mayPlace(render, 'full', free), false);
  assert.equal(mayPlace(render, 'tight', free), false);
  assert.equal(mayPlace(render, 'roomy', free), true);
  assert.equal(mayPlace(render, 'unknown', free), true);
  assert.equal(mayPlace(render, 'tight', free, new Set(), 5 * GB), true);
  assert.equal(MIN_FREE_BYTES, 10 * GB);
});

test('other tools ignore disk, but never a server the job already failed on', () => {
  assert.equal(mayPlace(image, 'full', free), true);
  assert.equal(mayPlace(image, 'roomy', free, new Set(['roomy'])), false);
});

test('the reason names the servers when none has room', () => {
  assert.match(noRoomReason(['full', 'tight'], free), /no GPU server has 10 GB.*full \(0\.0 GB free\).*tight \(9\.0 GB free\)/);
  assert.equal(noRoomReason(['full', 'roomy'], free), '');
  assert.equal(noRoomReason([], free), '');
  assert.match(noRoomReason(['roomy'], free, new Set(['roomy'])), /failed with a full disk/);
});

test('a full disk is retried once, not twice, not when cancelled', () => {
  const msg = 'Blender failed (exit 1):\nOSError: [Errno 28] No space left on device';
  assert.ok(isDiskFullError(msg));
  assert.ok(!isDiskFullError('Blender failed (exit 1): bad scene'));
  assert.equal(retryOnDiskFull(msg, new Set()), true);
  assert.equal(retryOnDiskFull(msg, new Set(['full'])), false);
  assert.equal(retryOnDiskFull(msg, new Set(), true), false);
  assert.equal(retryOnDiskFull('some other error', new Set()), false);
});
