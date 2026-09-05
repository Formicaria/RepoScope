/**
 * Scan a folder from the command line.
 *
 *   npm run scan:local -- ./path/to/repo              summary, map and review
 *   npm run scan:local -- ./repo --json               the full ScanResult
 *   npm run scan:local -- ./repo --review             only the review findings
 *   npm run scan:local -- ./repo --fail-on=high       exit 1 if anything at or above `high`
 *   npm run scan:local -- ./repo --category=security  filter the findings
 *
 * `--fail-on` is what makes this usable in CI: it turns the review into a gate that reports
 * exactly which findings failed the build and where they are.
 */
import { readRepositoryFromDisk } from '../server/analyzer/ingest.js'
import { analyzeRepository } from '../server/analyzer/index.js'
import type { ScanResult, Suggestion, SuggestionSeverity } from '../shared/types.js'

const SEVERITY_RANK: Record<SuggestionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('-'))
if (!dir) {
  console.error('Usage: npm run scan:local -- <folder> [--json] [--review] [--fail-on=<severity>]')
  process.exit(1)
}

const flag = (name: string): string | undefined => {
  const withValue = args.find((a) => a.startsWith(`--${name}=`))
  if (withValue) return withValue.split('=').slice(1).join('=')
  return args.includes(`--${name}`) ? '' : undefined
}

const asJson = args.includes('--json')
const reviewOnly = args.includes('--review')
const failOn = flag('fail-on') as SuggestionSeverity | '' | undefined
const categoryFilter = flag('category')

const files = await readRepositoryFromDisk(dir)
const name = dir.replace(/\/+$/, '').split('/').pop() ?? 'repo'
const started = Date.now()
const result: ScanResult = await analyzeRepository(
  { name, fullName: name, source: 'upload', scannedAt: new Date().toISOString() },
  files,
)
const elapsed = Date.now() - started

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(exitCode())
}

const review = result.review
const findings = (review?.suggestions ?? []).filter(
  (s) => !categoryFilter || s.category === categoryFilter,
)

if (!reviewOnly) {
  console.log(
    `${result.repository.name} — ${result.stats.files} files analysed in ${elapsed} ms\n` +
      `health ${result.health.score}/100 (${result.health.label}) · ${result.stats.modules} modules · ` +
      `${result.stats.connections} connections · ${result.stats.warnings} warnings · ${findings.length} review findings\n` +
      `frameworks: ${result.frameworks.join(', ') || '—'}\n` +
      `entry points: ${result.entryPoints.join(', ') || '—'}\n`,
  )
  console.log(result.summary.headline)
  console.log(result.summary.description)
  console.log(result.summary.architecture)
  console.log()
  for (const n of result.nodes.filter((x) => !x.parent)) {
    console.log(
      `  ${n.type.padEnd(11)} ${n.name.padEnd(30)} ${String(Math.round(n.importance * 100)).padStart(3)}%  ` +
        `deps ${n.dependencies.length}  used by ${n.dependents.length}`,
    )
  }
  console.log()
  for (const w of result.warnings) console.log(`  [${w.severity}] ${w.title}`)
  console.log()
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

console.log(
  `Code review — ${findings.length} finding${findings.length === 1 ? '' : 's'} from ` +
    `${review?.rulesRun ?? 0} rules across ${review?.filesInspected ?? 0} source files`,
)
if (review?.configured) {
  console.log(
    `  (tuned by ${review.configured.source}: ${review.configured.rulesDisabled} rules disabled, ` +
      `${review.configured.pathsIgnored} path patterns ignored)`,
  )
  for (const problem of review.configured.problems) console.log(`  ! ${problem}`)
}
if (review && review.filesInspected === 0 && review.sourceFileCount > 0) {
  console.log(
    `  ! No source file could be parsed, so the structural rules did not run. Install the\n` +
      `    optional tree-sitter grammars to enable them.`,
  )
}
console.log()

for (const s of findings) {
  console.log(`  ${severityTag(s.severity)} ${s.title}`)
  console.log(
    `     ${s.category} · ${s.effort}${s.confidence !== 'certain' ? ` · ${s.confidence}` : ''} · ${s.rule}`,
  )
  console.log(`     ${wrap(s.detail, 5)}`)
  console.log(`     Fix: ${wrap(s.fix, 5).trimStart()}`)
  for (const e of s.evidence) {
    console.log(`       ${e.path}${e.line ? `:${e.line}` : ''}`)
    if (e.excerpt) console.log(`         ${e.excerpt}`)
  }
  if (s.occurrences && s.occurrences > s.evidence.length) {
    console.log(`       …and ${s.occurrences - s.evidence.length} more`)
  }
  console.log()
}

if (!findings.length) {
  console.log('  Nothing to flag.\n')
}

const code = exitCode()
if (code !== 0) {
  const threshold = (failOn || 'high') as SuggestionSeverity
  const failing = findings.filter((s) => SEVERITY_RANK[s.severity] <= SEVERITY_RANK[threshold])
  console.log(
    `Failing: ${failing.length} finding${failing.length === 1 ? '' : 's'} at or above "${threshold}".`,
  )
}
process.exit(code)

function exitCode(): number {
  if (failOn === undefined) return 0
  const threshold = (failOn || 'high') as SuggestionSeverity
  if (SEVERITY_RANK[threshold] === undefined) {
    console.error(`--fail-on must be one of critical, high, medium, low (got "${failOn}")`)
    return 2
  }
  const failing = (result.review?.suggestions ?? []).filter(
    (s: Suggestion) =>
      (!categoryFilter || s.category === categoryFilter) &&
      SEVERITY_RANK[s.severity] <= SEVERITY_RANK[threshold],
  )
  return failing.length ? 1 : 0
}

function severityTag(severity: SuggestionSeverity): string {
  return `[${severity}]`.padEnd(11)
}

/** Wrap prose to a readable width so a terminal does not have to. */
function wrap(text: string, indent: number): string {
  const width = 92
  const pad = ' '.repeat(indent)
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.join(`\n${pad}`)
}
