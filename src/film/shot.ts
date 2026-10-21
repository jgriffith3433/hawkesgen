// The film pipeline's shot planner (docs/film-pipeline.md): pure functions, no I/O, so the tests check them directly.
//
// A shot (blender.render's `shot`) may give each character `beats`: a list of actions in order ("walk to the door,
// turn to him, draw the gun"). planShot() turns them into a resolved `timeline` the Blender script plays (where the
// character is, which way it faces, which clip plays and how fast, per segment), keeps characters from walking
// through each other, and lintShot() checks what can be checked without rendering (a prop attached to a bone, a
// character facing who it talks to, nobody standing between the camera and the speaker's face).
//
// Conventions match post/blender/hawkes_blender.py: positions are meters on the ground [x, y]; `facing` is degrees,
// 0 faces the default camera (a character faces -Y at 0), so the direction of a facing is (sin f, -cos f).

import { GenError } from '../util.ts';

export type Vec2 = [number, number];
export type Look = number | 'camera' | number[]; // a character index, "camera", or a point [x, y] / [x, y, z]

export type Beat = {
  /** Seconds from the start of the shot. Default: right after the previous beat. */
  at?: number;
  /** How long it lasts. With `to` and no `seconds`, the distance divided by `pace`. */
  seconds?: number;
  animation?: string;
  animationFile?: number;
  /** Walk (or run) here, [x, y] on the ground. */
  to?: number[];
  /** Ground speed in m/s for a move (default by the clip's name). */
  pace?: number;
  /** Fixed playback speed of the clip. Without it, moves match the clip's stride to the ground speed. */
  speed?: number;
  /** Turn to face a character (index), "camera", or a point once the move (if any) ends, and track it with head/spine. */
  lookAt?: Look;
  /** Aim a held weapon/flashlight at a character (index), "camera", or a point [x, y, z]. */
  aimAt?: Look;
  /** Peak height in meters for a parabolic jump arc (z(t) = v0*t - 0.5*9.81*t^2) during this beat. */
  jumpHeight?: number;
  /** Face this many degrees (absolute) once the move ends. */
  facing?: number;
  /** Seconds the turn takes (default 0.35). */
  turn?: number;
  /** Face the lookAt while moving too (strafe, back-pedal) instead of the direction of travel. */
  strafe?: boolean;
  loop?: boolean;
};

export type Attachment = {
  /** A prop of the shot, by index. */
  prop?: number;
  /** Or a model file of the job, by index (imported for the hand). */
  file?: number;
  /** Which bone: "right hand", "left hand", "head", "hips", "spine", or the rig's own bone name. */
  bone?: string;
  /** Where in the prop its grip is, as shares of its box [x, y, z] (default the middle). */
  grip?: number[];
  /** Meters in the bone's frame. */
  offset?: number[];
  /** Degrees, in the bone's frame. */
  rotation?: number[];
  /** Curl finger bones around the grip when attached to a hand (default true). */
  gripCurl?: boolean;
  /** Aim the holding hand/forearm bone toward a target (character index, "camera", or [x, y, z]). */
  aimAt?: Look;
  size?: number;
  scale?: number;
};

export type ShotCharacter = {
  file: number;
  animation?: string;
  animationFile?: number;
  height?: number;
  position?: number[];
  facing?: number;
  travel?: number;
  lookAt?: Look;
  aimAt?: Look;
  beats?: Beat[];
  attachments?: Attachment[];
  [k: string]: unknown;
};

export type Shot = {
  characters?: ShotCharacter[];
  props?: Record<string, unknown>[];
  camera?: Record<string, any>;
  /** Who is talking in this shot (a character index): the gate checks nothing hides their face. */
  speaker?: number;
  ground?: unknown;
  background?: unknown;
  walls?: unknown;
  vfx?: unknown;
  lights?: unknown;
  [k: string]: unknown;
};

/** What decides which way a segment faces: where it goes, a target, a fixed heading, or whatever it already faced. */
export type Face = { mode: 'hold' | 'travel' | 'target' | 'fixed'; look?: Look; deg?: number };

