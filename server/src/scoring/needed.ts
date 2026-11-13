// parts.needed (SPEC.md 13.3): how many more slop networks an account needs until the crowd test of
// its next tier passes, each with the trust of a brand-new install: the weakest ordinary voter. So a
// number here is a promise about the head count, not a promise of a status: the gates (standing,
// evidence, identity, a dispute) still decide. 0 when the test passes, at the top, and for an account
// that votes cannot move.
import { CONFIRM_TIER, FLAG_TIER, crowdPasses, type Case, type Decision } from './rules.js';
import { NEW_INSTALL_TRUST } from './weight.js';

export const NEEDED_MAX = 20; // past this, more networks of new installs are not what the account lacks

export function neededNetworks(c: Case, d: Decision): number {
  if (d.tier === 2 || d.status === 'cleared' || d.reason === 'moved') return 0;
  const next = crowdPasses(c, FLAG_TIER) ? CONFIRM_TIER : FLAG_TIER;
  if (crowdPasses(c, next)) return 0;
  for (let k = 1; k <= NEEDED_MAX; k++) {
    if (crowdPasses({ slopNetworks: c.slopNetworks + k, slopTrust: c.slopTrust + k * NEW_INSTALL_TRUST }, next)) return k;
  }
  return 0;
}
