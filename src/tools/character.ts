// blender.character: a fixed set of named Blender ops on one 3D character, chained in one job: import, clean
// (decimate to a triangle budget), bake (new UVs, base color and normal maps), attach a prop to a bone, retarget clips
// from another skeleton (rest-pose aware, across Mixamo / Unity / Unreal / Rigify / SMPL / BVH names), clip edits
// (trim, loop, in place, speed, mirror, reverse, concat, key poses from JSON), hard-surface robots (split into parts,
// template rigs, procedural clips), export (FBX for Unity, GLB for the web, the .blend) and previews (a turntable and
// a video per clip, rendered by blender.render's shot).
//
// No free-form bpy: the ops are post/blender/hawkes_character.py (+ hawkes_robot.py); this file checks them before a
// GPU server is claimed, runs them through blender.render's machinery (src/providers/blender/) and files what they
// made. The previews are hawkes_blender.py rendering the exported character. docs/3d-characters.md has every op.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { ask, usageOf } from '../providers/anthropic.ts';
import { extractJson } from '../providers/claudecode.ts';
import { ensureBlender, blenderWorkspace, BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';

const ROBOT_KINDS = ['spider', 'quadarm', 'biped', 'chain'] as const;
const CLIP_TYPES = ['walk', 'run', 'idle', 'attack', 'hit', 'death', 'jump'] as const;

/** Each op and the fields it takes (required ones first, marked with !). */
export const OPS: Record<string, string[]> = {
  import: ['file!', 'height', 'facing', 'clips', 'names', 'map'],
  clean: ['triangles', 'merge', 'normals'],
  fix: ['shards', 'holes', 'merge', 'smooth'],
  symmetrize: ['side', 'center', 'merge'],
  retopo: ['faces', 'mode', 'symmetry', 'fix', 'seed'],
  project: ['views!', 'size', 'sharpness', 'margin', 'rebuild_uv'],
  lod: ['levels', 'name', 'compress', 'textures', 'level', 'rebake', 'sizes', 'angle', 'islandMargin', 'samples', 'extrusion', 'distance', 'roughness'],
  report: [],
  pack: ['size', 'ao'],
  collision: ['mode', 'faces', 'parts', 'name'],
  budget: ['target', 'triangles', 'materials', 'bones', 'texture', 'strict'],
  bake: ['size', 'maps', 'high', 'samples', 'margin', 'extrusion', 'distance', 'roughness', 'islandMargin', 'angle'],
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
  split: ['by', 'parts', 'kind', 'segments', 'angles', 'label', 'size'],
  template: ['kind!', 'parts', 'segments', 'smooth'],
  clips: ['list', 'clips', 'kind', 'segments'],
  angles: ['size'],
  export: ['format!', 'name', 'clips', 'bones', 'title', 'compress', 'textures', 'level'],
  preview: ['turntable', 'clips', 'size', 'seconds', 'engine', 'samples', 'maxFrames'],
};
const NAMES = ['auto', 'mixamo', 'unity', 'unreal', 'rigify', 'smpl', 'soma', 'bvh'];
const MODELS = ['.glb', '.gltf', '.fbx', '.obj'];
const MOTION = [...MODELS, '.bvh'];
const IMAGES = ['.png', '.jpg', '.jpeg', '.webp'];

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
    if (o.op === 'retopo') {
      if (o.faces != null && !(Number.isInteger(o.faces) && o.faces >= 500 && o.faces <= 60000)) throw new GenError(`ops[${k}] retopo: faces is 500 to 60000`);
      if (o.mode != null && !['quad', 'voxel'].includes(o.mode)) throw new GenError(`ops[${k}] retopo: mode is quad or voxel`);
    }
    if (o.op === 'fix' && o.shards != null && !(o.shards >= 0 && o.shards <= 0.5)) throw new GenError(`ops[${k}] fix: shards is 0 to 0.5 (a piece smaller than this share of the biggest one is removed)`);
    if (o.op === 'symmetrize' && o.side != null && !['auto', '+X', '-X'].includes(o.side)) throw new GenError(`ops[${k}] symmetrize: side is auto, +X or -X`);
    if (o.op === 'budget' && o.target != null && !['web', 'mobile', 'desktop', 'hero'].includes(o.target)) throw new GenError(`ops[${k}] budget: target is web, mobile, desktop or hero`);
    if (o.op === 'pack') {
      if (o.ao != null) fileRef(o, k, 'ao', IMAGES);
      if (o.size != null && !(o.size >= 64 && o.size <= 4096)) throw new GenError(`ops[${k}] pack: size is 64 to 4096`);
    }
    if (o.op === 'collision') {
      if (o.mode != null && !['box', 'capsule', 'hull', 'hulls'].includes(o.mode)) throw new GenError(`ops[${k}] collision: mode is box, capsule, hull or hulls`);
      if (o.faces != null && !(Number.isInteger(o.faces) && o.faces >= 8 && o.faces <= 256)) throw new GenError(`ops[${k}] collision: faces is 8 to 256 per hull`);
      if (o.parts != null && !(Number.isInteger(o.parts) && o.parts >= 1 && o.parts <= 16)) throw new GenError(`ops[${k}] collision: parts is 1 to 16`);
    }
    if ((o.op === 'export' || o.op === 'lod') && o.compress != null && !['draco', 'none', true, false].includes(o.compress)) throw new GenError(`ops[${k}] ${o.op}: compress is draco`);
    if ((o.op === 'export' || o.op === 'lod') && o.textures != null && !['webp', 'jpeg', 'png', 'auto'].includes(o.textures)) throw new GenError(`ops[${k}] ${o.op}: textures is webp, jpeg or png`);
    if (o.op === 'lod' && o.levels != null && !(Array.isArray(o.levels) && o.levels.length && o.levels.every((r: unknown) => typeof r === 'number' && r >= 0.01 && r < 1))) {
      throw new GenError(`ops[${k}] lod: levels is a list of ratios from 0.01 to below 1, e.g. [0.5, 0.25, 0.1]`);
    }
    if (o.op === 'project') {
      if (!Array.isArray(o.views) || !o.views.length) throw new GenError(`ops[${k}] project: views is [{ file: 1, view: "front" }, { file: 2, view: "back" }, ...]`);
      o.views.forEach((v: any, i: number) => {
        if (!v || typeof v !== 'object') throw new GenError(`ops[${k}] project: views[${i}] must be { file, view }`);
        fileRef({ ...v, op: 'project' }, k, 'file', IMAGES);
        if (!(typeof v.view === 'string' ? ['front', 'back', 'left', 'right'].includes(v.view) : typeof (v.view ?? v.angle) === 'number')) {
          throw new GenError(`ops[${k}] project: views[${i}].view is front, back, left, right or an angle in degrees`);
        }
      });
      if (o.size != null && !(o.size >= 256 && o.size <= 4096)) throw new GenError(`ops[${k}] project: size is 256 to 4096`);
      plan.bake = true;
    }
    if (o.op === 'clean' && o.triangles != null && !(Number.isInteger(o.triangles) && o.triangles >= 500 && o.triangles <= 500000)) throw new GenError(`ops[${k}] clean: triangles is 500 to 500000`);
    if ((o.op === 'import' || o.op === 'retarget') && (o.names ?? o.from) != null && !NAMES.includes(o.names ?? o.from)) throw new GenError(`ops[${k}] ${o.op}: bone names are ${NAMES.join(', ')}`);
    if (o.op === 'speed' && !(o.factor >= 0.05 && o.factor <= 20)) throw new GenError(`ops[${k}] speed: factor is 0.05 to 20`);
    if (o.op === 'pose' && (typeof o.bones !== 'object' || Array.isArray(o.bones) || !Object.keys(o.bones).length)) throw new GenError(`ops[${k}] pose: bones is { "LeftArm": [x, y, z] degrees, ... }`);
    if (o.op === 'concat' && !(Array.isArray(o.clips) && o.clips.length >= 2)) throw new GenError(`ops[${k}] concat: clips is a list of at least two clip names`);
    if (o.op === 'split') {
      if (o.by != null && !['connected', 'centers', 'both'].includes(o.by)) throw new GenError(`ops[${k}] split: by is connected, centers or both`);
      if (o.kind != null && !(ROBOT_KINDS as readonly string[]).includes(o.kind)) throw new GenError(`ops[${k}] split: kind is ${ROBOT_KINDS.join(', ')}`);
      if (o.parts != null && !Array.isArray(o.parts) && typeof o.parts !== 'object') throw new GenError(`ops[${k}] split: parts is [{ name, center: [x,y,z] }, ...]`);
      if (o.label && !o.angles) o.angles = true; // Claude needs the four stills
    }
    if (o.op === 'template') {
      if (!(ROBOT_KINDS as readonly string[]).includes(o.kind)) throw new GenError(`ops[${k}] template: kind is ${ROBOT_KINDS.join(', ')}`);
      if (o.smooth != null && !(o.smooth >= 0 && o.smooth <= 0.5)) throw new GenError(`ops[${k}] template: smooth is 0 to 0.5 metres`);
    }
    if (o.op === 'clips') {
      const list = o.list ?? o.clips;
      if (list != null && list !== true && list !== '*' && !Array.isArray(list)) throw new GenError(`ops[${k}] clips: list is [{ type: walk|run|idle|... }, ...]`);
      if (Array.isArray(list)) {
        for (const [i, c] of list.entries()) {
          const t = typeof c === 'string' ? c : c?.type;
          if (!t || !(CLIP_TYPES as readonly string[]).includes(t)) throw new GenError(`ops[${k}] clips: list[${i}] type is ${CLIP_TYPES.join(', ')}`);
        }
      }
      if (o.kind != null && !(ROBOT_KINDS as readonly string[]).includes(o.kind)) throw new GenError(`ops[${k}] clips: kind is ${ROBOT_KINDS.join(', ')}`);
    }
    if (o.op === 'export') {
      if (!['fbx', 'glb', 'blend'].includes(o.format)) throw new GenError(`ops[${k}] export: format is fbx, glb or blend`);
      if (o.bones != null && !['mixamo', 'keep', 'generic', 'robot'].includes(o.bones)) {
        throw new GenError(`ops[${k}] export: bones is mixamo, keep or generic`);
      }
      plan.exports.push(o.format);
    }
    if (o.op === 'angles' && o.size != null && !(o.size >= 128 && o.size <= 1536)) throw new GenError(`ops[${k}] angles: size is 128 to 1536`);
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

const LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['parts'],
  properties: {
    parts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'center'],
        properties: {
          name: { type: 'string', description: 'Template role: body, leg1..leg6, leg_fl, arm_l, hips, seg0, ...' },
          center: {
            type: 'array', minItems: 3, maxItems: 3,
            items: { type: 'number' },
            description: 'Approximate 3D centre of that part in metres (character stands on z=0, faces -Y, origin at feet centre)',
          },
        },
      },
    },
  },
};

