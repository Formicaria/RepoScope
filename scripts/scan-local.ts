/**
 * Scan a folder on disk from the command line and print the analysis summary.
 * Usage: npm run scan:local -- ./path/to/repo [--json]
 */
import { readRepositoryFromDisk } from '../server/analyzer/ingest.js'
import { analyzeRepository } from '../server/analyzer/index.js'

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: npm run scan:local -- <folder> [--json]')
  process.exit(1)
}
const files = await readRepositoryFromDisk(dir)
const name = dir.replace(/\/+$/, '').split('/').pop() ?? 'repo'
const started = Date.now()
const result = await analyzeRepository(
  { name, fullName: name, source: 'upload', scannedAt: new Date().toISOString() },
  files,
)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(
    `${result.repository.name} — analysed ${result.stats.files} files in ${Date.now() - started} ms`,
  )
  console.log(
    `health ${result.health.score}/100 (${result.health.label}) · ${result.stats.modules} modules · ${result.stats.connections} connections · ${result.stats.warnings} warnings`,
  )
  console.log(`frameworks: ${result.frameworks.join(', ') || '—'}`)
  console.log(`entry points: ${result.entryPoints.join(', ') || '—'}`)
  console.log()
  console.log(result.summary.headline)
  console.log(result.summary.description)
  console.log(result.summary.architecture)
  console.log()
  for (const n of result.nodes.filter((n) => !n.parent))
    console.log(
      `  ${n.type.padEnd(11)} ${n.name.padEnd(32)} importance ${String(Math.round(n.importance * 100)).padStart(3)}%  deps ${n.dependencies.length}  dependents ${n.dependents.length}`,
    )
  console.log()
  for (const w of result.warnings) console.log(`  [${w.severity}] ${w.title}`)
}
