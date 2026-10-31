// The admin dashboard is the owner's and admins' alone (J, 2026-10-30: "Change the route to be completely protected by
// admin, if you're not admin you can't see any of it period"). Its files (dashboard/index.html, app.js, style.css, at
// /admin and, through the plain file route, at the root) are sent only to a request that is the owner or an admin by
// Gen's own checks: an admin key (Bearer or the dashboard's key cookie), the dashboard's Google sign-in of a listed email
// (dashauth.ts), or a Gen account signed in with Google whose email is listed (users.ts isGenAdmin). Anyone else gets a
// bare sign-in page with none of the dashboard's code, and the other files a 404.
import type { IncomingMessage } from 'node:http';
import { authenticate, LOCAL_OWNER } from './auth.ts';
import { authenticateRequest } from './users.ts';

/** The dashboard's own files, wherever they're asked for (the favicon stays public: the app uses it). */
const ROOT_FILES = new Set(['/index.html', '/app.js', '/style.css', '/bench.js']);

/** Whether a page route asks for the admin dashboard or one of its files. */
export function isAdminRoute(route: string) {
  if (route === '/admin' || route === '/admin/') return true;
  if (route.startsWith('/admin/')) return route !== '/admin/favicon.svg';
  return ROOT_FILES.has(route);
}

/** The pages that show the sign-in instead (the rest of the files answer 404). */
export const isAdminPage = (route: string) => route === '/admin' || route === '/admin/' || route === '/admin/index.html' || route === '/index.html';

const adminRole = (c: { role?: string } | null | undefined) => c?.role === 'owner' || c?.role === 'admin';

/**
 * Whether this request is the owner or an admin of this Gen. An admin key or the dashboard's Google sign-in counts; so
 * does a Gen account that is an admin. J's PC lets a request with nothing in as its owner (auth.ts localOpen, never on
 * Cloud Run), but not one signed in to the app as somebody who isn't an admin.
 */
export function isAdminViewer(req: IncomingMessage) {
  let a: { id?: string; role?: string } | null = null;
  try { a = authenticate(req); } catch { /* no key, no cookie */ }
  let u: { role?: string } | null = null;
  try { u = authenticateRequest(req); } catch { /* none */ }
  if (adminRole(u)) return true;
  if (a?.id === LOCAL_OWNER.id) return !u;
  return adminRole(a);
}

/** The sign-in page a non-admin sees at /admin: Google for the listed admins, or an admin key; nothing else. */
export const ADMIN_SIGNIN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hawkes Gen admin</title><link rel="icon" href="/favicon.svg"><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark;--bg:#0b0c0f;--card:#15171c;--text:#eceef2;--muted:#9aa0ab;--line:#262a31;--err:#ff7a7a}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:19px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}#g{min-height:44px;margin-bottom:18px}
details{border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;color:var(--muted)}
input{width:100%;margin:10px 0;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:#0f1115;color:var(--text);font:inherit}
button{width:100%;padding:10px 12px;border-radius:9px;border:0;background:var(--text);color:var(--bg);font:600 15px system-ui,sans-serif;cursor:pointer}
.err{color:var(--err);min-height:1.5em;margin-top:10px}a{color:var(--text)}
</style></head><body><main>
<h1>Hawkes Gen admin</h1><p>For Hawkes Gen's admins only. Sign in with an admin's Google account.</p>
<div id="g"></div>
<details><summary>Use an admin key</summary><input id="k" type="password" autocomplete="off" placeholder="hg_..."><button id="kb" type="button">Sign in</button></details>
<div class="err" id="e"></div>
<p style="margin:14px 0 0;font-size:13px"><a href="/">Back to Hawkes Gen</a></p>
</main><script>
(function(){
  var e=document.getElementById('e');
  function done(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok)throw new Error(j.error||'That sign-in was refused.');location.reload()})}
  function fail(x){e.textContent=x.message||String(x)}
  fetch('/v1/dashboard/google').then(function(r){return r.json()}).then(function(c){
    if(!c.clientId){document.getElementById('g').textContent='Google sign-in is not set up here.';return}
    var s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.onload=function(){
      google.accounts.id.initialize({client_id:c.clientId,ux_mode:'popup',callback:function(x){fetch('/v1/dashboard/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:x.credential})}).then(done).catch(fail)}});
      google.accounts.id.renderButton(document.getElementById('g'),{theme:'filled_black',size:'large',text:'continue_with',shape:'pill'});
    };document.head.appendChild(s);
  }).catch(fail);
  document.getElementById('kb').onclick=function(){fetch('/v1/dashboard/signin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('k').value})}).then(done).catch(fail)};
})();
</script></body></html>`;
