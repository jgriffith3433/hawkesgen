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
    /**
     * Gen's fixed public address when it has one (docs/gpu-providers.md, "The fleet from Cloud Run"): Cloud Run's Direct VPC
     * egress through Cloud NAT with a reserved IP (tools/gpu-providers/egress.mjs). The servers' security groups let this
     * address in. Empty: the address is looked up (J's PC, a VM), or HAWKES_PUBLIC_IP from the environment.
     */
    egressIp: string;
    /**
     * Without a fixed address on Cloud Run: open the servers' ComfyUI port (only it, never SSH) to every address and rely
     * on each server's own token. Off unless J turns it on; while off, Gen on Cloud Run without egressIp doesn't use the fleet.
     */
    openComfyPort: boolean;
  };
  /** The LOD system makes levels automatically only for these projects (globs: "usr_*"): the ones whose games load them
   *  (hawkesgen.ai's customers and its starter library, the beta portal's). Anything else asked for by id still gets them. */
  lod: { projects: string[] };
  /** Fair sharing of the GPU between customers (src/jobs.ts `fairOrder`): `perProjectGpu` is the most GPU jobs one customer
   *  project runs at once, `perProjectLane` the most slots one takes in each API or local lane (playtests count browser
   *  tabs), `projects` (globs) says which projects are customers. Studio's own projects and admin/owner keys are exempt. */
  queue: { perProjectGpu: number; perProjectLane: number; projects: string[] };
  /** Platform tokens from the portal (src/platform.ts): `issuer` the portal this lane trusts (empty: hawkesgames.com, or
   *  beta.hawkesgames.com on beta), `freeOrgs` the orgs that may submit jobs with a token before billing is connected
   *  (design partners, J's own). */
  platform: { issuer: string; freeOrgs: string[] };
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
  storage: { bucket: string | null; /** Which cloud the bucket is in: s3 (default) or gcs (Google Cloud Storage, src/storage.ts). */ provider?: 's3' | 'gcs'; /** The CDN's base URL (https://cdn.hawkesgen.ai), set by deploy/cdn.mjs; files are at <cdn>/sha256/<hash>. */ cdn?: string | null; /** Projects whose files the CDN serves: names, `prefix*`, or `*` (every project except customers' usr_ and ustg_ ones, which only their exact name or their own prefix lets in). Default ["*"]. */ cdnProjects?: string[] };
  /** The sound suite (docs/audio.md). `verified`: open models that passed their smoke test and audition; `provider: auto` uses
   *  only these, else ElevenLabs. `targetLufs`: loudness per project (and kind) for audio.process; "default" is the fallback. */
  audio: { verified: string[]; targetLufs: Record<string, number> };
  /**
   * Where GPU jobs run (docs/cloudrun.md). `backend`: fleet (the AWS servers, the default) or cloudrun (the family's Cloud
   * Run service, server/cloudrun/services.json); `families` overrides it per model family. `cloudrun.urls`: each deployed
   * service's URL (tools/cloudrun/deploy.mjs prints them); a family whose service has no URL stays on the fleet.
   * `cloudrun.bucket`: inputs and outputs of runs (gs://<bucket>/cloudrun/...). `cloudrun.services`: family -> service
   * overrides (a pilot alternative).
   */
  gpu: {
    backend: 'fleet' | 'cloudrun'; families: Record<string, 'fleet' | 'cloudrun'>; cloudrun: { bucket: string | null; urls: Record<string, string>; services: Record<string, string> };
    /**
     * GPU providers beyond the AWS fleet and Cloud Run (docs/gpu-providers.md, src/providers/gpu/): endpoints running
     * the same worker image (server/cloudrun/) on RunPod, Modal or any host that speaks the worker protocol. Each says
     * which families it runs ("*" for all), its GPU, its price and how many requests it takes at once.
     */
    providers: GpuEndpoint[];
    /**
     * The order GPU jobs try providers in: endpoint ids, "cloudrun" (the family's Cloud Run service, as cloudrun.urls
     * says) and "fleet" (the AWS servers). A provider that is down, out of capacity or not set up is skipped for a while
     * and the job goes to the next. Empty: the old rule (backend and families) and nothing else.
     */
    order: string[];
    /** An order per family over `order` ("video": ["runpod-a100", "fleet"]). */
    familyOrder: Record<string, string[]>;
  };
  /**
   * Where unity.build and unity.test run (docs/unity-cloudrun.md). "builder" is the Windows build server on AWS
   * (src/providers/builder/builder.ts); "cloudrun" is a Google Cloud Run job per build (cloudrun.ts), with the
   * project's Library cached in Cloud Storage. `timeoutMinutes` is the hard limit on one build for both.
   * `cleanAfterFailures`: that many cache-looking failures in a row make the next cloud build run without the cache.
   * `concurrency`: cloud builds at once (the build server always runs one).
   * "vm" (per project, for Libraries too big for Cloud Run's 32 GiB in memory): the same container on a spot VM per
   * project with a persistent disk that keeps the Library (vm.ts; `vm` below). `vmAt`: a Cloud Run build whose memory
   * peak passes that share of its limit moves its project to "vm" for the next build (0 turns it off).
   */
  unityBuild: {
    backend: UnityBackend; timeoutMinutes: number; cleanAfterFailures: number; concurrency: number; vmAt: number;
    /** A backend per project ("sickofitgame-unity": "vm") over `backend`: a Library too big for Cloud Run builds where it fits. */
    projects: Record<string, UnityBackend>;
    /**
     * `images`: the Unity versions customer builds may use, each with the Cloud Run job that runs that version's image
     * ({ "6000.3.7f1": "hawkes-unity-build" }; an execution can't change a job's image, so a version is a job). Empty:
     * `unity` on `job` only. Adding a version = an image (tools/unity-cloudrun/build-image.mjs), a job, and a line here.
     */
    gcp: { project: string; region: string; job: string; bucket: string; unity: string; cpu: number; memoryGiB: number; images: Record<string, string> };
    /** The build VMs: one per project, named hawkes-unity-<project>, made by tools/unity-cloudrun/vm.mjs. */
    vm: { zone: string; machineType: string; pricePerHour: number };
  };
  /**
   * Where playtest.run's browser runs on the control server (docs/playtest-cloudrun.md). "ec2" is the playtesters (T4
   * machines over an SSH tunnel, src/providers/playtester/playtester.ts); "cloudrun" is the Cloud Run L4 service
   * (server/playtest-cloudrun/, src/providers/playtester/cloudrun.ts). `projects` overrides it per product. Cloud Run is
   * used only when `cloudrun.url` is set; if it can't be reached the run falls back to the playtesters. `maxInstances`
   * and `tabsPerInstance` must match the deployed service (Gen's lane admits their product in browser tabs). `encode`:
   * where the video is encoded, on the service (NVENC) or here.
   * "cloudrun-cpu" is the same browser service without a GPU (gen-playtest-cpu: WebGL on SwiftShader, request-based
   * billing, scale to zero; `cloudrunCpu`): it plays when no GPU is to be had (AWS suspended 2026-10-28, no L4 quota).
   * "cloudrun" falls back to it when the L4 service can't be reached and `cloudrunCpu.url` is set; either falls back to
   * the playtesters. Frame rates there are SwiftShader's, so the run reports `software: true`.
   */
  playtest: {
    backend: PlaytestBackend;
    projects: Record<string, PlaytestBackend>;
    cloudrun: { url: string | null; maxInstances: number; tabsPerInstance: number; encode: 'service' | 'here' };
    cloudrunCpu: {
      url: string | null; maxInstances: number; tabsPerInstance: number; encode: 'service' | 'here';
      /** More regions of the same CPU service, tried in order when one is full (J, 2026-10-29: "can't we utilize both
       *  regions"): Cloud Run's CPU quota is per region, so each adds its own instances. Their tabs add to the lane. */
      extra: { url: string; region: string; maxInstances: number }[];
    };
    /**
     * A RunPod serverless load-balancer endpoint running the same browser image on a real NVIDIA GPU
     * (docs/playtest-runpod.md; tools/playtest-runpod/setup.mjs makes it). Backend "runpod" tries it first, then the
     * CPU service. `url` is https://<endpoint id>.api.runpod.ai; `maxInstances` is the endpoint's max workers;
     * `pricePerHour` is a worker's price (RunPod bills from the worker's start to its idle timeout, `idleSeconds`).
     */
    runpod: { url: string | null; maxInstances: number; tabsPerInstance: number; encode: 'service' | 'here'; gpu: string; pricePerHour: number; idleSeconds: number };
    /**
     * The runner router (src/providers/playtester/runners.ts, docs/playtest-runners.md): where a playtest plays, by its
     * target, first with room first. Empty: web runs play as `backend` says (the services above), and nothing plays
     * desktop targets. Each entry: `provider` runpod / cloudrun / cloudrun-cpu (the browser services above: their URL
     * when `url` is null) or native (a hawkes-play-native runner, the session protocol); `targets` it plays; `lanes`
     * whose builds it takes (studio: our own products; customer: untrusted builds, plan 3.5); a price and a cap.
     */
    runners: PlaytestRunner[];
  };
  /**
   * Where the CPU suite runs (docs/cpu-cloudrun.md): "local" is this machine; "cloudrun" is Cloud Run, one request per
   * job (server/cpu-cloudrun/, src/providers/cloudrun/cpu.ts). `tools` overrides it per tool ("asset.lod": "cloudrun"
   * sends the LOD system's image and model work there too). Two services of one image: `light` (gen-cpu: small
   * instances, many requests each) and `heavy` (gen-cpu-heavy: one request per instance); their sizes are in
   * server/cpu-cloudrun/service.json. A tool goes to its class's URL, else the other one; with neither URL, or no
   * `bucket`, it runs here. `concurrent`: jobs sent to Cloud Run at once (their own lane, apart from the local one).
   */
  cpu: {
    backend: 'local' | 'cloudrun';
    tools: Record<string, 'local' | 'cloudrun'>;
    cloudrun: { urls: { light?: string; heavy?: string }; bucket: string | null; concurrent: number };
  };
  /**
   * The dashboard's "Continue with Google" (src/dashauth.ts): the Google OAuth web client whose sign-in button it shows
   * (its Authorized JavaScript origins must list this Gen's address), and the Google accounts let in as the owner.
   * Without both, only the key sign-in is offered.
   */
  dashboard: { googleClientId: string | null; googleEmails: string[] };
};

