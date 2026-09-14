import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite, withFileLock } from './lock'
import { EventChain, type ChainDump, type ChainOp, type Provenance } from '../chain/chain'
import { diffSnapshots, type SnapshotDiff } from '../chain/diff'
import { fingerprintIntact, groundsLabel, issueText } from '../chain/explain'
import { rankFrontier, type FrontierRank } from '../kernel/ordering'
import type { Graph } from '../kernel/graph'
import type { NodeId, Result, Snapshot } from '../kernel/types'
import { opNotation } from '../chain/notation'
import { parseClaim } from '../chain/claim'
import { auditChain, pinLabel, type ArtifactDiff } from './provenance'
import { issueSummary, issuesReport, nextIssueKey, readIssues, type Issue } from '../chain/issues'
import { readVersions, versionsReport } from '../chain/versions'

/**
 * MCP shell state: an EventChain persisted as a chain dump (initial snapshot +
 * events) in a JSON file. Load = replay; every applied operation saves.
 * Determinism of the kernel makes the file the complete, portable history.
 */
export class McpStore {
  private chain: EventChain
  private seen = 0
  private _file: string
  /** directory evidence paths resolve against — the project root */
  readonly root: string
  /** called whenever a chain file is loaded or written — the registry hook */
  private readonly onChain: ((file: string) => void) | undefined

  constructor(file: string, root: string = process.cwd(), onChain?: (file: string) => void) {
    this._file = file
    this.root = root
    this.onChain = onChain
    this.chain = this.load()
    this.seen = this.chain.length
  }

  get file(): string {
    return this._file
  }

  /** Point the store at another chain file (runtime project switch — no restart). */
  switchFile(file: string): void {
    this._file = file
    this.chain = this.load()
    this.seen = this.chain.length
  }

  /**
   * Why the chain file cannot be used, when it exists but does not load — a
   * hand edit, a merge marker, a disk error. While set, every operation is
   * refused and nothing is written: the record is never replaced by a fresh
   * graph in silence (SEC-CHAIN-1). Cleared when the file loads again.
   */
  private broken: string | null = null

  private load(): EventChain {
    if (!existsSync(this._file)) {
      this.broken = null
      return EventChain.create('target', 'The build target')
    }
    try {
      const raw = readFileSync(this._file, 'utf8')
      const chain = EventChain.replay(JSON.parse(raw) as ChainDump)
      this.broken = null
      this.onChain?.(this._file)
      return chain
    } catch (e) {
      this.broken = (e as Error).message
      return EventChain.create('target', 'The build target')
    }
  }

  private refuseIfBroken(): string | null {
    if (this.broken === null) return null
    return `Refused: the chain file ${this._file} exists but cannot be loaded (${this.broken}). Nothing was written. Repair or move the file; graph_new starts a fresh chain deliberately.`
  }

  private save(): void {
    atomicWrite(this._file, JSON.stringify(this.chain.dump()))
    this.onChain?.(this._file)
  }

  /**
   * Catch up with whatever another session wrote since this one last did.
   * Every server writes on every operation, so the in-memory chain is
   * always a prefix of the file: catching up is a replay of the tail, never
   * a merge. A file whose prefix differs (someone ran graph_new, or the
   * file was replaced) is reloaded whole. Returns the number of foreign
   * events taken on.
   */
  refresh(): number {
    if (!existsSync(this._file)) return 0
    let dump: ChainDump
    try {
      dump = JSON.parse(readFileSync(this._file, 'utf8')) as ChainDump
    } catch (e) {
      // writes are atomic, so a file that does not parse is damaged, not mid-write:
      // refuse to operate on it rather than treat it as nothing new (SEC-CHAIN-1)
      this.broken = (e as Error).message
      return 0
    }
    if (this.broken !== null) {
      // the file may load again: take it whole, or stay broken
      return this.reloadWhole(dump)
    }
    const mine = this.chain.chain()
    const sameStart = JSON.stringify(dump.initial) === JSON.stringify(this.chain.dump().initial)
    const prefixMatches =
      sameStart &&
      dump.events.length >= mine.length &&
      mine.every((e, i) => JSON.stringify(e) === JSON.stringify(dump.events[i]))
    if (!prefixMatches) return this.reloadWhole(dump)
    let taken = 0
    for (const ev of dump.events.slice(mine.length)) {
      const r = this.chain.dispatch(ev.op, ev.via, ev.evidence, ev.provenance)
      if (!r.ok) {
        // the file's tail does not replay on our graph — the file is the truth
        return this.reloadWhole(dump)
      }
      taken++
    }
    this.seen = this.chain.length
    return taken
  }

