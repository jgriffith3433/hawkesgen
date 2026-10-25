// The Gen voice library: voices of open models, keyed by id (gv_...), no slot cap. A voice is its recipe, not a model
// file: the description it was designed from (or the reference clip it was cloned from), the model and seed that
// made it, and the reference audio kept under DATA_DIR/voices, so it can be recreated on any server and by any model
// that clones from a sample. `elevenlabs_id` links a character to the ElevenLabs voice it replaces (content/voice.json
// ids keep working; nothing is rewritten).

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { db } from '../db.ts';
import { GenError, id as newId } from '../util.ts';

db.exec(`CREATE TABLE IF NOT EXISTS audio_voices (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  recipe TEXT NOT NULL DEFAULT '{}',
  ref_file TEXT,
  ref_text TEXT NOT NULL DEFAULT '',
  elevenlabs_id TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS audio_voices_project ON audio_voices (project, status)');

export const VOICE_DIR = path.join(DATA_DIR, 'voices');
export const isGenVoiceId = (v: unknown) => typeof v === 'string' && /^gv_[0-9a-f]{12,32}$/.test(v);

export type Voice = {
  id: string; project: string; name: string; status: 'candidate' | 'saved'; description: string; model: string; language: string;
  recipe: Record<string, unknown>; refFile: string | null; refText: string; elevenlabsId: string | null; created: number; updated: number;
};

const row = (r: any): Voice => ({
  id: r.id, project: r.project, name: r.name, status: r.status, description: r.description, model: r.model, language: r.language,
  recipe: JSON.parse(r.recipe || '{}'), refFile: r.ref_file, refText: r.ref_text, elevenlabsId: r.elevenlabs_id, created: r.created, updated: r.updated,
});

export function createVoice(v: { project: string; name: string; status?: 'candidate' | 'saved'; description?: string; model: string; language?: string; recipe?: Record<string, unknown>; refAudio?: Buffer; refExt?: string; refText?: string; elevenlabsId?: string | null }): Voice {
  const name = v.name.trim();
  if (!name || name.length > 80) throw new GenError('A voice needs a name (up to 80 characters)');
  const id = newId('gv', 8);
  let refFile: string | null = null;
  if (v.refAudio) {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    refFile = `${id}${/^\.[a-z0-9]{2,4}$/i.test(v.refExt ?? '') ? v.refExt : '.wav'}`;
    fs.writeFileSync(path.join(VOICE_DIR, refFile), v.refAudio);
  }
  const now = Date.now();
  db.prepare('INSERT INTO audio_voices (id, project, name, status, description, model, language, recipe, ref_file, ref_text, elevenlabs_id, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, v.project, name, v.status ?? 'saved', v.description ?? '', v.model, v.language ?? 'en', JSON.stringify(v.recipe ?? {}), refFile, v.refText ?? '', v.elevenlabsId ?? null, now, now);
  return getVoice(id)!;
}

export function getVoice(idv: string): Voice | null {
  const r = db.prepare('SELECT * FROM audio_voices WHERE id = ?').get(idv);
  return r ? row(r) : null;
}

export function requireVoice(idv: string): Voice {
  const v = getVoice(idv);
  if (!v) throw new GenError(`No voice ${idv} in the Gen voice library (audio.voice-list shows them)`, { status: 404 });
  return v;
}

export function listVoices(o: { project?: string; status?: 'candidate' | 'saved' } = {}): Voice[] {
  const where: string[] = [];
  const args: string[] = [];
  if (o.project) { where.push('project = ?'); args.push(o.project); }
  if (o.status) { where.push('status = ?'); args.push(o.status); }
  return (db.prepare(`SELECT * FROM audio_voices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC`).all(...args) as any[]).map(row);
}

/** Promotes a designed candidate to a saved voice (and renames it). */
export function saveVoice(idv: string, p: { name: string; description?: string; elevenlabsId?: string | null }): Voice {
  const v = requireVoice(idv);
  const name = p.name.trim();
  if (!name || name.length > 80) throw new GenError('A voice needs a name (up to 80 characters)');
  db.prepare('UPDATE audio_voices SET name = ?, description = ?, status = ?, elevenlabs_id = COALESCE(?, elevenlabs_id), updated = ? WHERE id = ?')
    .run(name, p.description ?? v.description, 'saved', p.elevenlabsId ?? null, Date.now(), idv);
  return getVoice(idv)!;
}

export function deleteVoice(idv: string): Voice {
  const v = requireVoice(idv);
  db.prepare('DELETE FROM audio_voices WHERE id = ?').run(idv);
  if (v.refFile) fs.rmSync(path.join(VOICE_DIR, v.refFile), { force: true });
  return v;
}

/** The reference clip's local path, if the voice has one. */
export function refPath(v: Voice): string | null {
  if (!v.refFile) return null;
  const p = path.join(VOICE_DIR, v.refFile);
  return fs.existsSync(p) ? p : null;
}

/** What a voice looks like in a result: no local paths. */
export const publicVoice = (v: Voice) => ({ id: v.id, project: v.project, name: v.name, status: v.status, description: v.description, model: v.model, language: v.language, recipe: v.recipe, hasReference: Boolean(v.refFile), refText: v.refText, elevenlabsId: v.elevenlabsId, created: new Date(v.created).toISOString() });
