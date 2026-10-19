// blender.character: a fixed set of named Blender ops on one 3D character, chained in one job: import, clean
// (decimate to a triangle budget), bake (new UVs, base color and normal maps), attach a prop to a bone, retarget clips
// from another skeleton (rest-pose aware, across Mixamo / Unity / Unreal / Rigify / SMPL / BVH names), clip edits
// (trim, loop, in place, speed, mirror, reverse, concat, key poses from JSON), export (FBX for Unity, GLB for the web,
// the .blend) and previews (a turntable and a video per clip, rendered by blender.render's shot).
//
// No free-form bpy: the ops are post/blender/hawkes_character.py; this file checks them before a GPU server is
// claimed, runs them through blender.render's machinery (src/providers/blender/) and files what they made. The
// previews are hawkes_blender.py rendering the exported character. docs/3d-characters.md has every op.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { ensureBlender, blenderWorkspace, BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';

/** Each op and the fields it takes (required ones first, marked with !). */
export const OPS: Record<string, string[]> = {
  import: ['file!', 'height', 'facing', 'clips', 'names', 'map'],
  clean: ['triangles', 'merge', 'normals'],
  bake: ['size', 'maps', 'high', 'samples', 'margin', 'extrusion', 'distance', 'roughness', 'islandMargin'],
  attach: ['file!', 'bone!', 'offset', 'rotation', 'size', 'scale', 'origin', 'name'],
  retarget: ['file!', 'name', 'action', 'from', 'map', 'inPlace', 'scale'],
  trim: ['clip!', 'start', 'end', 'as'],
  loop: ['clip!', 'blend', 'as'],
  inplace: ['clip!', 'mode', 'as'],
  speed: ['clip!', 'factor!', 'as'],
  mirror: ['clip!', 'as'],
  reverse: ['clip!', 'as'],
  concat: ['clips!', 'name', 'blend'],
  pose: ['clip!', 'bones!', 'frame', 'frames', 'mode', 'ease', 'length', 'as'],
  copy: ['clip!', 'name'],
  rename: ['clip!', 'name!'],
  remove: ['clip', 'clips'],
  export: ['format!', 'name', 'clips', 'bones'],
  preview: ['turntable', 'clips', 'size', 'seconds', 'engine', 'samples', 'maxFrames'],
};
const NAMES = ['auto', 'mixamo', 'unity', 'unreal', 'rigify', 'smpl', 'bvh'];
const MODELS = ['.glb', '.gltf', '.fbx', '.obj'];
const MOTION = [...MODELS, '.bvh'];

export type CharacterPlan = { ops: Record<string, any>[]; previews: boolean; turntable: boolean; bake: boolean; exports: string[] };

