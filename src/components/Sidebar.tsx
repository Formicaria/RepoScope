import type { ScanResult } from '../../shared/types'
import { LEGEND, NODE_COLORS, NODE_LABELS } from '../lib/nodeStyles'
import { TypeGlyph } from './GraphNodes'
import type { Settings } from '../lib/storage'

export function Sidebar({
  result,
  settings,
  onShowWarnings,
  onShowReview,
}: {
  result: ScanResult
  settings: Settings
  onShowWarnings: () => void
  onShowReview: () => void
}) {
  const { repository, health, languages, frameworks, stats } = result
  const scoreColor =
    health.score >= 85
      ? 'var(--color-ok)'
      : health.score >= 70
        ? 'var(--color-accent)'
        : health.score >= 50
          ? 'var(--color-warn)'
          : 'var(--color-danger)'
  const present = new Set(result.nodes.filter((n) => !n.parent).map((n) => n.type))
  if (!settings.showTests) present.delete('test')
  if (!settings.showConfig) present.delete('config')
  if (!settings.showDocs) present.delete('docs')

  return (
    <aside className="border-border bg-surface flex h-full w-[260px] shrink-0 flex-col overflow-y-auto border-r">
      <div className="border-border border-b p-4">
        <div className="text-muted text-[11px]">
          {repository.source === 'upload'
            ? 'Uploaded folder'
            : repository.source === 'demo'
              ? 'Demo repository'
              : 'GitHub'}
        </div>
        <div
          className="mt-0.5 truncate font-mono text-[13.5px] font-medium"
          title={repository.fullName}
        >
          {repository.fullName}
        </div>
        {repository.url && (
          <a
            href={repository.url}
            target="_blank"
            rel="noreferrer"
            className="text-faint hover:text-muted mt-1 block truncate text-[11.5px]"
          >
            {repository.url.replace(/^https?:\/\//, '')}
          </a>
        )}
      </div>

      <div className="border-border border-b p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-muted text-[11px]">Estimated health</span>
          <span className="text-[11px] capitalize" style={{ color: scoreColor }}>
            {health.label}
          </span>
        </div>
        <div className="mt-1 flex items-end gap-2">
          <span
            className="text-[30px] leading-none font-semibold tabular-nums"
            style={{ color: scoreColor }}
          >
            {health.score}
          </span>
          <span className="text-faint pb-0.5 text-[12px]">/ 100</span>
        </div>
        <div className="bg-surface-2 mt-2 h-1 overflow-hidden rounded-full">
          <div
            className="h-full rounded-full"
            style={{ width: `${health.score}%`, background: scoreColor }}
          />
        </div>
        <details className="text-muted mt-2 text-[11.5px]">
          <summary className="hover:text-text cursor-pointer select-none">
            How it was estimated
          </summary>
          <ul className="mt-2 space-y-1">
            {health.breakdown.map((b) => (
              <li key={b.signal} className="flex justify-between gap-2">
                <span className="truncate" title={b.note}>
                  {b.signal}
                </span>
                <span className={`tabular-nums ${b.delta < 0 ? 'text-warn' : 'text-faint'}`}>
                  {b.delta === 0 ? '—' : b.delta}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-faint mt-2">
            Heuristic estimate from measurable signals — not a measured quality score.
          </p>
        </details>
      </div>

      <div className="border-border bg-border grid grid-cols-2 gap-px border-b">
        <Stat label="Files" value={stats.files} />
        <Stat label="Modules" value={stats.modules} />
        <button
          className="bg-surface hover:bg-surface-2 p-3 text-left transition-colors"
          onClick={onShowReview}
          title="Show the code review"
        >
          <div className="text-muted text-[11px]">Review</div>
          <div
            className={`text-[18px] font-semibold tabular-nums ${
              (result.review?.bySeverity.critical ?? 0) + (result.review?.bySeverity.high ?? 0) > 0
                ? 'text-warn'
                : ''
            }`}
          >
            {result.review?.suggestions.length ?? '—'}
          </div>
        </button>
        <button
          className="bg-surface hover:bg-surface-2 p-3 text-left transition-colors"
          onClick={onShowWarnings}
          title="Show warnings"
        >
          <div className="text-muted text-[11px]">Warnings</div>
          <div
            className={`text-[18px] font-semibold tabular-nums ${stats.warnings ? 'text-warn' : ''}`}
          >
            {stats.warnings}
          </div>
        </button>
      </div>

      <div className="border-border border-b p-4">
        <div className="text-muted text-[11px]">Languages</div>
        {languages.length === 0 && (
          <div className="text-faint mt-1 text-[12px]">No source files detected</div>
        )}
        <ul className="mt-2 space-y-1.5">
          {languages.slice(0, 5).map((l) => (
            <li key={l.name} className="text-[12px]">
              <div className="flex justify-between">
                <span>{l.name}</span>
                <span className="text-faint tabular-nums">{Math.round(l.share * 100)}%</span>
              </div>
              <div className="bg-surface-2 mt-1 h-0.5 overflow-hidden rounded">
                <div
                  className="bg-muted h-full"
                  style={{ width: `${Math.max(2, l.share * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-border border-b p-4">
        <div className="text-muted text-[11px]">Frameworks &amp; tooling</div>
        {frameworks.length === 0 ? (
          <div className="text-faint mt-1 text-[12px]">None detected</div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1">
            {frameworks.map((f) => (
              <span
                key={f}
                className="border-border bg-surface-2 rounded border px-1.5 py-0.5 text-[11px]"
              >
                {f}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="text-muted text-[11px]">Legend</div>
        <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
          {LEGEND.filter((t) => present.has(t)).map((t) => (
            <li key={t} className="flex items-center gap-1.5 text-[11.5px]">
              <TypeGlyph type={t} size={11} />
              <span style={{ color: NODE_COLORS[t] }}>{NODE_LABELS[t]}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface p-3">
      <div className="text-muted text-[11px]">{label}</div>
      <div className="text-[18px] font-semibold tabular-nums">{value}</div>
    </div>
  )
}
