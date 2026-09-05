import type { RepoFile, SuggestionSeverity } from '../../../shared/types.js'

/**
 * Repository-owned review configuration, read from `.reposcope.json` in the scanned
 * repository.
 *
 * The repository owns this, not RepoScope: a rule that disagrees with a deliberate choice
 * should be switched off by the people who made that choice, in a file they review like any
 * other. Without it the first false positive becomes permanent noise, and a list with
 * permanent noise in it stops being read.
 *
 * ```json
 * {
 *   "review": {
 *     "disable": ["craft/narrating-comments"],
 *     "ignore": ["legacy/**", "src/generated"],
 *     "severity": { "security/permissive-cors": "low" }
 *   }
 * }
 * ```
 */
export interface ReviewConfig {
  /** Rule ids to switch off entirely. */
  disable: string[]
  /** Path patterns to exclude from the review (`*` and `**` supported). */
  ignore: string[]
  /** Severity overrides per rule id; `off` is equivalent to disabling it. */
  severity: Record<string, SuggestionSeverity | 'off'>
  /** Set when a config file was found, so the UI can say the review was tuned. */
  source?: string
  /** Problems with the config itself, surfaced rather than swallowed. */
  problems: string[]
}

export const CONFIG_FILENAME = '.reposcope.json'

export const EMPTY_CONFIG: ReviewConfig = {
  disable: [],
  ignore: [],
  severity: {},
  problems: [],
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'off'])

function asStringArray(value: unknown, field: string, problems: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    problems.push(`"review.${field}" must be an array of strings; it was ignored.`)
    return []
  }
  return value as string[]
}

/** Read `.reposcope.json` from the scanned repository. Malformed config is reported, not obeyed. */
export function loadReviewConfig(files: RepoFile[]): ReviewConfig {
  const file = files.find((f) => f.path === CONFIG_FILENAME)
  if (!file?.content) return EMPTY_CONFIG

  const problems: string[] = []
  let parsed: { review?: Record<string, unknown> }
  try {
    parsed = JSON.parse(file.content) as { review?: Record<string, unknown> }
  } catch {
    return {
      ...EMPTY_CONFIG,
      source: file.path,
      problems: [`${CONFIG_FILENAME} is not valid JSON, so the whole file was ignored.`],
    }
  }

  const review = parsed.review ?? {}
  const severity: ReviewConfig['severity'] = {}
  const rawSeverity = review.severity
  if (rawSeverity !== undefined) {
    if (typeof rawSeverity !== 'object' || rawSeverity === null || Array.isArray(rawSeverity)) {
      problems.push('"review.severity" must be an object of rule id to severity; it was ignored.')
    } else {
      for (const [rule, value] of Object.entries(rawSeverity as Record<string, unknown>)) {
        if (typeof value === 'string' && SEVERITIES.has(value)) {
          severity[rule] = value as SuggestionSeverity | 'off'
        } else {
          problems.push(
            `"review.severity.${rule}" must be one of critical, high, medium, low, off; it was ignored.`,
          )
        }
      }
    }
  }

  return {
    disable: asStringArray(review.disable, 'disable', problems),
    ignore: asStringArray(review.ignore, 'ignore', problems),
    severity,
    source: file.path,
    problems,
  }
}

/**
 * Match a path against a pattern supporting `*` (within a segment) and `**` (across them).
 * A pattern with no wildcard matches the path itself or anything beneath it, so `"legacy"`
 * covers `legacy/db/query.ts` without anyone having to write `legacy/**`.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const clean = pattern.replace(/^\.\//, '').replace(/\/$/, '')
  if (!clean) return false
  if (!/[*?]/.test(clean)) return path === clean || path.startsWith(clean + '/')

  const regex = clean
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '(?:.+)'
        : segment
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
    )
    .join('/')
    // A trailing `/**` should also match the directory itself.
    .replace(/\/\(\?:\.\+\)$/, '(?:/.+)?')
  return new RegExp(`^${regex}$`).test(path)
}

export function isIgnored(config: ReviewConfig, path: string): boolean {
  return config.ignore.some((pattern) => matchesPattern(pattern, path))
}

/** Rules switched off outright, whether by `disable` or by a severity of `off`. */
export function isDisabled(config: ReviewConfig, ruleId: string): boolean {
  if (config.severity[ruleId] === 'off') return true
  return config.disable.some((entry) => entry === ruleId || matchesPattern(entry, ruleId))
}
