import { expect } from 'vitest'
import type { Graph } from '../graph'

/** A node's justification, by actual contents (the thing Verify judged). */
export interface Justification {
  own: string
  preds: Record<string, string>
}

export function justification(g: Graph, id: string): Justification {
  return {
    own: g.node(id).content,
    preds: Object.fromEntries(g.predecessors(id).map((p) => [p, g.node(p).content])),
  }
}

/**
 * Model-based restore-soundness oracle: every valid verdict must be backed by
 * an explicit Verify whose recorded justification contents equal the node's
 * current justification — a restore that revalidates a node over different
 * contents (e.g. a re-added id) violates this.
 */
export function checkJustifications(g: Graph, shadow: Map<string, Justification>): void {
  for (const id of g.ids()) {
    if (g.verdict(id) === 'valid') {
      const recorded = shadow.get(id)
      expect(recorded, `valid node "${id}" has no recorded verification`).toBeDefined()
      expect(justification(g, id)).toEqual(recorded)
    }
  }
}

/** The state laws: I1–I3, succ/pred mirroring, solid definition, D1. */
export function checkInvariants(g: Graph): void {
  const ids = g.ids()

  // root is the sole sink; every non-root node has >= 1 successor
  expect(g.successors(g.root)).toEqual([])
  for (const id of ids) {
    if (id !== g.root) expect(g.successors(id).length).toBeGreaterThan(0)
  }

  // succ/pred mirror each other
  for (const id of ids) {
    for (const s of g.successors(id)) expect(g.predecessors(s)).toContain(id)
    for (const p of g.predecessors(id)) expect(g.successors(p)).toContain(id)
  }

  // connected: every node reaches root (BFS from root along pred arcs)
  const reachable = new Set([g.root])
  const queue = [g.root]
  while (queue.length > 0) {
    for (const p of g.predecessors(queue.shift()!)) {
      if (!reachable.has(p)) {
        reachable.add(p)
        queue.push(p)
      }
    }
  }
  expect([...reachable].sort()).toEqual([...ids].sort())

  // acyclic: Kahn over succ arcs processes every node
  const indeg = new Map(ids.map((id) => [id, g.predecessors(id).length]))
  const topo = ids.filter((id) => indeg.get(id) === 0)
  let processed = 0
  while (topo.length > 0) {
    const n = topo.shift()!
    processed += 1
    for (const s of g.successors(n)) {
      const d = indeg.get(s)! - 1
      indeg.set(s, d)
      if (d === 0) topo.push(s)
    }
  }
  expect(processed).toBe(ids.length)

  // solid ≡ (verdict == valid ∧ all preds solid); valid ⇒ all preds solid
  for (const id of ids) {
    const predsSolid = g.predecessors(id).every((p) => g.solid(p))
    expect(g.solid(id)).toBe(g.verdict(id) === 'valid' && predsSolid)
    if (g.verdict(id) === 'valid') expect(predsSolid).toBe(true)
  }
}
