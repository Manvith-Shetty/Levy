import type { Agent } from './types'
import type { AgentIndex } from './selectors'

export const NODE_W = 192
export const NODE_H = 112
export const H_GAP = 18
export const V_GAP = 56

export interface LaidOutNode {
  agent: Agent
  x: number
  y: number
  depth: number
}

export interface LaidOutEdge {
  id: string
  parentId: string
  childId: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  /** Authority carried down this edge — drives the stroke weight. */
  amount: number
}

export interface TreeLayout {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  width: number
  height: number
  maxEdgeAmount: number
}

/**
 * Tidy top-down layout. Leaves are packed left to right; every parent is
 * centred over the span its children occupy, so the picture reads as
 * containment rather than as a generic org chart.
 */
export function layoutTree(index: AgentIndex, rootId: string): TreeLayout {
  const nodes: LaidOutNode[] = []
  const edges: LaidOutEdge[] = []
  let cursor = 0

  const place = (id: string, depth: number): number => {
    const agent = index[id]
    if (!agent) return 0

    const children = agent.children.filter((childId) => index[childId])
    let center: number

    if (children.length === 0) {
      center = cursor + NODE_W / 2
      cursor += NODE_W + H_GAP
    } else {
      const centers = children.map((childId) => place(childId, depth + 1))
      center = (centers[0] + centers[centers.length - 1]) / 2
    }

    const y = depth * (NODE_H + V_GAP)
    nodes.push({ agent, x: center - NODE_W / 2, y, depth })

    for (const childId of children) {
      const child = index[childId]
      const childNode = nodes.find((n) => n.agent.id === childId)
      if (!child || !childNode) continue
      edges.push({
        id: `${id}->${childId}`,
        parentId: id,
        childId,
        from: { x: center, y: y + NODE_H },
        to: { x: childNode.x + NODE_W / 2, y: childNode.y },
        amount: child.status === 'revoked' ? 0 : child.authority,
      })
    }

    return center
  }

  place(rootId, 0)

  const width = Math.max(0, cursor - H_GAP)
  const depth = nodes.reduce((max, node) => Math.max(max, node.depth), 0)
  const height = (depth + 1) * NODE_H + depth * V_GAP
  const maxEdgeAmount = edges.reduce((max, edge) => Math.max(max, edge.amount), 1)

  return { nodes, edges, width, height, maxEdgeAmount }
}

/** Orthogonal connector with rounded corners, drawn parent-bottom to child-top. */
export function edgePath(edge: LaidOutEdge): string {
  const { from, to } = edge
  const midY = from.y + V_GAP / 2
  const r = Math.min(10, Math.abs(to.x - from.x) / 2)

  if (Math.abs(to.x - from.x) < 1) {
    return `M${from.x} ${from.y} L${from.x} ${to.y}`
  }

  const dir = to.x > from.x ? 1 : -1
  return [
    `M${from.x} ${from.y}`,
    `L${from.x} ${midY - r}`,
    `Q${from.x} ${midY} ${from.x + dir * r} ${midY}`,
    `L${to.x - dir * r} ${midY}`,
    `Q${to.x} ${midY} ${to.x} ${midY + r}`,
    `L${to.x} ${to.y}`,
  ].join(' ')
}
