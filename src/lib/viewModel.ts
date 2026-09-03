import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import type { ProjectEdge, ProjectNode, ScanResult } from '../../shared/types'
import { aggregateEdges } from '../../shared/graph'
import type { Settings } from './storage'

export interface TzNodeData extends Record<string, unknown> {
  node: ProjectNode
  expandable: boolean
  expanded: boolean
  dimmed: boolean
  selected: boolean
  warningCount: number
  /** Shown for child files: the module they belong to. */
  inGroup: boolean
}

export type TzNode = Node<TzNodeData, 'tz'>
export type GroupNode = Node<{ node: ProjectNode; dimmed: boolean }, 'tzGroup'>

const NODE_W = 224
const NODE_H = 56
const FILE_W = 150
const FILE_H = 34
const GROUP_PAD = 14
const GROUP_HEADER = 40
const FILE_GAP = 8
const MAX_FILES_SHOWN = 60

export interface ViewOptions {
  settings: Settings
  expanded: Set<string>
  focus?: string
  selected?: string
}

export interface ViewModel {
  nodes: (TzNode | GroupNode)[]
  edges: Edge[]
  visibleIds: Set<string>
}

function hiddenByType(n: ProjectNode, s: Settings): boolean {
  if (n.type === 'test' && !s.showTests) return true
  if (n.type === 'config' && !s.showConfig) return true
  if (n.type === 'docs' && !s.showDocs) return true
  return false
}

