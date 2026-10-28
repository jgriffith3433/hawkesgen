// A small Google Cloud client for the Unity cloud builds (cloudrun.ts): an access token from Application Default
// Credentials, Cloud Storage objects, Cloud Run job executions and Cloud Logging entries, over the REST APIs with
// fetch (no Google SDK in the dependencies).
//
// Credentials, in this order:
//   1. GOOGLE_APPLICATION_CREDENTIALS (in .env or the environment): a service-account key file, or the
//      authorized_user file `gcloud auth application-default login` writes.
//   2. The well-known ADC file (~/.config/gcloud/application_default_credentials.json, %APPDATA%\gcloud\... on Windows).
//   3. The metadata server (when Gen itself runs on Google Cloud).
// Nothing here prints a token or a key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config.ts';
import { GenError } from '../../util.ts';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const fail = (message: string, kind = 'gcp', status = 409) => new GenError(message, { status, kind });

type Cached = { token: string; expires: number };
let cached: Cached | null = null;

function adcFile(): string | null {
  const named = env('GOOGLE_APPLICATION_CREDENTIALS');
  if (named) return named;
  const wellKnown = process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
    : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  return fs.existsSync(wellKnown) ? wellKnown : null;
}

/** A signed JWT for a service account's token request (RS256). Exported for the test. */
export function serviceAccountAssertion(key: { client_email: string; private_key: string; token_uri?: string }, now = Math.floor(Date.now() / 1000)) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.private_key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function tokenRequest(url: string, form: Record<string, string>) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j.access_token) throw fail(`Google Cloud refused the credentials (${r.status} ${j.error ?? ''} ${j.error_description ?? ''}). Check GOOGLE_APPLICATION_CREDENTIALS (docs/unity-cloudrun.md).`, 'auth');
  return { token: String(j.access_token), expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
}

/** An access token for the cloud-platform scope (cached until a minute before it expires). */
export async function accessToken(): Promise<string> {
  if (cached && cached.expires - 60_000 > Date.now()) return cached.token;
  const file = adcFile();
  if (file) {
    let cred: any;
    try {
      cred = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: any) {
      throw fail(`Couldn't read the Google credentials file ${file} (${e.message}).`, 'auth');
    }
    if (cred.type === 'service_account') {
      cached = await tokenRequest(cred.token_uri ?? 'https://oauth2.googleapis.com/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(cred) });
    } else if (cred.type === 'authorized_user') {
      cached = await tokenRequest('https://oauth2.googleapis.com/token', { grant_type: 'refresh_token', client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token });
    } else {
      throw fail(`The Google credentials in ${file} are of type "${cred.type}", which Hawkes Gen doesn't read yet (a service-account key or gcloud's application-default login works).`, 'auth');
    }
    return cached.token;
  }
  try {
    const r = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${SCOPE}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3_000) });
    const j = (await r.json()) as any;
    if (r.ok && j.access_token) {
      cached = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
      return cached.token;
    }
  } catch { /* not on Google Cloud */ }
  throw fail('No Google Cloud credentials: set GOOGLE_APPLICATION_CREDENTIALS in .env to the hawkes-gen service account\'s key file (docs/unity-cloudrun.md, "What J sets up").', 'auth');
}

/** A JSON call to a Google API. 404 resolves to null when `missingOk`. */
export async function gapi(url: string, init: { method?: string; body?: unknown; missingOk?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const r = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
  });
  if (r.status === 404 && init.missingOk) return null;
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
    throw fail(`Google Cloud answered ${r.status} for ${url.replace(/\?.*$/, '')}: ${msg}`, r.status === 401 || r.status === 403 ? 'auth' : 'gcp');
  }
  return text ? JSON.parse(text) : {};
}

// ------------------------------------------------------------ Cloud Storage

const enc = encodeURIComponent;
export type GcsObject = { name: string; size: number; updated: string; metadata?: Record<string, string> };

/** Splits gs://bucket/key. */
export function parseGs(uri: string) {
  const m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220})\/(.+)$/.exec(uri);
  if (!m) throw fail(`Not a gs:// address: ${uri}`);
  return { bucket: m[1], key: m[2] };
}

export async function gcsList(bucket: string, prefix: string): Promise<GcsObject[]> {
  const out: GcsObject[] = [];
  let page = '';
  do {
    const j = await gapi(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${enc(prefix)}&maxResults=1000${page ? `&pageToken=${enc(page)}` : ''}`);
    for (const o of j.items ?? []) out.push({ name: o.name, size: Number(o.size) || 0, updated: o.updated, metadata: o.metadata });
    page = j.nextPageToken ?? '';
  } while (page);
  return out;
}

export async function gcsDelete(bucket: string, key: string) {
  await gapi(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${enc(key)}`, { method: 'DELETE', missingOk: true });
}

/** An object's bytes, or null when it isn't there. */
export async function gcsRead(bucket: string, key: string): Promise<Buffer | null> {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${enc(key)}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(120_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw fail(`Couldn't read gs://${bucket}/${key} (${r.status} ${(await r.text()).slice(0, 200)})`);
  return Buffer.from(await r.arrayBuffer());
}

/** Downloads an object to a file (streamed; big build outputs). */
export async function gcsDownload(bucket: string, key: string, file: string, timeoutMs = 60 * 60_000) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${enc(key)}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok || !r.body) throw fail(`Couldn't download gs://${bucket}/${key} (${r.status})`);
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(file));
  return fs.statSync(file).size;
}

