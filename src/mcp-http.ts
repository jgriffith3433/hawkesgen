// /mcp: the Hawkes Gen MCP tools over Streamable HTTP, for Claude, Claude Code, Cursor, VS Code and any MCP client.
// Signing in is OAuth (src/genoauth.ts, J, 2026-10-30: no pasted keys): with no token the answer is a 401 whose
// WWW-Authenticate names where to sign in, and the editor opens the browser, the person signs in with their Gen account
// and allows it. The token (hgm_...) is that account everywhere a Gen key is (users.ts authenticateRequest). A Gen API
// key (Authorization: Bearer hg_..., or /mcp/hg_... for clients that can't send headers) and a platform token from the
// portal (src/platform.ts) still work. The tools call this service with the same credential, so its role and projects
// apply. hawkesstudio/docs/cloud.md has the setup.

import type { IncomingMessage, ServerResponse } from 'node:http';
// @ts-ignore: plain JS client
import { HawkesGen } from '../clients/js/hawkesgen.mjs';
import { serveHttp, mcpKey } from './mcp-core.ts';
import { genMcp } from './mcp-tools.ts';
import { authenticateRequest, getUserById } from './users.ts';
import { primePlatform } from './platform.ts';
import { genOAuth } from './genoauth.ts';
import { PORT } from './config.ts';
import { downloadLink, uploadLink } from './links.ts';

export async function handleMcp(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const key = mcpKey(req, pathname);
  if (key) req.headers.authorization = `Bearer ${key}`;
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  // A hawkesgen.ai platform token works here too (src/platform.ts): the tools call Gen with it, as the org's customer.
  await primePlatform(req);
  // Only what the request carries: never the app's session cookie (an MCP endpoint is called from anywhere).
  const client = bearer ? authenticateRequest(req) : null;
  if (!client) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': genOAuth.challenge(req, Boolean(bearer)), 'Access-Control-Expose-Headers': 'WWW-Authenticate' });
    return void res.end(JSON.stringify({ error: bearer ? 'This sign-in expired or was disconnected: connect again.' : 'Sign in: add this server in your editor and it opens Hawkes Gen to connect.' }));
  }
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
  const filesUrl = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
  const gen = new HawkesGen({ url: `http://127.0.0.1:${PORT}`, key: bearer });
  // A Gen account (an OAuth sign-in, or its own key) works in its own project unless a tool names another it may use;
  // an admin's account too (its own work stays in its own project, like the app).
  const account = client.userId ? getUserById(client.userId)?.project : undefined;
  // Outputs come back as signed links an editor can download without a credential; uploads as one-time links.
  return serveHttp(req, res, genMcp(gen, {
    remote: true, filesUrl, account,
    fileLink: (asset, name) => downloadLink(filesUrl, asset, name),
    uploadLink: (filename) => uploadLink(filesUrl, { id: client.id, projects: client.projects }, filename),
  }));
}
