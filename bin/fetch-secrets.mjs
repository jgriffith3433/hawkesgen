#!/usr/bin/env node
// On the AWS control server: reads the hawkes/gen secret (API keys) from Secrets Manager with the server's IAM
// role and writes it as an environment file for systemd (EnvironmentFile=/run/hawkes/gen.env). /run is in memory,
// so the keys never touch the disk. Run as root before the service starts (ExecStartPre=+...).
import fs from 'node:fs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

//   node fetch-secrets.mjs <out file> [secret id] [--optional]   (--optional: a missing secret isn't an error)
const args = process.argv.slice(2).filter((a) => a !== '--optional');
const optional = process.argv.includes('--optional');
const out = args[0] ?? '/run/hawkes/gen.env';
const id = args[1] ?? process.env.HAWKES_SECRET_ID ?? 'hawkes/gen';
const sm = new SecretsManagerClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
let r;
try {
  r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
} catch (e) {
  if (optional && e.name === 'ResourceNotFoundException') {
    console.log(`${id} doesn't exist yet; skipped`);
    process.exit(0);
  }
  throw e;
}
const values = JSON.parse(r.SecretString ?? '{}');
fs.mkdirSync(new URL('.', `file://${out}`).pathname, { recursive: true });
fs.writeFileSync(out, Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/\n/g, '')}`).join('\n') + '\n', { mode: 0o640 });
try {
  const { uid, gid } = fs.statSync('/home/hawkes');
  fs.chownSync(out, 0, gid);
} catch {
  // Not on the server layout.
}
console.log(`wrote ${Object.keys(values).length} values from ${id} to ${out}`);
