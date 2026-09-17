import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
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

/** Rings: a part sits one ring outside the deepest whole it supports, so every arc points inward. */
const RING_GAP = 190 // least distance between consecutive rings, centre to centre
const SLOT = 2 * NODE_R + 44 // arc length one claim needs on its ring
const CLEAR = NODE_R + 14 // how far an arc must stay from a claim it does not touch

/** depth(n) = longest path from n to the root along arcs; the root is 0. Nodes that do not reach it get 1. */
function depthsOf(snap: Snapshot): Map<NodeId, number> {
  const succ = new Map<NodeId, NodeId[]>()
  for (const n of snap.nodes) succ.set(n.id, [])
  for (const a of snap.arcs) succ.get(a.from)?.push(a.to)
  const depth = new Map<NodeId, number>([[snap.root, 0]])
  const visiting = new Set<NodeId>()
  const of = (id: NodeId): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 1 // a cycle cannot occur in a kernel snapshot; stay total anyway
    visiting.add(id)
    let d = 0
    for (const s of succ.get(id) ?? []) d = Math.max(d, of(s) + 1)
    visiting.delete(id)
    depth.set(id, d === 0 ? 1 : d)
    return depth.get(id)!
  }
  for (const n of snap.nodes) of(n.id)
  return depth
}

/** Ring radii: far enough from the ring inside, and long enough for the claims that sit on it. */
function ringRadii(depth: Map<NodeId, number>): number[] {
  const count: number[] = []
  for (const d of depth.values()) count[d] = (count[d] ?? 0) + 1
  const r: number[] = [0]
  for (let k = 1; k < count.length; k++) r[k] = Math.max(r[k - 1]! + RING_GAP, ((count[k] ?? 0) * SLOT) / (2 * Math.PI))
  return r
}

/** A radial tree over each claim's first whole: every claim gets the middle of a sector sized by its leaves. */
function sectorAngles(snap: Snapshot): Map<NodeId, number> {
  const kids = new Map<NodeId, NodeId[]>()
  for (const n of snap.nodes) kids.set(n.id, [])
  const placed = new Set<NodeId>([snap.root])
  for (const a of snap.arcs) {
    if (placed.has(a.from) || !kids.has(a.to)) continue // first whole wins; later wholes are cross-links
    placed.add(a.from)
    kids.get(a.to)!.push(a.from)
  }
  const leaves = new Map<NodeId, number>()
  const count = (id: NodeId): number => {
    const k = kids.get(id)!
    const c = k.length === 0 ? 1 : k.reduce((sum, x) => sum + count(x), 0)
    leaves.set(id, c)
    return c
  }
  count(snap.root)
  const angle = new Map<NodeId, number>()
  const place = (id: NodeId, from: number, to: number) => {
    angle.set(id, (from + to) / 2)
    let at = from
    for (const k of kids.get(id)!) {
      const span = ((to - from) * leaves.get(k)!) / leaves.get(id)!
      place(k, at, at + span)
      at += span
    }
  }
  place(snap.root, -Math.PI / 2, (3 * Math.PI) / 2)
  return angle
}

interface ArcRef {
  source: NodeId
  target: NodeId
}

/**
 * The force a plain force layout lacks: arcs as obstacles. A claim whose
 * centre comes within CLEAR of an arc it is not an end of is pushed off it
 * along the normal, and the arc's ends lean the other way.
 */
