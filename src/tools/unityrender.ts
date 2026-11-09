// unity.render: a Unity project's shots rendered in a Linux Unity editor with graphics on, on a GPU worker running the
// unity-render image (server/unity-render: GameCI's 6000.3.7f1 editor, an X display on the NVIDIA driver, ffmpeg, Node).
// First user: the TK Shock render farm (TurkeyRender Director/docs/render-farm.md, `mv farm`), which splits a video's
// shots across N of these jobs at once.
//
// The project tree reaches the worker by content, never per job: `mode: "sync"` unpacks a tar of files named by their
// sha256 into the network volume's store (each name checked against its bytes) and writes a manifest; `mode: "render"`
// names that manifest (job.snapshot), and the image's worker.sh assembles the tree, restores the Library cache, licenses
// Unity (the build account, from the endpoint's env), runs Farm.Run and sends back res/: one <id>-<hash>.mp4 with its
// .json sidecar per shot, worker.json (display, GPU, timings), stages.txt and unity.log. `mode: "check"` lists the blobs
// and manifests the store holds (what a sync can skip).
//
// It runs only on an endpoint whose families name `unity-render` (src/providers/gpu/route.ts keeps it off ComfyUI
// endpoints and the fleet, which have no Unity). docs/unity-render.md.

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.ts';
import { GenError } from '../util.ts';
import { jobWorkspace } from '../providers/workspace.ts';

/** Where the store lives on the volume (worker.sh uses the same folder). */
export const FARM_DIR = '"${HAWKES_WEIGHTS:-/runpod-volume/hawkes-weights}/tkshock-farm"';

const SHA = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[\w.-]{1,80}$/;

/** Checks a render job (the in/job.json worker.sh reads) and returns it with its frame count. */
export function checkJob(job: any): { job: any; frames: number } {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new GenError('job must be an object: { video, w, h, fps, quality, snapshot, shots }');
  if (typeof job.video !== 'string' || !SAFE_ID.test(job.video)) throw new GenError('job.video must be a video name');
  for (const k of ['w', 'h', 'fps']) if (!Number.isInteger(job[k]) || job[k] < 1 || job[k] > 4096) throw new GenError(`job.${k} must be a whole number`);
  if (job.quality != null && !['final', 'draft', 'preview', 'previs'].includes(job.quality)) throw new GenError('job.quality: final, draft, preview or previs');
  const snap = job.snapshot;
  if (!snap || (snap.kind !== 'manifest' && snap.kind !== 'git')) throw new GenError('job.snapshot must be { kind: "manifest", manifestHash } or { kind: "git", repo, commit }');
  if (snap.kind === 'manifest' && !/^[0-9a-f]{16,64}$/.test(String(snap.manifestHash))) throw new GenError('job.snapshot.manifestHash must be hex');
  if (snap.kind === 'git' && (!/^[\w.-]+\/[\w.-]+$/.test(String(snap.repo)) || !/^[0-9a-f]{7,40}$/.test(String(snap.commit)))) throw new GenError('job.snapshot: repo owner/name and a commit');
  if (!Array.isArray(job.shots) || !job.shots.length) throw new GenError('job.shots must list the shots to render');
  let frames = 0;
  for (const s of job.shots) {
    if (!SAFE_ID.test(String(s?.id)) || !/^[0-9a-f]{6,64}$/.test(String(s?.hash))) throw new GenError(`bad shot ${JSON.stringify(s?.id)}: { id, hash, f0, f1 }`);
    if (!Number.isInteger(s.f0) || !Number.isInteger(s.f1) || s.f1 <= s.f0) throw new GenError(`shot ${s.id}: f0 < f1, whole frames`);
    frames += s.f1 - s.f0;
  }
  if (job.timeoutMin != null && !(Number.isInteger(job.timeoutMin) && job.timeoutMin >= 5 && job.timeoutMin <= 180)) throw new GenError('job.timeoutMin: 5 to 180');
  return { job, frames };
}

/** The sync script: a tar of <sha256> files into the store (each verified), the manifest saved, the store listed. */
export function syncScript() {
  return [
    'set -uo pipefail',
    `FARM=${FARM_DIR}; S="$FARM/snapshots"; mkdir -p "$S/blobs" "$S/manifests" res`,
    'if [ -f in/pack.tar ]; then',
    '  mkdir -p in/x && tar -xf in/pack.tar -C in/x || { echo "HB error the pack is not a tar"; exit 3; }',
    '  ok=0; bad=0',
    '  for f in in/x/*; do [ -f "$f" ] || continue; n=$(basename "$f")',
    '    if [ "$(sha256sum "$f" | cut -c1-64)" = "$n" ]; then mv -f "$f" "$S/blobs/$n.tmp$$" && mv -f "$S/blobs/$n.tmp$$" "$S/blobs/$n"; ok=$((ok+1)); else bad=$((bad+1)); echo "HB warning $n: bytes differ from the name, dropped"; fi',
    '  done',
    '  echo "HB stored $ok blobs ($bad dropped)"',
    'fi',
    'if [ -f in/manifest.json ]; then',
    '  MH=$(python3 -c "import json;print(json.load(open(\'in/manifest.json\'))[\'hash\'])")',
    '  [[ "$MH" =~ ^[0-9a-f]{16,64}$ ]] || { echo "HB error the manifest has no hash"; exit 3; }',
    // A manifest is written only when every blob it names is in the store, so a render never meets a half tree.
    '  missing=$(python3 - "$S/blobs" <<\'EOF\'',
    'import json,os,sys',
    "m=json.load(open('in/manifest.json')); b=sys.argv[1]",
    "print(sum(1 for h in set(m['files'].values()) if not os.path.exists(os.path.join(b,h))))",
    'EOF',
    '  )',
    '  if [ "$missing" = 0 ]; then cp in/manifest.json "$S/manifests/$MH.json"; echo "HB manifest $MH saved"; else echo "HB warning manifest $MH: $missing blobs still missing, not saved"; fi',
    'fi',
    'ls "$S/blobs" | grep -E "^[0-9a-f]{64}$" > res/blobs.txt; ls "$S/manifests" > res/manifests.txt',
    'df -h "$FARM" | tail -1 | sed "s/^/HB volume /"',
    'echo "{\\"blobs\\": $(wc -l < res/blobs.txt), \\"manifests\\": $(wc -l < res/manifests.txt)}" > res/store.json',
  ].join('\n');
}

