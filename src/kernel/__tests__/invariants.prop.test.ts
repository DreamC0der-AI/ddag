import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Graph } from '../graph'
import type { Op, Snapshot } from '../types'
import { checkInvariants, checkJustifications, justification, type Justification } from './support'

/** Raw random material, interpreted against the current graph state. */
interface RawOp {
  k: number
  a: number
  b: number
  s: number
}

const rawOpArb = fc.record({
  k: fc.nat({ max: 5 }),
  a: fc.nat({ max: 40 }),
  b: fc.nat({ max: 40 }),
  s: fc.nat({ max: 7 }),
})

/** Deterministically interpret raw material into a concrete Op. */
function interpret(raw: RawOp, g: Graph, counter: number): Op {
  const ids = g.ids()
  const pick = (x: number) => ids[x % ids.length]!
  switch (raw.k) {
    case 0: {
      // sometimes draw the id from a small reusable pool so that dropped ids get
      // re-added — exercising fingerprint soundness under id reuse
      const id = raw.s >= 6 ? `r${raw.a % 5}` : `n${counter}`
      return { type: 'add', id, content: `c${counter}`, successor: pick(raw.b) }
    }
    case 1:
      return { type: 'link', from: pick(raw.a), to: pick(raw.b) }
    case 2:
      return { type: 'unlink', from: pick(raw.a), to: pick(raw.b) }
    case 3:
      return { type: 'mutate', id: pick(raw.a), content: `m${counter}` }
    case 4:
      return { type: 'verify', id: pick(raw.a), result: raw.s % 2 === 0 ? 'valid' : 'invalid' }
    default:
      return { type: 'doubt', id: pick(raw.a) }
  }
}

describe('kernel invariants under random op sequences', () => {
  it('holds all invariants after every op; rejected ops change nothing; replay is exact', () => {
    fc.assert(
      fc.property(fc.array(rawOpArb, { maxLength: 80 }), (raws) => {
        const g = new Graph('root', 'the target')
        const initial: Snapshot = g.snapshot()
        const applied: Op[] = []
        const shadow = new Map<string, Justification>() // last explicitly verified justification
        let counter = 0

        for (const raw of raws) {
          counter += 1
          const op = interpret(raw, g, counter)
          const before = JSON.stringify(g.snapshot())
          const result = g.apply(op)
          if (result.ok) {
            applied.push(op)
            if (op.type === 'verify' && op.result === 'valid') {
              shadow.set(op.id, justification(g, op.id))
            }
          } else {
            expect(JSON.stringify(g.snapshot())).toBe(before) // rejection mutated nothing
          }
          checkInvariants(g)
          checkJustifications(g, shadow)
        }

        // replay fidelity: initial snapshot + applied ops reproduces the graph exactly
        const replayed = Graph.fromSnapshot(initial)
        for (const op of applied) {
          const r = replayed.apply(op)
          expect(r.ok).toBe(true)
        }
        expect(replayed.snapshot()).toEqual(g.snapshot())

        // snapshot round-trip is lossless
        expect(Graph.fromSnapshot(g.snapshot()).snapshot()).toEqual(g.snapshot())
      }),
      { numRuns: 200 },
    )
  })
})
