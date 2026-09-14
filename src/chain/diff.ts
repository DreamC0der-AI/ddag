import type { Arc, NodeId, Snapshot, Verdict } from '../kernel/types'

/**
 * What changed between two snapshots. Presentation-layer: consumers (UI,
 * dashboard) use this instead of kernel change events — the kernel emits none.
 */
export interface SnapshotDiff {
  addedNodes: NodeId[]
  droppedNodes: NodeId[]
  addedArcs: Arc[]
  removedArcs: Arc[]
  mutatedNodes: NodeId[] // content version changed
  verdictChanged: { id: NodeId; from: Verdict; to: Verdict }[]
  solidChanged: { id: NodeId; from: boolean; to: boolean }[]
}

export function isEmptyDiff(d: SnapshotDiff): boolean {
  return (
    d.addedNodes.length === 0 &&
    d.droppedNodes.length === 0 &&
    d.addedArcs.length === 0 &&
    d.removedArcs.length === 0 &&
    d.mutatedNodes.length === 0 &&
    d.verdictChanged.length === 0 &&
    d.solidChanged.length === 0
  )
}

/** Recompute solid from a snapshot (solid is never serialized), preds-before-succs. */
export function computeSolid(snap: Snapshot): Map<NodeId, boolean> {
  const pred = new Map<NodeId, NodeId[]>()
  const succ = new Map<NodeId, NodeId[]>()
  const verdicts = new Map<NodeId, Verdict>()
  for (const n of snap.nodes) {
    pred.set(n.id, [])
    succ.set(n.id, [])
    verdicts.set(n.id, n.verdict)
  }
  for (const a of snap.arcs) {
    succ.get(a.from)!.push(a.to)
    pred.get(a.to)!.push(a.from)
  }
  const solid = new Map<NodeId, boolean>()
  const indeg = new Map<NodeId, number>()
  const queue: NodeId[] = []
  for (const n of snap.nodes) {
    const d = pred.get(n.id)!.length
    indeg.set(n.id, d)
    if (d === 0) queue.push(n.id)
  }
  while (queue.length > 0) {
    const n = queue.shift()!
    solid.set(n, verdicts.get(n) === 'valid' && pred.get(n)!.every((p) => solid.get(p)!))
    for (const s of succ.get(n)!) {
      const d = indeg.get(s)! - 1
      indeg.set(s, d)
      if (d === 0) queue.push(s)
    }
  }
  return solid
}

const arcKey = (a: Arc): string => JSON.stringify([a.from, a.to])

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]))
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]))
  const beforeArcs = new Map(before.arcs.map((a) => [arcKey(a), a]))
  const afterArcs = new Map(after.arcs.map((a) => [arcKey(a), a]))
  const beforeSolid = computeSolid(before)
  const afterSolid = computeSolid(after)

  const diff: SnapshotDiff = {
    addedNodes: [],
    droppedNodes: [],
    addedArcs: [],
    removedArcs: [],
    mutatedNodes: [],
    verdictChanged: [],
    solidChanged: [],
  }

  for (const id of afterNodes.keys()) if (!beforeNodes.has(id)) diff.addedNodes.push(id)
  for (const id of beforeNodes.keys()) if (!afterNodes.has(id)) diff.droppedNodes.push(id)
  for (const [k, a] of afterArcs) if (!beforeArcs.has(k)) diff.addedArcs.push(a)
  for (const [k, a] of beforeArcs) if (!afterArcs.has(k)) diff.removedArcs.push(a)

  for (const [id, b] of beforeNodes) {
    const a = afterNodes.get(id)
    if (!a) continue
    if (a.version !== b.version) diff.mutatedNodes.push(id)
    if (a.verdict !== b.verdict) diff.verdictChanged.push({ id, from: b.verdict, to: a.verdict })
    const sb = beforeSolid.get(id)!
    const sa = afterSolid.get(id)!
    if (sa !== sb) diff.solidChanged.push({ id, from: sb, to: sa })
  }

  return diff
}
