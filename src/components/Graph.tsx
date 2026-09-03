import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ScanResult } from '../../shared/types'
import type { Settings } from '../lib/storage'
import { buildView, type GroupNode, type TzNode } from '../lib/viewModel'
import { TzGroupView, TzNodeView } from './GraphNodes'
import { EDGE_LABELS } from '../lib/nodeStyles'

const nodeTypes = { tz: TzNodeView, tzGroup: TzGroupView }

export interface GraphProps {
  result: ScanResult
  settings: Settings
  expanded: Set<string>
  focus?: string
  selected?: string
  onSelect: (id: string | undefined) => void
  onToggleExpand: (id: string) => void
  onReset: () => void
  /** Increment to request a "fit to view" (e.g. after focus). */
  fitToken: number
  fitTargets?: string[]
}

export function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  )
}

function GraphInner({
  result,
  settings,
  expanded,
  focus,
  selected,
  onSelect,
  onToggleExpand,
  onReset,
  fitToken,
  fitTargets,
}: GraphProps) {
  const rf = useReactFlow()
  const view = useMemo(
    () => buildView(result, { settings, expanded, focus, selected }),
    [result, settings, expanded, focus, selected],
  )
  const structureKey = useMemo(
    () =>
      `${result.id}|${settings.direction}|${settings.showTests}${settings.showConfig}${settings.showDocs}`,
    [result.id, settings],
  )
  const lastKey = useRef('')
  const pendingFit = useRef(false)
  const nodesInitialized = useNodesInitialized()

  // Fit the view whenever the structure changes (new scan, layout direction, visibility),
  // waiting until React Flow has measured the new nodes.
  useEffect(() => {
    if (lastKey.current === structureKey) return
    lastKey.current = structureKey
    pendingFit.current = true
  }, [structureKey])
  useEffect(() => {
    if (!pendingFit.current || !nodesInitialized) return
    pendingFit.current = false
    const t = setTimeout(() => rf.fitView({ padding: 0.12, duration: 350, maxZoom: 1.1 }), 20)
    return () => clearTimeout(t)
  }, [nodesInitialized, structureKey, rf])

  useEffect(() => {
    if (!fitToken) return
    const t = setTimeout(() => {
      if (fitTargets?.length)
        rf.fitView({
          nodes: fitTargets.map((id) => ({ id })),
          padding: 0.2,
          duration: 400,
          maxZoom: 1.2,
        })
      else rf.fitView({ padding: 0.15, duration: 350, maxZoom: 1.2 })
    }, 30)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken])

  const onNodeClick: NodeMouseHandler<Node> = useCallback((_, n) => onSelect(n.id), [onSelect])
  const onNodeDoubleClick: NodeMouseHandler<Node> = useCallback(
    (_, n) => {
      const data = n.data as TzNode['data'] | GroupNode['data']
      const pn = data.node
      if (pn.children?.length) onToggleExpand(pn.id)
    },
    [onToggleExpand],
  )

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => onSelect(undefined)}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1c2129" />
      </ReactFlow>
      <Toolbar onReset={onReset} />
      <Legend edges={view.edges} />
    </div>
  )
}

function Toolbar({ onReset }: { onReset: () => void }) {
  const rf = useReactFlow()
  const btn =
    'flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-surface-2 hover:text-text'
  return (
    <div className="border-border bg-surface absolute right-3 bottom-3 flex overflow-hidden rounded-lg border shadow-lg">
      <button
        className={btn}
        onClick={() => rf.zoomIn({ duration: 200 })}
        title="Zoom in"
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        className={btn}
        onClick={() => rf.zoomOut({ duration: 200 })}
        title="Zoom out"
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        className={btn}
        onClick={() => rf.fitView({ padding: 0.15, duration: 300 })}
        title="Fit to view"
        aria-label="Fit to view"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9" />
        </svg>
      </button>
      <button
        className={`${btn} border-border border-l`}
        onClick={onReset}
        title="Reset view (collapse modules, clear focus)"
        aria-label="Reset view"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2.5 7a4.5 4.5 0 1 0 1.3-3.2M2.5 1.5v2.8h2.8" />
        </svg>
      </button>
    </div>
  )
}

function Legend({ edges }: { edges: Edge[] }) {
  const types = useMemo(() => {
    const s = new Set<string>()
    for (const e of edges) s.add((e.data as { type: string }).type)
    return [...s]
  }, [edges])
  if (!types.length) return null
  const dash: Record<string, string> = { depends: '6 4', dataflow: '2 4', tests: '1 3' }
  const color: Record<string, string> = {
    imports: '#5b6b80',
    calls: '#5b6b80',
    owns: '#5b6b80',
    depends: '#a86f45',
    dataflow: '#4f9e6e',
    tests: '#7c8a4c',
  }
  return (
    <div className="border-border bg-surface/90 text-muted absolute bottom-3 left-3 hidden items-center gap-3 rounded-lg border px-2.5 py-1.5 text-[10.5px] backdrop-blur md:flex">
      {types.map((t) => (
        <span key={t} className="flex items-center gap-1.5">
          <svg width="22" height="6">
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke={color[t]}
              strokeWidth="2"
              strokeDasharray={dash[t]}
            />
          </svg>
          {EDGE_LABELS[t as keyof typeof EDGE_LABELS]}
        </span>
      ))}
      <span className="text-faint">· double-click a module to expand</span>
    </div>
  )
}
