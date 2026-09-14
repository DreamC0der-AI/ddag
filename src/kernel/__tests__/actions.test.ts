import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { enabledActions, frontier, type Action } from '../actions'
import { Graph } from '../graph'
import { sha256Hex } from '../hash'
import type { NodeId, Op } from '../types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op =>
  ({ type: 'verify', id, result })

const has = (actions: Action[], a: Action) =>
  actions.some((x) => JSON.stringify(x) === JSON.stringify(a))

describe('enabledActions / frontier — examples', () => {
  it('genesis graph: add under root, mutate fresh, verify root — nothing else', () => {
    const g = new Graph('root', 'target')
    const actions = enabledActions(g)
    expect(actions).toEqual([
      { type: 'add', successor: 'root' },
      { type: 'mutate', id: 'root', contentClass: 'fresh' },
      { type: 'verify', id: 'root', result: 'valid' },
      { type: 'verify', id: 'root', result: 'invalid' },
    ])
    expect(frontier(g)).toEqual(['root'])
  })

  it('link candidates respect I2 (never from root), existing arcs, and cycles', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    g.apply(add('b', 'a'))
    const actions = enabledActions(g)
    expect(has(actions, { type: 'link', from: 'root', to: 'a' })).toBe(false) // I2
    expect(has(actions, { type: 'link', from: 'b', to: 'a' })).toBe(false) // arc exists
    expect(has(actions, { type: 'link', from: 'a', to: 'b' })).toBe(false) // cycle
    expect(has(actions, { type: 'link', from: 'b', to: 'root' })).toBe(true)
    expect(has(actions, { type: 'unlink', from: 'b', to: 'a' })).toBe(true)
    expect(has(actions, { type: 'unlink', from: 'a', to: 'b' })).toBe(false)
  })

  it('mutate:revert appears only after a valid verification; frontier tracks solidity', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    expect(frontier(g)).toEqual(['a']) // root blocked: predecessor a not solid
    expect(has(enabledActions(g), { type: 'mutate', id: 'a', contentClass: 'revert' })).toBe(false)

    g.apply(verify('a'))
    const actions = enabledActions(g)
    expect(has(actions, { type: 'mutate', id: 'a', contentClass: 'revert' })).toBe(true)
    expect(frontier(g)).toEqual(['root']) // a now valid (off frontier), root unblocked
    expect(has(actions, { type: 'verify', id: 'a', result: 'valid' })).toBe(false)
    expect(has(actions, { type: 'doubt', id: 'a' })).toBe(true) // valid ⇒ doubtable
    expect(has(actions, { type: 'doubt', id: 'root' })).toBe(false) // pending ⇒ not
  })
})

// ── duality: action ∈ enabled(G) ⟺ apply succeeds ──────────────────────────

interface Raw {
  k: number
  a: number
  b: number
  s: number
}

const rawArb = fc.record({
  k: fc.nat({ max: 4 }),
  a: fc.nat({ max: 40 }),
  b: fc.nat({ max: 40 }),
  s: fc.nat({ max: 7 }),
})

/** Build a random graph, tracking each node's last verified content. */
function buildRandom(raws: Raw[]): { g: Graph; verified: Map<NodeId, string> } {
  const g = new Graph('root', 'the target')
  const verified = new Map<NodeId, string>()
  let counter = 0
  for (const raw of raws) {
    counter += 1
    const ids = g.ids()
    const pick = (x: number) => ids[x % ids.length]!
    let op: Op
    switch (raw.k) {
      case 0:
        op = {
          type: 'add',
          id: raw.s >= 6 ? `r${raw.a % 5}` : `n${counter}`,
          content: `c${counter}`,
          successor: pick(raw.b),
        }
        break
      case 1:
        op = { type: 'link', from: pick(raw.a), to: pick(raw.b) }
        break
      case 2:
        op = { type: 'unlink', from: pick(raw.a), to: pick(raw.b) }
        break
      case 3:
        op = { type: 'mutate', id: pick(raw.a), content: `m${counter}` }
        break
      default:
        op = { type: 'verify', id: pick(raw.a), result: raw.s % 2 === 0 ? 'valid' : 'invalid' }
    }
    const r = g.apply(op)
    if (r.ok && op.type === 'verify' && op.result === 'valid') {
      verified.set(op.id, g.node(op.id).content)
    }
  }
  return { g, verified }
}

