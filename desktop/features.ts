import type { LicenceStatus } from './license.js'
import { tierOf } from './license.js'

/**
 * What a licence unlocks — one table, so the answer to "what do I get for paying" is
 * readable in a single place rather than spread through `if` statements.
 *
 * The rule this table follows: **everything RepoScope promises on the tin is free.** The
 * analyzer, the map, the review, the health score, the exports and the CLI gate are the
 * product, and gating any of them would make the free build a demo rather than a tool.
 * What a licence buys is convenience on top of that.
 */
export type Feature = 'scan-history' | 'batch-scan' | 'private-repos'

export const FEATURES: Record<Feature, { tiers: string[]; title: string; blurb: string }> = {
  'scan-history': {
    tiers: ['pro'],
    title: 'Scan history',
    blurb:
      'Keep every scan on this machine and reopen or compare them later, instead of the most recent one only.',
  },
  'batch-scan': {
    tiers: ['pro'],
    title: 'Batch scanning',
    blurb: 'Queue several repositories and get one combined report across all of them.',
  },
  'private-repos': {
    tiers: ['pro'],
    title: 'Private repositories',
    blurb:
      'Scan private repositories with a GitHub token held for the session only. Not yet implemented — listed here so the tier is honest about what is coming rather than what ships today.',
  },
}

export function allows(status: LicenceStatus, feature: Feature): boolean {
  return FEATURES[feature].tiers.includes(tierOf(status))
}

/** Features the current licence grants, for the settings panel. */
export function granted(status: LicenceStatus): Feature[] {
  return (Object.keys(FEATURES) as Feature[]).filter((f) => allows(status, f))
}
