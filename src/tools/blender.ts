// blender.render: a Blender shot rendered on a GPU server, with the control videos the video models follow.
//
// Give a .blend (or a .zip of a project folder) and/or a `shot` that builds the scene from the job's files:
// characters (GLB, FBX, OBJ, USD, .blend) with an animation from the file or a Mixamo FBX, props, a ground, a sky
// (an equirect image from image.panorama), lights and a camera move. It renders the beauty pass and the data passes
// (depth, pose, edges, normals, a character mask) as videos at the same frame rate and size, plus the first frame as
// an image to style with image.edit. video.control then repaints the shot in any look, following its motion exactly.
//
// The scripts are post/blender/hawkes_blender.py (inside Blender) and post/pose_draw.py; the server side is
// src/providers/blender/blender.ts. docs/blender.md has the shot format.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { paths } from '../config.ts';
import { ensureBlender, blenderWorkspace, BLENDER, BLENDER_VERSION } from '../providers/blender/blender.ts';

export const PASSES = ['beauty', 'depth', 'pose', 'edges', 'normal', 'mask'] as const;
/** The order outputs come back in (and their titles). */
const OUTPUT_ORDER = ['beauty', 'depth', 'pose', 'edges', 'normal', 'mask'];

/** Frames for a shot: `frames`, else seconds x fps + 1; snapped down to 8n + 1 (what LTX takes, and 4n + 1 for Wan). */
export function shotFrames(p: { frames?: number; seconds?: number; fps?: number; snap?: boolean }) {
  const fps = p.fps ?? 24;
  let n = p.frames ?? Math.round((p.seconds ?? 5) * fps) + 1;
  if (p.snap !== false) n = Math.max(9, Math.floor((n - 1) / 8) * 8 + 1);
  return Math.max(1, n);
}

/** Checks the passes asked for; edges need the beauty pass (they're drawn from it). */
export function shotPasses(list: unknown): string[] {
  const want = Array.isArray(list) ? list.map(String) : ['beauty', 'depth', 'pose', 'edges'];
  const bad = want.filter((p) => !(PASSES as readonly string[]).includes(p));
  if (bad.length) throw new GenError(`Unknown pass ${bad.join(', ')} (passes: ${PASSES.join(', ')})`);
  const out = [...new Set(want)];
  if (out.includes('edges') && !out.includes('beauty')) out.unshift('beauty');
  return out;
}

/** The script the server runs in the job's folder: Blender, the pose drawing, then one mp4 per pass. */
export function renderScript(
  o: { blend: string | null; zip: string | null; zipBlend?: string; fps: number; frames: number; edges: boolean },
  bin = { blender: BLENDER, python: '', python3: 'python3', ffmpeg: 'ffmpeg' },
) {
  const enc = (src: string, out: string, vf = '') =>
    `"${bin.ffmpeg}" -hide_banner -loglevel error -y -framerate ${o.fps} -start_number "$START" -i "${src}/%05d.png" -frames:v ${o.frames} ${vf ? `-vf "${vf}" ` : ''}-c:v libx264 -pix_fmt yuv420p -crf 12 -movflags +faststart "${out}"`;
  return [
    'set -e',
    'mkdir -p out res',
    o.zip
      ? `"${bin.python3}" -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "${o.zip}" in/project`
      : '',
    o.zip
      ? `BLEND=${o.zipBlend ? `"in/project/${o.zipBlend}"` : '$(find in/project -name "*.blend" -not -path "*/.*" | awk -F/ "{print NF, \\$0}" | sort -n | head -1 | cut -d" " -f2-)'}`
      : `BLEND=${o.blend ? `"${o.blend}"` : '""'}`,
    o.zip ? 'test -f "$BLEND" || { echo "HB error no .blend in the zip"; exit 3; }' : '',
    // The spec says where the .blend is, so the script knows it builds on a file.
    `"${bin.python3}" -c "import json,sys; s=json.load(open('spec.json')); s['blend']=sys.argv[1] or None; json.dump(s, open('spec.json','w'))" "$BLEND"`,
    `"${bin.blender}" -b \${BLEND:+"$BLEND"} --factory-startup --python-exit-code 1 -P hawkes_blender.py -- spec.json`,
    `START=$("${bin.python3}" -c "import json; print(json.load(open('out/info.json'))['start'])")`,
    // The pose is drawn with Pillow: ComfyUI's Python has it (gen servers keep it in /opt/comfy, adopted ones elsewhere).
    bin.python
      ? `PY="${bin.python}"`
      : 'PY=""; for p in /opt/comfy/venv/bin/python /opt/*/venv/bin/python /opt/*/*/venv/bin/python python3; do [ -x "$p" ] || command -v "$p" >/dev/null || continue; "$p" -c "import PIL" 2>/dev/null && { PY="$p"; break; }; done',
    'if [ -f out/pose.json ]; then if [ -n "$PY" ]; then "$PY" pose_draw.py out/pose.json out/pose "$START" >/dev/null; else echo "HB warning no Python with Pillow here: no pose video"; fi; fi',
    'echo "HB encoding"',
    ...['beauty', 'depth', 'normal', 'mask', 'pose'].map((p) => `if [ -d out/${p} ]; then ${enc(`out/${p}`, `res/${p}.mp4`)}; fi`),
    o.edges ? `if [ -d out/beauty ]; then ${enc('out/beauty', 'res/edges.mp4', 'edgedetect=low=0.1:high=0.3,format=yuv420p')}; fi` : '',
    'if [ -d out/beauty ]; then cp "out/beauty/$(printf %05d "$START").png" res/first.png; fi',
    'if [ -f out/shot.blend ]; then cp out/shot.blend res/shot.blend; fi',
    'cp out/info.json res/info.json',
    'echo "HB encoded"',
  ].filter(Boolean).join('\n');
}

