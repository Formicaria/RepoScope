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
}

export type ScanStage =
  'queued' | 'reading' | 'structure' | 'dependencies' | 'services' | 'summary' | 'done' | 'error'

export const SCAN_STAGES: { stage: ScanStage; label: string }[] = [
  { stage: 'reading', label: 'Reading repository' },
  { stage: 'structure', label: 'Detecting project structure' },
  { stage: 'dependencies', label: 'Mapping dependencies' },
  { stage: 'services', label: 'Identifying services' },
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