/** Uploads bytes or a file (a single request; fine up to a few GB on a good link). */
export async function gcsWrite(bucket: string, key: string, data: Buffer | string, contentType = 'application/octet-stream', timeoutMs = 60 * 60_000) {
  const body = typeof data === 'string' ? fs.createReadStream(data) : data;
  const size = typeof data === 'string' ? fs.statSync(data).size : data.length;
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${enc(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': contentType, 'Content-Length': String(size) },
    body: body as any, duplex: 'half', signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit);
  if (!r.ok) throw fail(`Couldn't upload gs://${bucket}/${key} (${r.status} ${(await r.text()).slice(0, 200)})`);
  return size;
}

// ---------------------------------------------------------------- Cloud Run

export type CloudRunTarget = { project: string; region: string; job: string };
const runBase = (t: CloudRunTarget) => `https://run.googleapis.com/v2/projects/${t.project}/locations/${t.region}`;

/** Starts one execution of the job with per-build env and a task timeout; returns the execution's full name. */
export async function runJob(t: CloudRunTarget, envs: Record<string, string>, timeoutSeconds: number): Promise<string> {
  const op = await gapi(`${runBase(t)}/jobs/${t.job}:run`, {
    body: { overrides: { containerOverrides: [{ env: Object.entries(envs).map(([name, value]) => ({ name, value })) }], taskCount: 1, timeout: `${timeoutSeconds}s` } },
  });
  const name = executionNameOf(op);
  if (name) return name;
  // Older answers carry only the operation: ask it.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    const again = await gapi(`https://run.googleapis.com/v2/${op.name}`);
    const n = executionNameOf(again);
    if (n) return n;
  }
  throw fail(`Cloud Run started the job but didn't say which execution (operation ${op.name}).`);
}

/** The execution name in a jobs.run operation (metadata, or response once done). */
export function executionNameOf(op: any): string | null {
  for (const v of [op?.metadata?.name, op?.response?.name]) if (typeof v === 'string' && /\/executions\/[^/]+$/.test(v)) return v;
  return null;
}

export type ExecutionState = { done: boolean; succeeded: boolean; cancelled: boolean; running: boolean; message: string; started?: string; completed?: string; logUri?: string };

/** What an execution resource says (exported for the test). */
export function executionState(e: any): ExecutionState {
  const done = Boolean(e?.completionTime);
  const completed = (e?.conditions ?? []).find((c: any) => c.type === 'Completed');
  const failedTask = (e?.conditions ?? []).find((c: any) => c.state === 'CONDITION_FAILED');
  return {
    done, succeeded: done && Number(e?.succeededCount ?? 0) > 0, cancelled: Number(e?.cancelledCount ?? 0) > 0,
    running: Number(e?.runningCount ?? 0) > 0, message: String(failedTask?.message ?? completed?.message ?? ''),
    started: e?.startTime, completed: e?.completionTime, logUri: e?.logUri,
  };
}

export async function getExecution(name: string) {
  return executionState(await gapi(`https://run.googleapis.com/v2/${name}`));
}

export async function cancelExecution(name: string) {
  await gapi(`https://run.googleapis.com/v2/${name}:cancel`, { body: {} }).catch(() => {});
}

// -------------------------------------------------------------- Cloud Logging

/** Log lines matching `filter` after `since` (RFC 3339), oldest first; `last` is where the next call starts. */
export async function logLines(project: string, filter: string, since: string) {
  const j = await gapi('https://logging.googleapis.com/v2/entries:list', {
    body: { resourceNames: [`projects/${project}`], filter: `${filter} AND timestamp>"${since}"`, orderBy: 'timestamp asc', pageSize: 1000 },
  });
  const entries = (j.entries ?? []) as any[];
  // Cloud Run writes textPayload; Docker's gcplogs driver (the build VM) writes jsonPayload.data.
  const lines = entries.map((e) => String(e.textPayload ?? e.jsonPayload?.data ?? e.jsonPayload?.message ?? '')).filter(Boolean);
  return { lines, last: entries.length ? String(entries[entries.length - 1].timestamp) : since };
}

/** The execution's log lines after `since`. */
export async function executionLogs(project: string, execution: string, since: string) {
  const short = execution.split('/').pop();
  return logLines(project, `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${short}"`, since);
}

// ------------------------------------------------------------ Compute Engine

export type VmTarget = { project: string; zone: string; name: string };
const vmBase = (t: VmTarget) => `https://compute.googleapis.com/compute/v1/projects/${t.project}/zones/${t.zone}/instances/${t.name}`;

/** The instance (status, id, metadata), or null when there is none. */
export async function getInstance(t: VmTarget): Promise<{ id: string; status: string; fingerprint: string; items: { key: string; value: string }[] } | null> {
  const i = await gapi(vmBase(t), { missingOk: true });
  if (!i) return null;
  return { id: String(i.id), status: String(i.status), fingerprint: String(i.metadata?.fingerprint ?? ''), items: (i.metadata?.items ?? []) as { key: string; value: string }[] };
}

/** Sets metadata keys on the instance (others are kept); `null` removes a key. */
export async function setInstanceMetadata(t: VmTarget, values: Record<string, string | null>) {
  const i = await getInstance(t);
  if (!i) throw fail(`There is no instance ${t.name} in ${t.zone}.`);
  const items = mergeMetadata(i.items, values);
  await gapi(`${vmBase(t)}/setMetadata`, { body: { fingerprint: i.fingerprint, items } });
}

/** Metadata items with `values` applied (exported for the test). */
export function mergeMetadata(items: { key: string; value: string }[], values: Record<string, string | null>) {
  const out = items.filter((x) => !(x.key in values));
  for (const [key, value] of Object.entries(values)) if (value !== null) out.push({ key, value });
  return out;
}

export async function startInstance(t: VmTarget) {
  await gapi(`${vmBase(t)}/start`, { body: {} });
}

export async function stopInstance(t: VmTarget) {
  await gapi(`${vmBase(t)}/stop`, { body: {} }).catch(() => {});
}
