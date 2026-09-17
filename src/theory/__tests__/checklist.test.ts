import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { checkReachability } from '../checklist'
import { enabledActions, type Action } from '../../kernel/actions'
import { Graph } from '../../kernel/graph'
import { sha256Hex } from '../../kernel/hash'
import type { NodeId, Op, Snapshot } from '../../kernel/types'
import { slow } from './slow'

const h = sha256Hex

/** Minimal well-formed snapshot builder for targeted violations. */
function snap(partial: {
  nodes: Array<Partial<Snapshot['nodes'][number]> & { id: string }>
  arcs?: Snapshot['arcs']
  root?: string
}): Snapshot {
  return {
    root: partial.root ?? 'root',
    nodes: partial.nodes.map((n) => ({
      content: `content of ${n.id}`,
      version: 0,
      verdict: 'pending',
      fingerprint: null,
      ...n,
    })) as Snapshot['nodes'],
    arcs: partial.arcs ?? [],
  }
}

describe('checkReachability — targeted violations (each condition has teeth)', () => {
  it('genesis passes', () => {
    expect(checkReachability(new Graph('root', 'the target').snapshot())).toEqual([])
  })

  it('I1: a cycle is flagged', () => {
    const s = snap({
      nodes: [{ id: 'root' }, { id: 'a' }, { id: 'b' }],
      arcs: [
        { from: 'a', to: 'root' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    })
    expect(checkReachability(s).join('\n')).toContain('I1')
  })

  it('I2: an out-arc on the root is flagged', () => {
    const s = snap({
      nodes: [{ id: 'root' }, { id: 'a' }],
      arcs: [
        { from: 'a', to: 'root' },
        { from: 'root', to: 'a' },
      ],
    })
    expect(checkReachability(s).join('\n')).toContain('I2')
  })

  it('I3: a node with no path to root is flagged', () => {
    const s = snap({ nodes: [{ id: 'root' }, { id: 'a' }] })
    expect(checkReachability(s).join('\n')).toContain('I3')
  })

  it('R2: valid without a fingerprint is flagged', () => {
    const s = snap({
      nodes: [{ id: 'root' }, { id: 'a', verdict: 'valid' }],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(s).join('\n')).toContain('valid without a fingerprint')
  })

  it('R2: valid with a content-stale fingerprint is flagged', () => {
    const s = snap({
      nodes: [
        { id: 'root' },
        {
          id: 'a',
          verdict: 'valid',
          version: 1,
          fingerprint: { ownHash: h('something else'), preds: {} },
        },
      ],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(s).join('\n')).toContain('does not match its content')
  })

  it('R2: valid with a parts-stale fingerprint is flagged', () => {
    const s = snap({
      nodes: [
        { id: 'root' },
        { id: 'b' },
        {
          id: 'a',
          verdict: 'valid',
          fingerprint: { ownHash: h('content of a'), preds: {} }, // b missing from record
        },
      ],
      arcs: [
        { from: 'a', to: 'root' },
        { from: 'b', to: 'a' },
      ],
    })
    expect(checkReachability(s).join('\n')).toContain('does not match its parts')
  })

  it('R2: valid over a non-solid part is flagged', () => {
    const s = snap({
      nodes: [
        { id: 'root' },
        { id: 'b' }, // pending — not solid
        {
          id: 'a',
          verdict: 'valid',
          fingerprint: { ownHash: h('content of a'), preds: { b: h('content of b') } },
        },
      ],
      arcs: [
        { from: 'a', to: 'root' },
        { from: 'b', to: 'a' },
      ],
    })
    expect(checkReachability(s).join('\n')).toContain('is not solid')
  })

  it('R4: pending with a matching fingerprint over solid parts is flagged (Restore is eager)', () => {
    const s = snap({
      nodes: [
        { id: 'root' },
        { id: 'a', verdict: 'pending', fingerprint: { ownHash: h('content of a'), preds: {} } },
      ],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(s).join('\n')).toContain('R4')
  })

  it('R4 spares invalid: a matching fingerprint on an invalid node is reachable (verdict with memory)', () => {
    // reachable via: verify valid, add part (T1, fp kept), verify part,
    // verify invalid, unlink part — the drop re-matches the fingerprint while
    // Restore's pending-only guard leaves invalid untouched
    const s = snap({
      nodes: [
        { id: 'root' },
        { id: 'a', verdict: 'invalid', fingerprint: { ownHash: h('content of a'), preds: {} } },
      ],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(s)).toEqual([])
  })

  it('R5: a fingerprint recording the root or itself as a part is flagged', () => {
    const rootAsPart = snap({
      nodes: [
        { id: 'root' },
        {
          id: 'a',
          fingerprint: { ownHash: h('older'), preds: { root: h('content of root') } },
          version: 1,
        },
      ],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(rootAsPart).join('\n')).toContain('R5')
    const selfAsPart = snap({
      nodes: [
        { id: 'root' },
        { id: 'a', fingerprint: { ownHash: h('older'), preds: { a: h('older') } }, version: 1 },
      ],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(selfAsPart).join('\n')).toContain('R5')
  })

  it('R3: a stale fingerprint at version 0 is flagged', () => {
    const s = snap({
      nodes: [
        { id: 'root' },
        { id: 'a', fingerprint: { ownHash: h('older content'), preds: {} } }, // version 0
      ],
      arcs: [{ from: 'a', to: 'root' }],
    })
    expect(checkReachability(s).join('\n')).toContain('R3')
  })

  it('a legitimately doubted/broken state still passes (pending needs nothing)', () => {
    const g = new Graph('root', 'the target')
    const must = (op: Op) => expect(g.apply(op).ok).toBe(true)
    must({ type: 'add', id: 'a', content: 'A', successor: 'root' })
    must({ type: 'verify', id: 'a', result: 'valid' })
    must({ type: 'verify', id: 'root', result: 'valid' })
    must({ type: 'mutate', id: 'a', content: 'A2' }) // root pending, fp kept (stale parts)
    expect(checkReachability(g.snapshot())).toEqual([])
  })
})

describe('checkReachability — the fwd theorem as a property', () => {
  interface Step {
    pick: number
    s: number
  }
  const stepArb = fc.record({ pick: fc.nat({ max: 9999 }), s: fc.nat({ max: 7 }) })

  function materialize(action: Action, step: Step, counter: number, g: Graph, verified: Map<NodeId, string>): Op {
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

  it('every reachable state passes the checklist (guided walks)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 80 }), (steps) => {
        const g = new Graph('root', 'the target')
        const verified = new Map<NodeId, string>()
        let counter = 0
        for (const step of steps) {
          counter += 1
          const enabled = enabledActions(g)
          const verifies = enabled.filter((a) => a.type === 'verify' && a.result === 'valid')
          const pool = step.s <= 2 && verifies.length > 0 ? verifies : enabled
          const action = pool[step.pick % pool.length]!
          const op = materialize(action, step, counter, g, verified)
          expect(g.apply(op).ok).toBe(true)
          if (op.type === 'verify' && op.result === 'valid') verified.set(op.id, g.node(op.id).content)
          const violations = checkReachability(g.snapshot())
          expect(violations, violations.join('; ')).toEqual([])
        }
      }),
      { numRuns: 50 },
    )
  }, slow(30000))
})
