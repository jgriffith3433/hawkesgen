// A character's identity pack (docs/worlds-roadmap.md, Phase 1; docs/identity.md): what everything that draws them
// reads, so every shot shows the same person. A locked sheet, a fixed description pasted unchanged into every prompt,
// the reference pictures, their 3D model, and a LoRA once they recur.
//
//   lock  { sheet, description, at }  the approved pack. `at` is when the person locked it; null is a draft (made by
//         "Make their look" or the character AI, not approved yet). A draft is still used: it beats the loose words.
//   lora  { asset, trigger, state, pending, failed }  a LoRA trained on their pictures (lora.train), drawn with
//         image.character. state: training (pending is the job), ready, failed.
//
// Never let one shot set the next shot's look: every shot reads from the pack, never from another take.
//
// Also here: the plans that make a pack (lookPlan, describeLook, loraPlan) and the pack makers for places and props
// (placePackPlan, propPackPlan) that the world kinds call.

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
  /** True once the person approved the pack ("Lock their look"). Added by Phase 1. */
  locked?: boolean;
};

export type Lock = { sheet: string | null; description: string; at: number | null };
export type LoraState = { asset?: string; trigger: string; state: 'training' | 'ready' | 'failed'; pending?: string; failed?: string };

const assetId = (v: unknown) => (typeof v === 'string' && /^a_[0-9a-f]{6,40}$/.test(v) ? v : null);
const jobId = (v: unknown) => (typeof v === 'string' && /^j_[0-9a-f]{6,40}$/.test(v) ? v : null);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'character';

/** The lock as stored (null when there's nothing in it). `at: true` (the AI locking on the person's word) becomes now. */
export function normalizeLock(v: any): Lock | null {
  if (!v || typeof v !== 'object') return null;
  const sheet = assetId(v.sheet);
  const description = typeof v.description === 'string' ? v.description.trim().slice(0, 1200) : '';
  if (!sheet && !description) return null;
  const at = v.at === true ? Date.now() : Number.isFinite(Number(v.at)) && Number(v.at) > 0 ? Math.round(Number(v.at)) : null;
  // Only a whole pack can be locked: a sheet and the fixed words.
  return { sheet, description, at: sheet && description ? at : null };
}

/** The LoRA as stored. */
export function normalizeLora(v: any): LoraState | null {
  if (!v || typeof v !== 'object') return null;
  const asset = assetId(v.asset), pending = jobId(v.pending);
  const state = asset && v.state !== 'training' ? 'ready' : pending ? 'training' : v.failed || v.state === 'failed' ? 'failed' : null;
  if (!state) return null;
  return {
    trigger: typeof v.trigger === 'string' ? v.trigger.slice(0, 60) : '', state,
    ...(asset && state === 'ready' ? { asset } : {}), ...(pending && state === 'training' ? { pending } : {}),
    ...(state === 'failed' ? { failed: String(v.failed ?? 'Training failed').slice(0, 300) } : {}),
  };
}

const ORDER = ['sheet', 'front', 'portrait', 'turnaround', 'reference'];

/** The pack from a character document (src/scenekinds.ts CharacterDoc). */
export function identityPack(doc: any): IdentityPack {
  const pics = (Array.isArray(doc?.pictures) ? doc.pictures : []).filter((p: any) => typeof p?.asset === 'string');
  pics.sort((a: any, b: any) => (ORDER.indexOf(a.role) + 99) % 99 - (ORDER.indexOf(b.role) + 99) % 99);
  const lock = normalizeLock(doc?.lock);
  const lr = normalizeLora(doc?.lora);
  const lora = lr?.state === 'ready' && lr.asset ? { asset: lr.asset, trigger: lr.trigger } : null;
  const sheet = lock?.sheet ?? pics.find((p: any) => p.role === 'sheet')?.asset ?? null;
  const refs = [...new Set<string>([...(sheet ? [sheet] : []), ...pics.filter((p: any) => p.role !== 'cutout').map((p: any) => p.asset)])];
  return {
    sheet,
    description: String(lock?.description || doc?.description || ''),
    refs,
    lora,
    model: typeof doc?.model?.asset === 'string' ? doc.model.asset : null,
    locked: Boolean(lock?.at),
  };
}

// ------------------------------------------------------------------ making the pack ("Make their look")
/** The front picture: empty hands (props drift between angles), plain background, A-pose. */
export const frontPrompt = (description: string) =>
  `${description.trim().replace(/\.$/, '')}. Full body, front view, standing in a relaxed A-pose, arms slightly away from the body, empty hands, holding nothing, plain light grey background, even studio light, sharp face, eyes open.`;

/** The sheet, painted over the front picture with image.edit (it keeps the person of image 1). */
export const sheetPrompt = (name: string, description: string) =>
  `Turn this into a character model sheet of exactly this person${name ? ` (${name})` : ''}, on one plain light grey background: on the left the same full-body front view, in the middle a full-body three-quarter view turned to their left, and on the right four head-and-shoulders close-ups with different expressions (neutral, smiling, angry, surprised). The same face, hair, body, outfit and colors in every view; empty hands; even studio light; no text, no labels.${description ? ` The person: ${description.trim().slice(0, 600)}` : ''}`;

