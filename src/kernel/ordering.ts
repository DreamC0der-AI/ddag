import { frontier } from './actions'
import { Graph } from './graph'
import type { NodeId } from './types'

/**
 * The frontier-ordering view (roadmap: ordering): where is the next judgment
 * best spent? For each frontier node, simulate `Verify(n) = valid` on a clone
 * and read the EXACT consequences off the kernel — determinism makes the
 * lookahead free and sound, no heuristics. A view, never a gate: the kernel
 * refused judgment cascades by design ("never cascade — use a view to plan
 * what to verify first"), so this ranks and nothing more.
 *
 * Only the valid outcome is simulated: the view prices the win, not the
 * information value of a possible refutation (a deliberate v1 boundary).
 */
export interface FrontierRank {
  id: NodeId
  /** Nodes whose judgments come back FREE via Restore if n verifies valid. */
  restored: NodeId[]
  /** Nodes newly verifiable (joining the frontier) once n is solid. */
  unlocked: NodeId[]
  /** The winning move: the root itself turns solid. */
  rootSolid: boolean
}

export function score(r: FrontierRank): number {
  return r.restored.length + r.unlocked.length
}

export interface RankOptions {
  /**
   * Doctrine P1 (no trivial win): leave an UNDECOMPOSED root out of the
   * ranking — verifying it bare would end the game without a single part.
   * A shell policy over the kernel-true frontier, off by default.
   */
  noTrivialWin?: boolean
  /** The node whose turning solid is the win; the kernel root by default. A target on a multi-target chain. */
  target?: NodeId
  /** Rank only these frontier nodes, and count unlocks only among them: a target's cone, minus what other targets judge. */
  only?: Set<NodeId>
}

/** Rank the frontier best-first: winning moves, then restore+unlock yield. */
export function rankFrontier(g: Graph, o: RankOptions = {}): FrontierRank[] {
  const snap = g.snapshot()
  const target = o.target ?? g.root
  const front = frontier(g).filter(
    (id) => (o.only === undefined || o.only.has(id)) && !(o.noTrivialWin && id === target && g.predecessors(target).length === 0),
  )
  const beforeFront = new Set(front)
  const rootWasSolid = g.solid(target)

  const ranks: FrontierRank[] = front.map((id) => {
    const sim = Graph.fromSnapshot(snap)
    if (!sim.apply({ type: 'verify', id, result: 'valid' }).ok) {
      return { id, restored: [], unlocked: [], rootSolid: false } // duality says unreachable
    }
    const restored = sim
      .ids()
      .filter((x) => x !== id && g.verdict(x) !== 'valid' && sim.verdict(x) === 'valid')
    const unlocked = frontier(sim).filter((x) => !beforeFront.has(x) && (o.only === undefined || o.only.has(x)))
    return { id, restored, unlocked, rootSolid: !rootWasSolid && sim.solid(target) }
  })

  ranks.sort((a, b) => {
    if (a.rootSolid !== b.rootSolid) return a.rootSolid ? -1 : 1
    const d = score(b) - score(a)
    return d !== 0 ? d : a.id.localeCompare(b.id) // stable, deterministic
  })
  return ranks
}
