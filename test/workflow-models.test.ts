// Every model a registered ComfyUI workflow needs can be installed: it is a core model in server/models.json, or its
// manifest gives a download url (installed on first use). Nothing is left for a server to fail on silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflows, listWorkflows, WORKFLOWS_DIR } from '../src/workflows/registry.ts';

test('every model a workflow requires is in models.json or has a download url', () => {
  const core = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, '../server/models.json'), 'utf8'));
  const declared = new Set<string>(core.models.map((m: any) => `${m.dir}/${m.file}`));
  loadWorkflows();
  const missing: string[] = [];
  for (const w of listWorkflows()) {
    for (const m of w.manifest.models ?? []) {
      const key = `${m.dir}/${m.file}`;
      if (!declared.has(key) && !(m as any).url) missing.push(`${w.manifest.id}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `declare these in server/models.json or give them a url in the workflow manifest:\n${missing.join('\n')}`);
});
