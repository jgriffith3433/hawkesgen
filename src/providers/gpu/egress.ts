// How the AWS fleet lets Gen in (docs/gpu-providers.md, "The fleet from Cloud Run"). The servers' security groups open the
// ComfyUI proxy and SSH to one address: Gen's. J's PC and a VM have one (looked up); Cloud Run has none of its own, so
// there Gen needs either a fixed egress address (settings.fleet.egressIp or HAWKES_PUBLIC_IP: Direct VPC egress through
// Cloud NAT with a reserved IP) or J's explicit fleet.openComfyPort (the ComfyUI port open to all, behind each server's
// token). With neither, Gen refuses to open the security group and the queue moves on to the next provider.
import { env } from '../../config.ts';

type Get = (name: string) => string | undefined;
type FleetAccess = { egressIp?: string; openComfyPort?: boolean };

const IP = /^\d{1,3}(\.\d{1,3}){3}$/;

export const NO_EGRESS =
  'Gen runs on Cloud Run, which has no fixed address for the GPU servers\' security groups to let in: set settings.fleet.egressIp ' +
  '(tools/gpu-providers/egress.mjs makes one) or turn on fleet.openComfyPort (docs/gpu-providers.md). Until then the fleet is skipped.';

/** The fixed address Gen's requests leave from, or null. */
export function fixedIp(fleet: FleetAccess, get: Get = env): string | null {
  const ip = (fleet.egressIp || get('HAWKES_PUBLIC_IP') || '').trim();
  return IP.test(ip) ? ip : null;
}

/** Why the fleet can't be reached from here, or null when it can. */
export function fleetBlocked(fleet: FleetAccess | undefined, get: Get = env): string | null {
  if (!get('K_SERVICE')) return null;
  if (fleet && fixedIp(fleet, get)) return null;
  if (fleet?.openComfyPort) return null;
  return NO_EGRESS;
}
