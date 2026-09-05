/**
 * Accuracy benchmark.
 *
 * Scans a fixed corpus of public repositories and records what the analyzer found, so an
 * analyzer change can be judged by its effect on real projects instead of by intuition.
 *
 *   npm run bench            scan the corpus and write benchmarks/snapshot.json
 *   npm run bench -- --diff  scan and print the delta against the committed snapshot
 *   npm run bench -- --only express,flask
 *
 * The headline metric is `unresolvedLocalRate`: the share of import specifiers that
 * unambiguously point inside the repository but could not be resolved to a file. Those are
 * always analyzer gaps, so the number is ground truth that needs no hand labelling.
 * Lower is better. `coverage` (share of files parsed with a real grammar) and the node-type
 * histogram catch regressions in classification.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { simpleGit } from 'simple-git'
import { analyzeRepository } from '../server/analyzer/index.js'
import { readRepositoryFromDisk } from '../server/analyzer/ingest.js'
import type { NodeType, ScanResult, WarningKind } from '../shared/types.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.bench-cache')
const SNAPSHOT = path.join(ROOT, 'benchmarks', 'snapshot.json')

interface CorpusEntry {
  name: string
  url: string
  why?: string
}

export interface RepoMetrics {
  name: string
  commit: string
  files: number
  lines: number
  modules: number
  moduleEdges: number
  fileEdges: number
  /** Share of code files whose imports came from a syntax tree (0–1). */
  coverage: number
  specifiers: number
  resolvedInternal: number
  external: number
  unresolvedLocal: number
  /** unresolvedLocal / (resolvedInternal + unresolvedLocal) — the headline metric. */
  unresolvedLocalRate: number
  entryPoints: string[]
  frameworks: string[]
  routes: number
  nodeTypes: Partial<Record<NodeType, number>>
  warningKinds: Partial<Record<WarningKind, number>>
  health: number
  /** Review findings, and how many are high-severity — a proxy for false-positive noise. */
  suggestions: number
  suggestionsHigh: number
  suggestionRules: string[]
  ms: number
  /** A few examples, to make a regression debuggable without re-running. */
  unresolvedSamples: string[]
}

export interface Snapshot {
  generatedAt: string
  analyzer: string
  repos: RepoMetrics[]
}

async function ensureClone(entry: CorpusEntry): Promise<string> {
  const dir = path.join(CACHE, entry.name)
  const exists = await fs
    .stat(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    await fs.mkdir(CACHE, { recursive: true })
    await fs.rm(dir, { recursive: true, force: true })
    process.stdout.write(`  cloning ${entry.url}\n`)
    await simpleGit({ timeout: { block: 180_000 } }).clone(entry.url, dir, [
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
    ])
  }
  const sha = await simpleGit(dir).revparse(['HEAD'])
  return sha.trim()
}

function tally<T extends string>(items: T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {}
  for (const i of items) out[i] = (out[i] ?? 0) + 1
  return out
}