  /** Replace the in-memory chain with the file's, or mark the store broken if the file does not replay. */
  private reloadWhole(dump: ChainDump): number {
    try {
      this.chain = EventChain.replay(dump)
    } catch (e) {
      this.broken = (e as Error).message
      return 0
    }
    this.seen = this.chain.length
    this.broken = null
    return this.chain.length
  }

  get graph(): Graph {
    return this.chain.graph
  }

  get eventChain(): EventChain {
    return this.chain
  }

  newGraph(rootId: string, content: string): void {
    withFileLock(this._file, () => {
      this.chain = EventChain.create(rootId, content)
      this.seen = 0
      this.broken = null // deliberate: graph_new is the one way to replace a file that will not load
      this.save()
    })
  }

  mintId(): string {
    for (let k = 1; ; k++) {
      const id = `n${k}`
      if (!this.graph.has(id)) return id
    }
  }

  /**
   * Run one epistemic operation (given as a closure over the chain), then
   * persist and narrate: applied events in notation, consequences as a diff,
   * and the current standing.
   */
  perform(run: (chain: EventChain) => Result): { ok: boolean; text: string } {
    let result: Result
    let applied: ReturnType<EventChain['chain']>
    let before: Snapshot
    let caughtUp = 0
    try {
      withFileLock(this._file, () => {
        caughtUp = this.refresh() // another session may have moved: apply against the truth
        const refused = this.refuseIfBroken()
        if (refused !== null) throw new Error(refused)
        before = this.chain.current()
        result = run(this.chain)
        const events = this.chain.chain()
        applied = events.slice(this.seen)
        this.seen = events.length
        if (applied.length > 0) this.save()
      })
    } catch (e) {
      const msg = (e as Error).message
      return { ok: false, text: msg.startsWith('Refused:') ? msg : `Rejected: ${msg}` }
    }
    result = result!
    applied = applied!
    before = before!

    if (!result.ok && applied.length === 0) {
      const note = caughtUp > 0 ? ` (after taking on ${caughtUp} event(s) another session wrote)` : ''
      return { ok: false, text: `Rejected: ${result.error}${note}` }
    }
    const lines: string[] = []
    if (caughtUp > 0) lines.push(`Caught up: ${caughtUp} event(s) written by another session since this one last wrote.`)
    lines.push(
      `Applied: ${applied
        .map((e) => {
          let s = e.via ? `${opNotation(e.op)} [${e.via}]` : opNotation(e.op)
          const grounds = e.evidence ?? issueText(e.op)
          if (grounds) s += ` (${groundsLabel(e.op)}: ${grounds})`
          if (e.provenance) s += ` [pinned ${pinLabel(e.provenance)}]`
          return s
        })
        .join('; ')}`,
    )
    if (!result.ok) lines.push(`Then rejected (honest partial): ${result.error}`)
    const changes = narrateDiff(diffSnapshots(before, this.chain.current()))
    if (changes) lines.push(`Consequences: ${changes}`)
    lines.push(this.standing())
    return { ok: result.ok, text: lines.join('\n') }
  }

  /**
   * One-line standing: root status + the frontier RANKED by the one-step
   * lookahead (roadmap: ordering) — where the next judgment is best spent.
   */
  standing(): string {
    const g = this.graph
    const rootState = g.solid(g.root) ? 'SOLID — the target is verified' : 'broken'
    const ranks = rankFrontier(g, { noTrivialWin: true })
    if (ranks.length === 0) {
      const bare = !g.solid(g.root) && g.predecessors(g.root).length === 0
      const note = this.recordNotes()
      return `Root ${g.root}: ${rootState}.${note} Frontier: ${bare ? '(empty — decompose the root first; P1 keeps a bare-root verify off the table)' : '(empty)'}`
    }
    const issuesNote = this.recordNotes()
    const fmt = (r: FrontierRank): string => {
      if (r.rootSolid) return `${r.id} (WINS — root turns solid)`
      const parts: string[] = []
      if (r.restored.length > 0) parts.push(`restores ${r.restored.length}`)
      if (r.unlocked.length > 0) parts.push(`unlocks ${r.unlocked.length}`)
      return parts.length > 0 ? `${r.id} (${parts.join(', ')})` : r.id
    }
    return `Root ${g.root}: ${rootState}.${issuesNote} Frontier (best judgment first): ${ranks.map(fmt).join(', ')}`
  }

  /** Issue keys this process closed, by the claim they were on — the fixer's own fixes (PROTO-2). */
  private readonly closedHere = new Map<string, NodeId | undefined>()

  noteClosedHere(key: string): void {
    const issue = readIssues(this.chain).find((i) => i.key === key)
    this.closedHere.set(key, issue?.node)
  }

