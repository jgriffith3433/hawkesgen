// The saved ElevenLabs voices: list them (with what Gen knows about each) and delete one to free a slot. The account
// has a fixed number of slots, and agents can only reach ElevenLabs through Gen.

import type { Tool } from './types.ts';
import { db } from '../db.ts';
import { recordUsage } from '../usage.ts';
import { voices, deleteVoice } from '../providers/elevenlabs.ts';
import { GenError } from '../util.ts';
import { listExtra, deleteExtra } from '../audio/params.ts';
import { routeAudio } from '../audio/plan.ts';

const ID = /^[A-Za-z0-9]{8,40}$/;
/** Tools that only manage voices: a mention of an id there is not a use. */
const MANAGING = ['audio.voice-list', 'audio.voice-delete', 'audio.voice-save', 'audio.voice-design'];

export type VoiceUse = { kind: 'job' | 'entity' | 'asset'; id: string; project: string; tool?: string };
export type VoiceOrigin = { job: string; project: string; client: string; assets: string[] };

/** What Gen's records say about a voice: the job that saved it, and the jobs, library items and recipes that use it. */
export function voiceKnowledge(voiceId: string): { origin: VoiceOrigin | null; uses: VoiceUse[] } {
  if (!ID.test(voiceId)) throw new GenError('voiceId must be an ElevenLabs voice id');
  const like = `%${voiceId}%`;
  const saved = db.prepare("SELECT id, project, client FROM jobs WHERE tool = 'audio.voice-save' AND status = 'done' AND result LIKE ? ORDER BY created LIMIT 1").get(like) as any;
  const origin: VoiceOrigin | null = saved ? { job: saved.id, project: saved.project, client: saved.client, assets: [] } : null;
  const uses: VoiceUse[] = [];
  const marks = MANAGING.map(() => '?').join(',');
  for (const j of db.prepare(`SELECT id, project, tool FROM jobs WHERE params LIKE ? AND tool NOT IN (${marks}) ORDER BY created DESC LIMIT 50`).all(like, ...MANAGING) as any[])
    uses.push({ kind: 'job', id: j.id, project: j.project, tool: j.tool });
  for (const e of db.prepare('SELECT id, project FROM entities WHERE archived = 0 AND data LIKE ?').all(like) as any[])
    uses.push({ kind: 'entity', id: e.id, project: e.project });
  for (const a of db.prepare(`SELECT id, project, tool FROM assets WHERE recipe LIKE ? AND tool NOT IN (${marks}) LIMIT 50`).all(like, ...MANAGING) as any[])
    uses.push({ kind: 'asset', id: a.id, project: a.project, tool: a.tool });
  return { origin, uses };
}

export const voiceListTool: Tool = {
  id: 'audio.voice-list',
  version: 1,
  title: 'List saved voices',
  description: 'Lists the voices saved in the ElevenLabs account (id, name, created, category) and, where Gen knows, the job that saved each one and the products whose jobs, entities and recipes use it. Use it before audio.voice-delete to find a slot to free.',
  provider: 'elevenlabs',
  output: 'json',
  inputs: {},
  params: {
    includePremade: { type: 'boolean', default: false, description: 'Also list ElevenLabs\' own premade voices (they use no slot).' },
    ...listExtra,
  },
  route: (p) => routeAudio('list', p),
  async run(ctx) {
    ctx.step('listing voices');
    const all = await voices({ force: true });
    const list = all.filter((v: any) => ctx.params.includePremade || v.category !== 'premade').map((v: any) => {
      const k = voiceKnowledge(v.id);
      return {
        id: v.id, name: v.name, created: v.created ? new Date(v.created).toISOString() : null, category: v.category, description: v.description,
        madeBy: k.origin, usedBy: k.uses, usedByProducts: [...new Set(k.uses.map((u) => u.project))],
      };
    });
    ctx.result({ count: list.length, voices: list });
  },
};

export const voiceDeleteTool: Tool = {
  id: 'audio.voice-delete',
  version: 1,
  title: 'Delete a saved voice',
  description: 'Deletes one saved ElevenLabs voice by id to free a slot. Refused when Gen\'s jobs, library or recipes show a product using it, unless confirm: true. Every delete is noted in the usage log (voice id, name, who asked) so the voice can be recreated. Deleting cannot be undone.',
  provider: 'elevenlabs',
  output: 'json',
  inputs: {},
  params: {
    voiceId: { type: 'string', required: true, description: 'The voice id (from audio.voice-list).' },
    confirm: { type: 'boolean', default: false, description: 'Delete even though a product uses this voice.' },
    ...deleteExtra,
  },
  route: (p) => routeAudio('delete', p),
  guard({ params }) {
    if (!ID.test(String(params.voiceId ?? ''))) throw new GenError('voiceId must be an ElevenLabs voice id (audio.voice-list shows them)');
  },
  async run(ctx) {
    const voiceId = String(ctx.params.voiceId);
    const k = voiceKnowledge(voiceId);
    const projects = [...new Set(k.uses.map((u) => u.project))];
    if (k.uses.length && ctx.params.confirm !== true)
      throw new GenError(`Voice ${voiceId} is used by ${projects.join(', ')} (${k.uses.length} job/library/recipe records, e.g. ${k.uses[0].kind} ${k.uses[0].id}). Pass confirm: true to delete it anyway.`, { status: 409 });
    ctx.step('finding the voice');
    const found = (await voices({ force: true })).find((v: any) => v.id === voiceId);
    if (!found) throw new GenError(`No saved voice ${voiceId} in the ElevenLabs account`, { status: 404 });
    const who = `${ctx.job.client}/${ctx.job.project}`;
    // Noted first, so a voice is never gone without a trace.
    const note = JSON.stringify({ voiceId, name: found.name, description: found.description, category: found.category, askedBy: who, job: ctx.job.id, confirmed: ctx.params.confirm === true, usedBy: projects, madeBy: k.origin?.job ?? null });
    ctx.log(`deleting voice ${note}`);
    recordUsage({ client: ctx.job.client, project: ctx.job.project, job: ctx.job.id, provider: 'elevenlabs', unit: 'voice-deleted', amount: 1, cost: 0, detail: `deleted voice ${voiceId} "${found.name}" asked by ${who}: ${note}` });
    ctx.step('deleting the voice');
    await deleteVoice(voiceId, ctx.signal);
    ctx.result({ deleted: true, voiceId, name: found.name, description: found.description, askedBy: who });
  },
};
