// Hawkes Gen: the local service every game calls for generative AI.
//   npm start          (or auto-start.bat)  ->  http://127.0.0.1:8790

import http from 'node:http';
import { HOST, PORT, DATA_DIR } from './config.ts';
import { handle } from './api.ts';
import { queue } from './jobs.ts';
import { startLagMonitor } from './lag.ts';

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
  queue.start();
  void import('./storage.ts').then((m) => m.resumeOnStart()).catch((e) => console.warn(`[storage] ${e.message}`));
  // Analytics: the daily rollups and the 13-month purge, and the GeoIP database (downloaded monthly).
  void import('./analytics/store.ts').then((m) => m.startMaintenance()).catch((e) => console.warn(`[analytics] ${e.message}`));
  void import('./analytics/geo.ts').then((m) => {
    const refresh = () => m.refreshGeo().then((r) => r !== 'fresh' && console.log(`[analytics] geo: ${r}`)).catch((e) => console.warn(`[analytics] ${e.message}`));
    void refresh();
    setInterval(refresh, 24 * 3600 * 1000).unref();
  });
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
  process.on(sig, () => {
    console.log('stopping (running jobs resume on the next start)');
    process.exit(0);
  });
}
