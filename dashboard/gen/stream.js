// Gen's live update stream (GET /v1/events, server-sent events), kept open the right way.
//
// A browser's EventSource retries by itself only when a working stream drops. When the answer is an HTTP error (a 500
// or 503 while Gen restarts during a deploy, 2026-11-02: Google's "Server Error" page for about 30 seconds) it gives up
// for good, and the page stopped hearing about jobs and productions until it was reloaded. This opens the stream again
// with a growing wait (2 s, 4 s, 8 s ... 30 s, a little jitter) and, once it is back, calls onReconnect once so the
// page fetches what it missed. No polling: nothing is asked for while the stream is up.
//
// Only named events reach the handlers, and only their data, which is JSON: an error page is never an event, and a
// line that isn't JSON is skipped.

export const RETRY_MIN = 2000;
export const RETRY_MAX = 30000;

/** The wait before try n (0, 1, 2 ...): 2 s doubling to 30 s, plus up to a fifth more so many tabs don't line up. */
export const retryDelay = (n, rand = Math.random) => {
  const base = Math.min(RETRY_MAX, RETRY_MIN * 2 ** Math.max(0, n));
  return Math.round(base + base * 0.2 * rand());
};

/**
 * Opens /v1/events and keeps it open until close().
 * handlers: { job(data), library(data), production(data), ... } by event name, each given the parsed JSON.
 * opts.onReconnect(): after the stream came back from a drop or an error (not on the first open).
 * opts.onState(state): 'live' | 'reconnecting', for a status pill.
 * opts.url, opts.EventSource, opts.setTimeout, opts.clearTimeout, opts.random: for tests.
 */
export function openStream(handlers, opts = {}) {
  const ES = opts.EventSource ?? globalThis.EventSource;
  const later = opts.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = opts.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const url = opts.url ?? '/v1/events';
  let es = null;
  let timer = 0;
  let tries = 0;
  let opened = false;
  let dropped = false;
  let closed = false;

  const state = (s) => { try { opts.onState?.(s); } catch { /* the pill is cosmetic */ } };

  function connect() {
    if (closed) return;
    es = new ES(url);
    es.onopen = () => {
      tries = 0;
      state('live');
      if (opened && dropped) { try { opts.onReconnect?.(); } catch { /* the caller's refresh failed: next event fixes it */ } }
      opened = true;
      dropped = false;
    };
    es.onerror = () => {
      if (closed) return;
      dropped = true;
      state('reconnecting');
      // CONNECTING: the browser is already retrying a stream that dropped. CLOSED: it gave up (an HTTP error, or not an
      // event stream), so it's ours to try again, later and later.
      if (es.readyState !== 2) return;
      es.close();
      es = null;
      cancel(timer);
      timer = later(connect, retryDelay(tries++, opts.random));
    };
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        fn(data);
      });
    }
  }

  connect();
  return {
    close() {
      closed = true;
      cancel(timer);
      es?.close();
      es = null;
    },
  };
}
