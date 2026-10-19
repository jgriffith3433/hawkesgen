// Where a visitor is, from their IP, with the free DB-IP Lite city database (CC BY 4.0, no account or key): downloaded
// into .data/geo and refreshed monthly. Only the place is kept; the IP is never stored or logged (docs/analytics.md).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { paths, env } from '../config.ts';
import { Mmdb } from './mmdb.ts';

export type Geo = { country: string | null; region: string | null; city: string | null; tz: string | null };

const FILE = 'dbip-city-lite.mmdb';
const dbFile = () => path.join(paths.geo, FILE);
let db: Mmdb | null = null;
let opened = 0;

/** Tests (and anyone with their own file) can point the lookups at a database. */
export function useGeoDb(file: string | null) {
  db?.close();
  db = file ? Mmdb.open(file) : null;
  opened = file ? Date.now() : 0;
}

function current(): Mmdb | null {
  if (db) return db;
  // Look for the downloaded file at most once a minute.
  if (Date.now() - opened < 60_000) return null;
  opened = Date.now();
  try {
    if (fs.existsSync(dbFile())) db = Mmdb.open(dbFile());
  } catch (e: any) {
    console.warn(`[analytics] geo database: ${e.message}`);
  }
  return db;
}

const name = (o: any) => (o?.names?.en ?? (o?.names ? Object.values(o.names)[0] : null) ?? null) as string | null;

export function lookup(ip: string | null): Geo | null {
  if (!ip) return null;
  const d = current();
  if (!d) return null;
  try {
    const r = d.get(ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1'));
    if (!r) return null;
    return {
      country: r.country?.iso_code ?? null,
      region: name(r.subdivisions?.[0]),
      city: name(r.city),
      tz: r.location?.time_zone ?? null,
    };
  } catch {
    return null;
  }
}

/** The month's file name on download.db-ip.com (they publish on the 1st; the previous month's stays up). */
export const geoUrl = (d: Date) => `https://download.db-ip.com/free/dbip-city-lite-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.mmdb.gz`;

/** Downloads the database when it's missing or older than a month. Off with HAWKESGEN_GEO=off. */
export async function refreshGeo(now = new Date()): Promise<string> {
  if (env('HAWKESGEN_GEO') === 'off') return 'off';
  const file = dbFile();
  const age = fs.existsSync(file) ? now.getTime() - fs.statSync(file).mtimeMs : Infinity;
  if (age < 31 * 24 * 3600 * 1000) return 'fresh';
  fs.mkdirSync(paths.geo, { recursive: true });
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  let last = '';
  for (const url of [geoUrl(now), geoUrl(prev)]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!r.ok || !r.body) {
        last = `${url}: HTTP ${r.status}`;
        continue;
      }
      const tmp = `${file}.part`;
      await pipeline(Readable.fromWeb(r.body as any), zlib.createGunzip(), fs.createWriteStream(tmp));
      Mmdb.open(tmp).close(); // a whole, readable file before it replaces the old one
      useGeoDb(null); // Windows won't replace an open file
      fs.renameSync(tmp, file);
      useGeoDb(file);
      return `downloaded ${path.basename(url)}`;
    } catch (e: any) {
      last = `${url}: ${e.message}`;
    }
  }
  throw new Error(`GeoIP download failed (${last})`);
}
