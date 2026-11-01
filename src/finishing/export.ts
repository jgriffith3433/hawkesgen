// The world export pack (docs/finishing.md, Phase 7 of docs/worlds-roadmap.md): a world as a zip a game can load.
// From worldContext: every character's rigged model (GLB, FBX when there is one), their pictures and voice samples;
// places (panoramas as skyboxes, 3D sets, ambience); props (GLBs); the look (palette, LUT); and world.json, the manifest
// (ids, names, descriptions, canon, file paths, and every file's recipe). Unity (clients/unity/com.hawkes.gen
// WorldPackImporter.cs) and web games (clients/js/hawkes-world.mjs) load it; so can Hawkes Games and the portal.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { worldContext, type WorldContext, type WorldMember } from '../worlds.ts';
import { getAsset, type Asset } from '../library.ts';
import { identityPack } from '../identity.ts';
import { GenError } from '../util.ts';

export const PACK_FORMAT = 'hawkes.world/1';

// ------------------------------------------------------------------------------------------------ zip

const DOS_EPOCH = (d: Date) => {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
};

/** A plain zip (deflate, or stored for files that are already compressed). No dependency: node's zlib. */
export function zip(entries: { name: string; data: Buffer }[], when = new Date()): Buffer {
  const { time, date } = DOS_EPOCH(when);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (seen.has(name)) throw new GenError(`zip: ${name} twice`);
    seen.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;
    const packed = /\.(png|jpe?g|webp|glb|mp4|mp3|ogg|zip|gz|fbx)$/i.test(name) ? null : zlib.deflateRawSync(e.data, { level: 6 });
    const method = packed && packed.length < e.data.length ? 8 : 0;
    const body = method === 8 ? packed! : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  if (offset > 0xffffffff || entries.length > 0xffff) throw new GenError('The pack is too big for a zip (over 4 GB or 65,535 files)');
  return Buffer.concat([...locals, cd, end]);
}

/** Reads a zip made by zip() (tests, and checking a pack): name -> contents. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new GenError('not a zip');
  const n = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(at + 26), lxlen = buf.readUInt16LE(at + 28);
    const body = buf.subarray(at + 30 + lnlen + lxlen, at + 30 + lnlen + lxlen + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the manifest

/** A file in the pack, with where it came from: its library id, content hash and recipe (ownership and history). */
export type PackFile = {
  path: string; role: string; asset: string; kind: string; mime: string; bytes: number; sha256: string;
  recipe: { tool: string; version: number; params: Record<string, unknown>; inputs: Record<string, unknown>; seed: number | null; made: string; job: string | null };
  meta?: Record<string, unknown>;
};

export type PackMember = { id: string; name: string; description: string; files: string[] };

export type WorldManifest = {
  format: typeof PACK_FORMAT;
  world: { id: string; name: string; canon: string[] };
  look: { style: string; negative: string; palette: string[]; grade: { lut: string | null; params: Record<string, number> | null }; board: string[] };
  characters: (PackMember & { model: string | null; fbx: string | null; voice: { id: string | null; samples: string[] }; pictures: string[]; clips: { name: string; file: string | null }[]; height?: number })[];
  places: (PackMember & { skybox: string | null; set: string | null; ambience: string | null; pictures: string[] })[];
  props: (PackMember & { model: string | null; pictures: string[] })[];
  files: PackFile[];
  made: { by: string; at: string; tool: string };
  missing: string[];
};

/** A slug for paths: lower case, dashes, never empty. */
export const slug = (s: string, fallback = 'item') => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || fallback;

export type PackSource = {
  /** The world, as worldContext gives it. */
  world: WorldContext;
  /** The scene document behind a member (a character's model, voice and clips), when there is one. */
  docOf?: (id: string) => any;
  /** An asset by id (default: the library). */
  asset?: (id: string) => Pick<Asset, 'id' | 'path' | 'kind' | 'mime' | 'bytes' | 'sha256' | 'recipe' | 'meta' | 'job' | 'created' | 'title'> | null;
  /** A voice's sample clips (asset ids or local files), when the voice has saved ones. */
  voiceSamples?: (voice: string) => string[];
};

const extOf = (a: { path: string; mime: string }) => path.extname(a.path) || ({ 'model/gltf-binary': '.glb', 'image/png': '.png', 'audio/wav': '.wav' } as Record<string, string>)[a.mime] || '.bin';
const isPanorama = (a: { meta?: any }) => { const w = Number(a.meta?.width), h = Number(a.meta?.height); return w > 0 && h > 0 && Math.abs(w / h - 2) < 0.15; };

