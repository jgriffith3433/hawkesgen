// Playtests on the GPU fleet: the control server has no GPU, so games there render in software at a few fps.
// A GPU server runs a Playwright browser server (Chromium drawing with the NVIDIA GPU through ANGLE/EGL); the
// playtest connects to it through an SSH tunnel, and local builds on this machine are tunneled back, so a game at
// http://localhost:8089 opens on the GPU server as if it were local.
//
// The browser server is installed on a GPU server the first time it's needed (Node + the same Playwright version as
// Hawkes Gen, ~2 minutes) and started as a transient systemd unit. Nothing here touches ComfyUI.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { sshRun, sshTarget, comfyEndpoints } from './fleet.ts';
import { paths } from '../../config.ts';
import { claimPlaytester, ssh as playtesterSsh } from '../playtester/playtester.ts';
import type { CloudPlaytest } from '../playtester/cloudrun.ts';

export const PW_VERSION = JSON.parse(fs.readFileSync(path.join(paths.server, '..', 'node_modules', 'playwright', 'package.json'), 'utf8')).version as string;
export const NODE_URL = 'https://nodejs.org/dist/v24.13.1/node-v24.13.1-linux-x64.tar.xz';
const PORT = 3600;

/** Chromium on Linux with the NVIDIA GPU (ANGLE on EGL). */
export const GPU_LINUX_ARGS = ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio'];

const ready = new Set<string>();

