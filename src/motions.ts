// The CC0 motion library: Quaternius's free Standard editions of Universal Animation Library 1 and 2.
// The catalog (motions/quaternius.json) is the clip list — name, tags, duration, loop — and the license.
// The zips are not in git. The first time a clip is used, its zip is downloaded, checked against the recorded
// sha256, and that one clip is written out as its own GLB. Search merges these into the library (hawkesgen_library).
// preset shared/motions retargets a list of them onto a character and files each one on that character's entity.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.ts';
import { getEntity, toSlug } from './entities.ts';
import type { Client } from './auth.ts';
import { GenError } from './util.ts';

const MAX_CLIPS = 16;

type ClipRow = { name: string; tags: string[]; duration: number; loop: boolean };
type Pack = {
  id: string; title: string; edition: string; released: string; sourceUrl: string; sourcePage: string; authorPage: string;
  license: string; licenseFile: string; zipSha256: string; glbEntry: string; glbSha256: string; bones: string; note: string;
  clips: ClipRow[];
};

export type MotionClip = {
  pack: string; packTitle: string; name: string; tags: string[]; duration: number; loop: boolean; bones: string; license: string;
};

export type MotionHit = {
  id: string; kind: 'file'; project: 'shared'; tool: 'motion.library'; title: string; tags: string[];
  mime: string; bytes: number;
  labels: { pack: string; action: string; license: string };
  meta: { duration: number; loop: boolean; pack: string; license: string };
  recipe: { tool: string; version: number; params: { clip: string }; inputs: Record<string, never> };
  created: number;
};

let packsCache: Pack[] | null = null;

function packs(): Pack[] {
  if (!packsCache) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'motions', 'quaternius.json'), 'utf8'));
    packsCache = raw.packs;
  }
  return packsCache!;
}

function packOf(id: string): Pack {
  const p = packs().find((x) => x.id === id);
  if (!p) throw new GenError(`No motion pack ${id}`);
  return p;
}

export function allClips(): MotionClip[] {
  const out: MotionClip[] = [];
  for (const p of packs()) {
    for (const c of p.clips) out.push({ pack: p.id, packTitle: p.title, name: c.name, tags: c.tags, duration: c.duration, loop: c.loop, bones: p.bones, license: p.license });
  }
  return out;
}