/** A GPU endpoint (settings.gpu.providers): a host running the worker image (docs/gpu-providers.md). */
/** RunPod load-balancing endpoints process a request for at most 5.5 minutes (docs.runpod.io, load balancing). */
export const RUNPOD_GRAPH_SECONDS = 300;

export type GpuEndpoint = {
  id: string;
  provider: 'runpod' | 'modal' | 'http';
  url: string;
  /** Families it runs, or ["*"]. */
  families: string[];
  gpu: string;
  pricePerHour: number;
  maxConcurrent: number;
  /**
   * The most one graph may run there, in seconds. Past a provider's request limit the stream ends and Gen follows the run
   * by its heartbeat (cloudrun/run.ts), but a host may stop an instance with no request open: RunPod's load-balancing
   * endpoints end a request at 5.5 minutes, so their default is 300 and longer graphs go to the next provider.
   */
  graphLimitSeconds: number;
  enabled: boolean;
};

/** What a playtest plays (playtest.run's `target`): a page, an Electron app, or a desktop build on Linux, Proton or Windows. */
export type PlaytestTarget = 'web' | 'electron' | 'linux' | 'proton' | 'windows';
export const PLAYTEST_TARGETS: readonly PlaytestTarget[] = ['web', 'electron', 'linux', 'proton', 'windows'];
/** A runner in settings.playtest.runners (docs/playtest-runners.md). */
export type PlaytestRunner = {
  id: string;
  provider: 'runpod' | 'cloudrun' | 'cloudrun-cpu' | 'native';
  /** https://…; null for a browser service means its URL in settings.playtest (runpod.url, cloudrun.url, cloudrunCpu.url). */
  url: string | null;
  targets: PlaytestTarget[];
  lanes: ('studio' | 'customer')[];
  /** What a second of a run costs us there (dollars), for usage rows and quotes. */
  pricePerSecond: number;
  /** Runs at once. */
  maxConcurrent: number;
  /** A native runner's key: the name of the environment variable or secret that holds it (sent as X-Hawkes-Token). */
  tokenEnv: string | null;
  /** A native runner behind a gateway that wants its own key (RunPod's load balancer: RUNPOD_API_KEY), sent as
   *  Authorization: Bearer; null for none. */
  gatewayKeyEnv?: string | null;
  enabled: boolean;
};

