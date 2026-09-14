import { describe, expect, it } from 'vitest'
import { Graph } from '../graph'
import type { Op } from '../types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op =>
  ({ type: 'verify', id, result })
const mutate = (id: string): Op => ({ type: 'mutate', id, content: `new content of ${id}` })

const mustApply = (g: Graph, op: Op) => {
  const r = g.apply(op)
  if (!r.ok) throw new Error(`op ${op.type} rejected: ${r.error}`)
}

/** root <- p2 <- p1 <- l, fully verified bottom-up. */
function verifiedChain(): Graph {
  const g = new Graph('root', 'target')
  mustApply(g, add('p2', 'root'))
  mustApply(g, add('p1', 'p2'))
  mustApply(g, add('l', 'p1'))
  for (const id of ['l', 'p1', 'p2', 'root']) mustApply(g, verify(id))
  return g
}

describe('verdict reset triggers', () => {
  it('a new added node pointing at a valid node resets it to pending', () => {
    const g = verifiedChain()
    mustApply(g, add('n', 'p1'))
    expect(g.verdict('p1')).toBe('pending')
  })

  it('a predecessor turning unsolid resets a valid node to pending, rippling to root', () => {
    const g = verifiedChain()
    mustApply(g, mutate('l'))
    expect(g.verdict('l')).toBe('pending')
    expect(g.verdict('p1')).toBe('pending')
    expect(g.verdict('p2')).toBe('pending')
    expect(g.verdict('root')).toBe('pending')
    for (const id of g.ids()) expect(g.solid(id)).toBe(false)
  })

  it('linking a predecessor resets a valid node to pending', () => {
    const g = verifiedChain()
    mustApply(g, add('n', 'root'))
    // p1 gained nothing; link n as new predecessor of p2
    mustApply(g, { type: 'link', from: 'n', to: 'p2' })
    expect(g.verdict('p2')).toBe('pending')
  })

  it('unlinking a predecessor resets a valid node to pending', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    mustApply(g, add('b', 'a'))
    mustApply(g, verify('b'))
    mustApply(g, verify('a'))
    mustApply(g, { type: 'unlink', from: 'b', to: 'a' })
    expect(g.has('b')).toBe(false)
    expect(g.verdict('a')).toBe('pending')
  })

  it('mutate resets the verdict to pending from valid and from invalid', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    mustApply(g, verify('a'))
    expect(g.verdict('a')).toBe('valid')
    mustApply(g, mutate('a'))
    expect(g.verdict('a')).toBe('pending')
    mustApply(g, verify('a', 'invalid'))
    expect(g.verdict('a')).toBe('invalid')
    mustApply(g, mutate('a'))
    expect(g.verdict('a')).toBe('pending')
  })
})

describe('Doubt', () => {
  it('withdraws a judgment: pending, fingerprint cleared, ancestors reopen, parts untouched', () => {
    const g = verifiedChain()
    mustApply(g, { type: 'doubt', id: 'p1' })
    expect(g.verdict('p1')).toBe('pending')
    expect(g.node('p1').fingerprint).toBeNull()
    expect(g.verdict('p2')).toBe('pending') // T2 reopened
    expect(g.verdict('root')).toBe('pending')
    expect(g.verdict('l')).toBe('valid') // doubt does not flow downward
  })

  it('a confirmed doubt costs exactly one re-verification: the tower restores', () => {
    const g = verifiedChain()
    mustApply(g, { type: 'doubt', id: 'l' })
    expect(g.solid('root')).toBe(false)
    mustApply(g, verify('l'))
    expect(g.verdict('p1')).toBe('valid') // restored, no re-verify
    expect(g.verdict('root')).toBe('valid')
    expect(g.solid('root')).toBe(true)
  })

  it('a disconfirmed doubt holds the tower open', () => {
    const g = verifiedChain()
    mustApply(g, { type: 'doubt', id: 'l' })
    mustApply(g, verify('l', 'invalid'))
    expect(g.verdict('p1')).toBe('pending')
    expect(g.solid('root')).toBe(false)
  })

  it('no structural wiggle can resurrect a withdrawn verdict', () => {
    const g = verifiedChain()
    mustApply(g, { type: 'doubt', id: 'p1' })
    mustApply(g, add('n', 'p1'))
    mustApply(g, { type: 'unlink', from: 'n', to: 'p1' }) // pred set returns exactly
    expect(g.verdict('p1')).toBe('pending') // no fingerprint — no resurrection
    expect(g.node('p1').fingerprint).toBeNull()
  })

  it('rejects pending, invalid, and unknown nodes', () => {
    const g = new Graph('root', 'target')
    expect(g.apply({ type: 'doubt', id: 'root' }).ok).toBe(false) // pending
    mustApply(g, add('a', 'root'))
    mustApply(g, verify('a', 'invalid'))
    expect(g.apply({ type: 'doubt', id: 'a' }).ok).toBe(false) // invalid
    expect(g.apply({ type: 'doubt', id: 'ghost' }).ok).toBe(false)
  })
})

