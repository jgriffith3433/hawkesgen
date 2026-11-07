// A deploy's old copy of Gen, started after the new one already holds the database (entrypoint.sh, lease exit 3).
// It must not open the database or write anything, but exiting made Cloud Run answer every request in the handover
// with Google's HTML "Server Error" page and start another copy for each one (2026-11-02, about 30 s per deploy). So it
// answers instead: 503 in Gen's JSON error shape, marked X-Hawkes-Restarting so the hawkesgen.ai Worker waits and asks
// again (server/gen-edge/src/index.ts), and the event stream a stream that tells the browser to open it again soon.
// It stops itself once nothing has asked it anything for 30 s (the new revision has the traffic).
import http from 'node:http';

export const STANDBY_ERROR = 'Gen is restarting (a new version is starting up). Please try again in a few seconds.';

export function handle(req, res) {
  const path = (req.url ?? '/').split('?')[0];
  const head = { 'Cache-Control': 'no-store', 'X-Hawkes-Restarting': '1', 'Retry-After': '3' };
  if (path === '/v1/events') {
    res.writeHead(200, { ...head, 'Content-Type': 'text/event-stream' });
    return res.end('retry: 3000\n: Gen is restarting\n\n');
  }
  if (path.startsWith('/v1/') || path === '/mcp' || path.startsWith('/mcp/')) {
    res.writeHead(503, { ...head, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: STANDBY_ERROR, kind: 'restarting' }));
  }
  res.writeHead(503, { ...head, 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('Hawkes Gen is restarting. Please reload in a few seconds.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  // CPU stays on while an instance lives (--no-cpu-throttling), so a copy nobody asks anything for 30 s stops itself
  // rather than idle until Cloud Run takes it away; a request after that starts another stand-in.
  let idle = 0;
  const rest = () => { clearTimeout(idle); idle = setTimeout(() => { console.log('[standby] idle: stopping'); process.exit(0); }, 30000); };
  const server = http.createServer((req, res) => { rest(); handle(req, res); }).listen(port, '0.0.0.0', () => console.log(`[standby] answering "restarting" on ${port} until the new revision takes the traffic`));
  rest();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
