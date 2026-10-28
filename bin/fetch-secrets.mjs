#!/usr/bin/env node
// On the control server: reads one secret (a JSON object of API keys) and writes it as an environment file for systemd
// (EnvironmentFile=/run/hawkes/gen.env). /run is in memory, so the keys never touch the disk. Run as root by the
// hawkes-secrets unit before the services start.
//
//   node fetch-secrets.mjs <out file> [secret id] [--optional]   (--optional: a missing secret isn't an error)
//
// Where it reads from (HAWKES_SECRETS_BACKEND):
//   aws (default)  AWS Secrets Manager with the server's IAM role; the id as it is (hawkes/gen)
//   gcp            Google Secret Manager with the VM's service account (a token from the GCE metadata server, no keys
//                  on the box). The id hawkes/gen is the secret hawkes-control-gen in HAWKES_GCP_PROJECT (default: the
//                  VM's own project). hawkesstudio deploy/gcp/secrets.mjs copies the AWS secrets there.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--optional');
const optional = process.argv.includes('--optional');
const out = args[0] ?? '/run/hawkes/gen.env';
const id = args[1] ?? process.env.HAWKES_SECRET_ID ?? 'hawkes/gen';
const backend = process.env.HAWKES_SECRETS_BACKEND ?? 'aws';

/** hawkes/gen -> hawkes-control-gen (Secret Manager names allow letters, digits, - and _). */
export const gcpName = (secretId) => `hawkes-control-${secretId.replace(/^hawkes\//, '').replace(/[^A-Za-z0-9_-]/g, '-')}`;

const METADATA = 'http://169.254.169.254/computeMetadata/v1';
async function metadata(p) {
  const r = await fetch(`${METADATA}/${p}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`GCE metadata ${p}: HTTP ${r.status}`);
  return r.text();
}

/** The secret's latest version from Google Secret Manager, or null when it doesn't exist. */
async function fromGcp(secretId) {
  const project = process.env.HAWKES_GCP_PROJECT || (await metadata('project/project-id')).trim();
  const { access_token: token } = JSON.parse(await metadata('instance/service-accounts/default/token'));
  const name = gcpName(secretId);
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 404) return { missing: `${name} (project ${project})` };
  if (!r.ok) throw new Error(`Secret Manager ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()).payload?.data ?? '';
  return { text: Buffer.from(data, 'base64').toString('utf8'), label: `${name} (project ${project})` };
}

async function fromAws(secretId) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
  try {
    return { text: (await sm.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString ?? '{}', label: secretId };
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return { missing: secretId };
    throw e;
  }
}

/** A secret is a JSON object; an env file's text (KEY=value lines) is accepted too. */
export function parseSecret(text) {
  const t = String(text ?? '').trim();
  if (t.startsWith('{')) return JSON.parse(t);
  return Object.fromEntries(t.split(/\r?\n/).map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
}

async function main() {
  if (!['aws', 'gcp'].includes(backend)) throw new Error(`HAWKES_SECRETS_BACKEND must be aws or gcp, not ${backend}`);
  const got = backend === 'gcp' ? await fromGcp(id) : await fromAws(id);
  if (got.missing) {
    if (optional) {
      console.log(`${got.missing} doesn't exist yet; skipped`);
      return;
    }
    throw new Error(`secret ${got.missing} doesn't exist`);
  }
  const values = parseSecret(got.text);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/\n/g, '')}`).join('\n') + '\n', { mode: 0o640 });
  try {
    const { gid } = fs.statSync('/home/hawkes');
    fs.chownSync(out, 0, gid);
  } catch {
    // Not on the server layout.
  }
  console.log(`wrote ${Object.keys(values).length} values from ${got.label} to ${out}`);
}

// Run as a script (the unit); imported by tests for gcpName and parseSecret.
if (process.argv[1]?.endsWith('fetch-secrets.mjs')) {
  await main();
}
