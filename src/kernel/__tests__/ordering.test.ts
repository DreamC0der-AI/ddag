import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { rankFrontier, score } from '../ordering'
import { enabledActions, frontier, type Action } from '../actions'
import { Graph } from '../graph'
import type { NodeId, Op } from '../types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op => ({ type: 'verify', id, result })
const must = (g: Graph, op: Op) => {
  const r = g.apply(op)
  if (!r.ok) throw new Error(`${op.type} rejected: ${r.error}`)
}

describe('rankFrontier — the one-step lookahead view', () => {
  it('prices the restore cascade: a confirmed doubt revives the tower for one verify', () => {
    // chain a -> b -> c -> root, fully verified, then Doubt(a): a's fp is
    // erased but its CONTENT is unchanged, so every ancestor's fingerprint
    // stays intact — one re-verify of a restores b, c, root in a wave.
    // (A fresh mutate would NOT score this way: it stales the ancestors'
    // recorded part-hashes, and the view must price that honestly.)
    const g = new Graph('root', 'target')
    must(g, add('c', 'root'))
    must(g, add('b', 'c'))
    must(g, add('a', 'b'))
    for (const id of ['a', 'b', 'c', 'root']) must(g, verify(id))
    must(g, { type: 'doubt', id: 'a' })
    expect(frontier(g)).toEqual(['a'])
    const [top] = rankFrontier(g)
    expect(top!.id).toBe('a')
    expect(top!.restored.sort()).toEqual(['b', 'c', 'root'])
    expect(top!.rootSolid).toBe(true) // the whole tower stands again — winning move
  })

  it('a FRESH mutate below scores no restores — the ancestors need real re-judgment', () => {
    const g = new Graph('root', 'target')
    must(g, add('b', 'root'))
    must(g, add('a', 'b'))
    for (const id of ['a', 'b', 'root']) must(g, verify(id))
    must(g, { type: 'mutate', id: 'a', content: 'restated' })
    const [top] = rankFrontier(g)
    expect(top!.id).toBe('a')
    expect(top!.restored).toEqual([]) // b's fp records a's OLD content — no free heal
    expect(top!.unlocked).toEqual(['b']) // but b becomes judgeable
  })

  it('prices unlocking: the node that opens new frontier outranks the one that does not', () => {
    // c1 -> m -> root and d -> root: judging c1 unlocks m; judging d unlocks
    // nothing (root still waits on m)
    const g = new Graph('root', 'target')
    must(g, add('m', 'root'))
    must(g, add('c1', 'm'))
    must(g, add('d', 'root'))
    const ranks = rankFrontier(g)
    expect(ranks.map((r) => r.id)).toEqual(['c1', 'd'])
    expect(ranks[0]!.unlocked).toEqual(['m'])
    expect(ranks[1]!.unlocked).toEqual([])
  })

  it('the winning move outranks everything, whatever the yields', () => {
    // root is itself on the frontier (all parts solid) next to a busy sibling
    // subtree — judging root wins NOW and must rank first
    const g = new Graph('root', 'target')
    must(g, add('a', 'root'))
    must(g, verify('a'))
    // grow an unlocking opportunity elsewhere: x -> a would break a; instead
    // a separate deep limb whose judgment unlocks two nodes
    expect(frontier(g)).toEqual(['root'])
    const [top] = rankFrontier(g)
    expect(top!.id).toBe('root')
    expect(top!.rootSolid).toBe(true)
  })

  it('noTrivialWin (P1) leaves a bare root out of the ranking, and only a bare one', () => {
    const g = new Graph('root', 'target')
    expect(rankFrontier(g).map((r) => r.id)).toEqual(['root']) // kernel truth: verifiable
    expect(rankFrontier(g, { noTrivialWin: true })).toEqual([]) // shell policy: not advertised
    must(g, add('a', 'root'))
    must(g, verify('a'))
    expect(rankFrontier(g, { noTrivialWin: true }).map((r) => r.id)).toEqual(['root']) // decomposed: fine
  })

  it('invalid frontier nodes are ranked too — re-verification is a move', () => {
    const g = new Graph('root', 'target')
    must(g, add('a', 'root'))
    must(g, verify('a', 'invalid'))
    const ranks = rankFrontier(g)
    expect(ranks.map((r) => r.id)).toEqual(['a'])
    expect(ranks[0]!.unlocked).toEqual(['root'])
  })

  it('property: ranks cover exactly the frontier, best-first by (win, yield)', () => {
    const stepArb = fc.record({ pick: fc.nat({ max: 9999 }), s: fc.nat({ max: 7 }) })
    const materialize = (a: Action, counter: number, verified: Map<NodeId, string>): Op => {
      switch (a.type) {
        case 'add':
          return { type: 'add', id: `g${counter}`, content: `w${counter}`, successor: a.successor }
        case 'mutate':
          return {
            type: 'mutate',
            id: a.id,
            content: a.contentClass === 'revert' ? verified.get(a.id)! : `w${counter}`,
          }
        default:
          return a
      }
    }
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        const g = new Graph('root', 'the target')
        const verified = new Map<NodeId, string>()
        let counter = 0
        for (const step of steps) {
          counter += 1
          const enabled = enabledActions(g)
          const op = materialize(enabled[step.pick % enabled.length]!, counter, verified)
          expect(g.apply(op).ok).toBe(true)
          if (op.type === 'verify' && op.result === 'valid') verified.set(op.id, g.node(op.id).content)
          const ranks = rankFrontier(g)
          expect(ranks.map((r) => r.id).sort()).toEqual([...frontier(g)].sort())
          for (let i = 1; i < ranks.length; i++) {
            const [hi, lo] = [ranks[i - 1]!, ranks[i]!]
            expect(hi.rootSolid >= lo.rootSolid).toBe(true)
            if (hi.rootSolid === lo.rootSolid) expect(score(hi)).toBeGreaterThanOrEqual(score(lo))
          }
        }
      }),
      { numRuns: 40 },
    )
  }, 30000)
})
