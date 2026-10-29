// How Gen proves itself to each GPU provider (docs/gpu-providers.md). Secrets come from the environment (on Cloud Run,
// Secret Manager mounted by tools/gen-cloudrun/deploy.mjs); none is ever sent to the worker or written anywhere.
//
//   runpod   Authorization: Bearer RUNPOD_API_KEY (RunPod's gateway checks it)
//   modal    Modal-Key / Modal-Secret: a Modal proxy auth token (MODAL_PROXY_KEY / MODAL_PROXY_SECRET), checked by
//            Modal's gateway in front of a web endpoint with requires_proxy_auth
//   http     Authorization: Bearer GPU_HTTP_TOKEN (the host checks it, or the worker does through WORKER_TOKEN)
//
// Every request also carries X-Hawkes-Worker-Token: GPU_WORKER_TOKEN when it is set, which the worker checks itself
// (its WORKER_TOKEN): a second lock that doesn't depend on the provider's gateway.
import { env } from '../../config.ts';
import type { GpuEndpoint } from '../../config.ts';

export type Secrets = (name: string) => string | undefined;

/** The environment variables an endpoint needs, for the dashboard and the "not set up" reason. */
export function secretsFor(provider: GpuEndpoint['provider']): string[] {
  if (provider === 'runpod') return ['RUNPOD_API_KEY'];
  if (provider === 'modal') return ['MODAL_PROXY_KEY', 'MODAL_PROXY_SECRET'];
  return ['GPU_HTTP_TOKEN'];
}

/** What's missing to call this endpoint ("" when nothing is). */
export function missingSecrets(provider: GpuEndpoint['provider'], get: Secrets = env): string {
  const gone = secretsFor(provider).filter((k) => !get(k));
  return gone.length ? `${gone.join(' and ')} not set` : '';
}

/** The headers of one request to an endpoint (throws when a secret is missing). */
export function endpointHeaders(provider: GpuEndpoint['provider'], get: Secrets = env): Record<string, string> {
  const missing = missingSecrets(provider, get);
  if (missing) throw Object.assign(new Error(`${provider}: ${missing}`), { unavailable: true, auth: true });
  const h: Record<string, string> = {};
  if (provider === 'runpod') h.Authorization = `Bearer ${get('RUNPOD_API_KEY')}`;
  else if (provider === 'modal') { h['Modal-Key'] = get('MODAL_PROXY_KEY')!; h['Modal-Secret'] = get('MODAL_PROXY_SECRET')!; }
  else h.Authorization = `Bearer ${get('GPU_HTTP_TOKEN')}`;
  const worker = get('GPU_WORKER_TOKEN');
  if (worker) h['X-Hawkes-Worker-Token'] = worker;
  return h;
}
