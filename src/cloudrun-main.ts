// The Cloud Run entry (server/gen-cloudrun/entrypoint.sh runs it under Litestream): the state files come down before
// anything reads settings, the owner key is made on an empty database, then the usual server starts (src/server.ts).
import { pullState, ensureOwner, startCloudHost } from './cloudhost.ts';

const n = await pullState().catch((e) => { console.warn(`[cloudhost] state pull: ${e.message}`); return 0; });
console.log(`[cloudhost] ${n} state file(s) from Cloud Storage`);
const owner = await ensureOwner();
if (owner) console.log(`[cloudhost] owner key set up (${owner})`);
await import('./server.ts');
startCloudHost();
