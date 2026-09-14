import { Graph } from '../kernel/graph'
import { sha256Hex } from '../kernel/hash'
import type { NodeId, Op, Snapshot } from '../kernel/types'
import { checkReachability } from './checklist'
import { canonicalKey } from './explorer'

/**
 * The constructive builder (DESIGN.md "Reachability"): given a checklist-
 * passing WITNESSED snapshot, synthesize an operation sequence from genesis
 * that reaches exactly that state. Success on a state is a constructive proof
 * of its reachability; a stuck report names the obstacle — either a v1
 * scheduling limit or a candidate missing checklist condition (R6 record
 * cycles, R7 version budgets).
 *
 * Strategy:
 * - Root-first: R5 guarantees the root appears in no fingerprint record, so
 *   the root's record moment can always be scheduled first, at genesis, with
 *   only its recorded parts existing.
 * - Hook scaffolding: a temporary node `hook -> root` gives every other node
 *   a survival path (`x -> hook`) that never pollutes anyone's pred set at a
 *   record moment (hooks are out-arcs of the survivors).
 * - Throwaway incarnations: before a node's own record, its id lives as a
 *   disposable incarnation that serves other records at any content, cost-
 *   free — dropping and re-adding resets the version counter, so serving
 *   appearances never touch the target's version budget (the discovery that
 *   refutes the naive R7 candidate). The FINAL incarnation is created at the
 *   node's record moment (or finalization, for fingerprint-less nodes) and
 *   spends at most one mutate: record content to final content — which R3
 *   guarantees the budget covers.
 * - Records run in "recorder before recorded-part" topological order; every
 *   recorded part is temp-verified as a leaf at the recorded content, and the
 *   record's arcs are unlinked immediately after (T1 resets the verdict, the
 *   fingerprint survives — verdicts are re-earned at the end).
 * - Two passes: pass 1 emits mutates on demand and reads each node's final
 *   version off the kernel; the gap to the target version is burned as
 *   same-content mutates right after the final incarnation's creation
 *   (T3-vacuous) in pass 2.
 */
export type SynthResult =
  | { ok: true; genesisContent: string; ops: Op[] }
  | { ok: false; reason: string }

