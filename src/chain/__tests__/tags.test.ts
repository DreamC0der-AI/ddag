import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { opNotation } from '../notation'
import { renderNodeChain } from '../reader'
import { checkpointOf, nextSegment } from '../segments'
import { readTags, strengthOf } from '../tags'

const base = () => {
  const c = EventChain.create('root', 'target')
  c.dispatch({ type: 'add', id: 'a', content: 'a', successor: 'root' })
  c.dispatch({ type: 'add', id: 'b', content: 'b', successor: 'root' })
  c.dispatch({ type: 'add', id: 'x', content: 'x', successor: 'a' })
  c.dispatch({ type: 'verify', id: 'x', result: 'valid' })
  return c
}

describe('arc tags — weight laid over an arc, above the kernel', () => {
  it('is inert to the kernel, round-trips through replay, and the last tag event of an arc is its tags', () => {
    const c = base()
    const before = JSON.stringify(c.current())
    expect(c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: ['strong'] }, undefined, 'root stands or falls with a')).toEqual({ ok: true })
    expect(c.dispatch({ type: 'tag', from: 'b', to: 'root', tags: ['weak', 'advisory'] })).toEqual({ ok: true })
    expect(JSON.stringify(c.current())).toBe(before) // no verdict moved, no claim reopened
    expect(opNotation(c.chain().at(-1)!.op)).toBe('Tag(b->root)=weak,advisory')
    c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: ['weak'] })
    const again = EventChain.replay(c.dump())
    const t = readTags(again)
    expect([...t.keys()].sort()).toEqual(['a->root', 'b->root'])
    expect(strengthOf(t.get('a->root')!.tags)).toBe('weak')
    expect(t.get('b->root')!.tags).toEqual(['weak', 'advisory'])
    expect(readTags(again, c.position - 1).get('a->root')!.tags).toEqual(['strong']) // as it stood before the retag
    c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: [] })
    expect(readTags(c).has('a->root')).toBe(false) // an empty list clears
  })

  it('refuses a missing arc, blank or repeated words, and strong with weak', () => {
    const c = base()
    expect(c.dispatch({ type: 'tag', from: 'x', to: 'root', tags: ['strong'] })).toEqual({ ok: false, error: 'no arc x->root — a tag names an arc the graph has' })
    expect(c.dispatch({ type: 'tag', from: 'ghost', to: 'root', tags: ['strong'] }).ok).toBe(false)
    expect(c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: [' strong'] }).ok).toBe(false)
    expect(c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: ['weak', 'weak'] })).toEqual({ ok: false, error: 'a tag is given twice' })
    expect(c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: ['strong', 'weak'] })).toEqual({ ok: false, error: 'an arc is not both strong and weak' })
    expect(c.length).toBe(4)
  })

  it('dies with its arc: an unlink drops it, a relink starts untagged, and a node dropped by the cascade takes its tags along', () => {
    const c = base()
    c.dispatch({ type: 'link', from: 'x', to: 'b' })
    c.dispatch({ type: 'tag', from: 'x', to: 'b', tags: ['strong'] })
    c.dispatch({ type: 'tag', from: 'x', to: 'a', tags: ['weak'] })
    c.dispatch({ type: 'unlink', from: 'x', to: 'b' })
    expect([...readTags(c).keys()]).toEqual(['x->a'])
    c.dispatch({ type: 'link', from: 'x', to: 'b' })
    expect(readTags(c).has('x->b')).toBe(false)
    c.dispatch({ type: 'unlink', from: 'a', to: 'root' }) // a drops, and x->a with it
    expect(readTags(c).size).toBe(0)
  })

  it('shows on both ends of the arc in their chains', () => {
    const c = base()
    c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: ['strong'] }, undefined, 'root stands or falls with a')
    expect(renderNodeChain(c, 'root').at(-1)).toMatch(/^#5 its part a tagged strong/)
    expect(renderNodeChain(c, 'a').at(-1)).toMatch(/^#5 tagged strong as a part of root/)
  })

  it('survives a roll: the checkpoint carries the tags the sealed events set', () => {
    const c = base()
    c.dispatch({ type: 'tag', from: 'a', to: 'root', tags: ['strong'] })
    const cp = checkpointOf(c, { segment: 1 })
    expect(cp.tags).toEqual([{ from: 'a', to: 'root', tags: ['strong'] }])
    const live = EventChain.replay(JSON.parse(JSON.stringify(nextSegment(c, cp))))
    expect(readTags(live).get('a->root')!.tags).toEqual(['strong'])
    live.dispatch({ type: 'unlink', from: 'a', to: 'root' })
    expect(readTags(live).size).toBe(0)
  })
})
