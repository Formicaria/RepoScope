import type {
  Dependency,
  RepoFile,
  ReviewSummary,
  Suggestion,
  SuggestionSeverity,
} from '../../../shared/types.js'
import type { ParsedFile } from '../parse.js'
import type { GraphOutput } from '../graph.js'
import type { RouteInfo } from '../detect.js'
import {
  NON_SOURCE,
  NOT_PRODUCT_CODE,
  TEST_FILE,
  type ReviewContext,
  type Rule,
  type RuleResult,
} from './context.js'
import { CODE_LANGUAGES, languageOf } from '../detect.js'
import { securityRules } from './security.js'
import { craftRules } from './craft.js'
import { productRules } from './product.js'

export { type Rule, type ReviewContext } from './context.js'

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
}

export function buildReviewContext(input: ReviewInput): ReviewContext {
  const byPath = new Map(input.files.map((f) => [f.path, f]))
  // What the review judges: code the project ships, in a language it understands.
  const sourceFiles = input.files.filter((f) => {
    if (!f.content) return false
    if (NON_SOURCE.test(f.path) || TEST_FILE.test(f.path) || NOT_PRODUCT_CODE.test(f.path))
      return false
    const lang = languageOf(f.path)
    return !!lang && CODE_LANGUAGES.has(lang)
  })
  const sourceSet = new Set(sourceFiles.map((f) => f.path))
  const structures = [...input.parsed.entries()]
    .filter(([path, p]) => p.structure && sourceSet.has(path))
    .map(([path, p]) => ({ file: byPath.get(path)!, structure: p.structure! }))
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
const SECRET_CONTEXT =
  /\b(secret|token|password|passwd|pwd|api[_-]?key|apikey|auth|credential|private[_-]?key|connection[_-]?string|dsn)\b/i

/**
 * Redact anything that could be a credential before an excerpt is shown or exported.
 *
 * The rule is deliberately blunt: on a line that mentions a secret by name, every string
 * literal is replaced. A finding is still actionable with the value hidden — it cites the
 * file and line — and showing one real secret once is worse than redacting a hundred
 * harmless strings.
 */
export function redact(excerpt: string | undefined): string | undefined {
  if (!excerpt) return excerpt
  let out = excerpt
  if (SECRET_CONTEXT.test(out)) {
    out = out.replace(/(['"`])(?:(?!\1)[^\\]|\\.){4,}?\1/g, '$1[redacted]$1')
  }
  return (
    out
      // Long opaque literals anywhere: keys, tokens, hashes.
      .replace(/(['"`])[A-Za-z0-9+/_-]{24,}\1/g, '$1[redacted]$1')
      // Credentials embedded in a URL.
      .replace(/(:\/\/[^:@\s/]+:)[^@\s/]+@/g, '$1[redacted]@')
  )
}

export function runReview(input: ReviewInput): ReviewSummary {
  const ctx = buildReviewContext(input)
  const rules = input.rules ?? ALL_RULES
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
        severity: result.severity ?? rule.severity,
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
  }
}

/** Attach a finding to the module that owns its first piece of evidence, for the inspector. */
function nodeForEvidence(graph: GraphOutput, result: RuleResult): string | undefined {
  const first = result.evidence?.[0]?.path
  if (!first) return undefined
  return graph.fileModule.get(first)
}
