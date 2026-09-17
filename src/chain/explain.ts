import { frontier } from '../kernel/actions'
import { Graph } from '../kernel/graph'
import { sha256Hex } from '../kernel/hash'
import { computeSolid, diffSnapshots } from './diff'
import type { NodeId, Snapshot, Verdict } from '../kernel/types'
import type { ChainOp } from './chain'

/** Judgments and withdrawals carry evidence; structural decisions carry rationale. */
export function groundsLabel(op: ChainOp): string {
  if (op.type === 'version') return 'note'
  if (op.type === 'round') return 'round'
  if (op.type === 'issue') return op.action === 'open' ? 'finding' : 'resolution'
  return op.type === 'verify' || op.type === 'doubt' ? 'evidence' : 'rationale'
}

/**
 * The text an issue event carries, for the places that show an event's
 * grounds: the finding's title (with its claim and severity) on open, the
 * resolution on close. Records keep their text in the record itself, not in
 * an evidence field, so the shells read it from here.
 */
export function issueText(op: ChainOp): string | undefined {
  if (op.type === 'version') return op.note
  if (op.type === 'round') return op.title
  if (op.type !== 'issue') return undefined
  if (op.action === 'open')
    return `${op.title}${op.severity ? ` [${op.severity}]` : ''}${op.node ? ` — on ${op.node}` : ''}`
  return op.resolution ?? `closed as ${op.outcome}, no resolution recorded`
}

/** Justification currently intact — this pending node would heal via Restore. */
export function fingerprintIntact(g: Graph, id: NodeId): boolean {
  const fp = g.node(id).fingerprint
  if (!fp) return false
  if (fp.ownHash !== sha256Hex(g.node(id).content)) return false
  const preds = g.predecessors(id)
  if (preds.length !== Object.keys(fp.preds).length) return false
  return preds.every((p) => fp.preds[p] === sha256Hex(g.node(p).content))
}

/**
 * Narrate one event's consequences with their causes named (DESIGN.md triggers
 * T1/T2/T3, Restore, drop cascade under I3) — including the vacuous cases,
 * because "why did nothing happen" (a leaf grew, no judgment stood above it)
 * is as much a debugging question as "why did this reopen".
 * Pure over snapshots, so it works identically for the sandbox and a replayed
 * live chain.
 */