export function synthesize(
  target: Snapshot,
  witness: ReadonlyMap<string, string>,
): SynthResult {
  const pre = checkReachability(target)
  if (pre.length > 0) return { ok: false, reason: `target fails the checklist: ${pre[0]}` }

  const byId = new Map(target.nodes.map((n) => [n.id, n]))
  const finalPreds = new Map<NodeId, NodeId[]>(target.nodes.map((n) => [n.id, []]))
  const finalSuccs = new Map<NodeId, NodeId[]>(target.nodes.map((n) => [n.id, []]))
  for (const a of target.arcs) {
    finalPreds.get(a.to)!.push(a.from)
    finalSuccs.get(a.from)!.push(a.to)
  }

  // every hash a fingerprint mentions needs a content preimage
  const unhash = (h: string): string | null => {
    const c = witness.get(h)
    return c !== undefined && sha256Hex(c) === h ? c : null
  }
  for (const n of target.nodes) {
    if (!n.fingerprint) continue
    for (const h of [n.fingerprint.ownHash, ...Object.values(n.fingerprint.preds)]) {
      if (unhash(h) === null) return { ok: false, reason: `unwitnessed hash ${h.slice(0, 12)}…` }
    }
  }

  // scaffolding: recorded part ids that the target no longer shows
  const scaffolding = new Set<NodeId>()
  for (const n of target.nodes) {
    for (const k of Object.keys(n.fingerprint?.preds ?? {})) {
      if (!byId.has(k)) scaffolding.add(k)
    }
  }
  const mintId = (base: string): NodeId => {
    let id = base
    for (let i = 0; byId.has(id) || scaffolding.has(id); i++) id = `${base}${i}`
    return id
  }
  const HOOK = mintId('~hook')

  // record schedule: recorder before recorded part; a cycle is the R6 shape
  const fpIds = target.nodes.filter((n) => n.fingerprint !== null).map((n) => n.id)
  const nonRootFp = fpIds.filter((id) => id !== target.root)
  const after = new Map<NodeId, NodeId[]>(nonRootFp.map((id) => [id, []]))
  const indeg = new Map<NodeId, number>(nonRootFp.map((id) => [id, 0]))
  for (const m of fpIds) {
    for (const k of Object.keys(byId.get(m)!.fingerprint!.preds)) {
      if (byId.get(k)?.fingerprint && k !== target.root && m !== target.root) {
        after.get(m)!.push(k)
        indeg.set(k, indeg.get(k)! + 1)
      }
    }
  }
  const schedule: NodeId[] = []
  const q = nonRootFp.filter((id) => indeg.get(id) === 0)
  while (q.length > 0) {
    const m = q.shift()!
    schedule.push(m)
    for (const k of after.get(m)!) {
      indeg.set(k, indeg.get(k)! - 1)
      if (indeg.get(k) === 0) q.push(k)
    }
  }
  if (schedule.length !== nonRootFp.length)
    return { ok: false, reason: 'record cycle — mutual stale records (candidate R6), or a v1 scheduling limit' }

  // ---- execution (two passes: burns land only in the second) ----
  const rootFp = byId.get(target.root)!.fingerprint
  const genesisContent = rootFp !== null ? unhash(rootFp.ownHash)! : byId.get(target.root)!.content

  const run = (burns: Map<NodeId, number>): { g: Graph; ops: Op[] } | { fail: string } => {
    const g = new Graph(target.root, genesisContent)
    const ops: Op[] = []
    let failure: string | null = null

    const apply = (op: Op): boolean => {
      if (failure) return false
      const r = g.apply(op)
      if (!r.ok) {
        failure = `${op.type} rejected: ${r.error}`
        return false
      }
      ops.push(op)
      return true
    }
    const setContent = (id: NodeId, c: string) => {
      if (g.node(id).content !== c) apply({ type: 'mutate', id, content: c })
    }
    const tempVerify = (id: NodeId) => {
      if (g.verdict(id) !== 'valid') apply({ type: 'verify', id, result: 'valid' })
    }
    const burn = (id: NodeId) => {
      const n = burns.get(id) ?? 0
      for (let i = 0; i < n; i++) apply({ type: 'mutate', id, content: g.node(id).content })
    }
    /** Swap the throwaway incarnation of `id` for its final one, fresh at v0. */
    const reincarnate = (id: NodeId, content: string) => {
      if (g.has(id)) apply({ type: 'unlink', from: id, to: HOOK }) // the throwaway drops
      apply({ type: 'add', id, content, successor: HOOK })
      burn(id)
    }

    // Phase 0 — the root cannot be re-incarnated, so its judgments happen
    // first, before the hook exists (R5 guarantees nobody needs it solid):
    burn(target.root)
    // 0a. its record, at genesis, with exactly its recorded parts
    if (rootFp !== null) {
      for (const [k, h] of Object.entries(rootFp.preds)) {
        apply({ type: 'add', id: k, content: unhash(h)!, successor: target.root })
        tempVerify(k)
      }
      apply({ type: 'verify', id: target.root, result: 'valid' })
    }
    // 0b. a final invalid verdict — content final first (no mutate may follow)
    const rootNode = byId.get(target.root)!
    if (rootNode.verdict === 'invalid') {
      setContent(target.root, rootNode.content) // T3 de-valids if it changes
      if (g.verdict(target.root) === 'valid') {
        // de-valid WITHOUT touching the fingerprint: a throwaway part
        // T1-resets the judgment, serves the invalid verify solid, and drops
        // on unlink (the mechanism the R4 refutation exposed)
        const sd = mintId('~t1')
        apply({ type: 'add', id: sd, content: '·', successor: target.root })
        tempVerify(sd)
        apply({ type: 'verify', id: target.root, result: 'invalid' })
        apply({ type: 'unlink', from: sd, to: target.root }) // sd drops
      } else {
        apply({ type: 'verify', id: target.root, result: 'invalid' })
      }
    }

    // Phase 1 — the hook, then a throwaway incarnation for every other id
    apply({ type: 'add', id: HOOK, content: '·', successor: target.root })
    for (const k of Object.keys(rootFp?.preds ?? {})) {
      apply({ type: 'link', from: k, to: HOOK })
      apply({ type: 'unlink', from: k, to: target.root })
    }
    for (const n of target.nodes) {
      if (n.id !== target.root && !g.has(n.id))
        apply({ type: 'add', id: n.id, content: '·', successor: HOOK })
    }
    for (const sc of scaffolding) {
      if (!g.has(sc)) apply({ type: 'add', id: sc, content: '·', successor: HOOK })
    }

    // Phase 2 — record moments, recorder before recorded part. Serving
    // nodes are still throwaways (the schedule guarantees their own records
    // lie ahead), so their content changes cost nothing; the recorded node
    // itself is re-incarnated here — this IS its final incarnation.
    for (const m of schedule) {
      const fp = byId.get(m)!.fingerprint!
      reincarnate(m, unhash(fp.ownHash)!)
      for (const [k, h] of Object.entries(fp.preds)) {
        setContent(k, unhash(h)!) // a content change T3-resets k; re-verified below
        apply({ type: 'link', from: k, to: m })
        tempVerify(k)
      }
      apply({ type: 'verify', id: m, result: 'valid' })
      for (const k of Object.keys(fp.preds)) apply({ type: 'unlink', from: k, to: m })
    }

    // Phase 3 — invalid verdicts on final incarnations, pred sets still empty
    for (const n of target.nodes) {
      if (n.verdict !== 'invalid' || n.id === target.root || failure) continue
      if (n.fingerprint === null) {
        reincarnate(n.id, n.content) // fresh pending, no judgment to clear
        apply({ type: 'verify', id: n.id, result: 'invalid' })
        continue
      }
      setContent(n.id, n.content) // T3 de-valids if it changes
      if (g.verdict(n.id) === 'valid') {
        const sd = mintId('~t1')
        apply({ type: 'add', id: sd, content: '·', successor: n.id })
        tempVerify(sd)
        apply({ type: 'verify', id: n.id, result: 'invalid' })
        apply({ type: 'unlink', from: sd, to: n.id })
      } else {
        apply({ type: 'verify', id: n.id, result: 'invalid' })
      }
    }

    // Phase 4 — remaining final incarnations and contents
    for (const n of target.nodes) {
      if (n.id === target.root || n.verdict === 'invalid') continue
      if (n.fingerprint === null) reincarnate(n.id, n.content) // never judged; ends pending
      else setContent(n.id, n.content) // ≤ 1 mutate: record content → final (R3 covers it)
    }
    if (rootNode.verdict !== 'invalid') setContent(target.root, rootNode.content)

    // Phase 5 — final arcs; then release the hook (scaffolding drops with it)
    for (const a of target.arcs) apply({ type: 'link', from: a.from, to: a.to })
    for (const n of target.nodes) {
      if (n.id !== target.root) apply({ type: 'unlink', from: n.id, to: HOOK })
    }
    apply({ type: 'unlink', from: HOOK, to: target.root })

    // Phase 6 — valid targets re-earn their verdicts, parts before wholes
    const order: NodeId[] = []
    {
      const d = new Map<NodeId, number>(target.nodes.map((n) => [n.id, finalPreds.get(n.id)!.length]))
      const qq = target.nodes.filter((n) => d.get(n.id) === 0).map((n) => n.id)
      while (qq.length > 0) {
        const x = qq.shift()!
        order.push(x)
        for (const s of finalSuccs.get(x)!) {
          d.set(s, d.get(s)! - 1)
          if (d.get(s) === 0) qq.push(s)
        }
      }
    }
    for (const id of order) {
      if (failure) break
      const n = byId.get(id)!
      if (n.verdict === 'valid' && g.verdict(id) !== 'valid')
        apply({ type: 'verify', id, result: 'valid' }) // same justification ⇒ same fingerprint
    }

    if (failure) return { fail: failure }
    return { g, ops }
  }

  const pass1 = run(new Map())
  if ('fail' in pass1) return { ok: false, reason: pass1.fail }
  const burns = new Map<NodeId, number>()
  for (const n of target.nodes) {
    const spent = pass1.g.has(n.id) ? pass1.g.node(n.id).version : 0
    if (spent > n.version)
      return {
        ok: false,
        reason: `version budget: "${n.id}" spent ${spent} mutates on its final incarnation, target allows ${n.version} (candidate R7, or a scheduling limit)`,
      }
    if (n.version > spent) burns.set(n.id, n.version - spent)
  }
  const pass2 = burns.size > 0 ? run(burns) : pass1
  if ('fail' in pass2) return { ok: false, reason: pass2.fail }

  if (canonicalKey(pass2.g.snapshot()) !== canonicalKey(target))
    return { ok: false, reason: 'construction diverged from the target (planner gap)' }
  return { ok: true, genesisContent, ops: pass2.ops }
}