async function measure(entry: CorpusEntry): Promise<RepoMetrics> {
  const commit = await ensureClone(entry)
  const dir = path.join(CACHE, entry.name)
  const files = await readRepositoryFromDisk(dir)
  const started = Date.now()
  const result: ScanResult = await analyzeRepository(
    {
      name: entry.name,
      fullName: entry.url.replace(/^https?:\/\/github\.com\//, ''),
      url: entry.url,
      source: 'github',
      scannedAt: new Date().toISOString(),
    },
    files,
  )
  const ms = Date.now() - started
  const d = result.diagnostics
  const top = result.nodes.filter((n) => !n.parent)
  const resolvable = (d?.resolvedInternal ?? 0) + (d?.unresolvedLocal.length ?? 0)

  return {
    name: entry.name,
    commit: commit.slice(0, 10),
    files: result.stats.files,
    lines: result.stats.lines,
    modules: result.stats.modules,
    moduleEdges: result.stats.connections,
    fileEdges: result.edges.length,
    coverage: round(
      (d?.parsedFiles ?? 0) / Math.max(1, (d?.parsedFiles ?? 0) + (d?.regexFiles ?? 0)),
    ),
    specifiers: d?.totalSpecifiers ?? 0,
    resolvedInternal: d?.resolvedInternal ?? 0,
    external: d?.external ?? 0,
    unresolvedLocal: d?.unresolvedLocal.length ?? 0,
    unresolvedLocalRate: round((d?.unresolvedLocal.length ?? 0) / Math.max(1, resolvable)),
    entryPoints: result.entryPoints,
    frameworks: result.frameworks,
    // Routes detected, not the per-module display subset — the metric must track truth.
    routes: d?.routesDetected ?? 0,
    nodeTypes: tally(top.map((n) => n.type)),
    warningKinds: tally(result.warnings.map((w) => w.kind)),
    health: result.health.score,
    suggestions: result.review?.suggestions.length ?? 0,
    suggestionsHigh:
      result.review?.suggestions.filter((s) => s.severity === 'critical' || s.severity === 'high')
        .length ?? 0,
    suggestionRules: [...new Set(result.review?.suggestions.map((s) => s.rule) ?? [])].sort(),
    ms,
    unresolvedSamples: [...new Set((d?.unresolvedLocal ?? []).map((u) => u.raw))].slice(0, 8),
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function fmtDelta(
  before: number | undefined,
  after: number,
  opts: { lowerIsBetter?: boolean } = {},
) {
  if (before === undefined) return `${after} (new)`
  const diff = round(after - before)
  if (diff === 0) return `${after}`
  const better = opts.lowerIsBetter ? diff < 0 : diff > 0
  const mark = better ? '▲' : '▼'
  return `${before} → ${after}  ${mark}${diff > 0 ? '+' : ''}${diff}`
}

async function main() {
  const args = process.argv.slice(2)
  const diffMode = args.includes('--diff')
  const onlyIndex = args.findIndex((a) => a === '--only' || a.startsWith('--only='))
  const only =
    onlyIndex === -1
      ? undefined
      : (args[onlyIndex].includes('=')
          ? args[onlyIndex].split('=')[1]
          : args[onlyIndex + 1]
        )?.split(',')

  const corpus: { repos: CorpusEntry[] } = JSON.parse(
    await fs.readFile(path.join(ROOT, 'benchmarks', 'corpus.json'), 'utf8'),
  )
  const repos = corpus.repos.filter((r) => !only || only.includes(r.name))

  let previous: Snapshot | undefined
  try {
    previous = JSON.parse(await fs.readFile(SNAPSHOT, 'utf8')) as Snapshot
  } catch {
    /* first run */
  }

  const metrics: RepoMetrics[] = []
  for (const entry of repos) {
    process.stdout.write(`\n${entry.name}\n`)
    try {
      const m = await measure(entry)
      metrics.push(m)
      const before = previous?.repos.find((r) => r.name === entry.name)
      process.stdout.write(
        `  files ${m.files} · modules ${m.modules} · module edges ${fmtDelta(before?.moduleEdges, m.moduleEdges)}\n` +
          `  parse coverage ${fmtDelta(before?.coverage, m.coverage)} · resolved ${fmtDelta(before?.resolvedInternal, m.resolvedInternal)}\n` +
          `  unresolved-local ${fmtDelta(before?.unresolvedLocal, m.unresolvedLocal, { lowerIsBetter: true })}` +
          ` (rate ${fmtDelta(before?.unresolvedLocalRate, m.unresolvedLocalRate, { lowerIsBetter: true })})\n` +
          `  routes ${fmtDelta(before?.routes, m.routes)} · entries ${m.entryPoints.length} · health ${fmtDelta(before?.health, m.health)} · ${m.ms} ms\n` +
          `  review ${fmtDelta(before?.suggestions, m.suggestions, { lowerIsBetter: true })} findings, ${fmtDelta(before?.suggestionsHigh, m.suggestionsHigh, { lowerIsBetter: true })} high\n`,
      )
      if (m.unresolvedSamples.length) {
        process.stdout.write(`  unresolved e.g. ${m.unresolvedSamples.slice(0, 5).join(', ')}\n`)
      }
      if (before && before.commit !== m.commit) {
        process.stdout.write(
          `  note: commit changed ${before.commit} → ${m.commit}; deltas include upstream drift\n`,
        )
      }
    } catch (err) {
      process.stdout.write(
        `  FAILED: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}\n`,
      )
    }
  }

  const totals = metrics.reduce(
    (a, m) => ({
      resolved: a.resolved + m.resolvedInternal,
      unresolved: a.unresolved + m.unresolvedLocal,
      edges: a.edges + m.fileEdges,
      ms: a.ms + m.ms,
    }),
    { resolved: 0, unresolved: 0, edges: 0, ms: 0 },
  )
  const rate = round(totals.unresolved / Math.max(1, totals.resolved + totals.unresolved))
  // Compare like with like: when --only narrows the run, the baseline must narrow too.
  const scanned = new Set(metrics.map((m) => m.name))
  const prevTotals = previous?.repos
    .filter((r) => scanned.has(r.name))
    .reduce(
      (a, m) => ({
        resolved: a.resolved + m.resolvedInternal,
        unresolved: a.unresolved + m.unresolvedLocal,
      }),
      { resolved: 0, unresolved: 0 },
    )
  const prevRate =
    prevTotals && prevTotals.resolved + prevTotals.unresolved > 0
      ? round(prevTotals.unresolved / Math.max(1, prevTotals.resolved + prevTotals.unresolved))
      : undefined

  process.stdout.write(
    `\ncorpus: ${metrics.length} repos · ${totals.resolved} resolved imports · ${totals.edges} file edges · ${(totals.ms / 1000).toFixed(1)}s\n` +
      `unresolved-local rate: ${fmtDelta(prevRate, rate, { lowerIsBetter: true })}\n`,
  )

  if (!diffMode) {
    const snapshot: Snapshot = {
      generatedAt: new Date().toISOString(),
      analyzer: JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version,
      repos: metrics,
    }
    await fs.mkdir(path.dirname(SNAPSHOT), { recursive: true })
    await fs.writeFile(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n')
    process.stdout.write(`wrote ${path.relative(ROOT, SNAPSHOT)}\n`)
  }
}

await main()
