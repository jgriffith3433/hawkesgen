// Portal accounts' projects (usr_/ustg_/ubeta_<hex>) run Claude on the house AI like Gen app accounts (u_<hex>);
// an org's own project still needs its own access (402). With the house AI off, the house route answers 503, which
// shows the call reached it instead of being refused as a customer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAWKESGEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-house-'));
process.env.HAWKESGEN_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.ANTHROPIC_API_KEY;

const { isHouseProject, orgOfProject } = await import('../src/orgsecrets.ts');
const { callScope, ask } = await import('../src/providers/anthropic.ts');
const house = await import('../src/houseai.ts');

const HEX = 'a1b2c3d4e5f60718';
const run = (project: string) => callScope.run({ customer: true, org: orgOfProject(project), house: isHouseProject(project) }, () => ask({ prompt: 'hi' } as any));

test('portal and Gen account projects are house-eligible; org projects are not', () => {
  for (const p of [`usr_${HEX}`, `ustg_${HEX}`, `ubeta_${HEX}`, `u_${HEX}`, `usr_${HEX}.game`]) assert.equal(isHouseProject(p), true, p);
  for (const p of [`org_${HEX}`, `org_${HEX}.game`, 'hawkesgen', `usr_xyz`, '']) assert.equal(isHouseProject(p), false, p);
});

test('a job in usr_<hex> reaches the house route, not the 402', async () => {
  house.saveHouseSettings({ source: 'off' });
  await assert.rejects(run(`usr_${HEX}`), (e: any) => e.status === 503 && /turned off/.test(e.message));
  await assert.rejects(run(`ustg_${HEX}`), (e: any) => e.status === 503);
  await assert.rejects(run(`org_${HEX}`), (e: any) => e.status === 402);
});
