// Hawkes Gen as an MCP server (stdio), so Claude Code, Cursor or any agent in
// any project can use it directly. It talks to the running service over HTTP
// (the cloud through ~/.hawkes/client.json, or this PC), so the queue, fleet and
// library are shared. The tools are in mcp-tools.ts; /mcp on the service serves
// the same ones over HTTP for Claude anywhere (hawkesstudio/docs/cloud.md).
//
//   .mcp.json:  { "mcpServers": { "hawkesgen": { "command": "node",
//                 "args": ["C:/Projects/hawkesgen/bin/hawkesgen-mcp.mjs"] } } }

// @ts-ignore: plain JS client
import { HawkesGen } from '../clients/js/hawkesgen.mjs';
import { serveStdio } from './mcp-core.ts';
import { genMcp } from './mcp-tools.ts';

serveStdio(genMcp(new HawkesGen({})));
