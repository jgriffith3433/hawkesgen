// The runner router (hawkesstudio docs/platform-plan.md 3.3, docs/playtest-runners.md): where a playtest plays, by its
// target. settings.playtest.runners lists runners in order, each with the targets it plays, whose builds it takes
// (`lanes`: studio, customer), a price and a cap; runnerCandidates gives a job the ones it may use now, first with room
// first, like gpuCandidates (src/providers/gpu/route.ts). A runner that refused us cools down (gpu/health.ts, keyed
// `runner:<id>`), a runner this job already failed on is skipped, and a full one is skipped while others have room.
//
// With no runners set, web runs keep today's order (settings.playtest.backend: RunPod, the L4 service, the CPU service,
// as cloudPlaytestsFor says) as implicit entries, and desktop targets have nowhere to play.
import type { PlaytestRunner, PlaytestTarget, Settings } from '../../config.ts';
import { env } from '../../config.ts';
import { isDown } from '../gpu/health.ts';
import { runpodCreditProblem } from '../gpu/credit.ts';
import { cloudPlaytestsFor, runpodPlaytest, modalPlaytest, providerOfVariant, loadSpec, SPEC_FILE, specPricePerSecond, CPU_SOFTWARE_WHY, type CloudPlaytest, type ServiceSpec } from './cloudrun.ts';

export type Lane = 'studio' | 'customer';
export type RunnerChoice =
  | { kind: 'browser'; runner: PlaytestRunner; cloud: CloudPlaytest }
  | { kind: 'native'; runner: PlaytestRunner; url: string; token: string | null; gatewayKey: string | null };
export type RunnerCandidates = { choices: RunnerChoice[]; skipped: string[] };

/** Targets a browser runner plays (Playwright over a connection: pages). Electron apps and desktop builds are launched on
 *  the runner's machine, so they need a native runner (which drives Electron with Playwright there). */
export const BROWSER_TARGETS: readonly PlaytestTarget[] = ['web'];
export const isNativeTarget = (t: PlaytestTarget) => !BROWSER_TARGETS.includes(t);

const cooldownKey = (id: string) => `runner:${id}`;

// Runs in progress per runner (this process is the only conductor: Gen runs one instance).
const active = new Map<string, number>();
export const activeOn = (id: string) => active.get(id) ?? 0;
/** Holds a slot on a runner until the returned release is called (once). */
export function claimRunner(id: string): () => void {
  active.set(id, activeOn(id) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active.set(id, Math.max(0, activeOn(id) - 1));
  };
}
/** Tests start clean. */
export const resetRunners = () => active.clear();

const variantOf = (p: PlaytestRunner['provider']) => (p === 'runpod' ? 'runpod' : p === 'modal' ? 'modal' : p === 'cloudrun-cpu' ? 'cpu' : 'gpu');

/**
 * The runners that apply: the settings' list, plus today's browser services as implicit web runners whenever that list
 * plays no web pages itself (so adding a desktop runner never takes websites' playtests away).
 */
export function runnersFor(project: string | null | undefined, settings: Pick<Settings, 'playtest'>, specs: { gpu?: ServiceSpec; cpu?: ServiceSpec } = {}): { runner: PlaytestRunner; cloud?: CloudPlaytest }[] {
  const listed = (settings.playtest.runners ?? []).map((runner) => ({ runner }));
  if (listed.some(({ runner }) => runner.targets.includes('web'))) return listed;
  return [...listed, ...implicitWebRunners(project, settings, specs)];
}

function implicitWebRunners(project: string | null | undefined, settings: Pick<Settings, 'playtest'>, specs: { gpu?: ServiceSpec; cpu?: ServiceSpec }): { runner: PlaytestRunner; cloud?: CloudPlaytest }[] {
  let clouds: CloudPlaytest[] = [];
  try {
    clouds = cloudPlaytestsFor(project, settings, specs);
  } catch {
    clouds = [];
  }
  return clouds.map((cloud) => ({
    cloud,
    runner: {
      id: `${providerOfVariant(cloud.variant)}${cloud.region && cloud.region !== 'RunPod' && cloud.region !== 'Modal' ? `-${cloud.region}` : ''}`,
      provider: providerOfVariant(cloud.variant),
      url: cloud.url, targets: ['web'], lanes: ['studio', 'customer'],
      pricePerSecond: cloud.pricePerSecond / Math.max(1, cloud.tabsPerInstance), maxConcurrent: cloud.maxInstances * cloud.tabsPerInstance,
      tokenEnv: null, enabled: true,
    },
  }));
}

