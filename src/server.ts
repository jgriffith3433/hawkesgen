// Hawkes Gen: the local service every game calls for generative AI.
//   npm start          (or auto-start.bat)  ->  http://127.0.0.1:8790

import http from 'node:http';
import { HOST, PORT, DATA_DIR } from './config.ts';
import { handle } from './api.ts';
import { queue } from './jobs.ts';
import { startLagMonitor } from './lag.ts';
import { assertMockProviders } from './mockproviders.ts';

// HAWKESGEN_MOCK_PROVIDERS=1 is for beta and local copies: on the live lane the service refuses to start.
try { assertMockProviders(); } catch (e: any) { console.error(e.message); process.exit(1); }

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  });
});

server.on('error', (e: any) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use: Hawkes Gen is probably already running (http://${HOST}:${PORT}).`);
    process.exit(1);
  }
  throw e;
});

// A stray error in a job's cleanup or a provider callback must not take every running job down with it.
process.on('uncaughtException', (e) => console.error(`[uncaught] ${e?.stack ?? e}`));
process.on('unhandledRejection', (e: any) => console.error(`[unhandled rejection] ${e?.stack ?? e}`));

server.listen(PORT, HOST, () => {
  console.log(`Hawkes Gen on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  startLagMonitor();
  // HAWKESGEN_SMOKE=1: the API and dashboard only. No queue (nothing runs or resumes), no uploads, no machine monitor, no
  // fleet or build-server access changes: a copy of the data can be checked beside the live service without both of them
  // driving the same GPU servers (the move to Google, hawkesstudio docs/gcp.md; like Studio's STUDIO_SMOKE).
  if (process.env.HAWKESGEN_SMOKE === '1') {
    console.log('[smoke] HAWKESGEN_SMOKE=1: the queue and every background task are off');
    return;
  }
  queue.start();
  // RunPod's balance, every 2 minutes: an empty one is skipped instead of waited on (providers/gpu/credit.ts).
  void import('./providers/gpu/credit.ts').then((m) => m.startCreditWatch()).catch((e) => console.warn(`[gpu] ${e.message}`));
  // Once per start: every RunPod endpoint keeps no warm worker and none idle past 60 s (providers/gpu/runpodIdle.ts).
  void import('./providers/gpu/runpodIdle.ts').then((m) => m.applyIdleRule()).then((r) => {
    if (!r) return;
    for (const c of r.changed) console.log(`[gpu] RunPod ${c.name}: min ${c.from.min ?? 0}, idle ${c.from.idleTimeout ?? '?'} s -> min 0, idle ${c.to.idleTimeout} s`);
    if (r.error) console.warn(`[gpu] RunPod idle rule: ${r.error}`);
  }).catch((e) => console.warn(`[gpu] ${e.message}`));
  // The RunPod playtest endpoint's workers.max, every 2 minutes: the playtest lane follows it (playtester/runpodcap.ts).
  void Promise.all([import('./providers/playtester/runpodcap.ts'), import('./config.ts')])
    .then(([m, c]) => m.startEndpointWatch(() => c.loadSettings().playtest.runpod.url)).catch((e) => console.warn(`[playtest] ${e.message}`));
  void import('./storage.ts').then((m) => m.resumeOnStart()).catch((e) => console.warn(`[storage] ${e.message}`));
  // Analytics: the daily rollups and the 13-month purge, and the GeoIP database (downloaded monthly).
  void import('./analytics/store.ts').then((m) => m.startMaintenance()).catch((e) => console.warn(`[analytics] ${e.message}`));
  void import('./analytics/geo.ts').then((m) => {
    const refresh = () => m.refreshGeo().then((r) => r !== 'fresh' && console.log(`[analytics] geo: ${r}`)).catch((e) => console.warn(`[analytics] ${e.message}`));
    void refresh();
    setInterval(refresh, 24 * 3600 * 1000).unref();
  });
  // The ranges crawlers and clouds publish (datacenter.ts: bot verdicts), refreshed daily.
  void import('./analytics/datacenter.ts').then((m) => {
    const refresh = () => m.refreshDatacenters().then((r) => r !== 'fresh' && console.log(`[analytics] data centres: ${r}`)).catch((e) => console.warn(`[analytics] ${e.message}`));
    void refresh();
    setInterval(refresh, 6 * 3600 * 1000).unref();
  });
  // The making loop's learning: library picks and discards as feedback, and the daily summary (src/make/feedback.ts).
  void import('./make/feedback.ts').then((m) => m.startMakeLearning()).catch((e) => console.warn(`[make] ${e.message}`));
  // On Cloud Run there are no machines of ours to watch or images to build (src/cloudhost.ts).
  if (process.env.K_SERVICE) return;
  // The Machines tab's history: running machines measured every minute (EC2 Describe and one SSH command each).
  void import('./machines.ts').then((m) => m.startMonitor()).catch((e) => console.warn(`[machines] ${e.message}`));
  void import('./providers/comfy/image.ts').then((m) => m.resumeImageBuild()).catch((e) => console.warn(`[image] ${e.message}`));
  // On the cloud control server, make sure the GPU fleet and the build server let this machine in.
  if (process.env.HAWKES_AWS_ROLE) {
    void (async () => {
      const { refreshAccess } = await import('./providers/comfy/fleet.ts');
      const { builderAccess, findBuilder } = await import('./providers/builder/builder.ts');
      await refreshAccess().then((r) => console.log(`[fleet] access for ${r.ip} in ${r.regions.join(', ')}`)).catch((e) => console.warn(`[fleet] access: ${e.message}`));
      if (await findBuilder().catch(() => null)) await builderAccess().catch((e) => console.warn(`[builder] access: ${e.message}`));
    })();
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log('stopping: no new jobs, letting running ones finish first');
    await import('./cloudhost.ts').then((m) => m.drainJobs()).catch(() => {});
    // Cloud Run: the state files go up first (the databases are Litestream's).
    if (process.env.K_SERVICE) await import('./cloudhost.ts').then((m) => m.flushOnStop()).catch(() => {});
    process.exit(0);
  });
}
