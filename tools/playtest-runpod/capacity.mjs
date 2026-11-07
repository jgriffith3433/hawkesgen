#!/usr/bin/env node
// How many playtest browsers run at once (docs/playtest-runpod.md, "Lane"): the RunPod playtest endpoint's workers.max,
// and nothing else. Gen reads workers.max back every 2 minutes (src/providers/playtester/runpodcap.ts), so its playtest
// lane is workers.max x tabs per worker (2) without any change to Gen's settings.
//
//   node tools/playtest-runpod/capacity.mjs --max 6                    print the change (changes nothing)
//   node tools/playtest-runpod/capacity.mjs --max 6 --apply            PATCH only workers.max, then read it back
//   options: --endpoint 43vc12r3r5gj4n
//
// Unlike setup.mjs --apply this sends only {workers: {min, max, idleTimeout}}: the image, the template, the GPU list and
// the token stay exactly as they are (a new GPU list needs a new endpoint: docs/playtest-runpod.md). Costs nothing by
// itself: RunPod bills a worker per second only while it runs, and workers min stays 0, so more workers play the same
// queue sooner for about the same money (each extra worker adds at most its cold start and its idle tail).
import { APPLY, arg, secret, say, header } from '../gpu-providers/lib.mjs';
import { runpod } from '../gpu-providers/runpod-v2.mjs';

/** The most this script will set: a mistake can't scale the endpoint past it. */
export const CEILING = 10;
const id = arg('endpoint', '43vc12r3r5gj4n');
const max = Number(arg('max', ''));
if (!/^[a-z0-9]{6,32}$/.test(id)) { console.error(`--endpoint ${id}: not a RunPod endpoint id`); process.exit(1); }
if (!Number.isInteger(max) || max < 1 || max > CEILING) { console.error(`--max must be a whole number from 1 to ${CEILING}`); process.exit(1); }
const key = secret('RUNPOD_API_KEY');
if (!key) { console.error('RUNPOD_API_KEY is not set (hawkesgen/.env, or the environment).'); process.exit(1); }
const api = runpod(key);

const before = await api.req('GET', `/serverless/${id}`);
const w = before.workers ?? {};
header(`RunPod endpoint ${id} (${before.name ?? '?'})`);
say(`now: workers ${w.min ?? '?'}..${w.max ?? '?'}, idle ${w.idleTimeout ?? '?'} s; GPU pools ${(before.gpu?.pools ?? []).join(', ') || '?'}`);
if (w.max === max) { say(`workers.max is already ${max}: nothing to do`); process.exit(0); }
const body = { workers: { min: w.min ?? 0, max, idleTimeout: w.idleTimeout ?? 60 } };
say(`${APPLY ? 'setting' : 'would set'} workers.max ${w.max ?? '?'} -> ${max} (${max * 2} playtest browsers with 2 per worker)`);
if (!APPLY) { say('dry run: add --apply to change it'); process.exit(0); }
await api.req('PATCH', `/serverless/${id}`, body);
const after = await api.req('GET', `/serverless/${id}`);
say(`read back: workers ${after.workers?.min}..${after.workers?.max}, idle ${after.workers?.idleTimeout} s; GPU pools ${(after.gpu?.pools ?? []).join(', ')}; image ${after.image ?? before.image ?? '?'}`);
if (after.workers?.max !== max) { console.error(`RunPod still says workers.max ${after.workers?.max}: not changed`); process.exit(1); }
if (JSON.stringify(after.gpu?.pools) !== JSON.stringify(before.gpu?.pools)) { console.error('the GPU pools changed too: check the endpoint'); process.exit(1); }
say('done: Gen picks it up within 2 minutes');