/** Installs (once) and starts the browser server on a GPU server. */
export async function ensurePlaytestHost(instanceId: string, step: (s: string) => void = () => {}) {
  // The server's idle stop only watches ComfyUI; a playtest counts as activity too.
  await sshRun('for d in /var/lib/dod /var/lib/gen; do [ -d $d ] && sudo touch $d/last_busy; done; true', instanceId).catch(() => {});
  if (ready.has(instanceId)) {
    const up = (await sshRun(`ss -ltn | grep -q ':${PORT} ' && echo up || echo down`, instanceId).catch(() => 'down')).trim();
    if (up === 'up') return;
  }
  const installed = (await sshRun(`test -f /opt/hawkes-pw/node_modules/playwright/package.json && grep -q '"version": "${PW_VERSION}"' /opt/hawkes-pw/node_modules/playwright/package.json && echo yes || echo no`, instanceId)).trim();
  if (installed !== 'yes') {
    step(`installing the playtest browser on the GPU server (Playwright ${PW_VERSION}, once)`);
    await sshRun([
      'set -e',
      `test -x /opt/hawkes-node/bin/node || (sudo mkdir -p /opt/hawkes-node && curl -fsSL ${NODE_URL} | sudo tar -xJ --strip-components=1 -C /opt/hawkes-node)`,
      'sudo mkdir -p /opt/hawkes-pw && sudo chown ubuntu:ubuntu /opt/hawkes-pw',
      'cd /opt/hawkes-pw && export PATH=/opt/hawkes-node/bin:$PATH',
      `npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error playwright@${PW_VERSION}`,
      'sudo env PATH=$PATH npx playwright install-deps chromium >/tmp/pw-deps.log 2>&1',
      'npx playwright install chromium chromium-headless-shell >/tmp/pw.log 2>&1',
      'echo installed',
    ].join(' && '), instanceId, { timeoutMs: 15 * 60_000 });
  }
  // run-server ignores per-connection launch options (Chromium then renders in software), so the server is started with
  // the GPU flags baked in (launchServer). A browser server left over from the old run-server is replaced.
  const script = [
    "import { chromium } from '/opt/hawkes-pw/node_modules/playwright/index.mjs';",
    `const server = await chromium.launchServer({ headless: true, args: ${JSON.stringify(GPU_LINUX_ARGS)}, host: '127.0.0.1', port: ${PORT}, wsPath: '/' });`,
    "server.process().on('exit', () => process.exit(1));",
  ].join(String.fromCharCode(10));
  await sshRun(`printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > /opt/hawkes-pw/server.mjs && (pgrep -f 'cli.js run-server' >/dev/null && sudo systemctl stop hawkes-playwright 2>/dev/null; true) && (ss -ltn | grep -q ':${PORT} ' || sudo systemd-run --unit hawkes-playwright --uid ubuntu --setenv=HOME=/home/ubuntu --setenv=PATH=/opt/hawkes-node/bin:/usr/bin:/bin /opt/hawkes-node/bin/node /opt/hawkes-pw/server.mjs); sleep 3; ss -ltn | grep -q ':${PORT} ' && echo up`, instanceId);
  ready.add(instanceId);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export type PlaytestHost = {
  wsEndpoint: string; server: string; close(): void;
  /** The playtester it runs on (null on a GPU fleet server), and the lanes it holds there until close(). */ playtester: string | null;
  /** The URL as the GPU server's browser must open it (local ports are tunneled to their own remote port). */ mapUrl(url: string): string;
  /** How to reach the machine over SSH (still usable after close(): the playtest video is encoded there). Null on Cloud Run. */ ssh: { args: string[]; dest: string } | null;
  /** The runner it plays on (settings.playtest.runners), when the router chose it. */ runner?: string | null;
  /** Where it runs. */ backend?: 'ec2' | 'fleet' | 'cloudrun' | 'cloudrun-cpu' | 'runpod' | 'modal';
  /** Set when the browser has no GPU (the Cloud Run CPU service): why, for the result's softwareBecause. */ software?: string | null;
  /** How much slower than a GPU browser to allow for (the boot wait and the default scenario limit): 1 on a GPU. */ slow?: number;
  /** A browser already connected (Cloud Run: a pool with a connection per tab); else playtest.ts connects to wsEndpoint. */ browser?: any;
  /** Added to every browser context's options (Cloud Run with a local page: service workers off, so routing sees every request). */ contextOptions?: Record<string, unknown>;
  /** Run on every new context before its page opens (Cloud Run: local origins served from here through the connection). */ prepareContext?(context: any): Promise<void>;
  /** Encodes the screencast's MJPEG where the browser ran (Cloud Run: the service's /encode); returns the encoder. */ encode?(mjpeg: string, out: string, viewport: { width: number; height: number }, signal: AbortSignal): Promise<string>;
};

/** How long a game waits for a RunPod worker from zero before software WebGL: a new machine pulls the ~1 GB image
 *  and may fetch the driver's graphics libraries (docs/playtest-runpod.md), which has taken over 5 minutes. */
export const GPU_COLD_START_MS = 12 * 60_000;

/**
 * How long one try at a browser service may wait (undefined: connectOne's own default). RunPod gets its whole cold start
 * on the first round (a game: GPU_COLD_START_MS, since a game played in software is inconclusive; a site crawl: 5
 * minutes); with more than one service, the others and later rounds get 40 s each (a full region is skipped, not waited on).
 */
export function connectWaitMs(cloud: { variant?: string }, round: number, { many, game }: { many: boolean; game: boolean }): number | undefined {
  if ((cloud.variant === 'runpod' || cloud.variant === 'modal') && round === 1) return game ? GPU_COLD_START_MS : many ? 5 * 60_000 : undefined;
  return many ? 40_000 : undefined;
}

/**
 * How long a GPU browser provider is skipped after it failed us, when it isn't a router's runner (null: not at all).
 * Out of credit or refusing our key: the runner cooldowns. A RunPod or Modal gateway that held every handshake for the
 * whole cold-start wait and never gave a browser (2026-11-02: Modal timed out at connect on every playtest for hours,
 * each one waiting 12 minutes before software WebGL): 30 minutes, so the playtests after it go to the next provider at
 * once and one run tries the provider again when the cooldown ends. Only the first round's full wait counts: a later
 * round's short try (40 s) timing out says nothing about the provider.
 */
export const GATEWAY_STUCK_COOLDOWN_MS = 30 * 60_000;
export function providerCooldownMs(cloud: { variant?: string; runner?: string }, why: string, { refusedForMoney, runnerCooldown, round = 1 }: { refusedForMoney: (w: string) => boolean; runnerCooldown: (w: string) => number; round?: number }): number | null {
  if (cloud.runner || !cloud.variant || cloud.variant === 'cpu') return null;
  if (refusedForMoney(why) || /\b(401|403)\b|Unauthorized|Forbidden/i.test(why)) return runnerCooldown(refusedForMoney(why) ? '401' : why);
  if (round === 1 && (cloud.variant === 'runpod' || cloud.variant === 'modal') && /Timeout \d+ ?ms exceeded/i.test(why)) return GATEWAY_STUCK_COOLDOWN_MS;
  return null;
}

/** A run in software says why no GPU browser played it (the CPU service's own note after the reasons). */
export const softwareWhy = (base: string, passedOver: string[]) => `no GPU browser (${passedOver.join('; ')}), so it ${base}`.slice(0, 600);

/**
 * The GPU browser for a playtest: Cloud Run when settings.playtest says so for this project and the service is
 * deployed (docs/playtest-cloudrun.md), else, or when Cloud Run can't be reached, the playtesters and GPU servers as
 * before (openPlaytestHost). Null when no GPU browser is ready.
 */
export async function openGpuHost(pageUrl: string, step: (s: string) => void = () => {}, { startPlaytester = false, game = false, tabs = 1, project, job, onUsage, clouds: given, fallback = true, site, passedOver: before = [], signal }: {
  startPlaytester?: boolean; tabs?: number; project?: string | null; job?: string; onUsage?: (u: { provider: string; unit: string; amount: number; cost?: number; detail?: string }) => void;
  /** A game (not a site crawl): software WebGL tells nothing about it, so RunPod gets a longer cold start (GPU_COLD_START_MS). */ game?: boolean;
  /** Why the runner router already left GPU runners out (runners.ts skipped): said again when the run lands in software. */ passedOver?: string[];
  /** The browser services to try, in order (the runner router's choice); else this project's from settings.playtest. */ clouds?: CloudPlaytest[];
  /** false: when none of them has a browser, null instead of the playtesters (customers' runs, builds the service serves). */ fallback?: boolean;
  /** A build each service serves itself (cloudrun.ts siteHeader). */ site?: string;
  /** The job's: once cancelled, no further service is tried and no worker is waited for. */ signal?: AbortSignal;
} = {}): Promise<PlaytestHost | null> {
  const { cloudPlaytestsFor, openCloudPlaytestHost, localPortsOf, providerDown, providerHealthKey, refusedForMoney } = await import('../playtester/cloudrun.ts');
  const { loadSettings } = await import('../../config.ts');
  const { markDown } = await import('../gpu/health.ts');
  const { runnerHealthKey, runnerCooldown } = await import('../playtester/runners.ts');
  const { runpodCreditProblem, recheckEmptyRunpodCredit } = await import('../gpu/credit.ts');
  const listed = given ?? (() => {
    try {
      return cloudPlaytestsFor(project, loadSettings());
    } catch (e: any) {
      step(`Cloud Run playtests aren't set up right (${e.message}); using the playtesters`);
      return [];
    }
  })();
  // Why each GPU browser was passed over, for the result when the run ends up in software (Studio shows it).
  const passedOver = [...before];
  // An empty RunPod balance starts no browser and its gateway just waits (gpu/credit.ts): the next service plays it.
  // An empty reading is read again first, so funds added a moment ago count now.
  const hasRunpod = listed.some((c) => c.variant === 'runpod');
  if (hasRunpod) await recheckEmptyRunpodCredit();
  const broke = hasRunpod ? runpodCreditProblem() : null;
  if (broke) {
    step(`skipping RunPod: ${broke}`);
    passedOver.push(`RunPod skipped: ${broke}`);
  }
  // A provider that refused us a moment ago (Modal out of credit, a bad token) cools down: the next one plays.
  const clouds = (broke ? listed.filter((c) => c.variant !== 'runpod') : listed).filter((c) => {
    const down = c.variant !== 'cpu' ? providerDown(c) : null;
    if (down) {
      step(`skipping ${c.name}: ${down.reason}`);
      passedOver.push(`${c.name} skipped: ${down.reason}`);
    }
    return !down;
  });
  // In order: the GPU browser (the RunPod endpoint, docs/playtest-runpod.md, or the L4 service), then the CPU service
  // (software WebGL) in each of its regions, then the playtesters. Each
  // step says why it moved on. With more than one service, each try is short (a full region is skipped, not waited on)
  // and the list is gone round again until one has room, for up to 6 minutes, as one service alone would wait.
  const many = clouds.length > 1;
  const end = Date.now() + 6 * 60_000;
  for (let round = 1; clouds.length; round++) {
    for (const [i, cloud] of clouds.entries()) {
      if (signal?.aborted) throw new Error('cancelled while opening the browser');
      try {
        // RunPod gets its full wait on the first round: its cold start pulls the image on a new machine (minutes), and
        // moving on to software WebGL would leave the worker it started idle.
        const wait = connectWaitMs(cloud, round, { many, game });
        const host = await openCloudPlaytestHost(cloud, { pageUrl, tabs, job, site, step, onUsage, signal, ...(wait ? { connectTimeoutMs: wait } : {}) });
        return host.software && passedOver.length ? { ...host, software: softwareWhy(host.software, passedOver) } : host;
      } catch (e: any) {
        if (signal?.aborted) throw e;
        const why = String(e?.message ?? e);
        if (cloud.variant !== 'cpu') passedOver.push(`${cloud.name}: ${why.split('\n')[0].slice(0, 160)}`);
        // A router's runner that refused us cools down (runners.ts), so the next runs go elsewhere first.
        if (cloud.runner && round === 1 && !/Build Failed/.test(why)) markDown(runnerHealthKey(cloud.runner), why.slice(0, 200), runnerCooldown(why));
        // A provider out of credit or refusing our key cools down too when it isn't a router's runner, so the next
        // playtests go straight to the next provider (RunPod's balance is read on its own: gpu/credit.ts).
        // A gateway that held every handshake through the whole cold-start wait cools down as well (providerCooldownMs).
        else {
          const ms = providerCooldownMs(cloud, why, { refusedForMoney, runnerCooldown, round });
          if (ms) markDown(providerHealthKey(cloud.variant), why.slice(0, 200), ms);
        }
        const nxt = clouds[i + 1] ?? (many && Date.now() < end ? clouds[0] : null);
        step(`no browser on ${cloud.name} in ${cloud.region} (${why.slice(0, 200)}); ${nxt ? `trying ${nxt.name} in ${nxt.region}${nxt.variant === 'cpu' ? ' (software WebGL)' : ''}` : fallback ? 'using the playtesters' : 'no other runner'}`);
      }
    }
    if (!many || Date.now() >= end) break;
  }
  if (!fallback || signal?.aborted) return null;
  return openPlaytestHost(localPortsOf(pageUrl), step, { startPlaytester, tabs });
}

/**
 * A browser on a GPU machine (a playtester with room first, else a GPU fleet server): ensures the host, opens the tunnel
 * (and reverse tunnels for local game ports) and returns the endpoint for chromium.connect. A playtester's lanes (tabs:
 * the players in the playtest) are held until close(). Null when no GPU server is ready.
 */
export async function openPlaytestHost(localPorts: number[], step: (s: string) => void = () => {}, { startPlaytester = false, tabs = 1 } = {}): Promise<PlaytestHost | null> {
  // A playtester (a small T4 machine that only plays games) with room, else a ready GPU fleet server.
  let ep: { id: string; region: string };
  let sshArgs: string[];
  let dest: string;
  // Games need a GPU to be judged: J's rule is that any game playtest starts a playtester when the running ones are
  // full or off (about $0.53/hr each; they power off after their idle time). Static-site crawls don't ask for this.
  const claim = await claimPlaytester(tabs, { start: startPlaytester, onStep: step }).catch((e: any) => {
    step(`no playtester (${e.message}); trying a GPU server`);
    return null;
  });
  const pt = claim?.target ?? null;
  let released = false;
  const release = () => { if (!released) { released = true; claim?.release(); } };
  if (pt) {
    ep = pt;
    sshArgs = pt.args;
    dest = `${pt.user}@${pt.ip}`;
    await playtesterSsh('touch /var/lib/hawkes/last_busy', { id: pt.id, timeoutMs: 30_000 }).catch(() => {});
  } else {
    const eps = await comfyEndpoints().catch(() => []);
    if (!eps.length) return null;
    ep = eps[0];
    await ensurePlaytestHost(ep.id, step);
    const { ip, key } = await sshTarget(ep.id);
    sshArgs = ['-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
    dest = `ubuntu@${ip}`;
  }
  const local = await freePort();
  // Each local game port gets its own random port on the GPU server, so concurrent playtests of the same site don't collide.
  const remote = new Map(localPorts.map((p) => [p, 20000 + Math.floor(Math.random() * 20000)]));
  const args = [...sshArgs, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-N',
    '-L', `${local}:127.0.0.1:${PORT}`, ...[...remote].flatMap(([p, r]) => ['-R', `${r}:127.0.0.1:${p}`]), dest];
  const child: ChildProcess = spawn('ssh', args, { windowsHide: true, stdio: 'ignore' });
  // Wait for the tunnel.
  const end = Date.now() + 20_000;
  for (;;) {
    const ok = await new Promise<boolean>((r) => {
      const sock = net.connect(local, '127.0.0.1', () => { sock.destroy(); r(true); });
      sock.on('error', () => r(false));
    });
    if (ok) break;
    if (Date.now() > end || child.exitCode !== null) {
      child.kill();
      release();
      throw new Error(`Couldn't open the tunnel to ${pt ? 'the playtester' : 'the GPU server'} ${ep.id}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const mapUrl = (url: string) => {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) && remote.has(port)) u.port = String(remote.get(port));
    return u.toString();
  };
  return { wsEndpoint: `ws://127.0.0.1:${local}/`, server: `${ep.id} (${ep.region})`, playtester: pt?.id ?? null, close: () => { child.kill(); release(); }, mapUrl, ssh: { args: sshArgs, dest }, backend: pt ? 'ec2' : 'fleet' };
}
