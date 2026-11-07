// HAWKESGEN_MOCK_PROVIDERS=1: every provider-backed tool (GPU/ComfyUI, ElevenLabs, Claude) answers at once with a tiny
// stand-in output, so the load harness (tools/load/run.mjs) can push hundreds of users through the real queue, library,
// events and routes for $0. It extends HAWKESGEN_AUDIO_MOCK / HAWKESGEN_QUALITY_MOCK / HAWKESGEN_AI_MOCK to the queue.
//
// Impossible on live: the flag is honoured only on a lane that is not live (HAWKESGEN_LANE = beta, dev, local or test), and
// never on a service whose address is public unless that lane is beta. On the live lane (HAWKESGEN_LANE unset or `live`)
// the server refuses to start with the flag set (assertMockProviders, called by server.ts), and mockProvidersOn() is
// false anyway, so a tool never swaps. With the flag unset nothing here runs: tools, lanes and providers are untouched.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Tool } from './tools/types.ts';
import { db } from './db.ts';

const LANES_ALLOWED = new Set(['beta', 'dev', 'local', 'test']);
const PUBLIC_HOST_OK = new Set(['beta']);

/** Why the flag can't be on here, or null when it may be. */
export function mockRefusal(e: NodeJS.ProcessEnv = process.env): string | null {
  const lane = (e.HAWKESGEN_LANE || 'live').toLowerCase();
  if (!LANES_ALLOWED.has(lane)) return `HAWKESGEN_MOCK_PROVIDERS is refused on the ${lane} lane: it is for beta and local copies only`;
  const host = e.HAWKESGEN_HOST || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !PUBLIC_HOST_OK.has(lane)) return `HAWKESGEN_MOCK_PROVIDERS is refused on ${host}: a local copy listens on loopback only`;
  return null;
}

export const mockFlag = (e: NodeJS.ProcessEnv = process.env) => e.HAWKESGEN_MOCK_PROVIDERS === '1';
/** Whether provider tools are mocked right now: the flag, on a lane that allows it. */
export const mockProvidersOn = (e: NodeJS.ProcessEnv = process.env) => mockFlag(e) && mockRefusal(e) === null;

/** Called at start-up: throws when the flag is set where it must not be. */
export function assertMockProviders(e: NodeJS.ProcessEnv = process.env) {
  if (!mockFlag(e)) return;
  const why = mockRefusal(e);
  if (why) throw new Error(why);
}

const BOOT = Date.now();
/** For /v1/health: whether mocking is on, and what real provider spend this process has recorded (the harness aborts if > 0). */
export function mockHealth() {
  if (!mockProvidersOn()) return { providers: false, flagRefused: mockFlag() ? mockRefusal() : null, realCost: null, realCostRows: null };
  const r = db.prepare("SELECT COALESCE(SUM(cost), 0) AS c, COUNT(*) AS n FROM usage WHERE at >= ? AND provider != 'mock' AND cost > 0").get(BOOT) as { c: number; n: number };
  return { providers: true, flagRefused: null, realCost: Math.round(r.c * 1e6) / 1e6, realCostRows: r.n };
}

// ---------------------------------------------------------------------------------------------- stand-in outputs
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** A valid 8x8 PNG in one grey (the seed picks it), a few dozen bytes. */
export function mockPng(seed: number): Buffer {
  const w = 8, h = 8, v = 64 + (Math.abs(seed) % 128);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, v); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A valid quarter-second mono WAV tone. */
export function mockWav(seed: number): Buffer {
  const rate = 8000, n = rate / 4, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (220 + (Math.abs(seed) % 200)) * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
/** An empty GLB container (header + empty JSON chunk). */
export function mockGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"}}   '.slice(0, 28));
  const h = Buffer.alloc(20); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + json.length, 8); h.writeUInt32LE(json.length, 12); h.write('JSON', 16);
  return Buffer.concat([h, json]);
}

const PROVIDERS = new Set(['comfy', 'elevenlabs', 'anthropic', 'gemini']);

/** A tool whose provider is a paid or GPU one, run by a stand-in. Other tools (local, pipeline, playtest, builder) are untouched. */
export function mockTool(t: Tool): Tool {
  if (!PROVIDERS.has(t.provider)) return t;
  const n = Math.max(1, Math.min(4, Math.floor(Number(t.params?.count ?? t.params?.n ?? 1)) || 1));
  return {
    ...t,
    provider: 'local',
    family: undefined,
    server: undefined,
    description: `${t.description} (mocked: HAWKESGEN_MOCK_PROVIDERS)`,
    async run(ctx) {
      ctx.step('mock provider');
      for (let i = ctx.done; i < n; i++) {
        const seed = ctx.seed(i);
        const base = { seed, title: `mock ${t.id} ${i + 1}`, meta: { mock: true } };
        if (t.output === 'image') await ctx.emit({ ...base, data: mockPng(seed), mime: 'image/png', ext: 'png' });
        else if (t.output === 'audio') await ctx.emit({ ...base, data: mockWav(seed), mime: 'audio/wav', ext: 'wav' });
        else if (t.output === 'video') await ctx.emit({ ...base, data: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), crypto.randomBytes(16)]), mime: 'video/mp4', ext: 'mp4' });
        else if (t.output === 'mesh') await ctx.emit({ ...base, data: mockGlb(), mime: 'model/gltf-binary', ext: 'glb' });
        else { ctx.result({ mock: true, text: 'mock answer' }); break; }
      }
      ctx.usage({ provider: 'mock', unit: 'jobs', amount: 1, cost: 0, detail: t.id });
    },
  };
}
