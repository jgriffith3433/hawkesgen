// Worlds: the layer above scenes (docs/worlds-roadmap.md, Phase 3). A world scene holds the bible (tone, rules, canon),
// the look every output inherits, and its characters, places, props and stories. Any scene may name its world with
// `doc.world` (a scene id).
//
// This file is the contract other work reads through. The worlds work (Phase 3) adds the kinds and replaces the
// placeholder body of worldContext; until then no scene has a world and callers get null.

export type WorldLook = {
  /** The style line every prompt in the world carries. */
  style: string;
  negative: string;
  palette: string[];
  /** Asset ids of the style board. */
  board: string[];
  /** One grade for every shot: a LUT asset, or simple params (contrast, saturation, warmth...). */
  grade: { lut?: string; params?: Record<string, number> } | null;
};

/** A character, place or prop as the world hands it to whatever draws it. */
export type WorldMember = { id: string; title: string; description: string; refs: string[] };

export type WorldContext = {
  worldId: string;
  title: string;
  look: WorldLook;
  /** Rules outputs and scripts must not break. */
  canon: string[];
  characters: WorldMember[];
  places: WorldMember[];
  props: WorldMember[];
};

/** The world a scene belongs to, from its document. */
export function worldOf(doc: unknown): string | null {
  const w = (doc as any)?.world;
  return typeof w === 'string' && /^[a-z]{2,4}_[\w-]{4,40}$/.test(w) ? w : null;
}

/** Everything a job made inside a world inherits. Null when there's no world (or it can't be seen). */
export function worldContext(_project: string, _worldId: string | null): WorldContext | null {
  return null;
}
