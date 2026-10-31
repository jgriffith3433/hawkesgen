// What the showrunner remembers about one account (docs/showrunner.md): the looks they keep, the pacing they cut to,
// what they always change, their recurring characters, and notes they write themselves. Kept per project (a Gen
// account is one project, u_<hex>) and never read for any other: every read and write names the caller's own project.
// Learned from what they do (turns, approved plans, cuts, review fixes kept or undone), shown and edited under
// Account > Your AI, and summarised into every showrunner turn.

import { db } from '../db.ts';

db.exec('CREATE TABLE IF NOT EXISTS showrunner_memory (project TEXT PRIMARY KEY, doc TEXT NOT NULL, updated INTEGER NOT NULL)');

export type Memory = {
  /** Style lines of worlds and productions they approved, newest first. */
  looks: string[];
  /** The average shot length of their cuts, and how many cuts it's from. */
  pacing: { shotSeconds: number | null; cuts: number };
  /** Changes they ask for again and again ("darker", "slower"), with how often. */
  changes: Record<string, number>;
  /** Characters across productions: name, and how many productions they're in. */
  characters: Record<string, { id: string | null; count: number }>;
  /** Their own words (Account > Your AI). */
  notes: string;
  /** Off: nothing is learned or summarised. */
  off: boolean;
};

const blank = (): Memory => ({ looks: [], pacing: { shotSeconds: null, cuts: 0 }, changes: {}, characters: {}, notes: '', off: false });

export function getMemory(project: string): Memory {
  const r = db.prepare('SELECT doc FROM showrunner_memory WHERE project = ?').get(project) as { doc: string } | undefined;
  if (!r) return blank();
  try { return { ...blank(), ...JSON.parse(r.doc) }; } catch { return blank(); }
}

function put(project: string, m: Memory) {
  db.prepare('INSERT INTO showrunner_memory (project, doc, updated) VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET doc = excluded.doc, updated = excluded.updated')
    .run(project, JSON.stringify(m), Date.now());
  return m;
}

/** The person's own edits from Account > Your AI: notes, the switch, and anything they remove. */
export function editMemory(project: string, patch: { notes?: unknown; off?: unknown; looks?: unknown; changes?: unknown; characters?: unknown; pacing?: unknown }): Memory {
  const m = getMemory(project);
  if (typeof patch.notes === 'string') m.notes = patch.notes.slice(0, 2000);
  if (typeof patch.off === 'boolean') m.off = patch.off;
  if (Array.isArray(patch.looks)) m.looks = patch.looks.filter((x) => typeof x === 'string').map((x: string) => x.slice(0, 300)).slice(0, 8);
  if (patch.changes && typeof patch.changes === 'object') m.changes = Object.fromEntries(Object.entries(patch.changes as Record<string, unknown>).filter(([k]) => k in m.changes).map(([k, v]) => [k, Math.max(0, Math.round(Number(v) || 0))]).filter(([, v]) => Number(v) > 0));
  if (patch.characters && typeof patch.characters === 'object') m.characters = Object.fromEntries(Object.entries(m.characters).filter(([k]) => k in (patch.characters as object)));
  if (patch.pacing === null) m.pacing = { shotSeconds: null, cuts: 0 };
  return put(project, m);
}
export const forgetMemory = (project: string) => { db.prepare('DELETE FROM showrunner_memory WHERE project = ?').run(project); return blank(); };

// The changes people ask for, as words to count (the first that matches a message is counted).
const CHANGES: [RegExp, string][] = [
  [/\b(darker|moodier|more shadow|less light)\b/i, 'darker'], [/\b(brighter|lighter|more light)\b/i, 'brighter'],
  [/\b(warmer|golden|orange)\b/i, 'warmer colors'], [/\b(cooler|colder|bluer)\b/i, 'cooler colors'],
  [/\b(faster|quicker|snappier|tighter|tighten|shorter cuts)\b/i, 'faster cuts'], [/\b(slower|longer shots|let it breathe|linger)\b/i, 'slower cuts'],
  [/\b(more dramatic|epic|intense)\b/i, 'more dramatic'], [/\b(subtler|calmer|quieter|understated)\b/i, 'subtler'],
  [/\b(closer|close-?up|tighter shot)\b/i, 'closer framing'], [/\b(wider|pull back|wide shot)\b/i, 'wider framing'],
  [/\b(more saturated|more colou?r|vivid)\b/i, 'more saturated'], [/\b(desaturated|muted|less colou?r)\b/i, 'muted colors'],
  [/\b(louder music|more music)\b/i, 'more music'], [/\b(less music|quieter music|no music)\b/i, 'less music'],
  [/\b(grain|filmic|film look)\b/i, 'film grain'], [/\b(handheld|shaky)\b/i, 'handheld camera'],
];

export type MemoryEvent =
  | { kind: 'turn'; text: string }
  | { kind: 'approved'; style?: string | null; characters?: { name: string; id: string | null }[] }
  | { kind: 'cut'; shotSeconds: number[] }
  | { kind: 'review'; note: string; kept: boolean };

/** Learns from one thing the person did. */
export function learn(project: string, e: MemoryEvent): Memory {
  const m = getMemory(project);
  if (m.off) return m;
  if (e.kind === 'turn' || (e.kind === 'review' && e.kept)) {
    const text = e.kind === 'turn' ? e.text : e.note;
    const hit = CHANGES.find(([re]) => re.test(text));
    if (hit) m.changes[hit[1]] = (m.changes[hit[1]] ?? 0) + 1;
  }
  if (e.kind === 'approved') {
    if (e.style?.trim()) m.looks = [e.style.trim().slice(0, 300), ...m.looks.filter((x) => x !== e.style!.trim())].slice(0, 8);
    for (const c of e.characters ?? []) {
      const k = c.name.trim().slice(0, 60);
      if (!k) continue;
      m.characters[k] = { id: c.id ?? m.characters[k]?.id ?? null, count: (m.characters[k]?.count ?? 0) + 1 };
    }
  }
  if (e.kind === 'cut' && e.shotSeconds.length) {
    const avg = e.shotSeconds.reduce((a, b) => a + b, 0) / e.shotSeconds.length;
    const n = m.pacing.cuts;
    m.pacing = { shotSeconds: Math.round((((m.pacing.shotSeconds ?? avg) * n + avg) / (n + 1)) * 10) / 10, cuts: n + 1 };
  }
  return put(project, m);
}

/** A few lines for every turn: only what's settled (a change asked for twice, a character in two productions). */
export function memorySummary(project: string): string {
  const m = getMemory(project);
  if (m.off) return '';
  const out: string[] = [];
  if (m.notes.trim()) out.push(`In their words: ${m.notes.trim().slice(0, 400)}`);
  if (m.looks.length) out.push(`Looks they kept: ${m.looks.slice(0, 2).join(' | ')}`);
  if (m.pacing.shotSeconds && m.pacing.cuts >= 1) out.push(`Their cuts average ${m.pacing.shotSeconds} s a shot.`);
  const often = Object.entries(m.changes).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  if (often.length) out.push(`They often ask for: ${often.join(', ')} (do it from the start).`);
  const recurring = Object.entries(m.characters).filter(([, c]) => c.count >= 2).slice(0, 6).map(([k, c]) => `${k}${c.id ? ` (${c.id})` : ''}`);
  if (recurring.length) out.push(`Recurring characters: ${recurring.join(', ')}.`);
  return out.join('\n').slice(0, 1200);
}
