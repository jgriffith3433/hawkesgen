#!/usr/bin/env node
// Adds the desktop playtest runner (docs/play-native.md) to a Gen lane's settings.playtest.runners, or updates it. The
// lane's browser runners stay: a list with no web runner keeps them (src/providers/playtester/runners.ts). Prints the
// change; --apply sends it with the lane's owner key from ~/.hawkes/client.json (genKey / genBetaKey).
//   node tools/play-native/add-runner.mjs --lane beta --endpoint jcttiz8lw75vca [--apply]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const lane = arg('lane', 'beta');
const endpoint = arg('endpoint');
const apply = process.argv.includes('--apply');
if (!['beta', 'live'].includes(lane) || !/^[a-z0-9]{8,32}$/.test(String(endpoint ?? ''))) {
  console.error('usage: node tools/play-native/add-runner.mjs --lane beta|live --endpoint <RunPod endpoint id> [--apply]');
  process.exit(1);
}
const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hawkes', 'client.json'), 'utf8'));
const url = (lane === 'beta' ? c.genBetaUrl ?? 'https://gen-beta.hawkesgen.ai' : c.genUrl ?? 'https://gen.hawkesgen.ai').replace(/\/+$/, '');
const key = String(lane === 'beta' ? c.genBetaKey : c.genKey ?? '').trim();
if (!key) { console.error(`~/.hawkes/client.json has no ${lane === 'beta' ? 'genBetaKey' : 'genKey'}`); process.exit(1); }
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'hawkes-add-runner' };

const settings = await (await fetch(`${url}/v1/settings`, { headers })).json();
const runner = {
  id: 'runpod-native', provider: 'native', url: `https://${endpoint}.api.runpod.ai`, targets: ['linux', 'proton'],
  lanes: ['studio', 'customer'], pricePerSecond: 0.000161, maxConcurrent: 2,
  tokenEnv: 'GPU_WORKER_TOKEN', gatewayKeyEnv: 'RUNPOD_API_KEY', enabled: true,
};
const runners = [...(settings.playtest?.runners ?? []).filter((r) => r.id !== runner.id), runner];
console.log(`${url}: settings.playtest.runners becomes`);
console.log(JSON.stringify(runners, null, 2));
if (!apply) { console.log('\n(dry run: add --apply to send it)'); process.exit(0); }
const r = await fetch(`${url}/v1/settings`, { method: 'POST', headers, body: JSON.stringify({ playtest: { ...settings.playtest, runners } }) });
if (!r.ok) { console.error(`Gen refused: ${r.status} ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const after = await r.json();
console.log(`saved: ${after.playtest.runners.map((x) => x.id).join(', ')}`);
