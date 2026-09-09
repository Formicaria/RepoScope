import type { AnalysisCoverage, LanguageStat, RepoFile } from '../../shared/types.js'
import type { GraphOutput } from './graph.js'
import { CODE_LANGUAGES, languageOf } from './detect.js'

/**
 * How much of this repository the analyzer could actually see.
 *
 * This exists because of a specific failure. Scanning a Rails application, RepoScope
 * resolved one import across ninety-seven files — Rails autoloads, so the explicit imports
 * every other part of the analyzer depends on simply are not written — and then reported
 * 82/100, "good", with a summary describing which layer talked to which. Every
 * graph-derived signal had scored zero because there was no graph, and zero evidence had
 * been read as zero problems.
 *
 * A tool that cannot see something must say so. Coverage is what lets the score withhold
 * the signals it could not measure, and the summary stop asserting relationships it never
 * observed.
 */

/**
 * Import resolution per language, as actually implemented in `imports.ts`.
 *
 * `full` — specifiers are resolved to files.
 * `partial` — only some forms resolve (relative requires, namespaces).
 * `none` — the language does not write imports the analyzer can follow, whether because it
 *   autoloads (Ruby on Rails), or because resolution is not implemented yet. Files are still
 *   counted, parsed and reviewed; they just cannot be placed in the graph.
 */
export const RESOLUTION: Record<string, 'full' | 'partial' | 'none'> = {
  TypeScript: 'full',
  JavaScript: 'full',
  Vue: 'full',
  Svelte: 'full',
  Astro: 'full',
  Python: 'full',
  Go: 'full',
  Rust: 'full',
  'C#': 'full',
  Java: 'full',
  Kotlin: 'full',
  Scala: 'full',
  PHP: 'partial',
  Ruby: 'partial',
  Dart: 'partial',
  C: 'partial',
  'C++': 'partial',
}

/**
 * Below this share of source files carrying at least one import edge, the structural
 * signals are not measuring the repository — they are measuring the analyzer's blind spot.
 * A tenth is deliberately low: real projects with a few standalone scripts stay above it,
 * and a repository the analyzer genuinely cannot follow falls far below.
 */
const MINIMAL = 0.1
const PARTIAL = 0.4

export function computeCoverage(
  files: RepoFile[],
  languages: LanguageStat[],
  graph: GraphOutput,
): AnalysisCoverage {
  const sourceFiles = files.filter((f) => {
    const lang = languageOf(f.path)
    return !!lang && CODE_LANGUAGES.has(lang)
  })

  const connected = new Set<string>()
  for (const e of graph.edges) {
    if (e.type !== 'imports') continue
    if (e.source.startsWith('file:')) connected.add(e.source.slice(5))
    if (e.target.startsWith('file:')) connected.add(e.target.slice(5))
  }

  const total = sourceFiles.length
  const connectedness = total === 0 ? 1 : connected.size / total

  // Languages carrying real weight in this repository whose imports we cannot fully follow.
  const significant = languages.filter((l) => l.files >= Math.max(3, total * 0.1))
  const limitedLanguages = significant
    .filter((l) => (RESOLUTION[l.name] ?? 'none') !== 'full')
    .map((l) => l.name)

  const level: AnalysisCoverage['level'] =
    total === 0 || connectedness >= PARTIAL
      ? 'full'
      : connectedness >= MINIMAL
        ? 'partial'
        : 'minimal'

  return {
    sourceFiles: total,
    connectedFiles: connected.size,
    connectedness: Math.round(connectedness * 100) / 100,
    level,
    limitedLanguages,
    note: noteFor(level, connected.size, total, limitedLanguages),
  }
}

function noteFor(
  level: AnalysisCoverage['level'],
  connected: number,
  total: number,
  limited: string[],
): string {
  if (level === 'full') return `${connected} of ${total} source files are placed in the graph.`

  const because = limited.length
    ? ` ${listOf(limited)} ${limited.length === 1 ? 'does' : 'do'} not write imports this analyzer can follow — ${limited.includes('Ruby') ? 'Rails autoloads rather than importing, so the relationships are conventions rather than statements in the code' : 'only some import forms resolve'}.`
    : ''

  if (level === 'minimal') {
    return (
      `Only ${connected} of ${total} source files could be connected to another file.${because}` +
      ' Structural findings — import cycles, module cohesion, unreferenced modules — were' +
      ' left out of the score rather than reported as clean, because there was no graph to' +
      ' judge them against.'
    )
  }
  return (
    `${connected} of ${total} source files are placed in the graph.${because}` +
    ' Structural findings cover the part that resolved, so treat them as a floor rather than' +
    ' the whole picture.'
  )
}

function listOf(names: string[]): string {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