function arcRepel(arcs: ArcRef[], strength = 0.9) {
  let byId = new Map<NodeId, BodyNode & { vx?: number; vy?: number }>()
  let nodes: (BodyNode & { vx?: number; vy?: number })[] = []
  const force = (alpha: number) => {
    for (const a of arcs) {
      const s = byId.get(a.source)
      const t = byId.get(a.target)
      if (!s || !t) continue
      const dx = t.x - s.x
      const dy = t.y - s.y
      const len2 = dx * dx + dy * dy || 1
      for (const n of nodes) {
        if (n === s || n === t) continue
        const u = Math.max(0, Math.min(1, ((n.x - s.x) * dx + (n.y - s.y) * dy) / len2))
        let ox = n.x - (s.x + u * dx)
        let oy = n.y - (s.y + u * dy)
        let d = Math.hypot(ox, oy)
        if (d >= CLEAR) continue
        if (d < 1e-6) {
          ox = -dy
          oy = dx
          d = Math.hypot(ox, oy) || 1
        }
        const k = ((CLEAR - d) / d) * alpha * strength
        n.vx = (n.vx ?? 0) + ox * k
        n.vy = (n.vy ?? 0) + oy * k
        s.vx = (s.vx ?? 0) - ox * k * 0.5 * (1 - u)
        s.vy = (s.vy ?? 0) - oy * k * 0.5 * (1 - u)
        t.vx = (t.vx ?? 0) - ox * k * 0.5 * u
        t.vy = (t.vy ?? 0) - oy * k * 0.5 * u
      }
    }
  }
  force.initialize = (n: BodyNode[]) => {
    nodes = n
    byId = new Map(n.map((x) => [x.id, x]))
  }
  return force
}

/**
 * After the physics, a bounded cleanup that gives the guarantee the physics
 * only tends to: move any free claim still within a radius of a foreign arc
 * off it, and any two claims still overlapping apart. Deterministic.
 */
function settle(bodies: BodyNode[], arcs: ArcRef[]): void {
  const byId = new Map(bodies.map((b) => [b.id, b]))
  const free = (b: BodyNode) => b.fx === undefined
  for (let pass = 0; pass < 60; pass++) {
    let moved = false
    for (const a of arcs) {
      const s = byId.get(a.source)
      const t = byId.get(a.target)
      if (!s || !t) continue
      const dx = t.x - s.x
      const dy = t.y - s.y
      const len2 = dx * dx + dy * dy || 1
      for (const n of bodies) {
        if (n === s || n === t || !free(n)) continue
        const u = Math.max(0, Math.min(1, ((n.x - s.x) * dx + (n.y - s.y) * dy) / len2))
        let ox = n.x - (s.x + u * dx)
        let oy = n.y - (s.y + u * dy)
        let d = Math.hypot(ox, oy)
        if (d >= NODE_R + 6) continue
        if (d < 1e-6) {
          ox = -dy
          oy = dx
          d = Math.hypot(ox, oy) || 1
        }
        const push = NODE_R + 8 - d
        n.x += (ox / d) * push
        n.y += (oy / d) * push
        moved = true
      }
    }
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!
        const b = bodies[j]!
        let ox = b.x - a.x
        let oy = b.y - a.y
        let d = Math.hypot(ox, oy)
        if (d >= 2 * NODE_R + 10) continue
        if (d < 1e-6) {
          ox = 1
          oy = 0
          d = 1
        }
        const push = (2 * NODE_R + 12 - d) / 2
        if (free(a)) {
          a.x -= (ox / d) * push
          a.y -= (oy / d) * push
        }
        if (free(b)) {
          b.x += (ox / d) * push
          b.y += (oy / d) * push
        }
        moved = true
      }
    if (!moved) break
  }
}

/**
 * The graph's layout: a force simulation on depth rings. The root sits at the
 * centre; a part sits one ring outside the deepest whole it supports, so arcs
 * point inward; a fresh graph is seeded as a radial tree so a hub's parts fan
 * out inside its own sector; arcs repel the claims they do not touch; and a
 * bounded cleanup removes what is left. Previous positions seed the run so
 * the picture stays put step to step, new claims hatch outward of their
 * whole, and user-pinned claims hold. Returns CENTER coordinates per node.
 */
