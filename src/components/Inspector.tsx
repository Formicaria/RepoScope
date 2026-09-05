import type { ProjectNode, ScanResult } from '../../shared/types'
import { NODE_COLORS, NODE_LABELS } from '../lib/nodeStyles'
import { TypeGlyph } from './GraphNodes'
import { Button, SeverityDot } from './ui'

export interface InspectorProps {
  result: ScanResult
  node: ProjectNode
  focused: boolean
  onClose: () => void
  onFocus: () => void
  onSelect: (id: string) => void
  onExpand?: () => void
  expanded: boolean
}

export function Inspector({
  result,
  node,
  focused,
  onClose,
  onFocus,
  onSelect,
  onExpand,
  expanded,
}: InspectorProps) {
  const byId = new Map(result.nodes.map((n) => [n.id, n]))
  const warnings = result.warnings.filter((w) => node.warnings.includes(w.id))
  const findings = (result.review?.suggestions ?? []).filter(
    (s) => s.nodeId === node.id || s.evidence.some((e) => e.path === node.path),
  )
  const parent = node.parent ? byId.get(node.parent) : undefined
  const related = (node.children ?? []).map((c) => byId.get(c)).filter((c): c is ProjectNode => !!c)
  const deps = node.dependencies.map((d) => byId.get(d)).filter((d): d is ProjectNode => !!d)
  const dependents = node.dependents.map((d) => byId.get(d)).filter((d): d is ProjectNode => !!d)

  return (
    <aside className="slide-in-right border-border bg-surface flex h-full w-[320px] shrink-0 flex-col overflow-y-auto border-l">
      <div className="border-border flex items-start gap-3 border-b p-4">
        <span className="mt-0.5">
          <TypeGlyph type={node.type} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold" title={node.name}>
            {node.name}
          </div>
          <div className="text-[11.5px]" style={{ color: NODE_COLORS[node.type] }}>
            {NODE_LABELS[node.type]}
            {parent ? <span className="text-muted"> in {parent.name}</span> : null}
          </div>
        </div>
        <button
          className="text-muted hover:text-text"
          onClick={onClose}
          aria-label="Close inspector"
        >
          ✕
        </button>
      </div>

      <div className="space-y-5 p-4 text-[12.5px]">
        <Section label="Location">
          <code className="text-muted font-mono text-[11.5px] break-all">{node.path}</code>
        </Section>

        <Section label="Purpose">
          <p className="leading-relaxed">{node.description}</p>
          {node.meta && (
            <div className="text-faint mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
              {node.meta.language && <span>{node.meta.language}</span>}
              {node.meta.files ? <span>{node.meta.files} files</span> : null}
              {node.meta.lines ? <span>{node.meta.lines.toLocaleString()} lines</span> : null}
              <span>importance {Math.round(node.importance * 100)}%</span>
            </div>
          )}
        </Section>

        <div className="flex gap-2">
          <Button variant={focused ? 'secondary' : 'primary'} onClick={onFocus} className="flex-1">
            {focused ? 'Clear focus' : 'Focus on this component'}
          </Button>
          {onExpand && (
            <Button onClick={onExpand} title={expanded ? 'Collapse files' : 'Show files'}>
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
          )}
        </div>

        {node.meta?.routes && node.meta.routes.length > 0 && (
          <Section label={`Routes (${node.meta.routes.length})`}>
            <ul className="space-y-0.5 font-mono text-[11.5px]">
              {node.meta.routes.slice(0, 24).map((r) => (
                <li key={r} className="truncate">
                  <span className="text-accent">{r.split(' ')[0]}</span>{' '}
                  <span className="text-muted">{r.slice(r.indexOf(' ') + 1)}</span>
                </li>
              ))}
              {node.meta.routes.length > 24 && (
                <li className="text-faint">… {node.meta.routes.length - 24} more</li>
              )}
            </ul>
          </Section>
        )}

        {warnings.length > 0 && (
          <Section label={`Warnings (${warnings.length})`}>
            <ul className="space-y-2">
              {warnings.map((w) => (
                <li key={w.id} className="flex gap-2">
                  <SeverityDot severity={w.severity} />
                  <div>
                    <div className="font-medium">{w.title}</div>
                    <div className="text-muted text-[11.5px] leading-relaxed">{w.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {findings.length > 0 && (
          <Section label={`Review findings (${findings.length})`}>
            <ul className="space-y-2">
              {findings.slice(0, 6).map((f) => (
                <li key={f.id} className="flex gap-2">
                  <span
                    className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      f.severity === 'critical'
                        ? 'bg-danger'
                        : f.severity === 'high'
                          ? 'bg-warn'
                          : 'bg-muted'
                    }`}
                  />
                  <div>
                    <div className="font-medium">{f.title}</div>
                    <div className="text-muted text-[11.5px] leading-relaxed">{f.fix}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <NodeList label="Depends on" nodes={deps} onSelect={onSelect} />
        <NodeList label="Used by" nodes={dependents} onSelect={onSelect} />
        {related.length > 0 && (
          <NodeList label={`Files (${related.length})`} nodes={related} onSelect={onSelect} mono />
        )}
      </div>
    </aside>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-muted mb-1.5 text-[11px] tracking-wide uppercase">{label}</div>
      {children}
    </section>
  )
}

function NodeList({
  label,
  nodes,
  onSelect,
  mono,
}: {
  label: string
  nodes: ProjectNode[]
  onSelect: (id: string) => void
  mono?: boolean
}) {
  if (!nodes.length) return null
  const shown = nodes.slice(0, 40)
  return (
    <Section label={`${label}${label.includes('(') ? '' : ` (${nodes.length})`}`}>
      <ul className="space-y-0.5">
        {shown.map((n) => (
          <li key={n.id}>
            <button
              className="hover:bg-surface-2 flex w-full items-center gap-2 rounded px-1 py-0.5 text-left"
              onClick={() => onSelect(n.id)}
            >
              <TypeGlyph type={n.type} size={10} />
              <span className={`truncate ${mono ? 'font-mono text-[11.5px]' : ''}`}>{n.name}</span>
              {n.warnings.length > 0 && (
                <span className="bg-warn ml-auto h-1.5 w-1.5 shrink-0 rounded-full" />
              )}
            </button>
          </li>
        ))}
        {nodes.length > shown.length && (
          <li className="text-faint px-1 text-[11.5px]">… {nodes.length - shown.length} more</li>
        )}
      </ul>
    </Section>
  )
}
