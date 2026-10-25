// The intelligibility check: does what a speech model said (transcribed by faster-whisper on the server) match the text.

const norm = (s: string) => s.toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/** Word error rate: edit distance between the word lists over the length of the expected one. 0 is a perfect read. */
export function wordErrorRate(expected: string, heard: string): number {
  const a = norm(expected);
  const b = norm(heard);
  if (!a.length) return b.length ? 1 : 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.round((d[a.length][b.length] / a.length) * 1000) / 1000;
}

/** Intelligible: at most this share of words wrong (growls and shouts are judged by ear, not by this). */
export const INTELLIGIBLE_WER = 0.25;
export const intelligible = (wer: number) => wer <= INTELLIGIBLE_WER;