/** Where playtest.run's browser runs (settings.playtest): the EC2 playtesters, the L4 service, the CPU service. */
export type PlaytestBackend = 'ec2' | 'cloudrun' | 'cloudrun-cpu' | 'runpod';
export const PLAYTEST_BACKENDS: readonly PlaytestBackend[] = ['ec2', 'cloudrun', 'cloudrun-cpu', 'runpod'];
export type UnityBackend = 'builder' | 'cloudrun' | 'vm';
const isUnityBackend = (v: unknown): v is UnityBackend => v === 'builder' || v === 'cloudrun' || v === 'vm';

export const SETTINGS_DEFAULTS: Settings = {
  fleet: { servers: 4, auto: true, autoLaunch: false, launchType: 'g6e.xlarge', idleMinutes: 60, autoPrune: true, disposable: true, maxDiskGb: 0, egressIp: '', openComfyPort: false },
  // pipeline: chains (asset.make, film) only wait on their steps; many at once keep a deep queue of each GPU model family,
  // so servers stay on one model instead of reloading (six at once made a 175-thing batch swap models all day).
  concurrency: { elevenlabs: 3, anthropic: 4, gemini: 3, local: 2, pipeline: 200, lod: 1 },
  lod: { projects: ['usr_*', 'ubeta_*'] },
  queue: { perProjectGpu: 2, perProjectLane: 2, projects: ['usr_*', 'ustg_*', 'ubeta_*', 'u_*', 'org_*'] },
  platform: { issuer: '', freeOrgs: [] },
  claude: { backend: 'max-plan', concurrency: 3, timeoutMinutes: 10 },
  brain: 'claude',
  model: '',
  localOpen: true,
  rates: { elevenlabsPer1kChars: 0.3 },
  storage: { bucket: null, provider: 's3', cdn: null, cdnProjects: ['*'] },
  gpu: { backend: 'fleet', families: {}, cloudrun: { bucket: null, urls: {}, services: {} }, providers: [], order: [], familyOrder: {} },
  audio: { verified: [], targetLufs: { default: -16, 'default:sfx': -18, 'default:music': -16, 'default:voice': -16 } },
  unityBuild: {
    backend: 'builder', timeoutMinutes: 40, cleanAfterFailures: 2, concurrency: 2, vmAt: 0.85, projects: {},
    gcp: { project: '', region: 'us-east4', job: 'hawkes-unity-build', bucket: '', unity: '6000.3.7f1', cpu: 8, memoryGiB: 32, images: {} },
    vm: { zone: 'us-east4-a', machineType: 'n2-standard-8', pricePerHour: 0.1 },
  },
  playtest: { backend: 'ec2', projects: {}, cloudrun: { url: null, maxInstances: 2, tabsPerInstance: 4, encode: 'service' }, cloudrunCpu: { url: null, maxInstances: 4, tabsPerInstance: 1, encode: 'service', extra: [] },
    runpod: { url: null, maxInstances: 2, tabsPerInstance: 2, encode: 'service', gpu: 'RTX A4000', pricePerHour: 0.58, idleSeconds: 60 }, runners: [] },
  cpu: { backend: 'local', tools: {}, cloudrun: { urls: {}, bucket: null, concurrent: 16 } },
  dashboard: { googleClientId: null, googleEmails: [] },
};

