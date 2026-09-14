import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'
import type { NodeId, Snapshot } from '../kernel/types'

export const NODE_R = 34 // circle radius (matches .sim-node in styles.css)

interface BodyNode {
  id: NodeId
  x: number
  y: number
  fx?: number
  fy?: number
}

/** Deterministic pseudo-angle from an id, for placing brand-new nodes. */
function jitterFor(id: string): { x: number; y: number } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  const angle = ((h >>> 0) % 360) * (Math.PI / 180)
  return { x: Math.cos(angle), y: Math.sin(angle) }
}

/**
 * Force-directed layout: root pinned at the center, parts scatter and cluster
 * around it (arcs as springs, nodes repelling). Previous positions seed the
 * simulation so the picture stays stable step to step; new nodes hatch next
 * to their successor. Returns CENTER coordinates per node.
 */
export function forceLayout(
  snap: Snapshot,
  prev: Map<NodeId, { x: number; y: number }>,
  pinned: Map<NodeId, { x: number; y: number }> = new Map(),
): Map<NodeId, { x: number; y: number }> {
  const bodies: BodyNode[] = snap.nodes.map((n) => {
    const p = prev.get(n.id)
    if (p) return { id: n.id, x: p.x, y: p.y }
    // hatch near the first successor (or near center), nudged by a stable angle
    const firstArc = snap.arcs.find((a) => a.from === n.id)
    const near = firstArc ? prev.get(firstArc.to) : undefined
    const j = jitterFor(n.id)
    return {
      id: n.id,
      x: (near?.x ?? 0) + j.x * 90,
      y: (near?.y ?? 0) + j.y * 90,
    }
  })
  // user-pinned nodes hold their dragged positions; the root defaults to the
  // center unless the user has dragged it somewhere themselves
  for (const b of bodies) {
    const pin = pinned.get(b.id)
    if (pin) {
      b.x = pin.x
      b.y = pin.y
      b.fx = pin.x
      b.fy = pin.y
    }
  }
  const root = bodies.find((b) => b.id === snap.root)!
  if (!pinned.has(snap.root)) {
    root.fx = 0
    root.fy = 0
  }

  const links = snap.arcs.map((a) => ({ source: a.from, target: a.to }))

  // Spring length is CENTER-to-center: 220px leaves ~150px of clear space
  // between 68px circles. Gravity is kept weak so it cannot compress the
  // springs; repulsion does the de-densifying between unlinked nodes.
  const sim = forceSimulation(bodies)
    .force(
      'link',
      forceLink<BodyNode, { source: string; target: string }>(links)
        .id((d) => d.id)
        .distance(220)
        .strength(0.4),
    )
    .force('charge', forceManyBody().strength(-650))
    .force('collide', forceCollide(NODE_R + 18))
    .force('x', forceX(0).strength(0.015))
    .force('y', forceY(0).strength(0.015))
    .stop()

  for (let i = 0; i < 300; i++) sim.tick()

  return new Map(bodies.map((b) => [b.id, { x: b.x, y: b.y }]))
}
