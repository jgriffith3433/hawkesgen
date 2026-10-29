// The whole Worker: the same request to Gen on Cloud Run, the answer streamed back as it comes (Gen's event streams and
// downloads included). The visitor's address goes along as X-Hawkes-Client-IP: Gen believes it only when the request
// reached Google from Cloudflare's edge (src/analytics/collect.ts clientIp).
export default {
  async fetch(request: Request, env: { GEN_ORIGIN: string }): Promise<Response> {
    const url = new URL(request.url);
    const origin = new URL(env.GEN_ORIGIN);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = '';
    const headers = new Headers(request.headers);
    headers.set('X-Hawkes-Client-IP', request.headers.get('CF-Connecting-IP') ?? '');
    headers.set('X-Forwarded-Host', new URL(request.url).host);
    headers.set('X-Forwarded-Proto', 'https');
    return fetch(url, { method: request.method, headers, body: request.body, redirect: 'manual' });
  },
};
