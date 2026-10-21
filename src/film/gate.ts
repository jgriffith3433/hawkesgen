// The director gate (docs/film-pipeline.md): before any ComfyUI or Cycles spend, a shot is rendered as four cheap eevee
// frames (t = 0, 33, 66, 100%), tiled into one contact sheet and shown to Claude Vision against a strict rubric:
//
//   - the prop is visibly gripped
//   - nobody occludes the speaker's face
//   - characters face who they interact with
//   - the character really travelled instead of moonwalking
//
// If it fails, the shot is adjusted (coordinates and angles only, through the bounded fixes in shot.ts) and checked
// again, at most twice more. The loop here has no I/O of its own: the tool hands it a `render` and a `judge`, so the
// tests drive it with fakes.

import { applyFixes, autoFixes, facingAt, FIX_SCHEMA_FIELDS, lintShot, planShot, positionAt, unwrap, type Fix, type Plan, type Shot } from './shot.ts';

export const STILL_SHARES = [0, 0.33, 0.66, 1];

export type Placed = { index: number; x: number; y: number; facing: number; height?: number };
export type MeshOverlap = { a: number; b: number; faces?: number } | [number, number];
export type StillInfo = { t: number; frame?: number; file?: string; characters: Placed[]; overlaps?: MeshOverlap[] };
export type SlideInfo = { index: number; segments?: { animation: string; ground: number; playback: number; slide?: number; note?: string }[] };
export type RenderOut = { sheet: string; stills: StillInfo[]; characters?: SlideInfo[]; job?: string };

export type Check = { id: string; question: string };
export type Finding = { id: string; pass: boolean; note: string; by: 'numbers' | 'claude' | 'lint' };
export type Verdict = { pass: boolean; checks: { id: string; pass: boolean; note: string }[]; fixes: Fix[]; summary: string };

export type Intent = {
  /** Pairs [a, b]: a must face b. */
  faces?: number[][];
  /** Extra things Claude should look for, in plain words. */
  notes?: string;
};

