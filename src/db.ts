// The database: jobs, the library of generated assets, usage (what each job
// cost, per client and project) and API clients. SQLite through node:sqlite,
// one file in DATA_DIR. JSON columns are stored as text and parsed on read.

import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.ts';

export const db = new DatabaseSync(paths.db);
// busy_timeout first: switching to WAL needs a moment alone with the file, and another process opening it (a second
// test file, the CLI next to the service) would otherwise fail at once with "database is locked".
db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

const MIGRATIONS: string[] = [
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     key TEXT,
     client TEXT NOT NULL,
     project TEXT NOT NULL,
     tool TEXT NOT NULL,
     params TEXT NOT NULL,
     inputs TEXT NOT NULL,
     labels TEXT NOT NULL DEFAULT '{}',
     priority INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     log TEXT NOT NULL DEFAULT '[]',
     outputs TEXT NOT NULL DEFAULT '[]',
     result TEXT,
     error TEXT,
     server TEXT,
     family TEXT,
     gpu_seconds REAL NOT NULL DEFAULT 0,
     cost REAL NOT NULL DEFAULT 0,
     graphs TEXT NOT NULL DEFAULT '[]',
     resumed INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL,
     started INTEGER,
     finished INTEGER
   );
   CREATE UNIQUE INDEX jobs_key ON jobs (client, key) WHERE key IS NOT NULL;
   CREATE INDEX jobs_status ON jobs (status, priority DESC, created);
   CREATE INDEX jobs_project ON jobs (project, created DESC);

   CREATE TABLE assets (
     id TEXT PRIMARY KEY,
     job TEXT,
     client TEXT NOT NULL,
     project TEXT NOT NULL,
     tool TEXT NOT NULL,
     kind TEXT NOT NULL,
     mime TEXT NOT NULL,
     path TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     seed INTEGER,
     recipe TEXT NOT NULL,
     recipe_key TEXT NOT NULL,
     labels TEXT NOT NULL DEFAULT '{}',
     tags TEXT NOT NULL DEFAULT '[]',
     title TEXT,
     starred INTEGER NOT NULL DEFAULT 0,
     meta TEXT NOT NULL DEFAULT '{}',
     created INTEGER NOT NULL
   );
   CREATE INDEX assets_project ON assets (project, created DESC);
   CREATE INDEX assets_kind ON assets (kind, created DESC);
   CREATE INDEX assets_recipe ON assets (recipe_key);
   CREATE INDEX assets_job ON assets (job);

   CREATE TABLE usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     client TEXT NOT NULL,
     project TEXT NOT NULL,
     job TEXT,
     provider TEXT NOT NULL,
     unit TEXT NOT NULL,
     amount REAL NOT NULL,
     cost REAL NOT NULL DEFAULT 0,
     detail TEXT
   );
   CREATE INDEX usage_at ON usage (at);

   CREATE TABLE clients (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     prefix TEXT NOT NULL,
     key_hash TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL,
     projects TEXT NOT NULL DEFAULT '["*"]',
     created INTEGER NOT NULL,
     last_used INTEGER,
     disabled INTEGER NOT NULL DEFAULT 0
   );`,
  // The library's structure (src/entities.ts): the things a product cares about (a fighter, a stage, a shot), named
  // slots on them (concept, side, pose/air, clip/jab, model, animation/walk) and every version of each slot: takes,
  // the current one, old ones and discarded ones, with notes and what each was made from.
  `CREATE TABLE entities (
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     slug TEXT NOT NULL,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     data TEXT NOT NULL DEFAULT '{}',
     tags TEXT NOT NULL DEFAULT '[]',
     archived INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE INDEX entities_project ON entities (project, kind, slug);

   CREATE TABLE versions (
     id TEXT PRIMARY KEY,
     entity TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
     slot TEXT NOT NULL,
     n INTEGER NOT NULL,
     asset TEXT NOT NULL,
     status TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     by TEXT NOT NULL DEFAULT '',
     job TEXT,
     made_from TEXT NOT NULL DEFAULT '[]',
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX versions_n ON versions (entity, slot, n);
   CREATE INDEX versions_asset ON versions (asset);
   CREATE INDEX versions_status ON versions (entity, slot, status);`,
  // Multi-tenant SaaS users, session tokens, and credit ledger (src/users.ts, src/billing.ts).
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT UNIQUE NOT NULL,
     name TEXT,
     password_hash TEXT NOT NULL,
     project TEXT UNIQUE NOT NULL,
     client_id TEXT,
     credits INTEGER NOT NULL DEFAULT 0,
     stripe_customer_id TEXT,
     created INTEGER NOT NULL,
     last_login INTEGER
   );
   CREATE INDEX users_client ON users (client_id);

   CREATE TABLE user_sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     created INTEGER NOT NULL,
     expires INTEGER NOT NULL
   );
   CREATE INDEX user_sessions_user ON user_sessions (user_id);

   CREATE TABLE credit_ledger (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     delta INTEGER NOT NULL,
     balance_after INTEGER NOT NULL,
     kind TEXT NOT NULL,
     detail TEXT,
     job_id TEXT,
     stripe_session_id TEXT UNIQUE,
     created INTEGER NOT NULL
   );
   CREATE INDEX credit_ledger_user ON credit_ledger (user_id, created DESC);
   CREATE INDEX credit_ledger_job ON credit_ledger (job_id);`,
  // Subscription plans and user subscriptions for monthly credit allocation.
  `CREATE TABLE subscription_plans (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     price_cents INTEGER NOT NULL,
     credits_per_month INTEGER NOT NULL,
     max_games INTEGER NOT NULL DEFAULT 3,
     max_members_per_game INTEGER NOT NULL DEFAULT 4,
     stripe_price_id TEXT UNIQUE,
     active INTEGER NOT NULL DEFAULT 1,
     created INTEGER NOT NULL
   );

   CREATE TABLE user_subscriptions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     plan_id TEXT NOT NULL REFERENCES subscription_plans (id),
     stripe_subscription_id TEXT UNIQUE,
     status TEXT NOT NULL,
     current_period_start INTEGER NOT NULL,
     current_period_end INTEGER NOT NULL,
     cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE INDEX user_subscriptions_user ON user_subscriptions (user_id);
   CREATE INDEX user_subscriptions_status ON user_subscriptions (status, current_period_end);`,
  // Games: collaborative web game projects with Babylon.js runtime.
  `CREATE TABLE games (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     slug TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     published INTEGER NOT NULL DEFAULT 0,
     published_at INTEGER,
     subdomain TEXT UNIQUE,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE INDEX games_user ON games (user_id, created DESC);
   CREATE INDEX games_slug ON games (user_id, slug);
   CREATE INDEX games_subdomain ON games (subdomain) WHERE subdomain IS NOT NULL;

   CREATE TABLE game_members (
     id TEXT PRIMARY KEY,
     game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     invited_by TEXT,
     joined INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX game_members_unique ON game_members (game_id, user_id);
   CREATE INDEX game_members_user ON game_members (user_id);

   CREATE TABLE game_files (
     id TEXT PRIMARY KEY,
     game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     content TEXT NOT NULL,
     updated_by TEXT NOT NULL,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX game_files_path ON game_files (game_id, path);
   CREATE INDEX game_files_updated ON game_files (game_id, updated DESC);

   CREATE TABLE game_releases (
     id TEXT PRIMARY KEY,
     game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
     version TEXT NOT NULL,
     notes TEXT NOT NULL DEFAULT '',
     files TEXT NOT NULL,
     released_by TEXT NOT NULL,
     created INTEGER NOT NULL
   );
   CREATE INDEX game_releases_game ON game_releases (game_id, created DESC);`,
];

db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
const version = Number((db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v?: string } | undefined)?.v ?? 0);
for (let i = version; i < MIGRATIONS.length; i++) {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(i + 1));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The LOD system (src/lod.ts): every image's and model's smaller copies belong to it (asset_lods), what's made per
// asset (asset_lod_state), and low copies a job made beside its model (asset_lod_links: hidden from lists). Created if
// missing rather than as a numbered migration, so it can't collide with another branch's next migration.
db.exec(`
CREATE TABLE IF NOT EXISTS asset_lods (
  asset TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  role TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  triangles INTEGER,
  texture INTEGER,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (asset, level)
);
CREATE TABLE IF NOT EXISTS asset_lod_state (
  asset TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  job TEXT,
  width INTEGER,
  height INTEGER,
  triangles INTEGER,
  texture INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_lod_state_state ON asset_lod_state (state, updated);
CREATE TABLE IF NOT EXISTS asset_lod_links (
  low TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  asset TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS asset_lod_links_asset ON asset_lod_links (asset);
-- A tool's recent finished jobs (jobs.ts recentRunSeconds, the queue's wait estimate): without it each ask scans every job.
CREATE INDEX IF NOT EXISTS jobs_tool_done ON jobs (tool, status, finished DESC);
`);

/** Parses the JSON columns of a row. */
export function parseRow<T = any>(row: any, json: string[]): T {
  if (!row) return row;
  const out = { ...row };
  for (const k of json) if (typeof out[k] === 'string') out[k] = JSON.parse(out[k]);
  return out as T;
}

export const J = (v: unknown) => JSON.stringify(v ?? null);
