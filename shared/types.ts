/**
 * Shared data model used by the analyzer (server) and the UI (client).
 * Everything here is plain JSON so scans can be stored, exported and shared.
 */

export type NodeType =
  | 'app'
  | 'entry'
  | 'module'
  | 'service'
  | 'api'
  | 'component'
  | 'database'
  | 'integration'
  | 'config'
  | 'test'
  | 'docs'
  | 'file'

export type EdgeType = 'imports' | 'calls' | 'depends' | 'dataflow' | 'owns' | 'tests'

export type WarningKind =
  | 'unclear-entry'
  | 'dead-module'
  | 'missing-tests'
  | 'duplicate-functionality'
  | 'excessive-complexity'
  | 'circular-dependency'
  | 'exposed-secret'
  | 'large-file'
  | 'unused-dependency'

export type Severity = 'info' | 'warning' | 'critical'

export interface Repository {
  name: string
  fullName: string
  url?: string
  source: 'github' | 'upload' | 'demo'
  defaultBranch?: string
  scannedAt: string
}

export interface Warning {
  id: string
  kind: WarningKind
  severity: Severity
  title: string
  detail: string
  /** Path or node id the warning is attached to (if any). */
  path?: string
  nodeId?: string
}

export interface Finding {
  id: string
  title: string
  detail: string
  kind: 'strength' | 'risk' | 'observation'
}

export interface ProjectNode {
  id: string
  name: string
  type: NodeType
  path: string
  description: string
  /** 0..1 – how central this node is to the project. */
  importance: number
  dependencies: string[]
  dependents: string[]
  warnings: string[]
  /** Ids of children nodes (files) when the node can be expanded. */
  children?: string[]
  parent?: string
  meta?: {
    files?: number
    lines?: number
    language?: string
    routes?: string[]
    package?: string
  }
}

export interface ProjectEdge {
  id: string
  source: string
  target: string
  type: EdgeType
  /** 0..1 */
  confidence: number
  label?: string
  weight?: number
}

export interface Module {
  id: string
  name: string
  path: string
  type: NodeType
  files: string[]
  lines: number
}

export interface Dependency {
  name: string
  version?: string
  ecosystem: 'npm' | 'pypi' | 'go' | 'nuget' | 'cargo' | 'maven' | 'rubygems' | 'composer' | 'other'
  dev: boolean
  used: boolean
  category?: string
}

export interface LanguageStat {
  name: string
  files: number
  lines: number
  share: number
}

export interface HealthScore {
  /** 0..100 */
  score: number
  label: 'excellent' | 'good' | 'fair' | 'needs attention'
  breakdown: { signal: string; delta: number; note: string }[]
}

export interface ProjectSummary {
  headline: string
  description: string
  architecture: string
  keyFindings: Finding[]
  nextActions: string[]
}

/* ---------------------------------------------------------------------- */
/* Code review                                                              */
/* ---------------------------------------------------------------------- */

export type SuggestionCategory =
  | 'security'
  | 'reliability'
  | 'maintainability'
  | 'craft'
  | 'accessibility'
  | 'performance'
  | 'testing'
  | 'documentation'

export type SuggestionSeverity = 'critical' | 'high' | 'medium' | 'low'

/** How sure the rule is. Anything below `certain` is phrased as a question, not a verdict. */
export type SuggestionConfidence = 'certain' | 'likely' | 'possible'

export interface Evidence {
  path: string
  line?: number
  /** A short, redacted excerpt. Never contains a secret value. */
  excerpt?: string
}

export interface Suggestion {
  id: string
  /** Stable rule identifier, e.g. `security/sql-injection`. */
  rule: string
  category: SuggestionCategory
  severity: SuggestionSeverity
  confidence: SuggestionConfidence
  /** What is wrong, specifically. */
  title: string
  /** Why it matters — the consequence, not a restatement. */
  detail: string
  /** What to change. Concrete enough to act on without further research. */
  fix: string
  /** Where it was found. Empty only for repository-wide findings. */
  evidence: Evidence[]
  /** Roughly how much work the fix is. */
  effort: 'quick' | 'moderate' | 'large'
  /** Total occurrences, when more were found than are listed as evidence. */
  occurrences?: number
  nodeId?: string
}

export interface ReviewSummary {
  suggestions: Suggestion[]
  /** Counts by category, for the panel headline. */
  byCategory: Partial<Record<SuggestionCategory, number>>
  bySeverity: Partial<Record<SuggestionSeverity, number>>
  /** Rules that ran, so a clean result reads as "checked" rather than "not looked at". */
  rulesRun: number
  /** Files the rules could inspect with a real parser. */
  filesInspected: number
  /** Source files that were candidates for inspection. */
  sourceFileCount: number
}

export interface ScanStats {
  files: number
  lines: number
  modules: number
  connections: number
  warnings: number
}

/** How much of the repository the analyzer actually understood. Useful for benchmarking. */
export interface AnalysisDiagnostics {
  parsedFiles: number
  regexFiles: number
  /** API routes detected, before the per-module display cap. */
  routesDetected: number
  totalSpecifiers: number
  resolvedInternal: number
  external: number
  unresolvedLocal: { from: string; raw: string }[]
}

export interface ScanResult {
  id: string
  repository: Repository
  summary: ProjectSummary
  languages: LanguageStat[]
  frameworks: string[]
  entryPoints: string[]
  nodes: ProjectNode[]
  edges: ProjectEdge[]
  modules: Module[]
  dependencies: Dependency[]
  warnings: Warning[]
  health: HealthScore
  stats: ScanStats
  /** Optional: present for scans produced by this version of the analyzer. */
  diagnostics?: AnalysisDiagnostics
  /** Actionable review findings. Optional so older stored scans still load. */
  review?: ReviewSummary
}

export type ScanStage =
  | 'queued'
  | 'reading'
  | 'structure'
  | 'dependencies'
  | 'services'
  | 'review'
  | 'summary'
  | 'done'
  | 'error'

export const SCAN_STAGES: { stage: ScanStage; label: string }[] = [
  { stage: 'reading', label: 'Reading repository' },
  { stage: 'structure', label: 'Detecting project structure' },
  { stage: 'dependencies', label: 'Mapping dependencies' },
  { stage: 'services', label: 'Identifying services' },
  { stage: 'review', label: 'Reviewing code quality' },
  { stage: 'summary', label: 'Generating architecture summary' },
]

export interface ScanStatus {
  id: string
  stage: ScanStage
  /** 0..100 */
  progress: number
  message?: string
  error?: {
    code: 'invalid-repo' | 'private-repo' | 'too-large' | 'not-found' | 'internal'
    message: string
  }
  result?: ScanResult
}

/** A file handed to the analyzer (from a clone or a browser upload). */
export interface RepoFile {
  path: string
  size: number
  /** Text content when available (binary or oversized files omit it). */
  content?: string
}
