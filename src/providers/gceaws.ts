// AWS without stored keys when the control server runs on Google Compute Engine (docs/gcp.md, "Keyless AWS").
//
// The VM's service account asks the GCE metadata server for a Google-signed ID token with a fixed audience, and AWS STS
// trades it for the role hawkes/hawkes-control-gce (AssumeRoleWithWebIdentity: the role trusts accounts.google.com with
// that service account's unique id; hawkesstudio deploy/gcp/aws-federation.mjs makes it). The temporary credentials are
// shared by every AWS client in this process and renewed 10 minutes before they expire. Nothing touches the disk.
//
// On when HAWKES_AWS_FEDERATION=gce (the hawkes-gen unit's GCP drop-in sets it), with
//   HAWKES_AWS_ROLE_ARN   arn:aws:iam::<account>:role/hawkes/hawkes-control-gce
//   HAWKES_AWS_AUDIENCE   the audience the role's trust policy expects (default hawkes-control-aws)
// awsConfig() (comfy/fleet.ts) returns { region, credentials: gceAwsCredentials } then.
//
// No SDK: one unsigned POST to STS's query API, so Studio (no AWS SDK of its own) uses the same code path.

import os from 'node:os';

export const DEFAULT_AUDIENCE = 'hawkes-control-aws';
const METADATA = 'http://169.254.169.254/computeMetadata/v1';
/** Renew this long before the credentials expire. */
const EARLY_MS = 10 * 60_000;

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
type Fetch = typeof fetch;

export function federationOn(env: Record<string, string | undefined> = process.env) {
  return env.HAWKES_AWS_FEDERATION === 'gce';
}

/** A Google-signed ID token for this VM's service account (valid an hour), from the metadata server. */
export async function gceIdentityToken(audience: string, f: Fetch = fetch): Promise<string> {
  const url = `${METADATA}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=standard`;
  const r = await f(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  const text = (await r.text()).trim();
  if (!r.ok || text.split('.').length !== 3) throw new Error(`GCE metadata gave no identity token (HTTP ${r.status}): is this a GCE VM with a service account?`);
  return text;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/** STS AssumeRoleWithWebIdentity (no signature needed: the token is the proof). */
export async function assumeRoleWithWebIdentity(o: { roleArn: string; token: string; sessionName: string; durationSeconds?: number; region?: string }, f: Fetch = fetch): Promise<AwsCreds> {
  const region = o.region ?? 'us-east-1';
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: o.roleArn, RoleSessionName: o.sessionName,
    WebIdentityToken: o.token, DurationSeconds: String(o.durationSeconds ?? 3600),
  }).toString();
  const r = await f(`https://sts.${region}.amazonaws.com/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, body, signal: AbortSignal.timeout(15_000) });
  const xml = await r.text();
  if (!r.ok) {
    const err: any = new Error(`AWS STS refused the GCE identity (${r.status} ${tag(xml, 'Code') ?? ''}: ${tag(xml, 'Message') ?? xml.slice(0, 200)})`);
    err.name = tag(xml, 'Code') ?? 'AccessDenied';
    throw err;
  }
  const accessKeyId = tag(xml, 'AccessKeyId');
  const secretAccessKey = tag(xml, 'SecretAccessKey');
  const sessionToken = tag(xml, 'SessionToken');
  const expiration = tag(xml, 'Expiration');
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new Error('AWS STS answered without credentials');
  return { accessKeyId, secretAccessKey, sessionToken, expiration: new Date(expiration) };
}

/** A role session name AWS accepts ([\w+=,.@-], 2-64 chars): shows in CloudTrail which machine it was. */
export function sessionName(host = os.hostname()) {
  return `gce-${host}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
}

let current: AwsCreds | null = null;
let pending: Promise<AwsCreds> | null = null;

/**
 * The AWS SDK credentials provider (an async function returning credentials with `expiration`): cached for the whole
 * process, renewed EARLY_MS before expiry, one renewal at a time.
 */
export async function gceAwsCredentials(): Promise<AwsCreds> {
  if (current && current.expiration.getTime() - Date.now() > EARLY_MS) return current;
  pending ??= (async () => {
    const roleArn = process.env.HAWKES_AWS_ROLE_ARN;
    if (!roleArn) throw new Error('HAWKES_AWS_FEDERATION=gce needs HAWKES_AWS_ROLE_ARN (the role made by deploy/gcp/aws-federation.mjs)');
    const token = await gceIdentityToken(process.env.HAWKES_AWS_AUDIENCE || DEFAULT_AUDIENCE);
    current = await assumeRoleWithWebIdentity({ roleArn, token, sessionName: sessionName() });
    return current;
  })().finally(() => { pending = null; });
  return pending;
}

/** Tests: forget the cached credentials. */
export function resetGceAwsCredentials() {
  current = null;
  pending = null;
}