/** One stretch of the timeline for one character: a clip, a place and a heading, in seconds from the shot's start. */
export type Segment = {
  t0: number;
  t1: number;
  animation?: string;
  animationFile?: number;
  loop: boolean;
  /** Where it stands at t0 and at t1. */
  from: Vec2;
  to: Vec2;
  /** Meters per second over the ground (0 when standing). */
  ground: number;
  /** A fixed playback speed, else the script matches the clip's stride to `ground`. */
  speed: number | null;
  /** Heading at t0 and the one it turns to within `turn` seconds (degrees, unwrapped so a turn is a subtraction). */
  faceFrom: number;
  faceTo: number;
  turn: number;
  face: Face;
  lookAt?: Look;
  aimAt?: Look;
  jumpHeight?: number;
};

export type Timeline = { character: number; radius: number; height: number; segments: Segment[] };
export type Plan = { timelines: Timeline[]; notes: string[]; moved: string[] };

const R = Math.PI / 180;
export const dirOf = (facingDeg: number): Vec2 => [Math.sin(facingDeg * R), -Math.cos(facingDeg * R)];
export const facingToward = (dx: number, dy: number) => Math.atan2(dx, -dy) / R;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** `b` as the angle equal to it mod 360 that is closest to `a`. */
export const unwrap = (a: number, b: number) => {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d;
};

/** A character's footprint radius on the ground (for keeping them apart). */
export const radiusOf = (height: number) => Math.max(0.35, 0.24 * height);

/** Ground speed by what the clip is called, for a character 1.75 m tall (scaled with height). */
export function defaultPace(animation: string | undefined, height: number) {
  const n = (animation ?? '').toLowerCase();
  const k = height / 1.75;
  if (/sprint/.test(n)) return 6.5 * k;
  if (/run|jog|chase/.test(n)) return 4.2 * k;
  if (/creep|sneak|crouch|stealth/.test(n)) return 0.9 * k;
  return 1.4 * k;
}

/** Clip names that step (so standing still in one is walking on the spot) and ones that don't (so travelling in one is sliding). */
export const isLocomotion = (name?: string) => /walk|run|jog|sprint|sneak|creep|chase|strut|march|limp/i.test(name ?? '');
export const isStanding = (name?: string) => /idle|stand|sit|talk|wave|point|shoot|aim|fire|reload|cheer|react|breath/i.test(name ?? '');

function checkPoint(v: unknown, where: string): Vec2 {
  if (!Array.isArray(v) || v.length < 2 || !v.slice(0, 2).every((x) => typeof x === 'number' && Number.isFinite(x))) throw new GenError(`${where}: give [x, y] in meters`);
  return [v[0], v[1]];
}

/** Position of a character at a time, from its segments (holds the end). */
export function positionAt(tl: Timeline, t: number): Vec2 {
  const s = tl.segments;
  if (!s.length) return [0, 0];
  if (t <= s[0].t0) return s[0].from;
  for (const g of s) {
    if (t <= g.t1) {
      const k = g.t1 > g.t0 ? Math.min(1, Math.max(0, (t - g.t0) / (g.t1 - g.t0))) : 1;
      return [g.from[0] + (g.to[0] - g.from[0]) * k, g.from[1] + (g.to[1] - g.from[1]) * k];
    }
  }
  return s[s.length - 1].to;
}

/** The heading at a time (degrees, unwrapped as in the segments). */
export function facingAt(tl: Timeline, t: number): number {
  const s = tl.segments;
  if (!s.length) return 0;
  if (t <= s[0].t0) return s[0].faceFrom;
  for (const g of s) {
    if (t <= g.t1) {
      const k = g.turn > 0 ? Math.min(1, Math.max(0, (t - g.t0) / g.turn)) : 1;
      const e = k * k * (3 - 2 * k);
      return g.faceFrom + (g.faceTo - g.faceFrom) * e;
    }
  }
  return s[s.length - 1].faceTo;
}

/**
 * Works out which way every segment faces, in order: the way it travels, at its target (where that character
 * stands as the turn ends), a fixed heading, or the way it already faced. Run again after anything moves.
 */