/** Checks the ops against the job's files before a server is claimed; returns what the job will make. */
export function checkOps(ops: unknown, files: string[]): CharacterPlan {
  if (!Array.isArray(ops) || !ops.length) throw new GenError('ops must be a list of steps, e.g. [{ "op": "import", "file": 0 }, { "op": "export", "format": "glb" }]');
  if (ops.length > 60) throw new GenError('At most 60 ops in one job');
  const ext = (i: number) => path.extname(files[i] ?? '').toLowerCase();
  const fileRef = (o: any, k: number, field: string, allowed: string[], many = false) => {
    const v = o[field];
    if (many && v === '*') return;
    const list = many && Array.isArray(v) ? v : [v];
    for (const x of list) {
      if (!Number.isInteger(x) || x < 0 || x >= files.length) throw new GenError(`ops[${k}] ${o.op}: ${field} must be the index of one of the job's files (0 to ${files.length - 1})`);
      if (!allowed.includes(ext(x))) throw new GenError(`ops[${k}] ${o.op}: file ${x} is ${ext(x) || 'not a model'}; this op takes ${allowed.join(', ')}`);
    }
  };
  let imported = false;
  const plan: CharacterPlan = { ops: [], previews: false, turntable: false, bake: false, exports: [] };
  ops.forEach((o: any, k) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new GenError(`ops[${k}] must be an object with an op`);
    const fields = OPS[o.op];
    if (!fields) throw new GenError(`ops[${k}]: unknown op ${JSON.stringify(o.op)} (${Object.keys(OPS).join(', ')})`);
    const known = new Set(['op', ...fields.map((f) => f.replace('!', ''))]);
    const extra = Object.keys(o).filter((f) => !known.has(f));
    if (extra.length) throw new GenError(`ops[${k}] ${o.op}: unknown field ${extra.join(', ')} (it takes ${[...known].slice(1).join(', ')})`);
    for (const f of fields.filter((x) => x.endsWith('!'))) if (o[f.slice(0, -1)] == null) throw new GenError(`ops[${k}] ${o.op}: ${f.slice(0, -1)} is required`);
    if (o.op === 'import') {
      if (imported) throw new GenError(`ops[${k}]: one import per job (bring clips in with retarget)`);
      if (k !== 0) throw new GenError(`ops[${k}]: import comes first`);
      fileRef(o, k, 'file', MODELS);
      imported = true;
    } else if (!imported) throw new GenError(`ops[${k}] ${o.op}: import the character first (ops[0] = { "op": "import", "file": 0 })`);
    if (o.op === 'attach') fileRef(o, k, 'file', MODELS);
    if (o.op === 'retarget') fileRef(o, k, 'file', MOTION, true);
    if (o.op === 'bake') {
      if (o.high != null) fileRef(o, k, 'high', MODELS);
      if (o.size != null && !(o.size >= 64 && o.size <= 2048)) throw new GenError(`ops[${k}] bake: size is 64 to 2048 (2K at most)`);
      plan.bake = true;
    }
    if (o.op === 'clean' && o.triangles != null && !(Number.isInteger(o.triangles) && o.triangles >= 500 && o.triangles <= 500000)) throw new GenError(`ops[${k}] clean: triangles is 500 to 500000`);
    if ((o.op === 'import' || o.op === 'retarget') && (o.names ?? o.from) != null && !NAMES.includes(o.names ?? o.from)) throw new GenError(`ops[${k}] ${o.op}: bone names are ${NAMES.join(', ')}`);
    if (o.op === 'speed' && !(o.factor >= 0.05 && o.factor <= 20)) throw new GenError(`ops[${k}] speed: factor is 0.05 to 20`);
    if (o.op === 'pose' && (typeof o.bones !== 'object' || Array.isArray(o.bones) || !Object.keys(o.bones).length)) throw new GenError(`ops[${k}] pose: bones is { "LeftArm": [x, y, z] degrees, ... }`);
    if (o.op === 'concat' && !(Array.isArray(o.clips) && o.clips.length >= 2)) throw new GenError(`ops[${k}] concat: clips is a list of at least two clip names`);
    if (o.op === 'export') {
      if (!['fbx', 'glb', 'blend'].includes(o.format)) throw new GenError(`ops[${k}] export: format is fbx, glb or blend`);
      plan.exports.push(o.format);
    }
    if (o.op === 'preview') {
      if (o.size != null && !(o.size >= 128 && o.size <= 1536)) throw new GenError(`ops[${k}] preview: size is 128 to 1536`);
      if (o.engine != null && !['cycles', 'eevee', 'workbench'].includes(o.engine)) throw new GenError(`ops[${k}] preview: engine is cycles, eevee or workbench`);
      plan.previews = o.clips !== false;
      plan.turntable = o.turntable !== false;
    }
    plan.ops.push(o);
  });
  return plan;
}

/** The script the server runs in the job's folder: the ops, then each preview shot rendered and encoded. */
export function characterScript(bin = { blender: BLENDER, python3: 'python3', ffmpeg: 'ffmpeg' }) {
  return [
    'set -e',
    'mkdir -p out res',
    `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_character.py -- spec.json`,
    'cp out/character.json res/',
    'if ls out/files/* >/dev/null 2>&1; then cp out/files/* res/; fi',
    'if [ -d out/previews ]; then for s in out/previews/*.json; do',
    '  n=$(basename "$s" .json); read FPS FRAMES < "out/previews/$n.args"',
    '  echo "HB step rendering preview $n"',
    `  "${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_blender.py -- "$s"`,
    `  START=$("${bin.python3}" -c "import json,sys; print(json.load(open(sys.argv[1]))['start'])" "out/previews/$n/info.json")`,
    '  echo "HB encoding"',
    `  "${bin.ffmpeg}" -hide_banner -loglevel error -y -framerate "$FPS" -start_number "$START" -i "out/previews/$n/beauty/%05d.png" -frames:v "$FRAMES" -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "res/preview-$n.mp4"`,
    '  cp "out/previews/$n/beauty/$(printf %05d "$START").png" "res/preview-$n.png"',
    'done; fi',
    'echo "HB encoded"',
  ].join('\n');
}

const MIME_EXT: Record<string, string> = { glb: '.glb', fbx: '.fbx', blend: '.blend' };