export function forceLayout(
  snap: Snapshot,
  prev: Map<NodeId, { x: number; y: number }>,
  pinned: Map<NodeId, { x: number; y: number }> = new Map(),
): Map<NodeId, { x: number; y: number }> {
  const depth = depthsOf(snap)
  const radius = ringRadii(depth)
  const ringOf = (id: NodeId) => radius[depth.get(id) ?? 1] ?? 0
  const centre = pinned.get(snap.root) ?? { x: 0, y: 0 }
  const fresh = snap.nodes.every((n) => n.id === snap.root || !prev.has(n.id))
  const sector = sectorAngles(snap)

  const bodies: BodyNode[] = snap.nodes.map((n) => {
    const p = prev.get(n.id)
    if (p && !fresh) return { id: n.id, x: p.x, y: p.y }
    if (fresh) {
      const a = sector.get(n.id) ?? 0
      return { id: n.id, x: centre.x + Math.cos(a) * ringOf(n.id), y: centre.y + Math.sin(a) * ringOf(n.id) }
    }
    // a new claim in a settled picture: outward of its first whole, nudged by a stable angle
    const firstArc = snap.arcs.find((a) => a.from === n.id)
    const near = firstArc ? prev.get(firstArc.to) : undefined
    const j = jitterFor(n.id)
    const out = near && Math.hypot(near.x - centre.x, near.y - centre.y) > 1 ? Math.atan2(near.y - centre.y, near.x - centre.x) : Math.atan2(j.y, j.x)
    const a = out + j.x * 0.35
    return { id: n.id, x: centre.x + Math.cos(a) * ringOf(n.id), y: centre.y + Math.sin(a) * ringOf(n.id) }
  })
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
    root.x = 0
    root.y = 0
    root.fx = 0
    root.fy = 0
  }

  const links = snap.arcs.map((a) => ({ source: a.from, target: a.to }))
  const arcs: ArcRef[] = snap.arcs.map((a) => ({ source: a.from, target: a.to }))

  const sim = forceSimulation(bodies)
    .force(
      'link',
      forceLink<BodyNode, { source: string; target: string }>(links)
        .id((d) => d.id)
        .distance((l) => {
          const s = (l.source as unknown as BodyNode).id ?? (l.source as unknown as string)
          const t = (l.target as unknown as BodyNode).id ?? (l.target as unknown as string)
          return Math.max(RING_GAP, Math.abs(ringOf(s) - ringOf(t)))
        })
        .strength(0.25),
    )
    .force('charge', forceManyBody().strength(-420).distanceMax(700))
    .force('collide', forceCollide(NODE_R + 20).iterations(2))
    .force('ring', forceRadial<BodyNode>((d) => ringOf(d.id), centre.x, centre.y).strength(0.85))
    .force('arcs', arcRepel(arcs))
    .stop()

  for (let i = 0; i < 300; i++) sim.tick()
  settle(bodies, arcs)

  return new Map(bodies.map((b) => [b.id, { x: b.x, y: b.y }]))
}

/**
 * How unreadable a layout is, as counts: arcs whose segment passes within a
 * claim's radius of a claim that is not one of its ends, and pairs of claims
 * closer than a diameter. Pure; the layout tests assert both are zero.
 */
export function layoutDefects(
  snap: Pick<Snapshot, 'nodes' | 'arcs'>,
  centers: Map<NodeId, { x: number; y: number }>,
  clearance = NODE_R,
): { arcThroughNode: number; nodeOverlap: number } {
  let arcThroughNode = 0
  for (const a of snap.arcs) {
    const s = centers.get(a.from)
    const t = centers.get(a.to)
    if (!s || !t) continue
    const dx = t.x - s.x
    const dy = t.y - s.y
    const len2 = dx * dx + dy * dy || 1
    for (const n of snap.nodes) {
      if (n.id === a.from || n.id === a.to) continue
      const c = centers.get(n.id)
      if (!c) continue
      const u = Math.max(0, Math.min(1, ((c.x - s.x) * dx + (c.y - s.y) * dy) / len2))
      const d = Math.hypot(c.x - (s.x + u * dx), c.y - (s.y + u * dy))
      if (d < clearance) arcThroughNode++
    }
  }
  let nodeOverlap = 0
  const ids = snap.nodes.map((n) => n.id)
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = centers.get(ids[i]!)
      const b = centers.get(ids[j]!)
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 2 * NODE_R) nodeOverlap++
    }
  return { arcThroughNode, nodeOverlap }
}

