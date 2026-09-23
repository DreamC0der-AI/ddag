import { isCarryOp, type EventChain, type Provenance } from './chain'
import type { NodeId } from '../kernel/types'

/** Where a node's current pin comes from: its last valid judgment, or a later carry that moved it (nc-carry). */
export interface LastPin {
  provenance: Provenance
  /** set when the pin was moved by a carry after the judgment — on the agent's word, not re-examined */
  carried?: { seq: number; round: string }
}

/**
 * A node's current pin: read back from the latest event that pinned it — a
 * valid judgment, or a carry made after one — in this segment, else from the
 * segment's checkpoint. Undefined when the node was never judged valid with
 * provenance, or its last valid judgment carried none.
 */
export function lastPin(chain: EventChain, id: NodeId): LastPin | undefined {
  const events = chain.chain()
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (isCarryOp(e.op)) {
      const own = e.op.pins.find((p) => p.id === id)
      if (own) return { provenance: own.provenance, carried: { seq: e.seq, round: e.op.round } }
      continue
    }
    if (e.op.type === 'verify' && e.op.id === id && e.op.result === 'valid') return e.provenance ? { provenance: e.provenance } : undefined
  }
  const memo = chain.checkpoint?.nodes[id]?.judged
  if (memo === undefined || memo.result !== 'valid' || memo.provenance === undefined) return undefined
  return memo.carried ? { provenance: memo.provenance, carried: memo.carried } : { provenance: memo.provenance }
}

/** The artifact paths of a node's current pin; empty when it has none. */
export function lastPinnedPaths(chain: EventChain, id: NodeId): string[] {
  return (lastPin(chain, id)?.provenance.artifacts ?? []).map((a) => a.path)
}