export function resolveFacing(plan: Plan, startFacing: number[], seconds: number, shot?: Shot) {
  for (const tl of plan.timelines) {
    let h = startFacing[tl.character] ?? 0;
    for (const g of tl.segments) {
      g.faceFrom = h;
      const f = g.face;
      if (f.mode === 'travel' && g.ground > 0 && dist(g.from, g.to) > 1e-6) h = unwrap(h, facingToward(g.to[0] - g.from[0], g.to[1] - g.from[1]));
      else if (f.mode === 'fixed') h = unwrap(h, f.deg ?? h);
      else if (f.mode === 'target' && f.look != null) {
        const at = Math.min(seconds, g.t0 + g.turn);
        let tgt: Vec2;
        if (f.look === 'camera') {
          const cam = cameraAt(shot ?? {}, plan, at, seconds);
          tgt = [cam.pos[0], cam.pos[1]];
        } else if (typeof f.look === 'number') {
          tgt = positionAt(plan.timelines[f.look], at);
        } else {
          tgt = checkPoint(f.look, `characters[${tl.character}] lookAt`);
        }
        const here = positionAt(tl, at);
        if (dist(here, tgt) > 1e-6) h = unwrap(h, facingToward(tgt[0] - here[0], tgt[1] - here[1]));
      }
      g.faceTo = h;
    }
  }
}

/**
 * Resolves every character's beats into a timeline. Without beats a character gets one segment (standing, or the
 * old `travel` walk), so every character has a timeline the gate and the lint can read. Throws GenError for a beat
 * that can't be played (bad fields); everything softer goes into `notes`.
 */
export function planShot(shot: Shot, seconds: number): Plan {
  const chars = shot.characters ?? [];
  const plan: Plan = { timelines: [], notes: [], moved: [] };
  const starts: number[] = [];
  chars.forEach((c, ci) => {
    const height = typeof c.height === 'number' && c.height > 0 ? c.height : 1.75;
    let pos: Vec2 = c.position ? checkPoint(c.position, `characters[${ci}].position`) : [0, 0];
    const face0 = typeof c.facing === 'number' ? c.facing : 0;
    starts.push(face0);
    const tl: Timeline = { character: ci, radius: radiusOf(height), height, segments: [] };
    plan.timelines.push(tl);
    const base = { loop: true, speed: null as number | null, turn: 0, faceFrom: face0, faceTo: face0 };
    if (!c.beats?.length) {
      const trav = Number(c.travel) || 0;
      const to: Vec2 = trav ? [pos[0] + dirOf(face0)[0] * trav * seconds, pos[1] + dirOf(face0)[1] * trav * seconds] : pos;
      tl.segments.push({
        ...base, t0: 0, t1: seconds, animation: c.animation, animationFile: c.animationFile, from: pos, to, ground: trav, face: { mode: 'hold' },
        ...(c.lookAt != null ? { lookAt: c.lookAt } : {}),
        ...(c.aimAt != null ? { aimAt: c.aimAt } : {}),
      });
      return;
    }
    if (!Array.isArray(c.beats)) throw new GenError(`characters[${ci}].beats must be a list`);
    let t = 0;
    let clip: string | undefined = c.animation;
    let clipFile: number | undefined = c.animationFile;
    for (const [bi, beat] of c.beats.entries()) {
      const where = `characters[${ci}].beats[${bi}]`;
      if (beat.at != null) {
        if (!(beat.at >= 0)) throw new GenError(`${where}: at is seconds from the start (0 or more)`);
        if (bi === 0) plan.notes.push(`${where}: the first beat starts at 0; at=${beat.at} is ignored`);
        else if (beat.at < t - 1e-6) throw new GenError(`${where}: at=${beat.at} is before the previous beat ends (${r3(t)} s)`);
        else if (beat.at > t + 1e-6) {
          // A gap: the previous clip carries on, standing.
          const prev = tl.segments[tl.segments.length - 1];
          tl.segments.push({ ...prev, jumpHeight: undefined, t0: t, t1: beat.at, from: pos, to: pos, ground: 0, turn: 0, face: { mode: 'hold' } });
          t = beat.at;
        }
      }
      if (beat.animation != null || beat.animationFile != null) {
        clip = beat.animation;
        clipFile = beat.animationFile;
      }
      let to = pos;
      let ground = 0;
      let dur = beat.seconds;
      if (beat.to != null) {
        to = checkPoint(beat.to, `${where}.to`);
        const d = dist(pos, to);
        if (d > 1e-6) {
          if (beat.pace != null && !(beat.pace > 0)) throw new GenError(`${where}: pace is meters per second (above 0)`);
          dur ??= d / (beat.pace ?? defaultPace(clip, tl.height));
          if (!(dur > 0)) throw new GenError(`${where}: seconds must be above 0`);
          ground = d / dur;
        }
      }
      if (dur == null) throw new GenError(`${where}: give seconds (or a move with to)`);
      if (!(dur > 0)) throw new GenError(`${where}: seconds must be above 0`);
      if (beat.lookAt != null && beat.lookAt !== 'camera' && typeof beat.lookAt === 'number' && (!Number.isInteger(beat.lookAt) || beat.lookAt < 0 || beat.lookAt >= chars.length || beat.lookAt === ci)) {
        throw new GenError(`${where}: lookAt ${beat.lookAt} is not another character of the shot`);
      }
      const turn = Math.min(beat.turn ?? 0.35, dur);
      let face: Face = { mode: 'hold' };
      if (ground > 0) {
        if (beat.strafe && beat.lookAt != null) face = { mode: 'target', look: beat.lookAt };
        else {
          face = { mode: 'travel' };
          if (beat.lookAt != null) plan.notes.push(`${where}: it faces where it goes while it moves; add a standing beat with lookAt to turn to the target (or strafe: true to face it while moving)`);
        }
      } else if (beat.lookAt != null) face = { mode: 'target', look: beat.lookAt };
      else if (beat.facing != null) face = { mode: 'fixed', deg: beat.facing };
      const lookAtVal = beat.lookAt ?? c.lookAt;
      const aimAtVal = beat.aimAt ?? c.aimAt;
      tl.segments.push({
        ...base, t0: t, t1: t + dur, animation: clip, animationFile: clipFile, loop: beat.loop !== false, from: pos, to, ground,
        speed: beat.speed != null ? Number(beat.speed) : null, turn: face.mode === 'travel' ? Math.min(0.3, dur) : turn, face,
        ...(lookAtVal != null ? { lookAt: lookAtVal } : {}),
        ...(aimAtVal != null ? { aimAt: aimAtVal } : {}),
        ...(beat.jumpHeight != null && beat.jumpHeight > 0 ? { jumpHeight: Number(beat.jumpHeight) } : {}),
      });
      t += dur;
      pos = to;
    }
    if (t < seconds - 1e-6) {
      // The last clip carries on to the end of the shot, standing.
      const last = tl.segments[tl.segments.length - 1];
      tl.segments.push({ ...last, jumpHeight: undefined, t0: t, t1: seconds, from: pos, to: pos, ground: 0, turn: 0, face: { mode: 'hold' } });
    } else if (t > seconds + 0.05) {
      plan.notes.push(`characters[${ci}]: its beats run ${r3(t)} s but the shot is ${r3(seconds)} s (the rest is cut off)`);
    }
  });
  resolveFacing(plan, starts, seconds, shot);
  avoidOverlap(plan, seconds);
  resolveFacing(plan, starts, seconds, shot);
  return plan;
}

