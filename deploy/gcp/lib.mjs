// Shared by the scripts that move the control server (Hawkes Studio + Hawkes Gen) from AWS EC2 to Google Compute Engine
// (docs/gcp.md). Every script prints its plan and changes nothing without --apply. Secrets are never printed.
//
// State: hawkesstudio/deploy/.keys/gcp-control.json (the VM, its address, its service account's unique id), next to the
// AWS server's hawkesstudio/deploy/.state.json. The SSH key is the AWS server's (deploy/.keys/control_ed25519), so every
// existing script (deploy.mjs, agent-sandbox.mjs, local-deploy.mjs, auto-ssh.bat) works against the new VM once
// .state.json points at it (move.mjs switch does that).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { gcloudBin } from '../../tools/gcloud-bin.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = path.dirname(fileURLToPath(import.meta.url));

/** C:\Projects: the folder that holds hawkesstudio and hawkesgen (these scripts may sit in either repo or a worktree). */
export const PROJECTS = (() => {
  if (process.env.HAWKES_PROJECTS) return path.resolve(process.env.HAWKES_PROJECTS);
  for (let d = HERE; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'hawkesstudio', 'deploy')) && fs.existsSync(path.join(d, 'hawkesgen'))) return d;
  }
  return 'C:\\Projects';
})();
export const STUDIO_DEPLOY = path.join(PROJECTS, 'hawkesstudio', 'deploy');
export const KEYS = path.join(STUDIO_DEPLOY, '.keys');
export const AWS_STATE_FILE = path.join(STUDIO_DEPLOY, '.state.json');
export const GCP_STATE_FILE = path.join(KEYS, 'gcp-control.json');

// ------------------------------------------------------------------ the target
export const GCP = {
  project: 'hawkes-prod',
  projectNumber: '598611630218',
  region: 'us-east4',
  zone: 'us-east4-c',
  name: 'hawkes-control',
  tag: 'hawkes-control',
  serviceAccount: 'hawkes-control',
  machineType: process.env.CONTROL_GCE_TYPE || 'e2-standard-4',
  diskGb: Number(process.env.CONTROL_GCE_DISK_GB || 200),
  diskType: 'pd-balanced',
  image: { family: 'ubuntu-2404-lts-amd64', project: 'ubuntu-os-cloud' },
};
export const SA_EMAIL = `${GCP.serviceAccount}@${GCP.project}.iam.gserviceaccount.com`;

// ------------------------------------------------------------------ AWS
export const AWS = {
  account: '028793236279',
  region: 'us-east-1',
  /** The role the Google VM assumes (aws-federation.mjs); today's EC2 role is hawkes/hawkes-control. */
  roleName: 'hawkes-control-gce',
  rolePath: '/hawkes/',
  /** The audience of the VM's identity token that the role's trust policy pins (Gen's gceaws.ts DEFAULT_AUDIENCE). */
  audience: 'hawkes-control-aws',
  /** The AWS control server's security group (SSH for the move's copy). */
  controlSg: 'sg-0aaed8dd41cf3abdf',
};
export const ROLE_ARN = `arn:aws:iam::${AWS.account}:role${AWS.rolePath}${AWS.roleName}`;

/** J's address (SSH to the VM). */
export const J_IP = process.env.HAWKES_ADMIN_IP || '99.57.156.100';

export const awsState = () => { try { return JSON.parse(fs.readFileSync(AWS_STATE_FILE, 'utf8')); } catch { return {}; } };
export const gcpState = () => { try { return JSON.parse(fs.readFileSync(GCP_STATE_FILE, 'utf8')); } catch { return {}; } };
export function saveGcpState(patch) {
  const s = { ...gcpState(), ...patch };
  fs.mkdirSync(KEYS, { recursive: true });
  fs.writeFileSync(GCP_STATE_FILE, JSON.stringify(s, null, 2));
  return s;
}
/** The address the AWS server has today (52.0.19.230), from its state file. */
export const OLD_IP = awsState().ip || '52.0.19.230';
export const SSH_KEY = awsState().key || path.join(KEYS, 'control_ed25519');

// ------------------------------------------------------------------ args, plan / apply
export const args = process.argv.slice(2);
export const flag = (k) => args.includes(`--${k}`);
export const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
export const APPLY = flag('apply');

