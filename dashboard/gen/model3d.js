// 3D files people bring in (J, 2026-11-08: an FBX dropped on a stage "just turns into a box"). Everything in Gen reads
// GLB: the stage (three.js GLTFLoader), Media's <model-viewer>, mesh.rig and the Blender tools. So an FBX or OBJ is
// turned into a GLB in the browser before it goes up (three.js FBXLoader / OBJLoader, then GLTFExporter, skeleton and
// every animation clip kept). Pictures dropped or picked with it become its textures when the file names them
// (Unity and Blender exports usually keep textures beside the FBX, not inside it). Nothing leaves the browser but the GLB.

const CONVERT = /\.(fbx|obj)$/i;
export const MODEL_FILE = /\.(glb|gltf|fbx|obj)$/i;
/** True for a file that is turned into a GLB before it goes up. */
export const needsGlb = (file) => CONVERT.test(file?.name ?? '');
const base = (s) => String(s).split(/[\\/]/).pop().split('?')[0].toLowerCase();
const stem = (s) => base(s).replace(/\.[^.]+$/, '');
const MAP_WORD = /normal|gloss|rough|metal|occlusion|(?:^|_)ao(?:_|$)|height|spec|bump|emiss|opacity|alpha/i;
const words = (s) => stem(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/^(tex|texture|map|png|jpg)$/.test(w));
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl4gAAAABJRU5ErkJggg==';

/**
 * Reads an FBX or OBJ (a File, or a URL for one already in the library) into three.js: { scene, animations, textures }.
 * `pictures` are image Files that may be its textures, matched by file name, then by the words in it (`pick`).
 * `textures` lists the names it asked for and whether each was found.
 */
export async function readModel(src, pictures = []) {
  const THREE = await import('three');
  const name = typeof src === 'string' ? src : src.name;
  const urls = new Map(pictures.map((p) => [p.name, URL.createObjectURL(p)]));
  const mine = new Set(urls.values());
  const asked = new Map(); // texture file name -> the picture's name it got, or null
  const taken = new Set();
  /** The picture a texture name means: the same file name, else the best word match, else a lone picture. */
  const pick = (want) => {
    const names = [...urls.keys()];
    const same = names.find((n) => base(n) === want) ?? names.find((n) => stem(n) === stem(want));
    if (same) return same;
    // Words in common: an equal word counts 2, one inside another 1 ("head_basemap" -> Person_Head.png, "body_basemap"
    // -> Person_Base.png). Normal, gloss, occlusion... maps never stand in for a color texture or the other way round.
    const kindOf = (n) => (n.match(MAP_WORD) ?? [''])[0].toLowerCase();
    const scored = names.filter((n) => !taken.has(n) && kindOf(stem(n)) === kindOf(stem(want))).map((n) => {
      const pw = words(n), tw = words(want);
      let score = 0;
      for (const t of tw) score += pw.includes(t) ? 2 : pw.some((w) => w.length > 2 && t.length > 2 && (w.includes(t) || t.includes(w))) ? 1 : 0;
      return { n, score };
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
    if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return scored[0].n;
    // Exactly one picture came with the model and nothing matched: it goes on the first texture asked for only (the
    // body before the head); a picture on the wrong part looks worse than none.
    if (names.length === 1 && !taken.size) return names[0];
    return null;
  };
  // Everything the manager loads (the file, then its textures, started while it is parsed) has ended when onLoad fires.
  let allLoaded;
  const loaded = new Promise((ok) => { allLoaded = ok; });
  const manager = new THREE.LoadingManager(() => allLoaded());
  const own = typeof src === 'string' ? src : URL.createObjectURL(src);
  manager.setURLModifier((url) => {
    // The file itself and our own picture links pass. Textures come asked for relative to the file's blob: link
    // ("blob:http://.../body_basemap.png"), so other blob: links are matched by name like any other.
    if (url === own || url.startsWith('data:') || mine.has(url)) return url;
    const want = base(url);
    if (!asked.has(want)) { const got = pick(want); asked.set(want, got); if (got) taken.add(got); }
    const got = asked.get(want);
    return got ? urls.get(got) : BLANK; // a texture it can't find is left blank, never fetched from the site
  });
  try {
    let scene, animations = [];
    if (/\.fbx$/i.test(name) || typeof src === 'string') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      scene = await new FBXLoader(manager).loadAsync(own);
      animations = scene.animations ?? [];
    } else {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      scene = await new OBJLoader(manager).loadAsync(own);
    }
    // Textures load after the model: wait for each picture (at most 15 s), then drop any that never got one, so the
    // model still comes through (untextured there) instead of failing the export.
    const maps = [];
    scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) for (const k of Object.keys(m ?? {})) if (m[k]?.isTexture) maps.push([m, k]); });
    const ready = (img) => img && ((img.complete && img.naturalWidth) || img.width > 0 || img.data);
    await Promise.race([loaded, new Promise((ok) => setTimeout(ok, 15000))]);
    for (const [m, k] of maps) if (!ready(m[k].image) || m[k].image?.src === BLANK) { m[k] = null; m.needsUpdate = true; }
    return { scene, animations, textures: [...asked].map(([file, picture]) => ({ file, found: Boolean(picture), picture })) };
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(own);
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
}

