// Visits from data centres and declared crawlers, by IP range (docs/analytics.md, "Bots"): the ranges the big clouds and
// the crawlers publish themselves, downloaded into .data/geo/datacenter.json and refreshed daily. A crawler's range is a
// bot whatever it does; a cloud's is a bot unless a person touched the page (store.ts ingest: a VPN on a cloud server
// still counts). Only the verdict is kept, never the IP. Off with HAWKESGEN_DC=off.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { paths, env } from '../config.ts';

export type RangeKind = 'crawler' | 'cloud';
export type Source = { id: string; name: string; kind: RangeKind; url: string; format: 'json' | 'csv' };
export type Hit = { kind: RangeKind; name: string };

/** Published by the owners themselves (no third-party list): their own formats, read by parse(). */
export const SOURCES: Source[] = [
  { id: 'googlebot', name: 'Googlebot', kind: 'crawler', format: 'json', url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json' },
  { id: 'google-special', name: 'Google crawler', kind: 'crawler', format: 'json', url: 'https://developers.google.com/static/search/apis/ipranges/special-crawlers.json' },
  { id: 'google-fetchers', name: 'Google fetcher (link previews)', kind: 'crawler', format: 'json', url: 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json' },
  { id: 'google-fetchers-google', name: 'Google fetcher (link previews)', kind: 'crawler', format: 'json', url: 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json' },
  { id: 'bingbot', name: 'Bingbot', kind: 'crawler', format: 'json', url: 'https://www.bing.com/toolbox/bingbot.json' },
  { id: 'gptbot', name: 'OpenAI GPTBot', kind: 'crawler', format: 'json', url: 'https://openai.com/gptbot.json' },
  { id: 'openai-search', name: 'OpenAI search', kind: 'crawler', format: 'json', url: 'https://openai.com/searchbot.json' },
  { id: 'chatgpt-user', name: 'ChatGPT fetcher', kind: 'crawler', format: 'json', url: 'https://openai.com/chatgpt-user.json' },
  { id: 'aws', name: 'AWS', kind: 'cloud', format: 'json', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json' },
  { id: 'google-cloud', name: 'Google Cloud', kind: 'cloud', format: 'json', url: 'https://www.gstatic.com/ipranges/cloud.json' },
  { id: 'oracle', name: 'Oracle Cloud', kind: 'cloud', format: 'json', url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json' },
  { id: 'digitalocean', name: 'DigitalOcean', kind: 'cloud', format: 'csv', url: 'https://www.digitalocean.com/geo/google.csv' },
];

const KEYS = new Set(['ip_prefix', 'ipv6_prefix', 'ipv4Prefix', 'ipv6Prefix', 'cidr']);

/** The CIDRs in a source's file: its known keys anywhere in the JSON, or a CSV's first column. */
export function parse(text: string, format: Source['format']): string[] {
  const out: string[] = [];
  if (format === 'csv') {
    for (const line of text.split(/\r?\n/)) {
      const c = line.split(',')[0]?.trim();
      if (c && c.includes('/')) out.push(c);
    }
    return out;
  }
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (KEYS.has(k) && typeof x === 'string' ? out.push(x) : walk(x));
  };
  walk(JSON.parse(text));
  return out;
}

// ---------------------------------------------------------------- lookups: sorted, merged ranges per family

type Table = { starts: bigint[]; ends: bigint[]; hits: Hit[] };
const empty = (): Table => ({ starts: [], ends: [], hits: [] });
/** Per kind and family: crawlers are looked up first, so a crawler inside a cloud's space is named as the crawler. */
let tables: Record<RangeKind, { 4: Table; 6: Table }> = { crawler: { 4: empty(), 6: empty() }, cloud: { 4: empty(), 6: empty() } };
let loadedAt = 0;

function toBig(ip: string): { v: bigint; bits: 32 | 128 } | null {
  const a = ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  if (net.isIPv4(a)) return { v: a.split('.').reduce((n, o) => (n << 8n) + BigInt(Number(o)), 0n), bits: 32 };
  if (!net.isIPv6(a)) return null;
  const [head, tail] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail != null && tail ? tail.split(':') : [];
  const groups = tail != null ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return { v: groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n), bits: 128 };
}

/** Whether an IP is inside any of these CIDRs (a short fixed list: collect.ts's Cloudflare edge). */
export function inCidrs(ip: string, cidrs: string[]): boolean {
  const b = toBig(ip);
  if (!b) return false;
  return cidrs.some((c) => { const r = rangeOf(c); return !!r && r.bits === b.bits && b.v >= r.start && b.v <= r.end; });
}

function rangeOf(cidr: string): { start: bigint; end: bigint; bits: 32 | 128 } | null {
  const [ip, len] = cidr.trim().split('/');
  const b = toBig(ip ?? '');
  const n = Number(len);
  if (!b || !Number.isInteger(n) || n < 0 || n > b.bits) return null;
  const host = BigInt(b.bits - n);
  const start = (b.v >> host) << host;
  return { start, end: start + (1n << host) - 1n, bits: b.bits };
}

/** Sorted, overlaps merged (an overlap keeps the name of the range that starts first). */
function table(rows: { start: bigint; end: bigint; hit: Hit }[]): Table {
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const t = empty();
  for (const r of rows) {
    const i = t.starts.length - 1;
    if (i >= 0 && r.start <= t.ends[i] + 1n && (r.start <= t.ends[i] || r.hit.name === t.hits[i].name)) {
      if (r.end > t.ends[i]) {
        if (r.hit.name === t.hits[i].name) t.ends[i] = r.end;
        else { t.starts.push(t.ends[i] + 1n); t.ends.push(r.end); t.hits.push(r.hit); }
      }
      continue;
    }
    t.starts.push(r.start);
    t.ends.push(r.end);
    t.hits.push(r.hit);
  }
  return t;
}

/** Builds the lookup tables from sources' CIDRs. */
export function useRanges(list: { kind: RangeKind; name: string; cidrs: string[] }[]) {
  const rows = { crawler: { 4: [] as any[], 6: [] as any[] }, cloud: { 4: [] as any[], 6: [] as any[] } };
  for (const s of list) {
    for (const c of s.cidrs) {
      const r = rangeOf(c);
      if (r) rows[s.kind][r.bits === 32 ? 4 : 6].push({ start: r.start, end: r.end, hit: { kind: s.kind, name: s.name } });
    }
  }
  tables = { crawler: { 4: table(rows.crawler[4]), 6: table(rows.crawler[6]) }, cloud: { 4: table(rows.cloud[4]), 6: table(rows.cloud[6]) } };
  loadedAt = Date.now();
}

function find(t: Table, v: bigint): Hit | null {
  let lo = 0;
  let hi = t.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid] > v) hi = mid - 1;
    else if (t.ends[mid] < v) lo = mid + 1;
    else return t.hits[mid];
  }
  return null;
}

