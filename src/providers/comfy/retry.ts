// "Keep trying": repeats a launch or start that failed because AWS had no
// machines free (or quota was short) until it works, fails some other way, or
// the time allowed runs out. A start tries every stopped server (each can only
// start in its own zone); with fallbackLaunch, once nothing could start twice
// in a row, it launches a fresh server wherever machines are free.
// State survives a restart (DATA_DIR/fleet/retry.json).

import fs from 'node:fs';
import path from 'node:path';
import { paths, loadSettings } from '../../config.ts';
import { GenError } from '../../util.ts';
import { fleetStatus, launchServer, startServer, imageAvailable } from './fleet.ts';

const RETRYABLE = new Set(['capacity', 'quota']);
const FILE = path.join(paths.fleet, 'retry.json');

export type RetryState = {
  active: boolean; action: 'launch' | 'start'; opts: any; every: number; started: number; until: number; next: number | null;
  tries: number; log: any[]; result: any; error: any; ended?: string; misses?: number;
};

export class Retry {
  state: RetryState | null = null;
  timer: NodeJS.Timeout | null = null;
  onSuccess?: (s: RetryState) => void;

  constructor({ onSuccess }: { onSuccess?: (s: RetryState) => void } = {}) {
    this.onSuccess = onSuccess;
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (saved?.active && saved.until > Date.now()) {
        this.state = saved;
        saved.log.push({ at: Date.now(), ok: true, message: 'picked up again after a restart' });
        this.schedule(Math.max(5000, (saved.next ?? 0) - Date.now()));
      } else {
        this.state = saved?.active ? { ...saved, active: false, next: null, ended: 'timed out while Hawkes Gen was down' } : saved;
      }
    } catch {
      // Nothing saved.
    }
  }

  save() {
    fs.writeFileSync(FILE, JSON.stringify(this.state));
  }

  schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.state!.next = Date.now() + ms;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.save();
  }

  start({ action, opts = {}, minutes = 60, every = 180 }: { action: 'launch' | 'start'; opts?: any; minutes?: number; every?: number }) {
    this.stop();
    const now = Date.now();
    this.state = {
      active: true, action, opts, every: Math.max(60, Math.min(900, every)), started: now,
      until: now + Math.max(5, Math.min(12 * 60, minutes)) * 60 * 1000, next: now, tries: 0, log: [], result: null, error: null,
    };
    this.save();
    void this.tick();
    return this.state;
  }

  stop(reason = 'stopped') {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state?.active) {
      Object.assign(this.state, { active: false, next: null, ended: reason });
      this.save();
    }
  }

  async startAny(s: RetryState) {
    const all = await fleetStatus();
    const up = all.find((st) => ['running', 'pending'].includes(st.state!));
    if (up) return { id: up.id, region: up.region };
    const attempts: any[] = [];
    let last: any = null;
    for (const st of all.filter((x) => x.state === 'stopped' && !x.imageSource && !x.purpose)) {
      try {
        return await startServer(st.id);
      } catch (e: any) {
        last = e;
        attempts.push(...(e.attempts?.length ? e.attempts : [{ region: st.region, zone: st.zone, code: e.name, kind: e.kind ?? 'other', message: e.message }]));
        if (!RETRYABLE.has(e.kind)) throw e;
      }
    }
    s.misses = (s.misses ?? 0) + 1;
    // With the image, launching is as quick as starting (and disposable servers aren't kept stopped), so do it straight away.
    const fromImage = await imageAvailable();
    if ((s.opts.fallbackLaunch && (s.misses >= 2 || !all.length)) || fromImage) {
      const r = await launchServer({ idleMinutes: s.opts.idleMinutes ?? loadSettings().fleet.idleMinutes, region: 'auto', type: 'auto' }).catch((e) => {
        throw new GenError(`No stopped server could start, and a new one couldn't launch either: ${e.message}`, { status: 409, kind: e.kind ?? 'capacity', attempts: [...attempts, ...(e.attempts ?? [])] });
      });
      return { ...r, launched: true };
    }
    if (!all.length) throw new GenError('There is no GPU server to start.', { status: 409 });
    const where = [...new Set(attempts.map((a) => `${a.region}${a.zone ? ` ${a.zone}` : ''}`))].join(', ');
    throw new GenError(`No stopped server could start: AWS has no machines free in ${where}.${s.opts.fallbackLaunch ? ' Next round launches a new one where machines are free.' : ''}`, { status: 409, kind: last?.kind ?? 'capacity', attempts });
  }

  async tick() {
    const s = this.state;
    if (!s?.active) return;
    s.tries++;
    const at = Date.now();
    try {
      const result: any = s.action === 'launch' ? await launchServer(s.opts) : await this.startAny(s);
      s.log.push({ at, ok: true, message: result.launched || s.action === 'launch' ? `launched in ${result.region} ${result.zone ?? ''}` : `started ${result.id} in ${result.region}` });
      Object.assign(s, { active: false, next: null, result, ended: 'done' });
      this.save();
      this.onSuccess?.(s);
    } catch (e: any) {
      const kind = e.kind ?? 'other';
      s.log.push({ at, ok: false, kind, message: e.message, attempts: e.attempts ?? [] });
      s.log = s.log.slice(-50);
      if (!RETRYABLE.has(kind)) {
        Object.assign(s, { active: false, next: null, error: { message: e.message, kind, attempts: e.attempts ?? [] }, ended: 'failed' });
        this.save();
        return;
      }
      if (Date.now() + s.every * 1000 > s.until) {
        Object.assign(s, { active: false, next: null, error: { message: `Gave up after ${s.tries} tries: ${e.message}`, kind, attempts: e.attempts ?? [] }, ended: 'timed out' });
        this.save();
        return;
      }
      this.schedule(s.every * 1000);
    }
  }
}
