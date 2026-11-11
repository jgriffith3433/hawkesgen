// Auto-duck under dialogue: Music tracks drop about 10 dB while a Voice/dialogue clip plays, with short
// attack/release. Same envelope for the live preview, the browser mixdown, and video.compose (duckTo).

/** Target gain while ducked (~10 dB quieter). */
export const DUCK_DB = 10;
export const DUCK_TO = 10 ** (-DUCK_DB / 20);
/** Ramp into and out of the duck (seconds). Matches video.compose's envelope width. */
export const DUCK_ATTACK = 0.25;
export const DUCK_RELEASE = 0.25;

/** What a track is for ducking: dialogue (Voice…), music (Music…), or neither. */
export function trackMixRole(name) {
  const n = String(name ?? '');
  if (/voice|dialog|line/i.test(n)) return 'dialogue';
  if (/music|score|song/i.test(n)) return 'music';
  return 'other';
}

export const isDialogueTrack = (tr) => trackMixRole(tr?.name) === 'dialogue';
export const isMusicTrack = (tr) => trackMixRole(tr?.name) === 'music';

/**
 * Spans where dialogue is sounding: [start, end] on the timeline, from clips on Voice/dialogue tracks
 * that have a file, aren't muted, have volume > 0, and whose track is audible. Overlapping spans stay
 * separate (the envelope multiplies them). `audibleFn(trackId)` is optional (defaults to always true).
 */
export function dialogueSpans(clips, trackOfFn, clipEndFn, audibleFn) {
  const out = [];
  for (const c of clips ?? []) {
    if (c.muted || !c.asset || (c.volume ?? 1) <= 0) continue;
    if (c.kind !== 'audio' && c.kind !== 'video') continue;
    if (!isDialogueTrack(trackOfFn?.(c.track))) continue;
    if (audibleFn && !audibleFn(c.track)) continue;
    const end = clipEndFn(c);
    if (end > c.start) out.push([c.start, end]);
  }
  return out;
}

/** Clamp x to [0, 1]. */
const unit = (x) => Math.max(0, Math.min(1, x));

/**
 * Music gain at time t given dialogue spans: 1 when clear, `to` under a line, eased over attack/release.
 * Several overlapping lines multiply (same as video.compose's volume envelope).
 */
export function duckFactorAt(t, spans, { to = DUCK_TO, attack = DUCK_ATTACK, release = DUCK_RELEASE } = {}) {
  if (!spans?.length) return 1;
  const dip = 1 - to;
  let g = 1;
  for (const [s, e] of spans) {
    const a = Math.max(1e-4, attack);
    const r = Math.max(1e-4, release);
    const into = (t - (s - a)) / a;
    const out = (e + r - t) / r;
    const amount = unit(Math.min(into, out));
    g *= 1 - dip * amount;
  }
  return g;
}

/** Whether this clip should be ducked under dialogue (a sounding clip on a Music track). */
export function shouldDuckClip(c, trackOfFn) {
  if (!c || c.muted || !c.asset) return false;
  if (c.kind !== 'audio' && c.kind !== 'video') return false;
  return isMusicTrack(trackOfFn?.(c.track));
}

/**
 * video.compose audio rows for the timeline's sound clips: dialogue flags, duck + duckTo on Music when
 * a sounding Voice clip exists, fades and volume. Same rules as the live preview.
 */
export function composeAudioPlan(clips, trackOfFn, { lengthOf } = {}) {
  const len = lengthOf ?? ((c) => Math.max(0, (c.out - c.in) / (c.speed || 1)));
  const audio = (clips ?? []).filter((c) => c.kind === 'audio' && c.asset);
  const isVoice = (c) => isDialogueTrack(trackOfFn?.(c.track)) && !c.muted && (c.volume ?? 1) > 0;
  const isMusic = (c) => isMusicTrack(trackOfFn?.(c.track));
  const hasVoice = audio.some(isVoice);
  return audio.map((c, j) => ({
    audio: j,
    start: c.start,
    in: c.in,
    seconds: len(c),
    ...(c.volume != null ? { volume: c.volume } : {}),
    ...(c.muted ? { volume: 0 } : {}),
    ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
    ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}),
    ...(isVoice(c) ? { dialogue: true } : {}),
    ...(isMusic(c) && hasVoice ? { duck: true, duckTo: DUCK_TO } : {}),
  }));
}
