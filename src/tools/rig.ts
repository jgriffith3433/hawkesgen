// mesh.rig: a generated humanoid (a GLB from mesh.from-image or mesh.textured) rigged with a Mixamo-named skeleton,
// with animation clips baked onto it, as one GLB. Plus a turntable preview of the first clip.
//
// It runs in Blender on a GPU server, through blender.render's machinery (src/providers/blender/): the skeleton is
// placed from the mesh's shape and skinned with Blender's automatic weights (bone heat) on a voxel-remeshed copy, then
// copied onto the real mesh; clips (Mixamo FBX or GLB) are retargeted by bone name in world space and baked, one
// action each. The preview is hawkes_blender.py rendering the rigged GLB with an orbiting camera. Why not Rigify or an
// auto-rig model: docs/blender.md ("mesh.rig"). The script is post/blender/hawkes_rig.py.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { ensureBlender, blenderWorkspace, BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';

export type RigClip = { file: string; name: string; action?: string | null };

/** Names each clip file: `names[i]`, else the file's own name ("Walking.fbx" -> "Walking"; not a library file's hash, which
 * becomes "Clip2"). Names must differ. */
export function clipNames(files: string[], names: unknown, actions?: unknown): RigClip[] {
  if (names != null && !Array.isArray(names)) throw new GenError('names must be a list of clip names');
  if (actions != null && !Array.isArray(actions)) throw new GenError('actions must be a list (one per clip file)');
  const out = files.map((f, i) => {
    const given = Array.isArray(names) && names[i] != null && String(names[i]).trim() ? String(names[i]).trim() : '';
    const base = path.basename(f, path.extname(f)).replace(/^(\d+|[0-9a-f]{16,})$/i, '');
    const name = (given || base || `Clip${i + 1}`).replace(/[^\w .-]/g, '').slice(0, 60) || `Clip${i + 1}`;
    const action = Array.isArray(actions) && actions[i] != null && String(actions[i]).trim() ? String(actions[i]) : null;
    return { file: f, name, action };
  });
  const seen = new Set<string>();
  for (const c of out) {
    if (seen.has(c.name)) throw new GenError(`Two clips are named ${c.name}; give each its own name in names`);
    seen.add(c.name);
  }
  return out;
}

/** The turntable frames: seconds x fps + 1. */
export const turnFrames = (p: { seconds?: number; fps?: number }) => Math.max(2, Math.round((p.seconds ?? 6) * (p.fps ?? 24)) + 1);

/** The spec hawkes_blender.py renders the turntable from: the rigged GLB playing `clip`, the camera going once around. */
export function turntableSpec(o: { out: string; glb: string; clip: string | null; frames: number; fps: number; size: number; engine: string; samples: number; device?: string }) {
  return {
    out: o.out, files: [o.glb], frames: o.frames, fps: o.fps, width: o.size, height: o.size, passes: ['beauty'],
    engine: o.engine, samples: o.samples, device: o.device ?? 'auto',
    shot: {
      characters: [{ file: 0, ...(o.clip ? { animation: o.clip } : {}), height: 1.8 }],
      camera: { move: 'orbit', amount: 360, angle: 180, distance: 2.6 },
      lights: 'studio',
    },
  };
}

/** The script the server runs in the job's folder: the rig, then (with a turntable) the preview render and its mp4. */
export function rigScript(o: { fps: number; frames: number; turntable: boolean }, bin = { blender: BLENDER, python3: 'python3', ffmpeg: 'ffmpeg' }) {
  return [
    'set -e',
    'mkdir -p out res',
    `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_rig.py -- rig.json`,
    'cp out/rigged.glb out/rig.json res/',
    ...(o.turntable
      ? [
          'echo "HB step rendering the turntable"',
          `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_blender.py -- turn.json`,
          `START=$("${bin.python3}" -c "import json; print(json.load(open('out/turn/info.json'))['start'])")`,
          'echo "HB encoding"',
          `"${bin.ffmpeg}" -hide_banner -loglevel error -y -framerate ${o.fps} -start_number "$START" -i "out/turn/beauty/%05d.png" -frames:v ${o.frames} -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart res/turntable.mp4`,
          'cp "out/turn/beauty/$(printf %05d "$START").png" res/preview.png',
        ]
      : []),
    'echo "HB encoded"',
  ].join('\n');
}

