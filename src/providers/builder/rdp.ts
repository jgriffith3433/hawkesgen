// Remote Desktop for the build server from a browser: the requester's address and the .rdp file text.
// Pure helpers (no AWS), so the tests can run them as they are.

import type { IncomingMessage } from 'node:http';
import { clientIp } from '../../analytics/collect.ts';

/** The address as a public IPv4 (a security group rule needs one), or null for private, loopback, IPv6 and junk. */
export function publicIpv4(addr: string | null | undefined): string | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec((addr ?? '').trim());
  if (!m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return null;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
  if (a === 169 && b === 254) return null;
  if (a === 172 && b >= 16 && b <= 31) return null;
  if (a === 192 && b === 168) return null;
  if (a === 100 && b >= 64 && b <= 127) return null;
  return `${a}.${b}.${c}.${d}`;
}

/** The public IPv4 of whoever is calling (Caddy's X-Forwarded-For), or undefined: then the caller is this machine. */
export function requesterIp(req: IncomingMessage): string | undefined {
  return publicIpv4(clientIp(req)) ?? undefined;
}

/** The contents of a Remote Desktop file for the server, with the user filled in. */
export function rdpText(ip: string, user: string) {
  return [`full address:s:${ip}`, `username:s:${user}`, 'prompt for credentials:i:1', 'screen mode id:i:1', 'desktopwidth:i:1600', 'desktopheight:i:900', ''].join('\r\n');
}
