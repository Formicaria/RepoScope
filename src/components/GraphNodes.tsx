import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import type { NodeType } from '../../shared/types'
import { NODE_COLORS, NODE_LABELS } from '../lib/nodeStyles'
import type { GroupNode, TzNode } from '../lib/viewModel'

/** Small glyph per node type — shapes carry meaning even without colour. */
export function TypeGlyph({ type, size = 12 }: { type: NodeType; size?: number }) {
  const color = NODE_COLORS[type]
  const s = size
  switch (type) {
    case 'entry':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <path d="M2 1.5 L10.5 6 L2 10.5 Z" fill={color} />
        </svg>
      )
    case 'database':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <ellipse cx="6" cy="3" rx="4.5" ry="1.8" fill={color} />
          <path
            d="M1.5 3v6c0 1 2 1.8 4.5 1.8S10.5 10 10.5 9V3"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
          />
        </svg>
      )
    case 'integration':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <path
            d="M6 1 L10.5 3.5 V8.5 L6 11 L1.5 8.5 V3.5 Z"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
          />
        </svg>
      )
    case 'api':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <rect x="1.5" y="3" width="9" height="6" rx="3" fill={color} />
        </svg>
      )
    case 'service':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <path d="M6 1.5 L10.5 6 L6 10.5 L1.5 6 Z" fill={color} />
        </svg>
      )
    case 'component':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <rect
            x="1.5"
            y="1.5"
            width="9"
            height="9"
            rx="1.5"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
          />
          <rect x="1.5" y="1.5" width="9" height="3" fill={color} />
        </svg>
      )
    case 'test':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <path
            d="M2 6.5 L5 9.5 L10 3"
            fill="none"
            stroke={color}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'app':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill={color} />
        </svg>
      )
    case 'file':
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <path d="M3 1.5h4l2.5 2.5v6.5H3z" fill="none" stroke={color} strokeWidth="1.3" />
        </svg>
      )
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden>
          <rect
            x="1.5"
            y="2.5"
            width="9"
            height="7"
            rx="1.5"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
          />
        </svg>
      )
  }
}

/** One source + one target handle per side so edges can leave from whichever side faces the other node. */
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} id="tl" />
      <Handle type="target" position={Position.Right} id="tr" />
      <Handle type="target" position={Position.Top} id="tt" />
      <Handle type="target" position={Position.Bottom} id="tb" />
      <Handle type="source" position={Position.Left} id="sl" />
      <Handle type="source" position={Position.Right} id="sr" />
      <Handle type="source" position={Position.Top} id="st" />
      <Handle type="source" position={Position.Bottom} id="sb" />
    </>
  )
}

const dashed = new Set<NodeType>(['integration', 'config', 'docs'])

export const TzNodeView = memo(function TzNodeView({ data }: NodeProps<TzNode>) {
  const { node, expandable, dimmed, selected, warningCount, inGroup } = data
  const color = NODE_COLORS[node.type]
  if (inGroup) {
    return (
      <div
        className={`bg-surface-2 flex h-full items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors ${selected ? 'border-accent' : 'border-border hover:border-border-strong'}`}
        style={{ opacity: dimmed ? 0.25 : 1 }}
        title={node.path}
      >
        <TypeGlyph type="file" size={10} />
        <span className="text-text truncate font-mono">{node.name}</span>
        {warningCount > 0 && <span className="bg-warn ml-auto h-1.5 w-1.5 shrink-0 rounded-full" />}
        <Handles />
      </div>
    )
  }
  return (
    <div
      className={`group bg-surface relative flex h-full items-center gap-2.5 rounded-lg border px-3 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] transition-[border-color,box-shadow] ${
        selected
          ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]'
          : 'border-border hover:border-border-strong'
      } ${dashed.has(node.type) ? 'border-dashed' : ''}`}
      style={{ opacity: dimmed ? 0.18 : 1 }}
    >
      <span
        className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r"
        style={{ background: color }}
      />
      <TypeGlyph type={node.type} size={14} />
      <div className="min-w-0 flex-1">
        <div className="text-text truncate text-[12.5px] leading-tight font-medium">
          {node.name}
        </div>
        <div className="text-muted truncate text-[10.5px] leading-tight">
          {NODE_LABELS[node.type]}
          {node.meta?.files ? ` · ${node.meta.files} files` : ''}
          {node.meta?.routes?.length ? ` · ${node.meta.routes.length} routes` : ''}
        </div>
      </div>
      {warningCount > 0 && (
        <span
          className="bg-warn/15 text-warn rounded-full px-1.5 text-[10px] leading-4"
          title={`${warningCount} warning(s)`}
        >
          {warningCount}
        </span>
      )}
      {expandable && (
        <span
          className="text-faint group-hover:text-muted text-[13px] transition-colors"
          title="Double-click to expand"
        >
          +
        </span>
      )}
      <Handles />
    </div>
  )
})

export const TzGroupView = memo(function TzGroupView({ data, selected }: NodeProps<GroupNode>) {
  const { node, dimmed } = data
  const color = NODE_COLORS[node.type]
  return (
    <div
      className={`bg-surface/70 h-full w-full rounded-xl border ${selected ? 'border-accent' : 'border-border-strong'}`}
      style={{ opacity: dimmed ? 0.25 : 1 }}
    >
      <div className="border-border flex h-10 items-center gap-2 border-b px-3">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="truncate text-[12.5px] font-medium">{node.name}</span>
        <span className="text-muted truncate text-[10.5px]">
          {NODE_LABELS[node.type]} · {node.children?.length ?? 0} files
        </span>
        <span className="text-faint ml-auto text-[12px]" title="Double-click to collapse">
          −
        </span>
      </div>
      <Handles />
    </div>
  )
})
