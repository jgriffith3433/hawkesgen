// The showrunner's first step (docs/showrunner.md): is this a small edit for the assistant of the scene in front, or a
// production for the planner? Decided by words, not a Claude call, so a small edit costs exactly what it did before
// (one turn of the existing assistant) and the decision is the same every time.
//
//   edit        "make this slow motion", "add rain", "move the camera behind her": the scene in front's own AI
//   production  "a 5-minute pilot about smugglers on a frozen moon", "a trailer for my world", "a new character for this
//               story": the planner, top down, with an approval card before anything costs GPU

export type Role = 'showrunner' | 'editor' | 'director' | 'art director' | 'sound';
export type Route = 'edit' | 'production';
export type ProductionKind = 'show' | 'trailer' | 'short' | 'character' | 'world';
export type Classified = { route: Route; role: Role; kind?: ProductionKind; seconds?: number; why: string };

/** Which role answers small edits for each kind of scene. */
export const ROLE_OF: Record<string, Role> = { video: 'editor', image: 'art director', audio: 'sound', stage: 'director', character: 'art director' };

const FORMAT = /\b(pilot|episode|series|show|season|short film|film|movie|trailer|teaser|sizzle|cutscene|music video|documentary|commercial|ad spot|story|saga)\b/i;
const MAKE = /\b(make|create|write|produce|build|direct|shoot|give me|i want|let'?s do|let'?s make|start|plan|draft|generate|come up with)\b|^\s*(a|an)\b/i;
const LENGTH = /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(minutes?|mins?|seconds?|secs?|s)\b/i;
const NEW_CHAR = /\b(a |another )?new (character|hero|villain|sidekick|creature|protagonist)\b|\bcast (a|someone)\b/i;
const NEW_WORLD = /\b(a |another )?new (world|universe|setting)\b|\bstart (a|my) world\b|\bbuild (a|me a|my) world\b/i;
// Words about the thing in front: these stay small edits even when a format word appears ("trim the trailer").
const LOCAL = /\b(this|these|that|here|the selected|selection|playhead|clip|track|layer|trim|cut out|split|delete|remove|move|nudge|louder|quieter|volume|fade|caption|slow motion|speed up)\b/i;

/** Seconds a request names ("a 5-minute pilot" is 300), else null. */
export function secondsIn(text: string): number | null {
  const m = LENGTH.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(/^m/i.test(m[2]) ? n * 60 : n);
}

function kindOf(t: string): ProductionKind {
  if (NEW_WORLD.test(t)) return 'world';
  if (NEW_CHAR.test(t) && !FORMAT.test(t.replace(/\bstory\b/gi, ''))) return 'character';
  if (/\b(trailer|teaser|sizzle)\b/i.test(t)) return 'trailer';
  if (/\b(pilot|episode|series|show|season)\b/i.test(t)) return 'show';
  return 'short';
}

/**
 * Classifies the person's newest words. `kind` is the scene in front (null: none). `planning`: a production card is
 * waiting for an answer, so what they say now is a change to it ("make it 90 seconds", "drop the second place").
 */
export function classify(text: string, kind: string | null, o: { planning?: boolean } = {}): Classified {
  const t = String(text ?? '').trim();
  const role = ROLE_OF[kind ?? ''] ?? 'editor';
  if (o.planning) return { route: 'production', role: 'showrunner', kind: kindOf(t), seconds: secondsIn(t) ?? undefined, why: 'a change to the plan waiting for approval' };
  const format = FORMAT.test(t);
  const make = MAKE.test(t);
  const secs = secondsIn(t);
  if (NEW_WORLD.test(t)) return { route: 'production', role: 'showrunner', kind: 'world', why: 'a new world' };
  if (NEW_CHAR.test(t) && (/\b(story|show|world|episode|series|film|cast)\b/i.test(t) || kind !== 'character')) {
    return { route: 'production', role: 'showrunner', kind: 'character', why: 'a new character for a story' };
  }
  // A format with a length, or a format being asked for ("a teaser about...", "make a pilot"), is a production; the same
  // words about what's on the timeline ("tighten the trailer's cuts") are not.
  const local = LOCAL.test(t);
  if (format && (secs != null || (make && !local)) && !(local && kind && secs == null)) {
    return { route: 'production', role: 'showrunner', kind: kindOf(t), ...(secs != null ? { seconds: secs } : {}), why: `a ${kindOf(t)}${secs != null ? ` of ${secs} s` : ''}` };
  }
  // No scene in front and a whole idea: plan it.
  if (!kind && make && t.split(/\s+/).length >= 6) return { route: 'production', role: 'showrunner', kind: kindOf(t), ...(secs != null ? { seconds: secs } : {}), why: 'an idea with no scene open' };
  return { route: 'edit', role, why: kind ? `an edit to the ${kind} in front` : 'a small request' };
}

// Turns that point at what was made ("fix the second shot", "her face changed"): the showrunner looks before answering.
const LOOK = /\b(shot|take|frame|face|faces|looks?|changed|different|wrong|weird|broken|off|fix|redo|again|blurry|melt\w*|flicker\w*|glitch\w*|hands?|fingers?|eyes|hair|outfit|costume|color|colour)\b/i;
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1 };

/** Whether the words refer to results (and which one, by position: "the second shot" is 2, "the last shot" is -1). */
export function refersToResults(text: string): { look: boolean; nth: number | null } {
  const t = String(text ?? '');
  const m = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(shot|clip|take|scene)\b/i.exec(t)
    ?? /\b(shot|clip|take)\s+(\d{1,2})\b/i.exec(t);
  const nth = !m ? null : ORDINALS[m[1].toLowerCase()] ?? (Number(m[2]) || null);
  return { look: LOOK.test(t) || nth != null, nth };
}