/** "motion:ual1/Walk_Loop", "ual1/Walk_Loop" or "Walk_Loop" (when only one pack has that name). */
export function findClip(ref: string): MotionClip {
  const id = String(ref).replace(/^motion:/, '').trim();
  const clips = allClips();
  const slash = id.indexOf('/');
  if (slash > 0) {
    const hit = clips.find((c) => c.pack === id.slice(0, slash) && c.name === id.slice(slash + 1));
    if (!hit) throw new GenError(`No motion clip ${id}. Search the library for locomotion, melee, hit, death or idle.`);
    return hit;
  }
  const exact = clips.filter((c) => c.name === id);
  const hits = exact.length ? exact : clips.filter((c) => c.name.toLowerCase() === id.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new GenError(`No motion clip ${id}. Search the library for locomotion, melee, hit, death or idle.`);
  throw new GenError(`${id} is in more than one pack: ${hits.map((c) => `${c.pack}/${c.name}`).join(', ')}`);
}

export function motionRecord(ref: string): MotionHit {
  return hit(findClip(ref));
}

function hit(c: MotionClip): MotionHit {
  const released = packOf(c.pack).released;
  return {
    id: `motion:${c.pack}/${c.name}`, kind: 'file', mime: 'model/gltf-binary', bytes: 0, project: 'shared', tool: 'motion.library', title: c.name, tags: c.tags,
    labels: { pack: c.packTitle, action: c.name, license: 'CC0-1.0' },
    meta: { duration: c.duration, loop: c.loop, pack: c.pack, license: 'CC0-1.0' },
    recipe: { tool: 'motion.library', version: 1, params: { clip: c.name }, inputs: {} },
    created: Date.parse(`${released}T00:00:00Z`) || 0,
  };
}

/** Clips whose name, pack or tags contain every word. */
export function searchMotions(text: string, opt: { limit?: number; offset?: number } = {}) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = allClips().filter((c) => {
    const hay = `${c.pack} ${c.packTitle} ${c.name} ${c.tags.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const offset = Math.max(0, opt.offset ?? 0);
  const limit = Math.max(1, Math.min(200, opt.limit ?? 60));
  return { items: hits.slice(offset, offset + limit).map(hit), total: hits.length };
}

/**
 * What to add to a library search. Motions show up when the text matches, or when the tool filter is motion.library.
 * They are not mixed into an unfiltered browse of everything Gen has made.
 */
export function motionsForQuery(q: { text?: string; tool?: string; kind?: string; job?: string; starred?: boolean; limit?: number; offset?: number }) {
  if (q.job || q.starred) return { items: [] as MotionHit[], total: 0 };
  if (q.kind && q.kind !== 'file') return { items: [] as MotionHit[], total: 0 };
  if (q.tool && q.tool !== 'motion.library') return { items: [] as MotionHit[], total: 0 };
  const only = q.tool === 'motion.library';
  if (!only && !String(q.text ?? '').trim()) return { items: [] as MotionHit[], total: 0 };
  return searchMotions(q.text ?? '', { limit: only ? q.limit : 80, offset: only ? (q.offset ?? 0) : 0 });
}

// ---------------------------------------------------------------- one clip, as its own GLB

const EXTRACT = `
import sys, zipfile
zpath, entry, dest = sys.argv[1:]
with zipfile.ZipFile(zpath) as z:
    open(dest, "wb").write(z.read(entry))
`;

const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function readGlb(buf: Buffer): { json: any; bin: Buffer } {
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new GenError('motion pack is not a GLB');
  let off = 12;
  let json: any = null;
  let bin = Buffer.alloc(0);
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
    if (type === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004E4942) bin = Buffer.from(chunk);
  }
  if (!json) throw new GenError('motion pack GLB has no JSON');
  const n = json.buffers?.[0]?.byteLength;
  if (typeof n === 'number' && n < bin.length) bin = bin.subarray(0, n);
  return { json, bin };
}

function writeGlb(json: any, bin: Buffer): Buffer {
  let jsonBuf = Buffer.from(JSON.stringify(json));
  const jpad = (4 - (jsonBuf.length % 4)) % 4;
  if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]);
  const bpad = (4 - (bin.length % 4)) % 4;
  const binPadded = bpad ? Buffer.concat([bin, Buffer.alloc(bpad)]) : bin;
  const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let at = 12;
  out.writeUInt32LE(jsonBuf.length, at);
  out.writeUInt32LE(0x4E4F534A, at + 4);
  jsonBuf.copy(out, at + 8);
  at += 8 + jsonBuf.length;
  out.writeUInt32LE(binPadded.length, at);
  out.writeUInt32LE(0x004E4942, at + 4);
  binPadded.copy(out, at + 8);
  return out;
}

/** A GLB that keeps the skeleton and mesh, and only this one animation. */
export function sliceClip(glb: Buffer, clipName: string): Buffer {
  const { json, bin } = readGlb(glb);
  const anims: any[] = json.animations ?? [];
  const anim = anims.find((a) => a.name === clipName);
  if (!anim) throw new GenError(`No animation ${clipName} in this motion pack`);
  const used = new Set<number>();
  for (const s of anim.samplers ?? []) {
    used.add(s.input);
    used.add(s.output);
  }
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const v of Object.values<number>(prim.attributes ?? {})) used.add(v);
      if (typeof prim.indices === 'number') used.add(prim.indices);
    }
  }
  for (const skin of json.skins ?? []) if (typeof skin.inverseBindMatrices === 'number') used.add(skin.inverseBindMatrices);

  const viewOf = new Map<number, number>();
  const newViews: any[] = [];
  const chunks: Buffer[] = [];
  let cursor = 0;
  const takeView = (vi: number) => {
    const have = viewOf.get(vi);
    if (have !== undefined) return have;
    const v = json.bufferViews[vi];
    if (!v) throw new GenError(`motion pack is missing buffer view ${vi}`);
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    const start = v.byteOffset ?? 0;
    chunks.push(Buffer.from(bin.subarray(start, start + v.byteLength)));
    const id = newViews.length;
    const next: any = { buffer: 0, byteOffset: cursor, byteLength: v.byteLength };
    if (v.byteStride) next.byteStride = v.byteStride;
    if (v.target) next.target = v.target;
    newViews.push(next);
    viewOf.set(vi, id);
    cursor += v.byteLength;
    return id;
  };

  const accMap = new Map<number, number>();
  const newAcc: any[] = [];
  for (const ai of [...used].sort((a, b) => a - b)) {
    const a = json.accessors[ai];
    if (!a || a.sparse || a.bufferView == null) throw new GenError(`animation ${clipName} could not be split out of the pack`);
    accMap.set(ai, newAcc.length);
    newAcc.push({ ...a, bufferView: takeView(a.bufferView) });
  }
  const remap = (n: number) => {
    const v = accMap.get(n);
    if (v == null) throw new GenError(`animation ${clipName} could not be split out of the pack`);
    return v;
  };
  const one = structuredClone(anim);
  for (const s of one.samplers) {
    s.input = remap(s.input);
    s.output = remap(s.output);
  }
  const meshes = structuredClone(json.meshes ?? []);
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      for (const k of Object.keys(prim.attributes ?? {})) prim.attributes[k] = remap(prim.attributes[k]);
      if (typeof prim.indices === 'number') prim.indices = remap(prim.indices);
    }
  }
  const skins = structuredClone(json.skins ?? []);
  for (const skin of skins) if (typeof skin.inverseBindMatrices === 'number') skin.inverseBindMatrices = remap(skin.inverseBindMatrices);

  return writeGlb({
    asset: json.asset, scene: json.scene ?? 0, scenes: json.scenes, nodes: json.nodes, meshes, skins,
    materials: json.materials, animations: [one], accessors: newAcc, bufferViews: newViews, buffers: [{ byteLength: cursor }],
  }, Buffer.concat(chunks));
}

function ensurePackGlb(pack: Pack): string {
  const dir = path.join(DATA_DIR, 'motions', 'packs');
  fs.mkdirSync(dir, { recursive: true });
  const glbPath = path.join(dir, `${pack.id}.glb`);
  if (fs.existsSync(glbPath) && sha(fs.readFileSync(glbPath)) === pack.glbSha256) return glbPath;
  const zipPath = path.join(dir, `${pack.id}.zip`);
  if (!fs.existsSync(zipPath) || sha(fs.readFileSync(zipPath)) !== pack.zipSha256) {
    const tmp = `${zipPath}.part`;
    try {
      execFileSync('curl', ['-fsSL', '--retry', '2', '--max-time', '180', '-o', tmp, pack.sourceUrl], { timeout: 200_000 });
    } catch (e: any) {
      fs.rmSync(tmp, { force: true });
      throw new GenError(`Could not download ${pack.title} (${pack.sourcePage}): ${e.message ?? e}`);
    }
    if (sha(fs.readFileSync(tmp)) !== pack.zipSha256) {
      fs.rmSync(tmp, { force: true });
      throw new GenError(`The download of ${pack.title} did not match the CC0 file this catalog records. It was not imported.`);
    }
    fs.renameSync(tmp, zipPath);
  }
  const tmpGlb = `${glbPath}.part`;
  try {
    execFileSync('python3', ['-c', EXTRACT, zipPath, pack.glbEntry, tmpGlb], { timeout: 60_000 });
  } catch (e: any) {
    fs.rmSync(tmpGlb, { force: true });
    throw new GenError(`Could not read the GLB out of ${pack.title}: ${e.message ?? e}`);
  }
  if (sha(fs.readFileSync(tmpGlb)) !== pack.glbSha256) {
    fs.rmSync(tmpGlb, { force: true });
    throw new GenError(`${pack.title} extracted, but the GLB did not match the recorded file. It was not imported.`);
  }
  fs.renameSync(tmpGlb, glbPath);
  return glbPath;
}

/** The local GLB for one clip. Downloads the free CC0 zip the first time. */
export function motionFile(ref: string): string {
  const clip = findClip(ref);
  if (!/^[\w.-]+$/.test(clip.name)) throw new GenError(`Bad clip name ${clip.name}`);
  const dest = path.join(DATA_DIR, 'motions', 'clips', clip.pack, `${clip.name}.glb`);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const sliced = sliceClip(fs.readFileSync(ensurePackGlb(packOf(clip.pack))), clip.name);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, sliced);
  fs.renameSync(tmp, dest);
  return dest;
}

// ---------------------------------------------------------------- put these clips on a character

/**
 * params.clips (["Walk_Loop", "ual2/Melee_Hook"]) on blender.character becomes a retarget and an export per clip.
 * params.entity (project/slug) files each GLB on animation/<name>. The character is inputs.files[0].
 * Returns null when the job isn't asking for library clips.
 */
export function expandMotionRequest(client: Client, spec: { tool?: string; params?: Record<string, any>; inputs?: Record<string, any>; labels?: Record<string, unknown> }) {
  const raw = spec.params?.clips;
  if (raw == null || raw === '') return null;
  let list: unknown = raw;
  if (typeof list === 'string') {
    const s = list.trim();
    if (s.startsWith('[')) {
      try { list = JSON.parse(s); } catch { throw new GenError('clips is a list of motion library names, like ["Walk_Loop", "ual2/Melee_Hook"]'); }
    } else list = s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (!Array.isArray(list) || !list.length || list.some((c) => typeof c !== 'string' || !c.trim())) throw new GenError('clips is a list of motion library names, like ["Walk_Loop", "ual2/Melee_Hook"]');
  if (spec.tool !== 'blender.character') throw new GenError('clips is for blender.character (preset shared/motions)');
  if (spec.params?.ops) throw new GenError('pass clips or ops, not both');
  if (list.length > MAX_CLIPS) throw new GenError(`at most ${MAX_CLIPS} clips in one job (this list has ${list.length})`);
  const found = list.map((c) => findClip(String(c)));
  const files0 = spec.inputs?.files;
  const character = Array.isArray(files0) ? files0[0] : files0;
  if (typeof character !== 'string' || !character) throw new GenError('the character is inputs.files[0] (a GLB or FBX, asset:<id>, or slot:./rig)');
  if (Array.isArray(files0) && files0.length > 1) throw new GenError('with clips, inputs.files is only the character; the clips come from the motion library');
  const entity = spec.params?.entity ?? spec.labels?.entity;
  if (!entity) throw new GenError('entity is the character the clips are filed on (project/slug)');
  getEntity(client, String(entity));

  const used = new Set<string>();
  const planned = found.map((c) => {
    let part = toSlug(c.name) || 'clip';
    if (used.has(part)) part = toSlug(`${c.pack}-${c.name}`) || `${part}-2`;
    used.add(part);
    return { clip: c, part };
  });
  const preview = spec.params?.preview === true || spec.params?.preview === 'true';
  const ops: Record<string, unknown>[] = [{ op: 'import', file: 0, clips: false }];
  planned.forEach((p, i) => ops.push({ op: 'retarget', file: i + 1, from: p.clip.bones, name: p.part }));
  for (const p of planned) ops.push({ op: 'export', format: 'glb', name: p.part, clips: [p.part], title: p.part });
  if (preview) ops.push({ op: 'preview', turntable: false, clips: planned.map((p) => p.part) });
  const slots: Record<string, string> = {};
  for (const p of planned) {
    slots[p.part] = `animation/${p.part}`;
    if (preview) slots[`preview/${p.part}`] = `preview/${p.part}`;
  }
  const params = { ...(spec.params ?? {}) };
  delete params.clips;
  delete params.entity;
  delete params.preview;
  params.ops = ops;
  return {
    params,
    inputs: { ...(spec.inputs ?? {}), files: [character, ...planned.map((p) => `motion:${p.clip.pack}/${p.clip.name}`)] },
    labels: {
      ...(spec.labels ?? {}),
      entity: String(entity),
      slot: `animation/${planned[0].part}`,
      slots,
      note: spec.labels?.note ?? `CC0 motion library: ${planned.map((p) => p.clip.name).join(', ')}`,
    },
  };
}
