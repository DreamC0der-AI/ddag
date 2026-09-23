import { Graph } from '../kernel/graph'
import type { NodeId, Op, Result, Snapshot } from '../kernel/types'

/**
 * One link of the event chain: the record of one applied operation.
 * Append-only, never reordered or rewritten. `prev` is the seq of the
 * predecessor event (seq - 1; 0 points at the initial snapshot).
 * `via`, when present, names the epistemic operation this atom was
 * dispatched as part of (e.g. "Revert(a)", "Merge(d->c)"). `evidence`,
 * when present, cites the grounds of a judgment (doctrine hook P2 — a
 * test run, a review note), of a withdrawal, or the rationale of a
 * structural decision (e.g. why a claim was decomposed). Both are
 * shell-attached environment data: inert to the kernel, preserved by
 * replay.
 */
export interface ChainEvent {
  seq: number
  prev: number
  op: ChainOp
  via?: string
  evidence?: string
  provenance?: Provenance
  /** the key of the round record this judgment cites: what moved and how it was checked, said once */
  round?: string
}

/**
 * An issue event: a finding recorded by the shell, or its closing. Issues
 * are not nodes (arcs mean part-of; a bug is not a part of correctness)
 * and not kernel operations — the graph snapshot is unchanged by them. They
 * are chain events so that they are ordered with the operations, written
 * under the same lock, fast-forwarded between sessions and replayed like
 * everything else. Environment data with a lifecycle.
 */
export type IssueOp =
  | {
      type: 'issue'
      action: 'open'
      /** the issue's key — the auditor's own (AUTHZ-1) or an assigned one (I7) */
      key: string
      title: string
      /** the claim the finding concerns, when there is one */
      node?: NodeId
      severity?: string
      /** the finding in full, as written — markdown is fine */
      detail?: string
    }
  | {
      type: 'issue'
      action: 'close'
      key: string
      outcome: 'fixed' | 'wontfix' | 'invalid' | 'duplicate'
      resolution?: string
    }

/**
 * A version mark: a declaration that the project, as of a commit, is a
 * working version with a name. Git knows every commit and no notion of
 * which one concluded a version; the chain knows every judgment and, with
 * this, when the project was a version. What the version *was* — root solid
 * or broken, issues open — is not stored: the chain at that seq tells it.
 */
export interface VersionOp {
  type: 'version'
  name: string
  /** the commit the version sits after, when inside a repository */
  commit?: string
  /** uncommitted changes were present at the mark — the commit alone does not identify the code */
  dirty?: boolean
  note?: string
}

/**
 * A round record: a change described once — what moved and how it was
 * checked (the diff in words, the suite result) — so that the judgments
 * re-anchored after it cite it by key and say one sentence about their own
 * claim, instead of each repeating the round (EVID-1). A record like an
 * issue or a version: inert to the kernel, no lifecycle.
 */
export interface RoundOp {
  type: 'round'
  key: string
  title: string
  detail?: string
}

/**
 * A carry: after a change described by a round, the valid judgments the
 * change does not concern keep their verdicts and have their pins moved to
 * the new hashes — on the agent's word, not on re-examination (nc-carry).
 * One event carries them all. A record, inert to the kernel, but it holds
 * provenance: a node's pin is read from its last valid judgment or a later
 * carry, whichever is later, and every view names a carried pin as such.
 */
export interface CarryOp {
  type: 'carry'
  /** the round that describes the change — what moved, how it was checked, and whose it is */
  round: string
  /** the files the change touched, relative to the project root */
  files: string[]
  /** each judgment carried: its node, and its pin set with the changed files re-hashed */
  pins: { id: NodeId; provenance: Provenance }[]
}

/** What a chain event can carry: a kernel operation, or a record (issue, version, round, carry). */
export type ChainOp = Op | IssueOp | VersionOp | RoundOp | CarryOp