/** settings.dashboard, checked: a Google web client id and plain email addresses (lower case). */
function cleanDashboard(d: Partial<Settings['dashboard']> | undefined): Settings['dashboard'] {
  const id = typeof d?.googleClientId === 'string' && /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(d.googleClientId.trim()) ? d.googleClientId.trim() : null;
  const emails = (Array.isArray(d?.googleEmails) ? d.googleEmails : []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));
  return { googleClientId: id, googleEmails: [...new Set(emails)].slice(0, 20) };
}

/** settings.cpu, checked: known backends, tool ids, an https URL, a bucket name, sizes Cloud Run allows. */
function cleanCpu(c: Partial<Settings['cpu']> | undefined): Settings['cpu'] {
  const d = SETTINGS_DEFAULTS.cpu;
  const be = (v: unknown): 'local' | 'cloudrun' | null => (v === 'cloudrun' ? 'cloudrun' : v === 'local' ? 'local' : null);
  const n = (v: unknown, lo: number, hi: number, def: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || def));
  const tools: Record<string, 'local' | 'cloudrun'> = {};
  for (const [k, v] of Object.entries(c?.tools ?? {})) if (/^[a-z0-9][a-z0-9.-]{0,62}$/.test(k) && be(v)) tools[k] = be(v)!;
  const r: Partial<Settings['cpu']['cloudrun']> = c?.cloudrun ?? {};
  const url = (v: unknown) => (typeof v === 'string' && /^https:\/\/[a-z0-9.-]+\/?$/.test(v) ? v.replace(/\/$/, '') : undefined);
  const urls: Settings['cpu']['cloudrun']['urls'] = {};
  for (const k of ['light', 'heavy'] as const) if (url(r.urls?.[k])) urls[k] = url(r.urls?.[k]);
  return {
    backend: be(c?.backend) ?? d.backend,
    tools,
    cloudrun: {
      urls,
      bucket: typeof r.bucket === 'string' && /^[a-z0-9][a-z0-9._-]{2,62}$/.test(r.bucket) ? r.bucket : null,
      concurrent: n(r.concurrent, 1, 200, d.cloudrun.concurrent),
    },
  };
}

