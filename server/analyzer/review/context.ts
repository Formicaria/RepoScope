import type {
  Dependency,
  Evidence,
  RepoFile,
  Suggestion,
  SuggestionCategory,
  SuggestionConfidence,
  SuggestionSeverity,
} from '../../../shared/types.js'
import type { FileStructure, ParsedFile } from '../parse.js'
import type { GraphOutput } from '../graph.js'
import type { RouteInfo } from '../detect.js'

/**
 * What a rule gets to look at.
 *
 * Rules are pure functions over this context. They never read the filesystem, never call
 * out, and never depend on each other, so a rule can be read, tested and removed on its own.
 */
export interface ReviewContext {
  files: RepoFile[]
  /** Files that carry text content, indexed by path. */
  byPath: Map<string, RepoFile>
  parsed: Map<string, ParsedFile>
  graph: GraphOutput
  dependencies: Dependency[]
  routes: RouteInfo[]
  entryPoints: string[]
  frameworks: Set<string>
  /** Source files worth reviewing: code, not tests, vendored code or generated output. */
  sourceFiles: RepoFile[]
  /** Structural facts for source files that parsed. */
  structures: { file: RepoFile; structure: FileStructure }[]
  /** Routes declared by shipped code, ignoring examples, docs and tests. */
  sourceRoutes: RouteInfo[]
  /**
   * True when this repository *is* an application rather than a library or a framework.
   *
   * The distinction matters: telling Express it should add `helmet()`, or Flask that it
   * needs a `.env.example`, is nonsense — they are the thing applications depend on. Rules
   * about deployment, configuration and request handling only apply to something deployed.
   */
  isApplication: boolean
  hasDependency(name: string): boolean
  /** Line text at a 1-based line number, trimmed and length-capped. */
  excerpt(path: string, line: number): string | undefined
}

export interface RuleResult {
  severity?: SuggestionSeverity
  confidence?: SuggestionConfidence
  title: string
  detail: string
  fix: string
  evidence?: Evidence[]
  effort?: Suggestion['effort']
  occurrences?: number
}

export interface Rule {
  /** Stable identifier, `category/short-name`. Shown in the UI so a finding can be looked up. */
  id: string
  category: SuggestionCategory
  severity: SuggestionSeverity
  confidence?: SuggestionConfidence
  effort?: Suggestion['effort']
  /** Returns nothing when the rule has no finding — the common case for a healthy repo. */
  run(ctx: ReviewContext): RuleResult | RuleResult[] | undefined
}

/** Files that exist to be built, vendored or generated are not the author's craft. */
export const NON_SOURCE =
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|coverage|\.next|\.nuxt|migrations?|__generated__|generated|\.venv|venv)\/|\.(gen|generated|g)\.[a-z]+$|_pb2\.py$|\.pb\.go$/i

/**
 * Documentation, samples and CI configuration are held to different standards than shipped
 * code: an example is *supposed* to print to the console and hard-code a URL. Reviewing them
 * as product code produces findings that are simply wrong.
 */
export const NOT_PRODUCT_CODE =
  /(^|\/)[_.]?(docs?|examples?|samples?|demos?|benchmarks?|bench|fixtures?|testdata|scripts?|github|storybook|\.storybook)\//i

export const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?|_test\.(go|py|rb|rs|ex)|Tests?\.cs|Test\.(java|kt))$|(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright)\//i

/** Cap on evidence lines per finding: enough to act on, not a wall of text. */
export const MAX_EVIDENCE = 5

export function evidenceFrom(
  ctx: ReviewContext,
  hits: { path: string; line?: number }[],
): Evidence[] {
  return hits.slice(0, MAX_EVIDENCE).map((h) => ({
    path: h.path,
    line: h.line,
    excerpt: h.line ? ctx.excerpt(h.path, h.line) : undefined,
  }))
}
