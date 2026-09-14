import { sha256Hex } from '../kernel/hash'
import type { NodeId, Result } from '../kernel/types'
import type { EventChain, Provenance } from './chain'

/**
 * Epistemic operation (DESIGN.md "Epistemic Operations"):
 *
 *   Revert(a)  ≜  Mutate(a, c)   where c = a's content at its last Verify(a) = valid
 *
 * The kernel stores only the hash of the verified content, so the text is
 * recovered from the event chain here and dispatched as an ordinary Mutate —
 * the chain records the expansion, never a new event type. Restore then fires
 * inside the kernel (immediately, or once the predecessors are solid again).
 */
/**
 * Reverify(a): re-judge a valid claim on today's evidence — Doubt then
 * Verify(valid) under one label. For the claim whose evidence aged (the
 * audit says its artifacts changed) while the claim itself still holds.
 * Ancestors reopen at the doubt and restore at the verify within the same
 * call, so the graph ends as it began with a fresh pin on a. A verify that
 * the kernel refuses leaves the doubt on the record: the withdrawal was
 * honest even if the re-judgment could not land.
 */
export function reverify(chain: EventChain, id: NodeId, evidence: string, provenance?: Provenance): Result {
  const g = chain.graph
  if (!g.has(id)) return { ok: false, error: `node "${id}" does not exist` }
  if (g.verdict(id) !== 'valid')
    return { ok: false, error: `node "${id}" is ${g.verdict(id)} — reverify re-judges a valid claim; use verify` }
  const via = `Reverify(${id})`
  const d = chain.dispatch({ type: 'doubt', id }, via, evidence)
  if (!d.ok) return d
  return chain.dispatch({ type: 'verify', id, result: 'valid' }, via, evidence, provenance)
}

/**
 * Refute(a): the mirror of Reverify — a valid claim shown false by a
 * finding is withdrawn and judged invalid in one act, Doubt then
 * Verify(invalid) under one label, the finding as evidence. Ancestors
 * reopen and stay reopened: the tower above a refuted claim is honestly
 * pending until the claim is repaired and re-judged.
 */
export function refute(chain: EventChain, id: NodeId, evidence: string, provenance?: Provenance): Result {
  const g = chain.graph
  if (!g.has(id)) return { ok: false, error: `node "${id}" does not exist` }
  if (g.verdict(id) !== 'valid')
    return { ok: false, error: `node "${id}" is ${g.verdict(id)} — refute withdraws a valid claim; use verify(invalid)` }
  const via = `Refute(${id})`
  const d = chain.dispatch({ type: 'doubt', id }, via, evidence)
  if (!d.ok) return d
  return chain.dispatch({ type: 'verify', id, result: 'invalid' }, via, evidence, provenance)
}

/**
 * Restructure(a): give a topic-shaped claim the property parts it stands
 * for, in one act — each part an Add under a, labelled Restructure(a).
 * The kernel reopens a through T1 as the parts land; a becomes a group
 * resting on its parts. Refuses before touching the chain if a is missing
 * or any part id already exists, so the call is all-or-nothing.
 */
export function restructure(
  chain: EventChain,
  id: NodeId,
  parts: readonly { id: NodeId; content: string; rationale?: string }[],
): Result {
  const g = chain.graph
  if (!g.has(id)) return { ok: false, error: `node "${id}" does not exist` }
  if (parts.length === 0) return { ok: false, error: 'restructure: no parts given' }
  const seen = new Set<NodeId>()
  for (const p of parts) {
    if (g.has(p.id)) return { ok: false, error: `restructure: node "${p.id}" already exists` }
    if (seen.has(p.id)) return { ok: false, error: `restructure: part "${p.id}" given twice` }
    seen.add(p.id)
  }
  const via = `Restructure(${id})`
  for (const p of parts) {
    const r = chain.dispatch({ type: 'add', id: p.id, content: p.content, successor: id }, via, p.rationale)
    if (!r.ok) return r
  }
  return { ok: true }
}