export const unityRenderTool: Tool = {
  id: 'unity.render',
  version: 1,
  title: 'Render Unity shots (render farm worker)',
  description:
    'Renders a Unity project\'s shots in a Linux Unity editor with graphics on, on a GPU worker running the unity-render image. ' +
    'mode "sync" stores the project\'s files by content on the worker volume (input pack: a tar of files named by sha256; manifest: { hash, files: { path: sha256 } }); ' +
    'mode "render" renders job.shots from a stored manifest and returns one mp4 and sidecar per shot plus worker.json; mode "check" lists what the store holds. ' +
    'Used by the TK Shock render farm (docs/unity-render.md).',
  provider: 'comfy',
  family: 'unity-render',
  image: 'unity-render',
  output: 'file',
  inputs: {
    pack: { kind: 'file', description: 'sync: a .tar of files, each named by the sha256 of its bytes.' },
    manifest: { kind: 'file', description: 'sync: { hash, files: { "<path>": "<sha256>" } }, saved once every blob it names is stored.' },
  },
  params: {
    mode: { type: 'enum', values: ['render', 'sync', 'check'], default: 'render' },
    job: { type: 'json', description: 'render: { video, w, h, fps, quality, snapshot: { kind: "manifest", manifestHash }, shots: [{ id, hash, f0, f1 }], timeoutMin, allowSoftware }' },
  },
  models: () => ['unity-6000.3.7f1'],
  // A worker's fixed minutes (license, tree, Library, editor, build) plus the frames at the A4000 class's guess (0.06 s).
  gpuSeconds: (p) => {
    if (p.mode === 'sync') return 120;
    if (p.mode === 'check') return 30;
    const frames = Array.isArray(p.job?.shots) ? p.job.shots.reduce((n: number, s: any) => n + Math.max(0, (s.f1 ?? 0) - (s.f0 ?? 0)), 0) : 0;
    return 300 + frames * (p.job?.quality === 'previs' ? 0.03 : 0.06);
  },
  guard({ params, inputs }) {
    const mode = params.mode ?? 'render';
    if (mode === 'render') checkJob(params.job);
    if (mode === 'sync' && !inputs.pack && !inputs.manifest) throw new GenError('sync needs a pack, a manifest or both');
  },
  async run(ctx) {
    const c = ctx.comfy!;
    if (!c || c.comfy) throw new GenError('unity.render runs only on an endpoint with the unity-render image (settings.gpu.providers families ["unity-render"]), never on the fleet');
    const mode = ctx.params.mode ?? 'render';
    const ws = await jobWorkspace(c, ctx.job.id);
    const out = ctx.tmp('unity');
    let lines: string[] = [];
    try {
      let script: string;
      if (mode === 'render') {
        const { job, frames } = checkJob(ctx.params.job);
        await ws.write({ 'in/job.json': JSON.stringify(job, null, 1) });
        script = 'bash /hawkes/worker.sh';
        ctx.step(`rendering ${job.shots.length} shots, ${frames} frames of ${job.video} at ${job.w}x${job.h} on ${ws.where}`);
      } else {
        const put: Record<string, string> = {};
        if (mode === 'sync' && ctx.inputs.pack) put['in/pack.tar'] = ctx.inputs.pack;
        if (mode === 'sync' && ctx.inputs.manifest) put['in/manifest.json'] = ctx.inputs.manifest;
        await ws.put(put);
        script = syncScript();
        ctx.step(mode === 'sync' ? `storing files on ${ws.where}'s volume` : `listing ${ws.where}'s store`);
      }
      const timeoutMin = mode === 'render' ? (ctx.params.job.timeoutMin ?? 80) + 15 : 30;
      await c.timed(() => ws.run(script, {
        signal: ctx.signal,
        timeoutMs: timeoutMin * 60_000,
        onLine: (line) => { lines.push(line); if (line.startsWith('step ') || line.startsWith('done') || line.startsWith('FAILED')) ctx.step(line); else ctx.log(line); },
      }));
      await ws.get('res', out);
    } finally {
      await ws.clean();
    }
    const files = fs.readdirSync(out).sort();
    const info = (name: string) => { try { return JSON.parse(fs.readFileSync(path.join(out, name), 'utf8')); } catch { return null; } };
    for (const [k, f] of files.entries()) {
      if (k < ctx.done) continue;
      const ext = path.extname(f) || '.txt';
      const file = path.join(out, f);
      if (ctx.emitFile && fs.statSync(file).size > 32 << 20) await ctx.emitFile({ file, ext, title: f });
      else await ctx.emit({ data: fs.readFileSync(file), ext, title: f });
    }
    const worker = info('worker.json');
    if (mode === 'render' && worker && worker.ok === false) ctx.log(`the worker failed: ${worker.error ?? 'see unity.log'}`);
    ctx.result({ mode, files, worker, store: info('store.json'), log: lines.slice(-40) });
  },
};
