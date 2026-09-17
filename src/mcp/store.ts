import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { atomicWrite, withFileLock } from './lock'
import { coneOf, homesOf, mainTarget, migrateToProject, projectOf, targetsOf } from '../chain/targets'
import { EventChain, type ChainDump, type ChainOp, type Provenance } from '../chain/chain'
import { diffSnapshots, type SnapshotDiff } from '../chain/diff'
import { fingerprintIntact, groundsLabel, issueText } from '../chain/explain'
import { rankFrontier, type FrontierRank } from '../kernel/ordering'
import { Graph } from '../kernel/graph'
import type { NodeId, Result, Snapshot } from '../kernel/types'
import { opNotation } from '../chain/notation'
import { eventsOf, firstSentence, nodeChain, renderEvents, renderNodeChain, roundTitle, type NodeEntry } from '../chain/reader'
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
  /** the target this session works on; null means the main target (session state, like the opened file) */
  private currentTarget: NodeId | null = null

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
    this.currentTarget = null
  }

  // ---------- targets (src/chain/targets.ts): a reading of the shape, one at a time ----------

  /** The project's display name: the opened folder's basename. */
  get projectName(): string {
    return basename(resolve(this.root))
  }

  project(): NodeId | null {
    return projectOf(this.chain)
  }

  targets(): NodeId[] {
    return targetsOf(this.chain)
  }

  /** The current target: the session's choice when it is still a target, else the main target. */
  target(): NodeId {
    const ts = this.targets()
    return this.currentTarget !== null && ts.includes(this.currentTarget) ? this.currentTarget : ts[0]!
  }

  /** How a target is named: the main target by its id, a sub-target as <project>/<id>. */
  targetLabel(id: NodeId): string {
    return id === mainTarget(this.chain) ? id : `${this.projectName}/${id}`
  }

  homes(): Map<NodeId, NodeId> {
    return homesOf(this.chain)
  }

  homeOf(id: NodeId): NodeId | null {
    return this.homes().get(id) ?? null
  }

  /** The current target's cone: every node with a path to it. */
  cone(): Set<NodeId> {
    return coneOf(this.graph, this.target())
  }

  /** What this session may judge or restructure: the cone's nodes whose home is the current target. */
  judgeable(): Set<NodeId> {
    const h = this.homes()
    const t = this.target()
    const out = new Set<NodeId>()
    for (const id of this.cone()) if (h.get(id) === t) out.add(id)
    return out
  }

  /** Refusal text when a judgment or restatement of `id` does not belong to the current target; null when it does. */
  notHome(id: NodeId): string | null {
    if (!this.graph.has(id)) return null // the kernel names the missing node
    if (id === this.project()) return `Refused: "${id}" is the project node — it holds the targets and is never judged or restated`
    const h = this.homeOf(id)
    const t = this.target()
    if (h !== null && h !== t)
      return `Refused: "${id}" is judged in its home target ${this.targetLabel(h)} — target_switch there first; in ${this.targetLabel(t)} it is only used`
    return null
  }

  /** Refusal text when a structural change would land outside the current target's cone; null when it is inside. */
  notInCone(id: NodeId, role: string): string | null {
    if (!this.graph.has(id)) return null
    if (id === this.project()) return `Refused: "${id}" is the project node — targets are added with target_new, not by hand`
    if (!this.cone().has(id)) return `Refused: ${role} "${id}" is not in target ${this.targetLabel(this.target())} — target_switch to the target it belongs to`
    return this.notHome(id)
  }

  /**
   * Add a sub-target under the project node, migrating a legacy chain to a
   * project chain first (the one deliberate rewrite of the file's initial
   * snapshot besides graph_new). The new target becomes the current one.
   */
  targetNew(id: NodeId, content: string, rationale?: string, adopt = false): { ok: boolean; text: string } {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return { ok: false, text: refused }
    if (!adopt && this.graph.has(id)) return { ok: false, text: `Rejected: node "${id}" already exists — pass adopt to make an existing claim a target` }
    if (adopt) {
      if (!this.graph.has(id)) return { ok: false, text: `Rejected: node "${id}" does not exist — adopt names an existing claim` }
      if (this.targets().includes(id) || id === this.project()) return { ok: false, text: `Rejected: "${id}" is already a target` }
    }
    let migrated: string | null = null
    if (this.project() === null) {
      const main = this.graph.root
      try {
        withFileLock(this._file, () => {
          this.refresh()
          const dump = migrateToProject(this.chain.dump(), `Project ${this.projectName}: its targets are its parts; never judged`)
          this.chain = EventChain.replay(dump)
          this.seen = this.chain.length
          this.save()
        })
      } catch (e) {
        return { ok: false, text: `Rejected: ${(e as Error).message}` }
      }
      migrated = `Migrated: the chain now has a project node "${this.project()}" above ${main}, which stays the main target; every event replayed unchanged, and other sessions on this file reload it whole.`
    }
    const p = this.project()!
    const r = adopt
      ? this.perform((chain) => {
          // Target(id): the claim becomes a sink of its own — linked under the project node, then
          // released from every whole it was a part of, so its subtree is re-homed to it
          const wholes = chain.graph.successors(id)
          const l = chain.dispatch({ type: 'link', from: id, to: p }, `Target(${id})`, rationale)
          if (!l.ok) return l
          for (const w of wholes) {
            const u = chain.dispatch({ type: 'unlink', from: id, to: w }, `Target(${id})`, rationale)
            if (!u.ok) return u
          }
          return { ok: true }
        })
      : this.dispatch({ type: 'add', id, content, successor: p }, rationale)
    if (!r.ok) return r
    this.currentTarget = id
    return { ok: true, text: `${migrated ? `${migrated}\n` : ''}Target ${this.targetLabel(id)} created and selected.\n${r.text.replace(/\n[^\n]*$/, '')}\n${this.standing()}` }
  }

  targetSwitch(id: NodeId): { ok: boolean; text: string } {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return { ok: false, text: refused }
    if (!this.targets().includes(id)) return { ok: false, text: `Rejected: "${id}" is not a target (targets: ${this.targets().join(', ')})` }
    this.currentTarget = id
    return { ok: true, text: `Switched to target ${this.targetLabel(id)}.\n${this.standing()}` }
  }

  targetList(): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const g = this.graph
    const current = this.target()
    const issues = readIssues(this.chain)
    const lines = [`Targets (${this.targets().length}) of ${this.projectName}${this.project() === null ? ' — single-target chain; target_new adds one' : ''}:`]
    for (const t of this.targets()) {
      const cone = coneOf(g, t)
      const open = issues.filter((i) => i.status === 'open' && i.node !== undefined && cone.has(i.node)).length
      const front = rankFrontier(g, { noTrivialWin: true, target: t, only: new Set([...cone].filter((id) => this.homes().get(id) === t)) }).length
      lines.push(
        `- ${this.targetLabel(t)}${t === current ? ' (current)' : ''}: ${g.solid(t) ? 'SOLID' : 'broken'} · ${cone.size} node(s) · frontier ${front} · issues ${open} open`,
      )
    }
    return lines.join('\n')
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
    this.currentTarget = null
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
          // a judgment's evidence is not quoted back (TOK-2): the caller wrote it, and
          // graph_history and the dashboard carry it; records keep their short summary
          const grounds = e.op.type === 'verify' || e.op.type === 'doubt' ? undefined : (e.evidence ?? issueText(e.op))
          if (grounds) s += ` (${groundsLabel(e.op)}: ${grounds})`
          if (e.provenance) s += ` [pinned ${pinLabel(e.provenance)}]`
          return s
        })
        .join('; ')}`,
    )
    if (!result.ok) lines.push(`Then rejected (honest partial): ${result.error}`)
    const changes = narrateDiff(diffSnapshots(before, this.chain.current()))
    if (changes) lines.push(`Consequences: ${changes}`)
    const t = this.target()
    if (this.project() !== null && before.nodes.some((n) => n.id === t) && !Graph.fromSnapshot(before).solid(t) && this.graph.solid(t))
      lines.push(`★ target ${this.targetLabel(t)} is verified — it is solid`)
    lines.push(this.standing())
    return { ok: result.ok, text: lines.join('\n') }
  }

  /**
   * One-line standing: root status + the frontier RANKED by the one-step
   * lookahead (roadmap: ordering) — where the next judgment is best spent.
   */
  standing(): string {
    const g = this.graph
    const t = this.target()
    const head = `${t === mainTarget(this.chain) ? 'Root' : 'Target'} ${this.targetLabel(t)}`
    const rootState = g.solid(t) ? 'SOLID — the target is verified' : 'broken'
    const ranks = this.ranks()
    if (ranks.length === 0) {
      const bare = !g.solid(t) && g.predecessors(t).length === 0
      const note = this.recordNotes()
      return `${head}: ${rootState}.${note} Frontier: ${bare ? '(empty — decompose the root first; a root with no parts is never judged)' : '(empty)'} · at #${this.chain.length}`
    }
    const issuesNote = this.recordNotes()
    const fmt = (r: FrontierRank): string => {
      if (r.rootSolid) return `${r.id} (WINS — root turns solid)`
      const parts: string[] = []
      if (r.restored.length > 0) parts.push(`restores ${r.restored.length}`)
      if (r.unlocked.length > 0) parts.push(`unlocks ${r.unlocked.length}`)
      return parts.length > 0 ? `${r.id} (${parts.join(', ')})` : r.id
    }
    return `${head}: ${rootState}.${issuesNote} Frontier (best judgment first): ${ranks.map(fmt).join(', ')} · at #${this.chain.length}`
  }

  /** The current target's frontier, ranked: its cone, minus what other targets judge. */
  ranks(): FrontierRank[] {
    return rankFrontier(this.graph, { noTrivialWin: true, target: this.target(), only: this.judgeable() })
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
    const cone = this.cone()
    return Object.entries(auditChain(this.chain, this.root, { chainFile: this._file }).nodes).filter(([id, a]) => a.status === 'stale' && cone.has(id)).length
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
    const cone = this.cone()
    return g.ids().filter((id) => {
      if (!cone.has(id) || g.verdict(id) !== 'invalid') return false
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
  /**
   * The graph as a worklist (TOK-1). Compact by default: one line per node
   * (verdict, solidity, parts, and STALE / open-issue / FRONTIER markers),
   * with the frontier nodes in full because they are about to be judged.
   * `node` gives one node in full; `full` the whole graph in full.
   */
  stateReport(opts: { node?: NodeId; full?: boolean } = {}): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const g = this.graph
    if (opts.node !== undefined && !g.has(opts.node)) return `Rejected: node "${opts.node}" does not exist`
    const cone = this.cone()
    const homes = this.homes()
    const t = this.target()
    const ids = opts.node !== undefined ? [opts.node] : g.ids().filter((id) => cone.has(id))
    const frontier = new Set(this.ranks().map((r) => r.id))
    const stale = new Set(
      Object.entries(auditChain(this.chain, this.root, { chainFile: this._file }).nodes)
        .filter(([, a]) => a.status === 'stale')
        .map(([id]) => id),
    )
    const open = new Map<NodeId, number>()
    for (const i of readIssues(this.chain)) if (i.status === 'open' && i.node) open.set(i.node, (open.get(i.node) ?? 0) + 1)
    const mode = opts.node !== undefined ? 'one node' : opts.full ? 'every node in full' : 'one line per node, frontier nodes in full'
    const others = this.targets().filter((x) => x !== t)
    const lines: string[] = [
      `Chain file: ${this._file}`,
      `${this.project() === null ? `Graph (root: ${g.root})` : `Target ${this.targetLabel(t)}${others.length > 0 ? ` (other targets: ${others.map((x) => this.targetLabel(x)).join(', ')}; target_switch to view)` : ''}`} — ${ids.length} nodes; ${mode}`,
    ]
    if (opts.node === undefined && !opts.full) lines.push('(graph_state {node} shows one node in full; {full: true} shows every node)')
    for (const id of ids) {
      const n = g.node(id)
      const parts = g.predecessors(id)
      const head = `- ${id} [${n.verdict}${g.solid(id) ? ', solid' : ''}]`
      const home = homes.get(id)
      const marks = [
        stale.has(id) ? 'STALE' : '',
        open.has(id) ? `issues: ${open.get(id)} open` : '',
        frontier.has(id) ? 'FRONTIER' : '',
        home !== undefined && home !== t ? `home: ${this.targetLabel(home)}` : '',
      ].filter(Boolean)
      const inFull = opts.full || opts.node !== undefined || frontier.has(id)
      if (!inFull) {
        lines.push(`${head} · ${parts.length > 0 ? `parts: ${parts.join(', ')}` : 'leaf'}${marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}`)
        continue
      }
      const fp =
        n.fingerprint === null
          ? 'no fingerprint'
          : this.fingerprintIntact(id)
            ? 'fingerprint intact (heals via Restore)'
            : 'fingerprint stale (needs re-verify or revert)'
      const { claim, criterion } = parseClaim(n.content)
      const h = this.nodeHistory(id)
      lines.push(`${head}${marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}`)
      lines.push(`    claim: ${claim}`)
      lines.push(`    verify: ${criterion ?? '(no criterion recorded)'}`)
      if (h.because) lines.push(`    because: ${h.because}`)
      lines.push(
        h.judged
          ? `    judged: ${h.judged.result}${h.judged.evidence ? ` — ${h.judged.evidence}` : ''}${h.judged.pin ? ` [pinned ${h.judged.pin}]` : ''}`
          : '    judged: never',
      )
      lines.push(`    parts: ${parts.length > 0 ? parts.join(', ') : '(leaf)'} · ${fp}`)
      if (opts.node !== undefined) {
        const entries = nodeChain(this.chain, id)
        const judgedAt = [...entries].reverse().find((e) => e.kind === 'judged')?.seq
        lines.push(`    chain: ${entries.length} entries, last #${entries.at(-1)?.seq ?? 0}${judgedAt ? `, judged #${judgedAt}` : ''} — graph_history {node: "${id}"} reads it, why {id: "${id}"} explains its state`)
      }
    }
    lines.push(this.standing())
    return lines.join('\n')
  }

  /**
   * The chain, read selectively (nc-tools): one claim's own chain (`node`), the current target's
   * (`cone`), what happened after a position (`since`), or the last `limit` events. Evidence shows
   * as its first sentence unless `full`; a Doubt+Verify pair under one label is one line.
   */
  historyReport(opts: { limit?: number; node?: NodeId; cone?: boolean; since?: number; full?: boolean } = {}): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const events = this.chain.chain()
    if (events.length === 0) return 'No events yet — the chain is at genesis.'
    const pin = (e: (typeof events)[number]) => (e.provenance ? pinLabel(e.provenance) : undefined)
    const render = { pin, ...(opts.full ? { full: true } : {}) }
    if (opts.node !== undefined) {
      const entries = nodeChain(this.chain, opts.node)
      if (entries.length === 0) return `Rejected: no event on this chain names or reaches "${opts.node}"`
      const lines = renderNodeChain(this.chain, opts.node, render)
      return [`History of ${opts.node} — ${entries.length} entries in ${lines.length} lines (chain at #${events.length}):`, ...lines].join('\n')
    }
    let pool: readonly (typeof events)[number][] = opts.cone ? eventsOf(this.chain, this.cone()) : events
    if (opts.since !== undefined) pool = pool.filter((e) => e.seq > opts.since!)
    const tail = opts.since !== undefined && opts.limit === undefined ? pool : pool.slice(-(opts.limit ?? 30))
    if (tail.length === 0) return `Nothing${opts.cone ? ` in target ${this.targetLabel(this.target())}` : ''} after #${opts.since ?? 0} — the chain is at #${events.length}.`
    const grounds = (e: (typeof events)[number]) => {
      const g = e.evidence ?? issueText(e.op)
      return g ? `${groundsLabel(e.op)}: ${g}` : undefined
    }
    return renderEvents(tail, { ...render, grounds }).join('\n')
  }

  /** Why a claim is in its current state: the causal slice, not the log (nc-tools). */
  whyReport(id: NodeId): string {
    this.refresh()
    const refused = this.refuseIfBroken()
    if (refused !== null) return refused
    const g = this.graph
    if (!g.has(id)) return `Rejected: node "${id}" does not exist`
    const events = this.chain.chain()
    const said = (seq: number) => {
      const e = events[seq - 1]!
      return `${e.evidence ? ` — ${firstSentence(e.evidence)}` : ''}${e.provenance ? ` [pinned ${pinLabel(e.provenance)}]` : ''}${e.round ? ` [round ${e.round}: ${roundTitle(this.chain, e.round) ?? '?'}]` : ''}`
    }
    const reason = (n: NodeId, depth: number): string[] => {
      const pad = '  '.repeat(depth)
      const chainOf = nodeChain(this.chain, n)
      const last = <K extends NodeEntry['kind']>(...kinds: K[]) => [...chainOf].reverse().find((e) => (kinds as string[]).includes(e.kind))
      const verdict = g.verdict(n)
      const out = [`${pad}${n} [${verdict}${g.solid(n) ? ', solid' : ''}]`]
      if (verdict === 'valid') {
        const j = last('judged', 'restored')
        if (j) out.push(`${pad}  ${j.kind === 'judged' ? `judged valid at #${j.seq}${j.via ? ` (${j.via})` : ''}${said(j.seq)}` : `restored at #${j.seq} by ${j.cause!.op}`}`)
        if (!g.solid(n)) {
          const open = g.predecessors(n).filter((p) => !g.solid(p))
          out.push(`${pad}  not solid: waiting on ${open.join(', ')}`)
          if (depth < 1) for (const p of open) out.push(...reason(p, depth + 1))
        }
        return out
      }
      if (verdict === 'invalid') {
        const j = last('judged')
        if (j) out.push(`${pad}  judged invalid at #${j.seq}${j.via ? ` (${j.via})` : ''}${said(j.seq)}`)
        const open = readIssues(this.chain).filter((i) => i.node === n && i.status === 'open')
        out.push(`${pad}  ${open.length > 0 ? `open issues: ${open.map((i) => i.key).join(', ')}` : 'no open issue on it — ready to re-verify once repaired'}`)
        return out
      }
      // pending: the last entry that left it without a judgment
      const c = [...chainOf].reverse().find((e) => e.kind === 'reopened' || e.kind === 'added' || e.kind === 'doubted' || e.kind === 'restated' || e.effect === 'reopened')
      if (c) {
        if (c.kind === 'added') out.push(`${pad}  never judged — added at #${c.seq} under ${c.ref}`)
        else if (c.kind === 'doubted') out.push(`${pad}  judgment withdrawn at #${c.seq}${said(c.seq)}`)
        else if (c.kind === 'restated') out.push(`${pad}  restated at #${c.seq} — the old judgment was of other words`)
        else if (c.direct) out.push(`${pad}  its parts changed at #${c.seq}: ${c.kind === 'gained-part' ? 'gained' : 'lost'} ${c.ref}`)
        else {
          out.push(`${pad}  reopened at #${c.seq} by ${c.cause!.op}`)
          if (depth < 1 && g.has(c.cause!.node)) out.push(...reason(c.cause!.node, depth + 1))
        }
      }
      const waiting = g.predecessors(n).filter((p) => !g.solid(p))
      out.push(`${pad}  ${waiting.length > 0 ? `cannot be judged yet: waiting on ${waiting.join(', ')}` : fingerprintIntact(g, n) ? 'its parts are solid and its fingerprint is intact' : 'on the frontier — verifiable now'}`)
      return out
    }
    return reason(id, 0).join('\n')
  }

  /** Record a round: a change described once, cited by the judgments re-anchored after it (nc-round). */
  roundRecord(key: string | undefined, title: string, detail?: string): { ok: boolean; text: string } {
    const k = key ?? `R${this.chain.chain().filter((e) => e.op.type === 'round').length + 1}`
    return this.dispatch({ type: 'round', key: k, title, ...(detail !== undefined ? { detail } : {}) })
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
    const all = auditChain(this.chain, this.root, { diffs: true, chainFile: this._file })
    const cone = this.cone()
    const nodes = Object.fromEntries(Object.entries(all.nodes).filter(([id]) => cone.has(id)))
    const summary = { stale: 0, unwatched: 0, parts: 0 }
    for (const a of Object.values(nodes)) {
      if (a.status === 'stale') summary.stale++
      else if (a.status === 'unwatched') summary.unwatched++
      else if (a.status === 'parts') summary.parts++
    }
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
        if (e.evidence) out.judged.evidence = e.round ? `[round ${e.round}: ${roundTitle(this.chain, e.round) ?? '?'}] ${e.evidence}` : e.evidence
        if (e.provenance) out.judged.pin = pinLabel(e.provenance)
      }
      if (!out.because && e.op.type === 'add' && e.op.id === id && e.evidence) out.because = e.evidence
      if (out.judged && out.because) break
    }
    return out
  }

  dispatch(op: ChainOp, evidence?: string, provenance?: Provenance, round?: string): { ok: boolean; text: string } {
    return this.perform((chain) => chain.dispatch(op, undefined, evidence, provenance, round))
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
