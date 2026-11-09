// Following jobs without polling (2026-11-02: the app asked GET /v1/jobs/<id> every 1.5 s per job it waited on, and
// every 2.5 s per waiting clip; each ask ran Cloudflare's Worker in front of Gen). One live stream (GET /v1/events,
// this account's jobs) for the whole page: a job is read once when it's followed, then follows its events; it is read
// once more when it ends (its outputs in full) and after the stream comes back from a drop. The stream is open only
// while the page is on screen and something listens; a hidden page catches up when it's shown again. No timers.
import { openStream as realOpenStream } from './stream.js';

const ENDED = new Set(['done', 'failed', 'cancelled']);
export const ended = (j) => ENDED.has(j?.status);

/**
 * The watcher. Everything it touches comes in, so tests run it without a browser.
 * fetchJob(id) reads a job (GET /v1/jobs/<id>); openStream(handlers, opts) is stream.js's; hidden() says whether the
 * page is hidden, and onVisible(fn) calls fn when that changes.
 */
export function createJobWatch({ fetchJob, openStream = realOpenStream, hidden = () => false, onVisible = () => {} }) {
  /** id -> { last, updates: [fn], ends: [fn] } (two callers following one job share it) */
  const following = new Map();
  /** { onJob, onReconnect } */
  const listeners = new Set();
  /** event name -> Set of { fn, onReconnect }: the stream's other events (scene, production ...) for pages that want them */
  const topics = new Map();
  let stream = null;
  /** fn(state) for 'live' | 'reconnecting': the "Reconnecting…" chip */
  const states = new Set();

  function finish(id, j) {
    const w = following.get(id);
    if (!w) return;
    following.delete(id);
    for (const end of w.ends) end(j);
    update();
  }
  /** One read of a job: its whole answer (queue place, outputs) and, when it ended, the end. */
  async function read(id) {
    const w = following.get(id);
    if (!w) return;
    let j;
    try { j = await fetchJob(id); } catch { return; /* the next event or reconnect tries again */ }
    if (!following.has(id)) return;
    w.last = j;
    if (ended(j)) return finish(id, j);
    tell(w, j);
  }
  function tell(w, j) {
    for (const fn of w.updates) { try { fn(j); } catch { /* the caller's drawing failed: the next event draws again */ } }
  }
  function onJob(j) {
    for (const l of listeners) { try { l.onJob(j); } catch { /* one listener's error never stops the others */ } }
    const w = j?.id && following.get(j.id);
    if (!w) return;
    // The event is the job's summary (no queue place): what the last read said is kept for what the event lacks.
    const merged = { ...w.last, ...j, queue: j.queue ?? (j.status === 'queued' ? w.last?.queue : undefined) };
    w.last = merged;
    if (ended(merged)) { void read(j.id); return; }
    tell(w, merged);
  }
  function onTopic(name) {
    return (data) => { for (const t of topics.get(name) ?? []) { try { t.fn(data); } catch { /* as above */ } } };
  }
  function topicsOpen() { return [...topics.values()].some((set) => set.size > 0); }
  function readAll() { for (const id of [...following.keys()]) void read(id); }
  function tellReconnect() {
    for (const l of listeners) { try { l.onReconnect?.(); } catch { /* as above */ } }
    for (const set of topics.values()) for (const t of set) { try { t.onReconnect?.(); } catch { /* as above */ } }
  }
  function update() {
    const want = !hidden() && (following.size > 0 || listeners.size > 0 || topicsOpen());
    if (!want) { stream?.close(); stream = null; return; }
    // Each time the stream opens (the first time too) the followed jobs are read once: an end that came before it is seen.
    if (!stream) stream = openStream({ job: onJob, scene: onTopic('scene'), production: onTopic('production'), ai: onTopic('ai') }, { onState: (st) => { if (st === 'live') readAll(); for (const fn of states) { try { fn(st); } catch { /* cosmetic */ } } }, onReconnect: tellReconnect });
  }
  let wasHidden = hidden();
  onVisible(() => {
    const now = hidden();
    update();
    // Shown again: update() opened the stream, which reads the followed jobs; listeners catch up too.
    if (wasHidden && !now) tellReconnect();
    wasHidden = now;
  });

  return {
    /**
     * Follows a job until it ends; resolves with the ended job (done, failed or cancelled). It is registered before its
     * first read, so an end that arrives meanwhile is never missed. The first read's error rejects.
     */
    follow(id, onUpdate) {
      return new Promise((resolve, reject) => {
        let w = following.get(id);
        const first = !w;
        if (first) { w = { last: null, updates: [], ends: [] }; following.set(id, w); }
        if (onUpdate) w.updates.push(onUpdate);
        w.ends.push(resolve);
        update();
        if (!first) { if (w.last && onUpdate) { try { onUpdate(w.last); } catch { /* drawing */ } } return; }
        fetchJob(id).then((j) => {
          if (following.get(id) !== w) return;
          w.last = j;
          if (ended(j)) finish(id, j); else tell(w, j);
        }, (e) => {
          if (following.get(id) === w) following.delete(id);
          update();
          reject(e);
        });
      });
    },
    /** Every job event of this account while on screen; onReconnect after a drop or coming back on screen. Returns stop. */
    listen(onJobEvent, onReconnect) {
      const l = { onJob: onJobEvent, onReconnect };
      listeners.add(l);
      update();
      return () => { listeners.delete(l); update(); };
    },
    /**
     * One of the stream's other events ('scene': { id, project, kind, version }; 'production') while the page is on screen.
     * onReconnect after a drop or coming back on screen: read what you show once. Returns stop.
     */
    on(name, fn, onReconnect) {
      const t = { fn, onReconnect };
      if (!topics.has(name)) topics.set(name, new Set());
      topics.get(name).add(t);
      update();
      return () => { topics.get(name)?.delete(t); update(); };
    },
    /** The stream's state ('live' | 'reconnecting') as it changes, for a status chip. Returns stop. */
    onState(fn) { states.add(fn); update(); return () => states.delete(fn); },
    /** For tests and the page: how many jobs are followed, and whether the stream is open. */
    get following() { return following.size; },
    get open() { return Boolean(stream); },
  };
}

let shared = null;
/** The page's one watcher (lazily, so a module that only imports `ended` needs no browser). */
export async function jobWatch() {
  if (shared) return shared;
  const { api } = await import('./lib.js');
  shared = createJobWatch({
    fetchJob: (id) => api(`/v1/jobs/${id}`),
    hidden: () => document.hidden,
    onVisible: (fn) => document.addEventListener('visibilitychange', fn),
  });
  return shared;
}
