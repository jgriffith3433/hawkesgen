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

test("projects' kinds: every slot recipe names a real tool, its inputs and valid params", () => {
  const checkMake = (where: string, make: any) => {
    if (!make) return;
    const tool = getTool(make.tool ?? (make.steps ? 'asset.make' : ''));
    assert.ok(tool, `${where}: unknown tool ${make.tool}`);
    for (const name of Object.keys(make.inputs ?? {})) assert.ok(name in tool!.inputs, `${where}: ${tool!.id} has no input ${name}`);
    const params: Record<string, unknown> = { ...(make.params ?? {}) };
    if (make.steps) {
      params.steps = make.steps;
      if (make.candidates != null) params.candidates = make.candidates;
      if (make.pick) params.pick = make.pick;
      if (make.pickAt != null) params.pickAt = make.pickAt;
      if (make.refs) params.refs = make.refs;
    }
    for (const [k2, spec] of Object.entries(tool!.params)) if (spec.required && params[k2] === undefined) params[k2] = spec.type === 'json' ? [] : 'x';
    assert.doesNotThrow(() => validateParams(tool!, params), where);
  };
  for (const pp of listPresets() as any[]) {
    for (const [kind, k] of Object.entries<any>(pp.kinds ?? {})) {
      if (kind.startsWith('_')) continue;
      for (const [slot, s] of Object.entries<any>(k.slots ?? {})) {
        checkMake(`${pp.project} kinds.${kind}.${slot}`, s.make);
        checkMake(`${pp.project} kinds.${kind}.${slot}.makeRobot`, s.makeRobot);
      }
    }
  }
});

test('the SDK copies list (clients/js/sdk.json) names real files', async () => {
  const fs = await import('node:fs');
  const sdk = JSON.parse(fs.readFileSync('clients/js/sdk.json', 'utf8'));
  for (const f of sdk.files) assert.ok(fs.existsSync(`clients/js/${f}`), f);
  for (const [repo, dirs] of Object.entries<any>(sdk.consumers)) {
    for (const files of Object.values<string[]>(dirs)) for (const f of files) assert.ok(sdk.files.includes(f), `${repo}: ${f} isn't an SDK file`);
  }
});
