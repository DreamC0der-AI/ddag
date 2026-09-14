import { sha256Hex } from './hash'
import type { Arc, DagNode, Fingerprint, NodeId, Op, Result, Snapshot, Verdict } from './types'

interface NodeState {
  content: string
  contentHash: string // h(content), maintained on create/mutate; never serialized
  version: number
  verdict: Verdict
  fingerprint: Fingerprint | null
}

const OK: Result = { ok: true }
const err = (error: string): Result => ({ ok: false, error })

/**
 * The Decompose DAG kernel: a pure deterministic state machine (DESIGN.md).
 * Arcs point part -> whole: arc A->B makes A a predecessor of B; root is the sole sink.
 * Every operation is atomic: validate everything first, then apply + propagate.
 * All Maps/Sets iterate in insertion order — no clock, no randomness.
 */
export class Graph {
  private readonly nodes = new Map<NodeId, NodeState>()
  private readonly succ = new Map<NodeId, Set<NodeId>>()
  private readonly pred = new Map<NodeId, Set<NodeId>>()
  private readonly solidMap = new Map<NodeId, boolean>()
  readonly root: NodeId

  constructor(root: NodeId, content: string) {
    if (root === '') throw new Error('root id must be non-empty')
    this.root = root
    this.createNode(root, content)
  }

  // ---------- queries ----------

  has(id: NodeId): boolean {
    return this.nodes.has(id)
  }

  ids(): NodeId[] {
    return [...this.nodes.keys()]
  }

  node(id: NodeId): DagNode {
    const st = this.mustGet(id)
    return {
      id,
      content: st.content,
      version: st.version,
      verdict: st.verdict,
      fingerprint: st.fingerprint
        ? { ownHash: st.fingerprint.ownHash, preds: { ...st.fingerprint.preds } }
        : null,
    }
  }

  verdict(id: NodeId): Verdict {
    return this.mustGet(id).verdict
  }

  solid(id: NodeId): boolean {
    this.mustGet(id)
    return this.solidMap.get(id)!
  }

  successors(id: NodeId): NodeId[] {
    this.mustGet(id)
    return [...this.succ.get(id)!]
  }

  predecessors(id: NodeId): NodeId[] {
    this.mustGet(id)
    return [...this.pred.get(id)!]
  }

  snapshot(): Snapshot {
    const nodes: DagNode[] = this.ids().map((id) => this.node(id))
    const arcs: Arc[] = []
    for (const [from, tos] of this.succ) for (const to of tos) arcs.push({ from, to })
    return { root: this.root, nodes, arcs }
  }

  // ---------- apply ----------

  apply(op: Op): Result {
    switch (op.type) {
      case 'add':
        return this.opAdd(op)
      case 'link':
        return this.opLink(op)
      case 'unlink':
        return this.opUnlink(op)
      case 'mutate':
        return this.opMutate(op)
      case 'verify':
        return this.opVerify(op)
      case 'doubt':
        return this.opDoubt(op)
    }
  }

  private opAdd(op: Extract<Op, { type: 'add' }>): Result {
    if (op.id === '') return err('node id must be non-empty')
    if (this.nodes.has(op.id)) return err(`node "${op.id}" already exists`)
    if (!this.nodes.has(op.successor)) return err(`successor "${op.successor}" does not exist`)
    // apply
    this.createNode(op.id, op.content)
    this.succ.get(op.id)!.add(op.successor)
    this.pred.get(op.successor)!.add(op.id)
    // propagate
    this.resetVerdictStructural(op.successor) // T1: gained a predecessor
    this.propagateSolid([op.id, op.successor])
    return OK
  }

  private opLink(op: Extract<Op, { type: 'link' }>): Result {
    if (!this.nodes.has(op.from)) return err(`node "${op.from}" does not exist`)
    if (!this.nodes.has(op.to)) return err(`node "${op.to}" does not exist`)
    if (op.from === op.to) return err('cannot link a node to itself')
    if (op.from === this.root) return err('root must have 0 successors')
    if (this.succ.get(op.from)!.has(op.to)) return err(`arc ${op.from}->${op.to} already exists`)
    if (this.canReach(op.to, op.from))
      return err(`arc ${op.from}->${op.to} would create a cycle`)
    // apply
    this.succ.get(op.from)!.add(op.to)
    this.pred.get(op.to)!.add(op.from)
    // propagate
    this.resetVerdictStructural(op.to)
    this.propagateSolid([op.to])
    return OK
  }

