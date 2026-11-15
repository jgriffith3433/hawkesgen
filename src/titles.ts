// Title presets, server side: the ids, defaults and one-line descriptions the document and the AI editor use. The maths
// (layout, safe area, animation) is dashboard/gen/titles.js, the one file the preview, the export and the tests run;
// test/titles.test.ts keeps this list and that one in step.

export type TitlePreset = { id: string; label: string; about: string; length: number; animIn: number; animOut: number; sub: string | null; sample: string; sample2: string };

export const TITLE_PRESETS: TitlePreset[] = [
  { id: 'big-title', label: 'Big title', about: 'a large centred title that scales in and fades out; text2 is an optional subtitle', length: 4, animIn: 0.7, animOut: 0.5, sub: 'subtitle', sample: 'Your title', sample2: '' },
  { id: 'lower-third', label: 'Lower third', about: 'a name (text) and a role (text2) on a plate in the bottom-left corner (align "right": bottom-right); the plate wipes in and out', length: 4, animIn: 0.6, animOut: 0.45, sub: 'role', sample: 'Alex Rivera', sample2: 'Director of photography' },
  { id: 'caption-bar', label: 'Caption bar', about: 'one or two lines on a bar across the bottom; slides up and down', length: 3, animIn: 0.35, animOut: 0.3, sub: null, sample: 'Say what is happening in a line or two.', sample2: '' },
  { id: 'kinetic', label: 'Kinetic words', about: 'the words pop in one at a time, then fade together', length: 3.5, animIn: 0.38, animOut: 0.4, sub: null, sample: 'Make every word land', sample2: '' },
  { id: 'end-card', label: 'End card', about: 'dims the picture and fades up a closing line (text) with a credit under it (text2)', length: 5, animIn: 0.8, animOut: 0.8, sub: 'credit line', sample: 'Thanks for watching', sample2: 'Made with Hawkes Gen' },
  { id: 'corner-label', label: 'Corner label', about: 'a small quiet label in the top-left corner (align "right": top-right): a place, a chapter, a date', length: 4, animIn: 0.4, animOut: 0.35, sub: null, sample: 'Chapter 1 · The harbour', sample2: '' },
];
const IDS = new Set(TITLE_PRESETS.map((p) => p.id));
export const isTitlePreset = (v: unknown): v is string => typeof v === 'string' && IDS.has(v);
export const titlePreset = (id: unknown) => TITLE_PRESETS.find((p) => p.id === id) ?? null;
/** Longest an in or out animation may be, as a share of the clip's length (the same 40% as the preview's). */
export const TITLE_ANIM_MAX_SHARE = 0.4;
/** The AI editor's list of presets, one line each. */
export const titleDoc = () => TITLE_PRESETS.map((p) => `"${p.id}" (${p.about}; about ${p.length} s)`).join('; ');