/** The first moment two characters' footprints overlap, or null. */
export function firstOverlap(timelines: Timeline[], seconds: number, step = 0.05) {
  for (let t = 0; t <= seconds + 1e-9; t += step) {
    for (let a = 0; a < timelines.length; a++) {
      for (let b = a + 1; b < timelines.length; b++) {
        const d = dist(positionAt(timelines[a], t), positionAt(timelines[b], t));
        if (d < timelines[a].radius + timelines[b].radius) return { t, a, b, d };
      }
    }
  }
  return null;
}

/**
 * Keeps characters apart: where a moving character's path would take it through another (or end inside it), a
 * waypoint swings it around, or the move stops short. Mutates the plan's segments; says what it did in `moved`.
 */
export function avoidOverlap(plan: Plan, seconds: number) {
  const tls = plan.timelines;
  for (let round = 0; round < 12; round++) {
    const hit = firstOverlap(tls, seconds);
    if (!hit) return;
    // Who gives way: the one moving at that moment (the later index if both move).
    const movingSeg = (i: number) => tls[i].segments.findIndex((s) => hit.t >= s.t0 && hit.t <= s.t1 && s.ground > 0);
    const mover = movingSeg(hit.b) >= 0 ? hit.b : movingSeg(hit.a) >= 0 ? hit.a : null;
    if (mover == null) {
      const PA = positionAt(tls[hit.a], hit.t);
      const PB = positionAt(tls[hit.b], hit.t);
      const minClear = tls[hit.a].radius + tls[hit.b].radius;
      const clear = minClear + 0.05;
      const dx = PB[0] - PA[0];
      const dy = PB[1] - PA[1];
      const ux = hit.d > 1e-6 ? dx / hit.d : 1;
      const uy = hit.d > 1e-6 ? dy / hit.d : 0;
      const PNew: Vec2 = [PA[0] + ux * clear, PA[1] + uy * clear];
      const tlB = tls[hit.b];
      for (let k = 0; k < tlB.segments.length; k++) {
        const s = tlB.segments[k];
        const sameFrom = Math.abs(s.from[0] - PB[0]) < 1e-5 && Math.abs(s.from[1] - PB[1]) < 1e-5;
        const sameTo = Math.abs(s.to[0] - PB[0]) < 1e-5 && Math.abs(s.to[1] - PB[1]) < 1e-5;
        if (!sameFrom && k > 0) break;
        if (sameFrom || k === 0) s.from = PNew;
        if (sameTo) {
          s.to = PNew;
        } else {
          const d = dist(s.from, s.to);
          s.ground = s.t1 > s.t0 ? d / (s.t1 - s.t0) : 0;
          break;
        }
      }
      const msg = `character ${hit.b} pushed to (${r3(PNew[0])}, ${r3(PNew[1])}) to clear character ${hit.a}`;
      plan.moved.push(msg);
      plan.notes.push(`characters ${hit.a} and ${hit.b} stand ${r3(hit.d)} m apart, closer than their size allows (${r3(minClear)} m): ${msg}`);
      continue;
    }
    const other = mover === hit.b ? hit.a : hit.b;
    const tl = tls[mover];
    const idx = movingSeg(mover);
    const seg = tl.segments[idx];
    const clear = tl.radius + tls[other].radius + 0.15;
    const P = positionAt(tls[other], hit.t);
    const A = seg.from;
    const B = seg.to;
    const len = dist(A, B);
    const u: Vec2 = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const along = (P[0] - A[0]) * u[0] + (P[1] - A[1]) * u[1];
    const side = (P[0] - A[0]) * -u[1] + (P[1] - A[1]) * u[0]; // above 0: P is to the left of the path
    if (dist(B, P) < clear && along >= len - clear) {
      // It ends in the other: stop short, in front of it.
      const stop = Math.max(0, along - clear);
      seg.to = [A[0] + u[0] * stop, A[1] + u[1] * stop];
      seg.ground = stop > 1e-6 ? stop / (seg.t1 - seg.t0) : 0;
      plan.moved.push(`character ${mover} stops ${r3(clear)} m short of character ${other}`);
      for (let k = idx + 1; k < tl.segments.length; k++) {
        // What follows starts where it really ended.
        if (tl.segments[k].from === B || (tl.segments[k].from[0] === B[0] && tl.segments[k].from[1] === B[1])) tl.segments[k].from = seg.to;
        if (tl.segments[k].to === B || (tl.segments[k].to[0] === B[0] && tl.segments[k].to[1] === B[1])) tl.segments[k].to = seg.to;
        else break;
      }
    } else {
      // It passes through: swing around on the far side.
      const n: Vec2 = side >= 0 ? [u[1], -u[0]] : [-u[1], u[0]]; // away from P
      const W: Vec2 = [P[0] + n[0] * clear * 1.15, P[1] + n[1] * clear * 1.15];
      const d1 = dist(A, W);
      const d2 = dist(W, B);
      const tm = seg.t0 + ((seg.t1 - seg.t0) * d1) / (d1 + d2);
      const second: Segment = { ...seg, t0: tm, from: W, ground: d2 / (seg.t1 - tm) };
      Object.assign(seg, { t1: tm, to: W, ground: d1 / (tm - seg.t0) });
      tl.segments.splice(idx + 1, 0, second);
      plan.moved.push(`character ${mover} swings around character ${other} at ${r3(hit.t)} s`);
    }
  }
  const left = firstOverlap(tls, seconds);
  if (left) plan.notes.push(`characters ${left.a} and ${left.b} still overlap at ${r3(left.t)} s: change their positions or beats`);
}

