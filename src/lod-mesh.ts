// A GLB's levels of detail, run by src/lod.ts as its own low-priority process (simplifying a big mesh takes seconds of
// CPU, and the service's HTTP server must never wait on it). Everything is JavaScript and WebAssembly (gltf-transform,
// meshoptimizer, Draco): nothing to install on the control server, and no GPU server is ever woken for it.
//
//   node src/lod-mesh.ts <plan.json>
//   plan: { in, out (a path stem), python, script (post/lod.py), source? (a low copy a job already made: its geometry
//           is used for the low level instead of simplifying again) }
// Prints one JSON line: { triangles, texture (biggest texture, px), draco, levels: [{ level (triangles), texture, path,
// bytes, role }] }.
//
// The levels (each only when it pays):
//   high  every triangle, textures at most 2048 px and as WebP: when that's a much smaller file (a 4096 px base colour,
//         PNGs inside)
//   mid   about 40% of the triangles (at most 50,000), textures at most 1024 px (a phone's near copy)
//   low   about 12% of the triangles (at most 10,000), textures an eighth of the model's, 128 to 256 px (far away: it
//         covers a few dozen pixels on screen)
// A model that came Draco-compressed stays Draco (the engine already has the decoder for it); others are quantized,
// which every glTF loader reads with no decoder.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Logger, NodeIO, type Document, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, simplify, weld, draco } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

export const MESH_LEVELS = [
  { role: 'high', ratio: 1, most: Infinity, error: 0, texture: 2048 },
  { role: 'mid', ratio: 0.4, most: 50_000, error: 0.01, texture: 1024 },
  { role: 'low', ratio: 0.12, most: 10_000, error: 0.05, texture: 256, eighth: true },
];
/** Below this many triangles a model is cheap already: only its textures get smaller copies. */
const SMALL = 600;

type Plan = { in: string; out: string; python: string; script: string; source?: string };

async function io() {
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  return new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}

export function triangles(doc: Document) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) continue; // TRIANGLES only (lines and points aren't drawn as surfaces)
    const idx = p.getIndices();
    n += Math.floor((idx ? idx.getCount() : p.getAttribute('POSITION')?.getCount() ?? 0) / 3);
  }
  return n;
}
const textureSize = (t: Texture) => Math.max(...(t.getSize() ?? [0, 0]));
export const biggestTexture = (doc: Document) => Math.max(0, ...doc.getRoot().listTextures().map(textureSize));

/** Every texture over `cap` px (and every PNG/JPEG when WebP is smaller), as WebP, in one Python call per level. */
function shrinkTextures(doc: Document, cap: number, plan: Plan, tag: string) {
  const tmp = `${plan.out}.${tag}.tex`;
  fs.mkdirSync(tmp, { recursive: true });
  const jobs: { in: string; out: string; max: number }[] = [];
  const list = doc.getRoot().listTextures();
  list.forEach((t, i) => {
    const img = t.getImage();
    if (!img) return;
    const ext = t.getMimeType() === 'image/jpeg' ? '.jpg' : t.getMimeType() === 'image/webp' ? '.webp' : '.png';
    const file = path.join(tmp, `${i}${ext}`);
    fs.writeFileSync(file, img);
    jobs.push({ in: file, out: path.join(tmp, `${i}.out.webp`), max: cap });
  });
  if (!jobs.length) return;
  const planFile = path.join(tmp, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ textures: jobs }));
  const r = spawnSync(plan.python, [plan.script, planFile], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`lod.py: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  const got = JSON.parse(r.stdout.trim().split('\n').pop()!).textures as any[];
  let webp = false;
  jobs.forEach((j, k) => {
    const g = got[k];
    if (!g || g.error || g.kept || !fs.existsSync(j.out)) return;
    const t = list[Number(path.basename(j.in).split('.')[0])];
    t.setImage(new Uint8Array(fs.readFileSync(j.out))).setMimeType('image/webp');
    t.setURI(t.getURI().replace(/\.(png|jpe?g)$/i, '.webp'));
    webp = true;
  });
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function compress(doc: Document, dracoIn: boolean) {
  if (dracoIn) {
    doc.createExtension(KHRDracoMeshCompression).setRequired(true);
    await doc.transform(draco({ method: 'edgebreaker' }));
  } else {
    for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName === KHRDracoMeshCompression.EXTENSION_NAME) e.dispose();
    await doc.transform(quantize());
  }
}

export async function meshLods(plan: Plan) {
  const reader = await io();
  const bytes = new Uint8Array(fs.readFileSync(plan.in));
  const first = await reader.readBinary(bytes);
  const tris = triangles(first);
  const tex = biggestTexture(first);
  const dracoIn = first.getRoot().listExtensionsUsed().some((e) => e.extensionName === KHRDracoMeshCompression.EXTENSION_NAME);
  const out: { level: number; texture: number; path: string; bytes: number; role: string }[] = [];
  for (const L of MESH_LEVELS) {
    const cap = Math.min(L.texture, tex || L.texture, (L as any).eighth && tex ? Math.max(128, tex / 8) : Infinity);
    const fewer = L.ratio < 1 && tris > SMALL;
    // high is tried for every textured model (it's kept only when its file is much smaller: PNGs inside as WebP, 4096 px
    // textures at 2048); mid only when it's really between the model and its low.
    if (L.role === 'high' && !tex) continue;
    if (L.role === 'mid' && tex <= L.texture && tris < 6000) continue;
    if (L.role === 'low' && !fewer && tex <= L.texture) continue;
    // The low level starts from the job's own low copy when there is one (Blender already decimated it well).
    const fromSource = L.role === 'low' && plan.source && fs.existsSync(plan.source);
    const doc = await reader.readBinary(fromSource ? new Uint8Array(fs.readFileSync(plan.source!)) : bytes);
    if (fewer && !fromSource) {
      // (A scan-sized mesh, 700k triangles, still gets a low of at most `most`.)
      const ratio = Math.max(0.005, Math.min(L.ratio, L.most / tris));
      if (L.role === 'low') {
        // As few triangles as keep the shape within 1% of its size first (a flat-sided crate becomes a box), then at
        // most the ratio whatever the error.
        await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.01, error: 0.01 }));
        const now = triangles(doc);
        if (now > tris * ratio) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: (tris * ratio) / now, error: L.error }));
      } else {
        await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: L.error }));
      }
    }
    shrinkTextures(doc, cap, plan, L.role);
    await doc.transform(prune(), dedup());
    await compress(doc, dracoIn);
    const n = triangles(doc);
    const t = biggestTexture(doc);
    if (out.some((o) => o.level === n)) continue;
    const data = await reader.writeBinary(doc);
    // Nothing gained (the same triangles and textures as the model, and a file not a fifth smaller): not kept.
    if (n >= tris && t >= tex && data.length > bytes.length * 0.8) continue;
    const file = `${plan.out}.${L.role}.glb`;
    fs.writeFileSync(file, data);
    out.push({ level: n, texture: t, path: file, bytes: data.length, role: L.role });
  }
  return { triangles: tris, texture: tex, draco: dracoIn, levels: out };
}

// Run as a script (src/lod.ts starts it): the plan in, the levels out.
if (/lod-mesh\.ts$/.test(process.argv[1] ?? '')) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Plan;
  meshLods(plan).then((r) => { console.log(JSON.stringify(r)); }, (e) => { console.error(e?.stack ?? e); process.exit(1); });
}
