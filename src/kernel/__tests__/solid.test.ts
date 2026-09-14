import { describe, expect, it } from 'vitest'
import { Graph } from '../graph'
import type { Op } from '../types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op =>
  ({ type: 'verify', id, result })

const mustApply = (g: Graph, op: Op) => {
  const r = g.apply(op)
  if (!r.ok) throw new Error(`op ${op.type} rejected: ${r.error}`)
}

describe('solid', () => {
  it('a leaf is solid iff its verdict is valid', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    expect(g.solid('a')).toBe(false)
    mustApply(g, verify('a'))
    expect(g.solid('a')).toBe(true)
    mustApply(g, { type: 'mutate', id: 'a', content: 'changed' })
    expect(g.solid('a')).toBe(false)
    mustApply(g, verify('a', 'invalid'))
    expect(g.solid('a')).toBe(false)
  })

  it('root follows the same rule: valid verdict + all predecessors solid', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('a', 'root'))
    mustApply(g, add('b', 'root'))
    mustApply(g, verify('a'))
    expect(g.apply(verify('root')).ok).toBe(false) // b not solid yet
    mustApply(g, verify('b'))
    mustApply(g, verify('root'))
    expect(g.solid('root')).toBe(true)
  })

  it('a bare root with valid verdict is solid (no predecessors)', () => {
    const g = new Graph('root', 'target')
    mustApply(g, verify('root'))
    expect(g.solid('root')).toBe(true)
  })

  it('a leaf mutation ripples false-ness all the way to root', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('mid', 'root'))
    mustApply(g, add('leaf1', 'mid'))
    mustApply(g, add('leaf2', 'mid'))
    for (const id of ['leaf1', 'leaf2', 'mid', 'root']) mustApply(g, verify(id))
    expect(g.solid('root')).toBe(true)

    mustApply(g, { type: 'mutate', id: 'leaf1', content: 'changed' })
    expect(g.solid('leaf1')).toBe(false)
    expect(g.solid('mid')).toBe(false)
    expect(g.solid('root')).toBe(false)
    expect(g.solid('leaf2')).toBe(true) // sibling untouched
  })

  it('solidity is rebuilt bottom-up, one verify per changed node', () => {
    const g = new Graph('root', 'target')
    mustApply(g, add('mid', 'root'))
    mustApply(g, add('leaf', 'mid'))
    expect(g.apply(verify('mid')).ok).toBe(false) // blocked: leaf not solid
    mustApply(g, verify('leaf'))
    mustApply(g, verify('mid'))
    mustApply(g, verify('root'))
    expect(g.solid('root')).toBe(true)
  })
})