/** An FBX or OBJ File as a GLB File of the same name ({ file, textures, clips }). */
export async function toGlb(file, pictures = []) {
  const { scene, animations, textures } = await readModel(file, pictures);
  // Materials the exporter can't carry (FBX gives Phong/Lambert) go across as standard ones with their color and map.
  const THREE = await import('three');
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const swap = (m) => (m && !m.isMeshStandardMaterial && !m.isMeshBasicMaterial
      ? Object.assign(new THREE.MeshStandardMaterial({ color: m.color ?? 0xffffff, map: m.map ?? null, normalMap: m.normalMap ?? null, transparent: m.transparent, opacity: m.opacity ?? 1, alphaTest: m.alphaTest ?? 0, side: m.side, roughness: 0.8, metalness: 0 }), { name: m.name })
      : m);
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  // FBXLoader gives every corner of every polygon its own vertex (and blend shapes multiply that): share the identical
  // ones before export, or a 7 MB FBX becomes an 85 MB GLB.
  const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');
  scene.traverse((o) => { if (o.isMesh && !o.geometry.index) { const g = mergeVertices(o.geometry, 1e-6); o.geometry.dispose(); o.geometry = g; } });
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, animations, onlyVisible: false, maxTextureSize: 4096 });
  const out = new File([glb], file.name.replace(CONVERT, '.glb'), { type: 'model/gltf-binary' });
  let meshes = 0;
  scene.traverse((o) => { if (o.isMesh) meshes++; });
  return { file: out, textures, clips: animations.map((a) => a.name), meshes };
}

/** A short note on what the conversion kept, for a toast ("2 clips; 1 texture not found: Person_Base.png"). */
export function glbNote({ textures, clips, meshes = 1 }) {
  const missing = textures.filter((t) => !t.found).map((t) => t.file);
  const parts = [];
  if (!meshes && clips.length) parts.push('animation only (no body): add it to a character as a move, it shows nothing on a stage by itself');
  else if (clips.length) parts.push(`${clips.length} animation${clips.length === 1 ? '' : 's'} kept`);
  if (missing.length) parts.push(`texture${missing.length === 1 ? '' : 's'} not found: ${missing.slice(0, 3).join(', ')} (drop ${missing.length === 1 ? 'it' : 'them'} in with the model)`);
  return parts.join('; ');
}

/**
 * Files about to go up, with every FBX or OBJ turned into a GLB. Pictures dropped with a model that it uses as textures
 * go into it and are not uploaded on their own. Returns { files, notes } (notes: one line per converted model).
 */
export async function prepareModels(files, onStep) {
  const models = files.filter(needsGlb);
  if (!models.length) return { files, notes: [] };
  const pictures = files.filter((f) => f.type.startsWith('image/'));
  const used = new Set();
  const notes = [];
  const out = [];
  for (const f of files) {
    if (!needsGlb(f)) { out.push(f); continue; }
    onStep?.(`Converting ${f.name} to GLB`);
    try {
      const r = await toGlb(f, pictures);
      r.textures.forEach((t) => { if (t.picture) used.add(pictures.find((p) => p.name === t.picture)); });
      out.push(r.file);
      notes.push(`${f.name} → ${r.file.name}${glbNote(r) ? `: ${glbNote(r)}` : ''}`);
    } catch (err) {
      notes.push(`${f.name} couldn't be read (${err?.message ?? err}). Export it as GLB or FBX 2013+ binary and try again.`);
    }
  }
  // Normal, gloss, occlusion... maps that came with a model are its material's, not pictures of their own: the GLB keeps
  // the color texture only, so they stay out of Media.
  const maps = pictures.filter((p) => !used.has(p) && MAP_WORD.test(stem(p.name)));
  maps.forEach((p) => used.add(p));
  if (maps.length) notes.push(`Left out ${maps.length} material map${maps.length === 1 ? '' : 's'} (normal, gloss, occlusion...) that came with the model.`);
  return { files: out.filter((f) => !used.has(f)), notes };
}
