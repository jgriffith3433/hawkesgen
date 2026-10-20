// motion.from-text: a humanoid clip from a sentence, on a GPU server.
//
// Kimodo-SOMA-RP-v1.2 writes a BVH on the SOMA skeleton (not SMPL). If it does not, HY-Motion 1.0
// writes SMPL-H pose numbers and smplh_to_bvh.py turns the body into a BVH, without SMPL's mesh weights.
// With a character, blender.character retargets each take, then loop / in-place, and renders a preview.
// Several takes come back as separate videos so library.judge can pick against the prompt.
// docs/3d-characters.md ("motion.from-text").

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { ensureBlender, blenderWorkspace, BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';
import { ensureMotion } from '../providers/motion/motion.ts';
import { HY_COMMIT, HY_MODEL, HY_PYTHON, HY_ROOT, KIMODO_COMMIT, KIMODO_MODEL, KIMODO_PYTHON, MOTION_LICENSES } from '../providers/motion/install.ts';
import { checkOps } from './character.ts';

const FPS = 30;

export type MotionBeat = { text: string; seconds?: number; at?: number };

export type MotionPlan = {
  /** What the caller asked for. library.judge uses this. */
  prompt: string;
  /** What the model hears. Key poses are folded in as one sentence each. */
  modelPrompt: string;
  /** Seconds per sentence, in order. One number when there are no key poses. */
  durations: number[];
  seconds: number;
  takes: number;
  loop: boolean;
  inPlace: boolean;
  constraints: Record<string, unknown>[] | null;
  clips: string[];
};

function beatsOf(raw: unknown): MotionBeat[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 8) throw new GenError('poses is a list of up to 8 key poses ({ text, seconds } or { text, at })');
  return raw.map((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new GenError(`poses[${i}] must be an object`);
    const text = String((b as any).text ?? (b as any).prompt ?? '').trim().replace(/\s+/g, ' ');
    if (text.length < 3) throw new GenError(`poses[${i}].text is the pose in a few words ("bat cocked over the right shoulder")`);
    const seconds = (b as any).seconds != null ? Number((b as any).seconds) : undefined;
    const at = (b as any).at != null ? Number((b as any).at) : undefined;
    if (seconds != null && !Number.isFinite(seconds)) throw new GenError(`poses[${i}].seconds must be a number`);
    if (at != null && !Number.isFinite(at)) throw new GenError(`poses[${i}].at must be seconds from the start`);
    return { text: text.replace(/\.+$/, ''), seconds, at };
  });
}

/** Kimodo constraints.json. Native objects (type + frame_indices) pass through. A root path can be given in seconds. */
export function kimodoConstraints(raw: unknown, fps: number): Record<string, unknown>[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new GenError('constraints is a list of Kimodo constraints, or root waypoints { type: "root2d", at: [seconds], path: [[x, z]] }');
  const frame = (t: number) => Math.max(0, Math.round(t * fps));
  return raw.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new GenError(`constraints[${i}] must be an object`);
    const o = c as Record<string, any>;
    if (o.frame_indices && o.type) return o;
    if (o.type === 'root2d' && Array.isArray(o.at) && Array.isArray(o.path)) {
      if (o.at.length !== o.path.length) throw new GenError(`constraints[${i}] root2d: at and path need one entry per waypoint`);
      return { type: 'root2d', frame_indices: o.at.map((t: number) => frame(Number(t))), smooth_root_2d: o.path };
    }
    if (o.type && o.at != null && !o.frame_indices) {
      const at = Array.isArray(o.at) ? o.at : [o.at];
      const { at: _at, ...rest } = o;
      return { ...rest, frame_indices: at.map((t: number) => frame(Number(t))) };
    }
    throw new GenError(`constraints[${i}] needs type and frame_indices, or type "root2d" with at (seconds) and path [[x, z], ...]`);
  });
}

