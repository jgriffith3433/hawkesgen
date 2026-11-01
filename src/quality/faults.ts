// The obvious failures per kind (docs/bench.md, "Faults"):
//   image  a flat or blank picture (ffmpeg), then what a viewer sees at a glance (hands, faces, limbs, text: judge.ts)
//   video  flat or broken frames and flicker (ffmpeg signalstats over the first 10 s), then the same look over 4 frames
//   mesh   the GLB itself: it parses, has triangles, no NaN or infinite positions, isn't flat or a speck, and its
//          triangle count is within a game's budget (blender.character's report measures more, on a GPU server: too
//          dear for a check that runs on every take)
//   audio  the audio gate every sound already passes (src/audio/post.ts judge: silent, clipped, long silences)

import fs from 'node:fs';
import type { FaultResult, OutputKind } from './index.ts';
import { flickerOf, frameStats, isFlat } from './media.ts';
import { mockFaults, qualityMock } from './mock.ts';
import { visualFaults } from './judge.ts';

/** Triangles above this are a fault for a game asset (a hero character is about 50k; docs/art-playbook.md budgets). */
export const MESH_TRIANGLE_LIMIT = 300_000;

export type MeshFacts = { meshes: number; triangles: number; vertices: number; nan: number; size: [number, number, number] | null; materials: number; note?: string };

/** What a GLB holds, read with gltf-transform (Draco-compressed geometry can't be read here: `note` says so). */
export async function meshFacts(file: string): Promise<MeshFacts> {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let doc;
  try {
    doc = await io.readBinary(new Uint8Array(fs.readFileSync(file)));
  } catch (e: any) {
    if (/draco/i.test(String(e?.message))) return { meshes: 0, triangles: 0, vertices: 0, nan: 0, size: null, materials: 0, note: 'Draco-compressed: geometry not checked' };
    throw e;
  }
  const root = doc.getRoot();
  let triangles = 0;
  let vertices = 0;
  let nan = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const n = pos.getCount();
      vertices += n;
      const idx = prim.getIndices();
      const mode = prim.getMode();
      const count = idx ? idx.getCount() : n;
      if (mode === 4) triangles += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
      const v = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        if (!v.every(Number.isFinite)) { nan++; continue; }
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
      }
    }
  }
  const size = Number.isFinite(lo[0]) ? (hi.map((h, k) => Math.round((h - lo[k]) * 1000) / 1000) as [number, number, number]) : null;
  return { meshes: root.listMeshes().length, triangles, vertices, nan, size, materials: root.listMaterials().length };
}

/** The faults in a mesh's facts. */
export function meshFaults(f: MeshFacts): string[] {
  if (f.note) return [];
  const out: string[] = [];
  if (!f.meshes || !f.triangles) out.push('the model has no geometry');
  if (f.nan) out.push(`${f.nan} vertices have broken (NaN or infinite) positions`);
  if (f.size) {
    const big = Math.max(...f.size);
    const sorted = [...f.size].sort((a, b) => a - b);
    if (big <= 1e-6) out.push('the model is a single point');
    else if (sorted[0] / big < 0.002) out.push('the model is flat (a sheet, not a solid)');
  }
  if (f.triangles > MESH_TRIANGLE_LIMIT) out.push(`${f.triangles.toLocaleString('en')} triangles, over a game's budget of ${MESH_TRIANGLE_LIMIT.toLocaleString('en')}`);
  return out;
}

export async function faultCheckImpl(a: { kind: OutputKind; file: string }): Promise<FaultResult> {
  if (qualityMock()) return mockFaults(a.file, a.kind);
  if (!fs.existsSync(a.file) || fs.statSync(a.file).size === 0) return { ok: false, faults: ['the file is empty or missing'] };
  const faults: string[] = [];
  if (a.kind === 'mesh') {
    try {
      faults.push(...meshFaults(await meshFacts(a.file)));
    } catch (e: any) {
      faults.push(`the model doesn't open: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    return { ok: !faults.length, faults };
  }
  if (a.kind === 'audio') {
    const { analyze, judge } = await import('../audio/post.ts');
    const v = judge(await analyze(a.file), { maxSilence: 1.5 });
    return { ok: v.ok, faults: v.problems };
  }
  const stats = await frameStats(a.file).catch(() => []);
  if (!stats.length) return { ok: false, faults: ['the file has no readable picture'] };
  const flat = stats.filter(isFlat).length;
  if (a.kind === 'image' && flat) return { ok: false, faults: ['the picture is blank (one flat color)'] };
  if (a.kind === 'video') {
    if (flat === stats.length) return { ok: false, faults: ['every frame is blank (one flat color)'] };
    if (flat) faults.push(`${flat} blank frame${flat > 1 ? 's' : ''}`);
    const fl = flickerOf(stats);
    if (fl.frames >= 2) faults.push(`flicker: the brightness jumps and comes back on ${fl.frames} frames`);
  }
  faults.push(...(await visualFaults({ kind: a.kind, file: a.file })));
  return { ok: !faults.length, faults };
}