  private opUnlink(op: Extract<Op, { type: 'unlink' }>): Result {
    if (!this.nodes.has(op.from) || !this.succ.get(op.from)!.has(op.to))
      return err(`arc ${op.from}->${op.to} does not exist`)
    // apply
    this.succ.get(op.from)!.delete(op.to)
    this.pred.get(op.to)!.delete(op.from)
    // propagate: `to` always survives (its own out-arcs are untouched); by the DropPass
    // lemma the cascade causes no other verdict resets on survivors.
    this.dropPass()
    this.resetVerdictStructural(op.to)
    this.propagateSolid([op.to])
    return OK
  }

  private opMutate(op: Extract<Op, { type: 'mutate' }>): Result {
    const st = this.nodes.get(op.id)
    if (!st) return err(`node "${op.id}" does not exist`)
    // apply
    st.content = op.content
    st.contentHash = sha256Hex(op.content)
    st.version += 1
    st.verdict = 'pending' // T3: unconditionally — from valid or invalid
    // propagate (self restores immediately iff the new content is exactly the verified content)
    this.propagateSolid([op.id])
    return OK
  }

  private opVerify(op: Extract<Op, { type: 'verify' }>): Result {
    const st = this.nodes.get(op.id)
    if (!st) return err(`node "${op.id}" does not exist`)
    if (st.verdict === 'valid') return err(`node "${op.id}" is already valid`)
    for (const p of this.pred.get(op.id)!) {
      if (!this.solidMap.get(p)!) return err(`predecessor "${p}" is not solid`)
    }
    // apply
    st.verdict = op.result
    if (op.result === 'valid') {
      const preds: Record<NodeId, string> = {}
      for (const p of this.pred.get(op.id)!) preds[p] = this.nodes.get(p)!.contentHash
      st.fingerprint = { ownHash: st.contentHash, preds }
    }
    // propagate (valid may cascade Restore through ancestors whose fingerprints match)
    this.propagateSolid([op.id])
    return OK
  }

  private opDoubt(op: Extract<Op, { type: 'doubt' }>): Result {
    const st = this.nodes.get(op.id)
    if (!st) return err(`node "${op.id}" does not exist`)
    if (st.verdict !== 'valid') return err(`node "${op.id}" is not valid — nothing to doubt`)
    // apply
    st.verdict = 'pending'
    st.fingerprint = null // the judgment's ledger entry dies with the judgment
    // propagate (A cannot Restore — its fingerprint is gone; valid ancestors
    // reopen via T2 but keep theirs, so re-verifying A restores them)
    this.propagateSolid([op.id])
    return OK
  }

  // ---------- shared subroutines (ALGORITHMS.md) ----------

  private createNode(id: NodeId, content: string): void {
    this.nodes.set(id, {
      content,
      contentHash: sha256Hex(content),
      version: 0,
      verdict: 'pending',
      fingerprint: null,
    })
    this.succ.set(id, new Set())
    this.pred.set(id, new Set())
    this.solidMap.set(id, false)
  }

  /** DFS along succ arcs; true iff `to` is reachable from `from`. */
  private canReach(from: NodeId, to: NodeId): boolean {
    if (from === to) return true
    const seen = new Set<NodeId>([from])
    const stack: NodeId[] = [from]
    while (stack.length > 0) {
      const n = stack.pop()!
      for (const s of this.succ.get(n)!) {
        if (s === to) return true
        if (!seen.has(s)) {
          seen.add(s)
          stack.push(s)
        }
      }
    }
    return false
  }

  /** Single survival rule: a node survives iff it has a succ-path to root. */
  private dropPass(): NodeId[] {
    const reachable = new Set<NodeId>([this.root])
    const queue: NodeId[] = [this.root]
    while (queue.length > 0) {
      const n = queue.shift()!
      for (const p of this.pred.get(n)!) {
        if (!reachable.has(p)) {
          reachable.add(p)
          queue.push(p)
        }
      }
    }
    const dropped = this.ids().filter((id) => !reachable.has(id))
    for (const id of dropped) {
      // Lemma: every successor of a dropped node is itself dropped, so only
      // surviving *predecessors* (which lose an out-arc, irrelevant to state)
      // need their arc sets cleaned.
      for (const p of this.pred.get(id)!) this.succ.get(p)?.delete(id)
      for (const s of this.succ.get(id)!) this.pred.get(s)?.delete(id)
      this.nodes.delete(id)
      this.succ.delete(id)
      this.pred.delete(id)
      this.solidMap.delete(id)
    }
    return dropped
  }

  /** Structural trigger: only a valid verdict resets to pending. */
  private resetVerdictStructural(id: NodeId): void {
    const st = this.nodes.get(id)!
    if (st.verdict === 'valid') st.verdict = 'pending'
  }