/** Compute React Flow nodes/edges for the current expand/focus state and lay them out with dagre. */
export function buildView(result: ScanResult, opts: ViewOptions): ViewModel {
  const { settings, expanded, focus, selected } = opts
  const byId = new Map(result.nodes.map((n) => [n.id, n]))
  const top = result.nodes.filter((n) => !n.parent && !hiddenByType(n, settings))

  // Visible node set: top-level nodes, with expanded modules replaced by their children.
  const visible = new Set<string>()
  for (const n of top) {
    if (expanded.has(n.id) && n.children?.length) {
      for (const c of n.children.slice(0, MAX_FILES_SHOWN)) visible.add(c)
    } else visible.add(n.id)
  }

  const aggEdges = aggregateEdges(result.nodes, result.edges, visible)

  // Focus: keep the focused node and its direct neighbours bright.
  let bright: Set<string> | undefined
  if (focus) {
    bright = new Set([focus])
    for (const e of aggEdges) {
      if (e.source === focus) bright.add(e.target)
      if (e.target === focus) bright.add(e.source)
    }
    // If the focused node is a module that is expanded, keep its children bright too.
    const f = byId.get(focus)
    if (f?.children) for (const c of f.children) bright.add(c)
  }
  const isDim = (id: string) => (bright ? !bright.has(id) : false)

  // Layout with dagre. Expanded modules become one big box sized for their file grid.
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: settings.direction,
    nodesep: 24,
    ranksep: settings.direction === 'LR' ? 64 : 56,
    marginx: 20,
    marginy: 20,
  })
  g.setDefaultEdgeLabel(() => ({}))

  const groupSize = new Map<string, { w: number; h: number; cols: number }>()
  for (const n of top) {
    if (expanded.has(n.id) && n.children?.length) {
      const count = Math.min(n.children.length, MAX_FILES_SHOWN)
      const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count))))
      const rows = Math.ceil(count / cols)
      const w = GROUP_PAD * 2 + cols * FILE_W + (cols - 1) * FILE_GAP
      const h = GROUP_HEADER + GROUP_PAD + rows * FILE_H + (rows - 1) * FILE_GAP + GROUP_PAD
      groupSize.set(n.id, { w, h, cols })
      g.setNode(n.id, { width: w, height: h })
    } else {
      g.setNode(n.id, { width: NODE_W, height: NODE_H })
    }
  }
  // Edges for layout are between top-level containers.
  const containerOf = (id: string) => byId.get(id)?.parent ?? id
  const layoutEdges = new Set<string>()
  for (const e of aggEdges) {
    const s = containerOf(e.source)
    const t = containerOf(e.target)
    if (s === t || !g.hasNode(s) || !g.hasNode(t)) continue
    const key = `${s}->${t}`
    if (layoutEdges.has(key)) continue
    layoutEdges.add(key)
    g.setEdge(s, t)
  }
  dagre.layout(g)

  const rfNodes: (TzNode | GroupNode)[] = []
  const warningCount = (n: ProjectNode) => n.warnings.length

  for (const n of top) {
    const pos = g.node(n.id)
    if (!pos) continue
    const size = groupSize.get(n.id)
    if (size && n.children) {
      const dimmed = isDim(n.id) && !n.children.some((c) => !isDim(c))
      rfNodes.push({
        id: n.id,
        type: 'tzGroup',
        position: { x: pos.x - size.w / 2, y: pos.y - size.h / 2 },
        data: { node: n, dimmed },
        style: { width: size.w, height: size.h },
        selectable: true,
        draggable: true,
        zIndex: 0,
      })
      n.children.slice(0, MAX_FILES_SHOWN).forEach((cid, i) => {
        const c = byId.get(cid)
        if (!c) return
        const col = i % size.cols
        const row = Math.floor(i / size.cols)
        rfNodes.push({
          id: c.id,
          type: 'tz',
          parentId: n.id,
          extent: 'parent',
          position: {
            x: GROUP_PAD + col * (FILE_W + FILE_GAP),
            y: GROUP_HEADER + row * (FILE_H + FILE_GAP),
          },
          data: {
            node: c,
            expandable: false,
            expanded: false,
            dimmed: isDim(c.id),
            selected: selected === c.id,
            warningCount: warningCount(c),
            inGroup: true,
          },
          style: { width: FILE_W, height: FILE_H },
          zIndex: 1,
        })
      })
    } else {
      rfNodes.push({
        id: n.id,
        type: 'tz',
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
        data: {
          node: n,
          expandable: !!n.children?.length,
          expanded: false,
          dimmed: isDim(n.id),
          selected: selected === n.id,
          warningCount: warningCount(n),
          inGroup: false,
        },
        style: { width: NODE_W, height: NODE_H },
        zIndex: 1,
      })
    }
  }

  // Absolute centre of every visible node (children are positioned relative to their group).
  const centre = new Map<string, { x: number; y: number }>()
  for (const n of rfNodes) {
    const w = Number(n.style?.width ?? NODE_W)
    const h = Number(n.style?.height ?? NODE_H)
    const parent = n.parentId ? rfNodes.find((p) => p.id === n.parentId) : undefined
    const ox = parent ? parent.position.x : 0
    const oy = parent ? parent.position.y : 0
    centre.set(n.id, { x: ox + n.position.x + w / 2, y: oy + n.position.y + h / 2 })
  }
  const rfEdges: Edge[] = aggEdges.map((e) => {
    const s = centre.get(e.source)
    const t = centre.get(e.target)
    let handles: [string, string]
    if (settings.direction === 'LR')
      handles = s && t && t.x < s.x - 40 ? ['sl', 'tr'] : ['sr', 'tl']
    else handles = s && t && t.y < s.y - 40 ? ['st', 'tb'] : ['sb', 'tt']
    return toRfEdge(
      e,
      isDim(e.source) || isDim(e.target),
      selected !== undefined && (e.source === selected || e.target === selected),
      handles,
    )
  })

  return { nodes: rfNodes, edges: rfEdges, visibleIds: visible }
}

const EDGE_COLORS: Record<ProjectEdge['type'], string> = {
  imports: '#5b6b80',
  calls: '#5b6b80',
  depends: '#a86f45',
  dataflow: '#4f9e6e',
  owns: '#5b6b80',
  tests: '#7c8a4c',
}

function toRfEdge(
  e: ProjectEdge,
  dimmed: boolean,
  highlighted: boolean,
  handles: [string, string],
): Edge {
  const weight = e.weight ?? 1
  const width = Math.min(3.5, 1 + Math.log2(weight + 1) * 0.6)
  const color = EDGE_COLORS[e.type]
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: handles[0],
    targetHandle: handles[1],
    type: 'default',
    animated: false,
    style: {
      stroke: highlighted ? '#c9d6ea' : color,
      strokeWidth: highlighted ? width + 0.8 : width,
      opacity: dimmed ? 0.08 : highlighted ? 1 : 0.7,
      strokeDasharray:
        e.type === 'depends'
          ? '6 4'
          : e.type === 'dataflow'
            ? '2 4'
            : e.type === 'tests'
              ? '1 3'
              : undefined,
    },
    markerEnd: {
      type: 'arrowclosed' as never,
      color: highlighted ? '#c9d6ea' : color,
      width: 14,
      height: 14,
    },
    data: { type: e.type, weight },
    zIndex: highlighted ? 2 : 0,
  }
}