/** settings.playtest, checked: known backends only, an https run.app-style URL, sane sizes. */
function cleanPlaytest(t: Partial<Settings['playtest']> | undefined): Settings['playtest'] {
  const d = SETTINGS_DEFAULTS.playtest;
  const be = (v: unknown): PlaytestBackend | null => (PLAYTEST_BACKENDS.includes(v as PlaytestBackend) ? (v as PlaytestBackend) : null);
  const n = (v: unknown, lo: number, hi: number, def: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || def));
  // A Cloud Run URL, or the same container on this machine (http://127.0.0.1:<port>: no token; docs/playtest-cloudrun.md).
  const okUrl = (u: unknown): u is string => typeof u === 'string' && (/^https:\/\/[a-z0-9.-]+\/?$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(u));
  const service = (c: Partial<Settings['playtest']['cloudrun']>, def: Settings['playtest']['cloudrun']): Settings['playtest']['cloudrun'] => ({
    url: okUrl(c.url) ? c.url.replace(/\/$/, '') : null,
    maxInstances: n(c.maxInstances, 1, 20, def.maxInstances),
    tabsPerInstance: n(c.tabsPerInstance, 1, 8, def.tabsPerInstance),
    encode: c.encode === 'here' ? 'here' : 'service',
  });
  const projects: Record<string, PlaytestBackend> = {};
  for (const [k, v] of Object.entries(t?.projects ?? {})) if (/^[A-Za-z0-9._/-]{1,80}$/.test(k) && be(v)) projects[k] = be(v)!;
  return {
    backend: be(t?.backend) ?? d.backend,
    projects,
    cloudrun: service(t?.cloudrun ?? {}, d.cloudrun),
    cloudrunCpu: {
      ...service(t?.cloudrunCpu ?? {}, d.cloudrunCpu),
      extra: (Array.isArray(t?.cloudrunCpu?.extra) ? t!.cloudrunCpu!.extra : [])
        .filter((x: any) => okUrl(x?.url) && /^[a-z]+-[a-z]+\d$/.test(String(x?.region ?? '')))
        .slice(0, 8)
        .map((x: any) => ({ url: String(x.url).replace(/\/$/, ''), region: String(x.region), maxInstances: n(x.maxInstances, 1, 20, d.cloudrunCpu.maxInstances) })),
    },
    runpod: (() => {
      const r: Partial<Settings['playtest']['runpod']> = t?.runpod ?? {};
      // A RunPod load-balancer endpoint, a RunPod Pod's HTTP proxy (the same image on a Pod), or the container on this machine.
      const url = typeof r.url === 'string' && (/^https:\/\/[a-z0-9]+\.api\.runpod\.ai\/?$/.test(r.url) || /^https:\/\/[a-z0-9]+-\d{2,5}\.proxy\.runpod\.net\/?$/.test(r.url) || /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(r.url)) ? r.url.replace(/\/$/, '') : null;
      const price = Number(r.pricePerHour);
      return {
        ...service(r, d.runpod),
        url,
        gpu: typeof r.gpu === 'string' && /^[A-Za-z0-9 ._-]{1,60}$/.test(r.gpu) ? r.gpu : d.runpod.gpu,
        pricePerHour: Number.isFinite(price) && price >= 0 && price <= 20 ? price : d.runpod.pricePerHour,
        idleSeconds: Math.max(5, Math.min(3600, Math.round(Number(r.idleSeconds)) || d.runpod.idleSeconds)),
      };
    })(),
    runners: cleanRunners(t?.runners),
  };
}