export const blenderCharacterTool: Tool = {
  id: 'blender.character',
  version: 1,
  title: '3D character ops in Blender (clean, bake, props, retarget, clip edits, FBX/GLB)',
  description:
    'Runs a chain of named Blender ops on one 3D character, on a GPU server: import (GLB/FBX/OBJ), clean (merge, fix normals, decimate to a ' +
    'triangle budget, default 25k), bake (smart UVs, base color + normal from the high-poly, 2K max), attach a prop to a bone (a bat in ' +
    'RightHand), retarget clips from another skeleton (FBX/GLB/BVH; Mixamo, Unity, Unreal, Rigify, SMPL/SOMA or BVH bone names; rest-pose ' +
    'aware), clip edits (trim, loop with a blended seam, in place, speed, mirror, reverse, concat, key poses from JSON bone rotations), ' +
    'export (FBX for Unity: Mixamo bone names, a take per clip, 1 unit = 1 m; GLB for the web: one animation per clip; or the .blend) and ' +
    'previews (a turntable and a video per clip). Ops refer to the job\'s files by index. For a mesh with no skeleton yet, use mesh.rig first. ' +
    'docs/3d-characters.md has every op.',
  provider: 'comfy',
  family: 'blender',
  output: 'mesh',
  inputs: {
    files: { kind: 'file', multiple: true, max: 32, required: true, description: 'The character, clips (FBX, GLB, BVH), props and a high-poly, by index (ops[].file = 0 is the first).' },
  },
  params: {
    ops: {
      type: 'json', required: true,
      description: 'The steps, in order: [{ op: import | clean | bake | attach | retarget | trim | loop | inplace | speed | mirror | reverse | concat | pose | copy | rename | remove | export | preview, ... }]. docs/3d-characters.md.',
      example: [
        { op: 'import', file: 0 },
        { op: 'retarget', file: 1, name: 'Walk' },
        { op: 'inplace', clip: 'Walk' },
        { op: 'loop', clip: 'Walk', blend: 6 },
        { op: 'export', format: 'fbx' },
        { op: 'export', format: 'glb' },
        { op: 'preview' },
      ],
    },
    fps: { type: 'integer', min: 12, max: 60, default: 30, description: 'The frame rate clips are sampled and exported at (Mixamo: 30).' },
    device: { type: 'enum', values: ['auto', 'cpu'], default: 'auto', advanced: true, description: 'Where Cycles bakes and renders previews (auto: the GPU).' },
  },
  models: () => [`blender-${BLENDER_VERSION}`],
  gpuSeconds: (p) => {
    try {
      const ops: any[] = Array.isArray(p.ops) ? p.ops : [];
      const bake = ops.some((o) => o?.op === 'bake') ? 60 : 0;
      const previews = ops.some((o) => o?.op === 'preview') ? 120 : 0;
      return 30 + ops.length * 4 + bake + previews;
    } catch {
      return 60;
    }
  },
  async run(ctx) {
    const c = ctx.comfy!;
    const files: string[] = ctx.inputs.files ?? [];
    const plan = checkOps(ctx.params.ops, files);
    const outDir = ctx.tmp('character');

    await ensureBlender(c.server.id, ctx.step);
    const ws = await blenderWorkspace(c.server.id, ctx.job.id);
    try {
      ctx.step(`sending ${files.length} file${files.length === 1 ? '' : 's'} to the GPU server`);
      const put: Record<string, string> = {};
      const remote = files.map((f, i) => {
        const name = `in/${i}${path.extname(f).toLowerCase()}`;
        put[name] = f;
        return `${ws.dir}/${name}`;
      });
      put['hawkes_character.py'] = path.join(paths.post, 'blender', 'hawkes_character.py');
      put['hawkes_blender.py'] = path.join(paths.post, 'blender', 'hawkes_blender.py');
      await ws.put(put);
      const spec = { out: `${ws.dir}/out`, files: remote, fps: ctx.params.fps ?? 30, device: ctx.params.device ?? 'auto', ops: plan.ops };
      await ws.write({ 'spec.json': JSON.stringify(spec, null, 1) });
      ctx.step(`running ${plan.ops.length} ops in Blender ${BLENDER_VERSION}`);
      await c.timed(() => ws.run(characterScript(), {
        signal: ctx.signal,
        timeoutMs: 90 * 60_000,
        onLine: (line) => {
          const [kind, ...rest] = line.split(' ');
          if (kind === 'step') ctx.step(rest.join(' '));
          else if (kind === 'frame') ctx.step(`preview: frame ${rest[0]} of ${rest[1]}`);
          else if (kind === 'warning' || kind === 'clip' || kind === 'op') ctx.log(`blender ${line}`);
          else if (kind === 'encoding') ctx.step('making the preview video');
        },
      }));
      ctx.step('fetching the results');
      await ws.get('res', outDir);
    } finally {
      await ws.clean();
    }

    const info = JSON.parse(fs.readFileSync(path.join(outDir, 'character.json'), 'utf8'));
    for (const w of info.warnings ?? []) ctx.log(`warning: ${w}`);
    const outs = [...(info.outputs ?? []), ...(info.previews ?? [])]
      .filter((o: any) => fs.existsSync(path.join(outDir, o.file)))
      .map((o: any) => ({ ...o, ext: o.ext ?? MIME_EXT[o.title] ?? path.extname(o.file) }));
    const meta = { height: info.height, triangles: info.triangles, clips: (info.clips ?? []).map((x: any) => x.name) };
    for (const [k, o] of outs.entries()) {
      if (k >= ctx.done) await ctx.emit({ data: fs.readFileSync(path.join(outDir, o.file)), ext: o.ext, title: o.title, meta });
    }
    ctx.result({
      height: info.height, triangles: info.triangles, names: info.names, clips: info.clips, props: info.props,
      bones: info.bones, ops: info.ops, warnings: info.warnings, seconds: info.seconds_total, outputs: outs.map((o: any) => o.title),
    });
  },
};
