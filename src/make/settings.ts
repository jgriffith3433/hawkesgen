// The owner's knobs for the making loop (docs/make.md): the default budget per request, the most retries, the check
// thresholds, whether paid partner models may be routed to, and what a check and a comparison cost. Kept in
// .data/make-settings.json (GET/PUT /v1/make/settings, owner only).

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../quality/index.ts';

export type MakeSettings = {
  /** Credits one request may spend when it names no budget (null: no cap beyond the worst case). */
  defaultBudget: number | null;
  maxRetries: number;
  /** Overrides of the routing data's thresholds (empty: knowledge/routing.json's defaults). */
  thresholds: Partial<Thresholds>;
  /** Paid partner models (video.seedance...) may be routed to when a request allows them. */
  allowPaid: boolean;
  /** Credits charged per quality check (vision questions, face and style scores) and per pairwise comparison. */
  checkCredits: number;
  compareCredits: number;
};

export const MAKE_DEFAULTS: MakeSettings = { defaultBudget: 400, maxRetries: 2, thresholds: {}, allowPaid: false, checkCredits: 2, compareCredits: 2 };

const file = () => path.join(DATA_DIR, 'make-settings.json');

const num = (v: unknown, lo: number, hi: number, def: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : def);

/** Settings, checked: numbers in range, thresholds only for known checks. */
export function cleanMakeSettings(raw: any): MakeSettings {
  const d = MAKE_DEFAULTS;
  const th: Partial<Thresholds> = {};
  for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const v = raw?.thresholds?.[k];
    if (v !== undefined && v !== null && Number.isFinite(Number(v))) th[k] = Math.max(0, Math.min(k === 'identity' ? 1 : 1, Number(v)));
  }
  return {
    defaultBudget: raw?.defaultBudget === null ? null : Math.round(num(raw?.defaultBudget, 1, 100_000, d.defaultBudget!)),
    maxRetries: Math.round(num(raw?.maxRetries, 0, 2, d.maxRetries)),
    thresholds: th,
    allowPaid: typeof raw?.allowPaid === 'boolean' ? raw.allowPaid : d.allowPaid,
    checkCredits: Math.round(num(raw?.checkCredits, 0, 100, d.checkCredits)),
    compareCredits: Math.round(num(raw?.compareCredits, 0, 100, d.compareCredits)),
  };
}

export function makeSettings(): MakeSettings {
  try {
    return cleanMakeSettings(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return { ...MAKE_DEFAULTS };
  }
}

export function saveMakeSettings(patch: Partial<MakeSettings>): MakeSettings {
  const cur = makeSettings();
  const next = cleanMakeSettings({ ...cur, ...patch, thresholds: patch.thresholds ?? cur.thresholds });
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
