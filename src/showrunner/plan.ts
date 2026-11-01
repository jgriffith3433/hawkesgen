// The planner (docs/showrunner.md): a production written top down, as cheap text, before anything costs GPU. World (when
// there isn't one), characters, places, the story (logline, beats, script, shot list), then the shots, the cut and the
// sound. A plan is checked twice: `lintPlan` (rules a program can check: the 180° rule between shots that share a pair,
// continuity of who and where, pacing against the length asked for, canon words) and a critique by Claude at high
// effort with the world's rules; what fails is fixed and checked again, at most twice.

import type { WorldContext } from '../worlds.ts';
import type { ProductionKind } from './classify.ts';

export type PlanCharacter = { key: string; id: string | null; name: string; description: string; voice: string | null; role: string };
export type PlanPlace = { key: string; id: string | null; name: string; description: string };
export type PlanLine = { who: string; text: string; direction: string };
export type ShotType = 'establishing' | 'action' | 'dialogue' | 'two-people' | 'insert';
export type PlanShot = {
  key: string; beat: string; place: string | null; cast: string[]; type: ShotType; seconds: number;
  /** Where the camera stands, in degrees around the action line: -90..90 is one side of it, beyond is the other. */
  angle: number; framing: 'wide' | 'medium' | 'close'; move: string; action: string; lines: PlanLine[];
};
export type PlanBeat = { key: string; text: string };
export type Plan = {
  title: string; kind: ProductionKind; logline: string; seconds: number; aspect: '16:9' | '9:16' | '1:1';
  world: { id: string | null; title: string; tone: string; style: string; negative: string; palette: string[]; canon: string[] } | null;
  characters: PlanCharacter[]; places: PlanPlace[];
  beats: PlanBeat[]; script: { beat: string; text: string }[]; shots: PlanShot[];
  music: { brief: string } | null;
};

const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.trim().slice(0, max) : d);
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const keyOf = (v: unknown, d: string) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : d);
const sceneId = (v: unknown) => (typeof v === 'string' && /^(sn|ep|sh)_[0-9a-f]{6,24}$/.test(v) ? v : null);
const TYPES: ShotType[] = ['establishing', 'action', 'dialogue', 'two-people', 'insert'];
const KINDS: ProductionKind[] = ['show', 'trailer', 'short', 'character', 'world'];

