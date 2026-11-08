// What the person sees when a /v1 call fails or the live stream drops (J, 2026-11-08: one plain sentence and a next step,
// never a blank panel, raw JSON, a stack trace or a key). One helper for every page:
//   explain(err)          { kind, text, label, next(retry) }  the sentence and the one thing to do
//   trouble(err, retry)   a toast with that next step (Add credits, Sign in, Try again)
//   troubleNote(err, retry)  the same inside a panel that couldn't load (an .empty-note with the button)
//   initTrouble()         the "Reconnecting…" chip (clears by itself when the stream is back: jobWatch's states, no
//                         timers, no fetches), the offline chip, and the sign-in prompt when a session ends mid-work.
import { $, h, bus, toast, friendly, plainError } from './lib.js';
import { state, openAccount, needSignIn, showMe } from './account.js';

/** Never raw JSON, a trace or a key in words for a person. */
export function scrub(text) {
  let t = plainError(text);
  if (/^\s*[{[]/.test(t) || /"\w+"\s*:/.test(t)) t = 'Something went wrong.';
  t = t.replace(/\b(?:hg_|hgm_|sk-ant-|sk_live_|sk_test_|AIza)[\w-]{6,}/g, 'a key');
  return t;
}

/** The sentence, the button's label, and what the button does (`retry` is the caller's own way to try again). */
export function explain(err) {
  const f = friendly(err);
  const text = scrub(f.text);
  const labels = { credits: 'Add credits', signin: 'Sign in', retry: 'Try again', connection: 'Try again', ai: 'Try again' };
  const label = labels[f.fix] ?? null;
  const next = (retry) => {
    if (f.fix === 'credits') return openAccount('credits');
    if (f.fix === 'signin') return needSignIn(() => retry?.(), 'login');
    retry?.();
  };
  return { kind: f.kind, text, label, next, wait: f.wait ?? null, fix: f.fix };
}

/** A toast: the sentence plus its next step. */
export function trouble(err, retry) {
  const e = explain(err);
  // A retry that has nothing to run isn't offered; credits and sign-in always are.
  const offer = e.label && (retry || e.fix === 'credits' || e.fix === 'signin');
  toast(e.text, offer ? { action: e.label, onAction: () => e.next(retry), ms: 9000 } : { ms: 6500 });
  return e;
}

/** A panel that couldn't load: one sentence and a button, in place of nothing. */
export function troubleNote(err, retry) {
  const e = explain(err);
  const offer = e.label && (retry || e.fix === 'credits' || e.fix === 'signin');
  return h('div', { class: 'empty-note trouble', role: 'alert', 'data-kind': e.kind },
    h('p', {}, e.text),
    offer ? h('button', { class: 'ghost small', onclick: () => e.next(retry) }, e.label) : '');
}

let chip = null;
let streamDown = false;
const showChip = () => {
  if (!chip) return;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  chip.textContent = offline ? 'You\'re offline: your work is kept here' : 'Reconnecting…';
  chip.dataset.kind = offline ? 'offline' : 'reconnecting';
  chip.hidden = !(offline || streamDown);
};

/** The stream's state ('live' | 'reconnecting') as the chip shows it. jobWatch reports it; the playtest forces it. */
export function streamState(st) { streamDown = st === 'reconnecting'; showChip(); }

export function initTrouble() {
  chip = $('#netChip');
  addEventListener('online', showChip);
  addEventListener('offline', showChip);
  // The stream's own states (jobWatch -> stream.js onState): shown while it retries, gone the moment it's live again.
  import('./jobwatch.js').then(({ jobWatch }) => jobWatch()).then((w) => {
    w.onState(streamState);
  }).catch(() => {});
  // A 401 on any call but the session probe: the session ended. Sign in again; the open scene stays as it is.
  let shown = 0;
  bus.on('sessionEnded', () => {
    if (!state.user || Date.now() - shown < 8000) return;
    shown = Date.now();
    state.user = null;
    showMe();
    const e = explain({ status: 401 });
    toast(e.text, { action: 'Sign in', onAction: () => needSignIn(() => import('./account.js').then((m) => m.loadMe()), 'login'), ms: 12000 });
  });
}
