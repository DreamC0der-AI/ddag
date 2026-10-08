import { isTagOp, type EventChain } from './chain'
import type { NodeId, Snapshot } from '../kernel/types'

/**
 * Arc tags (shell view over tag events): words laid over an arc — how
 * strongly a whole rests on a part, or any label the project gives its arcs.
 * Not a kernel notion: the kernel knows an arc as bare part-of, and a strong
 * part and a weak one reopen and restore their whole alike. Read from the
 * chain's tag events; a tag lives as long as its arc and is gone once the arc
 * leaves the graph (unlinked, or dropped with a node), so linking the same
 * pair again starts untagged.
 */

export interface ArcTags {
  from: NodeId
  to: NodeId
  tags: string[]
  /** seq of the tag event that set them; the checkpoint's seq for tags from before this segment */
  seq: number
}

/** The two tags every view reads as weight; any other tag is a label the views only show. */
export type Strength = 'strong' | 'weak'

export const arcKey = (from: NodeId, to: NodeId): string => `${from}->${to}`

export function strengthOf(tags: readonly string[]): Strength | undefined {
  return tags.includes('strong') ? 'strong' : tags.includes('weak') ? 'weak' : undefined
}

const arcsIn = (s: Snapshot): Set<string> => new Set(s.arcs.map((a) => arcKey(a.from, a.to)))

/** Every tagged arc as it stands after `upToSeq` (default: now), keyed `from->to`. */
export function readTags(chain: EventChain, upToSeq?: number): Map<string, ArcTags> {
  const out = new Map<string, ArcTags>()
  // tags from before this segment come from its checkpoint, on the arcs its initial graph still has
  const initial = arcsIn(chain.snapshotAt(chain.base))
  for (const t of chain.checkpoint?.tags ?? [])
    if (initial.has(arcKey(t.from, t.to))) out.set(arcKey(t.from, t.to), { ...t, tags: [...t.tags], seq: chain.base })
  for (const ev of chain.chain()) {
    if (upToSeq !== undefined && ev.seq > upToSeq) break
    const op = ev.op
    if (isTagOp(op)) {
      if (op.tags.length > 0) out.set(arcKey(op.from, op.to), { from: op.from, to: op.to, tags: [...op.tags], seq: ev.seq })
      else out.delete(arcKey(op.from, op.to))
      continue
    }
    // only an unlink takes arcs out of the graph — the arc itself, and any arcs of the nodes it drops
    if (op.type !== 'unlink' || out.size === 0) continue
    const standing = arcsIn(chain.snapshotAt(ev.seq))
    for (const k of [...out.keys()]) if (!standing.has(k)) out.delete(k)
  }
  return out
}

/** A node's tagged parts, for the views that list parts: part id → its tags. */
export function partTags(tags: ReadonlyMap<string, ArcTags>, id: NodeId): Map<NodeId, string[]> {
  const m = new Map<NodeId, string[]>()
  for (const t of tags.values()) if (t.to === id) m.set(t.from, t.tags)
  return m
}
