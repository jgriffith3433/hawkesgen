// The gen-cpu Cloud Run service's HTTP door (docs/cpu-cloudrun.md). The work is src/cpu/worker.ts: the CPU suite's
// own tool code, run against Cloud Storage. Cloud Run's IAM checks the caller (Gen's service account, roles/run.invoker)
// before a request gets here, so there is no key of our own.
//
//   POST /tool   { key, job, tool, version, params, inputs, done, seeds, out }  -> NDJSON events, then done or error
//   POST /exec   { key, kind: lod-images | lod-mesh, plan, out }                -> NDJSON, then done (with the result)
//   GET  /healthz                                                             -> the suite this image runs
//
// A request that closes before its answer (a cancel, or Gen going away) aborts the tool: its child processes die with it.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSuite } from '../../src/cpu/suite.ts';
import { runTool, runExec, type WorkerEnv } from '../../src/cpu/worker.ts';
import { gcs } from '../../src/providers/gcp/gcs.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = process.env.HAWKES_PYTHON ?? '/opt/venv/bin/python';
const PORT = Number(process.env.PORT ?? 8080);
const BOOT = Date.now();
let served = 0;
let running = 0;

function readBody(req: http.IncomingMessage, max = 8 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running, served, upSeconds: Math.round((Date.now() - BOOT) / 1000), tools: describeSuite().map((t) => `${t.id}@${t.version}`) }));
    return;
  }
  if (req.method !== 'POST' || !['/tool', '/exec'].includes(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  let body: any;
  try {
    body = await readBody(req);
  } catch (e: any) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`bad request: ${e.message}`);
    return;
  }
  // The first request an instance serves paid for its start (its cost and Gen's "cold start" count).
  const cold = served++ === 0;
  const startupSeconds = cold ? Math.round((Date.now() - BOOT) / 100) / 10 : 0;
  running++;
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) abort.abort(); });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (ev: Record<string, unknown>) => { if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`); };
  // Something on the wire every 20 s, so nothing between here and Gen takes a long encode for a dead connection.
  const beat = setInterval(() => send({ t: 'beat' }), 20_000);
  const env: WorkerEnv = { store: gcs(), python: PYTHON, root: ROOT, signal: abort.signal, send };
  try {
    const end = url.pathname === '/tool' ? await runTool(body, env) : await runExec(body, env);
    send({ ...end, cold, startupSeconds });
  } catch (e: any) {
    send({ t: 'error', message: String(e?.message ?? e), cold, startupSeconds });
  } finally {
    finished = true;
    clearInterval(beat);
    running--;
    res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(PORT, () => console.log(`gen-cpu listening on ${PORT} (python ${PYTHON})`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