/** Whose range an IP is in (a crawler or a cloud), or null: a home or mobile network as far as we know. */
export function datacenterOf(ip: string | null): Hit | null {
  if (!ip) return null;
  if (!loadedAt) loadFile();
  const b = toBig(ip);
  if (!b) return null;
  const fam = b.bits === 32 ? 4 : 6;
  return find(tables.crawler[fam], b.v) ?? find(tables.cloud[fam], b.v);
}

// ---------------------------------------------------------------- the file and the daily refresh

const file = () => path.join(paths.geo, 'datacenter.json');
type Saved = { at: number; sources: Record<string, { at: number; cidrs: string[] }> };

function readSaved(): Saved {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { at: 0, sources: {} };
  }
}

function useSaved(s: Saved) {
  useRanges(SOURCES.filter((x) => s.sources[x.id]).map((x) => ({ kind: x.kind, name: x.name, cidrs: s.sources[x.id].cidrs })));
}

function loadFile() {
  loadedAt = Date.now(); // once, even when there is no file yet
  if (env('HAWKESGEN_DC') === 'off') return;
  useSaved(readSaved());
}

/** Downloads every source when the file is a day old; a source that fails keeps its last copy. */
export async function refreshDatacenters(now = Date.now()): Promise<string> {
  if (env('HAWKESGEN_DC') === 'off') return 'off';
  const saved = readSaved();
  if (now - saved.at < 23 * 3600 * 1000 && Object.keys(saved.sources).length) {
    if (!loadedAt) useSaved(saved);
    return 'fresh';
  }
  const failed: string[] = [];
  for (const s of SOURCES) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'HawkesGen-analytics/1 (+https://hawkesgen.ai)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cidrs = parse(await r.text(), s.format);
      if (!cidrs.length) throw new Error('no ranges in it');
      saved.sources[s.id] = { at: now, cidrs };
    } catch (e: any) {
      failed.push(`${s.id} (${e.message})`);
    }
  }
  saved.at = now;
  fs.mkdirSync(paths.geo, { recursive: true });
  fs.writeFileSync(`${file()}.part`, JSON.stringify(saved));
  fs.renameSync(`${file()}.part`, file());
  useSaved(saved);
  const n = Object.values(saved.sources).reduce((a, x) => a + x.cidrs.length, 0);
  return `${n} ranges from ${Object.keys(saved.sources).length} sources${failed.length ? `; kept the last copy of ${failed.join(', ')}` : ''}`;
}
