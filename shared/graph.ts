import type { EdgeType, ProjectEdge, ProjectNode } from './types.js'

/**
 * Collapse fine-grained edges (file → file, file → integration) onto a set of visible nodes.
 * Each endpoint is replaced by its nearest visible ancestor; parallel edges are merged and weighted.
 * Used by the server (module-level stats) and the UI (expand / collapse).
 */
export function aggregateEdges(
  nodes: ProjectNode[],
  edges: ProjectEdge[],
  visible: Set<string>,
): ProjectEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const lift = (id: string): string | undefined => {
    let cur: ProjectNode | undefined = byId.get(id)
    while (cur) {
      if (visible.has(cur.id)) return cur.id
      cur = cur.parent ? byId.get(cur.parent) : undefined
    }
    return undefined
  }
  const merged = new Map<string, { edge: ProjectEdge; types: Map<EdgeType, number> }>()
  for (const e of edges) {
    const s = lift(e.source)
    const t = lift(e.target)
    if (!s || !t || s === t) continue
    const key = `${s}->${t}`
    const cur = merged.get(key)
    if (cur) {
      cur.edge.weight = (cur.edge.weight ?? 1) + (e.weight ?? 1)
      cur.edge.confidence = Math.max(cur.edge.confidence, e.confidence)
      cur.types.set(e.type, (cur.types.get(e.type) ?? 0) + 1)
    } else {
      merged.set(key, {
        edge: {
          id: `agg:${key}`,
          source: s,
          target: t,
          type: e.type,
          confidence: e.confidence,
          weight: e.weight ?? 1,
          label: e.label,
        },
        types: new Map([[e.type, 1]]),
      })
    }
  }
  return [...merged.values()].map(({ edge, types }) => {
    let best: EdgeType = edge.type
    let bestN = -1
    for (const [t, n] of types) if (n > bestN) ((best = t), (bestN = n))
    return {
      ...edge,
      type: best,
      label: edge.weight && edge.weight > 1 ? `${edge.weight}` : undefined,
    }
  })
}

/** Top-level nodes are those without a parent. */
export function topLevelIds(nodes: ProjectNode[]): Set<string> {
  return new Set(nodes.filter((n) => !n.parent).map((n) => n.id))
}
