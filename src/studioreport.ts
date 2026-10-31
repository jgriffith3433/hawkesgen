// The 🐞 button on Gen's beta app (J, 2026-10-30: "https://beta.hawkesgen.ai should have the bug report button and it
// should be able to have context when I'm submitting the bug report (screenshot, scene ids, account id, etc)").
// Hawkes Studio's widget does the work (the screenshot, the console, the page's own context from
// dashboard/gen/report.js) and files the report as a finding against Hawkes Gen in Studio (hawkesstudio
// src/dev-front.ts APP_HOSTS). On the beta lane only:
//   - the app's page gets the widget's script (and the early hook that keeps WebGL frames readable for the screenshot);
//   - /dev/__studio/* (the widget, its posts) goes to Studio with this host as X-Forwarded-Host and only Studio's own
//     sign-in cookie: Studio's gate decides who may file (J, signed in to Studio), never Gen.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import { GenError } from './util.ts';

/** Live Studio's own address (its sign-in cookie, hawkes_session, covers every hawkesgen.ai host). */
const STUDIO = () => (process.env.HAWKESGEN_REPORT_STUDIO || 'https://studio-388576319982.us-east4.run.app').replace(/\/+$/, '');

/** Whether this Gen shows the button (its beta lane, or a local copy that asks for it). */
export const reportsOn = () => process.env.HAWKESGEN_LANE === 'beta' || process.env.HAWKESGEN_REPORT_BUTTON === '1';

// Keeps WebGL frames readable after they're drawn, so the screenshot sees the 3D stage (as on Studio's beta sites).
const GL = `<script data-hawkes-report>(function(P){if(!P||window.__hawkesGl)return;var g=P.getContext;P.getContext=function(t,a){if(/^(webgl2?|experimental-webgl)$/.test(t)){try{a=Object.assign({},a,{preserveDrawingBuffer:true})}catch(e){}}return g.call(this,t,a)};window.__hawkesGl=1})(window.HTMLCanvasElement&&HTMLCanvasElement.prototype);</script>`;

// A project's own report script (hawkesstudio src/reportkey.ts: <Studio>/r/<project>.js?k=<key>), set by the owner at
// PUT /v1/admin/report-script: reports then go to whichever Studio has Gen's app as a project (a customer's included),
// with that project's key. Without one, the widget comes through this Gen from J's Studio (toStudio below).
const SCRIPT_FILE = () => path.join(DATA_DIR, 'report-script.json');
export const reportScript = (): string | null => { try { return String(JSON.parse(fs.readFileSync(SCRIPT_FILE(), 'utf8')).script ?? '') || null; } catch { return null; } };
export function setReportScript(value: unknown) {
  const s = String(value ?? '').trim();
  if (s && !/^https:\/\/[\w.-]+(?::\d+)?\/[^\s"'<>]*\/r\/[a-z][a-z0-9-]{1,39}\.js\?k=rk_[\w-]{20,}$/.test(s)) throw new GenError('That is not a Studio project report script (https://…/r/<project>.js?k=rk_…)', { status: 400 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (s) fs.writeFileSync(SCRIPT_FILE(), JSON.stringify({ script: s, at: Date.now() }));
  else fs.rmSync(SCRIPT_FILE(), { force: true });
  return { script: reportScript() };
}

/** The app's page with the widget in it (beta only; anything else unchanged). */
export function withReportButton(html: string, version: string) {
  if (!reportsOn() || html.includes('data-hawkes-report')) return html;
  const info = JSON.stringify({ product: 'hawkesgen', ref: `Gen beta ${version}`, sha: process.env.K_REVISION ?? null }).replace(/'/g, '&#39;');
  const own = reportScript();
  const widget = own ? `<script src="${own}" defer></script>` : `<script src="/dev/__studio/report.js" data-hawkes='${info}' defer></script>`;
  const head = /<head[^>]*>/i.exec(html);
  let out = head ? html.slice(0, head.index + head[0].length) + GL + html.slice(head.index + head[0].length) : GL + html;
  const end = out.toLowerCase().lastIndexOf('</body>');
  out = end >= 0 ? out.slice(0, end) + widget + out.slice(end) : out + widget;
  return out;
}

/** Only Studio's own cookies go to Studio (its session and pass), never Gen's. */
export function studioCookies(cookie: string | undefined) {
  return String(cookie ?? '').split(';').map((c) => c.trim()).filter((c) => /^hawkes_(session|pass)(_beta)?=/.test(c)).join('; ');
}

/** /dev/__studio/* on the beta lane: passed to Studio. true when answered. */
export async function toStudio(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
  if (!reportsOn() || !route.startsWith('/dev/__studio/')) return false;
  const method = req.method ?? 'GET';
  if (!['GET', 'POST'].includes(method)) return false;
  const chunks: Buffer[] = [];
  let size = 0;
  if (method === 'POST') {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 11 * 1024 * 1024) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"too big"}'); return true; }
      chunks.push(c as Buffer);
    }
  }
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  const headers: Record<string, string> = { 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https' };
  for (const h of ['content-type', 'origin', 'user-agent', 'accept']) if (req.headers[h]) headers[h] = String(req.headers[h]);
  const cookie = studioCookies(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  const ip = String(req.headers['x-hawkes-client-ip'] ?? '').trim();
  if (ip) headers['X-Forwarded-For'] = ip;
  try {
    const r = await fetch(`${STUDIO()}${route}`, { method, headers, body: method === 'POST' ? Buffer.concat(chunks) : undefined, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'private, no-store' });
    res.end(body);
  } catch (e: any) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Studio didn't answer: ${e.message ?? e}` }));
  }
  return true;
}
