import { useSyncExternalStore } from 'react'
import { enabledActions, frontier } from '../kernel/actions'
import { rankFrontier } from '../kernel/ordering'
import type { Graph } from '../kernel/graph'
import type { NodeId, Op, Snapshot } from '../kernel/types'
import { EventChain, isRoundOp, type ChainEvent, type ChainOp, type Provenance, type RoundOp } from '../chain/chain'
import { firstSentence, nodeChain, type NodeEntry } from '../chain/reader'
import { coneOf, homesOf, mainTarget, projectOf, targetsOf } from '../chain/targets'
import { discard, merge, revert, substitute } from '../chain/epistemic'
import { explainEvent, fingerprintIntact, issueText } from '../chain/explain'
import { opShort } from '../chain/notation'
import { issuesByNode, readIssues, type Issue } from '../chain/issues'
import { latestVersion, readVersions, type Version } from '../chain/versions'

/** One valid node's provenance audit, as the dashboard server reports it. */
export interface NodeAuditView {
  status: 'unpinned' | 'unwatched' | 'parts' | 'intact' | 'stale'
  pin?: string
  artifacts: number
  parts?: number
  changed: string[]
  missing: string[]
  diffs?: { path: string; added: number; removed: number; where: string[]; approximate: boolean }[]
}

/** "src/auth.rs: +12/-3 in sanitize_label" — what changed under a judgment since its pin. */
export function describeDiff(d: NonNullable<NodeAuditView['diffs']>[number]): string {
  const where = d.where.length > 0 ? ` in ${d.where.slice(0, 4).join('; ')}${d.where.length > 4 ? `; +${d.where.length - 4} more` : ''}` : ''
  return `${d.path}: +${d.added}/-${d.removed}${where}${d.approximate ? ' (approximate)' : ''}`
}

export interface FeedEntry {
  key: number
  seq: number
  short: string
  op: ChainOp
  via?: string
  evidence?: string
  /** Kernel consequences with their causes named (T1/T2/T3, Restore, drops, frontier). */
  explain: string[]
  /** Why the sandbox drew THIS operation — present on the first event of a step. */
  decision?: string[]
}

/** One entry of the epistemic menu: an operation of the front, ready to perform. */
export type EpistemicChoice =
  | { kind: 'Add'; successor: NodeId }
  | { kind: 'Link'; from: NodeId; to: NodeId }
  | { kind: 'Unlink'; from: NodeId; to: NodeId }
  | { kind: 'Mutate'; id: NodeId }
  | { kind: 'Verify'; id: NodeId; result: 'valid' | 'invalid' }
  | { kind: 'Doubt'; id: NodeId }
  | { kind: 'Revert'; id: NodeId }
  | { kind: 'Discard'; id: NodeId }
  | { kind: 'Substitute'; y: NodeId; x: NodeId; z: NodeId }
  | { kind: 'Merge'; d: NodeId; c: NodeId }

export const OPERATION_KINDS = [
  'Add',
  'Link',
  'Unlink',
  'Mutate',
  'Verify',
  'Doubt',
  'Revert',
  'Discard',
  'Substitute',
  'Merge',
] as const

export type OperationKind = (typeof OPERATION_KINDS)[number]

/** The epistemic operation a log entry belongs to: its composite marker when present, else its atom. */
/** A log entry's kind: an epistemic operation, or an issue record (not an operation — the graph is unchanged). */
export type EntryKind = OperationKind | 'Reverify' | 'Refute' | 'Issue' | 'Close' | 'Version' | 'Round'

export function kindOfEntry(e: { op: ChainOp; via?: string }): EntryKind {
  if (e.via?.startsWith('Reverify(')) return 'Reverify'
  if (e.via?.startsWith('Refute(')) return 'Refute'
  if (e.op.type === 'version') return 'Version'
  if (e.op.type === 'round') return 'Round'
  if (e.op.type === 'issue') return e.op.action === 'open' ? 'Issue' : 'Close'
  if (e.via) {
    const name = e.via.slice(0, e.via.indexOf('(') > 0 ? e.via.indexOf('(') : undefined)
    if ((OPERATION_KINDS as readonly string[]).includes(name)) return name as OperationKind
  }
  const atom: Record<Op['type'], OperationKind> = {
    add: 'Add',
    link: 'Link',
    unlink: 'Unlink',
    mutate: 'Mutate',
    verify: 'Verify',
    doubt: 'Doubt',
  }
  return atom[e.op.type]
}

