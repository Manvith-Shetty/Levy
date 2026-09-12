import { useEffect, useMemo, useRef, useState } from 'react'
import { useLeash } from '../../lib/store'
import { deriveStatus, statsFor, type AgentIndex } from '../../lib/selectors'
import { edgePath, layoutTree, NODE_H, NODE_W, type LaidOutNode } from '../../lib/treeLayout'
import type { Agent } from '../../lib/types'
import { cx, formatDate, money, percent, STATUS_LABEL, STATUS_TONE, timeUntil } from '../../lib/utils'
import { AuthorityMeter } from '../common/Meter'

const PAD_X = 28
const PAD_Y = 16

export function AgentTree({
  rootId,
  selectedId,
  onSelect,
}: {
  rootId: string
  selectedId?: string
  onSelect: (agent: Agent) => void
}) {
  const { index } = useLeash()
  const [hovered, setHovered] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [frameW, setFrameW] = useState(0)

  const layout = useMemo(() => layoutTree(index, rootId), [index, rootId])

  const canvasW = layout.width + PAD_X * 2
  const canvasH = layout.height + PAD_Y * 2 + 8

  // A wide hierarchy is scaled to fit rather than scrolled: the shape of the
  // tree is the point. Below a readable floor (phones) it scrolls instead,
  // opening centred on the root.
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const fit = () => setFrameW(element.clientWidth)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [canvasW])

  const MIN_SCALE = 0.62
  const scale = frameW === 0 ? 1 : Math.min(1, Math.max(MIN_SCALE, frameW / canvasW))
  const scaledW = canvasW * scale
  const offset = Math.max(0, (frameW - scaledW) / 2)
  const hoveredNode = layout.nodes.find((n) => n.agent.id === hovered)
  const root = layout.nodes.find((n) => n.agent.id === rootId)

  useEffect(() => {
    const element = frame.current
    if (!element || !root || scaledW <= frameW) return
    element.scrollLeft = (root.x + PAD_X + NODE_W / 2) * scale - frameW / 2
  }, [frameW, scaledW, scale, root])

  return (
    <div ref={frame} className="relative w-full overflow-x-auto overflow-y-hidden">
      <div className="relative" style={{ width: Math.max(frameW, scaledW), height: canvasH * scale }}>
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: canvasW,
          height: canvasH,
          transform: `translateX(${offset}px) scale(${scale})`,
        }}
        onMouseLeave={() => setHovered(null)}
      >
        <svg
          className="pointer-events-none absolute inset-0"
          width={canvasW}
          height={canvasH}
          aria-hidden
        >
          <g transform={`translate(${PAD_X} ${PAD_Y})`}>
            {layout.edges.map((edge) => {
              const child = index[edge.childId]
              const dead = child?.status === 'revoked' || child?.status === 'expired'
              const active =
                hovered === edge.parentId ||
                hovered === edge.childId ||
                selectedId === edge.parentId ||
                selectedId === edge.childId
              // Stroke weight carries the delegated amount: thick lines are
              // large grants, so the shrinking of authority down the tree is
              // visible before any number is read.
              const weight = 1.2 + 6.5 * Math.sqrt(edge.amount / layout.maxEdgeAmount)
              return (
                <path
                  key={edge.id}
                  d={edgePath(edge)}
                  fill="none"
                  strokeLinecap="round"
                  strokeWidth={dead ? 1.2 : weight}
                  strokeDasharray={dead ? '3 4' : undefined}
                  stroke={dead ? '#3a3f48' : active ? '#7a6bff' : '#4b41a8'}
                  opacity={dead ? 0.7 : active ? 1 : 0.72}
                />
              )
            })}
          </g>
        </svg>

        {layout.nodes.map((node) => (
          <TreeNode
            key={node.agent.id}
            node={node}
            index={index}
            selected={selectedId === node.agent.id}
            hovered={hovered === node.agent.id}
            onHover={setHovered}
            onSelect={onSelect}
          />
        ))}

        {hoveredNode && <Tooltip node={hoveredNode} index={index} canvasW={canvasW} />}
      </div>
      </div>
    </div>
  )
}

