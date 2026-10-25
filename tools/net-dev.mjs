// A scratch Hawkes Gen for trying Hawkes Net in a browser: its own data folder and port, the node inside it.
//   node tools/net-dev.mjs [port]      ->  http://127.0.0.1:<port>/net.html
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = process.argv[2] || process.env.PORT || '8796';
process.env.HAWKESGEN_PORT = port;
process.env.HAWKESGEN_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'hg-netdev-'));
process.env.HAWKESGEN_NET_WORKERS ??= '1';
await import('../src/server.ts');
