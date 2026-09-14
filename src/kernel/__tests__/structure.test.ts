import { describe, expect, it } from 'vitest'
import { Graph } from '../graph'

const add = (id: string, successor: string) =>
  ({ type: 'add', id, content: `content of ${id}`, successor }) as const

describe('root', () => {
  it('creates the root as sole node, pending and not solid', () => {
    const g = new Graph('root', 'the target')
    expect(g.ids()).toEqual(['root'])
    expect(g.verdict('root')).toBe('pending')
    expect(g.solid('root')).toBe(false)
    expect(g.successors('root')).toEqual([])
  })

  it('rejects an empty root id', () => {
    expect(() => new Graph('', 'x')).toThrow()
  })
})

describe('Add', () => {
  it('adds a node with one out-arc to its successor', () => {
    const g = new Graph('root', 'target')
    expect(g.apply(add('a', 'root'))).toEqual({ ok: true })
    expect(g.successors('a')).toEqual(['root'])
    expect(g.predecessors('root')).toEqual(['a'])
    expect(g.verdict('a')).toBe('pending')
  })

  it('rejects duplicate id, empty id, or unknown successor', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    expect(g.apply(add('a', 'root')).ok).toBe(false)
    expect(g.apply(add('', 'root')).ok).toBe(false)
    expect(g.apply(add('b', 'nope')).ok).toBe(false)
    expect(g.ids()).toEqual(['root', 'a'])
  })
})

describe('Link', () => {
  it('adds an arc between existing nodes', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    g.apply(add('b', 'root'))
    expect(g.apply({ type: 'link', from: 'b', to: 'a' })).toEqual({ ok: true })
    expect(g.successors('b')).toEqual(['root', 'a'])
  })

  it('rejects missing nodes, self-link, root as source, duplicate arc, and cycles', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    g.apply(add('b', 'a'))
    expect(g.apply({ type: 'link', from: 'x', to: 'a' }).ok).toBe(false)
    expect(g.apply({ type: 'link', from: 'a', to: 'x' }).ok).toBe(false)
    expect(g.apply({ type: 'link', from: 'a', to: 'a' }).ok).toBe(false)
    expect(g.apply({ type: 'link', from: 'root', to: 'a' }).ok).toBe(false)
    expect(g.apply({ type: 'link', from: 'b', to: 'a' }).ok).toBe(false)
    // b -> a exists, so a -> b would close a cycle
    expect(g.apply({ type: 'link', from: 'a', to: 'b' }).ok).toBe(false)
  })
})

describe('Unlink and the path-to-root survival rule', () => {
  it('rejects unlinking a non-existent arc', () => {
    const g = new Graph('root', 'target')
    expect(g.apply({ type: 'unlink', from: 'a', to: 'root' }).ok).toBe(false)
  })

  it('drops a node that loses its last successor', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    expect(g.apply({ type: 'unlink', from: 'a', to: 'root' })).toEqual({ ok: true })
    expect(g.has('a')).toBe(false)
    expect(g.predecessors('root')).toEqual([])
  })

  it('cascades the drop through predecessors', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    g.apply(add('b', 'a'))
    g.apply(add('c', 'b'))
    g.apply({ type: 'unlink', from: 'a', to: 'root' })
    expect(g.ids()).toEqual(['root'])
  })

  it('drops a split-off component, keeping the root side', () => {
    const g = new Graph('root', 'target')
    g.apply(add('x', 'root'))
    g.apply(add('y', 'x'))
    g.apply(add('keep', 'root'))
    g.apply({ type: 'unlink', from: 'x', to: 'root' })
    expect(g.ids()).toEqual(['root', 'keep'])
  })

  it('keeps a node that still has another path to root (diamond)', () => {
    const g = new Graph('root', 'target')
    g.apply(add('a', 'root'))
    g.apply(add('b', 'root'))
    g.apply(add('c', 'a'))
    g.apply({ type: 'link', from: 'c', to: 'b' })
    g.apply({ type: 'unlink', from: 'c', to: 'a' })
    expect(g.has('c')).toBe(true)
    expect(g.successors('c')).toEqual(['b'])
  })
})
