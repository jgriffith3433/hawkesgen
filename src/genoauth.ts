// Signing in to Gen's MCP from an editor (src/mcp-oauth.ts, J, 2026-10-30: "All of our MCPs should authenticate like
// this, no pasted keys"): Claude, Cursor or VS Code opens hawkesgen.ai, the person signs in with their Gen account
// (Continue with Google, the app's own sign-in) and allows it; the editor gets an hgm_ token that acts as that account
// everywhere a Gen key does (users.ts authenticateRequest): its project, its credits, its jobs. Pasted hg_ keys still work.
// Its connections are listed and disconnected at /v1/users/me/connections.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { sha256 } from './util.ts';
import { createOAuth } from './mcp-oauth.ts';
import { googleClientIdAny } from './dashauth.ts';

/** The Gen account signed in on this request (the app's hg_session cookie), or null. */
function sessionUser(req: IncomingMessage) {
  const cookie = String(req.headers.cookie ?? '');
  const token = /(?:^|;\s*)hg_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) return null;
  const row = db.prepare('SELECT u.id, u.email, s.expires FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256(decodeURIComponent(token))) as { id: string; email: string; expires: number } | undefined;
  if (!row || row.expires < Date.now()) return null;
  let off = false;
  try { off = Boolean(db.prepare('SELECT 1 FROM user_flags WHERE user_id = ? AND disabled = 1').get(row.id)); } catch { /* no flags yet */ }
  return off ? null : { id: row.id, label: row.email };
}

/** The sign-in page for an editor's connect: Continue with Google, then back to the consent page. */
function signIn(_req: IncomingMessage, res: ServerResponse, next: string) {
  const clientId = googleClientIdAny() ?? '';
  const back = /^\/oauth\/authorize\?/.test(next) ? next : '/';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><script src="/gen/nozoom.js"></script><title>Sign in to Hawkes Gen</title>
<script src="https://accounts.google.com/gsi/client" async></script>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f2ed;color:#1a1915}
@media (prefers-color-scheme:dark){body{background:#141413;color:#ecebe6}.card{background:#1f1e1c!important;border-color:#33312d!important}.muted{color:#a6a39a!important}}
.card{max-width:400px;margin:16px;padding:28px;background:#fff;border:1px solid #e3dfd6;border-radius:10px;text-align:center}h1{font-size:20px;margin:0 0 8px}.muted{color:#6b675e;margin:0 0 20px}#err{color:#b3261e}</style></head>
<body><div class="card"><h1>Sign in to Hawkes Gen</h1><p class="muted">to connect your editor. Your Gen account, its credits and its work.</p>
${clientId ? '<div id="g" style="display:inline-block"></div>' : '<p id="err">Google sign-in is not set up on this Gen.</p>'}<p id="err"></p></div>
<script>
const next = ${JSON.stringify(back)};
async function done(r) {
  const res = await fetch('/v1/users/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: r.credential }) });
  if (res.ok) location.replace(next); else document.getElementById('err').textContent = (await res.json().catch(() => ({}))).error || 'Sign-in failed';
}
window.onload = () => { if (!window.google || !${JSON.stringify(Boolean(clientId))}) return;
  google.accounts.id.initialize({ client_id: ${JSON.stringify(clientId)}, callback: done, ux_mode: 'popup' });
  google.accounts.id.renderButton(document.getElementById('g'), { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 280 }); };
</script></body></html>`);
}

export const genOAuth = createOAuth({ db, name: 'Hawkes Gen', prefix: 'hgm', user: sessionUser, signIn });