/** Claude names hard-surface parts from the four angle stills + optional connected-piece centres. */
export async function labelRobotParts(opts: {
  angles: string[];
  kind: string;
  height?: number;
  parts?: { name: string; center: number[] }[];
  signal?: AbortSignal;
}): Promise<{ parts: { name: string; center: number[] }[]; usage: ReturnType<typeof usageOf> }> {
  const roles =
    opts.kind === 'spider' ? 'body, leg1, leg2, leg3, leg4, leg5, leg6 (six legs around the body, as a mechanical spider)' :
    opts.kind === 'quadarm' ? 'body, head, leg_fl, leg_fr, leg_bl, leg_br, arm_l, arm_r (quadruped body with two arms, like Yo Bot)' :
    opts.kind === 'biped' ? 'hips, spine, head, arm_l, arm_r, leg_l, leg_r' :
    'seg0, seg1, ... along the longest axis (a chain / worm / tentacle)';
  const known = (opts.parts ?? []).map((p) => `${p.name} @ [${p.center.map((x) => x.toFixed(3)).join(', ')}]`).join('; ') || 'none yet';
  const r = await ask({
    system: 'You label hard-surface robot / creature mesh parts for a game rig. Answer only with the JSON schema. Centres are in metres: +Z up, character facing -Y, origin on the ground under the body. Prefer the template role names exactly.',
    prompt: `Template: ${opts.kind}
Height of the mesh: ${opts.height ?? 'unknown'} m
Roles to cover: ${roles}
Connected pieces already found (name @ centre): ${known}

The images are four views in order: front (-Y), right (+X), back (+Y), left (-X). Pick a centre for every role you can see. If a connected piece already matches a role, keep or nudge its centre. Skip roles that are clearly absent.`,
    images: opts.angles,
    schema: LABEL_SCHEMA,
    effort: 'medium',
    maxTokens: 2000,
  }, opts.signal);
  const parsed = JSON.parse(extractJson(r.text)) as { parts: { name: string; center: number[] }[] };
  if (!parsed.parts?.length) throw new GenError('Claude returned no parts for the robot split');
  return { parts: parsed.parts, usage: usageOf(r, `${r.model} robot parts`) };
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
  version: 5,
  title: '3D character ops in Blender (repair, retopo, bake, multi-view texture, LODs, props, retarget, robots, FBX/GLB)',
  description:
    'Runs a chain of named Blender ops on one 3D character, on a GPU server: import (GLB/FBX/OBJ), report (mesh quality: shards, holes, ' +
    'thin triangles, asymmetry, a 0-100 score), fix (remove floating shards, merge doubles, fill holes, fix normals), symmetrize (mirror the ' +
    'denser half so a generated figure is left/right the same), retopo (clean quad surface via Quadriflow, voxel fallback; the original is ' +
    'kept as the bake source), clean (merge, fix normals, decimate to a triangle budget, default 25k), bake (smart UVs, base color + normal ' +
    'from the high-poly, 2K max), project (paint the color texture from front/back/side pictures projected onto the mesh, so every side ' +
    'comes from a real view), lod (lower-detail GLBs), attach a prop to a bone (a bat in ' +
    'RightHand), retarget clips from another skeleton (FBX/GLB/BVH; Mixamo, Unity, Unreal, Rigify, SMPL/SOMA or BVH bone names; rest-pose ' +
    'aware), clip edits (trim, loop with a blended seam, in place, speed, mirror, reverse, concat, key poses from JSON bone rotations), ' +
    'hard-surface robots (split into parts by connected pieces or labelled centres; template rigs spider / quadarm / biped / chain with ' +
    'rigid bind; procedural walk/run/idle/attack/hit/death/jump clips), pack (ORM texture: occlusion, roughness, metal in one image), ' +
    'collision (physics proxies: box, capsule, hull or hulls), export (FBX for Unity: Mixamo or Generic bone names; GLB for the ' +
    'web; or the .blend) and previews (a turntable and a video per clip). Ops refer to the job\'s files by index. A file can be ' +
    'motion:<pack>/<clip> from the CC0 Quaternius library. For a humanoid mesh with no skeleton yet, use mesh.rig first. ' +
    'docs/3d-characters.md has every op.',
  provider: 'comfy',
  family: 'blender',
  output: 'mesh',
  inputs: {
    files: { kind: 'file', multiple: true, max: 32, required: true, description: 'The character, clips (FBX, GLB, BVH), props and a high-poly, by index (ops[].file = 0 is the first). A library clip is motion:<pack>/<name> (motion:ual1/Walk_Loop).' },
  },
  params: {
    ops: {
      type: 'json', required: true,
      description: 'The steps, in order: [{ op: import | report | budget | fix | symmetrize | retopo | clean | bake | project | lod | attach | retarget | trim | loop | inplace | speed | mirror | reverse | concat | pose | copy | rename | remove | split | template | clips | export | preview, ... }]. docs/3d-characters.md.',
      example: [
        { op: 'import', file: 0 },
        { op: 'split', kind: 'quadarm', label: true },
        { op: 'template', kind: 'quadarm' },
        { op: 'clips' },
        { op: 'export', format: 'fbx', bones: 'generic' },
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
      const robot = ops.some((o) => o?.op === 'split' || o?.op === 'template') ? 45 : 0;
      const art = (ops.some((o) => o?.op === 'retopo') ? 60 : 0) + (ops.some((o) => o?.op === 'project') ? 90 : 0) + (ops.some((o) => o?.op === 'lod') ? 20 : 0);
      return 30 + ops.length * 4 + bake + previews + robot + art;
    } catch {
      return 60;
    }
  },
  async run(ctx) {
    const c = ctx.comfy!;
    const files: string[] = ctx.inputs.files ?? [];
    const plan = checkOps(ctx.params.ops, files);
    const outDir = ctx.tmp('character');
    let ops = plan.ops.map((o) => ({ ...o }));

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
      put['hawkes_robot.py'] = path.join(paths.post, 'blender', 'hawkes_robot.py');
      put['hawkes_blender.py'] = path.join(paths.post, 'blender', 'hawkes_blender.py');
      await ws.put(put);

      const onLine = (line: string) => {
        const [kind, ...rest] = line.split(' ');
        if (kind === 'step') ctx.step(rest.join(' '));
        else if (kind === 'frame') ctx.step(`preview: frame ${rest[0]} of ${rest[1]}`);
        else if (kind === 'warning' || kind === 'clip' || kind === 'op') ctx.log(`blender ${line}`);
        else if (kind === 'encoding') ctx.step('making the preview video');
      };

      // Optional Claude pass: render four angles, label parts, inject centres into split, then run the full chain.
      const splitAt = ops.findIndex((o) => o.op === 'split' && o.label);
      if (splitAt >= 0) {
        const splitOp = ops[splitAt];
        const tmpl = ops.find((o) => o.op === 'template')?.kind ?? splitOp.kind;
        if (!tmpl || !(ROBOT_KINDS as readonly string[]).includes(tmpl)) {
          throw new GenError('split with label: true needs a template kind on split or a following template op (spider, quadarm, biped, chain)');
        }
        const phase1 = [
          ...ops.slice(0, splitAt),
          { ...splitOp, kind: tmpl, angles: true, label: undefined, parts: splitOp.parts },
        ];
        ctx.step(`labelling ${tmpl} parts from four angles (Claude)`);
        await ws.write({ 'spec.json': JSON.stringify({ out: `${ws.dir}/out`, files: remote, fps: ctx.params.fps ?? 30, device: ctx.params.device ?? 'auto', ops: phase1 }, null, 1) });
        await c.timed(() => ws.run(characterScript(), { signal: ctx.signal, timeoutMs: 90 * 60_000, onLine }));
        const labelDir = ctx.tmp('character-label');
        await ws.get('res', labelDir);
        const info1 = JSON.parse(fs.readFileSync(path.join(labelDir, 'character.json'), 'utf8'));
        const angleFiles = ['front', 'right', 'back', 'left']
          .map((n) => path.join(labelDir, `angle-${n}.png`))
          .filter((p) => fs.existsSync(p));
        if (angleFiles.length < 4) throw new GenError(`split label: expected four angle stills, got ${angleFiles.length}`);
        const labelled = await labelRobotParts({
          angles: angleFiles, kind: tmpl, height: info1.height, parts: info1.ops?.find((x: any) => x.op === 'split')?.parts, signal: ctx.signal,
        });
        ctx.usage(labelled.usage);
        ctx.log(`labelled ${labelled.parts.length} parts for ${tmpl}`);
        ops = ops.map((o, i) => {
          if (i !== splitAt) return o;
          const { label: _l, ...rest } = o;
          return { ...rest, kind: tmpl, parts: labelled.parts, angles: o.angles === true };
        });
        // Clear the remote out/ so the full run starts clean.
        await ws.run('rm -rf out res && mkdir -p out res', { signal: ctx.signal, timeoutMs: 60_000 });
      }

      const spec = { out: `${ws.dir}/out`, files: remote, fps: ctx.params.fps ?? 30, device: ctx.params.device ?? 'auto', ops };
      await ws.write({ 'spec.json': JSON.stringify(spec, null, 1) });
      ctx.step(`running ${ops.length} ops in Blender ${BLENDER_VERSION}`);
      await c.timed(() => ws.run(characterScript(), {
        signal: ctx.signal,
        timeoutMs: 90 * 60_000,
        onLine,
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
      quality: info.quality ?? null,
      budget: info.budget ?? null,
      template: info.ops?.find((x: any) => x.op === 'template')?.kind ?? null,
    });
  },
};
