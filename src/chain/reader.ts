import type { NodeId } from '../kernel/types'
import { isIssueOp, isRecordOp, isRoundOp, type ChainEvent, type EventChain } from './chain'
import { diffSnapshots } from './diff'
import { opNotation } from './notation'

/**
 * A node's event chain: the projection of the linear log onto one claim
 * (DESIGN.md "Node chains"). Direct entries are the events whose operation
 * names the node; indirect entries are the events whose consequences reached
 * it — reopened, restored, became solid, dropped — each carrying the
 * operation that caused it. Derived by one replay pass over the snapshots
 * the chain already holds and cached by chain length; nothing is stored, so
 * the index cannot drift from the log, and the log stays the one total order
 * replay and the multi-session fast-forward rest on.
 */
export type EntryKind =
  | 'added'
  | 'gained-part'
  | 'lost-part'
  | 'linked-into'
  | 'unlinked-from'
  | 'restated'
  | 'judged'
  | 'doubted'
  | 'issue-opened'
  | 'issue-closed'
  | 'reopened'
  | 'restored'
  | 'solid'
  | 'dropped'

export interface NodeEntry {
  seq: number
  /** the operation named this node; false when only its consequences reached it */
  direct: boolean
  kind: EntryKind
  result?: 'valid' | 'invalid'
  /** the other node of a structural entry, or the issue key */
  ref?: string
  /** what a direct structural or restating event did to this node's own verdict */
  effect?: 'reopened' | 'restored'
  /** indirect entries: the operation that caused this */
  cause?: { seq: number; node: NodeId; op: string; via?: string }
  via?: string
}

const cache = new WeakMap<EventChain, { len: number; index: Map<NodeId, NodeEntry[]> }>()

export function nodeIndex(chain: EventChain): Map<NodeId, NodeEntry[]> {
  const hit = cache.get(chain)
  if (hit && hit.len === chain.length) return hit.index
  const index = new Map<NodeId, NodeEntry[]>()
  const push = (id: NodeId, e: NodeEntry) => {
    const list = index.get(id)
    if (list) list.push(e)
    else index.set(id, [e])
  }
  const issueNode = new Map<string, NodeId>()
  for (const ev of chain.chain()) {
    const op = ev.op
    const seq = ev.seq
    if (isIssueOp(op)) {
      if (op.action === 'open') {
        if (op.node !== undefined) {
          issueNode.set(op.key, op.node)
          push(op.node, { seq, direct: true, kind: 'issue-opened', ref: op.key })
        }
      } else {
        const n = issueNode.get(op.key)
        if (n !== undefined) push(n, { seq, direct: true, kind: 'issue-closed', ref: op.key })
      }
      continue
    }
    if (isRecordOp(op)) continue
    const direct = new Map<NodeId, NodeEntry>()
    const put = (id: NodeId, e: Omit<NodeEntry, 'seq' | 'direct'>) => {
      const entry: NodeEntry = { seq, direct: true, ...e }
      if (ev.via !== undefined) entry.via = ev.via
      direct.set(id, entry)
      push(id, entry)
    }
    let primary: NodeId
    switch (op.type) {
      case 'add':
        primary = op.id
        put(op.id, { kind: 'added', ref: op.successor })
        put(op.successor, { kind: 'gained-part', ref: op.id })
        break
      case 'link':
        primary = op.from
        put(op.from, { kind: 'linked-into', ref: op.to })
        put(op.to, { kind: 'gained-part', ref: op.from })
        break
      case 'unlink':
        primary = op.from
        put(op.from, { kind: 'unlinked-from', ref: op.to })
        put(op.to, { kind: 'lost-part', ref: op.from })
        break
      case 'mutate':
        primary = op.id
        put(op.id, { kind: 'restated' })
        break
      case 'verify':
        primary = op.id
        put(op.id, { kind: 'judged', result: op.result })
        break
      case 'doubt':
        primary = op.id
        put(op.id, { kind: 'doubted' })
        break
    }
    const cause: NonNullable<NodeEntry['cause']> = { seq, node: primary, op: opNotation(op) }
    if (ev.via !== undefined) cause.via = ev.via
    const d = diffSnapshots(chain.snapshotAt(seq - 1), chain.snapshotAt(seq))
    const verdictMoved = new Set<NodeId>()
    for (const v of d.verdictChanged) {
      verdictMoved.add(v.id)
      if (v.to === 'invalid') continue // only a judgment makes a claim invalid: the direct entry says it
      const effect = v.to === 'valid' ? 'restored' : 'reopened'
      const own = direct.get(v.id)
      if (own) {
        if (own.kind !== 'judged' && own.kind !== 'doubted') own.effect = effect
      } else push(v.id, { seq, direct: false, kind: effect, cause })
    }
    for (const s of d.solidChanged) {
      if (s.to && !verdictMoved.has(s.id) && !direct.has(s.id)) push(s.id, { seq, direct: false, kind: 'solid', cause })
    }
    for (const id of d.droppedNodes) if (!direct.has(id)) push(id, { seq, direct: false, kind: 'dropped', cause })
  }
  cache.set(chain, { len: chain.length, index })
  return index
}

export function nodeChain(chain: EventChain, id: NodeId): NodeEntry[] {
  return nodeIndex(chain).get(id) ?? []
}

