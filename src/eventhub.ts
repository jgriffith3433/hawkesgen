// The live stream's hub (GET /v1/events): one bus listener per event name for the whole process, not four to six per
// connection. Each event is serialised once and written only to the streams that may see it: streams are bucketed by
// the project they are fixed to (a customer's own project) so an event touches its owner's streams, and the few wide
// ones (owner, admin, pattern keys such as the portal's usr_*) are checked with canProject. A user holds at most
// MAX_STREAMS_PER_USER streams: the oldest is told to stand down (`event: bye`, reason "limit") and closed, and the
// page's client (dashboard/gen/stream.js) opens one again after a pause. Admin-only events (machines, bench) go to
// streams opened with `ops`.
import { events } from './bus.ts';
import { canProject, fixedProject, type Client } from './auth.ts';

export const MAX_STREAMS_PER_USER = 3;
/** Event name -> where the project is in the payload. null: admin streams only (no project). */
const TOPICS: Record<string, ((e: any) => string) | null> = {
  job: (j) => String(j.project),
  library: (e) => String(e.entity).split('/')[0],
  production: (e) => String(e.project),
  scene: (e) => String(e.project),
  machines: null,
  bench: null,
};

export type Sink = { write(chunk: string): unknown; end(): unknown };
type Stream = { id: number; client: Client; user: string; sink: Sink; ops: boolean; fixed: string | null; transform: (name: string, data: any) => any };

const plain = (_n: string, d: any) => d;
let nextId = 1;
const byUser = new Map<string, Stream[]>();
const byProject = new Map<string, Set<Stream>>();
const wide = new Set<Stream>();
let attached = false;

/** Who counts as one user for the cap: the key (or token), and the projects it was narrowed to. */
const userOf = (c: Client) => `${c.id}|${c.projects.join(',')}`;

function attach() {
  if (attached) return;
  attached = true;
  // The hub is the bus's only stream listener, however many connections there are, so no listener-count warning.
  for (const name of Object.keys(TOPICS)) events.on(name, (data: any) => dispatch(name, data));
}

function safeWrite(s: Stream, text: string) {
  try { s.sink.write(text); } catch { remove(s); }
}

function dispatch(name: string, data: any) {
  const projectOf = TOPICS[name];
  const frames = new Map<(n: string, d: any) => any, string>();
  const send = (s: Stream) => {
    // Customers get the public shape of a job; serialised once per shape.
    let text = frames.get(s.transform);
    if (text === undefined) { text = `event: ${name}\ndata: ${JSON.stringify(s.transform(name, data))}\n\n`; frames.set(s.transform, text); }
    safeWrite(s, text);
  };
  if (projectOf === null) { for (const s of all()) if (s.ops) send(s); return; }
  const project = projectOf(data);
  for (const s of byProject.get(project) ?? []) send(s);
  for (const s of wide) if (canProject(s.client, project)) send(s);
}

function* all() { for (const list of byUser.values()) yield* list; }

function remove(s: Stream) {
  const list = byUser.get(s.user);
  if (list) { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); if (!list.length) byUser.delete(s.user); }
  if (s.fixed) { const set = byProject.get(s.fixed); set?.delete(s); if (set && !set.size) byProject.delete(s.fixed); } else wide.delete(s);
}

/**
 * Registers an open stream. Returns a function that unregisters it (call when the connection closes). Streams past the
 * user's cap: the oldest are sent `bye` and ended.
 * transform(name, data): what the stream is shown (a customer's jobs without internals).
 */
export function addStream(client: Client, sink: Sink, opts: { ops: boolean; transform?: (name: string, data: any) => any }): () => void {
  attach();
  const fixed = fixedProject(client);
  const s: Stream = { id: nextId++, client, user: userOf(client), sink, ops: opts.ops, fixed, transform: opts.transform ?? plain };
  const list = byUser.get(s.user) ?? [];
  list.push(s);
  byUser.set(s.user, list);
  if (fixed) { const set = byProject.get(fixed) ?? new Set(); set.add(s); byProject.set(fixed, set); } else wide.add(s);
  while (list.length > MAX_STREAMS_PER_USER) {
    const old = list[0];
    remove(old);
    try { old.sink.write('event: bye\ndata: {"reason":"limit","max":' + MAX_STREAMS_PER_USER + '}\n\n'); old.sink.end(); } catch { /* already gone */ }
  }
  return () => remove(s);
}

/** Every open stream (for health and tests). */
export function streamCount(user?: Client): number {
  return user ? byUser.get(userOf(user))?.length ?? 0 : [...all()].length;
}