/**
 * The pack's plan: every file with its path in the zip and its recipe, and the manifest. Pure apart from reading assets
 * through `source.asset`; the tool reads the files and zips them.
 */
export function planPack(src: PackSource, o: { by?: string } = {}): { manifest: WorldManifest; files: { path: string; file: string }[] } {
  const w = src.world;
  const getA = src.asset ?? getAsset;
  const files: { path: string; file: string }[] = [];
  const meta: PackFile[] = [];
  const missing: string[] = [];
  const used = new Map<string, string>();
  const take = (id: string | null | undefined, dir: string, base: string, role: string): string | null => {
    if (!id) return null;
    const cached = used.get(`${id}|${dir}`);
    if (cached) return cached;
    const a = getA(id);
    if (!a || !fs.existsSync(a.path)) { missing.push(`${dir}/${base}: ${id}`); return null; }
    let p = `${dir}/${base}${extOf(a)}`;
    for (let i = 2; files.some((f) => f.path === p); i++) p = `${dir}/${base}-${i}${extOf(a)}`;
    files.push({ path: p, file: a.path });
    meta.push({
      path: p, role, asset: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, sha256: a.sha256,
      recipe: { tool: a.recipe?.tool ?? 'upload', version: a.recipe?.version ?? 0, params: a.recipe?.params ?? {}, inputs: a.recipe?.inputs ?? {}, seed: a.recipe?.seed ?? null, made: new Date(a.created ?? Date.now()).toISOString(), job: a.job ?? null },
      ...(a.meta && Object.keys(a.meta).length ? { meta: a.meta } : {}),
    });
    used.set(`${id}|${dir}`, p);
    return p;
  };
  const kinds = (ids: string[], where: string) => ids.map((id) => {
    const a = getA(id);
    if (!a) missing.push(`${where}: ${id}`);
    return { id, a };
  }).filter((x) => x.a) as { id: string; a: NonNullable<ReturnType<typeof getA>> }[];
  const names = new Set<string>();
  const dirFor = (group: string, m: WorldMember) => {
    let s = slug(m.title, m.id);
    for (let i = 2; names.has(`${group}/${s}`); i++) s = `${slug(m.title, m.id)}-${i}`;
    names.add(`${group}/${s}`);
    return `${group}/${s}`;
  };

  const characters: WorldManifest['characters'] = w.characters.map((m) => {
    const dir = dirFor('characters', m);
    const doc = src.docOf?.(m.id) ?? null;
    const pack = doc ? identityPack(doc) : null;
    const refs = [...new Set([...(pack?.refs ?? []), ...m.refs])];
    const all = kinds(refs, dir);
    const modelId = pack?.model ?? all.find((x) => x.a.kind === 'mesh')?.id ?? null;
    const model = take(modelId, dir, 'model', 'character.model');
    const fbxId = doc?.model?.fbx ?? all.find((x) => /\.fbx$/i.test(x.a.path))?.id ?? null;
    const fbx = take(fbxId, dir, 'model', 'character.fbx');
    const pictures = all.filter((x) => x.a.kind === 'image').map((x, i) => take(x.id, `${dir}/pictures`, i === 0 && pack?.sheet === x.id ? 'sheet' : `picture-${i + 1}`, 'character.picture')).filter(Boolean) as string[];
    const voiceId = typeof doc?.voice === 'string' ? doc.voice : null;
    const samples = [...(voiceId ? src.voiceSamples?.(voiceId) ?? [] : []), ...all.filter((x) => x.a.kind === 'audio').map((x) => x.id)];
    const sampleFiles = samples.map((id, i) => take(id, `${dir}/voice`, `sample-${i + 1}`, 'character.voice')).filter(Boolean) as string[];
    const clips = (Array.isArray(doc?.clips) ? doc.clips : []).map((c: any) => ({ name: String(c.name), file: take(c.asset, `${dir}/clips`, slug(c.name, 'clip'), 'character.clip') }));
    const own = [model, fbx, ...pictures, ...sampleFiles, ...clips.map((c: any) => c.file)].filter(Boolean) as string[];
    return {
      id: m.id, name: m.title, description: pack?.description || m.description, files: own, model, fbx, voice: { id: voiceId, samples: sampleFiles }, pictures, clips,
      ...(Number(doc?.height) > 0 ? { height: Number(doc.height) } : {}),
    };
  });

  const places: WorldManifest['places'] = w.places.map((m) => {
    const dir = dirFor('places', m);
    const all = kinds(m.refs, dir);
    const images = all.filter((x) => x.a.kind === 'image');
    const pano = images.find((x) => isPanorama(x.a)) ?? null;
    const skybox = take(pano?.id, dir, 'skybox', 'place.skybox');
    const set = take(all.find((x) => x.a.kind === 'mesh')?.id, dir, 'set', 'place.set');
    const ambience = take(all.find((x) => x.a.kind === 'audio')?.id, dir, 'ambience', 'place.ambience');
    const pictures = images.filter((x) => x !== pano).map((x, i) => take(x.id, `${dir}/views`, `view-${i + 1}`, 'place.view')).filter(Boolean) as string[];
    return { id: m.id, name: m.title, description: m.description, files: [skybox, set, ambience, ...pictures].filter(Boolean) as string[], skybox, set, ambience, pictures };
  });

  const props: WorldManifest['props'] = w.props.map((m) => {
    const dir = dirFor('props', m);
    const all = kinds(m.refs, dir);
    const model = take(all.find((x) => x.a.kind === 'mesh')?.id, dir, 'model', 'prop.model');
    const pictures = all.filter((x) => x.a.kind === 'image').map((x, i) => take(x.id, `${dir}/pictures`, `picture-${i + 1}`, 'prop.picture')).filter(Boolean) as string[];
    return { id: m.id, name: m.title, description: m.description, files: [model, ...pictures].filter(Boolean) as string[], model, pictures };
  });

  const lut = take(w.look.grade?.lut, 'look', 'grade', 'look.lut');
  const board = kinds(w.look.board, 'look/board').map((x) => x.id).map((id, i) => take(id, 'look/board', `board-${i + 1}`, 'look.board')).filter(Boolean) as string[];

  const manifest: WorldManifest = {
    format: PACK_FORMAT,
    world: { id: w.worldId, name: w.title, canon: w.canon },
    look: { style: w.look.style, negative: w.look.negative, palette: w.look.palette, grade: { lut, params: w.look.grade?.params ?? null }, board },
    characters, places, props, files: meta,
    made: { by: o.by ?? 'Hawkes Gen', at: new Date().toISOString(), tool: 'world.export' },
    missing,
  };
  return { manifest, files };
}