/** The first sentence of a text: the doctrine makes it "what was examined and what it showed". */
export function firstSentence(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const m = /^(.*?[.!?])(?=\s|$)/.exec(flat)
  const s = m ? m[1]! : flat
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const isReanchorOf = (e: NodeEntry, id: NodeId): boolean => e.direct && (e.kind === 'doubted' || e.kind === 'judged') && e.via === `Reverify(${id})`
const isReanchorNoise = (e: NodeEntry): boolean => !e.direct && (e.cause?.via ?? '').startsWith('Reverify(')

export interface RenderOptions {
  /** whole evidence texts instead of first sentences */
  full?: boolean
  /** "[pinned …]" for an event, from the shell that knows provenance */
  pin?: (ev: ChainEvent) => string | undefined
}

/** A claim's chain as lines: re-anchoring runs collapsed, the noise of re-anchorings beneath it counted, causes named. */
export function renderNodeChain(chain: EventChain, id: NodeId, o: RenderOptions = {}): string[] {
  const events = chain.chain()
  const text = (seq: number): string => {
    const ev = events[seq - 1]!
    const grounds = ev.evidence ?? ''
    const body = grounds === '' ? '' : ` — ${o.full ? grounds : firstSentence(grounds)}`
    const pin = o.pin?.(ev)
    return `${body}${pin ? ` [pinned ${pin}]` : ''}${ev.round ? ` [round ${ev.round}]` : ''}`
  }
  const lines: string[] = []
  let run: { count: number; first: number; last: number } | null = null
  let noise = 0
  let noiseLast = 0
  const flush = () => {
    if (run === null) return
    lines.push(
      run.count === 1
        ? `#${run.last} re-anchored${text(run.last)}`
        : `#${run.first}–#${run.last} re-anchored ${run.count} times; the last${text(run.last)}`,
    )
    run = null
  }
  for (const e of nodeChain(chain, id)) {
    if (isReanchorNoise(e)) {
      noise++
      noiseLast = e.seq
      continue
    }
    if (isReanchorOf(e, id)) {
      if (e.kind === 'doubted') continue // the pair is one act; the verify carries it
      if (run === null) run = { count: 1, first: e.seq, last: e.seq }
      else {
        run.count++
        run.last = e.seq
      }
      continue
    }
    flush()
    const via = e.via ? ` [${e.via}]` : ''
    const eff = e.effect ? ` — this claim ${e.effect === 'reopened' ? 'reopened' : 'was restored'}` : ''
    switch (e.kind) {
      case 'added':
        lines.push(`#${e.seq} added under ${e.ref}${via}${text(e.seq)}`)
        break
      case 'gained-part':
        lines.push(`#${e.seq} gained the part ${e.ref}${via}${eff}`)
        break
      case 'lost-part':
        lines.push(`#${e.seq} lost the part ${e.ref}${via}${eff}`)
        break
      case 'linked-into':
        lines.push(`#${e.seq} linked into ${e.ref}${via}`)
        break
      case 'unlinked-from':
        lines.push(`#${e.seq} unlinked from ${e.ref}${via}`)
        break
      case 'restated':
        lines.push(`#${e.seq} restated${via}${eff}${text(e.seq)}`)
        break
      case 'judged':
        lines.push(`#${e.seq} judged ${e.result}${via}${text(e.seq)}`)
        break
      case 'doubted':
        lines.push(`#${e.seq} judgment withdrawn${via}${text(e.seq)}`)
        break
      case 'issue-opened':
        lines.push(`#${e.seq} issue ${e.ref} opened`)
        break
      case 'issue-closed':
        lines.push(`#${e.seq} issue ${e.ref} closed`)
        break
      case 'reopened':
        lines.push(`#${e.seq} reopened by ${e.cause!.op} (see ${e.cause!.node})`)
        break
      case 'restored':
        lines.push(`#${e.seq} restored by ${e.cause!.op} (see ${e.cause!.node})`)
        break
      case 'solid':
        lines.push(`#${e.seq} became solid through ${e.cause!.op}`)
        break
      case 'dropped':
        lines.push(`#${e.seq} dropped by ${e.cause!.op}`)
        break
    }
  }
  flush()
  if (noise > 0) lines.push(`(reopened and restored ${noise} times by re-anchorings beneath it, last at #${noiseLast} — no judgment of its own moved)`)
  return lines
}

/** Events as lines, a Doubt+Verify pair under one composite label as one line, evidence as its first sentence unless full. */
export function renderEvents(events: readonly ChainEvent[], o: RenderOptions & { grounds?: (ev: ChainEvent) => string | undefined } = {}): string[] {
  const lines: string[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    const next = events[i + 1]
    const paired =
      e.op.type === 'doubt' && e.via !== undefined && next !== undefined && next.via === e.via && next.op.type === 'verify' && next.op.id === e.op.id
    const shown = paired ? next! : e
    const grounds = o.grounds?.(shown) ?? shown.evidence
    const body = grounds ? ` — ${o.full ? grounds : firstSentence(grounds)}` : ''
    const pin = o.pin?.(shown)
    const head = paired
      ? `${e.seq}–${next!.seq}. ${e.via}=${(next!.op as { result: string }).result}`
      : `${e.seq}. ${opNotation(e.op)}${e.via ? ` [${e.via}]` : ''}`
    lines.push(`${head}${body}${pin ? ` [pinned ${pin}]` : ''}${shown.round ? ` [round ${shown.round}]` : ''}`)
    if (paired) i++
  }
  return lines
}

/** The events that named or reached any of these nodes, in log order. */
export function eventsOf(chain: EventChain, ids: Iterable<NodeId>): ChainEvent[] {
  const index = nodeIndex(chain)
  const seqs = new Set<number>()
  for (const id of ids) for (const e of index.get(id) ?? []) if (e.direct) seqs.add(e.seq)
  const events = chain.chain()
  return [...seqs].sort((a, b) => a - b).map((s) => events[s - 1]!)
}

export function roundTitle(chain: EventChain, key: string): string | undefined {
  for (const e of chain.chain()) if (isRoundOp(e.op) && e.op.key === key) return e.op.title
  return undefined
}
