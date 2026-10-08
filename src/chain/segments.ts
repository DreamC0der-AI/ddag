import { isRoundOp, type ChainDump, type Checkpoint, type EventChain, type NodeMemo } from './chain'
import type { NodeId } from '../kernel/types'
import { readIssues } from './issues'
import { readVersions } from './versions'
import { lastPin } from './pins'
import { homesOf } from './targets'
import { readTags } from './tags'

/**
 * Segments (chain-segments): a chain is rolled at a version mark into a
 * sealed segment and a live one. The live segment starts from a checkpoint —
 * the graph snapshot plus what the readers would otherwise derive from the
 * sealed events — so a session loads only what it needs, and the sealed
 * segment is a complete, replayable chain of its own. Event numbers continue
 * across segments. The kernel knows nothing of this: a checkpoint is a
 * keyframe, which the chain always allowed.
 */

/**
 * What every node in the graph now is remembered by: why it was added and
 * how it was last judged, read from this segment's events or inherited from
 * its checkpoint when the segment says nothing about the node.
 */
export function nodeMemos(chain: EventChain): Record<NodeId, NodeMemo> {
  const events = chain.chain()
  const out: Record<NodeId, NodeMemo> = {}
  for (const id of chain.graph.ids()) {
    const memo: NodeMemo = {}
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (memo.judged === undefined && e.op.type === 'verify' && e.op.id === id) {
        const content = chain.snapshotAt(e.seq).nodes.find((n) => n.id === id)?.content ?? ''
        memo.judged = { seq: e.seq, result: e.op.result, content }
        if (e.evidence !== undefined) memo.judged.evidence = e.evidence
        if (e.round !== undefined) memo.judged.round = e.round
        if (e.provenance !== undefined) memo.judged.provenance = e.provenance
      }
      if (memo.because === undefined && e.op.type === 'add' && e.op.id === id && e.evidence !== undefined) memo.because = e.evidence
      if (memo.judged !== undefined && memo.because !== undefined) break
    }
    const inherited = chain.checkpoint?.nodes[id]
    if (memo.judged === undefined && inherited?.judged !== undefined) memo.judged = { ...inherited.judged }
    if (memo.because === undefined && inherited?.because !== undefined) memo.because = inherited.because
    // the pin as it stands now, carries included, is what the next segment's audit reads
    if (memo.judged !== undefined && memo.judged.result === 'valid') {
      const pin = lastPin(chain, id)
      if (pin !== undefined) {
        memo.judged.provenance = pin.provenance
        if (pin.carried !== undefined) memo.judged.carried = pin.carried
        else delete memo.judged.carried
      }
    }
    if (memo.judged !== undefined || memo.because !== undefined) out[id] = memo
  }
  return out
}

/** The checkpoint a segment sealed now would leave for the next one. */
export function checkpointOf(chain: EventChain, o: { segment: number; parent?: string; after?: string }): Checkpoint {
  const rounds = [
    ...(chain.checkpoint?.rounds ?? []),
    ...chain
      .chain()
      .filter((e) => isRoundOp(e.op))
      .map((e) => ({ key: (e.op as { key: string }).key, title: (e.op as { title: string }).title, seq: e.seq })),
  ]
  const cp: Checkpoint = {
    seq: chain.position,
    segment: o.segment,
    nodes: nodeMemos(chain),
    issues: readIssues(chain),
    versions: readVersions(chain),
    rounds,
  }
  if (o.parent !== undefined) cp.parent = o.parent
  if (o.after !== undefined) cp.after = o.after
  if (chain.project !== undefined) cp.homes = Object.fromEntries(homesOf(chain)) // targets: every node's home survives the roll
  const tags = [...readTags(chain).values()].map(({ from, to, tags }) => ({ from, to, tags }))
  if (tags.length > 0) cp.tags = tags // arc tags survive the roll; the tag events that set them are sealed
  return cp
}

/** The live segment that follows a sealed one: its graph as it stands, no events yet, the checkpoint behind it. */
export function nextSegment(chain: EventChain, checkpoint: Checkpoint): ChainDump {
  const d: ChainDump = { initial: chain.current(), events: [], checkpoint }
  if (chain.project !== undefined) d.meta = { project: chain.project }
  return d
}