/** "@abc1234*, 3 artifacts" — the asterisk marks a dirty tree (the label src/mcp/provenance.ts prints). */
const pinLabel = (p: Provenance): string => {
  const head = p.head ? `@${p.head.slice(0, 7)}${p.dirty ? '*' : ''}` : 'no-git'
  return `${head}, ${p.artifacts.length} artifact${p.artifacts.length === 1 ? '' : 's'}`
}

/** What an event said, cut for a row: the first sentence, the whole text when it is longer, the round it cites. */
export interface Said {
  seq: number
  grounds: string | null
  /** the whole text, only when the first sentence is not all of it */
  full: string | null
  round: string | null
}

/**
 * One row of a claim's timeline — the collapsed view src/chain/reader.ts
 * renders as text (renderNodeChain), kept as data so causes can be chips:
 * a run of re-anchorings is one row, the reopen/restore noise of
 * re-anchorings beneath the claim is one last row.
 */
export type TimelineRow =
  | {
      type: 'entry'
      seq: number
      direct: boolean
      /** what happened, in plain words */
      what: string
      /** the other claim of the row: the part, the group, or the claim whose operation caused this */
      node: NodeId | null
      /** said after the node: what the event did to this claim's own verdict */
      tail: string | null
      via: string | null
      said: Said | null
    }
  | { type: 'run'; first: number; last: number; count: number; items: Said[] }
  | { type: 'noise'; count: number; last: number }

// the two collapsing rules of renderNodeChain (src/chain/reader.ts), kept word for word
const isReanchorOf = (e: NodeEntry, id: NodeId): boolean =>
  e.direct && (e.kind === 'doubted' || e.kind === 'judged') && e.via === `Reverify(${id})`
const isReanchorNoise = (e: NodeEntry): boolean => !e.direct && (e.cause?.via ?? '').startsWith('Reverify(')

/** Sampling weights per operation kind (renormalized over non-empty kinds). */
const WEIGHTS: Record<OperationKind, number> = {
  Add: 0.22,
  Link: 0.09,
  Unlink: 0.07,
  Mutate: 0.1,
  Verify: 0.32,
  Doubt: 0.04,
  Revert: 0.06,
  Discard: 0.05,
  Substitute: 0.05,
  Merge: 0.04,
}

/**
 * Simulation store: an EventChain plus a random stepper over the EPISTEMIC
 * operation front (DESIGN.md "Epistemic Operations") — the five atoms as
 * themselves plus Revert, Discard, Substitute, Merge. Randomness lives HERE,
 * in the shell — the kernel and chain stay deterministic, so the produced
 * history still replays exactly.
 */
class SimStore {
  private chain = EventChain.create('target', 'The build target')
  private feed: FeedEntry[] = []
  private key = 0
  private seenEvents = 0
  private version = 0
  private live = false
  private liveTimer: ReturnType<typeof setInterval> | null = null
  private lastRaw = ''
  private audit: Record<NodeId, NodeAuditView> = {}
  private auditTimer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = (): number => this.version

  get graph(): Graph {
    return this.chain.graph
  }

  get eventCount(): number {
    return this.chain.length
  }

  getFeed(): readonly FeedEntry[] {
    return this.feed
  }

  // ---------- targets: the view shows one target's cone at a time ----------

  /** The chosen target's id, or null for the main target; UI state, not chain state. */
  private target: NodeId | null = null
  private targetCache: { chain: EventChain; at: number; target: NodeId; cone: Set<NodeId>; homes: Map<NodeId, NodeId> } | null = null

  /** The project node when the chain carries several targets; never shown. */
  projectNode(): NodeId | null {
    return projectOf(this.chain)
  }

  /** Every target in creation order, the main one first; one entry on a legacy chain. */
  targets(): NodeId[] {
    return targetsOf(this.chain)
  }