/** A plan as kept: every field checked, keys made where missing, references to unknown keys dropped. */
export function normalizePlan(input: any, fallback: { kind?: ProductionKind; seconds?: number; title?: string } = {}): Plan {
  const p = input && typeof input === 'object' ? input : {};
  const characters: PlanCharacter[] = (Array.isArray(p.characters) ? p.characters : []).slice(0, 8).map((c: any, i: number) => ({
    key: keyOf(c?.key, `c${i + 1}`), id: sceneId(c?.id), name: str(c?.name, 60, `Character ${i + 1}`),
    description: str(c?.description, 900), voice: typeof c?.voice === 'string' && /^(hv|gv)_[\w-]{2,40}$/.test(c.voice) ? c.voice : null, role: str(c?.role, 120),
  }));
  const places: PlanPlace[] = (Array.isArray(p.places) ? p.places : []).slice(0, 6).map((x: any, i: number) => ({ key: keyOf(x?.key, `p${i + 1}`), id: sceneId(x?.id), name: str(x?.name, 60, `Place ${i + 1}`), description: str(x?.description, 900) }));
  const ck = new Set(characters.map((c) => c.key));
  const pk = new Set(places.map((x) => x.key));
  const beats: PlanBeat[] = (Array.isArray(p.beats) ? p.beats : []).slice(0, 24).map((b: any, i: number) => (typeof b === 'string' ? { key: `b${i + 1}`, text: b.slice(0, 400) } : { key: keyOf(b?.key, `b${i + 1}`), text: str(b?.text, 400) }));
  const shots: PlanShot[] = (Array.isArray(p.shots) ? p.shots : []).slice(0, 40).map((s: any, i: number) => ({
    key: keyOf(s?.key, `s${i + 1}`), beat: str(s?.beat, 40), place: pk.has(s?.place) ? s.place : null,
    cast: (Array.isArray(s?.cast) ? s.cast : []).filter((k: unknown) => typeof k === 'string' && ck.has(k)).slice(0, 4),
    type: TYPES.includes(s?.type) ? s.type : 'action', seconds: Math.round(clamp(num(s?.seconds, 4), 1, 12) * 10) / 10,
    angle: Math.round(clamp(num(s?.angle, 0), -180, 180)), framing: (['wide', 'medium', 'close'] as const).includes(s?.framing) ? s.framing : 'medium',
    move: str(s?.move, 40, 'static'), action: str(s?.action, 900),
    lines: (Array.isArray(s?.lines) ? s.lines : []).slice(0, 6).filter((l: any) => l && typeof l.text === 'string' && l.text.trim())
      .map((l: any) => ({ who: typeof l.who === 'string' ? l.who : '', text: str(l.text, 400), direction: str(l.direction, 120) })),
  }));
  const w = p.world && typeof p.world === 'object' ? p.world : null;
  return {
    title: str(p.title, 120, fallback.title ?? 'Untitled production'), kind: KINDS.includes(p.kind) ? p.kind : fallback.kind ?? 'short',
    logline: str(p.logline, 600), seconds: Math.round(clamp(num(p.seconds, fallback.seconds ?? 60), 5, 1800)),
    aspect: (['16:9', '9:16', '1:1'] as const).includes(p.aspect) ? p.aspect : '16:9',
    world: w ? { id: sceneId(w.id), title: str(w.title, 120, 'Untitled world'), tone: str(w.tone, 400), style: str(w.style, 600), negative: str(w.negative, 400), palette: (Array.isArray(w.palette) ? w.palette : []).filter((c: unknown) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8), canon: (Array.isArray(w.canon) ? w.canon : []).filter((c: unknown) => typeof c === 'string').map((c: string) => c.slice(0, 300)).slice(0, 20) } : null,
    characters, places, beats,
    script: (Array.isArray(p.script) ? p.script : []).slice(0, 80).map((x: any) => ({ beat: str(x?.beat, 40), text: str(x?.text ?? x, 1200) })).filter((x: { text: string }) => x.text),
    shots,
    music: p.music && typeof p.music === 'object' && str(p.music.brief, 400) ? { brief: str(p.music.brief, 400) } : null,
  };
}

/** Pulls a JSON object out of an answer (models sometimes wrap it in a fence or a sentence). */
export function jsonOf(text: string): any {
  let t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}

// ------------------------------------------------------------------ the rules a program can check
export type Issue = { rule: 'axis' | 'continuity' | 'pacing' | 'canon' | 'empty'; shot?: string; text: string };
const side = (angle: number) => (Math.abs(angle) <= 90 ? 'A' : 'B');
/** Seconds a line takes said aloud (about 2.6 words a second, plus a breath). */
export const lineSeconds = (text: string) => Math.round((text.split(/\s+/).filter(Boolean).length / 2.6 + 0.4) * 10) / 10;