function opFor(action: Action, k: number, verified: Map<NodeId, string>): Op {
  switch (action.type) {
    case 'add':
      return { type: 'add', id: `t${k}`, content: `fresh#${k}`, successor: action.successor }
    case 'mutate':
      return {
        type: 'mutate',
        id: action.id,
        content: action.contentClass === 'revert' ? verified.get(action.id)! : `fresh#${k}`,
      }
    default:
      return action
  }
}

const clone = (g: Graph) => Graph.fromSnapshot(g.snapshot())

describe('duality: enabled(G) ⟺ apply succeeds', () => {
  it('every enabled action applies; every non-enabled link/unlink/verify rejects', () => {
    fc.assert(
      fc.property(fc.array(rawArb, { maxLength: 25 }), (raws) => {
        const { g, verified } = buildRandom(raws)
        const enabled = enabledActions(g)

        // soundness: each enabled action, materialized, applies successfully —
        // with the mutate fork behaving as its content class promises
        let k = 0
        for (const action of enabled) {
          const c = clone(g)
          const r = c.apply(opFor(action, ++k, verified))
          expect(r.ok, `${JSON.stringify(action)} should apply`).toBe(true)
          if (action.type === 'doubt') {
            expect(c.verdict(action.id)).toBe('pending')
            expect(c.node(action.id).fingerprint).toBeNull()
          }
          if (action.type === 'mutate') {
            const predsSolid = c.predecessors(action.id).every((p) => c.solid(p))
            if (action.contentClass === 'fresh') {
              expect(c.verdict(action.id)).toBe('pending')
            } else {
              // revert re-supplies the verified CONTENT, but Restore also
              // requires the recorded predecessor set (ids + contents) to
              // match — a structural change since verification blocks it
              const fp = c.node(action.id).fingerprint!
              const preds = c.predecessors(action.id)
              const fpPredsMatch =
                Object.keys(fp.preds).length === preds.length &&
                preds.every((p) => fp.preds[p] === sha256Hex(c.node(p).content))
              expect(c.verdict(action.id)).toBe(fpPredsMatch && predsSolid ? 'valid' : 'pending')
            }
          }
        }

        // completeness: over the full candidate universe of link/unlink/verify,
        // membership in enabled(G) exactly predicts acceptance
        const keys = new Set(
          enabled.map((a) =>
            a.type === 'link' || a.type === 'unlink'
              ? `${a.type}|${a.from}|${a.to}`
              : a.type === 'verify'
                ? `verify|${a.id}|${a.result}`
                : a.type === 'doubt'
                  ? `doubt|${a.id}`
                  : '',
          ),
        )
        const ids = g.ids()
        for (const from of ids) {
          for (const to of ids) {
            expect(clone(g).apply({ type: 'link', from, to }).ok).toBe(keys.has(`link|${from}|${to}`))
            expect(clone(g).apply({ type: 'unlink', from, to }).ok).toBe(
              keys.has(`unlink|${from}|${to}`),
            )
          }
        }
        for (const id of ids) {
          for (const result of ['valid', 'invalid'] as const) {
            expect(clone(g).apply({ type: 'verify', id, result }).ok).toBe(
              keys.has(`verify|${id}|${result}`),
            )
          }
          expect(clone(g).apply({ type: 'doubt', id }).ok).toBe(keys.has(`doubt|${id}`))
        }
      }),
      { numRuns: 40 },
    )
  })
})
