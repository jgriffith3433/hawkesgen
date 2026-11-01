// The world kinds of scene (docs/worlds.md, docs/worlds-roadmap.md Phase 3): the layer above scenes. Registered like the
// character kind (src/scenekinds.ts), plug and play by scene id (`sceneRef`).
//
//   world  the bible (logline, tone, rules = canon, history, factions), the look every output inherits (style,
//          negative, palette, board, grade: src/worlds.ts WorldLook) and its members (character, place, prop, story ids)
//   place  description, its pack (a 360° panorama, key views, a 3D set), times of day and weather, its ambience
//   prop   description, a sheet and views, a 3D model, an owner (a character)
//   story  level story | series | episode: logline, beats, a script (scenes with lines by character), a shot list
//          (each shot names its place, cast and props, and the stage shot made from it), the continuity timeline
//          (who wears what, injuries, who holds which prop, where everyone is, the time of day), and the parent series
//
// Any scene may name its world with `doc.world` (kept for every kind by src/scenes.ts). File-holding elements follow
// src/scenekinds.ts: `asset`, or `pending` (a job), `failed`, `gen` (the AI's mark).

import { registerKind } from './scenes.ts';
import { resolveElements } from './scenekinds.ts';
import { normalizeWorld, normalizePlace, normalizeProp, normalizeStory, type El, type WorldDoc, type PlaceDoc, type PropDoc, type StoryDoc } from './worlddocs.ts';

// The documents themselves (normalizers, continuityAt, the types) are src/worlddocs.ts, re-exported here.
export * from './worlddocs.ts';

// ------------------------------------------------------------------ registration
const placeEls = (d: PlaceDoc): El[] => [...(d.panorama ? [d.panorama] : []), ...d.views, ...(d.set ? [d.set] : []), ...d.variants, ...(d.ambience ? [d.ambience] : [])];
const propEls = (d: PropDoc): El[] => [...(d.sheet ? [d.sheet] : []), ...d.views, ...(d.model ? [d.model] : [])];

registerKind('world', {
  normalize: normalizeWorld,
  blank: (title) => normalizeWorld({ title: title === 'Untitled' ? 'Untitled world' : title }),
  resolve: (doc: WorldDoc, jobOf) => {
    const c = resolveElements(doc.board, ['image'], jobOf);
    if (c) doc.look.board = doc.board.filter((b) => b.asset).map((b) => b.asset!);
    return c;
  },
  uses: (doc: WorldDoc) => doc.members,
  elements: (doc: WorldDoc) => doc.board,
});
registerKind('place', {
  normalize: normalizePlace,
  blank: (title) => normalizePlace({ title: title === 'Untitled' ? 'Unnamed place' : title }),
  resolve: (doc: PlaceDoc, jobOf) => {
    const a = resolveElements([...(doc.panorama ? [doc.panorama] : []), ...doc.views, ...doc.variants], ['image'], jobOf);
    const b = resolveElements(doc.set ? [doc.set] : [], ['mesh'], jobOf);
    const c = resolveElements(doc.ambience ? [doc.ambience] : [], ['audio'], jobOf);
    return a || b || c;
  },
  elements: placeEls,
});
registerKind('prop', {
  normalize: normalizeProp,
  blank: (title) => normalizeProp({ title: title === 'Untitled' ? 'Unnamed prop' : title }),
  resolve: (doc: PropDoc, jobOf) => {
    const a = resolveElements([...(doc.sheet ? [doc.sheet] : []), ...doc.views], ['image'], jobOf);
    const b = resolveElements(doc.model ? [doc.model] : [], ['mesh'], jobOf);
    return a || b;
  },
  uses: (doc: PropDoc) => (doc.owner ? [doc.owner] : []),
  elements: propEls,
});
registerKind('story', {
  normalize: normalizeStory,
  blank: (title) => normalizeStory({ title: title === 'Untitled' ? 'Untitled story' : title }),
  uses: (doc: StoryDoc) => [...(doc.parent ? [doc.parent] : []), ...doc.shots.flatMap((s) => [...(s.place ? [s.place] : []), ...s.cast, ...s.props, ...(s.stage ? [s.stage] : [])])],
});

export const WORLD_KINDS = ['world', 'place', 'prop', 'story'] as const;
export const isWorldKind = (k: string) => (WORLD_KINDS as readonly string[]).includes(k);
