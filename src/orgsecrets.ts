// An org's own Claude access (J, 2026-10-29: "they can use their own key or log into claude and use their subscription
// (not our key/plan)"). A customer org gives Gen its own Anthropic API key (Anthropic bills them) or its own Claude
// subscription's token (`claude setup-token`; Claude Code runs on their plan). Its jobs' Claude calls run on that, the
// key first; with neither they're refused with what to do. Never Gen's key or J's Max plan (providers/anthropic.ts).
//
// Stored encrypted (AES-256-GCM) with HAWKESGEN_SECRETS_KEY (32 bytes, base64; Secret Manager on the cloud lanes). Without
// it, orgs can't store keys and say so. The key is never returned: only whether one is set and its last 4 characters.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { env } from './config.ts';
import { GenError } from './util.ts';

db.exec(`CREATE TABLE IF NOT EXISTS org_secrets (org TEXT NOT NULL, kind TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, last4 TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT, PRIMARY KEY (org, kind))`);

export type SecretKind = 'anthropic' | 'claude-subscription';
const ORG_ID = /^org_[0-9a-f]{8,32}$/;

function masterKey(): Buffer {
  const raw = env('HAWKESGEN_SECRETS_KEY');
  const k = raw ? Buffer.from(raw, 'base64') : null;
  if (!k || k.length !== 32) throw new GenError('Org keys are not set up on this Gen (HAWKESGEN_SECRETS_KEY)', { status: 503 });
  return k;
}

/** The org a project belongs to: `org_<hex>` or `org_<hex>.<game>`, or a hawkesgen.ai account's own project
 *  (`usr_<hex>`, `ustg_<hex>` on beta), whose org is its personal org `org_<hex>`, or a Gen app account's (`u_<hex>`,
 *  src/users.ts), whose org is derived from it in a namespace of its own (`genAccountOrg`). Else null. */
export function orgOfProject(project: string): string | null {
  const o = project.split('.')[0];
  if (ORG_ID.test(o)) return o;
  const m = /^(?:usr|ustg)_([0-9a-f]{8,32})$/.exec(o);
  if (m) return `org_${m[1]}`;
  const g = /^u_([0-9a-f]{8,32})$/.exec(o);
  return g ? genAccountOrg(o) : null;
}

/** A Gen app account's own org: hashed, so it can never be a hawkesgen.ai org (Gen and the portal are separate products). */
export const genAccountOrg = (project: string) => `org_${crypto.createHash('sha256').update(`gen-account:${project}`).digest('hex').slice(0, 24)}`;

export function setOrgSecret(org: string, kind: SecretKind, value: string, by: string) {
  if (!ORG_ID.test(org)) throw new GenError('Not an org');
  const v = String(value ?? '').trim();
  if (kind === 'anthropic' && !/^sk-ant-api\d{2}-[\w-]{20,}$/.test(v)) throw new GenError('That is not an Anthropic API key (sk-ant-api...)', { status: 400 });
  if (kind === 'claude-subscription' && !/^sk-ant-oat\d{2}-[\w-]{20,}$/.test(v)) throw new GenError('That is not a Claude sign-in token: run `claude setup-token` and paste what it prints (sk-ant-oat...)', { status: 400 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  c.setAAD(Buffer.from(`${org}:${kind}`));
  const data = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  db.prepare(`INSERT INTO org_secrets (org, kind, iv, tag, data, last4, updated, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(org, kind) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, last4 = excluded.last4, updated = excluded.updated, by = excluded.by`)
    .run(org, kind, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64'), v.slice(-4), Date.now(), by);
  return orgSecretInfo(org, kind);
}

export function deleteOrgSecret(org: string, kind: SecretKind) {
  db.prepare('DELETE FROM org_secrets WHERE org = ? AND kind = ?').run(org, kind);
  return orgSecretInfo(org, kind);
}

/** Whether a key is set, and its last 4 characters (never the key). */
export function orgSecretInfo(org: string, kind: SecretKind) {
  const r = db.prepare('SELECT last4, updated, by FROM org_secrets WHERE org = ? AND kind = ?').get(org, kind) as { last4: string; updated: number; by: string } | undefined;
  return r ? { kind, set: true, last4: r.last4, updated: r.updated, by: r.by } : { kind, set: false };
}

/** The org's key, for its own jobs' calls only; null when none is set (or the store can't be read). */
export function orgSecret(org: string, kind: SecretKind): string | null {
  const r = db.prepare('SELECT iv, tag, data FROM org_secrets WHERE org = ? AND kind = ?').get(org, kind) as { iv: string; tag: string; data: string } | undefined;
  if (!r) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(r.iv, 'base64'));
    d.setAAD(Buffer.from(`${org}:${kind}`));
    d.setAuthTag(Buffer.from(r.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(r.data, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    console.error(`[orgsecrets] could not read ${org}'s ${kind} key: ${(e as Error).message}`);
    return null;
  }
}
