// The gate in front of AI turns (the editor, director, scene and world AIs): a few slots, first come first served.
//
// Before, a turn that found every slot busy waited for as long as it took, and said nothing. Now:
//   - one account may have `maxPerUser` turns going or waiting at once (a plain 429 beyond it),
//   - a turn that has to wait is told its place in line (`onWait`, which the app shows: "In line, 2 ahead"),
//   - and it gives up after `maxWaitMs` with a plain 503 that says where it stood. Nothing is charged for a turn that
//     never ran (AI turns are billed from the answer, after the call).
// Calls with no `who` (Gen's own jobs: reviews, judges, captions) keep the old rule: they wait their turn, with no bound.
import { GenError } from './util.ts';

export type WaitInfo = { state: 'waiting' | 'running' | 'gone'; position: number; ahead: number };
export type GateOpts = { who?: string; maxPerUser?: number; maxWaitMs?: number; onWait?: (e: WaitInfo) => void; signal?: AbortSignal };

type Entry = { who?: string; grant: () => void; onWait?: (e: WaitInfo) => void };

export function createGate(cap: () => number) {
  let running = 0;
  const waiting: Entry[] = [];
  const held = new Map<string, number>();
  const hold = (who: string | undefined, d: number) => { if (who) held.set(who, Math.max(0, (held.get(who) ?? 0) + d)); };
  const tell = (e: Entry, i: number) => { try { e.onWait?.({ state: 'waiting', position: i + 1, ahead: i }); } catch { /* the listener's problem */ } };
  const notify = () => waiting.forEach(tell);
  const pump = () => {
    while (running < cap() && waiting.length) {
      const e = waiting.shift()!;
      running++;
      e.grant();
    }
    notify();
  };

  /** Resolves with a release function once a slot is yours. Throws a plain GenError when refused or out of patience. */
  async function acquire(o: GateOpts = {}): Promise<() => void> {
    const { who, signal } = o;
    if (who && o.maxPerUser && (held.get(who) ?? 0) >= o.maxPerUser) {
      throw new GenError(`You already have ${o.maxPerUser} AI requests going. Wait for one to finish, then ask again.`, { status: 429, kind: 'busy' });
    }
    if (signal?.aborted) throw new GenError('Cancelled', { status: 499, kind: 'cancelled' });
    hold(who, 1);
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      running--;
      hold(who, -1);
      pump();
    };
    if (running < cap() && !waiting.length) {
      running++;
      return release;
    }
    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Entry = { who, onWait: o.onWait, grant: () => { cleanup(); try { o.onWait?.({ state: 'running', position: 0, ahead: 0 }); } catch { /* as above */ } resolve(release); } };
      const leave = (err: GenError) => {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        done = true;
        hold(who, -1);
        cleanup();
        try { o.onWait?.({ state: 'gone', position: 0, ahead: 0 }); } catch { /* as above */ }
        notify();
        reject(err);
      };
      const onAbort = () => leave(new GenError('Cancelled while waiting for the AI', { status: 499, kind: 'cancelled' }));
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (who && o.maxWaitMs) {
        timer = setTimeout(() => {
          const place = waiting.indexOf(entry) + 1;
          leave(new GenError(`The AI is busy right now${place ? ` (you were number ${place} in line)` : ''}. Nothing was used: try again in a minute.`, { status: 503, kind: 'busy' }));
        }, o.maxWaitMs);
        timer.unref?.();
      }
      waiting.push(entry);
      tell(entry, waiting.length - 1);
    });
  }

  return { acquire, load: () => ({ running, waiting: waiting.length, cap: cap() }) };
}
