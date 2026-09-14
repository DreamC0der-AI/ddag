import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { enabledActions } from '../../kernel/actions'
import {
  checkInvariants,
  checkJustifications,
  justification,
  type Justification,
} from '../../kernel/__tests__/support'
import type { NodeId, Op } from '../../kernel/types'
import { EventChain } from '../chain'
import { discard, merge, revert, substitute } from '../epistemic'

/**
 * Random walks over the epistemic operation front: atoms (drawn from
 * enabled(G), which must apply) mixed with revert/discard/substitute/merge
 * (which may reject — their guards and the kernel's are part of what is
 * exercised). After every move all state laws must hold, and at the end the
 * whole chain — via markers included — must replay exactly.
 */

const stepArb = fc.record({
  m: fc.nat({ max: 9 }),
  a: fc.nat({ max: 9999 }),
  b: fc.nat({ max: 9999 }),
  s: fc.nat({ max: 7 }),
})

describe('epistemic walks over the operation front', () => {
  it(
    'laws hold after every move; the chain (with markers) replays exactly',
    () => {
      fc.assert(
        fc.property(fc.array(stepArb, { maxLength: 50 }), (steps) => {
          const chain = EventChain.create('root', 'the target')
          const shadow = new Map<NodeId, Justification>()
          let counter = 0

          for (const step of steps) {
            counter += 1
            const g = chain.graph
            const ids = g.ids()
            const pick = (x: number) => ids[x % ids.length]!

            if (step.m <= 4) {
              // atom drawn from the menu — must apply (duality)
              const enabled = enabledActions(g).filter(
                (x) => !(x.type === 'mutate' && x.contentClass === 'revert'),
              )
              const action = enabled[step.a % enabled.length]!
              let op: Op
              if (action.type === 'add') {
                const rid = `r${step.a % 5}`
                const id = step.s >= 6 && !g.has(rid) ? rid : `g${counter}`
                op = { type: 'add', id, content: `w${counter}`, successor: action.successor }
              } else if (action.type === 'mutate') {
                op = { type: 'mutate', id: action.id, content: `w${counter}` }
              } else {
                op = action
              }
              const r = chain.dispatch(op)
              expect(r.ok, `enabled atom ${JSON.stringify(action)} must apply`).toBe(true)
              if (op.type === 'verify' && op.result === 'valid') {
                shadow.set(op.id, justification(g, op.id))
              }
            } else if (step.m === 5) {
              revert(chain, pick(step.a)) // may reject (no fingerprint) — fine
            } else if (step.m === 6) {
              discard(chain, pick(step.a)) // may reject (root) — fine
            } else if (step.m === 7) {
              const y = pick(step.a)
              const preds = chain.graph.predecessors(y)
              const x = preds.length > 0 ? preds[step.b % preds.length]! : 'ghost'
              substitute(chain, y, x, pick(step.b)) // may reject (cycle, x===z…) — fine
            } else {
              merge(chain, pick(step.a), pick(step.b)) // may reject or be partial — fine
            }

            checkInvariants(chain.graph)
            checkJustifications(chain.graph, shadow)
          }

          // the full history — markers included — replays to the identical graph
          const replayed = EventChain.replay(JSON.parse(JSON.stringify(chain.dump())))
          expect(replayed.current()).toEqual(chain.current())
          expect(replayed.chain().map((e) => e.via)).toEqual(chain.chain().map((e) => e.via))
        }),
        { numRuns: 40 },
      )
    },
    30000,
  )
})
