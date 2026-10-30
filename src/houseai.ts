// The house AI: Gen app accounts' Claude runs on Gen's own access, so people never connect anything (J, 2026-10-29:
// "Don't make users sign into claude ... we can use mine for the website ... users don't have to deal with this and it
// just works"). The owner sets it in /admin > AI: an Anthropic API key stored here (encrypted like orgs' keys), and/or
// the Claude logins Gen already has (src/claude-accounts.ts, Settings). Which one serves accounts is `source`:
//   auto   the API key when one is set, else the Claude logins
//   api    the API key only (stored here, else ANTHROPIC_API_KEY)
//   claude the Claude logins only
//   off    nobody gets the house AI (accounts with their own key or subscription still work)
// Each AI editor turn on the house AI is charged to the account in credits: the call's cost x markup, at least
// minCredits (a Claude login's calls cost $0, so they take minCredits). An account's own key or subscription, when set,
// still comes first and costs no credits.
//
// Anthropic's consumer plans (Pro, Max) are for one person's own use: serving other people's requests on them can break
// Anthropic's terms, so "auto" prefers the API key and /admin says so.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { env } from './config.ts';
import { orgSecret, orgSecretInfo, setOrgSecret, deleteOrgSecret } from './orgsecrets.ts';
import { activeToken, listAccounts } from './claude-accounts.ts';
import { GenError } from './util.ts';

db.exec('CREATE TABLE IF NOT EXISTS house_ai (k TEXT PRIMARY KEY, v TEXT NOT NULL)');

/** The house key's own "org" in the secret store: hashed, so it is never a customer's. */
export const HOUSE_ORG = `org_${crypto.createHash('sha256').update('gen-house-ai').digest('hex').slice(0, 24)}`;

export type HouseSource = 'auto' | 'api' | 'claude' | 'off';
export type HouseSettings = { source: HouseSource; markup: number; minCredits: number };
const DEFAULTS: HouseSettings = { source: 'auto', markup: 1.5, minCredits: 1 };

export function houseSettings(): HouseSettings {
  const rows = db.prepare('SELECT k, v FROM house_ai').all() as { k: string; v: string }[];
  const o: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.k, JSON.parse(r.v)]));
  return {
    source: (['auto', 'api', 'claude', 'off'] as const).includes(o.source as HouseSource) ? o.source as HouseSource : DEFAULTS.source,
    markup: Number.isFinite(Number(o.markup)) ? Math.min(10, Math.max(1, Number(o.markup))) : DEFAULTS.markup,
    minCredits: Number.isFinite(Number(o.minCredits)) ? Math.min(100, Math.max(0, Math.round(Number(o.minCredits)))) : DEFAULTS.minCredits,
  };
}

export function saveHouseSettings(patch: Partial<HouseSettings>) {
  const put = db.prepare('INSERT INTO house_ai (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  for (const k of ['source', 'markup', 'minCredits'] as const) if (patch[k] !== undefined) put.run(k, JSON.stringify(patch[k]));
  return houseStatus();
}

/** The stored key, else the service's own ANTHROPIC_API_KEY. */
export const houseKey = (): string | null => orgSecret(HOUSE_ORG, 'anthropic') ?? env('ANTHROPIC_API_KEY') ?? null;
const hasLogin = () => { try { return Boolean(activeToken()); } catch { return false; } };

/** What the house AI would run on now: the API key, a Claude login, or nothing (and why). */
export function houseRoute(): { via: 'api'; key: string } | { via: 'claude' } | { via: null; why: string } {
  const s = houseSettings();
  if (s.source === 'off') return { via: null, why: 'The AI is turned off for accounts right now.' };
  const key = s.source === 'claude' ? null : houseKey();
  if (key) return { via: 'api', key };
  if (s.source !== 'api' && hasLogin()) return { via: 'claude' };
  return { via: null, why: 'The AI isn\'t set up on Hawkes Gen yet. Please try again later.' };
}

export const houseReady = () => houseRoute().via !== null;
/** "auto" only: a failing API key may fall back to a Claude login. */
export const houseCanFallBack = () => houseSettings().source === 'auto' && hasLogin();

/** For /admin > AI: the settings, the stored key (last 4 only), the Claude logins, and what accounts get now. */
export function houseStatus() {
  const r = houseRoute();
  let logins: { label: string; active: boolean }[] = [];
  try { logins = listAccounts().accounts.map((a: any) => ({ label: a.label, active: Boolean(a.active) })); } catch { /* */ }
  return {
    ...houseSettings(),
    key: orgSecretInfo(HOUSE_ORG, 'anthropic'),
    envKey: Boolean(env('ANTHROPIC_API_KEY')),
    logins,
    now: r.via ?? 'none',
    why: r.via ? null : (r as { why: string }).why,
  };
}

export const setHouseKey = (key: string, by: string) => { setOrgSecret(HOUSE_ORG, 'anthropic', key, by); return houseStatus(); };
export const clearHouseKey = () => { deleteOrgSecret(HOUSE_ORG, 'anthropic'); return houseStatus(); };

/** Credits for one house AI call: its cost in cents x markup, at least minCredits. */
export function turnCredits(costUsd: number) {
  const s = houseSettings();
  return Math.max(s.minCredits, Math.ceil(Math.max(0, costUsd) * 100 * s.markup));
}

/** Refuses an AI turn the account can't pay for, before Claude is called. */
export function checkCanPay(credits: number) {
  const min = houseSettings().minCredits;
  if (credits < min) throw new GenError(`The AI costs at least ${min} credit${min === 1 ? '' : 's'} a message. Add credits to keep going.`, { status: 402 });
}
