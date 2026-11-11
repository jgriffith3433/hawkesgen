// motion.from-video: a humanoid clip lifted out of an ordinary video (motion capture without a suit), on a GPU worker
// with the 3D image or a fleet server.
//
// NVIDIA GEM-X (Body Motion, native77) finds the main person, reads their 2D keypoints and Body Pose features, and
// predicts world-space SOMA motion with its Contact/IK pass (feet planted). post/motion/soma_to_bvh.py writes that as
// the same SOMA BVH Kimodo writes (checking itself against SOMA's own joints), post/motion/check.py measures it, and
// with a character blender.character retargets it (bone names "soma"), loops or keeps it in place, and renders a
// preview: the same back half as motion.from-text. The video can be anyone's footage, or Gen's own (video.i2v of the
// character doing the move: the recipe "animate from a video of itself", docs/3d-animation.md).

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';
import { jobWorkspace, prepare3d, weightsPrelude } from '../providers/workspace.ts';
import { GEMX_COMMIT, GEMX_PYTHON, GEMX_ROOT, MOCAP_LICENSES, MOCAP_WEIGHTS, weightsScript } from '../providers/mocap/install.ts';
import { KIMODO_PYTHON } from '../providers/motion/install.ts';
import { checkOps } from './character.ts';
import { retargetOps, retargetLines, checkLines, readChecks, rigNames, retargetChecks, withRetargetChecks } from './motion.ts';

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];

export type MocapPlan = { start: number; seconds: number; camera: 'background' | 'static'; loop: boolean; inPlace: boolean; name: string };

