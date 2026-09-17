import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { reverify } from '../epistemic'
import { opNotation } from '../notation'
import { roundTitle } from '../reader'

describe('round records — a change described once', () => {
  it('is inert to the kernel, round-trips through dump and replay, and refuses a duplicate key', () => {
    const c = EventChain.create('root', 'target')
    c.dispatch({ type: 'add', id: 'a', content: 'a', successor: 'root' })
    const before = JSON.stringify(c.current())
    expect(c.dispatch({ type: 'round', key: 'r1', title: 'formatter pass', detail: 'lib.ts reformatted; suite 3 passed' })).toEqual({ ok: true })
    expect(JSON.stringify(c.current())).toBe(before) // the snapshot after a record is the snapshot before it
    expect(opNotation(c.chain().at(-1)!.op)).toBe('Round(r1)')
    expect(c.dispatch({ type: 'round', key: 'r1', title: 'again' })).toEqual({ ok: false, error: 'round "r1" is already recorded' })
    const again = EventChain.replay(c.dump())
    expect(again.length).toBe(c.length)
    expect(roundTitle(again, 'r1')).toBe('formatter pass')
    expect(JSON.stringify(again.current())).toBe(before)
  })

  it('a judgment may cite a recorded round, stored on the event and preserved by replay; an unrecorded round is refused and leaves no event', () => {
    const c = EventChain.create('root', 'target')
    c.dispatch({ type: 'add', id: 'a', content: 'a', successor: 'root' })
    c.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'examined')
    const len = c.length
    expect(reverify(c, 'a', 'one sentence', undefined, 'nope')).toEqual({ ok: false, error: 'round "nope" is not recorded — round_record it first' })
    expect(c.length).toBe(len)
    expect(c.graph.verdict('a')).toBe('valid') // the refused re-anchoring withdrew nothing
    c.dispatch({ type: 'round', key: 'r1', title: 'a change' })
    expect(reverify(c, 'a', 'nothing under a moved', undefined, 'r1')).toEqual({ ok: true })
    const [doubt, verify] = c.chain().slice(-2)
    expect(doubt!.round).toBe('r1')
    expect(verify!.round).toBe('r1')
    expect(EventChain.replay(c.dump()).chain().at(-1)!.round).toBe('r1')
  })
})
