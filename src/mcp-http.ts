// /mcp: the Hawkes Gen MCP tools over Streamable HTTP, for Claude Code anywhere (claude mcp add --transport http)
// and claude.ai connectors. The caller's Hawkes Gen API key is the auth, sent as "Authorization: Bearer hg_..." or in
// the URL (/mcp/hg_..., for clients that can't send headers); the tools then call this service with that same key,
// so its role and projects apply. hawkesstudio/docs/cloud.md has the setup.

import type { IncomingMessage, ServerResponse } from 'node:http';
// @ts-ignore: plain JS client
import { HawkesGen } from '../clients/js/hawkesgen.mjs';
import { serveHttp, mcpKey } from './mcp-core.ts';
import { genMcp } from './mcp-tools.ts';
import { authenticate } from './auth.ts';
import { PORT } from './config.ts';

export async function handleMcp(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const key = mcpKey(req, pathname);
  if (key) req.headers.authorization = `Bearer ${key}`;
  const client = authenticate(req);
  if (!client) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="hawkesgen"' });
    return void res.end(JSON.stringify({ error: 'Send a Hawkes Gen API key: Authorization: Bearer hg_...' }));
  }
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
  const filesUrl = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
  const gen = new HawkesGen({ url: `http://127.0.0.1:${PORT}`, key });
  return serveHttp(req, res, genMcp(gen, { remote: true, filesUrl }));
}
