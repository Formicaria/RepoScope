import type { ScanResult } from '../../shared/types'
import { SeverityDot } from './ui'

export type AnalysisTab = 'summary' | 'architecture' | 'findings' | 'actions' | 'warnings'

export interface AnalysisPanelProps {
  result: ScanResult
  open: boolean
  tab: AnalysisTab
  onToggle: () => void
  onTab: (t: AnalysisTab) => void
  onSelectNode: (id: string) => void
}

const TABS: { id: AnalysisTab; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'findings', label: 'Key findings' },
  { id: 'actions', label: 'Next actions' },
  { id: 'warnings', label: 'Warnings' },
]

export function AnalysisPanel({
  result,
  open,
  tab,
  onToggle,
  onTab,
  onSelectNode,
}: AnalysisPanelProps) {
  const { summary, warnings } = result
  return (
    <section
      className={`border-border bg-surface shrink-0 border-t transition-[height] duration-200 ${open ? 'h-[240px]' : 'h-9'} flex flex-col`}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <button
          className="text-muted hover:bg-surface-2 hover:text-text mr-1 flex h-7 w-7 items-center justify-center rounded"
          onClick={onToggle}
          aria-label={open ? 'Collapse analysis' : 'Expand analysis'}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className={`transition-transform ${open ? '' : 'rotate-180'}`}
          >
            <path d="M2 4l4 4 4-4" />
          </svg>
        </button>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`h-7 rounded px-2.5 text-[12px] transition-colors ${tab === t.id && open ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}
            onClick={() => {
              onTab(t.id)
              if (!open) onToggle()
            }}
          >
            {t.label}
            {t.id === 'warnings' && warnings.length > 0 && (
              <span className="bg-warn/15 text-warn ml-1.5 rounded-full px-1.5 text-[10px]">
                {warnings.length}
              </span>
            )}
          </button>
        ))}
        {!open && (
          <span className="text-faint ml-3 hidden truncate text-[12px] md:inline">
            {summary.headline}
          </span>
        )}
      </div>
      {open && (
        <div className="fade-in flex-1 overflow-y-auto px-4 pb-4 text-[13px] leading-relaxed">
          {tab === 'summary' && (
            <div className="max-w-3xl">
              <p className="font-medium">{summary.headline}</p>
              <p className="text-muted mt-2">{summary.description}</p>
            </div>
          )}
          {tab === 'architecture' && <p className="text-muted max-w-3xl">{summary.architecture}</p>}
          {tab === 'findings' && (
            <ul className="grid max-w-4xl gap-x-6 gap-y-3 md:grid-cols-2">
              {summary.keyFindings.map((f) => (
                <li key={f.id} className="flex gap-2">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${f.kind === 'strength' ? 'bg-ok' : f.kind === 'risk' ? 'bg-warn' : 'bg-muted'}`}
                  />
                  <div>
                    <div className="font-medium">{f.title}</div>
                    <div className="text-muted text-[12.5px]">{f.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tab === 'actions' && (
            <ol className="text-muted marker:text-faint max-w-3xl list-decimal space-y-1.5 pl-5">
              {summary.nextActions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ol>
          )}
          {tab === 'warnings' &&
            (warnings.length === 0 ? (
              <p className="text-muted">
                No warnings. Nothing looked fragile with the available heuristics.
              </p>
            ) : (
              <ul className="grid max-w-5xl gap-x-6 gap-y-2.5 md:grid-cols-2">
                {warnings.map((w) => (
                  <li key={w.id} className="flex gap-2">
                    <SeverityDot severity={w.severity} />
                    <div className="min-w-0">
                      <div className="font-medium">
                        {w.nodeId ? (
                          <button
                            className="hover:text-accent text-left"
                            onClick={() => onSelectNode(w.nodeId!)}
                          >
                            {w.title}
                          </button>
                        ) : (
                          w.title
                        )}
                      </div>
                      <div className="text-muted text-[12.5px]">{w.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </section>
  )
}
