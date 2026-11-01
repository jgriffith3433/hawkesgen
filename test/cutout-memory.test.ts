// image.cutout on a machine without room for BiRefNet (beta Gen's 4 GiB instance, 2026-11-01): the python process was
// killed and its error was only tqdm's download bars, which read as blank. util.failure says what happened instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failure } from '../src/util.ts';

test('a killed process says it was killed, most likely out of memory', () => {
  const bars = 'Downloading data from x to y.\n' + Array.from({ length: 50 }, (_, i) => `${i * 2}%|##| ${i * 19}M/973M`).join('\r');
  const m = failure('/app/.venv/bin/python', null, 'SIGKILL', bars);
  assert.match(m, /^python was killed \(SIGKILL, most likely out of memory\)/);
  assert.ok(!m.includes('\r'), 'no progress-bar redraws left');
  assert.match(m, /98%\|##\| 931M\/973M$/, 'the last bar is kept');
});

test('an ordinary failure keeps the end of its output', () => {
  assert.equal(failure('ffmpeg', 1, null, 'bad input\n'), 'bad input');
  assert.equal(failure('/usr/bin/ffmpeg', 1, null, '   '), 'ffmpeg exited 1');
  assert.equal(failure('node', null, 'SIGTERM', ''), 'node was stopped (SIGTERM)');
});
