import type {
  Dependency,
  RepoFile,
  ReviewSummary,
  Suggestion,
  SuggestionSeverity,
} from '../../../shared/types.js'
import type { FileStructure, ParsedFile } from '../parse.js'
import type { GraphOutput } from '../graph.js'
import type { RouteInfo } from '../detect.js'
import {
  NON_SOURCE,
  NOT_PRODUCT_CODE,
  TEST_FILE,
  testBlockRanges,
  type ReviewContext,
  type Rule,
  type RuleResult,
} from './context.js'
import { CODE_LANGUAGES, languageOf } from '../detect.js'
import { securityRules } from './security.js'
import { craftRules } from './craft.js'
import { productRules } from './product.js'
import {
  EMPTY_CONFIG,
  isDisabled,
  isIgnored,
  loadReviewConfig,
  type ReviewConfig,
} from './config.js'

export { type Rule, type ReviewContext } from './context.js'
export { loadReviewConfig, matchesPattern, CONFIG_FILENAME, type ReviewConfig } from './config.js'

/**
 * The review pass: everything the analyzer can say about how the code is written, as
 * opposed to how it is arranged.
 *
 * Rules are independent pure functions. Each returns findings with a file, a line, why it
 * matters and what to change — a suggestion nobody can act on is worse than silence,
 * because it trains people to skim the list.
 *
 * This is static analysis over heuristics. It does not run the code, does not know the
 * product's requirements, and will occasionally be wrong; every finding carries a
 * confidence and cites its evidence so a reader can check it in seconds.
 */

export const ALL_RULES: Rule[] = [...securityRules, ...craftRules, ...productRules]

const SEVERITY_ORDER: Record<SuggestionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const CONFIDENCE_ORDER = { certain: 0, likely: 1, possible: 2 } as const

export interface ReviewInput {
  files: RepoFile[]
  parsed: Map<string, ParsedFile>
  graph: GraphOutput
  dependencies: Dependency[]
  routes: RouteInfo[]
  entryPoints: string[]
  frameworks: string[]
  /** Dependencies declared at the repository root; see ManifestInfo. */
  rootDependencies?: Set<string>
  rules?: Rule[]
  /** Repository-owned overrides; read from `.reposcope.json` when not supplied. */
  config?: ReviewConfig
}

/**
 * Drop everything the parser found inside an in-file test block, so the structural rules see
 * only shipped code. Rust puts its tests in `#[cfg(test)] mod tests` next to the code they
 * cover; excluding test *files* alone would leave a crate being told off for the duplication
 * in its own fixtures.
 */
function withoutTestBlocks(structure: FileStructure, ranges: [number, number][]): FileStructure {
  if (!ranges.length) return structure
  const inside = (line: number) => ranges.some(([start, end]) => line >= start && line <= end)
  const keep = <T extends { line: number }>(items: T[]) => items.filter((i) => !inside(i.line))
  return {
    ...structure,
    functions: keep(structure.functions),
    catches: keep(structure.catches),
    calls: keep(structure.calls),
    comments: keep(structure.comments),
    elements: keep(structure.elements),
    attributes: keep(structure.attributes),
    strings: keep(structure.strings),
  }
}

export function buildReviewContext(input: ReviewInput): ReviewContext {
  const byPath = new Map(input.files.map((f) => [f.path, f]))
  const config = input.config ?? EMPTY_CONFIG
  // What the review judges: code the project ships, in a language it understands, minus
  // anything the repository asked to be left alone.
  const sourceFiles = input.files.filter((f) => {
    if (!f.content) return false
    if (NON_SOURCE.test(f.path) || TEST_FILE.test(f.path) || NOT_PRODUCT_CODE.test(f.path))
      return false
    if (isIgnored(config, f.path)) return false
    const lang = languageOf(f.path)
    return !!lang && CODE_LANGUAGES.has(lang)
  })
  const sourceSet = new Set(sourceFiles.map((f) => f.path))
  const structures = [...input.parsed.entries()]
    .filter(([path, p]) => p.structure && sourceSet.has(path))
    .map(([path, p]) => {
      const file = byPath.get(path)!
      return { file, structure: withoutTestBlocks(p.structure!, testBlockRanges(file)) }
    })
  const depNames = new Set(input.dependencies.map((d) => d.name))
  const sourceRoutes = input.routes.filter(
    (r) => !NOT_PRODUCT_CODE.test(r.file) && !TEST_FILE.test(r.file) && !NON_SOURCE.test(r.file),
  )

  // An application depends on a web or app framework and has code that serves or renders.
  // A framework itself matches neither: it declares no such dependency.
  const APP_FRAMEWORKS = [
    'express',
    'fastify',
    'koa',
    'hono',
    '@nestjs/core',
    'next',
    'nuxt',
    'react',
    'vue',
    'svelte',
    '@sveltejs/kit',
    '@angular/core',
    'astro',
    'remix',
    'flask',
    'django',
    'fastapi',
    'starlette',
    'rails',
    'laravel/framework',
    'gin-gonic',
    'actix-web',
    'axum',
  ]
  const declared = input.rootDependencies ?? depNames
  const dependsOnFramework = APP_FRAMEWORKS.some((name) =>
    [...declared].some((d) => d === name || d.endsWith('/' + name)),
  )
  const isApplication = dependsOnFramework && sourceRoutes.length + input.entryPoints.length > 0

  const testBlocks = new Map<string, [number, number][]>()

  return {
    files: input.files,
    byPath,
    parsed: input.parsed,
    graph: input.graph,
    dependencies: input.dependencies,
    routes: input.routes,
    entryPoints: input.entryPoints,
    frameworks: new Set(input.frameworks),
    sourceFiles,
    structures,
    sourceRoutes,
    isApplication,
    hasDependency: (name) =>
      depNames.has(name) || [...depNames].some((d) => d.startsWith(name) || name.startsWith(d)),
    inTestBlock(path, line) {
      let ranges = testBlocks.get(path)
      if (!ranges) {
        const file = byPath.get(path)
        ranges = file ? testBlockRanges(file) : []
        testBlocks.set(path, ranges)
      }
      return ranges.some(([start, end]) => line >= start && line <= end)
    },
    excerpt(path, line) {
      const text = byPath.get(path)?.content
      if (!text) return undefined
      const raw = text.split('\n')[line - 1]
      if (raw === undefined) return undefined
      const trimmed = raw.trim()
      return trimmed.length > 160 ? trimmed.slice(0, 157) + '…' : trimmed
    },
  }
}