/** What to ask of this shot: only the checks that apply (a shot with no prop has no grip check). */
export function rubric(shot: Shot, plan: Plan, intent: Intent = {}): Check[] {
  const checks: Check[] = [];
  const chars = shot.characters ?? [];
  chars.forEach((c, ci) => {
    for (const [k, a] of (c.attachments ?? []).entries()) {
      const what = a.prop != null ? `prop ${a.prop}` : `file ${a.file}`;
      checks.push({
        id: `grip:${ci}:${k}`,
        question: `Character ${ci} visibly grips the ${what} in its ${a.bone ?? 'right hand'}: the hand closes on the grip, the prop is not floating beside the hand, clipping through the body, or pointing the wrong way for how it is used. (If the prop is not on screen in a frame, judge the frames where it is.)`,
      });
    }
  });
  if (typeof shot.speaker === 'number') {
    checks.push({ id: 'face-clear', question: `Nobody and nothing occludes the face of character ${shot.speaker} (the speaker) in any frame where they are on screen: no other character's head, shoulder or prop crosses it.` });
  }
  const pairs = new Map<string, number[]>();
  chars.forEach((c, ci) => {
    for (const b of c.beats ?? []) if (typeof b.lookAt === 'number') pairs.set(`${ci}:${b.lookAt}`, [ci, b.lookAt]);
  });
  for (const p of intent.faces ?? []) if (p.length === 2) pairs.set(`${p[0]}:${p[1]}`, [p[0], p[1]]);
  for (const [id, [a, b]] of pairs) {
    checks.push({ id: `faces:${id}`, question: `Character ${a} faces character ${b}: head and torso turned toward them in the last two frames, as people do when they interact (not looking past them or away).` });
  }
  plan.timelines.forEach((tl, ci) => {
    if (tl.segments.some((s) => s.ground > 0.15)) {
      checks.push({
        id: `travel:${ci}`,
        question: `Character ${ci} really travels: it is at clearly different places across the four frames, moving the way it faces (forward), not sliding sideways or backwards, not walking on the spot and not gliding in a standing pose. The numbers below say how far it should have gone.`,
      });
    }
  });
  checks.push({ id: 'in-frame', question: 'Every character of the shot is inside the frame (not cut off by its edge) in the frames where it matters, and nothing blocks the camera.' });
  return checks;
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

/**
 * What the numbers say, from the render's own report: did each character stand where the plan put it at each still,
 * facing the way the plan turned it, and did the walk clips keep their feet on the ground (the stride-matched speed)?
 */
export function numericFindings(plan: Plan, stills: StillInfo[], seconds: number, slides: SlideInfo[] = []): Finding[] {
  const out: Finding[] = [];
  for (const tl of plan.timelines) {
    const wrong: string[] = [];
    for (const s of stills) {
      const me = s.characters.find((c) => c.index === tl.character);
      if (!me) continue;
      const t = s.t * seconds;
      const want = positionAt(tl, t);
      if (Math.hypot(me.x - want[0], me.y - want[1]) > 0.4) wrong.push(`at ${t.toFixed(1)} s it stands at (${me.x}, ${me.y}), the plan has (${want[0].toFixed(2)}, ${want[1].toFixed(2)})`);
      const wf = facingAt(tl, t);
      const d = Math.abs(unwrap(wf, me.facing) - wf);
      if (d > 20) wrong.push(`at ${t.toFixed(1)} s it faces ${me.facing}°, the plan has ${Math.round(wf)}°`);
    }
    if (tl.segments.some((g) => g.ground > 0.15) || wrong.length) {
      out.push({ id: `placed:${tl.character}`, pass: !wrong.length, note: wrong.length ? wrong.slice(0, 3).join('; ') : 'stood where the plan put it at every still', by: 'numbers' });
    }
  }
  for (const c of slides) {
    for (const g of c.segments ?? []) {
      if (g.slide != null && g.ground > 0) {
        const ok = Math.abs(g.slide - 1) <= 0.25 && !g.note?.startsWith('clamped');
        out.push({ id: `stride:${c.index}:${g.animation}`, pass: ok, note: ok ? `${g.animation} played at ${g.playback}x keeps its feet on the ground` : `${g.animation} at ${g.playback}x gives feet ${g.slide}x the ground speed${g.note ? ` (${g.note})` : ''}: the feet will slide`, by: 'numbers' });
      }
    }
  }
  const hitPairs = new Map<string, { a: number; b: number; times: string[]; faces: number }>();
  for (const s of stills) {
    for (const ov of s.overlaps ?? []) {
      const a = Array.isArray(ov) ? ov[0] : ov.a;
      const b = Array.isArray(ov) ? ov[1] : ov.b;
      const faces = Array.isArray(ov) ? 1 : (ov.faces ?? 1);
      if (typeof a === 'number' && typeof b === 'number' && faces > 0) {
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        const cur = hitPairs.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), times: [], faces: 0 };
        cur.times.push(`${(s.t * seconds).toFixed(1)} s`);
        cur.faces = Math.max(cur.faces, faces);
        hitPairs.set(key, cur);
      }
    }
  }
  for (const [key, h] of hitPairs) {
    out.push({
      id: `overlap:${key}`,
      pass: false,
      note: `characters ${h.a} and ${h.b} 3D meshes overlap (${h.faces} intersecting faces at ${h.times.join(', ')})`,
      by: 'numbers',
    });
  }
  return out;
}