  /**
   * The protocol asks that a fixer never re-verify its own fix. This
   * process cannot know who is typing, but it knows which issues it closed:
   * a valid judgment on a claim whose issue it closed is, unless the
   * evidence says otherwise, the fixer judging the fix.
   */
  selfFixNudge(id: NodeId): string | null {
    const keys = [...this.closedHere].filter(([, node]) => node === id).map(([key]) => key)
    if (keys.length === 0) return null
    return `Protocol: this session closed ${keys.join(', ')} on ${id} — a fixer re-verifying its own fix. The protocol asks for an independent re-examination (a fresh subagent, or the auditor) to make this judgment; if this judgment records one, say so in the evidence, otherwise doubt it and have the re-examination verify.`
  }

  /** Recorded findings with their lifecycle (see src/chain/issues.ts). */
  issuesReport(opts: { detail?: boolean; key?: string } = {}): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    let issues = readIssues(this.chain)
    if (opts.key !== undefined) {
      issues = issues.filter((i) => i.key === opts.key)
      if (issues.length === 0) return `No issue "${opts.key}" on this chain.`
      return issuesReport(issues, { detail: true })
    }
    return issuesReport(issues, opts)
  }

  issues(): Issue[] {
    this.refresh()
    return readIssues(this.chain)
  }

  versionsReport(): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    return versionsReport(readVersions(this.chain))
  }

  /** A key for a new issue when the caller gives none: I1, I2, … */
  nextIssueKey(): string {
    return nextIssueKey(readIssues(this.chain))
  }

  /** Valid judgments whose pinned artifacts changed or vanished since. */
  staleCount(): number {
    return auditChain(this.chain, this.root).summary.stale
  }

  /** Invalid claims on the frontier whose recorded issues are all closed — the fix is in, the judgment is not. */
  readyToReverify(): NodeId[] {
    const g = this.graph
    const byNode = new Map<NodeId, { open: number; total: number }>()
    for (const i of readIssues(this.chain)) {
      if (i.node === undefined) continue
      const c = byNode.get(i.node) ?? { open: 0, total: 0 }
      c.total++
      if (i.status === 'open') c.open++
      byNode.set(i.node, c)
    }
    return g.ids().filter((id) => {
      if (g.verdict(id) !== 'invalid') return false
      const c = byNode.get(id)
      return c !== undefined && c.total > 0 && c.open === 0
    })
  }

  /** The standing line's record notes: open issues, stale judgments, claims ready to re-verify. */
  private recordNotes(): string {
    const parts: string[] = []
    const open = issueSummary(readIssues(this.chain)).open
    if (open > 0) parts.push(`Issues: ${open} open.`)
    const stale = this.staleCount()
    if (stale > 0) parts.push(`Stale: ${stale} judgment(s) rest on changed code — reverify or doubt them.`)
    const ready = this.readyToReverify()
    if (ready.length > 0) parts.push(`Ready to re-verify (issues all closed): ${ready.join(', ')}.`)
    return parts.length > 0 ? ` ${parts.join(' ')}` : ''
  }

  /** Full state report. */
  stateReport(): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const g = this.graph
    const lines: string[] = [
      `Chain file: ${this._file}`,
      `Graph (root: ${g.root}) — ${g.ids().length} nodes`,
    ]
    for (const id of g.ids()) {
      const n = g.node(id)
      const fp =
        n.fingerprint === null
          ? 'no fingerprint'
          : this.fingerprintIntact(id)
            ? 'fingerprint intact (heals via Restore)'
            : 'fingerprint stale (needs re-verify or revert)'
      const parts = g.predecessors(id)
      const { claim, criterion } = parseClaim(n.content)
      const h = this.nodeHistory(id)
      lines.push(`- ${id} [${n.verdict}${g.solid(id) ? ', solid' : ''}]`)
      lines.push(`    claim: ${claim}`)
      lines.push(`    verify: ${criterion ?? '(no criterion recorded)'}`)
      if (h.because) lines.push(`    because: ${h.because}`)
      lines.push(
        h.judged
          ? `    judged: ${h.judged.result}${h.judged.evidence ? ` — ${h.judged.evidence}` : ''}${h.judged.pin ? ` [pinned ${h.judged.pin}]` : ''}`
          : '    judged: never',
      )
      lines.push(`    parts: ${parts.length > 0 ? parts.join(', ') : '(leaf)'} · ${fp}`)
    }
    lines.push(this.standing())
    return lines.join('\n')
  }

  historyReport(limit: number): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const events = this.chain.chain()
    const tail = events.slice(-limit)
    if (tail.length === 0) return 'No events yet — the chain is at genesis.'
    return tail
      .map(
        (e) =>
          `${e.seq}. ${opNotation(e.op)}${e.via ? ` [${e.via}]` : ''}${e.evidence ?? issueText(e.op) ? ` — ${groundsLabel(e.op)}: ${e.evidence ?? issueText(e.op)}` : ''}${e.provenance ? ` [pinned ${pinLabel(e.provenance)}]` : ''}`,
      )
      .join('\n')
  }

  /**
   * Evidence audit (doctrine hook P5): for every valid node, re-hash the
   * artifacts its last valid judgment was pinned to. Changed or missing
   * artifacts mean the evidence may be stale — the mechanical prompt for
   * Doubt. Judgments recorded without provenance are listed as unpinned.
   */
  auditReport(): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const { nodes, summary } = auditChain(this.chain, this.root, { diffs: true })
    const lines: string[] = []
    for (const [id, a] of Object.entries(nodes)) {
      switch (a.status) {
        case 'unpinned':
          lines.push(`- ${id}: unpinned — judged without provenance (Restore, or an older shell)`)
          break
        case 'unwatched':
          lines.push(`- ${id}: unwatched — pinned to ${a.pin} but no artifacts cited; drift under this judgment is invisible`)
          break
        case 'parts':
          lines.push(`- ${id}: rests on its ${a.parts} part(s) — each carries its own pin, and a part's restatement reopens this node`)
          break
        case 'intact':
          lines.push(`- ${id}: intact — ${a.artifacts} artifact(s) unchanged since ${a.pin}`)
          break
        case 'stale': {
          const what = [...a.changed.map((p) => `${p} changed`), ...a.missing.map((p) => `${p} missing`)].join(', ')
          lines.push(`- ${id}: STALE? — since ${a.pin}: ${what} → reverify(${id}) if it still holds, refute(${id}) if not`)
          for (const d of a.diffs ?? []) lines.push(`    ${describeDiff(d)}`)
        }
      }
    }
    if (lines.length === 0) return 'No valid judgments to audit.'
    return [
      `Evidence audit (${summary.stale} judgment(s) resting on changed artifacts${summary.unwatched > 0 ? `, ${summary.unwatched} unwatched` : ''}${summary.parts > 0 ? `, ${summary.parts} resting on parts` : ''}):`,
      ...lines,
      'A changed artifact does not refute a claim — it means the judgment was made against code that no longer exists. Re-examine, then doubt or re-verify.',
    ].join('\n')
  }

  fingerprintIntact(id: NodeId): boolean {
    return fingerprintIntact(this.graph, id)
  }

  /** Why the node exists (its Add rationale) and how it was last judged — read off the chain. */
  nodeHistory(id: NodeId): { because?: string; judged?: { result: string; evidence?: string; pin?: string } } {
    const events = this.chain.chain()
    const out: { because?: string; judged?: { result: string; evidence?: string; pin?: string } } = {}
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (!out.judged && e.op.type === 'verify' && e.op.id === id) {
        out.judged = { result: e.op.result }
        if (e.evidence) out.judged.evidence = e.evidence
        if (e.provenance) out.judged.pin = pinLabel(e.provenance)
      }
      if (!out.because && e.op.type === 'add' && e.op.id === id && e.evidence) out.because = e.evidence
      if (out.judged && out.because) break
    }
    return out
  }

  dispatch(op: ChainOp, evidence?: string, provenance?: Provenance): { ok: boolean; text: string } {
    return this.perform((chain) => chain.dispatch(op, undefined, evidence, provenance))
  }

  currentSnapshot(): Snapshot {
    return this.chain.current()
  }
}