  /** The target the view is on: the chosen one while it exists, else the main target. */
  currentTarget(): NodeId {
    const ts = this.targets()
    return this.target !== null && ts.includes(this.target) ? this.target : mainTarget(this.chain)
  }

  /** Pick the target to view; remembered per project in this browser. */
  selectTarget(id: NodeId | null): void {
    this.target = id
    const project = this.liveSource()?.project
    if (project !== undefined) {
      try {
        if (id === null) localStorage.removeItem(`${TARGET_KEY}.${project}`)
        else localStorage.setItem(`${TARGET_KEY}.${project}`, id)
      } catch {
        // per-browser convenience only
      }
    }
    this.emit()
  }

  /** How a target is named in the toolbar: the main one by its id, a sub-target as project/id. */
  targetLabel(id: NodeId): string {
    return id === mainTarget(this.chain) ? id : `${this.liveChainPath()}/${id}`
  }

  private targetView(): { cone: Set<NodeId>; homes: Map<NodeId, NodeId> } {
    const at = this.chain.length
    const target = this.currentTarget()
    const c = this.targetCache
    if (c && c.chain === this.chain && c.at === at && c.target === target) return c
    const view = { chain: this.chain, at, target, cone: coneOf(this.graph, target), homes: homesOf(this.chain) }
    this.targetCache = view
    return view
  }

  /** The current target's cone: every node with a path to it. The whole graph on a legacy chain. */
  cone(): Set<NodeId> {
    return this.targetView().cone
  }

  /** A node's home target — where it is judged; it may be used (linked) elsewhere. */
  homeOf(id: NodeId): NodeId {
    return this.targetView().homes.get(id) ?? this.currentTarget()
  }

  /**
   * What the canvas draws: the current target's cone with the target as root
   * and only the arcs inside the cone. On a legacy chain this is the graph.
   */
  viewSnapshot(): Snapshot {
    const snap = this.graph.snapshot()
    if (this.projectNode() === null) return snap
    const cone = this.cone()
    return {
      root: this.currentTarget(),
      nodes: snap.nodes.filter((n) => cone.has(n.id)),
      arcs: snap.arcs.filter((a) => cone.has(a.from) && cone.has(a.to)),
    }
  }

  /** Verifiable now, in this target: on the kernel frontier, in the cone, and judged here (not homed elsewhere). */
  onFrontier(): Set<NodeId> {
    const front = frontier(this.graph)
    if (this.projectNode() === null) return new Set(front)
    const target = this.currentTarget()
    const { cone, homes } = this.targetView()
    return new Set(front.filter((id) => cone.has(id) && homes.get(id) === target))
  }

  /** Frontier ranked by the one-step lookahead — the agent's best next move toward this target. */
  frontierRanks(): Map<NodeId, { n: number; win: boolean; restores: number; unlocks: number }> {
    const m = new Map<NodeId, { n: number; win: boolean; restores: number; unlocks: number }>()
    const scoped = this.projectNode() !== null ? { target: this.currentTarget(), only: this.onFrontier() } : {}
    rankFrontier(this.graph, { noTrivialWin: true, ...scoped }).forEach((r, i) =>
      m.set(r.id, { n: i + 1, win: r.rootSolid, restores: r.restored.length, unlocks: r.unlocked.length }),
    )
    return m
  }

  private issueCache: { chain: EventChain; at: number; issues: Issue[]; byNode: Map<NodeId, Issue[]> } | null = null

  /** Recorded findings with their lifecycle — re-read when the chain moves. */
  issues(): Issue[] {
    return this.issueView().issues
  }

  /** Invalid claims whose recorded issues are all closed — the fix is in, the judgment is not. */
  readyToReverify(): Set<NodeId> {
    const g = this.graph
    const out = new Set<NodeId>()
    for (const [id, list] of this.issueView().byNode) {
      if (g.has(id) && g.verdict(id) === 'invalid' && list.every((i) => i.status !== 'open')) out.add(id)
    }
    return out
  }

  versions(): Version[] {
    return readVersions(this.chain)
  }

  latestVersion(): Version | undefined {
    return latestVersion(this.chain)
  }

  issuesOf(id: NodeId): Issue[] {
    return this.issueView().byNode.get(id) ?? []
  }

