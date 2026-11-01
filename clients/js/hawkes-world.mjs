// Hawkes Gen world packs in a web game (three.js or Babylon.js). A world pack is the zip `world.export` makes
// (docs/finishing.md): world.json lists the world's characters, places, props and look, with every file's path and recipe.
// Unzip it next to your game (or serve it), then:
//
//   import { loadWorldPack, threeSkybox, babylonSkybox } from './hawkes-world.mjs';
//   const world = await loadWorldPack('worlds/frostmoon/');            // the folder, or a URL to its world.json
//   const maya = world.character('Maya');                              // by name or id
//   const gltf = await new GLTFLoader().loadAsync(world.url(maya.model)); // three.js
//   scene.background = await threeSkybox(THREE, world.url(world.place('The Harbor').skybox));
//
// No dependency: pass in the engine you use. Every helper takes the engine's module, so this file never imports one.

export const PACK_FORMAT = 'hawkes.world/1';

/**
 * Loads a pack's world.json. `where` is the unzipped folder (ending in /) or the manifest's URL.
 * @returns {Promise<WorldPack>}
 */
export async function loadWorldPack(where, { fetch: f = globalThis.fetch } = {}) {
  const url = /\.json(\?|$)/.test(where) ? where : `${String(where).replace(/\/?$/, '/')}world.json`;
  const res = await f(url);
  if (!res.ok) throw new Error(`world pack: ${url} answered ${res.status}`);
  return worldPack(await res.json(), new URL('.', new URL(url, globalThis.location?.href ?? 'http://localhost/')).href);
}

/** A pack from a manifest already in hand; `base` is the URL its paths are relative to. */
export function worldPack(manifest, base = './') {
  if (!manifest || manifest.format !== PACK_FORMAT) throw new Error(`not a Hawkes world pack (format ${manifest?.format ?? 'missing'}, want ${PACK_FORMAT})`);
  const find = (list, key) => {
    const k = String(key).toLowerCase();
    return list.find((m) => m.id === key || m.name.toLowerCase() === k) ?? null;
  };
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  return {
    manifest,
    name: manifest.world.name,
    canon: manifest.world.canon,
    look: manifest.look,
    characters: manifest.characters,
    places: manifest.places,
    props: manifest.props,
    character: (key) => find(manifest.characters, key),
    place: (key) => find(manifest.places, key),
    prop: (key) => find(manifest.props, key),
    /** A file's URL from its path in the pack (null stays null). */
    url: (p) => (p ? new URL(p, base).href : null),
    /** A file's entry: its library id, hash and the recipe that made it. */
    file: (p) => byPath.get(p) ?? null,
    /** The palette as numbers (0xRRGGBB), for materials and UI. */
    palette: () => manifest.look.palette.filter((h) => /^#?[0-9a-f]{6}$/i.test(h)).map((h) => parseInt(h.replace('#', ''), 16)),
  };
}

/** three.js: an equirectangular skybox texture from a place's panorama (scene.background / scene.environment). */
export async function threeSkybox(THREE, url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Babylon.js: a skybox dome from a place's panorama. */
export function babylonSkybox(BABYLON, scene, url, size = 1000) {
  return new BABYLON.PhotoDome('hawkesSky', url, { resolution: 64, size }, scene);
}

/** Babylon.js: loads a character's or prop's GLB (needs @babylonjs/loaders). */
export async function babylonModel(BABYLON, scene, world, member) {
  const url = world.url(member.model);
  if (!url) throw new Error(`${member.name} has no 3D model in this pack`);
  const i = url.lastIndexOf('/');
  return BABYLON.SceneLoader.ImportMeshAsync('', url.slice(0, i + 1), url.slice(i + 1), scene);
}
