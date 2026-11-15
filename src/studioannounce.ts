// Gen tells Hawkes Studio when its lane runs this deploy (J, 2026-11-11: "A go-live play waits until beta has actually
// deployed the build it is testing, keyed on the deployed commit. Use the deploy's completion event, not polling").
// Studio's play of a commit waits until beta runs it; this is the event that wakes it (hawkesstudio src/deploywait.ts).
//
// When: the first /v1/health this instance answers (the deploy's own health check, Studio's reads, Cloud Run), so the
// lane's traffic has reached it. Studio answers whether the lane now runs this commit (it reads /v1/health itself and
// never takes this call's word for it); once it says seen, this instance says nothing more. Before that, at most once
// every ANNOUNCE_GAP_MS and only while health requests come in: nothing here runs on a timer or looks by itself.
// How: POST <Studio>/api/hooks/deployed with a Google-signed ID token for Studio's address, from this service's own
// account (the metadata server; no secret), and the body { repo, lane, commit }.
import { env } from './config.ts';

/** Studio's address (the same one .github/workflows/hawkes-studio.yml tells about pushes). */
export const studioUrl = (get: (k: string) => string | undefined = env) => (get('HAWKES_STUDIO_URL') || 'https://studio.hawkesgen.ai/o/j-studio-4f12').replace(/\/+$/, '');
export const REPO = 'jgriffith3433/hawkesgen';
export const ANNOUNCE_GAP_MS = 20_000;

type Deps = { get?: (k: string) => string | undefined; fetcher?: typeof fetch; now?: () => number };
const state = { seen: false, inflight: false, last: -Infinity };
/** For tests: a new instance. */
export const resetAnnounce = () => { state.seen = false; state.inflight = false; state.last = -Infinity; };
export const announceState = () => ({ ...state });

/** Says once (until Studio has seen it) that this lane runs this commit. Never throws; resolves when the call ends. */
export async function announceDeployed({ get = env, fetcher = fetch, now = Date.now }: Deps = {}): Promise<'seen' | 'not-yet' | 'skipped' | 'failed'> {
  const commit = get('HAWKESGEN_COMMIT');
  if (!get('K_SERVICE') || !commit || state.seen || state.inflight || now() - state.last < ANNOUNCE_GAP_MS) return 'skipped';
  state.inflight = true;
  state.last = now();
  try {
    const studio = studioUrl(get);
    const t = await fetcher(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(studio)}&format=full`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) });
    if (!t.ok) throw new Error(`no ID token from the metadata server (${t.status})`);
    const token = (await t.text()).trim();
    const lane = (get('HAWKESGEN_LANE') || 'live') === 'beta' ? 'beta' : 'live';
    const r = await fetcher(`${studio}/api/hooks/deployed`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, lane, commit }), signal: AbortSignal.timeout(60_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Studio answered ${r.status} ${String(j?.error ?? '').slice(0, 200)}`);
    if (j?.seen) {
      state.seen = true;
      console.log(`[studio] told Hawkes Studio ${lane} runs ${commit.slice(0, 7)}`);
      return 'seen';
    }
    return 'not-yet';
  } catch (e: any) {
    console.warn(`[studio] couldn't tell Hawkes Studio about this deploy: ${String(e?.message ?? e)}`);
    return 'failed';
  } finally {
    state.inflight = false;
  }
}