/** settings.playtest.runners, checked: known providers and targets, https URLs (a local one for the runner beside Gen), sane numbers. */
export function cleanRunners(list: unknown): PlaytestRunner[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: PlaytestRunner[] = [];
  for (const r of list.slice(0, 32) as any[]) {
    const id = String(r?.id ?? '');
    if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(id) || seen.has(id)) continue;
    if (!['runpod', 'cloudrun', 'cloudrun-cpu', 'native'].includes(r?.provider)) continue;
    const url = typeof r.url === 'string' && (/^https:\/\/[a-z0-9.-]+(:\d{2,5})?\/?$/.test(r.url) || /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(r.url)) ? r.url.replace(/\/$/, '') : null;
    if (r.provider === 'native' && !url) continue;
    const targets = (Array.isArray(r.targets) ? r.targets : []).filter((x: unknown) => PLAYTEST_TARGETS.includes(x as PlaytestTarget)) as PlaytestTarget[];
    if (!targets.length) continue;
    const lanes = (Array.isArray(r.lanes) ? r.lanes : ['studio', 'customer']).filter((x: unknown) => x === 'studio' || x === 'customer') as PlaytestRunner['lanes'];
    const price = Number(r.pricePerSecond);
    seen.add(id);
    out.push({
      id, provider: r.provider, url, targets: [...new Set(targets)], lanes: lanes.length ? [...new Set(lanes)] : ['studio'],
      pricePerSecond: Number.isFinite(price) && price >= 0 && price <= 0.1 ? price : 0,
      maxConcurrent: Math.max(1, Math.min(200, Math.round(Number(r.maxConcurrent)) || 1)),
      tokenEnv: typeof r.tokenEnv === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(r.tokenEnv) ? r.tokenEnv : null,
      gatewayKeyEnv: typeof r.gatewayKeyEnv === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(r.gatewayKeyEnv) ? r.gatewayKeyEnv : null,
      enabled: r.enabled !== false,
    });
  }
  return out;
}
export const FLEET_MAX = 16;

const NAME = /^[a-z0-9][a-z0-9._:-]{0,62}$/;
/** settings.gpu, checked: only known backends, family and service names, https Cloud Run URLs. */
function cleanGpu(g: Partial<Settings['gpu']> | undefined): Settings['gpu'] {
  const be = (v: unknown): 'fleet' | 'cloudrun' | null => (v === 'cloudrun' ? 'cloudrun' : v === 'fleet' ? 'fleet' : null);
  const families: Record<string, 'fleet' | 'cloudrun'> = {};
  for (const [k, v] of Object.entries(g?.families ?? {})) if (NAME.test(k) && be(v)) families[k] = be(v)!;
  const urls: Record<string, string> = {};
  for (const [k, v] of Object.entries(g?.cloudrun?.urls ?? {})) if (NAME.test(k) && typeof v === 'string' && /^https:\/\/[a-z0-9.-]+\/?$/.test(v)) urls[k] = v.replace(/\/$/, '');
  const services: Record<string, string> = {};
  for (const [k, v] of Object.entries(g?.cloudrun?.services ?? {})) if (NAME.test(k) && typeof v === 'string' && NAME.test(v)) services[k] = v;
  const b = g?.cloudrun?.bucket;
  return {
    backend: be(g?.backend) ?? 'fleet',
    families,
    cloudrun: { bucket: typeof b === 'string' && /^[a-z0-9][a-z0-9._-]{2,62}$/.test(b) ? b : null, urls, services },
    ...cleanProviders(g),
  };
}