describe('Verify preconditions', () => {
  it('rejects verifying an already-valid node', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    mustApply(g, verify('a'))
    expect(g.apply(verify('a')).ok).toBe(false)
  })

  it('rejects verifying a node with an unsolid predecessor', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    expect(g.apply(verify('root')).ok).toBe(false)
    mustApply(g, verify('a'))
    expect(g.apply(verify('root')).ok).toBe(true)
  })

  it('accepts re-verifying an invalid node', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    mustApply(g, verify('a', 'invalid'))
    expect(g.solid('a')).toBe(false)
    mustApply(g, verify('a', 'valid'))
    expect(g.solid('a')).toBe(true)
  })
})

describe('Restore (verification cascade)', () => {
  it('after a leaf mutation, only the direct successor needs re-verification; ancestors restore', () => {
    const g = verifiedChain()
    mustApply(g, mutate('l'))

    mustApply(g, verify('l'))
    // p1 must NOT restore: its justification includes l's content, which changed
    expect(g.verdict('p1')).toBe('pending')
    expect(g.verdict('p2')).toBe('pending')

    mustApply(g, verify('p1'))
    // p2 and root restore automatically: their justifications are unchanged
    expect(g.verdict('p2')).toBe('valid')
    expect(g.verdict('root')).toBe('valid')
    expect(g.solid('root')).toBe(true)
  })

  it('unlink + relink of the same arc restores validity', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    mustApply(g, add('b', 'root'))
    mustApply(g, { type: 'link', from: 'b', to: 'a' })
    for (const id of ['b', 'a', 'root']) mustApply(g, verify(id)) // preds-first order

    expect(g.solid('root')).toBe(true)

    mustApply(g, { type: 'unlink', from: 'b', to: 'a' })
    expect(g.verdict('a')).toBe('pending')
    expect(g.verdict('root')).toBe('pending')

    mustApply(g, { type: 'link', from: 'b', to: 'a' })
    expect(g.verdict('a')).toBe('valid')
    expect(g.verdict('root')).toBe('valid')
    expect(g.solid('root')).toBe(true)
  })

  it('does not restore after the predecessor set changed', () => {
    const g = verifiedChain()
    mustApply(g, add('n', 'p1')) // p1 pending: gained predecessor n
    mustApply(g, verify('n'))
    // p1's fingerprint recorded preds {l}; now preds are {l, n} — no restore
    expect(g.verdict('p1')).toBe('pending')
    mustApply(g, verify('p1'))
    // p2/root justifications unchanged — restore cascades to the top
    expect(g.verdict('p2')).toBe('valid')
    expect(g.verdict('root')).toBe('valid')
  })

  it('a re-added id with different content cannot cause an unsound restore', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('n', 'root'))
    mustApply(g, add('x', 'n'))
    for (const id of ['x', 'n', 'root']) mustApply(g, verify(id))

    mustApply(g, { type: 'unlink', from: 'x', to: 'n' }) // x drops; n, root go pending
    expect(g.has('x')).toBe(false)
    mustApply(g, {
      type: 'add',
      id: 'x',
      content: 'a completely different claim',
      successor: 'n',
    })
    mustApply(g, verify('x'))
    // n's fingerprint recorded the OLD x content — the impostor must not restore n
    expect(g.verdict('n')).toBe('pending')
    mustApply(g, verify('n'))
    // root's justification (n's content) is unchanged — restore cascades
    expect(g.verdict('root')).toBe('valid')
    expect(g.solid('root')).toBe(true)
  })

  it('re-adding the id with the exact verified content IS restorable', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('n', 'root'))
    mustApply(g, add('x', 'n'))
    for (const id of ['x', 'n', 'root']) mustApply(g, verify(id))

    mustApply(g, { type: 'unlink', from: 'x', to: 'n' })
    mustApply(g, { type: 'add', id: 'x', content: 'content of x', successor: 'n' })
    mustApply(g, verify('x'))
    // justification is bit-for-bit what was verified — n and root heal in one wave
    expect(g.verdict('n')).toBe('valid')
    expect(g.verdict('root')).toBe('valid')
    expect(g.solid('root')).toBe(true)
  })

  it('mutating content back to the verified text restores the whole chain', () => {
    const g = verifiedChain()
    mustApply(g, { type: 'mutate', id: 'l', content: 'changed' })
    expect(g.solid('root')).toBe(false)
    mustApply(g, { type: 'mutate', id: 'l', content: 'content of l' }) // exact original
    for (const id of ['l', 'p1', 'p2', 'root']) {
      expect(g.verdict(id)).toBe('valid')
      expect(g.solid(id)).toBe(true)
    }
  })

  it('mutating to identical content is an epistemic no-op (instant self-restore)', () => {
    const g = verifiedChain()
    mustApply(g, { type: 'mutate', id: 'l', content: 'content of l' })
    expect(g.verdict('l')).toBe('valid')
    expect(g.solid('root')).toBe(true) // nothing downstream was disturbed
  })

  it('restorability survives snapshot reload', () => {
    const g = verifiedChain()
    mustApply(g, mutate('l'))
    const g2 = Graph.fromSnapshot(g.snapshot())
    mustApply(g2, verify('l'))
    mustApply(g2, verify('p1'))
    expect(g2.verdict('p2')).toBe('valid')
    expect(g2.verdict('root')).toBe('valid')
    expect(g2.solid('root')).toBe(true)
  })
})
