// Paths, the .env file and the settings J can change from the dashboard.
//
// Secrets stay in .env and are read on demand (never copied into process.env),
// so a tool only sees the key it asks for. Everything Hawkes Gen writes lives
// under DATA_DIR (default .data/, gitignored): the database, the library of
// generated files, fleet state and SSH keys, job graphs and scratch files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readEnv(root = ROOT): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

/** One value from .env, falling back to the real environment. */
export function env(name: string): string | undefined {
  return readEnv()[name] || process.env[name] || undefined;
}

export const DATA_DIR = path.resolve(env('HAWKESGEN_DATA_DIR') ?? path.join(ROOT, '.data'));
export const PORT = Number(env('HAWKESGEN_PORT') ?? 8790);
export const HOST = env('HAWKESGEN_HOST') ?? '127.0.0.1';

export const paths = {
  db: path.join(DATA_DIR, 'hawkesgen.db'),
  library: path.join(DATA_DIR, 'library'),
  blobs: path.join(DATA_DIR, 'blobs'),
  fleet: path.join(DATA_DIR, 'fleet'),
  builder: path.join(DATA_DIR, 'builder'),
  /** The folder that holds every project (Hawkes Gen's parent): C:\Projects. */
  projects: path.resolve(ROOT, '..'),
  graphs: path.join(DATA_DIR, 'graphs'),
  tmp: path.join(DATA_DIR, 'tmp'),
  settings: path.join(DATA_DIR, 'settings.json'),
  /** Player analytics (src/analytics/): its own database, and the GeoIP database it reads. */
  analytics: path.join(DATA_DIR, 'analytics.db'),
  geo: path.join(DATA_DIR, 'geo'),
  analyticsProducts: path.join(ROOT, 'analytics', 'products.json'),
  server: path.join(ROOT, 'server'),
  post: path.join(ROOT, 'post'),
  dashboard: path.join(ROOT, 'dashboard'),
};

for (const dir of [DATA_DIR, paths.library, paths.blobs, paths.fleet, paths.builder, paths.graphs, paths.tmp]) fs.mkdirSync(dir, { recursive: true });

/** Settings changed from the dashboard or the API (not secrets). */
export type Settings = {
  fleet: {
    /** How many GPU servers there may be, and how many GPU jobs run at once (one per ready server). */
    servers: number;
    /** Start stopped servers by themselves when GPU jobs wait (src/autostart.ts). On since 2026-10-18 (J: start stopped servers, no new launches). */
    auto: boolean;
    /** With auto on, also launch new servers from the fleet image when no stopped one is left. Off unless J turns it on. */
    autoLaunch: boolean;
    /**
     * The instance type auto launch uses (J, 2026-10-26: "make sure it launches the right one"): g6e.xlarge (one L40S,
     * 48 GB) by default, so it never falls back to a bigger, dearer machine with the same GPU (a g6e.4xlarge once took
     * all of us-west-2's quota for one GPU). "auto" brings back the fallback through every type, cheapest first.
     */
    launchType: string;
    /** How long a server sits idle before it powers itself off. */
    idleMinutes: number;
    /** When a job's models don't fit, remove the server's least recently used non-core models. */
    autoPrune: boolean;
    /** Servers launched from the fleet image are thrown away when idle (terminated, not stopped), so no disk is left costing ~$20/month. Servers that installed themselves are always kept. */
    disposable: boolean;
    /** When a job's models still don't fit after pruning, grow the server's disk up to this many GB (0: never; ~$0.08/GB-month). */
    maxDiskGb: number;
  };
  /** The LOD system makes levels automatically only for these projects (globs: "usr_*"): the ones whose games load them
   *  (hawkesgen.com's customers and its starter library, the beta portal's). Anything else asked for by id still gets them. */
  lod: { projects: string[] };
  /** Fair sharing of the GPU between customers (src/jobs.ts `fairOrder`): `perProjectGpu` is the most GPU jobs one customer
   *  project runs at once, `projects` (globs) says which projects are customers. Studio's own projects and admin/owner keys are exempt. */
  queue: { perProjectGpu: number; projects: string[] };
  /** Jobs at once for the API providers and local tools. */
  concurrency: { elevenlabs: number; anthropic: number; gemini: number; local: number; pipeline: number; lod: number };
  /** Where Claude calls go: "max-plan" runs Claude Code (`claude -p`) on J's Max plan ($0 per call), "api" the API key
   * (billed per token), "bedrock" uses AWS Bedrock (billed per token to AWS). J switched to max-plan on 2026-10-18 when the API account ran out of credits. Calls at once
   * (inside every job: reviews, judges, captions) and how long one may take. */
  claude: { backend: 'max-plan' | 'api' | 'bedrock'; concurrency: number; timeoutMinutes: number };
  /**
   * Which harness answers writing, review and JSON calls, and (via Studio) the coding agents.
   * "claude" is Claude Code (the Max plan or the API key above). "cursor" is Cursor's agent on the Cursor plan.
   * "copilot" is the GitHub Copilot CLI on the Copilot plan.
   * A saved "grok" was the xAI API; it now means Cursor. A file that never chose runs on Cursor (Claude usage is out, J 2026-10-19).
   */
  brain: 'claude' | 'cursor' | 'copilot';
  /** The Cursor model, when the harness is Cursor. Empty: Grok 4.7. */
  model?: string;
  /** Local requests (127.0.0.1) without an API key act as the owner. Turn off before exposing the service. */
  localOpen: boolean;
  /** Dollars per unit for usage reports, where the provider doesn't say. */
  rates: { elevenlabsPer1kChars: number };
  /** The library's files also go to this S3 bucket (src/storage.ts); null keeps them on this disk only. */
  storage: { bucket: string | null; /** The CDN's base URL (https://cdn.hawkesgen.com), set by deploy/cdn.mjs; files are at <cdn>/sha256/<hash>. */ cdn?: string | null };
  /** The sound suite (docs/audio.md). `verified`: open models that passed their smoke test and audition; `provider: auto` uses
   *  only these, else ElevenLabs. `targetLufs`: loudness per project (and kind) for audio.process; "default" is the fallback. */
  audio: { verified: string[]; targetLufs: Record<string, number> };
};