// ---------------------------------------------------------------- the camera, as the Blender script moves it

export type CamPose = { pos: [number, number, number]; aim: [number, number, number] };

/** Where the shot's camera is and what it looks at, at a time (the same moves as add_camera in hawkes_blender.py). */
export function cameraAt(shot: Shot, plan: Plan, t: number, seconds: number): CamPose {
  const cs = shot.camera ?? {};
  const tgt = cs.target ?? (plan.timelines.length ? 0 : [0, 0, 1]);
  const k = seconds > 0 ? Math.min(1, Math.max(0, t / seconds)) : 0;
  const e = k * k * (3 - 2 * k);
  const move: string = cs.move ?? 'static';
  const char = typeof tgt === 'number' ? plan.timelines[tgt] : undefined;
  let aim: [number, number, number];
  let baseFace = 0;
  let h = 1.7;
  if (char) {
    h = char.height;
    const p0 = char.segments[0]?.from ?? [0, 0];
    aim = [p0[0], p0[1], h * (cs.aimHeight ?? 0.55)];
    baseFace = char.segments[0]?.faceFrom ?? 0;
  } else {
    const a = Array.isArray(tgt) ? tgt : [0, 0, 1];
    aim = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
  }
  const dist0 = Number(cs.distance ?? Math.max(2.5, h * 2.2));
  const height = Number(cs.height ?? aim[2]);
  const angle = Number(cs.angle ?? 0);
  const amt = cs.amount;
  const at = (a: number, d: number, z: number, off: [number, number, number] = [0, 0, 0], tOff: [number, number, number] = [0, 0, 0]): CamPose => {
    const dir = dirOf(baseFace + a);
    return {
      pos: [aim[0] + dir[0] * d + off[0], aim[1] + dir[1] * d + off[1], z + off[2]],
      aim: [aim[0] + tOff[0], aim[1] + tOff[1], aim[2] + tOff[2]],
    };
  };
  const side = dirOf(baseFace + angle + 90); // the camera's right
  const lerp = (a: number, b: number) => a + (b - a) * e;
  switch (move) {
    case 'push-in': return at(angle, lerp(dist0, dist0 * (1 - Number(amt ?? 0.35))), height);
    case 'pull-out': return at(angle, lerp(dist0, dist0 * (1 + Number(amt ?? 0.5))), height);
    case 'orbit': {
      const sweep = Number(amt ?? 40);
      return at(angle - sweep / 2 + sweep * e, dist0, height);
    }
    case 'turntable': return at(angle + 360 * k, dist0, height);
    case 'pan': {
      const a = Number(amt ?? dist0 * 0.35);
      return at(angle, dist0, height, [0, 0, 0], [side[0] * a * (2 * e - 1), side[1] * a * (2 * e - 1), 0]);
    }
    case 'truck': {
      const a = Number(amt ?? 1.5) * (e - 0.5);
      return at(angle, dist0, height, [side[0] * a, side[1] * a, 0], [side[0] * a, side[1] * a, 0]);
    }
    case 'crane-up': case 'crane-down': {
      const a = Number(amt ?? 1) * (move === 'crane-up' ? 1 : -1);
      return at(angle, dist0, height - a / 2 + a * e);
    }
    case 'follow': {
      // Rides along with the character: the offset from where it stands stays the same.
      if (char) {
        const p = positionAt(char, t);
        const p0 = char.segments[0]?.from ?? [0, 0];
        const base = at(angle, dist0, height);
        return { pos: [base.pos[0] + p[0] - p0[0], base.pos[1] + p[1] - p0[1], base.pos[2]], aim: [base.aim[0] + p[0] - p0[0], base.aim[1] + p[1] - p0[1], base.aim[2]] };
      }
      return at(angle, dist0, height);
    }
    default: return at(angle, dist0, height);
  }
}

