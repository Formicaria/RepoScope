import type { Dependency, HealthScore, RepoFile, Warning } from '../../shared/types.js'
import type { GraphOutput } from './graph.js'

export interface ScoreInput {
  files: RepoFile[]
  graph: GraphOutput
  warnings: Warning[]
  dependencies: Dependency[]
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

  const count = (kind: Warning['kind']) => warnings.filter((w) => w.kind === kind)
  const paths = files.map((f) => f.path)

  // Tests
  const missing = count('missing-tests')
  if (missing.some((w) => w.severity === 'critical'))
    apply('Tests', -25, 'No automated tests detected')
  else if (missing.some((w) => w.severity === 'warning'))
    apply('Tests', -12, 'Test coverage looks sparse')
  else if (missing.length)
    apply('Tests', -Math.min(8, missing.length * 2), `${missing.length} module(s) without tests`)
  else apply('Tests', 0, 'Tests present')

  // Secrets
  // Only real findings are penalised. Secrets inside test fixtures are reported at info
  // severity because committing throwaway keys and .env files there is normal and deliberate.
  const secrets = count('exposed-secret').filter((w) => w.severity !== 'info')
  const fixtureSecrets = count('exposed-secret').length - secrets.length
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
      -Math.min(15, cycles.length * 4),
      `${cycles.length} import cycle(s)`,
    )
  else apply('Circular dependencies', 0, 'No import cycles')

  // Complexity
  const complexity = count('excessive-complexity')
  if (complexity.length)
    apply(
      'Complexity',
      -Math.min(12, complexity.length * 3),
      `${complexity.length} complexity warning(s)`,
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
    apply('Dead modules', -Math.min(8, dead.length * 2), `${dead.length} unreferenced module(s)`)
  const entry = count('unclear-entry')
  if (entry.some((w) => w.severity === 'warning')) apply('Entry point', -6, 'No clear entry point')
  const large = count('large-file')
  if (large.length)
    apply('Large files', -Math.min(6, large.length * 2), `${large.length} very large file(s)`)

  score = Math.max(0, Math.min(100, Math.round(score)))
  const label: HealthScore['label'] =
    score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'needs attention'
  return { score, label, breakdown }
}