const C = { cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
export const say = (s) => console.log(`${C.cyan}[gcp]${C.off} ${s}`);
export const warn = (s) => console.log(`${C.yellow}[gcp] ${s}${C.off}`);
export const fail = (s) => { console.error(`${C.red}[gcp] ${s}${C.off}`); process.exit(1); };
export const show = (s) => console.log(`${C.dim}${String(s).replace(/^/gm, '    ')}${C.off}`);
export function header(title) {
  console.log(`\n${C.cyan}== ${title} ==${C.off} ${APPLY ? '' : `${C.yellow}(plan only: nothing changes without --apply)${C.off}`}`);
}

// ------------------------------------------------------------------ gcloud
const GCLOUD_WIN = path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd');
const oldGcloudBin = () => (process.platform === 'win32' && fs.existsSync(GCLOUD_WIN) ? GCLOUD_WIN : 'gcloud');
/** The command line as J would type it (for the plan). */
export const gcloudLine = (a) => `gcloud ${a.map((x) => (/[\s"*;|&<>]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)).join(' ')}`;

/** Runs gcloud (values on stdin only, never on the command line). Returns { status, stdout, stderr }. */
export function gcloud(a, { input, quiet = true, ok = false } = {}) {
  const bin = oldGcloudBin();
  // gcloud on Windows is a .cmd under "Cloud SDK" (a space): through the shell with the path quoted.
  const win = process.platform === 'win32';
  const quoted = win ? a.map((x) => (/[\s"&|<>^()]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)) : a;
  void bin; void quoted;
  const [exe, pre] = gcloudBin();
  const r = spawnSync(exe, [...pre, ...a], { input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: quiet ? 'pipe' : ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0 && !ok) throw new Error(`${gcloudLine(a.slice(0, 4))}… failed (${r.status}): ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
  return r;
}
/** gcloud --format=json, parsed (read-only calls for the plan); null when it fails. */
export function gcloudJson(a) {
  try {
    const r = gcloud([...a, '--format=json'], { ok: true });
    return r.status === 0 ? JSON.parse(r.stdout || 'null') : null;
  } catch {
    return null;
  }
}

/**
 * One step of a plan: printed always, run only with --apply. `run` is a function (Node work) or gcloud args.
 * `skip` (a string) says why it is already done.
 */
export async function step(title, { gcloud: g, run, skip, detail } = {}) {
  if (skip) { say(`${title}: ${skip}`); return null; }
  say(title);
  if (g) show(gcloudLine(g));
  if (detail) show(detail);
  if (!APPLY) return null;
  if (g) return gcloud(g, { quiet: false });
  return run?.();
}

// ------------------------------------------------------------------ SSH
/** Git's ssh on Windows (it accepts the key file's permissions; Windows' OpenSSH can be strict about them). */
const sshBin = () => {
  const git = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
  return process.platform === 'win32' && fs.existsSync(git) ? git : 'ssh';
};
const sshArgs = (known) => ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(KEYS, known)}`, '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15'];

/** Runs a command (or a bash script on stdin with `script`) as ubuntu on a host. Streams output unless quiet. */
export function ssh(host, command, { input, quiet = false, known = 'known_hosts', ok = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sshBin(), [...sshArgs(known), `ubuntu@${host}`, command], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; if (!quiet) process.stderr.write(d); });
    if (input !== undefined) child.stdin.end(input.replace(/\r\n/g, '\n')); else child.stdin.end();
    child.on('close', (code) => (code === 0 || ok ? resolve(out) : reject(new Error(`ssh ${host} exited ${code}: ${(err || out).trim().split('\n').slice(-3).join(' | ')}`))));
  });
}
/** A bash script as root on a host (stdin), streamed. */
export const sudoScript = (host, script, o = {}) => ssh(host, 'sudo bash -s', { ...o, input: `set -euo pipefail\n${script}\n` });
export const onAws = (script, o) => sudoScript(OLD_IP, script, { known: 'known_hosts', ...o });
export const onGce = (script, o) => {
  const ip = gcpState().ip;
  if (!ip) fail('No GCE VM yet: run node deploy/gcp/provision.mjs --apply first (it saves the address in hawkesstudio/deploy/.keys/gcp-control.json)');
  return sudoScript(ip, script, { known: 'known_hosts_gcp', ...o });
};

// ------------------------------------------------------------------ AWS SDK (J's claw keys from hawkesgen/.env, never printed)
export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
}
export function awsCfg(region = AWS.region) {
  const env = readEnvFile(path.join(PROJECTS, 'hawkesgen', '.env'));
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) fail('No AWS keys in hawkesgen/.env (the claw user): they are needed from J\'s PC for this step');
  return { region, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } };
}
/** An AWS SDK package from hawkesstudio/deploy's node_modules (client-iam, client-ec2…) or hawkesgen's. */
export async function awsSdk(name) {
  for (const base of [path.join(STUDIO_DEPLOY, 'package.json'), path.join(PROJECTS, 'hawkesgen', 'package.json')]) {
    try {
      const req = createRequire(base);
      return await import(`file://${req.resolve(name).replace(/\\/g, '/')}`);
    } catch { /* try the next one */ }
  }
  fail(`${name} is not installed (npm install in hawkesstudio/deploy)`);
}

// ------------------------------------------------------------------ DNS (Route 53, through the portal repo's dns.py)
export const DNS_PY = path.join(PROJECTS, 'hawkesgenwebsite', 'cloud', 'dns.py');
export const dnsLine = (name, ip) => `py -I ${DNS_PY} point ${name} A ${ip}`;
export function dnsPoint(name, ip) {
  const r = spawnSync('py', ['-I', DNS_PY, 'point', name, 'A', ip], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`dns.py point ${name} failed (${r.status})`);
}
/** What public DNS (Google's resolver) answers for a name's A record. */
export async function resolveA(name) {
  try {
    const r = await (await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`, { signal: AbortSignal.timeout(8000) })).json();
    return (r.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