// ---------------------------------------------------------------- lint: what can be said without rendering

export type Issue = { level: 'error' | 'warn'; check: string; message: string };

/** Does anyone stand between the camera and a character's face? (Capsules for the bodies, a segment to the head.) */
export function occluders(shot: Shot, plan: Plan, seconds: number, speaker: number, samples = 12) {
  const hits = new Map<number, number>();
  const sp = plan.timelines[speaker];
  if (!sp) return [];
  for (let s = 0; s <= samples; s++) {
    const t = (seconds * s) / samples;
    const cam = cameraAt(shot, plan, t, seconds);
    const ph = positionAt(sp, t);
    const head: [number, number, number] = [ph[0], ph[1], sp.height * 0.92];
    for (const tl of plan.timelines) {
      if (tl.character === speaker) continue;
      const p = positionAt(tl, t);
      // Closest point of the camera->head segment to the body's vertical axis, in the ground plane.
      const ax = cam.pos[0], ay = cam.pos[1];
      const bx = head[0] - ax, by = head[1] - ay;
      const len2 = bx * bx + by * by;
      if (len2 < 1e-9) continue;
      let u = ((p[0] - ax) * bx + (p[1] - ay) * by) / len2;
      if (u <= 0 || u >= 1) continue;
      const cx = ax + bx * u, cy = ay + by * u;
      const dd = Math.hypot(p[0] - cx, p[1] - cy);
      const z = cam.pos[2] + (head[2] - cam.pos[2]) * u;
      if (dd < tl.radius * 1.1 && z < tl.height * 1.02) hits.set(tl.character, (hits.get(tl.character) ?? 0) + 1);
    }
  }
  return [...hits.entries()].filter(([, n]) => n >= 2).map(([c, n]) => ({ character: c, samples: n, of: samples + 1 }));
}

