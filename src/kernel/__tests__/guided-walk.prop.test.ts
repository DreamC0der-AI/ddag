import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { enabledActions, type Action } from '../actions'
import { Graph } from '../graph'
import type { NodeId, Op } from '../types'
import { checkInvariants, checkJustifications, justification, type Justification } from './support'

/**
 * Rung 1 of action-space testing: guided walks. Instead of generating blind
 * ops (mostly rejections, shallow states), each step picks uniformly from
 * enabled(G) — every step lands, so walks reach deep, complex states: long
 * verified chains, diamonds with mixed verdicts, half-restored regions,
 * fingerprints surviving drops. The laws are state predicates, so they are
 * asserted at every step with no scenario-specific expectations needed.
 */

interface Step {
  pick: number
  s: number
}

const stepArb = fc.record({ pick: fc.nat({ max: 9999 }), s: fc.nat({ max: 7 }) })

/** Shell policy for turning an Action into a concrete Op. */
function materialize(
  action: Action,
  step: Step,
  counter: number,
  g: Graph,
  verified: Map<NodeId, string>,
): Op {
  switch (action.type) {
    case 'add': {
      // mostly fresh ids; sometimes re-add a previously dropped pool id
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

describe('guided walks over enabled(G)', () => {
  it(
    'every step lands; all laws hold at every state; the walk replays exactly',
    () => {
      fc.assert(
        fc.property(fc.array(stepArb, { maxLength: 100 }), (steps) => {
          const g = new Graph('root', 'the target')
          const initial = g.snapshot()
          const applied: Op[] = []
          const verified = new Map<NodeId, string>() // last verified content per id
          const shadow = new Map<NodeId, Justification>()
          let counter = 0

          for (const step of steps) {
            counter += 1
            const enabled = enabledActions(g)
            expect(enabled.length).toBeGreaterThan(0) // mutate:fresh always exists
            // mild policy weight: uniform menu choice churns structure and rarely
            // builds verified regions, so ~3/8 of steps take a Verify=valid from
            // the frontier when one exists — green regions then get broken by
            // later mutates/unlinks and healed by reverts
            const verifies = enabled.filter((a) => a.type === 'verify' && a.result === 'valid')
            const pool = step.s <= 2 && verifies.length > 0 ? verifies : enabled
            const action = pool[step.pick % pool.length]!
            const op = materialize(action, step, counter, g, verified)

            const r = g.apply(op)
            expect(r.ok, `enabled action ${JSON.stringify(action)} must apply`).toBe(true)
            applied.push(op)

            if (op.type === 'verify' && op.result === 'valid') {
              verified.set(op.id, g.node(op.id).content)
              shadow.set(op.id, justification(g, op.id))
            }

            checkInvariants(g)
            checkJustifications(g, shadow)
          }

          // the guided walk is ordinary history: it must replay exactly
          const replayed = Graph.fromSnapshot(initial)
          for (const op of applied) expect(replayed.apply(op).ok).toBe(true)
          expect(replayed.snapshot()).toEqual(g.snapshot())
        }),
        { numRuns: 60 },
      )
    },
    30000,
  )
})
