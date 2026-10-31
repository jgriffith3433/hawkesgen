// A character's identity pack (docs/worlds-roadmap.md, Phase 1): what everything that draws them reads, so every shot
// shows the same person. A locked sheet, a fixed description pasted unchanged into every prompt, the reference
// pictures, and a LoRA once they recur.
//
// This file is the contract other work reads through. The identity work (Phase 1) adds `lock` and `lora` to the
// character document (src/scenekinds.ts) and makes the pack; until then the pack is read from the pictures and
// description the character already has.

export type IdentityPack = {
  /** The locked character sheet (asset id), when there is one. */
  sheet: string | null;
  /** The fixed description: 50 to 80 words, pasted unchanged into every prompt that draws them. */
  description: string;
  /** Reference pictures, best first (asset ids): the sheet, front, portrait, then other references. */
  refs: string[];
  /** A trained LoRA and its trigger word, once there is one. */
  lora: { asset: string; trigger: string } | null;
  /** Their 3D model (asset id), for references rendered from a shot's camera. */
  model: string | null;
};

const ORDER = ['sheet', 'front', 'portrait', 'turnaround', 'reference'];

/** The pack from a character document (src/scenekinds.ts CharacterDoc). */
export function identityPack(doc: any): IdentityPack {
  const pics = (Array.isArray(doc?.pictures) ? doc.pictures : []).filter((p: any) => typeof p?.asset === 'string');
  pics.sort((a: any, b: any) => (ORDER.indexOf(a.role) + 99) % 99 - (ORDER.indexOf(b.role) + 99) % 99);
  const lock = doc?.lock && typeof doc.lock === 'object' ? doc.lock : null;
  const lora = doc?.lora && typeof doc.lora.asset === 'string' ? { asset: doc.lora.asset, trigger: String(doc.lora.trigger ?? '') } : null;
  const sheet = typeof lock?.sheet === 'string' ? lock.sheet : pics.find((p: any) => p.role === 'sheet')?.asset ?? null;
  const refs = [...new Set<string>([...(sheet ? [sheet] : []), ...pics.filter((p: any) => p.role !== 'cutout').map((p: any) => p.asset)])];
  return {
    sheet,
    description: String(lock?.description ?? doc?.description ?? ''),
    refs,
    lora,
    model: typeof doc?.model?.asset === 'string' ? doc.model.asset : null,
  };
}