export function explainEvent(before: Snapshot, after: Snapshot, op: ChainOp): string[] {
  const lines: string[] = []
  if (op.type === 'version') {
    const g = Graph.fromSnapshot(after)
    lines.push(
      `version ${op.name} marked${op.commit ? ` after commit ${op.commit.slice(0, 7)}${op.dirty ? ' with uncommitted changes present' : ''}` : ''} — the root was ${g.solid(g.root) ? 'solid' : 'broken'} at this point; a record, the graph is unchanged`,
    )
    return lines
  }
  if (op.type === 'issue') {
    if (op.action === 'open')
      lines.push(
        `issue ${op.key} opened${op.node ? ` on ${op.node}` : ''}${op.severity ? ` (${op.severity})` : ''}: ${op.title} — a record, not a judgment; the graph is unchanged`,
      )
    else lines.push(`issue ${op.key} closed as ${op.outcome}${op.resolution ? `: ${op.resolution}` : ''} — the graph is unchanged`)
    return lines
  }
  const d = diffSnapshots(before, after)
  const verdictBefore = new Map<NodeId, Verdict>(before.nodes.map((n) => [n.id, n.verdict]))
  const solidBefore = computeSolid(before)
  const solidAfter = computeSolid(after)
  const gAfter = Graph.fromSnapshot(after)

  // Lines say what happened in plain words first; the kernel mechanism that
  // caused it rides at the end in brackets, for readers debugging the kernel.
  const healNote = (id: NodeId): string =>
    gAfter.has(id) && gAfter.verdict(id) === 'pending' && fingerprintIntact(gAfter, id)
      ? '; nothing of its own changed, so it will re-verify automatically once its parts are verified'
      : ''

  // ── the operation itself: what it did to its target, or why it vacuously didn't
  const structuralTarget =
    op.type === 'add' ? op.successor : op.type === 'link' || op.type === 'unlink' ? op.to : null

  switch (op.type) {
    case 'add':
      lines.push(`${op.id} added as a part of ${op.successor} — unverified until judged`)
      break
    case 'link':
      lines.push(`${op.to} now also rests on ${op.from}`)
      break
    case 'unlink':
      lines.push(`${op.to} no longer rests on ${op.from}`)
      break
    case 'mutate': {
      const was = verdictBefore.get(op.id)
      const now = gAfter.verdict(op.id)
      if (now === 'valid') {
        lines.push(
          was === 'pending'
            ? `${op.id} restated back to its verified wording — verified again automatically [Restore]`
            : `${op.id} restated to exactly its verified wording — reopened and verified again in the same step [restated, Restore]`,
        )
      } else if (was === 'pending') {
        lines.push(`${op.id} restated; it was not verified anyway, so nothing to reopen [nothing to reopen]`)
      } else {
        lines.push(`${op.id} restated — its ${was} verdict no longer applies, it needs a fresh judgment${healNote(op.id)} [restated]`)
      }
      break
    }
    case 'verify':
      lines.push(
        op.result === 'valid'
          ? `${op.id} verified valid — its claim and parts are remembered, so it can be verified again automatically if they ever come back unchanged [fingerprint]`
          : `${op.id} verified invalid — recorded as found; nothing is remembered for automatic re-verification`,
      )
      break
    case 'doubt':
      lines.push(
        `judgment on ${op.id} withdrawn — it needs a fresh judgment, and automatic re-verification is off the table for it [Doubt]`,
      )
      break
  }

  // vacuous T1 — the leaf vs non-leaf distinction: structure under an unjudged
  // node is trust-free; under a valid node it fires
  if (structuralTarget !== null) {
    const was = verdictBefore.get(structuralTarget)
    if (was !== 'valid') {
      lines.push(
        `${structuralTarget} unaffected — it was not verified (${was}), so there was nothing to reopen [nothing to reopen]`,
      )
    }
  }

  // ── every other verdict change, attributed
  for (const v of d.verdictChanged) {
    if ((op.type === 'verify' || op.type === 'doubt' || op.type === 'mutate') && v.id === op.id)
      continue // the opener covered the target itself
    if (v.to === 'valid') {
      lines.push(
        `${v.id} verified again automatically — nothing it rests on changed since its last judgment [Restore]`,
      )
      continue
    }
    if (v.id === structuralTarget) {
      lines.push(`${v.id} needs a fresh judgment — its parts changed${healNote(v.id)} [parts changed]`)
      continue
    }
    // T2: a part of v.id went solid→un-solid in this event
    const culprits = gAfter.has(v.id)
      ? gAfter
          .predecessors(v.id)
          .filter((p) => solidBefore.get(p) === true && solidAfter.get(p) !== true)
      : []
    lines.push(
      `${v.id} needs a fresh judgment — ${
        culprits.length > 0 ? `its part ${culprits.join(', ')} is no longer verified` : 'a part below it is no longer verified'
      }${healNote(v.id)} [a part reopened]`,
    )
  }

  // ── solid gained without a verdict change: an already-valid node's last part came solid
  for (const s of d.solidChanged) {
    if (s.to && !d.verdictChanged.some((v) => v.id === s.id)) {
      lines.push(`${s.id} is fully verified now — its last outstanding part came through`)
    }
  }

  if (d.droppedNodes.length > 0) {
    lines.push(`${d.droppedNodes.join(', ')} removed — no longer connected to the target [I3]`)
  }

  if (solidAfter.get(after.root) === true && solidBefore.get(before.root) !== true) {
    lines.push(`★ the target is verified — the root is solid`)
  }

  // ── frontier delta: what became verifiable, what fell off the worklist
  const frontBefore = new Set(frontier(Graph.fromSnapshot(before)))
  const frontAfter = new Set(frontier(gAfter))
  const joined = [...frontAfter].filter((id) => !frontBefore.has(id))
  const left = [...frontBefore].filter((id) => !frontAfter.has(id))
  if (joined.length > 0) lines.push(`ready to verify now: ${joined.join(', ')}`)
  if (left.length > 0) lines.push(`off the worklist: ${left.join(', ')}`)

  return lines
}
