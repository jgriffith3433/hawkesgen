// Gives each house voice (src/audio/house.ts) its sample: designs it once on Gen's own voice model from its description
// and seed, and saves it to the `shared` project under its id. From then on every line in that voice clones the sample,
// so a character sounds the same in every line, and the app plays it as the voice's preview.
//
//   node tools/house-voices.mjs                 lists what each voice has (free)
//   node tools/house-voices.mjs --make          designs the ones without a sample (GPU: about a cent each; ask J first)
//   node tools/house-voices.mjs --make --redo hv_villain,hv_kid   designs these again (the old sample stays until deleted)
//   --url <gen>                                  another Gen (default: ~/.hawkes/client.json)

import { HawkesGen } from '../clients/js/hawkesgen.mjs';
import { HOUSE_VOICES } from '../src/audio/house.ts';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const make = args.includes('--make');
const redo = new Set(String(opt('redo', '')).split(',').filter(Boolean));
const gen = new HawkesGen({ url: opt('url'), project: 'shared' });

const list = await gen.run('audio.voice-list', { params: { project: 'shared', provider: 'open' } });
const saved = new Map((list.result?.voices ?? []).filter((v) => v.hasReference).map((v) => [v.name, v]));
for (const h of HOUSE_VOICES) {
  const have = saved.get(h.id);
  console.log(`${h.id.padEnd(20)} ${h.name.padEnd(8)} ${have ? `sample ${have.id}` : 'no sample yet'}`);
}
if (!make) process.exit(0);

const todo = HOUSE_VOICES.filter((h) => !saved.has(h.id) || redo.has(h.id));
console.log(`\nDesigning ${todo.length} voice(s) on Gen's voice model...`);
// All at once: Gen keeps them on one worker with the model loaded.
const jobs = await Promise.allSettled(todo.map((h) => gen.run('audio.voice-design', {
  params: { description: h.description, candidates: 1, seed: h.seed, provider: 'open' },
  key: `house-voice:${h.id}:${h.seed}`,
})));
for (const [i, h] of todo.entries()) {
  const r = jobs[i];
  const id = r.status === 'fulfilled' ? r.value.result?.candidates?.[0] : null;
  if (!id) { console.log(`${h.id}: no candidate (${r.status === 'rejected' ? r.reason?.message : 'none came back'})`); continue; }
  const s = await gen.run('audio.voice-save', { params: { generatedVoiceId: id, name: h.id, description: h.description, provider: 'open' } });
  console.log(`${h.id}: saved ${s.result?.voiceId}`);
}