export const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'checks', 'fixes', 'summary'],
  properties: {
    pass: { type: 'boolean', description: 'true only if every check passes' },
    checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'pass', 'note'],
        properties: { id: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string', description: 'one sentence of evidence: what you see in which frame' } },
      },
    },
    fixes: {
      type: 'array', description: 'The smallest changes that would fix the failures (at most 4). Empty when everything passes.',
      items: {
        type: 'object', additionalProperties: false, required: ['target', 'index', 'attachment', 'field', 'values', 'reason'],
        properties: {
          target: { type: 'string', enum: ['character', 'camera', 'attachment', 'prop'] },
          index: { type: 'integer', description: 'character or prop index; -1 for the camera' },
          attachment: { type: 'integer', description: 'attachment index within the character (target attachment); -1 otherwise' },
          field: { type: 'string' },
          values: { type: 'array', items: { type: 'number' } },
          reason: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', description: 'two sentences: what is wrong and what you changed' },
  },
};

export const GATE_SYSTEM =
  'You are the director of photography gating a 3D previs shot before the studio spends GPU money repainting it. You see a contact sheet of four frames ' +
  'of a Blender preview (plain grey shading is fine; judge staging, not looks). Be strict: a check passes only if you can see it is true. ' +
  'When something fails, propose the smallest changes (coordinates and angles only) from the allowed list; never invent fields.';

/** The prompt for the judge: the coordinates, the shot, what the numbers say, the checks and the allowed fixes. */
export function gatePrompt(shot: Shot, plan: Plan, checks: Check[], findings: Finding[], stills: StillInfo[], seconds: number, intent: Intent = {}) {
  const { characters, camera, props, speaker } = shot;
  const summary = {
    seconds, speaker, camera,
    characters: (characters ?? []).map((c, i) => ({
      index: i, height: c.height, position: c.position, facing: c.facing, beats: c.beats, attachments: c.attachments,
      plan: plan.timelines[i].segments.map((s) => ({ from: [s.t0, s.t1].map((x) => +x.toFixed(2)), clip: s.animation, at: [s.from, s.to].map((p) => p.map((x) => +x.toFixed(2))), faces: [s.faceFrom, s.faceTo].map((x) => Math.round(x)) })),
    })),
    props: (props ?? []).map((p, i) => ({ index: i, ...p })),
  };
  const where = stills.map((s) => `t=${(s.t * 100).toFixed(0)}%: ${s.characters.map((c) => `character ${c.index} at (${c.x}, ${c.y}) facing ${c.facing}°`).join('; ')}`).join('\n');
  const fixes = Object.entries(FIX_SCHEMA_FIELDS).map(([t, f]) => `${t}: ${f.join(', ')}`).join('\n');
  return `The four frames are tiled in one image: top-left t=0, top-right 33%, bottom-left 66%, bottom-right 100% of the ${seconds.toFixed(1)} s shot.

Coordinates: meters on the ground, x to the right, y away from the default camera. Facing is in degrees: 0 faces the default camera, 90 faces +x, -90 faces -x, 180 faces away. The shot's camera: angle is degrees around its target (0 = in front of the target character, turning counter-clockwise seen from above), distance and height in meters, lens in mm.

The shot:
${JSON.stringify(summary)}

Where the preview put everyone at each frame (measured in Blender):
${where}

What the numbers already say:
${findings.map((f) => `- ${f.id}: ${f.pass ? 'ok' : 'FAILED'}: ${f.note}`).join('\n') || '- (nothing)'}
${intent.notes ? `\nThe director's notes: ${intent.notes}\n` : ''}
Checks (answer every one by its id):
${checks.map((c) => `- ${c.id}: ${c.question}`).join('\n')}

Allowed fixes (target: fields; scalars take one number, position/offset/rotation/grip take as many as the field name implies: position 2 (x, y) for characters, 3 for props; offset, rotation and grip 3):
${fixes}
Use index -1 for the camera and attachment -1 unless the target is an attachment. If everything passes, return no fixes.`;
}

export type GateOptions = {
  shot: Shot;
  seconds: number;
  intent?: Intent;
  /** Adjust-and-check rounds after the first look (default 2). */
  maxTries?: number;
  nFiles: number;
  render(shot: Shot, attempt: number): Promise<RenderOut>;
  judge(input: { prompt: string; sheet: string; checks: Check[] }): Promise<Verdict>;
  log?(line: string): void;
};

export type GateResult = {
  pass: boolean;
  shot: Shot;
  tries: number;
  rounds: { attempt: number; sheet: string; job?: string; findings: Finding[]; summary: string; applied: string[] }[];
  summary: string;
};

/** Claude's fixes, cleaned: -1 means "not applicable"; a fix that can't apply is dropped (and logged) rather than crashing the gate. */
export function cleanFixes(shot: Shot, raw: any[], log: (l: string) => void = () => {}): { shot: Shot; applied: string[] } {
  let cur = shot;
  const applied: string[] = [];
  for (const f of (raw ?? []).slice(0, 6)) {
    const fix: Fix = { target: f.target, field: f.field, values: f.values, reason: f.reason };
    if (typeof f.index === 'number' && f.index >= 0) fix.index = f.index;
    if (typeof f.attachment === 'number' && f.attachment >= 0) fix.attachment = f.attachment;
    try {
      const r = applyFixes(cur, [fix]);
      cur = r.shot;
      applied.push(...r.applied);
    } catch (e: any) {
      log(`skipped a fix (${e.message})`);
    }
  }
  return { shot: cur, applied };
}

/**
 * The loop. Lint first (and the no-judgment fixes it allows), then render the contact sheet and judge it; on failure
 * apply Claude's fixes and look again, up to `maxTries` times.
 */
export async function runGate(o: GateOptions): Promise<GateResult> {
  const log = o.log ?? (() => {});
  const maxTries = o.maxTries ?? 2;
  let shot: Shot = JSON.parse(JSON.stringify(o.shot));
  const rounds: GateResult['rounds'] = [];
  const pre = autoFixes(shot, o.seconds);
  if (pre.length) {
    const r = applyFixes(shot, pre);
    shot = r.shot;
    rounds.push({ attempt: -1, sheet: '', findings: [], summary: 'fixed before the first look', applied: r.applied });
    log(`before rendering: ${r.applied.join('; ')}`);
  }
  let verdictPass = false;
  for (let attempt = 0; attempt <= maxTries; attempt++) {
    const { issues, plan } = lintShot(shot, o.seconds, o.nFiles);
    const bad = issues.filter((i) => i.level === 'error' && i.check !== 'occlusion');
    if (bad.length || !plan) {
      // A structural error is the caller's to fix; the render would only fail.
      return { pass: false, shot, tries: attempt, rounds, summary: `The shot can't be built: ${bad.map((b) => b.message).join('; ')}` };
    }
    const rendered = await o.render(shot, attempt);
    const checks = rubric(shot, plan, o.intent);
    const findings: Finding[] = [
      ...issues.filter((i) => i.check === 'occlusion').map((i) => ({ id: 'face-clear', pass: false, note: i.message, by: 'lint' as const })),
      ...numericFindings(plan, rendered.stills, o.seconds, rendered.characters),
    ];
    const prompt = gatePrompt(shot, plan, checks, findings, rendered.stills, o.seconds, o.intent);
    const v = await o.judge({ prompt, sheet: rendered.sheet, checks });
    for (const c of v.checks) findings.push({ id: c.id, pass: c.pass, note: c.note, by: 'claude' });
    const missing = checks.filter((c) => !v.checks.some((x) => x.id === c.id));
    for (const m of missing) findings.push({ id: m.id, pass: false, note: 'Claude did not answer this check', by: 'claude' });
    // Pass only if every check and every number holds: Claude's overall `pass` can't override a failing finding.
    verdictPass = v.pass && findings.every((f) => f.pass);
    const round = { attempt, sheet: rendered.sheet, job: rendered.job, findings, summary: v.summary, applied: [] as string[] };
    rounds.push(round);
    log(`look ${attempt + 1}: ${verdictPass ? 'passed' : `failed ${findings.filter((f) => !f.pass).map((f) => f.id).join(', ')}`}`);
    if (verdictPass) return { pass: true, shot, tries: attempt, rounds, summary: v.summary };
    if (attempt === maxTries) break;
    // Adjust: what no judgment is needed for (the camera away from whoever hides the speaker), then Claude's fixes.
    const auto = autoFixes(shot, o.seconds);
    let next = shot;
    if (auto.length) {
      const r = applyFixes(next, auto);
      next = r.shot;
      round.applied.push(...r.applied);
    }
    const r2 = cleanFixes(next, v.fixes, log);
    next = r2.shot;
    round.applied.push(...r2.applied);
    if (!round.applied.length) {
      log('nothing to adjust; stopping');
      break;
    }
    // Re-plan the shot (and check the adjustments didn't break the beats) before spending another render.
    try {
      planShot(next, o.seconds);
    } catch (e: any) {
      log(`the adjusted shot doesn't plan (${e.message}); keeping the last one`);
      break;
    }
    shot = next;
  }
  const last = rounds[rounds.length - 1];
  const failed = last.findings.filter((f) => !f.pass);
  return {
    pass: false, shot, tries: rounds.filter((r) => r.attempt >= 0).length - 1, rounds,
    summary: `${last.summary} Still failing: ${failed.map((f) => `${f.id} (${f.note})`).join('; ') || 'the judge did not pass it'}.`,
  };
}