/** "src/auth.rs: +12/-3 in sanitize_label, fn wrap_aad (approximate — pinned on a dirty tree)" */
export function describeDiff(d: ArtifactDiff): string {
  const where = d.where.length > 0 ? ` in ${d.where.slice(0, 6).join('; ')}${d.where.length > 6 ? `; +${d.where.length - 6} more` : ''}` : ''
  return `${d.path}: +${d.added}/-${d.removed}${where}${d.approximate ? ' (approximate — pinned on a dirty tree)' : ''}`
}

function narrateDiff(d: SnapshotDiff): string {
  const parts: string[] = []
  if (d.addedNodes.length > 0) parts.push(`added ${d.addedNodes.join(', ')}`)
  if (d.droppedNodes.length > 0) parts.push(`dropped ${d.droppedNodes.join(', ')}`)
  if (d.addedArcs.length > 0) parts.push(`arcs + ${d.addedArcs.map((a) => `${a.from}->${a.to}`).join(', ')}`)
  if (d.removedArcs.length > 0) parts.push(`arcs − ${d.removedArcs.map((a) => `${a.from}->${a.to}`).join(', ')}`)
  for (const v of d.verdictChanged) parts.push(`${v.id}: ${v.from}→${v.to}`)
  const restored = d.verdictChanged.filter((v) => v.from === 'pending' && v.to === 'valid')
  if (restored.length > 1) parts.push(`(restore cascade: ${restored.map((v) => v.id).join(', ')})`)
  return parts.join('; ')
}
