import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ScanResult } from '../../shared/types'
import type { Settings } from '../lib/storage'
import { AnalysisPanel, type AnalysisTab } from './AnalysisPanel'
import { ExportDialog, SettingsDialog } from './Dialogs'
import { Graph } from './Graph'
import { Inspector } from './Inspector'
import { Sidebar } from './Sidebar'
import { Button, Wordmark } from './ui'

export interface MapViewProps {
  result: ScanResult
  settings: Settings
  onSettings: (s: Settings) => void
  onNewScan: () => void
  shareUrl?: string
  readOnly?: boolean
}

export function MapView({
  result,
  settings,
  onSettings,
  onNewScan,
  shareUrl,
  readOnly,
}: MapViewProps) {
  const [selected, setSelected] = useState<string>()
  const [focus, setFocus] = useState<string>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<AnalysisTab>('summary')
  const [dialog, setDialog] = useState<'export' | 'settings'>()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [fitToken, setFitToken] = useState(0)
  const [fitTargets, setFitTargets] = useState<string[]>()

  const byId = useMemo(() => new Map(result.nodes.map((n) => [n.id, n])), [result])
  const selectedNode = selected ? byId.get(selected) : undefined

  // Reset interaction state when a different scan is shown.
  useEffect(() => {
    setSelected(undefined)
    setFocus(undefined)
    setExpanded(new Set())
  }, [result.id])

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setFitTargets([id])
    setFitToken((t) => t + 1)
  }, [])

  const select = useCallback(
    (id: string | undefined) => {
      setSelected(id)
      if (!id) return
      const n = byId.get(id)
      // Selecting a file that is hidden inside a collapsed module expands it.
      if (n?.parent && !expanded.has(n.parent)) toggleExpand(n.parent)
    },
    [byId, expanded, toggleExpand],
  )

  const focusOn = useCallback(
    (id: string) => {
      if (focus === id) {
        setFocus(undefined)
        setFitTargets(undefined)
        setFitToken((t) => t + 1)
        return
      }
      setFocus(id)
      const n = byId.get(id)
      const neighbours = new Set<string>([id])
      for (const d of n?.dependencies ?? []) neighbours.add(d)
      for (const d of n?.dependents ?? []) neighbours.add(d)
      // Fit to the top-level containers of the neighbourhood.
      const containers = [...neighbours].map((x) => byId.get(x)?.parent ?? x)
      setFitTargets([...new Set(containers)])
      setFitToken((t) => t + 1)
    },
    [byId, focus],
  )

  const reset = useCallback(() => {
    setFocus(undefined)
    setSelected(undefined)
    setExpanded(new Set())
    setFitTargets(undefined)
    setFitToken((t) => t + 1)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dialog) setDialog(undefined)
        else if (selected) setSelected(undefined)
        else if (focus) setFocus(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, selected, focus])

  return (
    <div className="flex h-full flex-col">
      <header className="border-border bg-surface flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <button
          className="text-muted hover:bg-surface-2 mr-1 flex h-8 w-8 items-center justify-center rounded lg:hidden"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Toggle project summary"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        </button>
        <Wordmark />
        <span className="text-faint hidden truncate font-mono text-[12px] sm:inline">
          / {result.repository.fullName}
        </span>
        {readOnly && (
          <span className="border-border text-muted rounded border px-1.5 py-0.5 text-[10.5px]">
            read-only
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="primary" onClick={onNewScan}>
            New Scan
          </Button>
          <Button onClick={() => setDialog('export')}>Export</Button>
          <Button variant="ghost" onClick={() => setDialog('settings')} aria-label="Settings">
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            >
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
            </svg>
            <span className="hidden sm:inline">Settings</span>
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div
          className={`absolute inset-y-0 left-0 z-20 lg:static lg:block ${sidebarOpen ? 'block shadow-2xl' : 'hidden'}`}
        >
          <Sidebar
            result={result}
            settings={settings}
            onShowWarnings={() => {
              setTab('warnings')
              setPanelOpen(true)
              setSidebarOpen(false)
            }}
          />
        </div>
        {sidebarOpen && (
          <div
            className="absolute inset-0 z-10 bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Graph
              result={result}
              settings={settings}
              expanded={expanded}
              focus={focus}
              selected={selected}
              onSelect={select}
              onToggleExpand={toggleExpand}
              onReset={reset}
              fitToken={fitToken}
              fitTargets={fitTargets}
            />
          </div>
          <AnalysisPanel
            result={result}
            open={panelOpen}
            tab={tab}
            onToggle={() => setPanelOpen((v) => !v)}
            onTab={setTab}
            onSelectNode={select}
          />
        </div>

        {selectedNode && (
          <div className="absolute inset-y-0 right-0 z-20 md:static">
            <Inspector
              result={result}
              node={selectedNode}
              focused={focus === selectedNode.id}
              expanded={expanded.has(selectedNode.id)}
              onClose={() => setSelected(undefined)}
              onFocus={() => focusOn(selectedNode.id)}
              onSelect={select}
              onExpand={
                selectedNode.children?.length ? () => toggleExpand(selectedNode.id) : undefined
              }
            />
          </div>
        )}
      </div>

      {dialog === 'export' && (
        <ExportDialog result={result} shareUrl={shareUrl} onClose={() => setDialog(undefined)} />
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          settings={settings}
          onChange={onSettings}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  )
}
