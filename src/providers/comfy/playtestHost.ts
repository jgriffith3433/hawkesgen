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
  /** Where it runs. */ backend?: 'ec2' | 'fleet' | 'cloudrun';
  /** A browser already connected (Cloud Run: a pool with a connection per tab); else playtest.ts connects to wsEndpoint. */ browser?: any;
  /** Added to every browser context's options (Cloud Run with a local page: service workers off, so routing sees every request). */ contextOptions?: Record<string, unknown>;
  /** Run on every new context before its page opens (Cloud Run: local origins served from here through the connection). */ prepareContext?(context: any): Promise<void>;
  /** Encodes the screencast's MJPEG where the browser ran (Cloud Run: the service's /encode); returns the encoder. */ encode?(mjpeg: string, out: string, viewport: { width: number; height: number }, signal: AbortSignal): Promise<string>;
};

/**
 * The GPU browser for a playtest: Cloud Run when settings.playtest says so for this project and the service is
 * deployed (docs/playtest-cloudrun.md), else, or when Cloud Run can't be reached, the playtesters and GPU servers as
 * before (openPlaytestHost). Null when no GPU browser is ready.
 */
export async function openGpuHost(pageUrl: string, step: (s: string) => void = () => {}, { startPlaytester = false, tabs = 1, project, job, onUsage }: { startPlaytester?: boolean; tabs?: number; project?: string | null; job?: string; onUsage?: (u: { provider: string; unit: string; amount: number; cost?: number; detail?: string }) => void } = {}): Promise<PlaytestHost | null> {
  const { cloudPlaytestFor, openCloudPlaytestHost, localPortsOf } = await import('../playtester/cloudrun.ts');
  const { loadSettings } = await import('../../config.ts');
  const cloud = (() => {
    try {
      return cloudPlaytestFor(project, loadSettings());
    } catch (e: any) {
      step(`Cloud Run playtests aren't set up right (${e.message}); using the playtesters`);
      return null;
    }
  })();
  if (cloud) {
    try {
      return await openCloudPlaytestHost(cloud, { pageUrl, tabs, job, step, onUsage });
    } catch (e: any) {
      step(`no Cloud Run browser (${String(e?.message ?? e).slice(0, 200)}); using the playtesters`);
    }
  }
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
