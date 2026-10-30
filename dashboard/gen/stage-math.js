// The director's stage maths, with no DOM or three.js (director.js uses it; test/director.test.ts checks it): where
// each cast member is at a time (its beats played in order), and where the shot camera is, looks and how wide it sees.
// Blender's coordinates and conventions (docs/blender.md, "The shot"), so the stage matches blender.render.

/** How far each camera move goes when the shot doesn't say. */
export const DEFAULT_AMOUNT = { 'push-in': 0.35, 'pull-out': 0.4, orbit: 40, pan: 2, truck: 2, 'crane-up': 1.5, 'crane-down': 1.5 };
export const rad = (d) => (d * Math.PI) / 180;
const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/** Where a cast member is at time t, which way it faces, and whether it's walking (its beats played in order). */
export function poseAt(cast, i, t) {
  const c = cast[i];
  let pos = [...c.position], face = c.facing, walking = false, at = 0;
  for (const b of c.beats ?? []) {
    const from = [...pos];
    const dist = b.to ? Math.hypot(b.to[0] - from[0], b.to[1] - from[1]) : 0;
    const dur = b.seconds ?? (b.to ? Math.max(0.3, dist / (1.4 * (c.height / 1.75))) : 1);
    const u = Math.min(1, Math.max(0, (t - at) / dur));
    if (b.to) {
      const dir = Math.atan2(b.to[0] - from[0], -(b.to[1] - from[1])) * 180 / Math.PI;
      if (t >= at) { face = dist > 0.01 ? dir : face; pos = [from[0] + (b.to[0] - from[0]) * u, from[1] + (b.to[1] - from[1]) * u]; walking = t < at + dur && dist > 0.01; }
    } else if (t >= at) {
      let goal = b.facing;
      if (b.lookAt != null) {
        const tp = typeof b.lookAt === 'number' ? (cast[b.lookAt]?.position ?? pos) : b.lookAt;
        goal = Math.atan2(tp[0] - pos[0], -(tp[1] - pos[1])) * 180 / Math.PI;
      }
      if (goal != null) { let d = ((goal - face + 540) % 360) - 180; face += d * Math.min(1, (t - at) / 0.35); }
    }
    if (t < at + dur) break;
    at += dur;
  }
  return { pos, face, walking };
}

/** The shot camera at time t: where it is, where it looks, its vertical field of view. */
export function cameraAt(s, t, aspect) {
  const c = s.camera;
  const u = ease(Math.min(1, Math.max(0, s.seconds ? t / s.seconds : 0)));
  const tgt = (time) => {
    if (typeof c.target === 'number' && s.cast[c.target]) { const p = poseAt(s.cast, c.target, time); return { x: p.pos[0], y: p.pos[1], z: s.cast[c.target].height * (c.aimHeight ?? 0.55), face: s.cast[c.target].facing }; }
    const p = Array.isArray(c.target) ? c.target : [0, 0, 1];
    return { x: p[0], y: p[1], z: p[2], face: 0 };
  };
  const base = tgt(0), aim = c.move === 'follow' ? tgt(t) : tgt(t);
  const amount = c.amount ?? DEFAULT_AMOUNT[c.move] ?? 0;
  let dist = c.distance, ang = c.angle, height = c.height, side = 0, look = { ...aim };
  if (c.move === 'push-in') dist = c.distance * (1 - amount * u);
  if (c.move === 'pull-out') dist = c.distance * (1 + amount * u);
  if (c.move === 'orbit') ang = c.angle + amount * u;
  if (c.move === 'turntable') ang = c.angle + 360 * (s.seconds ? t / s.seconds : 0);
  if (c.move === 'crane-up') height = c.height + amount * u;
  if (c.move === 'crane-down') height = Math.max(0.1, c.height - amount * u);
  if (c.move === 'truck') side = amount * (u - 0.5);
  const anchor = c.move === 'follow' ? aim : base;
  // "Angle 0 is in front of the character": the side its facing points to (Blender: facing 0 looks toward -y).
  const phi = rad(anchor.face + ang);
  const fwd = [Math.sin(phi), -Math.cos(phi)];
  const right = [-fwd[1], fwd[0]];
  let pos = { x: anchor.x + fwd[0] * dist + right[0] * side, y: anchor.y + fwd[1] * dist + right[1] * side, z: height };
  if (c.move === 'truck') look = { ...look, x: look.x + right[0] * side, y: look.y + right[1] * side };
  if (c.move === 'pan') { const off = amount * (u - 0.5); look = { ...look, x: look.x - right[0] * off, y: look.y - right[1] * off }; }
  if (c.handheld) {
    const k = c.handheld * 0.03;
    pos = { x: pos.x + Math.sin(t * 1.3) * k, y: pos.y + Math.sin(t * 0.9 + 1) * k, z: pos.z + Math.sin(t * 1.7 + 2) * k };
  }
  const hfov = 2 * Math.atan(18 / c.lens);
  const vfov = aspect >= 1 ? 2 * Math.atan(Math.tan(hfov / 2) / aspect) : hfov;
  return { pos, look, vfov: (vfov * 180) / Math.PI };
}
