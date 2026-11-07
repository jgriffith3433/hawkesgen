// Canned answers for ask() (HAWKESGEN_AI_MOCK=1), so tests and Studio's playtests can drive the editor, director, scene
// and showrunner routes without calling Claude. The mock sits inside ask() (providers/anthropic.ts), below every route:
// the route code, prompts and answer parsing run unchanged; only the model call is replaced.
//
//   - Off unless HAWKESGEN_AI_MOCK=1 (same style as HAWKESGEN_QUALITY_MOCK / HAWKESGEN_AUDIO_MOCK).
//   - Only for a test account: one made by the test sign-in (POST /v1/users/test-session, or its GitHub twin), which is
//     the only way an account gets a `playtest:` Google id. A real user, an API key, a customer's org, Gen's own jobs:
//     never, flag or not. Each test account has its own queue.
//   - A queued answer is matched by a substring of the prompt (or system text), else taken in order (the first answer
//     with no `match`). Each answer is used `times` times (default 1). Its `cost` (dollars) is what the call reports, so
//     the house AI's credit charge can be tested. Nothing queued for a call: the call runs for real, as without the flag.
import { db } from './db.ts';
import { env } from './config.ts';
import { GenError } from './util.ts';
import { genAccountOrg } from './orgsecrets.ts';

export type CannedAnswer = {
  /** A substring of the prompt (or the system text) this answer is for; none: the next call, in order. */
  match?: string;
  /** The answer's text. */
  text?: string;
  /** Or a value, sent as JSON (a schema call's answer, the editor's `{ say, ops }`). */
  json?: unknown;
  /** Dollars the call reports (the house AI turns it into credits). Default 0. */
  cost?: number;
  model?: string;
  /** How many calls it answers. Default 1. */
  times?: number;
};
type Queued = { match: string | null; text: string; cost: number; model: string; times: number };

export const aiMockOn = () => env('HAWKESGEN_AI_MOCK') === '1';

/** Whether a user is a test account: signed in through the test sign-in (its Google id is `playtest:<project>`). */
export function isTestUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return Boolean(db.prepare("SELECT 1 FROM user_google WHERE user_id = ? AND sub LIKE 'playtest:%'").get(userId));
}

const queues = new Map<string, Queued[]>();

/** The queue's key for a user: its project (a test account's calls arrive with the org that project maps to). */
function projectOf(userId: string): string | null {
  const r = db.prepare('SELECT project FROM users WHERE id = ?').get(userId) as { project: string } | undefined;
  return r?.project ?? null;
}

/** Queue canned answers for a test account's calls. Throws unless the flag is on and the user is a test account. */
export function queueAnswers(userId: string, answers: CannedAnswer[]) {
  if (!aiMockOn()) throw new GenError('The AI mock is off here', { status: 404 });
  if (!isTestUser(userId)) throw new GenError('Only a test sign-in account can queue canned AI answers', { status: 403 });
  const project = projectOf(userId)!;
  const q = queues.get(project) ?? [];
  for (const a of answers) {
    const text = a.text ?? (a.json !== undefined ? JSON.stringify(a.json) : null);
    if (text == null) throw new GenError('A canned answer needs text or json', { status: 400 });
    const cost = a.cost == null ? 0 : Number(a.cost);
    if (!Number.isFinite(cost) || cost < 0) throw new GenError('A canned answer\'s cost is dollars, 0 or more', { status: 400 });
    q.push({ match: a.match ? String(a.match) : null, text, cost, model: a.model ? String(a.model) : 'mock', times: Math.max(1, Math.floor(Number(a.times ?? 1)) || 1) });
  }
  queues.set(project, q);
  return mockStatus(userId);
}

export function clearAnswers(userId: string) {
  const project = projectOf(userId);
  if (project) queues.delete(project);
  return mockStatus(userId);
}

export function mockStatus(userId: string) {
  const project = projectOf(userId);
  const q = (project && queues.get(project)) || [];
  return { on: aiMockOn(), test: isTestUser(userId), queued: q.reduce((n, a) => n + a.times, 0), answers: q.map((a) => ({ match: a.match, cost: a.cost, times: a.times })) };
}

/** The canned answer for a call from `org` (the org a Gen account's project maps to), or null to run the call for real. */
export function takeAnswer(org: string | null | undefined, p: { prompt: string; system?: string }): { text: string; model: string; cost: number } | null {
  if (!aiMockOn() || !org || !queues.size) return null;
  // Only a test account's org: look it up now, so a flag on a real user's call changes nothing.
  const rows = db.prepare("SELECT u.project FROM users u JOIN user_google g ON g.user_id = u.id WHERE g.sub LIKE 'playtest:%'").all() as { project: string }[];
  let project: string | null = null;
  for (const r of rows) if (queues.has(r.project) && orgOfTestProject(r.project) === org) { project = r.project; break; }
  if (!project) return null;
  const q = queues.get(project)!;
  const hay = `${p.system ?? ''}\n${p.prompt}`;
  let i = q.findIndex((a) => a.match != null && hay.includes(a.match));
  if (i < 0) i = q.findIndex((a) => a.match == null);
  if (i < 0) return null;
  const a = q[i];
  if (--a.times <= 0) q.splice(i, 1);
  if (!q.length) queues.delete(project);
  return { text: a.text, model: a.model, cost: a.cost };
}

const orgOfTestProject = (project: string) => genAccountOrg(project.split('.')[0]);