export const isIssueOp = (op: ChainOp): op is IssueOp => op.type === 'issue'
export const isVersionOp = (op: ChainOp): op is VersionOp => op.type === 'version'
export const isRoundOp = (op: ChainOp): op is RoundOp => op.type === 'round'
export const isCarryOp = (op: ChainOp): op is CarryOp => op.type === 'carry'
/** Records are events the kernel never sees: the snapshot after one is the snapshot before it. */
export const isRecordOp = (op: ChainOp): op is IssueOp | VersionOp | RoundOp | CarryOp =>
  op.type === 'issue' || op.type === 'version' || op.type === 'round' || op.type === 'carry'

/**
 * Where a judgment was made: the code state its evidence was gathered
 * against. Environment data attached by the shell at Verify time — inert to
 * the kernel, preserved by replay — so a later audit can tell whether the
 * cited artifacts changed since the judgment (the mechanical prompt for
 * Doubt; fingerprints cover claims and parts, never code).
 */
export interface Provenance {
  /** git HEAD at judgment time, when inside a repository */
  head?: string
  /** uncommitted changes were present — HEAD alone does not identify the code */
  dirty?: boolean
  /** cited files or directories, content-hashed, relative to `root` */
  artifacts: { path: string; hash: string }[]
  /** the directory the artifact paths are relative to (the server's cwd at pin time) */
  root?: string
}

/** A rejected operation is not an event — kept separately for analysis/display. */
export interface Rejection {
  op: ChainOp
  error: string
}

/**
 * Chain-level environment data: the id of the project node when the chain
 * carries several targets (src/chain/targets.ts). Inert to the kernel.
 */
export interface ChainMeta {
  project: NodeId
}

/**
 * What a segment remembers of a node from before its checkpoint: why it was
 * added and how it was last judged, with the content it was judged on (so a
 * revert can restore it) and its pin. Read by the views and the audit when
 * the live events say nothing about the node.
 */
export interface NodeMemo {
  because?: string
  judged?: {
    seq: number
    result: 'valid' | 'invalid'
    content: string
    evidence?: string
    round?: string
    provenance?: Provenance
    /** the pin was moved by a carry after the judgment */
    carried?: { seq: number; round: string }
  }
}

/**
 * A checkpoint: what the segment that starts here needs from the sealed
 * segments before it (chain-segments). The graph itself is the segment's
 * initial snapshot; this carries the layer-two state the readers derive from
 * events — memos per node, every issue, every version, every round key — and
 * the position the segment starts after, so event numbers keep counting.
 */
export interface Checkpoint {
  /** events before this segment: the first event here is seq + 1 */
  seq: number
  /** this segment's index, 0 for a chain that was never rolled */
  segment: number
  /** the sealed segment that holds the events before, relative to the chain folder */
  parent?: string
  /** the version this segment starts after */
  after?: string
  nodes: Record<NodeId, NodeMemo>
  issues: import('./issues').Issue[]
  versions: import('./versions').Version[]
  rounds: { key: string; title: string; seq: number }[]
  /** on a multi-target chain, the home target of every node at the roll — the add events that said so are sealed */
  homes?: Record<NodeId, NodeId>
}

/** Serialized form: the initial snapshot plus the chain fully determine the graph; a checkpoint says what came before. */
export interface ChainDump {
  initial: Snapshot
  events: ChainEvent[]
  meta?: ChainMeta
  checkpoint?: Checkpoint
}

/**
 * The event chain (DESIGN.md "Event"): a journal layer around the kernel.
 * All mutation goes through dispatch(); the kernel's determinism makes
 * the chain replayable. Snapshots are recorded per event (keyframes-every-N
 * is the later escalation if graphs grow).
 */