  private issueView(): { issues: Issue[]; byNode: Map<NodeId, Issue[]> } {
    const at = this.chain.length
    if (this.issueCache && this.issueCache.chain === this.chain && this.issueCache.at === at) return this.issueCache
    const issues = readIssues(this.chain)
    this.issueCache = { chain: this.chain, at, issues, byNode: issuesByNode(issues) }
    return this.issueCache
  }

  /** The provenance audit of a valid node, when a live project reports one. */
  auditOf(id: NodeId): NodeAuditView | null {
    return this.audit[id] ?? null
  }

  /** Valid nodes whose pinned artifacts changed or vanished since judgment. */
  staleCount(): number {
    return Object.values(this.audit).filter((a) => a.status === 'stale').length
  }

  /** Justification currently intact — this pending node would heal via Restore. */
  fingerprintIntact(id: NodeId): boolean {
    return fingerprintIntact(this.graph, id)
  }

  /** Why the node exists (its Add rationale) and how it was last judged — read off the chain. */
  nodeHistory(id: NodeId): { because?: string; judged?: { seq: number; result: string; evidence?: string; round?: string; pin?: string } } {
    const events = this.chain.chain()
    const out: ReturnType<SimStore['nodeHistory']> = {}
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (!out.judged && e.op.type === 'verify' && e.op.id === id) {
        out.judged = { seq: e.seq, result: e.op.result }
        if (e.evidence) out.judged.evidence = e.evidence
        if (e.round !== undefined) out.judged.round = e.round
        if (e.provenance) out.judged.pin = pinLabel(e.provenance)
      }
      if (!out.because && e.op.type === 'add' && e.op.id === id && e.evidence) out.because = e.evidence
      if (out.judged && out.because) break
    }
    return out
  }

  /** A round record by its key: the change a judgment cites instead of repeating it. */
  roundOf(key: string): (RoundOp & { seq: number }) | null {
    for (const e of this.chain.chain()) if (isRoundOp(e.op) && e.op.key === key) return { ...e.op, seq: e.seq }
    return null
  }

  /** A claim's own chain as rows, oldest first, collapsed by the rules of renderNodeChain. */
  timelineOf(id: NodeId): TimelineRow[] {
    const events = this.chain.chain()
    const said = (seq: number): Said => {
      const ev = events[seq - 1]!
      const text = (ev.evidence ?? '').replace(/\s+/g, ' ').trim()
      const first = text === '' ? null : firstSentence(text)
      return { seq, grounds: first, full: first !== null && first !== text ? text : null, round: ev.round ?? null }
    }
    const rows: TimelineRow[] = []
    let run: Said[] = []
    let noise = 0
    let noiseLast = 0
    const flush = () => {
      if (run.length === 0) return
      rows.push({ type: 'run', first: run[0]!.seq, last: run[run.length - 1]!.seq, count: run.length, items: run })
      run = []
    }
    for (const e of nodeChain(this.chain, id)) {
      if (isReanchorNoise(e)) {
        noise++
        noiseLast = e.seq
        continue
      }
      if (isReanchorOf(e, id)) {
        if (e.kind === 'judged') run.push(said(e.seq)) // the pair is one act; the verify carries it
        continue
      }
      flush()
      const row = (what: string, o: { node?: NodeId; said?: boolean; effect?: boolean } = {}): void => {
        rows.push({
          type: 'entry',
          seq: e.seq,
          direct: e.direct,
          what,
          node: o.node ?? null,
          tail: o.effect && e.effect ? (e.effect === 'reopened' ? 'this claim reopened' : 'this claim was restored') : null,
          via: e.direct ? (e.via ?? null) : (e.cause?.via ?? null),
          said: o.said ? said(e.seq) : null,
        })
      }
      const ref = e.ref ?? ''
      const cause = e.cause
      switch (e.kind) {
        case 'added':
          row('added under', { node: ref, said: true })
          break
        case 'gained-part':
          row('gained the part', { node: ref, effect: true })
          break
        case 'lost-part':
          row('lost the part', { node: ref, effect: true })
          break
        case 'linked-into':
          row('linked into', { node: ref })
          break
        case 'unlinked-from':
          row('unlinked from', { node: ref })
          break
        case 'restated':
          row('restated', { said: true, effect: true })
          break
        case 'judged':
          row(`judged ${e.result}`, { said: true })
          break
        case 'doubted':
          row('judgment withdrawn', { said: true })
          break
        case 'issue-opened':
          row(`issue ${ref} opened`)
          break
        case 'issue-closed':
          row(`issue ${ref} closed`)
          break
        case 'reopened':
          row(`reopened by ${cause!.op}`, { node: cause!.node })
          break
        case 'restored':
          row(`restored by ${cause!.op}`, { node: cause!.node })
          break
        case 'solid':
          row(`became solid through ${cause!.op}`, { node: cause!.node })
          break
        case 'dropped':
          row(`dropped by ${cause!.op}`, { node: cause!.node })
          break
      }
    }
    flush()
    if (noise > 0) rows.push({ type: 'noise', count: noise, last: noiseLast })
    return rows
  }

  /** Feed entry for one chain event, with its consequences explained from the snapshots. */
  private entryFor(ev: ChainEvent): FeedEntry {
    const entry: FeedEntry = {
      key: this.key++,
      seq: ev.seq,
      short: opShort(ev.op),
      op: ev.op,
      explain: explainEvent(this.chain.snapshotAt(ev.seq - 1), this.chain.snapshotAt(ev.seq), ev.op),
    }
    if (ev.via !== undefined) entry.via = ev.via
    const grounds = ev.evidence ?? issueText(ev.op)
    if (grounds !== undefined) entry.evidence = grounds
    return entry
  }

  /** The simulation's goal: the build target is verified. */
  done(): boolean {
    return this.graph.solid(this.graph.root)
  }

  /**
   * Enumerate the epistemic menu: every operation of the front that would
   * apply in full right now (composites are included only when their whole
   * expansion is legal, so every click lands).
   */
  epistemicMenu(): EpistemicChoice[] {
    const g = this.graph
    const ids = g.ids()
    const menu: EpistemicChoice[] = []
    const atoms = enabledActions(g)

    // legal Link targets per node: linkables.get(y) = set of z with Link(z->y) enabled
    const linkables = new Map<NodeId, Set<NodeId>>()
    for (const a of atoms) {
      if (a.type === 'link') {
        if (!linkables.has(a.to)) linkables.set(a.to, new Set())
        linkables.get(a.to)!.add(a.from)
      }
    }

    for (const a of atoms) {
      switch (a.type) {
        case 'add':
          menu.push({ kind: 'Add', successor: a.successor })
          break
        case 'link':
          menu.push({ kind: 'Link', from: a.from, to: a.to })
          break
        case 'unlink':
          menu.push({ kind: 'Unlink', from: a.from, to: a.to })
          break
        case 'mutate':
          if (a.contentClass === 'fresh') menu.push({ kind: 'Mutate', id: a.id })
          else menu.push({ kind: 'Revert', id: a.id })
          break
        case 'verify':
          menu.push({ kind: 'Verify', id: a.id, result: a.result })
          break
        case 'doubt':
          menu.push({ kind: 'Doubt', id: a.id })
          break
      }
    }

    for (const id of ids) {
      if (id !== g.root) menu.push({ kind: 'Discard', id })
    }

    // Substitute(y: x->z): arc x->y exists and Link(z->y) is legal
    for (const y of ids) {
      for (const x of g.predecessors(y)) {
        for (const z of linkables.get(y) ?? []) {
          menu.push({ kind: 'Substitute', y, x, z })
        }
      }
    }

    // Merge(d->c): every role of d must be transferable in full
    for (const d of ids) {
      if (d === g.root) continue
      const roles = g.successors(d)
      for (const c of ids) {
        if (c === d) continue
        const ok = roles.every(
          (s) => s === c || g.successors(c).includes(s) || (linkables.get(s)?.has(c) ?? false),
        )
        if (ok) menu.push({ kind: 'Merge', d, c })
      }
    }

    return menu
  }

  /** Live counts per operation kind — the front, listed. */
  menuCounts(): { total: number; byKind: Map<OperationKind, number> } {
    const byKind = new Map<OperationKind, number>(OPERATION_KINDS.map((k) => [k, 0]))
    const menu = this.epistemicMenu()
    for (const m of menu) byKind.set(m.kind, byKind.get(m.kind)! + 1)
    return { total: menu.length, byKind }
  }

  reset(): void {
    if (this.live) return
    this.chain = EventChain.create('target', 'The build target')
    this.feed = []
    this.seenEvents = 0
    this.emit()
  }

  isLive(): boolean {
    return this.live
  }

  /**
   * Where live view reads from, decided by the URL: /p/<name> streams a
   * registered project through the dashboard API; ?chain=<path> streams a
   * file the dev server can reach (in-repo chains). Neither: no live source
   * — the sandbox.
   */
  liveSource(): { url: string; label: string; project?: string } | null {
    const { pathname, search } = window.location
    const m = /^\/p\/([^/]+)\/?$/.exec(pathname)
    if (m) {
      const project = decodeURIComponent(m[1]!)
      return { url: `/api/chain/${encodeURIComponent(project)}`, label: project, project }
    }
    const chain = new URLSearchParams(search).get('chain')
    if (chain) return { url: `/${chain}`, label: chain }
    return null
  }

  /** Label of the live source, for the toolbar. */
  liveChainPath(): string {
    return this.liveSource()?.label ?? 'ddag.json'
  }

  /**
   * Live view: mirror an MCP chain file (served by the dev server from the
   * project tree) instead of the sandbox. The page becomes a dashboard of
   * whatever agent session is writing that file — replay keeps it exact.
   */
  toggleLive(): void {
    if (this.live) {
      if (this.liveTimer !== null) clearInterval(this.liveTimer)
      if (this.auditTimer !== null) clearInterval(this.auditTimer)
      this.liveTimer = null
      this.auditTimer = null
      this.audit = {}
      this.target = null
      this.live = false
      this.emit()
      return
    }
    const src = this.liveSource()
    if (!src) return // nothing to mirror
    this.live = true
    this.lastRaw = ''
    // which target to open on: the link's ?target=, else the one last viewed
    // here; either is checked against the chain's targets when it arrives
    this.target = new URLSearchParams(window.location.search).get('target')
    if (this.target === null && src.project !== undefined) {
      try {
        this.target = localStorage.getItem(`${TARGET_KEY}.${src.project}`)
      } catch {
        this.target = null
      }
    }
    const tick = async () => {
      try {
        const res = await fetch(`${src.url}?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const raw = await res.text()
        if (raw === this.lastRaw) return
        const chain = EventChain.replay(JSON.parse(raw)) // throws on partial writes — skip tick
        this.lastRaw = raw
        this.chain = chain
        this.feed = chain.chain().map((ev) => this.entryFor(ev))
        this.seenEvents = chain.length
        this.emit()
      } catch {
        // unreadable or mid-write — try again next tick
      }
    }
    void tick()
    this.liveTimer = setInterval(() => void tick(), 1500)
    // the audit is a property of the code on disk, not of the chain: the
    // server re-hashes on a 10 s cache, so a 5 s poll sees a change in
    // at most one cache period without hammering directory hashes
    if (src.project) {
      const project = src.project
      const auditTick = async () => {
        try {
          const res = await fetch(`/api/audit/${encodeURIComponent(project)}?t=${Date.now()}`, { cache: 'no-store' })
          if (!res.ok) return
          const body = (await res.json()) as { nodes: Record<NodeId, NodeAuditView> }
          const next = JSON.stringify(body.nodes)
          if (next === JSON.stringify(this.audit)) return
          this.audit = body.nodes
          this.emit()
        } catch {
          // the dashboard server is away — the graph still streams, the audit waits
        }
      }
      void auditTick()
      this.auditTimer = setInterval(() => void auditTick(), 5000)
    }
    this.emit()
  }

  /** One click = one random epistemic operation from the menu. */
  randomStep(): void {
    if (this.live) return // live view is read-only
    if (this.done()) return // target solid — the simulation stops
    const g = this.graph
    // draw policy (menu display stays kernel-true): don't verify an
    // undecomposed root — the simulation is about decomposition, and a
    // bare-root verify would end the game on click one
    const rootBare = g.predecessors(g.root).length === 0
    const fullMenu = this.epistemicMenu()
    const menu = fullMenu.filter((m) => !(rootBare && m.kind === 'Verify' && m.id === g.root))
    if (menu.length === 0) return
    const decision: string[] = [`menu: ${menu.length} legal operations on the epistemic front`]
    if (menu.length < fullMenu.length)
      decision.push(
        `excluded Verify(${g.root}): the root is undecomposed — a bare-root verify would end the game on click one (draw policy, not the kernel)`,
      )
    const { choice, notes } = this.pickChoice(menu)
    decision.push(...notes)

    switch (choice.kind) {
      case 'Add': {
        const id = this.mintId()
        this.chain.dispatch({ type: 'add', id, content: `claim ${id}`, successor: choice.successor })
        break
      }
      case 'Link':
        this.chain.dispatch({ type: 'link', from: choice.from, to: choice.to })
        break
      case 'Unlink':
        this.chain.dispatch({ type: 'unlink', from: choice.from, to: choice.to })
        break
      case 'Mutate': {
        const v = this.graph.node(choice.id).version + 1
        this.chain.dispatch({ type: 'mutate', id: choice.id, content: `claim ${choice.id} · v${v}` })
        break
      }
      case 'Verify':
        this.chain.dispatch({ type: 'verify', id: choice.id, result: choice.result })
        break
      case 'Doubt':
        this.chain.dispatch({ type: 'doubt', id: choice.id })
        break
      case 'Revert':
        revert(this.chain, choice.id)
        break
      case 'Discard':
        discard(this.chain, choice.id)
        break
      case 'Substitute':
        substitute(this.chain, choice.y, choice.x, choice.z)
        break
      case 'Merge':
        merge(this.chain, choice.d, choice.c)
        break
    }

    // composites append several atoms — capture every new event for the log;
    // the draw decision rides on the step's first event
    const evs = this.chain.chain()
    for (let i = this.seenEvents; i < evs.length; i++) {
      const entry = this.entryFor(evs[i]!)
      if (i === this.seenEvents) entry.decision = decision
      this.feed.push(entry)
    }
    this.seenEvents = evs.length
    this.emit()
  }

  /** Weighted draw: pick a kind by weight, then uniformly within the kind. */
  private pickChoice(menu: EpistemicChoice[]): { choice: EpistemicChoice; notes: string[] } {
    const byKind = new Map<OperationKind, EpistemicChoice[]>()
    for (const m of menu) {
      if (!byKind.has(m.kind)) byKind.set(m.kind, [])
      byKind.get(m.kind)!.push(m)
    }
    const buckets = [...byKind.entries()].map(([kind, pool]) => ({ kind, pool, weight: WEIGHTS[kind] }))
    const total = buckets.reduce((acc, b) => acc + b.weight, 0)
    let roll = Math.random() * total
    let bucket = buckets[buckets.length - 1]!
    for (const b of buckets) {
      roll -= b.weight
      if (roll <= 0) {
        bucket = b
        break
      }
    }
    const notes = [
      `rolled kind ${bucket.kind} — weight ${WEIGHTS[bucket.kind]} of ${total.toFixed(2)} across ${buckets.length} available kinds; ${bucket.pool.length} candidate${bucket.pool.length === 1 ? '' : 's'}`,
    ]
    // inside Verify: favor valid so green regions actually form
    if (bucket.kind === 'Verify') {
      const valids = bucket.pool.filter((m) => m.kind === 'Verify' && m.result === 'valid')
      if (valids.length > 0 && Math.random() < 0.75) {
        notes.push(`bias: drew from the valid verdicts (75% when available) so green regions form`)
        return { choice: pick(valids), notes }
      }
    }
    notes.push(`picked uniformly within the kind`)
    return { choice: pick(bucket.pool), notes }
  }

  private mintId(): string {
    for (let k = 1; ; k++) {
      const id = `n${k}`
      if (!this.graph.has(id)) return id
    }
  }

  private emit(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!

const TARGET_KEY = 'ddag.target'

export const store = new SimStore()

export function useSim(): SimStore {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store
}