  /**
   * True iff the node's entire justification is unchanged since its last valid
   * Verify — by content identity (hashes), so a re-added id with different
   * content never matches, and content mutated back to its verified text does.
   */
  private fingerprintMatches(id: NodeId): boolean {
    const st = this.nodes.get(id)!
    const fp = st.fingerprint
    if (!fp || fp.ownHash !== st.contentHash) return false
    const preds = this.pred.get(id)!
    if (Object.keys(fp.preds).length !== preds.size) return false
    for (const p of preds) {
      if (fp.preds[p] !== this.nodes.get(p)!.contentHash) return false
    }
    return true
  }

  private predsAllSolid(id: NodeId): boolean {
    for (const p of this.pred.get(id)!) {
      if (!this.solidMap.get(p)!) return false
    }
    return true
  }

  /**
   * Restore `solid ≡ (verdict == valid ∧ all preds solid)` everywhere, applying the
   * true→false verdict trigger and Restore (verification cascade) along the way.
   */
  private propagateSolid(seeds: NodeId[]): void {
    const queue = [...seeds]
    while (queue.length > 0) {
      const n = queue.shift()!
      const st = this.nodes.get(n)
      if (!st) continue // dropped
      const predsSolid = this.predsAllSolid(n)
      if (st.verdict === 'pending' && predsSolid && this.fingerprintMatches(n)) {
        st.verdict = 'valid' // Restore — justification unchanged, no re-verification needed
      }
      const newSolid = st.verdict === 'valid' && predsSolid
      if (newSolid === this.solidMap.get(n)) continue
      this.solidMap.set(n, newSolid)
      for (const s of this.succ.get(n)!) {
        if (!newSolid) {
          const ss = this.nodes.get(s)!
          if (ss.verdict === 'valid') ss.verdict = 'pending' // the true→false trigger
        }
        queue.push(s)
      }
    }
  }

  // ---------- snapshot load ----------

  /** Rebuild a graph from a snapshot. Throws on corrupt data; solid is recomputed. */
  static fromSnapshot(snap: Snapshot): Graph {
    const rootNode = snap.nodes.find((n) => n.id === snap.root)
    if (!rootNode) throw new Error('snapshot: root node missing')
    const g = new Graph(snap.root, rootNode.content)
    for (const n of snap.nodes) {
      if (n.id !== snap.root) {
        if (g.nodes.has(n.id)) throw new Error(`snapshot: duplicate node "${n.id}"`)
        g.createNode(n.id, n.content)
      }
      const st = g.nodes.get(n.id)!
      st.version = n.version
      st.verdict = n.verdict
      st.fingerprint = n.fingerprint
        ? { ownHash: n.fingerprint.ownHash, preds: { ...n.fingerprint.preds } }
        : null
    }
    for (const a of snap.arcs) {
      if (!g.nodes.has(a.from) || !g.nodes.has(a.to))
        throw new Error(`snapshot: arc ${a.from}->${a.to} references a missing node`)
      if (a.from === snap.root) throw new Error('snapshot: root must have 0 successors')
      if (g.succ.get(a.from)!.has(a.to))
        throw new Error(`snapshot: duplicate arc ${a.from}->${a.to}`)
      g.succ.get(a.from)!.add(a.to)
      g.pred.get(a.to)!.add(a.from)
    }
    // Recompute solid in topological order (preds before succs); doubles as validation.
    const indeg = new Map<NodeId, number>()
    const queue: NodeId[] = []
    for (const id of g.ids()) {
      const d = g.pred.get(id)!.size
      indeg.set(id, d)
      if (d === 0) queue.push(id)
    }
    let processed = 0
    while (queue.length > 0) {
      const n = queue.shift()!
      processed += 1
      g.solidMap.set(n, g.nodes.get(n)!.verdict === 'valid' && g.predsAllSolid(n))
      for (const s of g.succ.get(n)!) {
        const d = indeg.get(s)! - 1
        indeg.set(s, d)
        if (d === 0) queue.push(s)
      }
    }
    if (processed !== g.nodes.size) throw new Error('snapshot: graph contains a cycle')
    for (const id of g.ids()) {
      if (id !== snap.root && g.succ.get(id)!.size === 0)
        throw new Error(`snapshot: node "${id}" has no path to root`)
    }
    return g
  }

  private mustGet(id: NodeId): NodeState {
    const st = this.nodes.get(id)
    if (!st) throw new Error(`node "${id}" does not exist`)
    return st
  }
}