export const blenderRenderTool: Tool = {
  id: 'blender.render',
  version: 1,
  title: 'Render a Blender shot (with control videos)',
  description:
    'Renders a 3D shot in Blender on a GPU server and returns it as videos: the beauty render plus control passes (depth, pose skeletons from the ' +
    'rigs, edges, normals, a character mask) and the first frame as an image. Give a .blend (or a .zip of the project folder) and/or a `shot` ' +
    'that builds the scene from the job\'s files: characters (GLB, FBX, .blend; an animation by name or from a Mixamo FBX), props, ground, sky, ' +
    'lights and a camera move (push-in, orbit, follow, ...). Then style the first frame with image.edit and repaint the whole shot with ' +
    'video.control (it follows the motion exactly). docs/blender.md has the shot format.',
  provider: 'comfy',
  family: 'blender',
  output: 'video',
  inputs: {
    scene: { kind: 'file', description: 'A .blend, or a .zip of a project folder with its textures (the .blend at the top, or name it with blend).' },
    files: { kind: 'file', multiple: true, max: 16, description: 'Models, animations and images the shot uses, by index (characters[].file = 0 is the first).' },
  },
  params: {
    shot: {
      type: 'json',
      description: 'Builds the scene: { characters: [{ file, animation, animationFile, height, position, facing, travel }], props, ground, background, lights, camera: { move, target, distance, height, angle, lens, amount, handheld } }',
      example: { characters: [{ file: 0, animation: 'Walk', height: 1.8, travel: 1.3, facing: 90 }], camera: { move: 'follow', angle: 70, distance: 4.5 }, lights: 'studio' },
    },
    camera: { type: 'string', description: 'The camera to render in the .blend (default: the scene camera, or the shot\'s).' },
    start: { type: 'integer', min: -100000, max: 100000, description: 'First frame (default: the .blend\'s start, or 1).' },
    seconds: { type: 'number', min: 0.4, max: 30, default: 5, description: 'Length when frames isn\'t given.' },
    frames: { type: 'integer', min: 1, max: 1441, description: 'Frame count (snapped down to 8n + 1 unless snap is off). Default: seconds x fps + 1.' },
    fps: { type: 'integer', min: 8, max: 60, default: 24, description: 'Frame rate (LTX: 24 or 25; Wan: 16).' },
    width: { type: 'integer', min: 256, max: 2048, default: 1280, description: 'LTX likes 1280x704 (or 704x1280); keep both multiples of 32.' },
    height: { type: 'integer', min: 256, max: 2048, default: 704 },
    passes: { type: 'json', default: ['beauty', 'depth', 'pose', 'edges'], description: `Which videos to make: ${PASSES.join(', ')}.` },
    engine: { type: 'enum', values: ['cycles', 'eevee', 'workbench'], default: 'cycles', description: 'The beauty pass renderer. Workbench is a fast grey preview.' },
    samples: { type: 'integer', min: 1, max: 4096, default: 32, advanced: true, description: 'Cycles samples for the beauty pass (denoised).' },
    near: { type: 'number', min: 0.001, advanced: true, description: 'Depth range start in meters (default: measured from the shot).' },
    far: { type: 'number', min: 0.01, advanced: true, description: 'Depth range end in meters (default: measured).' },
    snap: { type: 'boolean', default: true, advanced: true, description: 'Snap the frame count to 8n + 1 (what LTX and Wan take).' },
    blend: { type: 'string', advanced: true, description: 'With a .zip: the .blend inside it, e.g. "scenes/street.blend".' },
    save: { type: 'boolean', default: false, advanced: true, description: 'Also return the built shot as a .blend (to open and adjust in Blender).' },
  },
  models: () => [`blender-${BLENDER_VERSION}`],
  gpuSeconds: (p) => 45 + shotFrames(p) * shotPasses(p.passes).length * 0.25,
  async run(ctx) {
    const c = ctx.comfy!;
    const p = ctx.params;
    const scene: string | undefined = ctx.inputs.scene;
    const files: string[] = ctx.inputs.files ?? [];
    if (!scene && !p.shot) throw new GenError('Give a .blend or .zip (scene), or a shot to build from files');
    if (p.shot && (typeof p.shot !== 'object' || Array.isArray(p.shot))) throw new GenError('shot must be an object');
    const ext = scene ? path.extname(scene).toLowerCase() : '';
    if (scene && !['.blend', '.zip'].includes(ext)) throw new GenError('scene must be a .blend or a .zip');
    const passes = shotPasses(p.passes);
    const frames = shotFrames(p);
    const outDir = ctx.tmp('blender');

    await ensureBlender(c.server.id, ctx.step);
    const ws = await blenderWorkspace(c.server.id, ctx.job.id);
    try {
      ctx.step('sending the scene and files to the GPU server');
      const remoteFiles: string[] = [];
      const put: Record<string, string> = {};
      files.forEach((f, i) => {
        const name = `in/${i}${path.extname(f).toLowerCase()}`;
        put[name] = f;
        remoteFiles.push(`${ws.dir}/${name}`);
      });
      if (scene) put[`in/scene${ext}`] = scene;
      put['hawkes_blender.py'] = path.join(paths.post, 'blender', 'hawkes_blender.py');
      put['pose_draw.py'] = path.join(paths.post, 'pose_draw.py');
      await ws.put(put);
      const spec = {
        out: `${ws.dir}/out`, files: remoteFiles, shot: p.shot ?? null, camera: p.camera ?? null, start: p.start ?? null,
        frames, fps: p.fps, width: p.width, height: p.height,
        passes: passes.filter((x) => x !== 'edges'), engine: p.engine, samples: p.samples, near: p.near ?? null, far: p.far ?? null,
        save: !!p.save, device: 'auto',
      };
      await ws.write({ 'spec.json': JSON.stringify(spec, null, 1) });
      const script = renderScript({
        blend: ext === '.blend' ? `in/scene.blend` : null, zip: ext === '.zip' ? 'in/scene.zip' : null, zipBlend: p.blend,
        fps: p.fps, frames, edges: passes.includes('edges'),
      });
      ctx.step(`rendering ${frames} frames (${passes.join(', ')}) in Blender ${BLENDER_VERSION}`);
      await c.timed(() => ws.run(script, {
        signal: ctx.signal,
        timeoutMs: 90 * 60_000,
        onLine: (line) => {
          const [kind, ...rest] = line.split(' ');
          if (kind === 'frame') ctx.step(`rendering: frame ${rest[0]} of ${rest[1]}`);
          else if (kind === 'pass') ctx.step(`rendering the ${rest[0]} pass`);
          else if (kind === 'warning' || kind === 'character' || kind === 'shot') ctx.log(`blender ${line}`);
          else if (kind === 'encoding') ctx.step('making the videos');
        },
      }));
      ctx.step('fetching the videos');
      await ws.get('res', outDir);
    } finally {
      await ws.clean();
    }

    const info = JSON.parse(fs.readFileSync(path.join(outDir, 'info.json'), 'utf8'));
    for (const w of info.warnings ?? []) ctx.log(`warning: ${w}`);
    const made: Record<string, number> = {};
    const outs: { file: string; title: string; ext: string }[] = [];
    for (const name of OUTPUT_ORDER) if (fs.existsSync(path.join(outDir, `${name}.mp4`))) outs.push({ file: `${name}.mp4`, title: name, ext: '.mp4' });
    if (fs.existsSync(path.join(outDir, 'first.png'))) outs.push({ file: 'first.png', title: 'first frame', ext: '.png' });
    if (fs.existsSync(path.join(outDir, 'shot.blend'))) outs.push({ file: 'shot.blend', title: 'shot', ext: '.blend' });
    for (const [k, o] of outs.entries()) {
      if (k >= ctx.done) await ctx.emit({ data: fs.readFileSync(path.join(outDir, o.file)), ext: o.ext, title: o.title, meta: { pass: o.title, frames: info.frames, fps: info.fps, width: info.width, height: info.height } });
      made[o.title] = k;
    }
    ctx.result({
      frames: info.frames, fps: info.fps, width: info.width, height: info.height, start: info.start, camera: info.camera,
      depth: { near: info.near, far: info.far }, device: info.device, characters: info.characters, warnings: info.warnings,
      seconds: info.seconds, outputs: Object.keys(made),
    });
  },
};
