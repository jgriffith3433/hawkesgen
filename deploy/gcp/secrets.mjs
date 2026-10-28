// Copies the control server's secrets into Google Secret Manager (hawkes-prod), where the Google VM's hawkes-secrets reads
// them (hawkesgen bin/fetch-secrets.mjs with HAWKES_SECRETS_BACKEND=gcp). Values travel in memory and on gcloud's stdin;
// they are never printed, logged or written to disk here. Plan by default; --apply writes (J: secret writes are his).
//
//   node deploy/gcp/secrets.mjs                     which secrets exist where (names and key names only)
//   node deploy/gcp/secrets.mjs --apply             copy every one that's missing on Google, grant the VM access to each
//   node deploy/gcp/secrets.mjs --apply --replace   also add a new version where Google's copy differs
//   options: --from aws (default: AWS Secrets Manager with the claw keys in hawkesgen/.env)
//            --from server (the files the AWS server's hawkes-secrets wrote: /run/hawkes/<name>.env, over SSH)
//
// What moves (AWS name -> Google name, hawkesgen fetch-secrets.mjs gcpName):
//   hawkes/gen, github, claude, twitch, cursor, copilot, gemini, antigravity   -> hawkes-control-<name>   (JSON objects)
//   /etc/hawkes/keys.env on the AWS server (Gen keys for Studio, web, dev, Talk; Studio MCP key; the login hash)
//                                                                              -> hawkes-control-keys-env (JSON object)
// keys.env stays a file on the VM (/etc/hawkes/keys.env, copied by move.mjs); the Google copy is its backup and the
// way to rebuild a VM from nothing. Each secret gets roles/secretmanager.secretAccessor for the VM's service account
// only (no project-wide access).
import { GCP, SA_EMAIL, OLD_IP, APPLY, flag, opt, say, warn, fail, header, gcloud, gcloudJson, awsCfg, awsSdk, ssh } from './lib.mjs';

const NAMES = ['gen', 'github', 'claude', 'twitch', 'cursor', 'copilot', 'gemini', 'antigravity'];
const FROM = opt('from', 'aws');
if (!['aws', 'server'].includes(FROM)) fail('--from is aws or server');
const P = ['--project', GCP.project];
const gcpName = (n) => `hawkes-control-${n.replace(/[^A-Za-z0-9_-]/g, '-')}`;

/** KEY=value lines -> object (the same parse as fetch-secrets.mjs). */
const parseEnv = (t) => Object.fromEntries(String(t).split(/\r?\n/).map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));

async function readAws() {
  const { SecretsManagerClient, GetSecretValueCommand } = await awsSdk('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient(awsCfg());
  const out = {};
  for (const n of NAMES) {
    try {
      out[n] = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: `hawkes/${n}` }))).SecretString ?? '{}');
    } catch (e) {
      if (e.name !== 'ResourceNotFoundException') throw new Error(`hawkes/${n}: ${e.name}`);
    }
  }
  return out;
}

async function readServer() {
  const out = {};
  for (const n of NAMES) {
    const text = await ssh(OLD_IP, `sudo cat /run/hawkes/${n}.env 2>/dev/null || true`, { quiet: true });
    if (text.trim()) out[n] = parseEnv(text);
  }
  return out;
}

const readKeysEnv = async () => parseEnv(await ssh(OLD_IP, 'sudo cat /etc/hawkes/keys.env', { quiet: true }));

/** The latest version on Google, parsed (null when the secret doesn't exist). Read only to compare; never shown. */
function googleValue(name) {
  const r = gcloud(['secrets', 'versions', 'access', 'latest', '--secret', name, ...P], { ok: true });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

const same = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

header(`secrets: ${FROM === 'aws' ? 'AWS Secrets Manager' : `the AWS server's /run/hawkes`} -> Google Secret Manager (${GCP.project})`);
const values = FROM === 'aws' ? await readAws() : await readServer();
try {
  values['keys.env'] = await readKeysEnv();
} catch (e) {
  warn(`could not read /etc/hawkes/keys.env on ${OLD_IP} (${e.message}): it is copied as a file by move.mjs anyway`);
}
const existing = new Set((gcloudJson(['secrets', 'list', ...P]) ?? []).map((s) => s.name.split('/').pop()));

for (const [n, value] of Object.entries(values)) {
  const name = gcpName(n);
  const keys = Object.keys(value);
  if (!keys.length) { warn(`${n}: empty, skipped`); continue; }
  const there = existing.has(name);
  const current = there && flag('replace') ? googleValue(name) : null;
  const differs = there && flag('replace') && !same(current, value);
  say(`${n} -> ${name}: ${keys.length} values (${keys.join(', ')}); on Google: ${there ? (flag('replace') ? (differs ? 'differs: new version' : 'the same') : 'exists (kept; --replace compares)') : 'missing: will be made'}`);
  if (!APPLY) continue;
  const data = JSON.stringify(value);
  if (!there) {
    gcloud(['secrets', 'create', name, '--data-file=-', '--replication-policy=user-managed', `--locations=${GCP.region}`, '--labels=project=hawkes-cloud,role=control', ...P], { input: data });
    say(`  made ${name}`);
  } else if (differs) {
    gcloud(['secrets', 'versions', 'add', name, '--data-file=-', ...P], { input: data });
    say(`  new version of ${name}`);
  }
  gcloud(['secrets', 'add-iam-policy-binding', name, '--member', `serviceAccount:${SA_EMAIL}`, '--role', 'roles/secretmanager.secretAccessor', '--condition=None', ...P]);
  say(`  ${SA_EMAIL} may read ${name}`);
}
for (const n of NAMES) if (!values[n]) say(`${n}: not in ${FROM === 'aws' ? 'AWS' : 'the server'} (optional secrets are fine missing)`);
if (!APPLY) say('nothing written (plan). With --apply: the copies above, each readable by the VM only.');
