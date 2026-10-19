// The products that may send analytics, and which origin means which env (analytics/products.json, docs/analytics.md).

import fs from 'node:fs';
import { paths } from '../config.ts';

export type Env = 'live' | 'beta' | 'preview' | 'local';
export type Product = { id: string; name: string; origins: string[]; beta?: string; levels?: string[]; customEvents: number };

export const BETA_DOMAIN = 'hawkesgen.com';

let cache: { mtime: number; products: Map<string, Product> } | null = null;

/** The registry, re-read when the file changes (no restart needed to add a product or an origin). */
export function products(file = paths.analyticsProducts): Map<string, Product> {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return new Map();
  }
  if (cache && cache.mtime === mtime) return cache.products;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).products ?? {};
  const out = new Map<string, Product>();
  for (const [id, p] of Object.entries<any>(raw)) {
    out.set(id, {
      id, name: String(p.name ?? id),
      origins: (Array.isArray(p.origins) ? p.origins : []).map((o: string) => String(o).replace(/\/+$/, '').toLowerCase()),
      beta: typeof p.beta === 'string' ? p.beta.toLowerCase() : undefined,
      levels: Array.isArray(p.levels) ? p.levels.map(String) : undefined,
      customEvents: Math.max(0, Math.min(500, Number(p.customEvents ?? 50) || 0)),
    });
  }
  cache = { mtime, products: out };
  return out;
}

/**
 * The env an origin means for a product, or null when the product doesn't accept it: one of its live origins (live),
 * https://<beta>.hawkesgen.com (beta, or preview for pages under /c/<change>/), http(s)://localhost or 127.0.0.1 on
 * any port (local).
 */
export function envFor(p: Product, origin: string, page = ''): Env | null {
  const o = origin.replace(/\/+$/, '').toLowerCase();
  if (!o) return null;
  if (p.origins.includes(o)) return 'live';
  if (p.beta && o === `https://${p.beta}.${BETA_DOMAIN}`) return /^\/c\/[\w-]+(\/|$)/.test(page) ? 'preview' : 'beta';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o)) return 'local';
  return null;
}