/** settings.gpu's providers and order, checked: known provider kinds, https URLs, sane numbers, ids that exist. */
export function cleanProviders(g: Partial<Settings['gpu']> | undefined): Pick<Settings['gpu'], 'providers' | 'order' | 'familyOrder'> {
  const n = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const providers: GpuEndpoint[] = [];
  for (const p of Array.isArray(g?.providers) ? g!.providers : []) {
    const id = String(p?.id ?? '').trim();
    if (!NAME.test(id) || id === 'fleet' || id === 'cloudrun' || providers.some((x) => x.id === id)) continue;
    if (!['runpod', 'modal', 'http'].includes(String(p?.provider))) continue;
    const url = String(p?.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(url)) continue;
    const families = (Array.isArray(p.families) ? p.families : ['*']).map(String).filter((x) => x === '*' || NAME.test(x));
    providers.push({
      id, provider: p.provider, url, families: families.length ? families : ['*'],
      gpu: String(p.gpu ?? '').trim().slice(0, 40) || 'gpu',
      pricePerHour: n(p.pricePerHour, 0, 100, 0), maxConcurrent: Math.round(n(p.maxConcurrent, 1, 64, 1)),
      graphLimitSeconds: Math.round(n(p.graphLimitSeconds, 60, 86_400, p.provider === 'runpod' ? RUNPOD_GRAPH_SECONDS : 3300)), enabled: p.enabled !== false,
    });
  }
  const known = new Set(['fleet', 'cloudrun', ...providers.map((p) => p.id)]);
  const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => known.has(x)))];
  const familyOrder: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(g?.familyOrder ?? {})) if (NAME.test(k) && list(v).length) familyOrder[k] = list(v);
  return { providers, order: list(g?.order), familyOrder };
}

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
      egressIp: /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s.fleet?.egressIp ?? '').trim()) ? String(s.fleet!.egressIp).trim() : '',
      openComfyPort: s.fleet?.openComfyPort === true,
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
      perProjectLane: n(s.queue?.perProjectLane, 1, 64, SETTINGS_DEFAULTS.queue.perProjectLane),
      projects: Array.isArray(s.queue?.projects) ? s.queue!.projects.map(String).filter(Boolean).slice(0, 50) : SETTINGS_DEFAULTS.queue.projects,
    },
    platform: {
      issuer: typeof s.platform?.issuer === 'string' && /^https?:\/\/[^\s]+$/.test(s.platform.issuer) ? s.platform.issuer : '',
      freeOrgs: Array.isArray(s.platform?.freeOrgs) ? s.platform!.freeOrgs.map(String).filter((o) => /^org_[0-9a-f]{8,32}$/.test(o)).slice(0, 200) : [],
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
    unityBuild: cleanUnityBuild(s.unityBuild),
    storage: {
      bucket: typeof s.storage?.bucket === 'string' && /^[a-z0-9][a-z0-9.-]{2,62}$/.test(s.storage.bucket) ? s.storage.bucket : null,
      provider: s.storage?.provider === 'gcs' ? 'gcs' : 's3',
      cdn: typeof s.storage?.cdn === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(s.storage.cdn) ? s.storage.cdn : null,
      cdnProjects: Array.isArray(s.storage?.cdnProjects) ? [...new Set(s.storage!.cdnProjects.map(String).filter((p) => /^(\*|[A-Za-z0-9._-]{1,64}\*?)$/.test(p)))] : ['*'],
    },
    gpu: cleanGpu(s.gpu),
    playtest: cleanPlaytest(s.playtest),
    cpu: cleanCpu(s.cpu),
    dashboard: cleanDashboard(s.dashboard),
  };
}

/** Which backend a unity.build / unity.test job runs on: its `backend` param, else its project's, else the default. */
export function unityBackendOf(params: { backend?: unknown; project?: unknown } | undefined, u: Settings['unityBuild']): UnityBackend {
  const b = params?.backend;
  if (isUnityBackend(b)) return b;
  const own = typeof params?.project === 'string' ? u.projects[params.project.replace(/\\/g, '/')] : undefined;
  return own ?? u.backend;
}