export class EventChain {
  private readonly g: Graph
  private readonly initial: Snapshot
  private readonly events: ChainEvent[] = []
  private readonly snapshots: Snapshot[] = [] // snapshots[i] = state after events[i]
  private readonly rejections: Rejection[] = []
  private readonly meta: ChainMeta | undefined
  /** what came before this segment; undefined on a chain that was never rolled */
  readonly checkpoint: Checkpoint | undefined
  /** the position this segment starts after: 0, or the checkpoint's seq */
  readonly base: number

  private constructor(g: Graph, meta?: ChainMeta, checkpoint?: Checkpoint) {
    this.g = g
    this.initial = g.snapshot()
    this.meta = meta
    this.checkpoint = checkpoint
    this.base = checkpoint?.seq ?? 0
  }

  static create(root: NodeId, rootContent: string): EventChain {
    return new EventChain(new Graph(root, rootContent))
  }

  /** The chain's position: the seq of its last event, counted from the first segment. */
  get position(): number {
    return this.base + this.events.length
  }

  /** The event at an absolute seq, when it is in this segment. */
  eventAt(seq: number): ChainEvent | undefined {
    return this.events[seq - this.base - 1]
  }

  /** A round recorded in this segment or carried by its checkpoint. */
  hasRound(key: string): boolean {
    return this.events.some((e) => isRoundOp(e.op) && e.op.key === key) || (this.checkpoint?.rounds.some((r) => r.key === key) ?? false)
  }

  /** The project node's id when this chain carries several targets; undefined on a single-target chain. */
  get project(): NodeId | undefined {
    return this.meta?.project
  }

  /** Query-only access to the live graph. Mutate via dispatch(), never graph.apply(). */
  get graph(): Graph {
    return this.g
  }

  get length(): number {
    return this.events.length
  }