export const SHEET_SIZE = { width: 2048, height: 1152 } as const;

export type LookStep = { role: 'front' | 'sheet'; tool: string; params: Record<string, any>; inputs?: Record<string, any> };

/**
 * "Make their look": the jobs in order. The front picture (only when there isn't one), then the sheet over it
 * (inputs.images "$front" is the front picture's file). The fixed description is written after (describeLook).
 */
export function lookPlan(doc: any): { steps: LookStep[]; front: string | null } {
  const look = String(doc?.description ?? '').trim();
  const front = (Array.isArray(doc?.pictures) ? doc.pictures : []).find((p: any) => p?.role === 'front' && assetId(p.asset))?.asset ?? null;
  const steps: LookStep[] = [];
  if (!front) steps.push({ role: 'front', tool: 'image.generate', params: { prompt: frontPrompt(look || String(doc?.title ?? 'A person')), width: 768, height: 1344 } });
  steps.push({ role: 'sheet', tool: 'image.edit', params: { prompt: sheetPrompt(String(doc?.title ?? ''), look), ...SHEET_SIZE }, inputs: { images: ['$front'] } });
  return { steps, front };
}

/** Words in a text. */
export const wordCount = (t: string) => (String(t).trim().match(/\S+/g) ?? []).length;

/** A fixed description kept to 50-80 words: cut at the last full sentence within 80 words. */
export function fitDescription(t: string): string {
  const words = String(t ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= 80) return words.join(' ');
  const cut = words.slice(0, 80).join(' ');
  const end = cut.lastIndexOf('.');
  return end > cut.length * 0.6 ? cut.slice(0, end + 1) : `${cut.replace(/[,;:]$/, '')}.`;
}

export const DESCRIBE_SYSTEM = 'You write the fixed description of a character for an AI film studio: 50 to 80 words that every picture and video of them is painted from, pasted unchanged into every prompt. Describe only what stays the same in every shot: apparent age, build and height, skin tone, face (shape, eyes, nose, distinctive marks), hair (color, length, style), the outfit piece by piece with colors and materials, and signature accessories that are worn (never held). Plain, concrete, visual words in present tense, no names of real people, no story, no mood, no camera or pose words, no lists or line breaks: one paragraph. Follow the pictures where they and the words disagree.';

/** The Claude call that writes the fixed description from their words and pictures (local paths). */
export function describeRequest(doc: any, images: string[]) {
  return {
    system: DESCRIBE_SYSTEM,
    prompt: `The character: ${String(doc?.title ?? 'Unnamed')}.\nHow the person described them: ${String(doc?.description ?? '').slice(0, 1500) || '(nothing written: go by the pictures)'}\n${doc?.notes ? `Notes: ${String(doc.notes).slice(0, 800)}\n` : ''}${images.length ? `The pictures: ${images.length === 1 ? 'their front view' : 'their front view, then their character sheet'}.` : ''}\nWrite the fixed description.`,
    images, effort: 'low' as const, maxTokens: 800,
    schema: { type: 'object', additionalProperties: false, required: ['description'], properties: { description: { type: 'string' } } },
  };
}

