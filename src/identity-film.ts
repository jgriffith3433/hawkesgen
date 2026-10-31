// References in every shot (docs/identity.md): how a shot's cast brings their identity packs (src/identity.ts) into
// its first frame. The chosen way, from what Gen's tools take:
//
//   1. paint   image.control paints the stage's first frame in the look (or image.edit edits it): the layout, camera
//              and poses stay. Its prompt carries each character's fixed description, unchanged.
//   2. on-model  one image.edit pass per known character (at most three), Qwen-Image-Edit-2511 with three images:
//              the painted frame, their sheet, and the reference rendered from the shot's own camera (their 3D model
//              in its pose at frame 1, on a plain background: dashboard/gen/director.js record) when there is one, else
//              a second picture of them. It repaints only that person, back on-model, and keeps everything else.
//   3. LoRA    a character with a trained LoRA first gets a fresh picture of them at this shot's angle from
//              image.character, which becomes the on-model pass's first reference.
//
// All of it is one asset.make job, so it is one recipe and one price. The video (video.control, video.talk) then
// starts from that frame, and its prompt carries the fixed descriptions too.

import type { IdentityPack } from './identity.ts';

/** A cast member's pack in a shot. */
export type CastPack = IdentityPack & { cast: number; name: string };

export type FirstFrameOptions = {
  look: string;
  keyframe: 'image.control' | 'image.edit';
  keyframeNodes?: Record<string, string | number | boolean>;
  width: number;
  height: number;
  /** A render of the modeled cast from the shot camera comes with the job (its file is "$camera"). */
  camera?: boolean;
  /** Where each cast member stands in frame 1 ("left", "center", "right"), by cast index. */
  screen?: Record<string, string>;
  /** Which way the camera sees each cast member ("three-quarter view"...), by cast index (for LoRA pictures). */
  views?: Record<string, string>;
  /** image.character can run now (the LoRA pass is added only then). */
  loraReady?: boolean;
  /** The retry after a failed identity check: two pictures of the person, firmer words, best of two. */
  strong?: boolean;
};

export type JobPlan = { tool: string; params: Record<string, any>; inputs: Record<string, any> };
export type FirstFramePlan = JobPlan & { checks: { cast: number; name: string; refs: string[] }[] };

export const MAX_ON_MODEL = 3;

/** The cast members to put back on-model: those with pictures, locked packs first, at most three. */
export function onModelCast(packs: CastPack[]): CastPack[] {
  return packs.filter((p) => p.refs.length).sort((a, b) => Number(Boolean(b.locked)) - Number(Boolean(a.locked)) || a.cast - b.cast).slice(0, MAX_ON_MODEL);
}

/** Which way the shot camera sees a cast member, in words (the camera's angle around the target against their facing). */
export function viewOf(cameraAngle: number, facing: number): string {
  const rel = Math.abs((((cameraAngle - facing) % 360) + 540) % 360 - 180);
  return rel < 25 ? 'front view' : rel < 70 ? 'three-quarter view' : rel < 115 ? 'side view' : 'back view';
}

export const onModelPrompt = (p: CastPack, o: { where?: string; second: 'camera' | 'picture' | 'none'; strong?: boolean }) =>
  [`Image 1 is a film frame. Repaint only ${p.name}${o.where ? `, the person ${o.where === 'center' ? 'in the center' : `on the ${o.where}`} of the frame,` : ''} so they are exactly the person in image 2: the same face, hair, body, outfit and colors.`,
    p.description ? `${p.name}: ${p.description}` : '',
    o.second === 'camera' ? 'Image 3 is them in this exact pose and angle: match it.' : o.second === 'picture' ? 'Image 3 is another picture of the same person.' : '',
    o.strong ? 'Their face must be unmistakably the person in the references: the same eye shape, nose, jaw, skin tone and hairline.' : '',
    'Keep everything else in image 1 exactly: the composition, the camera, the light, the other people, every pose and position.'].filter(Boolean).join(' ');

/**
 * The first-frame job for a shot. Placeholders the caller fills: "$stage" (the stage's first frame) and "$camera"
 * (the camera render). With no one to keep on-model it is the paint job alone, as before.
 */
export function firstFramePlan(packs: CastPack[], o: FirstFrameOptions): FirstFramePlan {
  const kn = o.keyframeNodes && Object.keys(o.keyframeNodes).length ? { nodes: o.keyframeNodes } : {};
  const paint = (image: string) => (o.keyframe === 'image.edit'
    ? { tool: 'image.edit', params: { prompt: `${o.look} Keep the composition, camera and every figure's position exactly.`, width: o.width, height: o.height, ...kn }, inputs: { images: [image] } }
    : { tool: 'image.control', params: { prompt: o.look, ...kn }, inputs: { image } });
  const who = onModelCast(packs);
  if (!who.length) return { ...paint('$stage'), checks: [] };

  const files: string[] = ['$stage'];
  if (o.camera) files.push('$camera');
  const fileOf = (asset: string) => { const f = `asset:${asset}`; const i = files.indexOf(f); if (i >= 0) return `$input:${i}`; files.push(f); return `$input:${files.length - 1}`; };
  const steps: any[] = [{ ...paint('$input:0') }];
  let frame = 1;
  const checks: FirstFramePlan['checks'] = [];
  const refIdx = new Set<number>();
  for (const p of who) {
    const sheet = p.sheet ?? p.refs[0];
    const other = p.refs.find((r) => r !== sheet) ?? null;
    let first = fileOf(sheet);
    refIdx.add(Number(first.slice(7)));
    let second: string | null = null, kind: 'camera' | 'picture' | 'none' = 'none';
    if (p.lora && o.loraReady && !o.strong) {
      steps.push({ tool: 'image.character', params: { lora: p.lora.asset, prompt: `${p.description || p.name}. ${o.views?.[p.cast] ?? 'three-quarter view'}, full body, plain light grey background, even light`, width: 1024, height: 1024 } });
      second = first; kind = 'picture';
      first = `$step${steps.length}`;
    }
    if (!second && o.camera && !o.strong) { second = '$input:1'; kind = 'camera'; }
    if (!second && other) { second = fileOf(other); kind = 'picture'; refIdx.add(Number(second.slice(7))); }
    steps.push({
      tool: 'image.edit',
      params: { prompt: onModelPrompt(p, { where: o.screen?.[p.cast], second: kind, strong: o.strong }), width: o.width, height: o.height },
      inputs: { images: [`$step${frame}`, first, ...(second ? [second] : [])] },
    });
    frame = steps.length;
    checks.push({ cast: p.cast, name: p.name, refs: p.refs.slice(0, 3) });
  }
  steps[steps.length - 1].save = 'keyframe';
  const params: Record<string, any> = { steps };
  if (o.strong) Object.assign(params, { candidates: 2, pickAt: steps.length, refs: [...refIdx], pick: `The people are exactly the ones in the reference pictures (${who.map((p) => p.name).join(', ')}): faces, hair, outfits and colors; the frame's composition, camera and poses kept; hands and faces intact.` });
  return { tool: 'asset.make', params, inputs: { files }, checks };
}

/** Puts the uploaded files in place of a plan's placeholders. */
export function fillPlan<T>(plan: T, files: { stage: string; camera?: string | null }): T {
  const fill = (v: any): any => (Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v === '$stage' ? `asset:${files.stage}` : v === '$camera' ? (files.camera ? `asset:${files.camera}` : v) : v);
  return fill(plan);
}