function TreeNode({
  node,
  index,
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  node: LaidOutNode
  index: AgentIndex
  selected: boolean
  hovered: boolean
  onHover: (id: string | null) => void
  onSelect: (agent: Agent) => void
}) {
  const { agent } = node
  const stats = statsFor(index, agent.id)
  const status = deriveStatus(agent, index)
  const dead = status === 'revoked' || status === 'expired'
  const expiry = timeUntil(agent.expiresAt)

  return (
    <button
      type="button"
      onMouseEnter={() => onHover(agent.id)}
      onFocus={() => onHover(agent.id)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(agent)}
      className={cx(
        'press absolute flex flex-col justify-between rounded-lg border p-3 text-left',
        dead
          ? 'border-line bg-[#0e0f12] opacity-70'
          : selected
            ? 'border-authority/70 bg-[#121917] shadow-[var(--shadow-glow-authority)]'
            : hovered
              ? 'border-line-strong bg-raised shadow-[var(--shadow-floating)]'
              : 'border-line bg-surface shadow-[var(--shadow-raised)]',
        !dead && 'hover:-translate-y-0.5',
      )}
      style={{ left: node.x + PAD_X, top: node.y + PAD_Y, width: NODE_W, height: NODE_H }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[13px] leading-[1.25] font-medium text-ink">
          <span
            aria-hidden
            className={cx(
              'mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full align-middle',
              STATUS_TONE[status].dot,
            )}
          />
          {agent.name}
        </span>
        {stats.childCount > 0 && (
          <span className="numeric shrink-0 rounded bg-delegated/12 px-1 text-[10.5px] text-delegated">
            {stats.childCount}
          </span>
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="numeric text-[17px] leading-none font-semibold text-ink">
            {money(agent.authority)}
          </span>
          <span
            className={cx(
              'numeric text-[11.5px]',
              stats.utilization >= 0.8 ? 'text-warn' : 'text-muted',
            )}
          >
            {percent(stats.utilization)} used
          </span>
        </div>
        <AuthorityMeter
          authority={agent.authority}
          spent={stats.spent}
          reserved={stats.reserved}
          size="sm"
          muted={dead}
          className="mt-2"
        />
      </div>

      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="numeric text-muted">{money(stats.spent)} spent</span>
        <span className={cx(expiry.soon && !dead ? 'text-warn' : 'text-faint')}>
          {dead ? STATUS_LABEL[status] : expiry.label.replace('Expires in ', '')}
        </span>
      </div>
    </button>
  )
}

function Tooltip({
  node,
  index,
  canvasW,
}: {
  node: LaidOutNode
  index: AgentIndex
  canvasW: number
}) {
  const stats = statsFor(index, node.agent.id)
  const width = 210
  const flip = node.x + PAD_X + NODE_W + 12 + width > canvasW
  const left = flip ? node.x + PAD_X - width - 12 : node.x + PAD_X + NODE_W + 12

  const rows: [string, string][] = [
    ['Authority', money(node.agent.authority)],
    ['Spent', money(stats.spent)],
    ['Remaining', money(stats.remaining)],
    ['Children', String(stats.childCount)],
    ['Expires', node.agent.expiresAt ? formatDate(node.agent.expiresAt) : 'Never'],
  ]

  return (
    <div
      className="animate-enter pointer-events-none absolute z-20 rounded-lg border border-line-strong bg-raised p-3 shadow-[var(--shadow-floating)]"
      style={{ left: Math.max(4, left), top: node.y + PAD_Y, width }}
    >
      <p className="mb-2 text-[12.5px] font-medium text-ink">{node.agent.name}</p>
      <dl className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[11.5px] text-muted">{label}</dt>
            <dd className="numeric truncate text-[12px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