/** The params, checked: where in the video, how long (GEM-X takes at most 60 s), and the camera. */
export function planMocap(p: Record<string, any>): MocapPlan {
  const start = p.start == null ? 0 : Number(p.start);
  if (!Number.isFinite(start) || start < 0) throw new GenError('start is seconds into the video (0 or more)');
  const seconds = p.seconds == null ? 0 : Number(p.seconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new GenError('seconds is how much of the video to read, up to 60 (0: the whole video, if it is 60 s or less)');
  if (seconds > 0 && seconds < 0.5) throw new GenError('seconds is at least 0.5');
  const cam = String(p.camera ?? 'auto');
  if (!['auto', 'still', 'moving'].includes(cam)) throw new GenError('camera is auto, still or moving');
  const name = String(p.name ?? 'mocap').trim().replace(/[^\w-]/g, '').slice(0, 40) || 'mocap';
  return {
    start, seconds,
    // GEM-X's "background" mode estimates the camera's turn from the background; "static" trusts a locked-off camera.
    camera: cam === 'still' ? 'static' : 'background',
    loop: p.loop === true, inPlace: p.inPlace === true || p['in-place'] === true, name,
  };
}

/** The script the job folder runs: GEM-X, the SOMA BVH, the check, then (with a character) the retarget and preview. */
export function mocapJobScript(o: { ext: string; plan: MocapPlan; character: boolean }, bin = { blender: BLENDER, gemx: GEMX_PYTHON, gemxRoot: GEMX_ROOT, kimodo: KIMODO_PYTHON, weights: MOCAP_WEIGHTS }) {
  const p = o.plan;
  return [
    'set -euo pipefail',
    weightsPrelude([weightsScript()]),
    // A worker keeps the weights in $HAWKES_WEIGHTS/mocap; a fleet server where its installer put them.
    `MW="\${HAWKES_WEIGHTS:+$HAWKES_WEIGHTS/mocap}"; MW="\${MW:-${bin.weights}}"`,
    'export HF_HOME="${HAWKES_HF_HOME:-/opt/hawkes-mocap/hf}"',
    'export TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=0',
    'mkdir -p out/mocap out/bvhs res',
    `"${bin.gemx}" gemx_run.py --video in/clip${o.ext} --root ${bin.gemxRoot} --weights "$MW/weights" --soma "$MW/soma" --out out/mocap --camera ${p.camera}${p.start > 0 ? ` --start ${p.start}` : ''}${p.seconds > 0 ? ` --seconds ${p.seconds}` : ''}`,
    'echo "HB step writing the SOMA BVH"',
    `"${bin.kimodo}" soma_to_bvh.py out/mocap/soma.npz out/bvhs/take-0.bvh out/mocap/convert.json`,
    'echo "mocap" > out/bvhs/backend.txt',
    'cp out/bvhs/take-0.bvh res/take-0.bvh',
    'cp out/mocap/gemx.json out/mocap/convert.json res/',
    ...checkLines(),
    ...(o.character ? retargetLines(bin.blender) : []),
    'echo "HB encoded"',
  ].join('\n');
}

export const motionFromVideoTool: Tool = {
  id: 'motion.from-video',
  version: 2,
  title: 'Humanoid animation from a video (motion capture)',
  description:
    'Lifts a person\'s motion out of an ordinary video and makes it a humanoid clip: motion capture without a suit. NVIDIA GEM-X finds the main ' +
    'person and predicts their 3D motion on the SOMA skeleton (feet planted by its contact pass; commercial use allowed), written as a BVH. ' +
    'Pass a rigged character (GLB/FBX from mesh.rig) and the clip is retargeted onto it (Mixamo bone names on the FBX), with loop / inPlace and ' +
    'a preview video. Works on anyone\'s footage or on Gen\'s own: video.i2v of the character doing a move, then this (moves words can\'t describe: ' +
    'a dance, a signature attack). Best with the whole body in frame, one person, a still or slow camera, up to 60 s. Every clip is measured ' +
    '(foot slide, ground, pops, jitter). Runs on a GPU worker with the 3D image or a fleet server (family mocap). docs/3d-animation.md.',
  provider: 'comfy',
  family: 'mocap',
  image: '3d',
  output: 'file',
  inputs: {
    video: { kind: 'file', required: true, description: 'The video of the person moving (mp4, mov or webm): the whole body in frame, one person.' },
    character: { kind: 'file', description: 'The rig to put the clip on (GLB or FBX from mesh.rig). Without it, the job returns the BVH only.' },
  },
  params: {
    start: { type: 'number', min: 0, max: 3600, default: 0, description: 'Seconds into the video where the move starts.' },
    seconds: { type: 'number', min: 0, max: 60, default: 0, description: 'How much of the video to read (0: all of it, if it is 60 seconds or less).' },
    camera: { type: 'enum', values: ['auto', 'still', 'moving'], default: 'auto', description: 'still: a locked-off camera (most accurate). auto / moving: the camera\'s turn is estimated from the background.' },
    loop: { type: 'boolean', default: false, description: 'Seamless loop, after retarget (needs a character). For idles and cycles.' },
    inPlace: { type: 'boolean', default: false, description: 'Take the hips\' travel off the ground, after retarget (needs a character).' },
    names: { type: 'enum', values: ['auto', 'mixamo', 'unity', 'unreal', 'rigify', 'smpl', 'soma', 'bvh'], default: 'auto', advanced: true, description: 'How the character\'s bones are named (needs a character). auto reads limbs and fingers separately.' },
    map: { type: 'json', advanced: true, description: 'Bones the automatic naming misses: { "the rig\'s bone": "Mixamo name without the prefix" }, e.g. { "Chest": "Spine2" } (needs a character).' },
    name: { type: 'string', default: 'mocap', description: 'The clip\'s name on the rig.' },
  },
  models: () => [`gem-x@${GEMX_COMMIT.slice(0, 12)}`, 'soma-x@v0.3.3', `blender-${BLENDER_VERSION}`],
  estimateMode: (_p, inputs) => (inputs && !inputs.character ? 'bvh-only' : 'with-character'),
  gpuSeconds: (p) => 150 + Math.min(60, Number(p.seconds) || 10) * 6,
  async run(ctx) {
    const c = ctx.comfy!;
    const plan = planMocap(ctx.params);
    const video: string | undefined = ctx.inputs.video;
    if (!video) throw new GenError('Give the video of the person moving');
    const ext = path.extname(video).toLowerCase();
    if (!VIDEO_EXT.includes(ext)) throw new GenError(`video must be one of ${VIDEO_EXT.join(', ')}`);
    const character: string | undefined = ctx.inputs.character;
    if ((plan.loop || plan.inPlace) && !character) throw new GenError('loop and inPlace are applied when the clip is retargeted. Pass the rig as character, or turn them off to get the BVH only.');
    if (character && !['.glb', '.gltf', '.fbx'].includes(path.extname(character).toLowerCase())) throw new GenError('character must be a .glb, .gltf or .fbx');
    const ops = character ? retargetOps([plan.name], 'soma', plan, rigNames(ctx.params)) : null;
    if (ops) checkOps(ops, [character!, `${plan.name}.bvh`]);
    const outDir = ctx.tmp('mocap');

    await prepare3d(c, ['blender', 'motion', 'mocap'], ctx.step);
    const ws = await jobWorkspace(c, ctx.job.id);
    try {
      ctx.step(`sending the video to ${ws.where}`);
      const put: Record<string, string> = {
        [`in/clip${ext}`]: video,
        'gemx_run.py': path.join(paths.post, 'mocap', 'gemx_run.py'),
        'soma_to_bvh.py': path.join(paths.post, 'motion', 'soma_to_bvh.py'),
        'check.py': path.join(paths.post, 'motion', 'check.py'),
        'hawkes_character.py': path.join(paths.post, 'blender', 'hawkes_character.py'),
        'hawkes_blender.py': path.join(paths.post, 'blender', 'hawkes_blender.py'),
      };
      if (character) put['in/character' + path.extname(character).toLowerCase()] = character;
      await ws.put(put);
      if (ops) {
        const files = [`${ws.dir}/in/character${path.extname(character!).toLowerCase()}`, `${ws.dir}/out/bvhs/take-0.bvh`];
        await ws.write({ 'spec.json': JSON.stringify({ out: `${ws.dir}/out`, files, fps: 30, device: 'auto', ops }, null, 1) });
      }
      ctx.step('reading the motion out of the video with GEM-X');
      await c.timed(() => ws.run(mocapJobScript({ ext, plan, character: !!character }), {
        signal: ctx.signal,
        timeoutMs: 60 * 60_000,
        onLine: (line) => {
          const [word, ...rest] = line.split(' ');
          if (word === 'step') ctx.step(rest.join(' '));
          else if (word === 'frame') ctx.step(`preview: frame ${rest[0]} of ${rest[1]}`);
          else if (word === 'warning' || word === 'mocap' || word === 'clip' || word === 'op') ctx.log(line);
          else if (word === 'encoding') ctx.step('making the preview video');
        },
      }));
      ctx.step('fetching the clip');
      await ws.get('res', outDir);
    } finally {
      await ws.clean();
    }

    const read = (f: string) => (fs.existsSync(path.join(outDir, f)) ? JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')) : null);
    const gemx = read('gemx.json');
    const convert = read('convert.json');
    const info = read('character.json');
    const [check] = withRetargetChecks(readChecks(outDir, 1), character ? retargetChecks(info, [plan.name]) : []);
    for (const w of info?.warnings ?? []) ctx.log(`warning: ${w}`);
    if (check && !check.ok) ctx.log(`warning: the motion check found: ${check.problems.join('; ')}`);
    const meta = { backend: 'gem-x', seconds: gemx?.seconds, frames: gemx?.frames, camera: plan.camera, check: check ? { ok: check.ok, problems: check.problems } : undefined };
    const outs: { file: string; title: string; ext: string }[] = [];
    if (fs.existsSync(path.join(outDir, 'take-0.bvh'))) outs.push({ file: 'take-0.bvh', title: 'bvh', ext: '.bvh' });
    if (info) {
      const glb = (info.outputs ?? []).find((o: any) => o.title === 'glb' && o.file === `${plan.name}.glb`);
      const fbx = (info.outputs ?? []).find((o: any) => o.title === 'fbx' && o.file === `${plan.name}.fbx`);
      const preview = (info.previews ?? []).find((o: any) => o.title === `preview/${plan.name}` && String(o.file).endsWith('.mp4'));
      if (glb) outs.push({ file: glb.file, title: 'glb', ext: '.glb' });
      if (fbx) outs.push({ file: fbx.file, title: 'fbx', ext: '.fbx' });
      if (preview) outs.push({ file: preview.file, title: 'preview', ext: '.mp4' });
    }
    if (!outs.length) throw new GenError('GEM-X made no clip (see the job log)');
    for (const [k, o] of outs.entries()) {
      if (k >= ctx.done) await ctx.emit({ data: fs.readFileSync(path.join(outDir, o.file)), ext: o.ext, title: o.title, meta });
    }
    ctx.result({
      backend: 'gem-x', frames: gemx?.frames ?? null, seconds: gemx?.seconds ?? null, camera: plan.camera,
      start: plan.start, loop: plan.loop, inPlace: plan.inPlace, clip: plan.name,
      check, conversion: convert ? { convention: convert.convention, score: convert.score } : null,
      outputs: outs.map((o) => o.title),
      licenses: MOCAP_LICENSES.filter((x) => x.commercial).map((x) => ({ id: x.id, commercial: x.commercial, weights: x.weights })),
    });
  },
};
