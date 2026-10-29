// V4 signed URLs for Cloud Storage downloads (docs/gpu-providers.md, "Files"): the broker hands a worker without a
// Google identity a link that reads one object for a few minutes, so a model of several GB goes straight from the
// bucket to the GPU host instead of through Gen. Gen signs as its own service account with IAM's signBlob (no private
// key anywhere): on Cloud Run the account comes from the metadata server and needs roles/iam.serviceAccountTokenCreator
// on itself (tools/gen-cloudrun/deploy.mjs grants it); on J's PC, HAWKESGEN_GCP_IMPERSONATE names it.
// https://cloud.google.com/storage/docs/access-control/signing-urls-manually
import crypto from 'node:crypto';
import { env } from '../../config.ts';
import { gcpTokens } from '../gcp/gcs.ts';

export type Signer = { email: string; sign: (bytes: Buffer) => Promise<Buffer> };

/** RFC 3986 encoding, as V4 wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A V4 signed GET URL for gs://bucket/name, valid `seconds`. */
export async function signedGetUrl(uri: string, signer: Signer, seconds = 900, now = new Date()): Promise<string> {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`not a gs:// URI: ${uri}`);
  const [, bucket, name] = m;
  const host = 'storage.googleapis.com';
  const canonicalUri = `/${bucket}/${name.split('/').map(enc).join('/')}`;
  const scope = `${ymd(now)}/auto/storage/goog4_request`;
  const q: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${signer.email}/${scope}`,
    'X-Goog-Date': stamp(now),
    'X-Goog-Expires': String(Math.max(1, Math.min(604_800, Math.round(seconds)))),
    'X-Goog-SignedHeaders': 'host',
  };
  const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = ['GET', canonicalUri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', stamp(now), scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const sig = await signer.sign(Buffer.from(toSign));
  return `https://${host}${canonicalUri}?${query}&X-Goog-Signature=${sig.toString('hex')}`;
}

let cached: Signer | null | undefined;
/** Tests swap in a fake signer (null: Gen can't sign, the broker streams instead). */
export function setSigner(s: Signer | null | undefined) {
  cached = s;
}

/** Gen's signer, or null when it can't sign (no service account to sign as). Remembered. */
export async function signer(): Promise<Signer | null> {
  if (cached !== undefined) return cached;
  let email = env('HAWKESGEN_GCP_IMPERSONATE') ?? null;
  if (!email && env('K_SERVICE')) {
    email = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.text() : null)).catch(() => null);
  }
  if (!email) return (cached = null);
  const who = email.trim();
  cached = {
    email: who,
    async sign(bytes) {
      const r = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(who)}:signBlob`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await gcpTokens().access()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: bytes.toString('base64') }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`signBlob as ${who}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return Buffer.from(((await r.json()) as { signedBlob: string }).signedBlob, 'base64');
    },
  };
  return cached;
}
