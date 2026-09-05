import type { Dependency, RepoFile, Repository, ScanResult, ScanStage } from '../../shared/types.js'
import {
  detectEntryPoints,
  detectLanguages,
  detectManifests,
  detectRoutes,
  detectStorage,
} from './detect.js'
import { buildGraph } from './graph.js'
import { analyzeImports, workspaceDirectories } from './imports.js'
import { parseAll } from './parse.js'
import { runReview } from './review/index.js'
import { computeHealth } from './score.js'
import { buildTemplateSummary, templateProvider, type SummaryProvider } from './summary.js'
import { detectWarnings } from './warnings.js'

export type ProgressFn = (stage: ScanStage, progress: number, message?: string) => void

export interface AnalyzeOptions {
  provider?: SummaryProvider
  onProgress?: ProgressFn
}

const ECOSYSTEM_BY_LANG: Record<string, Dependency['ecosystem']> = {
  TypeScript: 'npm',
  JavaScript: 'npm',
  Vue: 'npm',
  Svelte: 'npm',
  Python: 'pypi',
  Go: 'go',
  Rust: 'cargo',
  'C#': 'nuget',
  Java: 'maven',
  Kotlin: 'maven',
  Ruby: 'rubygems',
  PHP: 'composer',
}

/** Run the full deterministic analysis on an in-memory file list. */
export async function analyzeRepository(
  repository: Repository,
  files: RepoFile[],
  options: AnalyzeOptions = {},
): Promise<ScanResult> {
  const progress = options.onProgress ?? (() => {})
  const provider = options.provider ?? templateProvider
  const tick = () => new Promise<void>((r) => setTimeout(r, 0))

  progress('structure', 25, `Detecting structure in ${files.length} files`)
  await tick()
  const languages = detectLanguages(files)
  const manifests = detectManifests(files)
  const entryPoints = detectEntryPoints(files, manifests.entryHints, workspaceDirectories(files))

  progress('dependencies', 45, 'Resolving imports')
  await tick()
  // Parse once; the import resolver and the review rules both read the result.
  const parsed = await parseAll(files, { structure: true })
  const { imports, diagnostics } = await analyzeImports(files, parsed)

  progress('services', 65, 'Identifying services, APIs and storage')
  await tick()
  const routes = detectRoutes(files)
  const storage = detectStorage(files, manifests.dependencies)
  const graph = buildGraph({
    files,
    imports,
    dependencies: manifests.dependencies,
    entryPoints,
    routes,
    storage,
    packageName: manifests.packageName ?? repository.name,
  })

  const hasImportsFor = new Set<Dependency['ecosystem']>()
  for (const l of languages) {
    const eco = ECOSYSTEM_BY_LANG[l.name]
    if (eco && l.files > 0) hasImportsFor.add(eco)
  }
  diagnostics.routesDetected = routes.length
  const warnings = detectWarnings({
    files,
    graph,
    dependencies: manifests.dependencies,
    entryPoints,
    hasImportsFor,
  })
  progress('review', 80, 'Reviewing code quality and security')
  await tick()
  const review = runReview({
    files,
    parsed,
    graph,
    dependencies: manifests.dependencies,
    routes,
    entryPoints,
    frameworks: manifests.frameworks,
    rootDependencies: manifests.rootDependencies,
  })

  const health = computeHealth({
    files,
    graph,
    warnings,
    dependencies: manifests.dependencies,
    review,
  })

  progress('summary', 90, 'Writing architecture summary')
  await tick()
  const stats = {
    files: files.length,
    lines: languages.reduce((n, l) => n + l.lines, 0),
    modules: graph.modules.length,
    connections: graph.moduleEdges.length,
    warnings: warnings.length,
  }
  const facts = {
    repository,
    diagnostics,
    review,
    languages,
    frameworks: manifests.frameworks,
    entryPoints,
    nodes: graph.nodes,
    edges: graph.edges,
    modules: graph.modules,
    dependencies: manifests.dependencies,
    warnings,
    health,
    stats,
  }
  const draft = buildTemplateSummary(facts)
  const summary = await provider.summarize(draft, facts)

  return { id: '', summary, ...facts }
}