/** The prompt Kimodo hears, and how long each sentence is. Key poses become one sentence per beat. */
export function planMotion(p: Record<string, any>): MotionPlan {
  const prompt = String(p.prompt ?? '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  if (prompt.length < 3 || prompt.length > 500) throw new GenError('prompt is a sentence describing the move (3 to 500 characters)');
  const seconds = p.seconds == null ? 2 : Number(p.seconds);
  if (!Number.isFinite(seconds) || seconds < 0.4 || seconds > 12) throw new GenError('seconds is between 0.4 and 12');
  const takes = p.takes == null ? 1 : Number(p.takes);
  if (!Number.isInteger(takes) || takes < 1 || takes > 8) throw new GenError('takes is a whole number from 1 to 8');
  const beats = beatsOf(p.poses);
  const sentence = (text: string) => `${prompt}, ${text.replace(/\.+/g, ',')}`;
  let durations: number[];
  let modelPrompt: string;
  if (!beats.length) {
    durations = [Math.round(seconds * 1000) / 1000];
    modelPrompt = prompt.replace(/\.+/g, ',');
  } else if (beats.every((b) => b.seconds != null && b.at == null)) {
    durations = beats.map((b) => Math.round(Number(b.seconds) * 1000) / 1000);
    if (durations.some((d) => d < 0.2 || d > 8)) throw new GenError('each pose\'s seconds is between 0.2 and 8');
    modelPrompt = beats.map((b) => sentence(b.text)).join('. ');
  } else if (beats.every((b) => b.at != null && b.seconds == null)) {
    const at = beats.map((b) => Number(b.at));
    if (at.some((t, i) => t <= (at[i - 1] ?? 0) || t > seconds)) throw new GenError('pose at times increase, stay above 0 and end by seconds');
    // Segment i runs up to at[i]. The last one runs to the end of the clip.
    durations = beats.map((b, i) => {
      const end = i === beats.length - 1 ? seconds : Number(b.at);
      const start = i === 0 ? 0 : Number(beats[i - 1].at);
      return Math.round((end - start) * 1000) / 1000;
    });
    if (durations.some((d) => d < 0.2)) throw new GenError('key poses need at least 0.2 seconds between them');
    modelPrompt = beats.map((b) => sentence(b.text)).join('. ');
  } else if (beats.every((b) => b.seconds == null && b.at == null)) {
    durations = beats.map(() => Math.round((seconds / beats.length) * 1000) / 1000);
    modelPrompt = beats.map((b) => sentence(b.text)).join('. ');
  } else {
    throw new GenError('give every pose a seconds length, or every pose an at time, or neither (the clip is split evenly)');
  }
  const total = Math.round(durations.reduce((s, d) => s + d, 0) * 1000) / 1000;
  return {
    prompt, modelPrompt, durations, seconds: total, takes,
    loop: p.loop === true, inPlace: p.inPlace === true || p['in-place'] === true,
    constraints: kimodoConstraints(p.constraints, FPS),
    clips: Array.from({ length: takes }, (_, i) => `take${i}`),
  };
}

/** blender.character ops: retarget each BVH, then the edits, then one file and one preview per take. */
export function retargetOps(clips: string[], scheme: 'soma' | 'smpl', o: { loop: boolean; inPlace: boolean }) {
  const ops: Record<string, unknown>[] = [{ op: 'import', file: 0, clips: false }];
  clips.forEach((name, i) => {
    ops.push({ op: 'retarget', file: i + 1, name, from: scheme });
    if (o.inPlace) ops.push({ op: 'inplace', clip: name, mode: 'travel' });
    if (o.loop) ops.push({ op: 'loop', clip: name, blend: 6 });
    ops.push({ op: 'export', format: 'glb', name, clips: [name] });
    ops.push({ op: 'export', format: 'fbx', name, clips: [name] });
  });
  ops.push({ op: 'preview', turntable: false, clips, size: 512, samples: 16, maxFrames: 360 });
  return ops;
}

/** The script the server runs in the job folder. Kimodo first; HY-Motion only if there is no BVH. */
export function motionJobScript(o: { character: boolean }, bin = { blender: BLENDER, kimodo: KIMODO_PYTHON, hy: HY_PYTHON, hyRoot: HY_ROOT, hyModel: HY_MODEL }) {
  const retarget = o.character ? [
    'python3 stamp.py',
    'echo "HB step retargeting onto the character"',
    `"${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_character.py -- spec.json`,
    'cp out/character.json res/ || true',
    'if ls out/files/* >/dev/null 2>&1; then cp out/files/* res/; fi',
    'if [ -d out/previews ]; then for s in out/previews/*.json; do',
    '  n=$(basename "$s" .json); read FPS FRAMES < "out/previews/$n.args"',
    '  echo "HB step rendering preview $n"',
    `  "${bin.blender}" -b --factory-startup --python-exit-code 1 -P hawkes_blender.py -- "$s"`,
    '  START=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\'start\'])" "out/previews/$n/info.json")',
    '  echo "HB encoding"',
    '  ffmpeg -hide_banner -loglevel error -y -framerate "$FPS" -start_number "$START" -i "out/previews/$n/beauty/%05d.png" -frames:v "$FRAMES" -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "res/preview-$n.mp4"',
    'done; fi',
  ] : ['python3 stamp.py'];
  return [
    'set -euo pipefail',
    'export HF_HOME=/opt/hawkes-motion/hf',
    'export HF_HUB_ENABLE_HF_TRANSFER=0',
    'export USE_HF_MODELS=1',
    'if [ -f /opt/hawkes-motion/hf/token ]; then export HF_TOKEN="$(cat /opt/hawkes-motion/hf/token)"; export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"; fi',
    'VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | tr -d " " || echo 0)',
    'if [ "${VRAM:-0}" -lt 40000 ]; then export TEXT_ENCODER_DEVICE=cpu; fi',
    'mkdir -p out/bvhs res',
    'rm -rf out/bvhs; mkdir -p out/bvhs',
    'echo "HB step generating the motion with Kimodo"',
    'set +e',
    `"${bin.kimodo}" kimodo_run.py`,
    'K=$?',
    'WANT=$(cat takes.txt); GOT=$(find out/bvhs -name "take-*.bvh" | wc -l)',
    'set -e',
    'if [ "$GOT" -ne "$WANT" ]; then',
    '  echo "HB warning Kimodo wrote $GOT of $WANT takes (exit $K); using HY-Motion 1.0"',
    '  rm -rf out/bvhs; mkdir -p out/bvhs',
    '  if [ "${VRAM:-0}" -lt 26000 ]; then echo "HY-Motion 1.0 wants 26 GB of VRAM" >&2; exit 1; fi',
    '  echo "HB step generating the motion with HY-Motion"',
    `  "${bin.hy}" hymotion_run.py ${bin.hyRoot} ${bin.hyModel}`,
    '  echo "HB step writing the BVH"',
    `  "${bin.blender}" -b --factory-startup --python-exit-code 1 -P smplh_to_bvh.py -- out/hy out/bvhs`,
    '  echo hymotion > out/bvhs/backend.txt',
    'fi',
    'test -f out/bvhs/take-0.bvh',
    'cp out/bvhs/take-*.bvh res/',
    'cp out/bvhs/backend.txt res/backend.txt',
    ...retarget,
    'echo "HB encoded"',
  ].join('\n');
}

export const motionFromTextTool: Tool = {
  id: 'motion.from-text',
  version: 1,
  title: 'Humanoid animation from a text prompt',
  description:
    'Makes a humanoid clip from a sentence on a GPU server. Kimodo-SOMA-RP-v1.2 writes a BVH on the SOMA skeleton ' +
    '(not SMPL; the NVIDIA Open Model License allows commercial use). If Kimodo writes nothing, HY-Motion 1.0 is the fallback ' +
    'and its pose is saved as a BVH without SMPL\'s body weights. poses are key moments (a swing\'s windup, contact and ' +
    'follow-through). Pass a rigged character and the clip is retargeted with blender.character; loop and inPlace are those ops. ' +
    'takes makes that many previews so library.judge can pick against the prompt. Own venv, family motion, installed on first use. ' +
    'docs/3d-characters.md ("motion.from-text").',
  provider: 'comfy',
  family: 'motion',
  output: 'file',
  inputs: {
    character: { kind: 'file', description: 'The rig to put the clip on (GLB or FBX from mesh.rig). Without it, the job returns the BVH only.' },
  },
  params: {
    prompt: { type: 'text', required: true, description: 'The move, as a sentence. "A person throws a straight right punch and returns to a ready stance."', example: 'A person swings a bat: windup, contact, follow-through.' },
    seconds: { type: 'number', min: 0.4, max: 12, default: 2, description: 'Length of the clip. Game moves are about 0.5 to 3 seconds.' },
    loop: { type: 'boolean', default: false, description: 'Seamless loop, after retarget (needs a character). For idles.' },
    inPlace: { type: 'boolean', default: false, description: 'Take the hips\' travel off the ground, after retarget (needs a character). For attacks and hits.' },
    poses: {
      type: 'json',
      description: 'Key poses in order. Each is { text, seconds } or { text, at } (at is seconds from the start). A bat swing: windup, contact, follow-through.',
      example: [
        { text: 'windup, the bat cocked back over the right shoulder', seconds: 0.6 },
        { text: 'contact, the bat level in front of the chest', seconds: 0.3 },
        { text: 'follow-through, the bat finishing over the left shoulder', seconds: 0.7 },
      ],
    },
    constraints: {
      type: 'json', advanced: true,
      description: 'Kimodo constraints (type, frame_indices, ...) or root waypoints { type: "root2d", at: [0, 1], path: [[0, 0], [0, 1]] } in meters.',
    },
    takes: { type: 'integer', min: 1, max: 8, default: 1, description: 'How many variations to make. File the preview videos into one slot and run library.judge with this prompt as the criteria.' },
    seed: { type: 'integer', min: 1, max: 2 ** 31 - 1, advanced: true, description: 'Seed for the first take. The next takes count up. Random when empty.' },
  },
  models: () => [`${KIMODO_MODEL}@${KIMODO_COMMIT.slice(0, 12)}`, `hy-motion-1.0@${HY_COMMIT.slice(0, 12)}`, `blender-${BLENDER_VERSION}`],
  gpuSeconds: (p) => 180 + (Number(p.takes) || 1) * 40,
  async run(ctx) {
    const c = ctx.comfy!;
    const plan = planMotion({ ...ctx.params, loop: ctx.params.loop, inPlace: ctx.params.inPlace });
    const character: string | undefined = ctx.inputs.character;
    if ((plan.loop || plan.inPlace) && !character) throw new GenError('loop and inPlace are applied when the clip is retargeted. Pass the rig as character, or turn them off to get the BVH only.');
    if (character && !['.glb', '.gltf', '.fbx'].includes(path.extname(character).toLowerCase())) throw new GenError('character must be a .glb, .gltf or .fbx');
    const ops = character ? retargetOps(plan.clips, 'soma', plan) : null;
    if (ops) checkOps(ops, [character!, ...plan.clips.map((name) => `${name}.bvh`)]);
    const outDir = ctx.tmp('motion');
    const seed = ctx.seed(0);

    await ensureBlender(c.server.id, ctx.step);
    await ensureMotion(c.server.id, ctx.step);
    const ws = await blenderWorkspace(c.server.id, ctx.job.id);
    try {
      ctx.step('sending the job to the GPU server');
      const put: Record<string, string> = {
        'kimodo_run.py': path.join(paths.post, 'motion', 'kimodo_run.py'),
        'hymotion_run.py': path.join(paths.post, 'motion', 'hymotion_run.py'),
        'smplh_to_bvh.py': path.join(paths.post, 'motion', 'smplh_to_bvh.py'),
        'stamp.py': path.join(paths.post, 'motion', 'stamp.py'),
        'hawkes_character.py': path.join(paths.post, 'blender', 'hawkes_character.py'),
        'hawkes_blender.py': path.join(paths.post, 'blender', 'hawkes_blender.py'),
      };
      if (character) put['in/character' + path.extname(character).toLowerCase()] = character;
      await ws.put(put);
      const files = character
        ? [`${ws.dir}/in/character${path.extname(character).toLowerCase()}`, ...plan.clips.map((_, i) => `${ws.dir}/out/bvhs/take-${i}.bvh`)]
        : [];
      const spec = ops ? { out: `${ws.dir}/out`, files, fps: FPS, device: 'auto', ops } : null;
      const text: Record<string, string> = {
        'prompt.txt': plan.modelPrompt + '\n',
        'duration.txt': plan.durations.join(' ') + '\n',
        'seconds.txt': String(plan.seconds) + '\n',
        'takes.txt': String(plan.takes) + '\n',
        'seed.txt': String(seed) + '\n',
      };
      if (plan.constraints) text['constraints.json'] = JSON.stringify(plan.constraints);
      if (spec) text['spec.json'] = JSON.stringify(spec, null, 1);
      await ws.write(text);
      ctx.step(`generating ${plan.takes} take${plan.takes === 1 ? '' : 's'} with Kimodo (${KIMODO_MODEL})`);
      await c.timed(() => ws.run(motionJobScript({ character: !!character }), {
        signal: ctx.signal,
        timeoutMs: 80 * 60_000,
        onLine: (line) => {
          const [word, ...rest] = line.split(' ');
          if (word === 'step') ctx.step(rest.join(' '));
          else if (word === 'frame') ctx.step(`preview: frame ${rest[0]} of ${rest[1]}`);
          else if (word === 'warning' || word === 'backend' || word === 'clip' || word === 'op') ctx.log(line);
          else if (word === 'encoding') ctx.step('making the preview video');
        },
      }));
      ctx.step('fetching the clip');
      await ws.get('res', outDir);
    } finally {
      await ws.clean();
    }

    const backend = fs.existsSync(path.join(outDir, 'backend.txt')) ? fs.readFileSync(path.join(outDir, 'backend.txt'), 'utf8').trim() : 'kimodo';
    const info = fs.existsSync(path.join(outDir, 'character.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'character.json'), 'utf8')) : null;
    for (const w of info?.warnings ?? []) ctx.log(`warning: ${w}`);
    const meta = { backend, prompt: plan.prompt, seconds: plan.seconds, model: backend === 'hymotion' ? 'HY-Motion-1.0' : KIMODO_MODEL };
    const outs: { file: string; title: string; ext: string; take: number }[] = [];
    for (let i = 0; i < plan.takes; i++) {
      const bvh = `take-${i}.bvh`;
      if (fs.existsSync(path.join(outDir, bvh))) outs.push({ file: bvh, title: 'bvh', ext: '.bvh', take: i });
      if (!info) continue;
      const glb = (info.outputs ?? []).find((o: any) => o.title === 'glb' && o.file === `${plan.clips[i]}.glb`);
      const fbx = (info.outputs ?? []).find((o: any) => o.title === 'fbx' && o.file === `${plan.clips[i]}.fbx`);
      const preview = (info.previews ?? []).find((o: any) => o.title === `preview/${plan.clips[i]}` && String(o.file).endsWith('.mp4'));
      if (glb) outs.push({ file: glb.file, title: 'glb', ext: '.glb', take: i });
      if (fbx) outs.push({ file: fbx.file, title: 'fbx', ext: '.fbx', take: i });
      if (preview) outs.push({ file: preview.file, title: 'preview', ext: '.mp4', take: i });
    }
    for (const [k, o] of outs.entries()) {
      if (k >= ctx.done) await ctx.emit({ data: fs.readFileSync(path.join(outDir, o.file)), ext: o.ext, title: o.title, seed: seed + o.take, meta: { ...meta, take: o.take } });
    }
    ctx.result({
      backend, model: meta.model, prompt: plan.prompt, modelPrompt: plan.modelPrompt, seconds: plan.seconds,
      durations: plan.durations, takes: plan.takes, loop: plan.loop, inPlace: plan.inPlace,
      clips: plan.clips, outputs: outs.map((o) => ({ title: o.title, take: o.take })),
      licenses: MOTION_LICENSES.filter((x) => x.commercial).map((x) => ({ id: x.id, commercial: x.commercial, weights: x.weights })),
      judge: plan.takes > 1 ? {
        tool: 'library.judge',
        criteria: plan.prompt,
        note: 'File every preview into one slot (saves: { "preview": "preview/<clip>" }) and every glb into the clip slot. library.judge picks the video. The glb with the same take is the clip.',
      } : null,
    });
  },
};