export function lintPlan(plan: Plan): Issue[] {
  const issues: Issue[] = [];
  if (plan.kind !== 'character' && plan.kind !== 'world' && !plan.shots.length) issues.push({ rule: 'empty', text: 'There are no shots.' });
  const chars = new Map(plan.characters.map((c) => [c.key, c]));
  // The 180° rule: consecutive shots that share two or more people, in the same place, keep the camera on one side of
  // their line, unless an establishing shot (a new geography) comes between.
  for (let i = 1; i < plan.shots.length; i++) {
    const a = plan.shots[i - 1], b = plan.shots[i];
    const shared = a.cast.filter((k) => b.cast.includes(k));
    if (shared.length >= 2 && a.place === b.place && b.type !== 'establishing' && a.type !== 'establishing' && side(a.angle) !== side(b.angle)) {
      issues.push({ rule: 'axis', shot: b.key, text: `Shot ${b.key} crosses the line between ${shared.map((k) => chars.get(k)?.name ?? k).join(' and ')} (camera at ${b.angle}° after ${a.angle}°): keep it on the same side, or put an establishing shot between.` });
    }
  }
  for (const s of plan.shots) {
    for (const l of s.lines) {
      if (!s.cast.includes(l.who)) issues.push({ rule: 'continuity', shot: s.key, text: `In shot ${s.key}, "${l.text.slice(0, 40)}" is said by ${chars.get(l.who)?.name ?? (l.who || 'nobody')}, who isn't in the shot.` });
    }
    const talk = s.lines.reduce((n, l) => n + lineSeconds(l.text), 0);
    if (talk > s.seconds + 0.5) issues.push({ rule: 'pacing', shot: s.key, text: `Shot ${s.key} is ${s.seconds} s but its lines take about ${Math.ceil(talk)} s.` });
    if (s.type === 'dialogue' && !s.lines.length) issues.push({ rule: 'continuity', shot: s.key, text: `Shot ${s.key} is a dialogue shot with no lines.` });
    if (s.type !== 'establishing' && s.type !== 'insert' && !s.cast.length && !s.action) issues.push({ rule: 'continuity', shot: s.key, text: `Shot ${s.key} has nobody in it and no action.` });
  }
  if (plan.shots.length) {
    const total = plan.shots.reduce((n, s) => n + s.seconds, 0);
    if (Math.abs(total - plan.seconds) > Math.max(3, plan.seconds * 0.15)) issues.push({ rule: 'pacing', text: `The shots add up to ${Math.round(total)} s; the production is ${plan.seconds} s.` });
  }
  // Canon written as a word nobody says ("no one says the founder's name: Arlen"): checked on every line.
  for (const rule of plan.world?.canon ?? []) {
    const m = /\b(?:never|no one|nobody)\b[^"'“]*(?:say|says|said|speak|speaks|mention|mentions|names?)\b[^"'“]*["'“]([^"'”]{2,40})["'”]/i.exec(rule);
    if (!m) continue;
    const word = m[1].toLowerCase();
    for (const s of plan.shots) for (const l of s.lines) if (l.text.toLowerCase().includes(word)) issues.push({ rule: 'canon', shot: s.key, text: `Shot ${s.key} breaks the canon "${rule}".` });
  }
  return issues;
}

// ------------------------------------------------------------------ prompts
export type PlanContext = {
  request: string; kind: ProductionKind; seconds: number | null;
  world: WorldContext | null; memory: string;
  characters: { id: string; name: string; description: string }[];
  voices: { id: string; name: string; about: string }[];
  /** A plan already on the card, when the person asked to change it. */
  previous?: Plan | null;
  conversation: { role: 'user' | 'assistant'; text: string }[];
};

const PLAN_DOC = `A production plan (JSON):
{"title": "...", "kind": "show"|"trailer"|"short"|"character"|"world", "logline": "one sentence", "seconds": total length, "aspect": "16:9"|"9:16"|"1:1",
 "world": null when it plays in the person's world (its id is given) | {"id": the world's id or null for a new one, "title", "tone", "style": the style line every picture carries (medium, lens, light, palette words), "negative", "palette": ["#rrggbb"...], "canon": ["rules nothing may break"]},
 "characters": [{"key": "c1", "id": an existing character's id or null, "name", "description": 50 to 80 words of how they look (face, build, hair, clothes, colors), written once and pasted unchanged into every shot, "voice": a voice id or null, "role": "who they are in the story"}],
 "places": [{"key": "p1", "id": null, "name", "description": "how it looks: light, weather, era, colors"}],
 "beats": [{"key": "b1", "text": "what happens"}], "script": [{"beat": "b1", "text": "screenplay lines for that beat"}],
 "shots": [{"key": "s1", "beat": "b1", "place": "p1", "cast": ["c1"], "type": "establishing"|"action"|"dialogue"|"two-people"|"insert", "seconds": 2 to 8, "angle": degrees around the action line (-90..90 is one side, keep it while two people share a scene), "framing": "wide"|"medium"|"close", "move": "static"|"push-in"|"pull-out"|"pan"|"orbit"|"follow"|"crane-up", "action": "what we see, as a motion description: who moves, how, where", "lines": [{"who": "c1", "text": "...", "direction": "how it's said"}]}],
 "music": {"brief": "what the score is: mood, instruments, tempo, where it lifts"} | null}`;

export function plannerPrompt(c: PlanContext) {
  const convo = c.conversation.slice(-10).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${String(m.text).slice(0, 3000)}`).join('\n\n');
  const system = `You are the showrunner of Hawkes Gen: the person describes a production and you plan it top down, the way a writers' room and a director would: the world (only when there isn't one), the characters, the places, then the story as a logline, beats, a short script and a shot list. Everything you write is cheap text the person approves before anything is filmed, so make it complete and specific.

Rules: write each character's description once, concretely (it is pasted unchanged into every shot that shows them); reuse the person's existing characters by id when they fit; cover dialogue like an editor cuts it (establishing, then two-shots, over-the-shoulders, close-ups) and keep the camera on one side of two people's line (the 180° rule); every line is said by someone in that shot; shots are 2 to 8 seconds and add up to the length asked for; lines fit their shot (about 2.6 words a second); keep the world's canon; a trailer is beats of images and a few lines, not a whole story. Short shot lists are better than long ones: about one shot per 4 seconds.

${PLAN_DOC}

Answer with JSON only: {"say": "one or two sentences to the person about the plan", "plan": { ... }}.`;
  const prompt = `${c.world ? `The person's world (everything must fit it; leave "world" null):\n${JSON.stringify({ id: c.world.worldId, title: c.world.title, look: c.world.look, canon: c.world.canon, characters: c.world.characters.map((x) => ({ id: x.id, name: x.title, description: x.description })), places: c.world.places.map((x) => ({ id: x.id, name: x.title, description: x.description })) })}\n\n` : 'There is no world yet: plan one (the "world" object) unless the request is only a character.\n\n'}The person's characters (reuse by id when they fit):\n${JSON.stringify(c.characters.slice(0, 20))}\n\nVoices:\n${JSON.stringify(c.voices.slice(0, 30).map((v) => ({ id: v.id, name: v.name, about: v.about })))}\n\n${c.memory ? `What you know about this person's taste (follow it unless they ask otherwise):\n${c.memory}\n\n` : ''}What they asked for: a ${c.kind}${c.seconds ? ` of ${c.seconds} seconds` : ''}.\n\n${c.previous ? `The plan on their card now (change what they ask, keep the rest and its keys):\n${JSON.stringify(c.previous)}\n\n` : ''}The conversation (the last line is what to do now):\n${convo}`;
  return { system, prompt, maxTokens: 16000, effort: 'high' as const };
}

export function critiquePrompt(plan: Plan, issues: Issue[], world: WorldContext | null) {
  const system = `You are the script supervisor and editor reviewing a production plan before anything is filmed. Check: the 180° rule between shots that share two people; continuity (who is where, what they wear and hold, time of day, from shot to shot); pacing (shots 2 to 8 s, lines fit their shots, the whole matches its length, a clear rise); the world's canon; each character's description is concrete enough to draw the same person every time. Fix everything you find in the plan itself, keeping keys. If it is already good, return it unchanged with ok true.

${PLAN_DOC}

Answer with JSON only: {"ok": true|false, "issues": ["what you found, one line each"], "plan": { the plan, fixed }}.`;
  const prompt = `${world ? `The world's canon (nothing may break it): ${JSON.stringify(world.canon)}\nIts look: ${JSON.stringify(world.look)}\n\n` : ''}What a program already found:\n${issues.length ? issues.map((x) => `- ${x.text}`).join('\n') : '- nothing'}\n\nThe plan:\n${JSON.stringify(plan)}`;
  return { system, prompt, maxTokens: 16000, effort: 'high' as const };
}

/** A plan as words for the card: the layers, top down. */
export function planOutline(plan: Plan) {
  return {
    title: plan.title, logline: plan.logline, seconds: plan.seconds,
    world: plan.world ? { title: plan.world.title, tone: plan.world.tone, isNew: !plan.world.id } : null,
    characters: plan.characters.map((c) => ({ name: c.name, role: c.role, isNew: !c.id })),
    places: plan.places.map((x) => ({ name: x.name, isNew: !x.id })),
    beats: plan.beats.map((b) => b.text),
    shots: plan.shots.map((s) => ({ key: s.key, seconds: s.seconds, type: s.type, action: s.action.slice(0, 160), lines: s.lines.length })),
  };
}
