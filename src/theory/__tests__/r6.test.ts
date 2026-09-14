import { describe, expect, it } from 'vitest'
import { canonicalKey, exploreKeys, type Universe } from '../explorer'
import { checkReachability } from '../checklist'
import { sha256Hex } from '../../kernel/hash'
import type { Snapshot } from '../../kernel/types'

const h = sha256Hex

/**
 * The R6 verdict: record cycles. Two hand proofs are on trial here, both
 * machine-checked by bounded exhaustive search:
 *
 * (a) A cycle of MISMATCHED records (each node recorded by the next at a
 *     content other than its own record content) is unreachable at any
 *     length: order the final record moments; the earliest-recorded node of
 *     the cycle can only be solid at its recorder's moment via Restore
 *     (another verify would overwrite its final fingerprint), and Restore
 *     pins it to its own record content — contradicting the different
 *     content its recorder needs to see.
 *
 * (b) ANY two-cycle of records is unreachable, matched hashes included:
 *     restoring m1 needs arc m2->m1 (its recorded pred set), while
 *     record(m2) needs arc m1->m2 — coexistence is a cycle, I1 forbids it.
 *
 * The matched two-cycle was BELIEVED reachable during the epistemic-ops
 * design ("arc flipping"); writing the witness for this test refuted that.
 */

const node = (id: string, fp: { own: string; preds: Record<string, string> } | null) => ({
  id,
  content: 'R',
  version: 1,
  verdict: 'pending' as const,
  fingerprint: fp === null ? null : { ownHash: fp.own, preds: fp.preds },
})

const twoCycle = (aRecordsB: string, bRecordsA: string): Snapshot => ({
  root: 'root',
  nodes: [
    { id: 'root', content: 'R', version: 0, verdict: 'pending', fingerprint: null },
    node('a', { own: h('X'), preds: { b: aRecordsB } }),
    node('b', { own: h('X'), preds: { a: bRecordsA } }),
  ],
  arcs: [
    { from: 'a', to: 'root' },
    { from: 'b', to: 'root' },
  ],
})

// S*: mutually MISMATCHED records (each records the other at h(R), while
// each records itself at h(X))
const S_MISMATCH = twoCycle(h('R'), h('R'))
// S°: mutually MATCHED records (each records the other at its record content)
const S_MATCHED = twoCycle(h('X'), h('X'))
// one-way control: a records b (stale), b records nothing back — reachable
const S_ONEWAY: Snapshot = {
  root: 'root',
  nodes: [
    { id: 'root', content: 'R', version: 0, verdict: 'pending', fingerprint: null },
    node('a', { own: h('X'), preds: { b: h('R') } }),
    node('b', null),
  ],
  arcs: [
    { from: 'a', to: 'root' },
    { from: 'b', to: 'root' },
  ],
}

// three-node witnesses live in a SINGLE-content universe (every hash is
// h('X'), version 0 — self-matching fingerprints keep R3 silent), which is
// what makes three free ids exhaustible
const xnode = (id: string, preds: Record<string, string>, verdict: 'pending' | 'valid' = 'pending') => ({
  id,
  content: 'X',
  version: 0,
  verdict,
  fingerprint: { ownHash: h('X'), preds },
})
const X_ROOT = { id: 'root', content: 'X', version: 0, verdict: 'pending' as const, fingerprint: null }
const X_ARCS = [
  { from: 'a', to: 'root' },
  { from: 'b', to: 'root' },
  { from: 'c', to: 'root' },
]
// matched three-cycle: a records b, b records c, c records a
const S3_CYCLE: Snapshot = {
  root: 'root',
  nodes: [X_ROOT, xnode('a', { b: h('X') }), xnode('b', { c: h('X') }), xnode('c', { a: h('X') })],
  arcs: X_ARCS,
}
// acyclic three-chain control: a records b, b records c, c records nothing —
// c's fingerprint fully matches (empty record, no preds), so R4 forces c valid
const S3_CHAIN: Snapshot = {
  root: 'root',
  nodes: [X_ROOT, xnode('a', { b: h('X') }), xnode('b', { c: h('X') }), xnode('c', {}, 'valid')],
  arcs: X_ARCS,
}