export const SETTINGS_DEFAULTS: Settings = {
  fleet: { servers: 4, auto: true, autoLaunch: false, launchType: 'g6e.xlarge', idleMinutes: 60, autoPrune: true, disposable: true, maxDiskGb: 0 },
  // pipeline: chains (asset.make, film) only wait on their steps; many at once keep a deep queue of each GPU model family,
  // so servers stay on one model instead of reloading (six at once made a 175-thing batch swap models all day).
  concurrency: { elevenlabs: 3, anthropic: 4, gemini: 3, local: 2, pipeline: 200, lod: 1 },
  lod: { projects: ['usr_*', 'ubeta_*'] },
  queue: { perProjectGpu: 2, projects: ['usr_*', 'ubeta_*'] },
  claude: { backend: 'max-plan', concurrency: 3, timeoutMinutes: 10 },
  brain: 'claude',
  model: '',
  localOpen: true,
  rates: { elevenlabsPer1kChars: 0.3 },
  storage: { bucket: null, cdn: null },
  audio: { verified: [], targetLufs: { default: -16, 'default:sfx': -18, 'default:music': -16, 'default:voice': -16 } },
};
export const FLEET_MAX = 16;

function clean(s: Settings): Settings {
  const n = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || d));
  return {
    fleet: {
      servers: n(s.fleet?.servers, 1, FLEET_MAX, SETTINGS_DEFAULTS.fleet.servers),
      auto: s.fleet?.auto === true,
      autoLaunch: s.fleet?.autoLaunch === true,
      launchType: /^(auto|g\d+e?\.\d*x?large)$/.test(String(s.fleet?.launchType ?? '')) ? String(s.fleet!.launchType) : SETTINGS_DEFAULTS.fleet.launchType,
      idleMinutes: n(s.fleet?.idleMinutes, 10, 240, SETTINGS_DEFAULTS.fleet.idleMinutes),
      autoPrune: s.fleet?.autoPrune !== false,
      disposable: s.fleet?.disposable !== false,
      maxDiskGb: n(s.fleet?.maxDiskGb, 0, 2000, SETTINGS_DEFAULTS.fleet.maxDiskGb),
    },
    concurrency: {
      elevenlabs: n(s.concurrency?.elevenlabs, 1, 16, SETTINGS_DEFAULTS.concurrency.elevenlabs),
      anthropic: n(s.concurrency?.anthropic, 1, 16, SETTINGS_DEFAULTS.concurrency.anthropic),
      gemini: n(s.concurrency?.gemini, 1, 16, SETTINGS_DEFAULTS.concurrency.gemini),
      local: n(s.concurrency?.local, 1, 8, SETTINGS_DEFAULTS.concurrency.local),
      pipeline: n(s.concurrency?.pipeline, 1, 1000, SETTINGS_DEFAULTS.concurrency.pipeline),
      lod: n(s.concurrency?.lod, 1, 4, SETTINGS_DEFAULTS.concurrency.lod),
    },
    lod: { projects: Array.isArray(s.lod?.projects) ? s.lod!.projects.map(String).filter(Boolean).slice(0, 50) : SETTINGS_DEFAULTS.lod.projects },
    queue: {
      perProjectGpu: n(s.queue?.perProjectGpu, 1, 16, SETTINGS_DEFAULTS.queue.perProjectGpu),
      projects: Array.isArray(s.queue?.projects) ? s.queue!.projects.map(String).filter(Boolean).slice(0, 50) : SETTINGS_DEFAULTS.queue.projects,
    },
    claude: {
      backend: s.claude?.backend === 'api' ? 'api' : s.claude?.backend === 'bedrock' ? 'bedrock' : 'max-plan',
      concurrency: n(s.claude?.concurrency, 1, 16, SETTINGS_DEFAULTS.claude.concurrency),
      timeoutMinutes: n(s.claude?.timeoutMinutes, 1, 60, SETTINGS_DEFAULTS.claude.timeoutMinutes),
    },
    brain: s.brain === 'cursor' || (s.brain as string) === 'grok' ? 'cursor' : s.brain === 'copilot' ? 'copilot' : 'claude',
    model: typeof (s as { model?: string }).model === 'string' ? (s as { model?: string }).model : '',
    localOpen: s.localOpen !== false,
    rates: { elevenlabsPer1kChars: Number(s.rates?.elevenlabsPer1kChars ?? SETTINGS_DEFAULTS.rates.elevenlabsPer1kChars) || 0 },
    audio: {
      verified: Array.isArray(s.audio?.verified) ? [...new Set(s.audio!.verified.map(String).filter((x) => /^[a-z0-9][a-z0-9._-]{0,40}$/.test(x)))] : [],
      targetLufs: Object.fromEntries(Object.entries({ ...SETTINGS_DEFAULTS.audio.targetLufs, ...(s.audio?.targetLufs ?? {}) }).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v as number) && (v as number) <= -5 && (v as number) >= -40)) as Record<string, number>,
    },
    storage: {
      bucket: typeof s.storage?.bucket === 'string' && /^[a-z0-9][a-z0-9.-]{2,62}$/.test(s.storage.bucket) ? s.storage.bucket : null,
      cdn: typeof s.storage?.cdn === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(s.storage.cdn) ? s.storage.cdn : null,
    },
  };
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
    // Settings saved before fleet.autoLaunch existed had auto start off by default: J turned it on (2026-10-18, starts
    // only). The first save after this writes autoLaunch, so J's later choice sticks.
    if (raw.fleet && !('autoLaunch' in raw.fleet)) raw.fleet = { ...raw.fleet, auto: true, autoLaunch: false };
    // A file saved before "brain" existed never chose Claude on purpose. Claude usage is out (J, 2026-10-19).
    if (!raw.brain || raw.brain === 'grok') raw.brain = 'cursor';
    return clean({ ...SETTINGS_DEFAULTS, ...raw, fleet: { ...SETTINGS_DEFAULTS.fleet, ...raw.fleet }, concurrency: { ...SETTINGS_DEFAULTS.concurrency, ...raw.concurrency }, claude: { ...SETTINGS_DEFAULTS.claude, ...raw.claude }, rates: { ...SETTINGS_DEFAULTS.rates, ...raw.rates }, audio: { ...SETTINGS_DEFAULTS.audio, ...raw.audio } });
  } catch {
    return clean(SETTINGS_DEFAULTS);
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const cur = loadSettings();
  const next = clean({
    ...cur,
    ...patch,
    fleet: { ...cur.fleet, ...(patch.fleet ?? {}) },
    concurrency: { ...cur.concurrency, ...(patch.concurrency ?? {}) },
    claude: { ...cur.claude, ...(patch.claude ?? {}) },
    brain: patch.brain ?? cur.brain,
    model: patch.model ?? cur.model,
    rates: { ...cur.rates, ...(patch.rates ?? {}) },
    audio: { ...cur.audio, ...(patch.audio ?? {}) },
  });
  fs.writeFileSync(paths.settings, JSON.stringify(next, null, 2));
  return next;
}
