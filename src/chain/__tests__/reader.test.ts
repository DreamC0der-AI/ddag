import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { reverify } from '../epistemic'
import { firstSentence, nodeChain, nodeIndex, renderEvents, renderNodeChain } from '../reader'

const ok = (c: EventChain, op: Parameters<EventChain['dispatch']>[0], evidence?: string) => {
  const r = c.dispatch(op, undefined, evidence)
  if (!r.ok) throw new Error(r.error)
}
const tower = () => {
  const c = EventChain.create('root', 'the target')
  ok(c, { type: 'add', id: 'mid', content: 'mid', successor: 'root' }, 'mid is needed. More words.')
  ok(c, { type: 'add', id: 'leaf', content: 'leaf', successor: 'mid' })
  ok(c, { type: 'verify', id: 'leaf', result: 'valid' }, 'leaf examined: 3 tests passed. And a long tail nobody needs.')
  ok(c, { type: 'verify', id: 'mid', result: 'valid' }, 'parts hold')
  ok(c, { type: 'verify', id: 'root', result: 'valid' }, 'parts hold')
  return c
}

describe('node chains — the log projected onto a claim (src/chain/reader.ts)', () => {
  it('direct entries name the node; structural events land on both ends', () => {
    const c = tower()
    expect(nodeChain(c, 'leaf').map((e) => `${e.seq}:${e.kind}`)).toEqual(['2:added', '3:judged'])
    expect(nodeChain(c, 'mid').map((e) => `${e.seq}:${e.kind}`)).toEqual(['1:added', '2:gained-part', '4:judged'])
    expect(nodeChain(c, 'mid')[1]).toMatchObject({ direct: true, ref: 'leaf' })
  })

  it('a restatement at the bottom reopens the tower: indirect entries carry the cause; the re-judgment restores it', () => {
    const c = tower()
    ok(c, { type: 'mutate', id: 'leaf', content: 'leaf v2' })
    const mid = nodeChain(c, 'mid').at(-1)!
    expect(mid).toMatchObject({ seq: 6, direct: false, kind: 'reopened', cause: { seq: 6, node: 'leaf', op: 'Mutate(leaf)' } })
    expect(nodeChain(c, 'root').at(-1)).toMatchObject({ kind: 'reopened', cause: { node: 'leaf' } })
    ok(c, { type: 'mutate', id: 'leaf', content: 'leaf' }) // back to the verified wording: Restore cascades
    expect(nodeChain(c, 'leaf').at(-1)).toMatchObject({ kind: 'restated', effect: 'restored' })
    expect(nodeChain(c, 'root').at(-1)).toMatchObject({ seq: 7, kind: 'restored', cause: { op: 'Mutate(leaf)' } })
  })

  it('an unlink that drops a subtree appears as dropped on each dropped node; issues land on their node', () => {
    const c = tower()
    ok(c, { type: 'issue', action: 'open', key: 'I-1', title: 't', node: 'leaf' })
    ok(c, { type: 'issue', action: 'close', key: 'I-1', outcome: 'fixed' })
    expect(nodeChain(c, 'leaf').slice(-2).map((e) => `${e.kind}:${e.ref}`)).toEqual(['issue-opened:I-1', 'issue-closed:I-1'])
    ok(c, { type: 'unlink', from: 'mid', to: 'root' })
    expect(nodeChain(c, 'leaf').at(-1)).toMatchObject({ kind: 'dropped', direct: false, cause: { op: 'Unlink(mid||root)' } })
    expect(nodeChain(c, 'root').at(-1)).toMatchObject({ kind: 'lost-part', ref: 'mid', effect: 'reopened' })
  })

  it('is derived: the index of a replayed dump is the same, and an unchanged chain returns the cached index', () => {
    const c = tower()
    const again = EventChain.replay(c.dump())
    expect(JSON.stringify([...nodeIndex(again)])).toBe(JSON.stringify([...nodeIndex(c)]))
    expect(nodeIndex(c)).toBe(nodeIndex(c))
    const before = nodeIndex(c)
    ok(c, { type: 'doubt', id: 'leaf' })
    expect(nodeIndex(c)).not.toBe(before)
  })

  it('renders first sentences, collapses a run of re-anchorings, and counts the noise of re-anchorings beneath', () => {
    const c = tower()
    for (const n of [1, 2, 3]) {
      const r = reverify(c, 'leaf', `re-examined round ${n}. Long tail.`)
      if (!r.ok) throw new Error(r.error)
    }
    const leaf = renderNodeChain(c, 'leaf')
    expect(leaf).toEqual([
      '#2 added under mid',
      '#3 judged valid — leaf examined: 3 tests passed.',
      '#7–#11 re-anchored 3 times; the last — re-examined round 3.',
    ])
    const root = renderNodeChain(c, 'root')
    expect(root.at(-1)).toBe('(reopened and restored 6 times by re-anchorings beneath it, last at #11 — no judgment of its own moved)')
    expect(root).toContain('#5 judged valid — parts hold')
    expect(renderNodeChain(c, 'leaf', { full: true })[1]).toContain('And a long tail nobody needs.')
    // the global view shows a Reverify pair as one line
    const lines = renderEvents(c.chain().slice(-2))
    expect(lines).toEqual(['10–11. Reverify(leaf)=valid — re-examined round 3.'])
    expect(firstSentence('vitest lexer.ts: 12 passed')).toBe('vitest lexer.ts: 12 passed')
  })
})
