// The showrunner sees its work (docs/showrunner.md): a turn about results ("fix the second shot", "her face changed")
// gets the outputs it points at as pictures: three frames of one clip, or a contact sheet of every shot's middle frame.
// For small edits the existing assistants take words only, so the showrunner looks first and hands them what it saw
// as a note on the person's message; the planner and review mode get the pictures themselves.

import { deps } from './deps.ts';

type Clip = { id: string; track: string; kind: string; start: number; asset?: string; label?: string };

/** The cut's shots in order: the main track's video clips (else every video clip). */
export function shotClips(doc: any): Clip[] {
  const clips: Clip[] = Array.isArray(doc?.clips) ? doc.clips : [];
  const main = (Array.isArray(doc?.tracks) ? doc.tracks : []).find((t: any) => t.role === 'main')?.id;
  const vids = clips.filter((c) => c.kind === 'video' && c.asset);
  const onMain = vids.filter((c) => c.track === main);
  return (onMain.length ? onMain : vids).slice().sort((a, b) => a.start - b.start);
}

/** The pictures a turn should look at, and what they are. `nth` is 1-based (-1: the last); `selected` clip ids. */
export async function picturesFor(doc: any, o: { nth?: number | null; selected?: string[] } = {}): Promise<{ images: string[]; about: string } | null> {
  const d = deps();
  const shots = shotClips(doc);
  if (!shots.length) return null;
  let pick: Clip[] = [];
  if (o.nth) pick = [o.nth === -1 ? shots[shots.length - 1] : shots[o.nth - 1]].filter(Boolean);
  if (!pick.length && o.selected?.length) pick = shots.filter((c) => o.selected!.includes(c.id));
  if (pick.length === 1) {
    const file = d.assetPath(pick[0].asset!);
    if (!file) return null;
    const frames = await d.frames(file).catch(() => [] as string[]);
    const i = shots.indexOf(pick[0]) + 1;
    return frames.length ? { images: frames, about: `shot ${i} (${pick[0].label ?? pick[0].id}): its start, middle and end` } : null;
  }
  const list = (pick.length ? pick : shots).slice(0, 12);
  const middles: string[] = [];
  for (const c of list) {
    const file = d.assetPath(c.asset!);
    if (!file) continue;
    const f = await d.frames(file).catch(() => [] as string[]);
    if (f[1] ?? f[0]) middles.push(f[1] ?? f[0]);
  }
  const sheet = await d.sheet(middles);
  return sheet ? { images: [sheet], about: `a contact sheet of ${middles.length} shots in order, left to right, top to bottom` } : null;
}

/** What the showrunner sees, as a note for an assistant that takes words only. */
export async function lookNote(project: string, request: string, pics: { images: string[]; about: string }, payer: string | null): Promise<{ note: string; aiCredits: number }> {
  const d = deps();
  const r = await d.ask(project, {
    system: 'You look at frames from a video the person is editing and tell the editor, in two or three plain sentences, exactly what you see that matters to the request: who is in frame, what is wrong (faces, hands, continuity, light, framing), and what to change. Be specific and visual. No preamble.',
    prompt: `The person said: "${request.slice(0, 800)}"\nThe pictures: ${pics.about}.`,
    images: pics.images, maxTokens: 800, effort: 'medium',
  });
  const credits = r.house ? d.chargeAi(payer, r.cost, `Showrunner looked: ${request.slice(0, 60)}`) : 0;
  return { note: r.text.trim().slice(0, 900), aiCredits: credits };
}
