import type { Graph } from './graph'
import type { NodeId } from './types'

/**
 * The action space (DESIGN.md "Enabled Actions"): the legal next moves of a
 * graph, as a pure computed view. Mirrors each operation's `requires` clause —
 * the duality property test pins `action ∈ enabled(G) ⟺ apply succeeds`.
 *
 * `add` carries no id/content: fresh ids are interchangeable, minted by the
 * shell. `mutate` forks by content class: `fresh` (any new text) vs `revert`
 * (the exact verified text — triggers Restore; payload recovered by the shell
 * from the event chain, see src/chain/epistemic.ts).
 */
export type Action =
  | { type: 'add'; successor: NodeId }
  | { type: 'link'; from: NodeId; to: NodeId }
  | { type: 'unlink'; from: NodeId; to: NodeId }
  | { type: 'mutate'; id: NodeId; contentClass: 'fresh' | 'revert' }
  | { type: 'verify'; id: NodeId; result: 'valid' | 'invalid' }
  | { type: 'doubt'; id: NodeId }

/** frontier(G): nodes where verification can proceed right now. */
export function frontier(g: Graph): NodeId[] {
  return g
    .ids()
    .filter((id) => g.verdict(id) !== 'valid' && g.predecessors(id).every((p) => g.solid(p)))
}

/** True iff `to` is reachable from `from` along succ arcs (zero or more). */
function reaches(g: Graph, from: NodeId, to: NodeId): boolean {
  if (from === to) return true
  const seen = new Set<NodeId>([from])
  const stack: NodeId[] = [from]
  while (stack.length > 0) {
    const n = stack.pop()!
    for (const s of g.successors(n)) {
      if (s === to) return true
      if (!seen.has(s)) {
        seen.add(s)
        stack.push(s)
      }
    }
  }
  return false
}

/** enabled(G), in spec order: Add, Link, Unlink, Mutate (fresh/revert), Verify. */
export function enabledActions(g: Graph): Action[] {
  const ids = g.ids()
  const actions: Action[] = []

  for (const s of ids) actions.push({ type: 'add', successor: s })

  for (const from of ids) {
    if (from === g.root) continue // I2
    const existing = new Set(g.successors(from))
    for (const to of ids) {
      if (to === from || existing.has(to)) continue
      if (reaches(g, to, from)) continue // I1: would create a cycle
      actions.push({ type: 'link', from, to })
    }
  }

  for (const from of ids) {
    for (const to of g.successors(from)) actions.push({ type: 'unlink', from, to })
  }

  for (const id of ids) {
    actions.push({ type: 'mutate', id, contentClass: 'fresh' })
    if (g.node(id).fingerprint !== null) actions.push({ type: 'mutate', id, contentClass: 'revert' })
  }

  for (const id of frontier(g)) {
    actions.push({ type: 'verify', id, result: 'valid' })
    actions.push({ type: 'verify', id, result: 'invalid' })
  }

  for (const id of ids) {
    if (g.verdict(id) === 'valid') actions.push({ type: 'doubt', id })
  }

  return actions
}