describe('R6 — record cycles, machine verdict', () => {
  it('both two-cycle witnesses are flagged by R6 and nothing else; the one-way control passes', () => {
    const mism = checkReachability(S_MISMATCH)
    expect(mism.length).toBeGreaterThan(0)
    expect(mism.every((v) => v.startsWith('R6'))).toBe(true)
    const matched = checkReachability(S_MATCHED)
    expect(matched.length).toBeGreaterThan(0)
    expect(matched.every((v) => v.startsWith('R6'))).toBe(true)
    expect(checkReachability(S_ONEWAY)).toEqual([])
  })

  it('a matched THREE-cycle is flagged; the acyclic three-CHAIN of records is not', () => {
    // the unified theorem: ANY record cycle is unreachable — R2 as an
    // invariant chains "solid ⟹ next solid" around the cycle at the last
    // record's moment, so that verify can never land
    const threeCycle = checkReachability(S3_CYCLE)
    expect(threeCycle.length).toBeGreaterThan(0)
    expect(threeCycle.every((v) => v.startsWith('R6'))).toBe(true)
    expect(checkReachability(S3_CHAIN)).toEqual([])
  })

  it(
    'bounded exhaustion: neither cycle is ever reached; the one-way control is',
    () => {
      // Paths may use a frozen scaffolding id and both genesis contents.
      // The root is INERT — a lossless prune, because both witnesses show it
      // at genesis values and nothing reads the root's fields: it is never a
      // predecessor (I2) and never recorded (R5), so deleting root-judging
      // ops from any history leaves every other op legal.
      const PATH_U: Universe = {
        idPool: ['a', 'b', 'c'],
        contents: ['R', 'X'],
        maxVersion: 2,
        frozenIds: ['c'],
        inertIds: ['root'],
      }
      // fwd checked per state on the fly: everything reached must pass
      // R1-R6 — the machine's check that R6 forbids nothing reachable
      const fwdViolations: string[] = []
      const onState = (s: Parameters<typeof checkReachability>[0]) => {
        const v = checkReachability(s)
        if (v.length > 0 && fwdViolations.length < 5)
          fwdViolations.push(`${v.join('; ')}\n${canonicalKey(s)}`)
      }
      const reached = new Set<string>()
      for (const g of PATH_U.contents) {
        for (const k of exploreKeys(g, PATH_U, onState)) reached.add(k)
      }
      console.log(`r6 path universe reached: ${reached.size}`)
      expect(fwdViolations, fwdViolations.join('\n---\n')).toEqual([])
      expect(reached.has(canonicalKey(S_ONEWAY)), 'one-way control must be reachable').toBe(true)
      expect(reached.has(canonicalKey(S_MISMATCH)), 'mismatched two-cycle must be unreached').toBe(false)
      expect(reached.has(canonicalKey(S_MATCHED)), 'matched two-cycle must be unreached').toBe(false)
    },
    600000,
  )

  it(
    'bounded exhaustion, three free ids: the matched three-cycle is never reached; the three-chain is',
    () => {
      // three free ids and no scaffolding — the fourth id blew the search
      // past exhaustibility; within this bound the cycle stays unreached,
      // and the unified theorem carries the general claim
      const PATH_U: Universe = {
        idPool: ['a', 'b', 'c'],
        contents: ['X'],
        maxVersion: 1,
        inertIds: ['root'],
      }
      const fwdViolations: string[] = []
      const onState = (s: Snapshot) => {
        const v = checkReachability(s)
        if (v.length > 0 && fwdViolations.length < 5)
          fwdViolations.push(`${v.join('; ')}\n${canonicalKey(s)}`)
      }
      const reached = exploreKeys('X', PATH_U, onState)
      console.log(`r6 three-id single-content universe reached: ${reached.size}`)
      expect(fwdViolations, fwdViolations.join('\n---\n')).toEqual([])
      expect(reached.has(canonicalKey(S3_CHAIN)), 'acyclic three-chain must be reachable').toBe(true)
      expect(reached.has(canonicalKey(S3_CYCLE)), 'matched three-cycle must be unreached').toBe(false)
    },
    600000,
  )
})