export const meshRigTool: Tool = {
  id: 'mesh.rig',
  version: 1,
  title: 'Rig and animate a humanoid mesh',
  description:
    'Rigs a generated humanoid character (a GLB from mesh.from-image or mesh.textured, standing, arms out in a T- or A-pose) with a ' +
    'Mixamo-named skeleton (mixamorig:Hips ... no fingers), skins it with automatic weights, and bakes animation clips onto it ' +
    '(Mixamo FBX or GLB files, retargeted by bone name). Returns one GLB with a named animation per clip, a turntable video of the ' +
    'first clip and a still. Runs in Blender on a GPU server (about a minute). Not for animals, props or meshes that already have a rig ' +
    '(use blender.render to animate those). docs/blender.md ("mesh.rig").',
  provider: 'comfy',
  family: 'blender',
  output: 'mesh',
  inputs: {
    mesh: { kind: 'file', required: true, description: 'The character: GLB/GLTF, FBX or OBJ, one humanoid standing upright.' },
    clips: { kind: 'file', multiple: true, max: 24, description: 'Animation clips with a Mixamo-named skeleton (FBX "without skin" from Mixamo, or GLB).' },
  },
  params: {
    names: { type: 'json', description: 'A name per clip, in order (default: each file\'s name). These are the animation names in the GLB.', example: ['Idle', 'Walk', 'Wave'] },
    height: { type: 'number', min: 0.05, max: 100, description: 'Scale the character to this many meters tall (default: keep its size).' },
    facing: { type: 'number', min: -360, max: 360, default: 0, description: 'Which way the mesh faces now, in degrees (0: toward the viewer, glTF +Z; 90 or -90 for a side view, 180 for a back view). The rig turns it to face front.' },
    fps: { type: 'integer', min: 12, max: 60, default: 30, description: 'Frame rate the clips are baked at (Mixamo: 30).' },
    turntable: { type: 'boolean', default: true, description: 'Also render a turntable video (the first clip playing, the camera going around once) and a still.' },
    seconds: { type: 'number', min: 1, max: 20, default: 6, description: 'Turntable length.' },
    size: { type: 'integer', min: 256, max: 1536, default: 640, description: 'Turntable size in pixels (square).' },
    engine: { type: 'enum', values: ['cycles', 'eevee', 'workbench'], default: 'cycles', advanced: true, description: 'Turntable renderer.' },
    samples: { type: 'integer', min: 1, max: 1024, default: 16, advanced: true, description: 'Cycles samples for the turntable (denoised).' },
    actions: { type: 'json', advanced: true, description: 'With clip files that hold several animations: which one to take from each, by name, in order.' },
    weights: { type: 'enum', values: ['proxy', 'direct'], default: 'proxy', advanced: true, description: 'proxy: weight a voxel-remeshed copy, then copy the weights over (works on generated meshes with holes). direct: bone heat on the mesh itself.' },
    voxel: { type: 'number', min: 0.001, max: 1, advanced: true, description: 'Proxy voxel size in the mesh\'s units (default: height / 110).' },
  },
  models: () => [`blender-${BLENDER_VERSION}`],
  gpuSeconds: (p) => 40 + (p.turntable === false ? 0 : turnFrames({ seconds: p.seconds, fps: 24 }) * 0.3),
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    const mesh: string | undefined = ctx.inputs.mesh;
    if (!mesh) throw new GenError('Give the character mesh (a GLB)');
    const ext = path.extname(mesh).toLowerCase();
    if (!['.glb', '.gltf', '.fbx', '.obj'].includes(ext)) throw new GenError('mesh must be a .glb, .gltf, .fbx or .obj');
    const files: string[] = ctx.inputs.clips ?? [];
    for (const f of files) if (!['.fbx', '.glb', '.gltf'].includes(path.extname(f).toLowerCase())) throw new GenError(`Clip ${path.basename(f)} must be an .fbx, .glb or .gltf`);
    const clips = clipNames(files, p.names, p.actions);
    const turntable = p.turntable !== false;
    const fps = 24;
    const frames = turnFrames({ seconds: p.seconds, fps });
    const outDir = ctx.tmp('rig');

    await ensureBlender(c.server.id, ctx.step);
    const ws = await blenderWorkspace(c.server.id, ctx.job.id);
    try {
      ctx.step('sending the mesh and clips to the GPU server');
      const put: Record<string, string> = { [`in/mesh${ext}`]: mesh };
      const remote: RigClip[] = clips.map((cl, i) => {
        const name = `in/clip${i}${path.extname(cl.file).toLowerCase()}`;
        put[name] = cl.file;
        return { ...cl, file: `${ws.dir}/${name}` };
      });
      put['hawkes_rig.py'] = path.join(paths.post, 'blender', 'hawkes_rig.py');
      put['hawkes_blender.py'] = path.join(paths.post, 'blender', 'hawkes_blender.py');
      await ws.put(put);
      const spec = {
        mesh: `${ws.dir}/in/mesh${ext}`, clips: remote, out: `${ws.dir}/out`, height: p.height ?? null, facing: p.facing ?? 0,
        fps: p.fps ?? 30, weights: p.weights ?? 'proxy', voxel: p.voxel ?? null,
      };
      const turn = turntableSpec({
        out: `${ws.dir}/out/turn`, glb: `${ws.dir}/out/rigged.glb`, clip: clips[0]?.name ?? null, frames, fps,
        size: p.size ?? 640, engine: p.engine ?? 'cycles', samples: p.samples ?? 16,
      });
      await ws.write({ 'rig.json': JSON.stringify(spec, null, 1), 'turn.json': JSON.stringify(turn, null, 1) });
      ctx.step(`rigging${clips.length ? ` and baking ${clips.length} clip${clips.length > 1 ? 's' : ''}` : ''} in Blender ${BLENDER_VERSION}`);
      await c.timed(() => ws.run(rigScript({ fps, frames, turntable }), {
        signal: ctx.signal,
        timeoutMs: 45 * 60_000,
        onLine: (line) => {
          const [kind, ...rest] = line.split(' ');
          if (kind === 'step') ctx.step(rest.join(' '));
          else if (kind === 'frame') ctx.step(`turntable: frame ${rest[0]} of ${rest[1]}`);
          else if (kind === 'warning' || kind === 'clip') ctx.log(`blender ${line}`);
          else if (kind === 'encoding') ctx.step('making the turntable video');
        },
      }));
      ctx.step('fetching the rigged model');
      await ws.get('res', outDir);
    } finally {
      await ws.clean();
    }

    const info = JSON.parse(fs.readFileSync(path.join(outDir, 'rig.json'), 'utf8'));
    for (const w of info.warnings ?? []) ctx.log(`warning: ${w}`);
    const outs = [
      { file: 'rigged.glb', title: 'rigged', ext: '.glb' },
      { file: 'turntable.mp4', title: 'turntable', ext: '.mp4' },
      { file: 'preview.png', title: 'preview', ext: '.png' },
    ].filter((o) => fs.existsSync(path.join(outDir, o.file)));
    const meta = { bones: info.bones?.length, clips: (info.clips ?? []).map((x: any) => x.name), height: info.height };
    for (const [k, o] of outs.entries()) {
      if (k >= ctx.done) await ctx.emit({ data: fs.readFileSync(path.join(outDir, o.file)), ext: o.ext, title: o.title, meta });
    }
    ctx.result({
      bones: info.bones, clips: info.clips, height: info.height, vertices: info.vertices, joints: info.joints,
      weights: info.weights, warnings: info.warnings, seconds: info.seconds_total, outputs: outs.map((o) => o.title),
    });
  },
};