/** The palette as a GIMP palette file (Unity, Krita, Aseprite and most paint tools read it). */
export function paletteGpl(name: string, palette: string[]) {
  const rows = palette.map((hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `${String((n >> 16) & 255).padStart(3)} ${String((n >> 8) & 255).padStart(3)} ${String(n & 255).padStart(3)}\t#${m[1].toLowerCase()}`;
  }).filter(Boolean);
  return `GIMP Palette\nName: ${name}\nColumns: ${Math.min(8, rows.length || 1)}\n#\n${rows.join('\n')}\n`;
}

/** The note in every pack: what's in it and how to load it. */
export function importNote(m: WorldManifest) {
  return `# ${m.world.name}: world pack

Made by Hawkes Gen (${m.made.at}). Format \`${m.format}\`: everything is listed in \`world.json\`.

- ${m.characters.length} character(s), ${m.places.length} place(s), ${m.props.length} prop(s), ${m.files.length} file(s).
- Every file in \`world.json\` \`files\` carries its recipe (the tool, its version, the settings and inputs that made it): what you made and how.

## Unity

1. Add the Hawkes Gen package (\`com.hawkes.gen\`) and glTFast (\`com.unity.cloud.gltfast\`) for the GLB models.
2. **Hawkes Gen > Import World Pack...** and pick this zip (or the unzipped \`world.json\`).
3. Everything lands in \`Assets/HawkesWorlds/<world>/\`: models, a skybox material per place (Skybox/Panoramic), the
   palette, and a \`WorldPack\` asset listing it all.

## Web (three.js or Babylon.js)

\`\`\`js
import { loadWorldPack } from './hawkes-world.mjs';
const world = await loadWorldPack('worlds/${slug(m.world.name, 'world')}/'); // the unzipped folder (or a URL to world.json)
const hero = world.character('${m.characters[0]?.name ?? 'Name'}');
const gltf = await new GLTFLoader().loadAsync(world.url(hero.model));
\`\`\`

## Missing

${m.missing.length ? m.missing.map((x) => `- ${x}`).join('\n') : 'Nothing: every file the world names is here.'}
`;
}

let source: ((project: string, worldId: string) => WorldContext | null) = worldContext;
/** Tests only: a world without the worlds work (null puts worldContext back). */
export function _setWorldSource(f: ((project: string, worldId: string) => WorldContext | null) | null) {
  source = f ?? worldContext;
}
export const worldFor = (project: string, worldId: string) => source(project, worldId);
