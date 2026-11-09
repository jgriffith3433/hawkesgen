// mesh.rig: rig and skin a generated mesh on a GPU server, then show it walking.
//
// Humanoids (kind humanoid, or kind auto when the shape is a biped with its arms out) go through Make-It-Animatable
// v2, which predicts a Mixamo skeleton (mixamorig: bone names, fingers included). Anything else, and a humanoid that
// Make-It-Animatable fails on when kind is auto, goes through SkinTokens (UniRig's successor). Each model has its own
// venv, installed on first use on the fleet (src/providers/rig/) and baked into the 3D worker image (server/gpu3d) for
// RunPod and Modal, family "rig"; src/providers/workspace.ts runs the script in either place.
//
// Blender then plants the result, copies textures back when the model dropped them, bakes a one-second walk (and any
// Mixamo clips the caller passed), and writes a GLB and an FBX. The preview is that walk. Licenses and pins:
// docs/3d-characters.md ("mesh.rig"). hawkes_rig.py still has the older geometric rigger (mode "rig") for its test.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';
import { jobWorkspace, prepare3d, weightsPrelude } from '../providers/workspace.ts';
import { MIA_COMMIT, MIA_PYTHON, MIA_ROOT, RIG_LICENSES, RIG_ROOT, SKIN_COMMIT, SKIN_PYTHON, SKIN_ROOT, weightsScript } from '../providers/rig/install.ts';

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

/** The spec hawkes_blender.py renders from: the rigged GLB playing `clip`. The walk preview stands the camera still; the old turntable orbits. */
export function turntableSpec(o: { out: string; glb: string; clip: string | null; frames: number; fps: number; size: number; engine: string; samples: number; device?: string; camera?: Record<string, unknown> }) {
  return {
    out: o.out, files: [o.glb], frames: o.frames, fps: o.fps, width: o.size, height: o.size, passes: ['beauty'],
    engine: o.engine, samples: o.samples, device: o.device ?? 'auto',
    shot: {
      characters: [{ file: 0, ...(o.clip ? { animation: o.clip } : {}), height: 1.8 }],
      camera: o.camera ?? { move: 'orbit', amount: 360, angle: 180, distance: 2.6 },
      lights: 'studio',
    },
  };
}

