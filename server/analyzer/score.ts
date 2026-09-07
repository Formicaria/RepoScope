import type {
  Dependency,
  HealthScore,
  RepoFile,
  ReviewSummary,
  Warning,
} from '../../shared/types.js'
import type { GraphOutput } from './graph.js'

export interface ScoreInput {
  files: RepoFile[]
  graph: GraphOutput
  warnings: Warning[]
  dependencies: Dependency[]
  review?: ReviewSummary
}

/**
 * Estimated project health. This is a heuristic blend of measurable signals, not a scientific metric —
 * the UI labels it as an estimate and shows the breakdown so users can judge it themselves.
 */
export function computeHealth(input: ScoreInput): HealthScore {
  const { files, graph, warnings, dependencies } = input
  const breakdown: HealthScore['breakdown'] = []
  let score = 100
  const apply = (signal: string, delta: number, note: string) => {
    breakdown.push({ signal, delta, note })
    score += delta
  }

  /**
   * Only warnings the analyzer is confident are defects count against the score. `info` is
   * how a detector says "worth mentioning, not worth holding against you" — a benchmark
   * directory with no tests, a cycle inside a single module, a `.env` in a test fixture.
   * Scoring them anyway was a quiet contradiction of that contract, and it cost Vue 8 points
   * for `sfc-playground` and `__benchmarks__` having no test files.
   */
  const count = (kind: Warning['kind']) =>
    warnings.filter((w) => w.kind === kind && w.severity !== 'info')
  const all = (kind: Warning['kind']) => warnings.filter((w) => w.kind === kind)
  const paths = files.map((f) => f.path)

  // Denominators for the rate-based penalties below. A module count of zero would only
  // happen on an empty repository, where nothing is scored anyway.
  const moduleCount = Math.max(1, graph.modules.length)
  const fileCount = Math.max(1, files.length)

  /**
   * A penalty from a rate rather than a count.
   *
   * Every count-based penalty here used to read `Math.min(cap, n * weight)`, which makes the
   * score a proxy for repository size: a 650-file project accumulates more of everything
   * than a 60-file one and hits the cap in category after category, whatever its quality.
   * Measured across the corpus, score correlated -0.73 with file count. Rates are the fix:
   * `full` is the share at which a signal is bad enough to cost the whole `max`.
   *
   * The thresholds below are still judgement calls, and the score is still labelled an
   * estimate. What changed is that they are judgements about proportions, which mean the
   * same thing in a small repository and a large one.
   */
  const rate = (n: number, of: number, full: number, max: number) =>
    n === 0 ? 0 : -Math.min(max, Math.max(1, Math.round((n / of / full) * max)))

  // Tests
  const missing = count('missing-tests')
  if (missing.some((w) => w.severity === 'critical'))
    apply('Tests', -25, 'No automated tests detected')
  else if (missing.some((w) => w.severity === 'warning'))
    apply('Tests', -12, 'Test coverage looks sparse')
  else if (missing.length)
    apply(
      'Tests',
      rate(missing.length, moduleCount, 0.3, 8),
      `${missing.length} of ${moduleCount} modules without tests`,
    )
  else apply('Tests', 0, 'Tests present')

  // Secrets
  // Only real findings are penalised. Secrets inside test fixtures are reported at info
  // severity because committing throwaway keys and .env files there is normal and deliberate.
  const secrets = count('exposed-secret')
  const fixtureSecrets = all('exposed-secret').length - secrets.length
  if (secrets.length)
    apply(
      'Secrets',
      -Math.min(30, 15 + secrets.length * 5),
      `${secrets.length} possible exposed secret(s)`,
    )
  else if (fixtureSecrets)
    apply('Secrets', 0, `${fixtureSecrets} secret-carrying test fixture(s), not counted`)
  else apply('Secrets', 0, 'No secrets detected')

  // Circular dependencies
  const cycles = count('circular-dependency')
  if (cycles.length)
    apply(
      'Circular dependencies',
      rate(cycles.length, moduleCount, 0.15, 12),
      `${cycles.length} import cycle(s) across ${moduleCount} modules`,
    )
  else apply('Circular dependencies', 0, 'No import cycles')

  // Complexity
  const complexity = count('excessive-complexity')
  if (complexity.length)
    apply(
      'Complexity',
      rate(complexity.length, moduleCount, 0.2, 10),
      `${complexity.length} of ${moduleCount} modules flagged for complexity`,
    )
  else apply('Complexity', 0, 'No oversized files or modules')

  // Dependency complexity
  const runtimeDeps = dependencies.filter((d) => !d.dev).length
  if (runtimeDeps > 80) apply('Dependencies', -8, `${runtimeDeps} runtime dependencies`)
  else if (runtimeDeps > 40) apply('Dependencies', -4, `${runtimeDeps} runtime dependencies`)
  else apply('Dependencies', 0, `${runtimeDeps} runtime dependencies`)
  const unused = count('unused-dependency')
  if (unused.length) apply('Unused dependencies', -3, unused[0].title)

  // Documentation
  const hasReadme = paths.some((p) => /^readme(\.\w+)?$/i.test(p))
  const hasDocs =
    paths.some((p) => /^docs?\//i.test(p)) ||
    paths.some((p) => /^(CONTRIBUTING|ARCHITECTURE)\.md$/i.test(p))
  if (!hasReadme) apply('Documentation', -10, 'No README')
  else if (hasDocs) apply('Documentation', 0, 'README and docs present')
  else apply('Documentation', -2, 'README only')

  // Configuration quality
  const hasCI = paths.some((p) => /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\//.test(p))
  const hasLint = paths.some((p) =>
    /^(\.eslintrc|eslint\.config|\.prettierrc|prettier\.config|ruff\.toml|\.flake8|\.golangci|\.editorconfig|biome\.json)/.test(
      p,
    ),
  )
  const hasIgnore = paths.some((p) => p === '.gitignore')
  let cfg = 0
  const notes: string[] = []
  if (!hasCI) ((cfg -= 4), notes.push('no CI workflow'))
  if (!hasLint) ((cfg -= 2), notes.push('no lint/format config'))
  if (!hasIgnore) ((cfg -= 2), notes.push('no .gitignore'))
  apply('Configuration', cfg, notes.length ? notes.join(', ') : 'CI, lint and .gitignore present')

  // Module cohesion: share of import edges that stay inside a module.
  let internal = 0
  let total = 0
  for (const e of graph.edges) {
    if (e.type !== 'imports') continue
    total++
    const a = graph.fileModule.get(e.source.replace(/^file:/, ''))
    const b = graph.fileModule.get(e.target.replace(/^file:/, ''))
    if (a && a === b) internal++
  }
  if (total >= 10) {
    const cohesion = internal / total
    if (cohesion < 0.3)
      apply(
        'Module cohesion',
        -8,
        `Only ${Math.round(cohesion * 100)}% of imports stay within their module`,
      )
    else if (cohesion < 0.5)
      apply(
        'Module cohesion',
        -3,
        `${Math.round(cohesion * 100)}% of imports stay within their module`,
      )
    else
      apply(
        'Module cohesion',
        0,
        `${Math.round(cohesion * 100)}% of imports stay within their module`,
      )
  }

  // Dead modules / entry clarity / large files
  const dead = count('dead-module')
  if (dead.length)
    apply(
      'Dead modules',
      rate(dead.length, moduleCount, 0.15, 8),
      `${dead.length} of ${moduleCount} modules unreferenced`,
    )
  const entry = count('unclear-entry')
  if (entry.some((w) => w.severity === 'warning')) apply('Entry point', -6, 'No clear entry point')
  const large = count('large-file')
  if (large.length)
    apply(
      'Large files',
      rate(large.length, fileCount, 0.02, 6),
      `${large.length} of ${fileCount} files are very large`,
    )

  // Review findings move the score, but never dominate it: the warnings above already
  // cover tests, secrets, cycles and complexity, and double-counting the same weaknesses
  // produced scores that were not credible (a well-engineered compiler scoring 18/100).
  // Only confident findings count — a `possible` one is worth reading, not scoring.
  if (input.review) {
    const REVIEW_BUDGET = 20
    const confident = input.review.suggestions.filter((s) => s.confidence !== 'possible')
    const pending: { signal: string; delta: number; note: string }[] = []

    const security = confident.filter(
      (s) => s.category === 'security' && (s.severity === 'critical' || s.severity === 'high'),
    )
    if (security.length)
      pending.push({
        signal: 'Security review',
        delta: -Math.min(20, security.length * 8),
        note: `${security.length} finding(s), e.g. ${security[0].rule}`,
      })

    const reliability = confident.filter((s) => s.category !== 'security' && s.severity === 'high')
    if (reliability.length)
      pending.push({
        signal: 'Reliability review',
        delta: -Math.min(8, reliability.length * 4),
        note: `${reliability.length} high-severity finding(s)`,
      })

    const craft = confident.filter(
      (s) => (s.category === 'craft' || s.category === 'maintainability') && s.severity !== 'low',
    )
    if (craft.length)
      pending.push({
        signal: 'Code craft',
        delta: -Math.min(6, craft.length * 2),
        note: `${craft.length} craft finding(s)`,
      })

    const a11y = confident.filter((s) => s.category === 'accessibility')
    if (a11y.length)
      pending.push({
        signal: 'Accessibility',
        delta: -Math.min(6, a11y.length * 3),
        note: `${a11y.length} accessibility finding(s)`,
      })

    // Scale proportionally if the findings together would exceed the budget.
    const raw = pending.reduce((n, p) => n + p.delta, 0)
    const scale = raw < -REVIEW_BUDGET ? REVIEW_BUDGET / -raw : 1
    for (const item of pending) apply(item.signal, Math.round(item.delta * scale), item.note)
    if (!pending.length && input.review.filesInspected > 0)
      apply('Code review', 0, `No confident findings across ${input.review.rulesRun} rules`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const label: HealthScore['label'] =
    score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'needs attention'
  return { score, label, breakdown }
}