export function revert(chain: EventChain, id: NodeId, evidence?: string): Result {
  const g = chain.graph
  if (!g.has(id)) return { ok: false, error: `node "${id}" does not exist` }
  const fp = g.node(id).fingerprint
  if (fp === null)
    return { ok: false, error: `node "${id}" has never been verified valid — nothing to revert to` }
  const via = `Revert(${id})`

  // The current node's last valid verification is the most recent
  // Verify(id)=valid on the chain (a re-added id is re-verified after re-add).
  const events = chain.chain()
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    if (ev.op.type === 'verify' && ev.op.id === id && ev.op.result === 'valid') {
      const content = chain.snapshotAt(ev.seq).nodes.find((n) => n.id === id)!.content
      return chain.dispatch({ type: 'mutate', id, content }, via, evidence)
    }
  }

  // No verify event on this chain: it may start from a mid-history keyframe.
  // The initial snapshot's content is the verified one iff its hash matches.
  const initial = chain.snapshotAt(0).nodes.find((n) => n.id === id)
  if (initial && sha256Hex(initial.content) === fp.ownHash) {
    return chain.dispatch({ type: 'mutate', id, content: initial.content }, via, evidence)
  }

  return { ok: false, error: `verified content of "${id}" is not recoverable from this chain` }
}

/**
 * Discard(a): "abandon this line of work" — unlink every out-arc of a;
 * a and its exclusive subtree drop by I3. A rejected atom aborts the rest.
 */
export function discard(chain: EventChain, id: NodeId, evidence?: string): Result {
  const g = chain.graph
  if (!g.has(id)) return { ok: false, error: `node "${id}" does not exist` }
  if (id === g.root) return { ok: false, error: 'the root cannot be discarded' }
  const via = `Discard(${id})`
  for (const s of g.successors(id)) {
    const r = chain.dispatch({ type: 'unlink', from: id, to: s }, via, evidence)
    if (!r.ok) return r
  }
  return { ok: true }
}

/**
 * Substitute(y: x→z): "y rests on z instead of x" — link first so y stays
 * connected throughout; a rejected link (e.g. cycle) aborts before the unlink.
 */
export function substitute(chain: EventChain, y: NodeId, x: NodeId, z: NodeId, evidence?: string): Result {
  const g = chain.graph
  if (x === z) return { ok: false, error: 'substitute: x and z are the same node' }
  if (!g.has(x) || !g.successors(x).includes(y))
    return { ok: false, error: `substitute: no arc ${x}->${y} to swap out` }
  const via = `Substitute(${y}: ${x}->${z})`
  const link = chain.dispatch({ type: 'link', from: z, to: y }, via, evidence)
  if (!link.ok) return link
  return chain.dispatch({ type: 'unlink', from: x, to: y }, via, evidence)
}

/**
 * Merge(d→c): "d and c are the same claim" — c takes over every role of d,
 * then d is discarded. Affected parents are T1-reset, so the sameness belief
 * is audited by the verifications that follow. A rejected atom (e.g. a link
 * that would create a cycle) aborts the remainder — the record shows the
 * honest partial execution.
 */
export function merge(chain: EventChain, d: NodeId, c: NodeId, evidence?: string): Result {
  const g = chain.graph
  if (!g.has(d)) return { ok: false, error: `node "${d}" does not exist` }
  if (!g.has(c)) return { ok: false, error: `node "${c}" does not exist` }
  if (d === c) return { ok: false, error: 'cannot merge a node with itself' }
  if (d === g.root) return { ok: false, error: 'the root cannot be merged away' }
  const via = `Merge(${d}->${c})`
  for (const s of g.successors(d)) {
    if (s === c || g.successors(c).includes(s)) continue // role already covered
    const r = chain.dispatch({ type: 'link', from: c, to: s }, via, evidence)
    if (!r.ok) return r
  }
  for (const s of g.successors(d)) {
    const r = chain.dispatch({ type: 'unlink', from: d, to: s }, via, evidence)
    if (!r.ok) return r
  }
  return { ok: true }
}