/** What the server runs: prepare the mesh, pick Make-It-Animatable or SkinTokens, then a walk preview. */
export function rigJobScript(o: { kind: 'humanoid' | 'auto'; keepTextures: boolean; fps: number; frames: number; preview?: boolean }, bin = { blender: BLENDER, mia: MIA_PYTHON, skin: SKIN_PYTHON, miaRoot: MIA_ROOT, skinRoot: SKIN_ROOT }) {
  const keep = o.keepTextures ? '1' : '0';
  return [
    'set -euo pipefail',
    weightsPrelude([weightsScript()]),
    `export HF_HOME="\${HAWKES_HF_HOME:-${RIG_ROOT}/hf}"`,
    `export MIA_ROOT=${bin.miaRoot}`,
    'mkdir -p out res',
    'sample() {',
    '  python3 -c \'import json,os,subprocess,sys',
    'tag=sys.argv[1]',
    'mem={}',
    'for line in open("/proc/meminfo"):',
    '    k,v=line.split(":")',
    '    if k in ("MemTotal","MemAvailable"): mem[k]=int(v.strip().split()[0])*1024',
    'vram=None',
    'try:',
    '    used,total=subprocess.check_output(["nvidia-smi","--query-gpu=memory.used,memory.total","--format=csv,noheader,nounits"],text=True).strip().splitlines()[0].split(",")',
    '    vram={"usedMib":int(used.strip()),"totalMib":int(total.strip())}',
    'except Exception as e:',
    '    vram={"error":str(e)}',
    'disk=subprocess.check_output(["df","-B1","--output=used,avail","/"],text=True).strip().splitlines()[-1].split()',
    'open("res/samples.jsonl","a").write(json.dumps({"tag":tag,"vram":vram,"memTotalBytes":mem.get("MemTotal"),"memAvailableBytes":mem.get("MemAvailable"),"diskUsedBytes":int(disk[0]),"diskFreeBytes":int(disk[1])})+"\\n")\' "$1" || true',
    '}',
    'sample start',
    'echo "HB step preparing the mesh"',
    `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_rig.py -- prep.json`,
    `KIND=${o.kind}`,
    'BACKEND=mia',
    'if [ "$KIND" = auto ]; then',
    '  echo "HB step checking whether it is a humanoid"',
    `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_rig.py -- classify.json`,
    '  if ! python3 -c \'import json,sys; sys.exit(0 if json.load(open("out/class.json")).get("humanoid") else 1)\'; then BACKEND=skin; fi',
    'fi',
    'echo "HB backend $BACKEND"',
    'BEAMS=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | python3 -c \'import sys; t=int(sys.stdin.read().strip().splitlines()[0]); print(2 if t < 20000 else 4 if t < 32000 else 10)\')',
    'run_mia() {',
    '  echo "HB step rigging with Make-It-Animatable"',
    `  "${bin.mia}" mia_run.py --input "$PWD/in/prepared.glb" --output "$PWD/out/mia.fbx"`,
    '  cp out/mia.fbx out/rigged_in.fbx',
    '}',
    'run_skin() {',
    '  echo "HB step rigging with SkinTokens"',
    '  sample before-skin',
    `  TRANSFER=""`,
    `  if [ "${keep}" = 1 ]; then TRANSFER=--use_transfer; fi`,
    '  JOB=$PWD',
    `  (cd ${bin.skinRoot} && "${bin.skin}" demo.py --input "$JOB/in/prepared.glb" --output "$JOB/out/skinned.glb" $TRANSFER --num_beams "$BEAMS")`,
    '  cp out/skinned.glb out/rigged_in.glb',
    '  rm -f out/rigged_in.fbx',
    '  sample after-skin',
    '}',
    'if [ "$BACKEND" = mia ]; then',
    '  sample before-mia',
    '  if ! run_mia; then',
    '    sample after-mia',
    '    if [ "$KIND" = auto ]; then echo "HB warning Make-It-Animatable failed; using SkinTokens"; run_skin; else exit 1; fi',
    '  else',
    '    sample after-mia',
    '  fi',
    'else',
    '  run_skin',
    'fi',
    'python3 -c \'import json,os; p="finish.json"; s=json.load(open(p)); s["rigged"]=os.path.abspath("out/rigged_in.fbx" if os.path.isfile("out/rigged_in.fbx") else "out/rigged_in.glb"); json.dump(s, open(p,"w"))\'',
    'echo "HB step exporting the rig and the walk"',
    `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_rig.py -- finish.json`,
    'CLIP=$(python3 -c \'import json; c=json.load(open("out/rig.json")).get("clips") or []; print(next((x["name"] for x in c if x["name"]=="Walk"), c[0]["name"] if c else ""))\')',
    'python3 -c \'import json,os,sys; p="turn.json"; s=json.load(open(p)); clip=sys.argv[1]; ch=s["shot"]["characters"][0]; ch.pop("animation", None);',
    'import pathlib',
    'if clip: ch["animation"]=clip',
    'json.dump(s, open(p,"w"))\' "$CLIP"',
    ...(o.preview === false
      ? []
      : [
          'echo "HB step rendering the walk"',
          `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_blender.py -- turn.json`,
          `START=$(python3 -c "import json; print(json.load(open('out/turn/info.json'))['start'])")`,
          'echo "HB encoding"',
          `ffmpeg -hide_banner -loglevel error -y -framerate ${o.fps} -start_number "$START" -i "out/turn/beauty/%05d.png" -frames:v ${o.frames} -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart res/walk.mp4`,
          'cp "out/turn/beauty/$(printf %05d "$START").png" res/preview.png',
        ]),
    'cp out/rigged.glb res/rigged.glb',
    'cp out/character.fbx res/character.fbx',
    'cp out/rig.json res/rig.json',
    'sample end',
    'if [ -f /opt/hawkes-rig/resources.json ]; then cp /opt/hawkes-rig/resources.json res/install.json; fi',
    'echo "HB encoded"',
  ].join('\n');
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
  version: 4,
  title: 'Rig and skin a mesh',
  description:
    'Rigs and skins a mesh from mesh.views3d (GLB, or FBX/OBJ). kind humanoid uses Make-It-Animatable, which builds a Mixamo skeleton ' +
    '(mixamorig: bone names). kind auto (the default) does that for an upright biped with its arms out, and uses SkinTokens for anything else ' +
    'and if Make-It-Animatable fails. keepTextures copies the source textures back onto the rig. Returns a rigged GLB, an FBX, and a video of a ' +
    'standard walk. Optional Mixamo clips are baked on too. Runs on a GPU worker with the 3D image (RunPod, Modal) or a fleet server (family rig, ' +
    'not a ComfyUI node). docs/3d-characters.md ("mesh.rig").',
  provider: 'comfy',
  family: 'rig',
  image: '3d',
  output: 'mesh',
  inputs: {
    mesh: { kind: 'file', required: true, description: 'The character: a GLB from mesh.views3d (FBX or OBJ too), standing upright.' },
    clips: { kind: 'file', multiple: true, max: 24, description: 'Optional extra clips with a Mixamo-named skeleton (FBX or GLB), baked on beside the walk.' },
  },
  params: {
    kind: { type: 'enum', values: ['humanoid', 'auto'], default: 'auto', description: 'humanoid: Make-It-Animatable (Mixamo bone names). auto: that for a biped, SkinTokens otherwise.' },
    keepTextures: { type: 'boolean', default: true, description: 'Keep the mesh\'s textures on the rigged result.' },
    names: { type: 'json', description: 'A name per extra clip, in order (default: each file\'s name).', example: ['Idle', 'Wave'] },
    height: { type: 'number', min: 0.05, max: 100, description: 'Scale the character to this many meters tall (default: keep its size).' },
    facing: { type: 'number', min: -360, max: 360, default: 0, description: 'Which way the mesh faces now, in degrees (0: toward the viewer, glTF +Z; 90 or -90 for a side view, 180 for a back view).' },
    fps: { type: 'integer', min: 12, max: 60, default: 30, description: 'Frame rate of the walk and of any extra clips (Mixamo: 30).' },
    seconds: { type: 'number', min: 1, max: 20, default: 4, description: 'How long the walk preview is. The walk itself repeats every second.' },
    size: { type: 'integer', min: 256, max: 1536, default: 640, description: 'Preview size in pixels (square).' },
    engine: { type: 'enum', values: ['cycles', 'eevee', 'workbench'], default: 'cycles', advanced: true, description: 'Preview renderer.' },
    samples: { type: 'integer', min: 1, max: 1024, default: 16, advanced: true, description: 'Cycles samples for the preview (denoised).' },
    turntable: { type: 'boolean', default: true, advanced: true, description: 'Render the walk preview. Off returns the rigged files only.' },
    actions: { type: 'json', advanced: true, description: 'With clip files that hold several animations: which one to take from each, by name, in order.' },
    weights: { type: 'enum', values: ['proxy', 'direct'], default: 'proxy', advanced: true, description: 'Ignored. Skinning comes from the model. Kept so older recipes still submit.' },
    voxel: { type: 'number', min: 0.001, max: 1, advanced: true, description: 'Ignored. Kept so older recipes still submit.' },
  },
  models: () => [`make-it-animatable@${MIA_COMMIT.slice(0, 12)}`, `skintokens@${SKIN_COMMIT.slice(0, 12)}`, 'hunyuan3d-vae-v2-1', `blender-${BLENDER_VERSION}`],
  gpuSeconds: (p) => 240 + (p.turntable === false ? 0 : turnFrames({ seconds: p.seconds, fps: p.fps ?? 24 }) * 0.3),
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    const mesh: string | undefined = ctx.inputs.mesh;
    if (!mesh) throw new GenError('Give the character mesh (a GLB)');
    const ext = path.extname(mesh).toLowerCase();
    if (!['.glb', '.gltf', '.fbx', '.obj'].includes(ext)) throw new GenError('mesh must be a .glb, .gltf, .fbx or .obj');
    const kind = p.kind === 'humanoid' ? 'humanoid' : 'auto';
    const files: string[] = ctx.inputs.clips ?? [];
    for (const f of files) if (!['.fbx', '.glb', '.gltf'].includes(path.extname(f).toLowerCase())) throw new GenError(`Clip ${path.basename(f)} must be an .fbx, .glb or .gltf`);
    const clips = clipNames(files, p.names, p.actions);
    const preview = p.turntable !== false;
    const fps = p.fps ?? 30;
    const frames = turnFrames({ seconds: p.seconds ?? 4, fps });
    const outDir = ctx.tmp('rig');

    await prepare3d(c, ['blender', 'rig'], ctx.step);
    const ws = await jobWorkspace(c, ctx.job.id);
    try {
      ctx.step(`sending the mesh to ${ws.where}`);
      const put: Record<string, string> = { [`in/mesh${ext}`]: mesh };
      const remote: RigClip[] = clips.map((cl, i) => {
        const name = `in/clip${i}${path.extname(cl.file).toLowerCase()}`;
        put[name] = cl.file;
        return { ...cl, file: `${ws.dir}/${name}` };
      });
      put['hawkes_rig.py'] = path.join(paths.post, 'blender', 'hawkes_rig.py');
      put['hawkes_blender.py'] = path.join(paths.post, 'blender', 'hawkes_blender.py');
      put['mia_run.py'] = path.join(paths.post, 'rig', 'mia_run.py');
      await ws.put(put);
      const prepared = `${ws.dir}/in/prepared.glb`;
      const shared = { out: `${ws.dir}/out`, height: p.height ?? null, facing: p.facing ?? 0, fps };
      const turn = turntableSpec({
        out: `${ws.dir}/out/turn`, glb: `${ws.dir}/out/rigged.glb`, clip: 'Walk', frames, fps,
        size: p.size ?? 640, engine: p.engine ?? 'cycles', samples: p.samples ?? 16,
        camera: { move: 'static', angle: 35, distance: 3.2, height: 0.9 },
      });
      await ws.write({
        'prep.json': JSON.stringify({ mode: 'prep', mesh: `${ws.dir}/in/mesh${ext}`, prepared, ...shared }, null, 1),
        'classify.json': JSON.stringify({ mode: 'classify', mesh: prepared, ...shared }, null, 1),
        'finish.json': JSON.stringify({
          mode: 'finish', rigged: `${ws.dir}/out/rigged_in.fbx`, source: `${ws.dir}/in/mesh${ext}`, prepared,
          keepTextures: p.keepTextures !== false, clips: remote, frames, ...shared,
        }, null, 1),
        'turn.json': JSON.stringify(turn, null, 1),
      });
      ctx.step(kind === 'humanoid' ? 'rigging with Make-It-Animatable' : 'rigging (Make-It-Animatable for a humanoid, SkinTokens otherwise)');
      await c.timed(() => ws.run(rigJobScript({ kind, keepTextures: p.keepTextures !== false, fps, frames, preview }), {
        signal: ctx.signal,
        timeoutMs: 50 * 60_000,
        onLine: (line) => {
          const [word, ...rest] = line.split(' ');
          if (word === 'step') ctx.step(rest.join(' '));
          else if (word === 'frame') ctx.step(`walk: frame ${rest[0]} of ${rest[1]}`);
          else if (word === 'warning' || word === 'backend' || word === 'class' || word === 'mia') ctx.log(line);
          else if (word === 'encoding') ctx.step('making the walk video');
        },
      }));
      ctx.step('fetching the rigged model');
      await ws.get('res', outDir);
    } finally {
      await ws.clean();
    }

    const info = JSON.parse(fs.readFileSync(path.join(outDir, 'rig.json'), 'utf8'));
    const samples = fs.existsSync(path.join(outDir, 'samples.jsonl'))
      ? fs.readFileSync(path.join(outDir, 'samples.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const install = fs.existsSync(path.join(outDir, 'install.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'install.json'), 'utf8')) : null;
    for (const w of info.warnings ?? []) ctx.log(`warning: ${w}`);
    const outs = [
      { file: 'rigged.glb', title: 'rigged', ext: '.glb' },
      { file: 'character.fbx', title: 'fbx', ext: '.fbx' },
      { file: 'walk.mp4', title: 'walk', ext: '.mp4' },
      { file: 'preview.png', title: 'preview', ext: '.png' },
    ].filter((o) => fs.existsSync(path.join(outDir, o.file)));
    const meta = { bones: info.bones?.length, clips: (info.clips ?? []).map((x: any) => x.name), height: info.height };
    for (const [k, o] of outs.entries()) {
      if (k >= ctx.done) await ctx.emit({ data: fs.readFileSync(path.join(outDir, o.file)), ext: o.ext, title: o.title, meta });
    }
    ctx.result({
      bones: info.bones, clips: info.clips, height: info.height, vertices: info.vertices, warnings: info.warnings,
      seconds: info.seconds_total, outputs: outs.map((o) => o.title),
      licenses: RIG_LICENSES.map((x) => ({ id: x.id, commercial: x.commercial, weights: x.weights })),
      resources: { install, samples },
    });
  },
};