  dispatch(op: ChainOp, via?: string, evidence?: string, provenance?: Provenance, round?: string): Result {
    if (isIssueOp(op)) return this.recordIssue(op, evidence)
    if (isVersionOp(op)) return this.recordVersion(op, evidence)
    if (isRoundOp(op)) return this.recordRound(op)
    if (isCarryOp(op)) return this.recordCarry(op)
    if (round !== undefined && !this.hasRound(round)) {
      const error = `round "${round}" is not recorded — round_record it first`
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    const result = this.g.apply(op)
    if (result.ok) {
      const seq = this.position + 1
      const ev: ChainEvent = { seq, prev: seq - 1, op }
      if (via !== undefined) ev.via = via
      if (evidence !== undefined) ev.evidence = evidence
      if (provenance !== undefined) ev.provenance = provenance
      if (round !== undefined) ev.round = round
      this.events.push(ev)
      this.snapshots.push(this.g.snapshot())
    } else {
      this.rejections.push({ op, error: result.error })
    }
    return result
  }

  /**
   * Append an issue event. The kernel is not consulted; the snapshot after
   * the event is the snapshot before it. Refuses a key that is already open
   * (open) or not open (close), so the record stays a readable lifecycle.
   */
  private recordVersion(op: VersionOp, evidence?: string): Result {
    const earlier = this.checkpoint?.versions.find((v) => v.name === op.name)
    const here = this.events.find((e) => isVersionOp(e.op) && e.op.name === op.name)
    const at = here?.seq ?? earlier?.seq
    if (at !== undefined) {
      const error = `version "${op.name}" is already marked (at event ${at})`
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    this.appendRecord(op, evidence)
    return { ok: true }
  }

  private recordRound(op: RoundOp): Result {
    if (this.hasRound(op.key)) {
      const error = `round "${op.key}" is already recorded`
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    this.appendRecord(op)
    return { ok: true }
  }

  /**
   * A carry moves pins, never verdicts: it names a recorded round, and every
   * node it carries must be valid right now — a carried pin on a pending or
   * invalid claim would be a pin on nothing.
   */
  private recordCarry(op: CarryOp): Result {
    const reject = (error: string): Result => {
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    if (!this.hasRound(op.round)) return reject(`round "${op.round}" is not recorded — round_record it first`)
    if (op.pins.length === 0) return reject('a carry with no judgments carries nothing')
    for (const p of op.pins) {
      if (!this.g.has(p.id)) return reject(`node "${p.id}" does not exist`)
      if (this.g.verdict(p.id) !== 'valid') return reject(`node "${p.id}" is ${this.g.verdict(p.id)} — only a valid judgment can be carried`)
    }
    this.appendRecord(op)
    return { ok: true }
  }

  private appendRecord(op: IssueOp | VersionOp | RoundOp | CarryOp, evidence?: string): void {
    const seq = this.position + 1
    const ev: ChainEvent = { seq, prev: seq - 1, op }
    if (evidence !== undefined) ev.evidence = evidence
    this.events.push(ev)
    this.snapshots.push(this.current())
  }

  private recordIssue(op: IssueOp, evidence?: string): Result {
    const open = new Set<string>()
    for (const i of this.checkpoint?.issues ?? []) if (i.status === 'open') open.add(i.key)
    for (const e of this.events) {
      if (!isIssueOp(e.op)) continue
      if (e.op.action === 'open') open.add(e.op.key)
      else open.delete(e.op.key)
    }
    if (op.action === 'open' && open.has(op.key)) {
      const error = `issue "${op.key}" is already open`
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    if (op.action === 'close' && !open.has(op.key)) {
      const error = `issue "${op.key}" is not open`
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    if (op.action === 'open' && op.node !== undefined && !this.g.has(op.node)) {
      const error = `issue "${op.key}": node "${op.node}" does not exist`
      this.rejections.push({ op, error })
      return { ok: false, error }
    }
    this.appendRecord(op, evidence)
    return { ok: true }
  }

  chain(): readonly ChainEvent[] {
    return this.events
  }

  rejectionLog(): readonly Rejection[] {
    return this.rejections
  }

  /** State after event `seq`; the segment's base seq (0 on an unrolled chain) is the initial snapshot. */
  snapshotAt(seq: number): Snapshot {
    if (seq === this.base) return this.initial
    if (seq < this.base) throw new Error(`no snapshot at seq ${seq}: this segment starts after #${this.base}`)
    const snap = this.snapshots[seq - this.base - 1]
    if (!snap) throw new Error(`no snapshot at seq ${seq}`)
    return snap
  }

  current(): Snapshot {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1]! : this.initial
  }

  /** Serialize: initial snapshot + chain (per-event snapshots are rebuilt on load) + the checkpoint it starts from. */
  dump(): ChainDump {
    const d: ChainDump = { initial: this.initial, events: [...this.events] }
    if (this.meta !== undefined) d.meta = { ...this.meta }
    if (this.checkpoint !== undefined) d.checkpoint = this.checkpoint
    return d
  }

  /**
   * Rebuild a chain by replaying events from the initial snapshot through the
   * kernel. Throws if the chain is not contiguous from its base (seq 1, or the
   * checkpoint's seq + 1) or if any event fails to apply — either means the
   * dump is corrupt. The initial snapshot may itself be mid-history (a
   * keyframe, or a segment's checkpoint): it is loaded verbatim, not recomputed.
   */
  static replay(dump: ChainDump): EventChain {
    const chain = new EventChain(Graph.fromSnapshot(dump.initial), dump.meta === undefined ? undefined : { ...dump.meta }, dump.checkpoint)
    const base = chain.base
    for (const [i, ev] of dump.events.entries()) {
      if (ev.seq !== base + i + 1 || ev.prev !== base + i)
        throw new Error(`replay: chain broken at index ${i} (seq ${ev.seq}, prev ${ev.prev}, segment base ${base})`)
      const r = chain.dispatch(ev.op, ev.via, ev.evidence, ev.provenance, ev.round)
      if (!r.ok) throw new Error(`replay: event seq ${ev.seq} rejected: ${r.error}`)
    }
    return chain
  }
}