function cleanUnityBuild(u: Partial<Settings['unityBuild']> | undefined): Settings['unityBuild'] {
  const d = SETTINGS_DEFAULTS.unityBuild;
  const n = (v: unknown, lo: number, hi: number, def: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || def));
  const g = { ...d.gcp, ...(u?.gcp ?? {}) };
  const vm = { ...d.vm, ...(u?.vm ?? {}) };
  const word = (v: unknown, re: RegExp, def: string) => (typeof v === 'string' && re.test(v) ? v : def);
  return {
    backend: isUnityBackend(u?.backend) ? u!.backend : 'builder',
    timeoutMinutes: n(u?.timeoutMinutes, 10, 180, d.timeoutMinutes),
    cleanAfterFailures: n(u?.cleanAfterFailures, 1, 10, d.cleanAfterFailures),
    concurrency: n(u?.concurrency, 1, 8, d.concurrency),
    vmAt: u?.vmAt !== undefined && Number.isFinite(Number(u.vmAt)) ? Math.max(0, Math.min(1, Number(u.vmAt))) : d.vmAt,
    projects: Object.fromEntries(Object.entries(u?.projects ?? {}).filter(([k, v]) => /^[A-Za-z0-9._/-]{1,80}$/.test(k) && isUnityBackend(v))) as Record<string, UnityBackend>,
    vm: {
      zone: word(vm.zone, /^[a-z]+-[a-z]+\d+-[a-z]$/, d.vm.zone),
      machineType: word(vm.machineType, /^[a-z0-9]+-[a-z0-9-]+$/, d.vm.machineType),
      pricePerHour: Math.max(0, Math.min(10, Number(vm.pricePerHour) || d.vm.pricePerHour)),
    },
    gcp: {
      project: word(g.project, /^[a-z][a-z0-9-]{4,29}$/, ''),
      region: word(g.region, /^[a-z]+-[a-z]+\d+$/, d.gcp.region),
      job: word(g.job, /^[a-z][a-z0-9-]{0,48}$/, d.gcp.job),
      bucket: word(g.bucket, /^[a-z0-9][a-z0-9._-]{2,62}$/, ''),
      unity: word(g.unity, /^\d{4}\.\d+\.\d+[abfp]\d+$/, d.gcp.unity),
      cpu: [4, 8].includes(Number(g.cpu)) ? Number(g.cpu) : d.gcp.cpu,
      memoryGiB: n(g.memoryGiB, 4, 32, d.gcp.memoryGiB),
      images: Object.fromEntries(Object.entries(g.images && typeof g.images === 'object' ? g.images : {})
        .filter(([k, v]) => /^\d{4}\.\d+\.\d+[abfp]\d+$/.test(k) && typeof v === 'string' && /^[a-z][a-z0-9-]{0,48}$/.test(v))) as Record<string, string>,
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
    return clean({ ...SETTINGS_DEFAULTS, ...raw, fleet: { ...SETTINGS_DEFAULTS.fleet, ...raw.fleet }, concurrency: { ...SETTINGS_DEFAULTS.concurrency, ...raw.concurrency }, claude: { ...SETTINGS_DEFAULTS.claude, ...raw.claude }, rates: { ...SETTINGS_DEFAULTS.rates, ...raw.rates }, audio: { ...SETTINGS_DEFAULTS.audio, ...raw.audio }, gpu: { ...SETTINGS_DEFAULTS.gpu, ...raw.gpu }, unityBuild: { ...SETTINGS_DEFAULTS.unityBuild, ...raw.unityBuild }, playtest: { ...SETTINGS_DEFAULTS.playtest, ...raw.playtest, cloudrun: { ...SETTINGS_DEFAULTS.playtest.cloudrun, ...raw.playtest?.cloudrun }, cloudrunCpu: { ...SETTINGS_DEFAULTS.playtest.cloudrunCpu, ...raw.playtest?.cloudrunCpu }, runpod: { ...SETTINGS_DEFAULTS.playtest.runpod, ...raw.playtest?.runpod } }, cpu: { ...SETTINGS_DEFAULTS.cpu, ...raw.cpu, cloudrun: { ...SETTINGS_DEFAULTS.cpu.cloudrun, ...raw.cpu?.cloudrun } }, dashboard: { ...SETTINGS_DEFAULTS.dashboard, ...raw.dashboard } });
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
    storage: { ...cur.storage, ...(patch.storage ?? {}) },
    gpu: patch.gpu ? { ...cur.gpu, ...patch.gpu, families: { ...cur.gpu.families, ...(patch.gpu.families ?? {}) }, cloudrun: { ...cur.gpu.cloudrun, ...(patch.gpu.cloudrun ?? {}), urls: { ...cur.gpu.cloudrun.urls, ...(patch.gpu.cloudrun?.urls ?? {}) }, services: { ...cur.gpu.cloudrun.services, ...(patch.gpu.cloudrun?.services ?? {}) } } } : cur.gpu,
    unityBuild: { ...cur.unityBuild, ...(patch.unityBuild ?? {}), gcp: { ...cur.unityBuild.gcp, ...(patch.unityBuild?.gcp ?? {}) }, vm: { ...cur.unityBuild.vm, ...(patch.unityBuild?.vm ?? {}) } },
    playtest: { ...cur.playtest, ...(patch.playtest ?? {}), projects: { ...cur.playtest.projects, ...(patch.playtest?.projects ?? {}) }, cloudrun: { ...cur.playtest.cloudrun, ...(patch.playtest?.cloudrun ?? {}) }, cloudrunCpu: { ...cur.playtest.cloudrunCpu, ...(patch.playtest?.cloudrunCpu ?? {}) }, runpod: { ...cur.playtest.runpod, ...(patch.playtest?.runpod ?? {}) }, runners: patch.playtest?.runners ?? cur.playtest.runners },
    cpu: { ...cur.cpu, ...(patch.cpu ?? {}), tools: { ...cur.cpu.tools, ...(patch.cpu?.tools ?? {}) }, cloudrun: { ...cur.cpu.cloudrun, ...(patch.cpu?.cloudrun ?? {}), urls: { ...cur.cpu.cloudrun.urls, ...(patch.cpu?.cloudrun?.urls ?? {}) } } },
    dashboard: { ...cur.dashboard, ...(patch.dashboard ?? {}) },
  });
  fs.writeFileSync(paths.settings, JSON.stringify(next, null, 2));
  return next;
}