/** The checks that need no render. Errors are things that can't work; warnings are things the gate should look at. */
export function lintShot(shot: Shot, seconds: number, nFiles: number): { issues: Issue[]; plan: Plan | null } {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], check: string, message: string) => issues.push({ level, check, message });
  const chars = shot.characters ?? [];
  const props = shot.props ?? [];
  let plan: Plan | null = null;
  try {
    plan = planShot(shot, seconds);
  } catch (e: any) {
    add('error', 'beats', String(e.message ?? e));
  }
  const fileOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < nFiles;
  chars.forEach((c, i) => {
    if (!fileOk(c.file)) add('error', 'file', `characters[${i}].file ${JSON.stringify(c.file)} is not one of the job's ${nFiles} files`);
    for (const [k, a] of (c.attachments ?? []).entries()) {
      const where = `characters[${i}].attachments[${k}]`;
      if (a.prop == null && a.file == null) add('error', 'attachment', `${where}: name a prop (index into props) or a file`);
      else if (a.prop != null && !(Number.isInteger(a.prop) && a.prop >= 0 && a.prop < props.length)) add('error', 'attachment', `${where}: prop ${a.prop} is not one of the shot's ${props.length} props`);
      else if (a.file != null && !fileOk(a.file)) add('error', 'attachment', `${where}: file ${a.file} is not one of the job's files`);
      if (!a.bone) add('warn', 'attachment', `${where}: no bone named, so it goes to the right hand`);
      for (const f of ['grip', 'offset', 'rotation'] as const) {
        const v = a[f];
        if (v != null && !(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number'))) add('error', 'attachment', `${where}: ${f} is [x, y, z]`);
      }
    }
  });
  const used = new Map<number, number>();
  chars.forEach((c, i) => (c.attachments ?? []).forEach((a) => { if (a.prop != null) { if (used.has(a.prop)) add('warn', 'attachment', `prop ${a.prop} is attached twice (characters ${used.get(a.prop)} and ${i}); only one holds it`); used.set(a.prop, i); } }));
  if (shot.speaker != null && !(Number.isInteger(shot.speaker) && shot.speaker >= 0 && shot.speaker < chars.length)) add('error', 'speaker', `speaker ${shot.speaker} is not a character of the shot`);
  if (plan) {
    for (const n of plan.notes) add('warn', 'beats', n);
    for (const m of plan.moved) add('warn', 'overlap', `adjusted: ${m}`);
    if (typeof shot.speaker === 'number' && shot.speaker >= 0 && shot.speaker < chars.length) {
      for (const o of occluders(shot, plan, seconds, shot.speaker)) add('error', 'occlusion', `character ${o.character} blocks the camera's view of character ${shot.speaker}'s face in ${o.samples} of ${o.of} sampled moments`);
    }
    // Moonwalking, from the plan: a clip that steps while the character stands, or a character that glides in a clip that doesn't step.
    plan.timelines.forEach((tl, i) => {
      for (const g of tl.segments) {
        const name = g.animation ?? (g === tl.segments[0] ? chars[i].animation : undefined);
        if (g.t1 - g.t0 < 0.8) continue;
        if (g.ground > 0.15 && name && isStanding(name) && !isLocomotion(name)) add('warn', 'moonwalk', `character ${i} glides at ${r3(g.ground)} m/s in "${name}", a clip that doesn't step: use a walk or run clip for the move`);
        if (g.ground === 0 && name && isLocomotion(name) && g.speed == null) add('warn', 'moonwalk', `character ${i} stands still in "${name}", a clip that walks (it will walk on the spot): use an idle clip`);
      }
    });
  }
  return { issues, plan };
}

// ---------------------------------------------------------------- fixes (what the gate may change)

export type Fix = {
  target: 'character' | 'camera' | 'attachment' | 'prop';
  index?: number;
  /** Attachment index within the character (for target "attachment"). */
  attachment?: number;
  field: string;
  values: number[];
  reason?: string;
};

const FIX_FIELDS: Record<Fix['target'], Record<string, number>> = {
  character: { position: 2, facing: 1, travel: 1, height: 1 },
  camera: { angle: 1, distance: 1, height: 1, lens: 1, aimHeight: 1, amount: 1, target: 1 },
  attachment: { offset: 3, rotation: 3, grip: 3, size: 1, scale: 1 },
  prop: { position: 3, facing: 1, size: 1 },
};
const FIX_LIMITS: Record<string, [number, number]> = {
  position: [-60, 60], facing: [-720, 720], travel: [0, 12], height: [0.2, 6], angle: [-180, 180], distance: [0.5, 40], lens: [10, 200], aimHeight: [0, 1.2],
  amount: [-360, 360], offset: [-2, 2], rotation: [-360, 360], grip: [0, 1], size: [0.02, 5], scale: [0.01, 100], target: [0, 31],
};

export const FIX_SCHEMA_FIELDS = Object.fromEntries(Object.entries(FIX_FIELDS).map(([t, f]) => [t, Object.keys(f)]));

/** Applies fixes to a copy of the shot. Throws on a fix that names something that isn't there or goes out of range. */
export function applyFixes(shot: Shot, fixes: Fix[]): { shot: Shot; applied: string[] } {
  const out: Shot = JSON.parse(JSON.stringify(shot));
  const applied: string[] = [];
  for (const f of fixes) {
    const want = FIX_FIELDS[f.target]?.[f.field];
    if (!want) throw new GenError(`fix: ${f.target} has no adjustable ${f.field}`);
    if (!Array.isArray(f.values) || f.values.length !== want || !f.values.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new GenError(`fix: ${f.target}.${f.field} takes ${want} number(s)`);
    const [lo, hi] = FIX_LIMITS[f.field];
    if (f.values.some((v) => v < lo || v > hi)) throw new GenError(`fix: ${f.target}.${f.field} must be ${lo} to ${hi}`);
    const val = want === 1 ? f.values[0] : f.values;
    let host: any;
    if (f.target === 'camera') host = out.camera ??= {};
    else if (f.target === 'character') host = out.characters?.[f.index ?? -1];
    else if (f.target === 'prop') host = out.props?.[f.index ?? -1];
    else host = out.characters?.[f.index ?? -1]?.attachments?.[f.attachment ?? 0];
    if (!host) throw new GenError(`fix: no ${f.target} ${f.index ?? ''}${f.target === 'attachment' ? `.${f.attachment ?? 0}` : ''}`);
    // A character that has beats: a new position/facing moves where it starts (the beats follow from there).
    host[f.field] = val;
    applied.push(`${f.target}${f.index != null ? ` ${f.index}` : ''} ${f.field} = ${JSON.stringify(val)}${f.reason ? ` (${f.reason})` : ''}`);
  }
  return { shot: out, applied };
}

/**
 * Fixes that need no judgment, from the lint: swing the camera away from whoever hides the speaker, turn a character
 * toward who it should face. Returns [] when there is nothing to do.
 */
export function autoFixes(shot: Shot, seconds: number): Fix[] {
  const { issues, plan } = lintShot(shot, seconds, 1e9);
  if (!plan) return [];
  const fixes: Fix[] = [];
  if (issues.some((i) => i.check === 'occlusion') && typeof shot.speaker === 'number') {
    // Try camera angles off to either side until nothing blocks the speaker's face.
    const base = Number(shot.camera?.angle ?? 0);
    for (const d of [15, -15, 30, -30, 45, -45, 60, -60]) {
      const trial: Shot = { ...shot, camera: { ...(shot.camera ?? {}), target: shot.speaker, angle: base + d } };
      if (!occluders(trial, plan, seconds, shot.speaker).length) {
        fixes.push({ target: 'camera', field: 'angle', values: [base + d], reason: `swings ${d > 0 ? '+' : ''}${d}° so nobody blocks the speaker's face` });
        if (shot.camera?.target !== shot.speaker) fixes.push({ target: 'camera', field: 'target', values: [shot.speaker], reason: 'aims at the speaker' });
        break;
      }
    }
  }
  return fixes;
}