/** The fixed description from Claude's answer (JSON or plain text), fitted to 80 words. */
export function parseDescription(text: string): string {
  let t = String(text ?? '').trim();
  try { const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); if (typeof j.description === 'string') t = j.description; } catch { /* plain text */ }
  return fitDescription(t.replace(/^["']|["']$/g, ''));
}

// ------------------------------------------------------------------ LoRAs for characters that recur
export const LORA_MIN_SHOTS = 3;
export const LORA_MIN_PICTURES = 8;
export const LORA_TRAIN_IMAGES = 6;

/** Their approved pictures: the files they have (cut-outs repeat the front, so they don't count). */
export const approvedPictures = (doc: any) => [...new Set<string>((Array.isArray(doc?.pictures) ? doc.pictures : []).filter((p: any) => assetId(p?.asset) && p.role !== 'cutout').map((p: any) => p.asset))];

/** The trigger word lora.train makes for a name. */
export const triggerFor = (name: string) => `hwk_${slug(name).replace(/-/g, '_')}`;

export type LoraOffer = { eligible: boolean; why: string; shots: number; pictures: number; state: LoraState['state'] | null };

/** Whether to offer "Keep <name> consistent everywhere": a locked character cast in 3+ shots, or with 8+ approved pictures. */
export function loraOffer(doc: any, shots: number): LoraOffer {
  const lr = normalizeLora(doc?.lora);
  const pictures = approvedPictures(doc).length;
  const base = { shots, pictures, state: lr?.state ?? null };
  if (lr?.state === 'training') return { ...base, eligible: false, why: 'Learning their look' };
  if (lr?.state === 'ready') return { ...base, eligible: false, why: 'Locked in' };
  if (!normalizeLock(doc?.lock)?.at) return { ...base, eligible: false, why: 'Lock their look first' };
  if (shots < LORA_MIN_SHOTS && pictures < LORA_MIN_PICTURES) return { ...base, eligible: false, why: `In ${shots} of ${LORA_MIN_SHOTS} shots, ${pictures} of ${LORA_MIN_PICTURES} pictures` };
  return { ...base, eligible: true, why: shots >= LORA_MIN_SHOTS ? `In ${shots} shots` : `${pictures} pictures` };
}

const VIEWS = [
  'front-right quarter view, eye-level shot, full body',
  'front-left quarter view, eye-level shot, full body',
  'right side view, eye-level shot, full body',
  'front view, eye-level shot, close-up of the face',
  'front-right quarter view, low-angle shot, medium shot',
  'back view, eye-level shot, full body',
];

/**
 * The LoRA as one asset.make job: their approved pictures, topped up to six with new angles of the front picture
 * (image.edit with the Multiple-Angles LoRA), then lora.train with Claude's per-image captions. inputs.files are the
 * pictures; the trained file is the lora.train step's output (scenekinds resolve reads it from the chain).
 */
export function loraPlan(doc: any) {
  const lock = normalizeLock(doc?.lock);
  const pics = approvedPictures(doc);
  if (!pics.length) throw Object.assign(new Error('They need pictures first: make their look'), { status: 400 });
  const front = (doc.pictures.find((p: any) => p.role === 'front' && assetId(p.asset)) ?? doc.pictures.find((p: any) => assetId(p.asset)))!.asset;
  const files = [`asset:${front}`, ...pics.filter((a) => a !== front).slice(0, 29).map((a) => `asset:${a}`)];
  const steps: any[] = [];
  const extra = Math.max(0, LORA_TRAIN_IMAGES - files.length);
  for (let i = 0; i < extra; i++) steps.push({ tool: 'image.edit', params: { prompt: `<sks> ${VIEWS[i]}. The same person, the same outfit, empty hands, plain light grey background.`, angles: 0.9 }, inputs: { images: ['$input:0'] } });
  const name = String(doc?.title ?? 'character');
  steps.push({
    tool: 'lora.train',
    params: { name, caption: (lock?.description || String(doc?.description ?? '') || name).slice(0, 600), autoCaption: true },
    inputs: { images: [...files.map((_, i) => `$input:${i}`), ...steps.map((_, i) => `$step${i + 1}`)] },
    save: 'lora',
  });
  return { tool: 'asset.make', params: { steps }, inputs: { files }, trigger: triggerFor(name), images: files.length + extra };
}

// ------------------------------------------------------------------ places and props (the world kinds call these)
/**
 * A place's pack: a 360° panorama, then three key views painted from it (wide establishing, eye level, a reverse
 * angle), all asset.make steps. Saved as panorama, view-wide, view-eye, view-reverse.
 */
export function placePackPlan(description: string, o: { style?: string } = {}) {
  const what = `${String(description ?? '').trim().replace(/\.$/, '')}${o.style ? `. ${o.style}` : ''}`;
  return {
    steps: [
      { tool: 'image.panorama', params: { prompt: `${what}. A seamless 360 degree equirectangular panorama, no people.` }, save: 'panorama' },
      { tool: 'image.edit', params: { prompt: `${what}. A wide establishing shot of this place from a high vantage point, the whole place in view, no people. Keep its architecture, materials, colors and light from image 1.`, width: 1280, height: 704 }, inputs: { images: ['$step1'] }, save: 'view-wide' },
      { tool: 'image.edit', params: { prompt: `${what}. An eye-level view standing inside this place, looking toward its main feature, no people. Keep its architecture, materials, colors and light from image 1.`, width: 1280, height: 704 }, inputs: { images: ['$step1'] }, save: 'view-eye' },
      { tool: 'image.edit', params: { prompt: `${what}. The reverse angle: the opposite side of this place at eye level, no people. Keep its architecture, materials, colors and light from image 1.`, width: 1280, height: 704 }, inputs: { images: ['$step1'] }, save: 'view-reverse' },
    ],
  };
}

/**
 * A prop's pack: the prop alone on a plain background, cut out, then a checked 4-view sheet (image.viewsheet, form
 * prop) with nothing else in frame. Saved as front and sheet.
 */
export function propPackPlan(description: string, o: { style?: string } = {}) {
  const what = `${String(description ?? '').trim().replace(/\.$/, '')}${o.style ? `. ${o.style}` : ''}`;
  return {
    steps: [
      { tool: 'image.generate', params: { prompt: `${what}. The object alone, whole and centered, seen straight from the front at eye level, nothing else in frame, no hands, no people, plain light grey background, even studio light.`, width: 1024, height: 1024 }, save: 'front' },
      { tool: 'image.remove-background', inputs: { image: '$prev' } },
      { tool: 'image.viewsheet', params: { form: 'prop', look: what.slice(0, 300) }, inputs: { image: '$prev:cutout' }, save: 'sheet' },
    ],
  };
}
