import type { EdgeType, NodeType } from '../../shared/types'

export const NODE_COLORS: Record<NodeType, string> = {
  entry: 'var(--color-t-entry)',
  app: 'var(--color-t-app)',
  module: 'var(--color-t-module)',
  service: 'var(--color-t-service)',
  api: 'var(--color-t-api)',
  component: 'var(--color-t-component)',
  database: 'var(--color-t-database)',
  integration: 'var(--color-t-integration)',
  config: 'var(--color-t-config)',
  test: 'var(--color-t-test)',
  docs: 'var(--color-t-docs)',
  file: 'var(--color-t-file)',
}

export const NODE_LABELS: Record<NodeType, string> = {
  entry: 'Entry point',
  app: 'Application',
  module: 'Module',
  service: 'Service',
  api: 'API',
  component: 'UI',
  database: 'Storage',
  integration: 'Integration',
  config: 'Config',
  test: 'Tests',
  docs: 'Docs',
  file: 'File',
}

export const EDGE_LABELS: Record<EdgeType, string> = {
  imports: 'imports',
  calls: 'calls',
  depends: 'depends on',
  dataflow: 'reads / writes',
  owns: 'owns',
  tests: 'tests',
}

/** Legend order for the sidebar. */
export const LEGEND: NodeType[] = [
  'entry',
  'app',
  'api',
  'service',
  'component',
  'module',
  'database',
  'integration',
  'test',
  'config',
  'docs',
]
