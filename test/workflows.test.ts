// Every workflow folder loads, its manifest points at real graph nodes, and its
// graph passes the node-definition check (with the cached /object_info).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflows, listWorkflows } from '../src/workflows/registry.ts';
import { checkGraph } from '../src/workflows/convert.ts';
import { DATA_DIR } from '../src/config.ts';

const infoFile = path.join(DATA_DIR, 'comfy-cache', 'object_info.json');

test('workflow folders load', () => {
  loadWorkflows();
  assert.ok(listWorkflows().length >= 10, `only ${listWorkflows().length} workflows loaded`);
});

test('workflow graphs match the server node definitions', { skip: !fs.existsSync(infoFile) && 'no cached object_info' }, () => {
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  loadWorkflows();
  for (const w of listWorkflows()) {
    const { problems } = checkGraph(w.graph, info);
    assert.deepEqual(problems, [], `${w.manifest.id}: ${problems.join('; ')}`);
    for (const mm of w.manifest.models) assert.match(mm.url, /^https:\/\//, `${w.manifest.id}: ${mm.file} has no download link`);
  }
});