/** Words whose presence on a line means every literal on it is treated as a credential. */
const SECRET_WORDS = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'apikey',
  'key',
  'keys',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'privatekey',
  'connectionstring',
  'dsn',
  'cert',
  'certificate',
  'signature',
  'salt',
])

/** Literal prefixes of well-known credential formats, which are never safe to display. */
const KEY_PREFIX =
  /(['"`])(AKIA[0-9A-Z]{6,}|gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{8,})[^'"`]*\1/g

/**
 * Split a line into the words its identifiers are made of, so `JWT_SECRET`, `authToken` and
 * `api-key` all yield their parts.
 *
 * A plain `\bsecret\b` test does not: `_` is a word character, so `JWT_SECRET` never matches
 * it. That gap let `process.env.JWT_SECRET || 'superSecret'` print its fallback value.
 */
function identifierWords(line: string): string[] {
  return line
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))
    .map((w) => w.toLowerCase())
    .filter(Boolean)
}

/**
 * Redact anything that could be a credential before an excerpt is shown or exported.
 *
 * The rule is deliberately blunt: on a line that names a secret, every string literal is
 * replaced. A finding is still actionable with the value hidden — it cites the file and
 * line — and showing one real secret once is worse than redacting a hundred harmless
 * strings. It errs towards redaction, but not so far that `author: 'Jane Doe'` disappears.
 */
export function redact(excerpt: string | undefined): string | undefined {
  if (!excerpt) return excerpt
  let out = excerpt
  if (identifierWords(out).some((w) => SECRET_WORDS.has(w))) {
    out = out.replace(/(['"`])(?:(?!\1)[^\\]|\\.){3,}?\1/g, '$1[redacted]$1')
  }
  return (
    out
      // Recognisable credential formats, wherever they appear.
      .replace(KEY_PREFIX, '$1[redacted]$1')
      // Long opaque literals: keys, tokens, hashes.
      .replace(/(['"`])[A-Za-z0-9+/_-]{24,}\1/g, '$1[redacted]$1')
      // Credentials embedded in a URL.
      .replace(/(:\/\/[^:@\s/]+:)[^@\s/]+@/g, '$1[redacted]@')
  )
}

export function runReview(input: ReviewInput): ReviewSummary {
  const config = input.config ?? loadReviewConfig(input.files)
  const ctx = buildReviewContext({ ...input, config })
  const allRules = input.rules ?? ALL_RULES
  const rules = allRules.filter((r) => !isDisabled(config, r.id))
  const suggestions: Suggestion[] = []
  let seq = 0

  for (const rule of rules) {
    let produced: RuleResult | RuleResult[] | undefined
    try {
      produced = rule.run(ctx)
    } catch {
      // A rule that throws is a bug in the rule, not a reason to lose the whole review.
      continue
    }
    if (!produced) continue
    for (const result of Array.isArray(produced) ? produced : [produced]) {
      suggestions.push({
        id: `s${++seq}`,
        rule: rule.id,
        category: rule.category,
        severity:
          config.severity[rule.id] === undefined || config.severity[rule.id] === 'off'
            ? (result.severity ?? rule.severity)
            : (config.severity[rule.id] as SuggestionSeverity),
        confidence: result.confidence ?? rule.confidence ?? 'likely',
        title: result.title,
        detail: result.detail,
        fix: result.fix,
        effort: result.effort ?? rule.effort ?? 'moderate',
        evidence: (result.evidence ?? []).map((e) => ({ ...e, excerpt: redact(e.excerpt) })),
        occurrences: result.occurrences,
        nodeId: nodeForEvidence(input.graph, result),
      })
    }
  }

  suggestions.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      (b.occurrences ?? 1) - (a.occurrences ?? 1),
  )

  const byCategory: ReviewSummary['byCategory'] = {}
  const bySeverity: ReviewSummary['bySeverity'] = {}
  for (const s of suggestions) {
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1
    bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1
  }

  return {
    suggestions,
    byCategory,
    bySeverity,
    rulesRun: rules.length,
    filesInspected: ctx.structures.length,
    sourceFileCount: ctx.sourceFiles.length,
    configured: config.source
      ? {
          source: config.source,
          rulesDisabled: allRules.length - rules.length,
          pathsIgnored: config.ignore.length,
          problems: config.problems,
        }
      : undefined,
  }
}

/** Attach a finding to the module that owns its first piece of evidence, for the inspector. */
function nodeForEvidence(graph: GraphOutput, result: RuleResult): string | undefined {
  const first = result.evidence?.[0]?.path
  if (!first) return undefined
  return graph.fileModule.get(first)
}
