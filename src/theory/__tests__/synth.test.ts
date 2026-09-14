import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { synthesize } from '../synth'
import { canonicalKey, enumerateUniverse, type Universe } from '../explorer'
import { checkReachability } from '../checklist'
import { enabledActions, type Action } from '../../kernel/actions'
import { Graph } from '../../kernel/graph'
import { sha256Hex } from '../../kernel/hash'
import type { NodeId, Op, Snapshot } from '../../kernel/types'

/** Independent replay: the ops must rebuild the target on a fresh kernel. */
function rebuilt(target: Snapshot, genesisContent: string, ops: Op[]): boolean {
  const g = new Graph(target.root, genesisContent)
  for (const op of ops) {
    if (!g.apply(op).ok) return false
  }
  return canonicalKey(g.snapshot()) === canonicalKey(target)
}

const witnessOf = (contents: Iterable<string>): Map<string, string> => {
  const w = new Map<string, string>()
  for (const c of contents) w.set(sha256Hex(c), c)
  return w
}

describe('synth — the constructive builder', () => {
  it('EXHAUSTIVE: builds every checklist-passing state of the explored universe', () => {
    const U: Universe = { idPool: ['a'], contents: ['R', 'X'], maxVersion: 2 }
    const witness = witnessOf(['R', 'X', '·'])
    const passing = enumerateUniverse(U).filter((s) => checkReachability(s).length === 0)
    expect(passing.length).toBe(2376) // pinned: matches the explorer's exact result
    let built = 0
    for (const target of passing) {
      const r = synthesize(target, witness)
      expect(r.ok, r.ok ? '' : `stuck on ${canonicalKey(target)}: ${r.reason}`).toBe(true)
      if (r.ok) {
        expect(rebuilt(target, r.genesisContent, r.ops), `replay diverged: ${canonicalKey(target)}`).toBe(true)
        built++
      }
    }
    expect(built).toBe(passing.length)
  }, 120000)

  it('the R4 counterexample state is built: invalid with a matching fingerprint', () => {
    const target: Snapshot = {
      root: 'root',
      nodes: [
        {
          id: 'root',
          content: 'R',
          version: 0,
          verdict: 'invalid',
          fingerprint: { ownHash: sha256Hex('R'), preds: {} },
        },
      ],
      arcs: [],
    }
    const r = synthesize(target, witnessOf(['R', '·']))
    expect(r.ok, r.ok ? '' : r.reason).toBe(true)
    if (r.ok) expect(rebuilt(target, r.genesisContent, r.ops)).toBe(true)
  })

  it('builds a three-node record CHAIN — the acyclic shape next to R6\'s forbidden cycle', () => {
    const X = sha256Hex('X')
    const target: Snapshot = {
      root: 'root',
      nodes: [
        { id: 'root', content: 'X', version: 0, verdict: 'pending', fingerprint: null },
        { id: 'a', content: 'X', version: 0, verdict: 'pending', fingerprint: { ownHash: X, preds: { b: X } } },
        { id: 'b', content: 'X', version: 0, verdict: 'pending', fingerprint: { ownHash: X, preds: { c: X } } },
        { id: 'c', content: 'X', version: 0, verdict: 'valid', fingerprint: { ownHash: X, preds: {} } },
      ],
      arcs: [
        { from: 'a', to: 'root' },
        { from: 'b', to: 'root' },
        { from: 'c', to: 'root' },
      ],
    }
    const r = synthesize(target, witnessOf(['X', '·']))
    expect(r.ok, r.ok ? '' : r.reason).toBe(true)
    if (r.ok) expect(rebuilt(target, r.genesisContent, r.ops)).toBe(true)
  })

  it('WALKS: rebuilds snapshots of random histories (stuck only on known v1 gaps)', () => {
    interface Step {
      pick: number
      s: number
    }
    const stepArb = fc.record({ pick: fc.nat({ max: 9999 }), s: fc.nat({ max: 7 }) })
    const materialize = (action: Action, step: Step, counter: number, g: Graph, verified: Map<NodeId, string>): Op => {
      switch (action.type) {
        case 'add': {
          const rid = `r${step.pick % 5}`
          const id = step.s >= 6 && !g.has(rid) ? rid : `g${counter}`
          return { type: 'add', id, content: `w${counter}`, successor: action.successor }
        }
        case 'mutate':
          return {
            type: 'mutate',
            id: action.id,
            content: action.contentClass === 'revert' ? verified.get(action.id)! : `w${counter}`,
          }
        default:
          return action
      }
    }
    let stuckCycles = 0
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const g = new Graph('root', 'the target')
        const contents = new Set<string>(['the target', '·'])
        const verified = new Map<NodeId, string>()
        let counter = 0
        for (const step of steps) {
          counter += 1
          const enabled = enabledActions(g)
          const verifies = enabled.filter((a) => a.type === 'verify' && a.result === 'valid')
          const pool = step.s <= 2 && verifies.length > 0 ? verifies : enabled
          const op = materialize(pool[step.pick % pool.length]!, step, counter, g, verified)
          expect(g.apply(op).ok).toBe(true)
          if (op.type === 'add' || op.type === 'mutate') contents.add(op.content)
          if (op.type === 'verify' && op.result === 'valid') verified.set(op.id, g.node(op.id).content)
        }
        const target = g.snapshot()
        const r = synthesize(target, witnessOf(contents))
        if (!r.ok && r.reason.startsWith('record cycle')) {
          stuckCycles++ // legal states v1 cannot schedule yet — counted, not hidden
          return
        }
        expect(r.ok, r.ok ? '' : `stuck: ${r.reason}\non ${canonicalKey(target)}`).toBe(true)
        if (r.ok) expect(rebuilt(target, r.genesisContent, r.ops)).toBe(true)
      }),
      { numRuns: 120 },
    )
    console.log(`walk targets stuck on record cycles (v1 gap): ${stuckCycles}`)
  }, 60000)
})