/** A browser runner entry as the browser service playtest.run connects to: its settings' service, with the entry's URL, price and cap. */
export function browserService(r: PlaytestRunner, settings: Pick<Settings, 'playtest'>, specs: { gpu?: ServiceSpec; cpu?: ServiceSpec } = {}): CloudPlaytest | null {
  const t = settings.playtest;
  const v = variantOf(r.provider);
  let base: CloudPlaytest;
  if (v === 'runpod') {
    const url = r.url ?? t.runpod.url;
    if (!url) return null;
    base = runpodPlaytest({ ...t.runpod, url });
  } else if (v === 'modal') {
    const url = r.url ?? t.modal.url;
    if (!url) return null;
    base = modalPlaytest({ ...t.modal, url });
  } else {
    const conf = v === 'cpu' ? t.cloudrunCpu : t.cloudrun;
    const url = r.url ?? conf.url;
    if (!url) return null;
    let spec: ServiceSpec | null = specs[v] ?? null;
    try { spec ??= loadSpec(SPEC_FILE(v)); } catch { spec = null; }
    base = { ...conf, url, pricePerSecond: spec ? specPricePerSecond(spec) : 0, region: spec?.region ?? '', name: spec?.name ?? r.id, variant: v,
      slow: v === 'cpu' ? Math.max(1, Number(spec?.slow) || 2) : 1, software: v === 'cpu' ? CPU_SOFTWARE_WHY : null };
  }
  // The entry's own numbers win: its price is per run (a tab), its cap the tabs it plays at once.
  const tabs = Math.max(1, base.tabsPerInstance);
  return {
    ...base, name: r.id,
    pricePerSecond: r.pricePerSecond > 0 ? r.pricePerSecond * tabs : base.pricePerSecond,
    maxInstances: Math.max(1, Math.ceil(r.maxConcurrent / tabs)),
  };
}

/** The runners ids this job already failed on (it moves on from them): labels.runnersTried. */
export const runnersTried = (labels?: Record<string, unknown>): string[] => (Array.isArray(labels?.runnersTried) ? (labels!.runnersTried as unknown[]).map(String) : []);

/**
 * The runners this run may use now, in order, and why the others were skipped. `lane` is whose build it is: customers'
 * builds go only to runners that take them. Full runners go after the ones with room (the run waits on them last).
 */
export function runnerCandidates(
  job: { project: string | null; labels?: Record<string, unknown> },
  target: PlaytestTarget,
  lane: Lane,
  settings: Pick<Settings, 'playtest'>,
  { now = Date.now(), get = env, specs = {} }: { now?: number; get?: (k: string) => string | undefined; specs?: { gpu?: ServiceSpec; cpu?: ServiceSpec } } = {},
): RunnerCandidates {
  const skipped: string[] = [];
  const room: RunnerChoice[] = [];
  const full: RunnerChoice[] = [];
  const tried = new Set(runnersTried(job.labels));
  const list = runnersFor(job.project, settings, specs);
  if (!list.length) skipped.push(settings.playtest.runners?.length ? 'no runners' : 'no runners in settings.playtest.runners and no browser service set up');
  for (const { runner: r, cloud } of list) {
    if (!r.enabled) { skipped.push(`${r.id}: turned off`); continue; }
    if (!r.targets.includes(target)) { skipped.push(`${r.id}: doesn't play ${target}`); continue; }
    if (!r.lanes.includes(lane)) { skipped.push(`${r.id}: doesn't take ${lane === 'customer' ? 'customers\'' : 'the studio\'s'} builds`); continue; }
    if (tried.has(r.id)) { skipped.push(`${r.id}: this run already failed there`); continue; }
    const cool = isDown(cooldownKey(r.id), now);
    if (cool) { skipped.push(`${r.id}: ${cool.reason} (skipped for ${Math.ceil((cool.until - now) / 60_000)} min)`); continue; }
    const broke = r.provider === 'runpod' ? runpodCreditProblem(get) : null;
    if (broke) { skipped.push(`${r.id}: ${broke}`); continue; }
    let choice: RunnerChoice;
    if (r.provider === 'native') {
      if (!isNativeTarget(target)) { skipped.push(`${r.id}: a native runner doesn't play pages`); continue; }
      const token = r.tokenEnv ? get(r.tokenEnv) ?? null : null;
      if (r.tokenEnv && !token) { skipped.push(`${r.id}: ${r.tokenEnv} is not set`); continue; }
      const gatewayKey = r.gatewayKeyEnv ? get(r.gatewayKeyEnv) ?? null : null;
      if (r.gatewayKeyEnv && !gatewayKey) { skipped.push(`${r.id}: ${r.gatewayKeyEnv} is not set`); continue; }
      choice = { kind: 'native', runner: r, url: r.url!, token, gatewayKey };
    } else {
      if (isNativeTarget(target)) { skipped.push(`${r.id}: a browser runner doesn't play ${target} builds`); continue; }
      const svc = cloud ?? browserService(r, settings, specs);
      if (!svc) { skipped.push(`${r.id}: no URL (set it, or the ${r.provider} service in settings.playtest)`); continue; }
      choice = { kind: 'browser', runner: r, cloud: { ...svc, runner: r.id } };
    }
    if (activeOn(r.id) >= r.maxConcurrent) {
      skipped.push(`${r.id}: full (${activeOn(r.id)} of ${r.maxConcurrent} runs)`);
      full.push(choice);
    } else room.push(choice);
  }
  return { choices: [...room, ...full], skipped };
}

/** How long a runner cools down after it refused us: capacity clears up soon, a refused key doesn't. */
export function runnerCooldown(message: string): number {
  if (/\b(401|403)\b|Unauthorized|Forbidden|bad token/i.test(message)) return 30 * 60_000;
  if (/\b(429|503)\b|Too Many|full|no workers|capacity/i.test(message)) return 2 * 60_000;
  return 10 * 60_000;
}
export { cooldownKey as runnerHealthKey };
