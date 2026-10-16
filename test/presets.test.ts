// Every preset names a real tool and only params that tool takes, with valid values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPresets, applyPreset } from '../src/presets.ts';
import { getTool } from '../src/tools/index.ts';
import { validateParams } from '../src/tools/validate.ts';

test('presets are valid for their tools', () => {
  const all = listPresets();
  assert.ok(all.length >= 5);
  for (const pp of all) {
    for (const [name, p] of Object.entries(pp.presets)) {
      const tool = getTool(p.tool ?? '');
      assert.ok(tool, `${pp.project}/${name}: unknown tool ${p.tool}`);
      const applied = applyPreset({ project: pp.project, preset: name, params: { prompt: 'a test subject' } }, (id) => getTool(id)?.params ?? null);
      const params: Record<string, unknown> = Object.fromEntries(Object.entries(applied.params).filter(([k]) => k in tool!.params));
      // What the caller always supplies (a line's text, a voice id...).
      for (const [k, spec] of Object.entries(tool!.params)) if (spec.required && params[k] === undefined) params[k] = spec.type === 'json' ? {} : k === 'voice' ? 'abcdefghij' : 'x';
      assert.doesNotThrow(() => validateParams(tool!, params), `${pp.project}/${name}`);
      if (p.prompt && 'prompt' in tool!.params) assert.ok(String(applied.params.prompt).includes('a test subject'), `${pp.project}/${name}: prompt template drops {prompt}`);
    }
  }
});
