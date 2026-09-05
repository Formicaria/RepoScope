import { useMemo, useState } from 'react'
import type {
  ReviewSummary,
  Suggestion,
  SuggestionCategory,
  SuggestionSeverity,
} from '../../shared/types'

const SEVERITY_STYLE: Record<SuggestionSeverity, { dot: string; label: string; text: string }> = {
  critical: { dot: 'bg-danger', label: 'Critical', text: 'text-danger' },
  high: { dot: 'bg-warn', label: 'High', text: 'text-warn' },
  medium: { dot: 'bg-accent', label: 'Medium', text: 'text-accent' },
  low: { dot: 'bg-muted', label: 'Low', text: 'text-muted' },
}

const CATEGORY_LABEL: Record<SuggestionCategory, string> = {
  security: 'Security',
  reliability: 'Reliability',
  maintainability: 'Maintainability',
  craft: 'Craft',
  accessibility: 'Accessibility',
  performance: 'Performance',
  testing: 'Testing',
  documentation: 'Documentation',
}

const EFFORT_LABEL: Record<Suggestion['effort'], string> = {
  quick: 'quick fix',
  moderate: 'moderate',
  large: 'larger piece of work',
}

export interface ReviewPanelProps {
  review: ReviewSummary
  onSelectNode: (id: string) => void
}

export function ReviewPanel({ review, onSelectNode }: ReviewPanelProps) {
  const [category, setCategory] = useState<SuggestionCategory | 'all'>('all')
  const [expanded, setExpanded] = useState<string>()

  const shown = useMemo(
    () =>
      category === 'all'
        ? review.suggestions
        : review.suggestions.filter((s) => s.category === category),
    [review.suggestions, category],
  )

  const categories = useMemo(
    () =>
      (Object.keys(review.byCategory) as SuggestionCategory[]).sort(
        (a, b) => (review.byCategory[b] ?? 0) - (review.byCategory[a] ?? 0),
      ),
    [review.byCategory],
  )

  const partial = review.filesInspected === 0 && review.sourceFileCount > 0

  if (partial) {
    return (
      <div className="max-w-3xl text-[13px]">
        <p className="text-text">The code review could not run in full.</p>
        <p className="text-muted mt-2">
          None of {review.sourceFileCount} source files could be parsed, so the rules that read the
          syntax tree — error handling, function size, accessibility, injection sinks — were
          skipped. This happens when the optional tree-sitter grammars are not installed. Run{' '}
          <code className="font-mono">npm install</code> without{' '}
          <code className="font-mono">--omit=optional</code> to enable them.
        </p>
        {review.suggestions.length > 0 && (
          <p className="text-muted mt-2">
            {review.suggestions.length} project-level findings are shown below.
          </p>
        )}
      </div>
    )
  }

  if (!review.suggestions.length) {
    return (
      <div className="max-w-3xl text-[13px]">
        <p className="text-text">Nothing to flag.</p>
        <p className="text-muted mt-2">
          {review.rulesRun} rules ran across {review.filesInspected} source files and none matched.
          That covers injection, secrets handling, error handling, accessibility, type safety and
          project hygiene — not correctness, and not anything specific to what this software is
          meant to do.
        </p>
        <ConfiguredNote review={review} />
      </div>
    )
  }

  return (
    <div className="text-[13px]">
      <ConfiguredNote review={review} />
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <FilterChip active={category === 'all'} onClick={() => setCategory('all')}>
          All {review.suggestions.length}
        </FilterChip>
        {categories.map((c) => (
          <FilterChip key={c} active={category === c} onClick={() => setCategory(c)}>
            {CATEGORY_LABEL[c]} {review.byCategory[c]}
          </FilterChip>
        ))}
        <span className="text-faint ml-auto hidden text-[11.5px] lg:inline">
          {review.rulesRun} rules · {review.filesInspected} files · heuristic, check before acting
        </span>
      </div>

      <ul className="max-w-4xl space-y-1.5">
        {shown.map((s) => {
          const open = expanded === s.id
          const style = SEVERITY_STYLE[s.severity]
          return (
            <li key={s.id} className="border-border bg-surface-2/40 rounded-lg border">
              <button
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left"
                onClick={() => setExpanded(open ? undefined : s.id)}
                aria-expanded={open}
              >
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{s.title}</span>
                  <span className="text-faint mt-0.5 block text-[11.5px]">
                    <span className={style.text}>{style.label}</span>
                    {' · '}
                    {CATEGORY_LABEL[s.category]}
                    {' · '}
                    {EFFORT_LABEL[s.effort]}
                    {s.confidence !== 'certain' && ` · ${s.confidence}`}
                    {' · '}
                    <code className="font-mono">{s.rule}</code>
                  </span>
                </span>
                <span className="text-faint mt-0.5 text-[11px]">{open ? '−' : '+'}</span>
              </button>

              {open && (
                <div className="fade-in border-border space-y-3 border-t px-3 py-3 pl-8">
                  <p className="text-muted leading-relaxed">{s.detail}</p>
                  <div>
                    <div className="text-muted mb-1 text-[11px] tracking-wide uppercase">
                      What to do
                    </div>
                    <p className="leading-relaxed">{s.fix}</p>
                  </div>
                  {s.evidence.length > 0 && (
                    <div>
                      <div className="text-muted mb-1 text-[11px] tracking-wide uppercase">
                        Where
                        {s.occurrences && s.occurrences > s.evidence.length
                          ? ` (${s.evidence.length} of ${s.occurrences})`
                          : ''}
                      </div>
                      <ul className="space-y-1">
                        {s.evidence.map((e, i) => (
                          <li key={`${e.path}:${e.line}:${i}`} className="font-mono text-[11.5px]">
                            <span className="text-accent">
                              {e.path}
                              {e.line ? `:${e.line}` : ''}
                            </span>
                            {e.excerpt && (
                              <span className="text-faint block truncate pl-3">{e.excerpt}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {s.nodeId && (
                    <button
                      className="text-accent hover:text-accent-strong text-[12px]"
                      onClick={() => onSelectNode(s.nodeId!)}
                    >
                      Show the module on the map →
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * A tuned review has to say so. Otherwise a clean list is ambiguous: it could mean the code is
 * clean, or it could mean somebody switched the rules off.
 */
function ConfiguredNote({ review }: { review: ReviewSummary }) {
  const c = review.configured
  if (!c) return null
  const tuning = [
    c.rulesDisabled ? `${c.rulesDisabled} rule${c.rulesDisabled === 1 ? '' : 's'} disabled` : '',
    c.pathsIgnored
      ? `${c.pathsIgnored} path pattern${c.pathsIgnored === 1 ? '' : 's'} ignored`
      : '',
  ].filter(Boolean)
  return (
    <div className="border-border bg-surface-2/40 text-muted mb-3 max-w-4xl rounded-lg border px-3 py-2 text-[11.5px]">
      Tuned by <code className="text-text font-mono">{c.source}</code>
      {tuning.length > 0 && <> — {tuning.join(', ')}</>}.
      {c.problems.map((p) => (
        <div key={p} className="text-warn mt-1">
          {p}
        </div>
      ))}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${
        active
          ? 'border-accent text-accent bg-accent/10'
          : 'border-border text-muted hover:border-border-strong hover:text-text'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
