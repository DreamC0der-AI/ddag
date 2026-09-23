import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { reverify } from '../epistemic'
import { opNotation } from '../notation'
import { nodeChain, roundTitle } from '../reader'
import type { CarryOp, Provenance } from '../chain'

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

  it('a carry moves pins, never verdicts: inert to the kernel, replayed, and refused for an unrecorded round, a node not valid, or nothing to carry', () => {
    const c = EventChain.create('root', 'target')
    c.dispatch({ type: 'add', id: 'a', content: 'a', successor: 'root' })
    c.dispatch({ type: 'add', id: 'b', content: 'b', successor: 'root' })
    const pin: Provenance = { artifacts: [{ path: 'lib.ts', hash: 'h1' }] }
    c.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'examined', pin)
    const carry = (round: string, ids: string[]): CarryOp => ({
      type: 'carry',
      round,
      files: ['lib.ts'],
      pins: ids.map((id) => ({ id, provenance: { artifacts: [{ path: 'lib.ts', hash: 'h2' }] } })),
    })
    expect(c.dispatch(carry('r1', ['a']))).toEqual({ ok: false, error: 'round "r1" is not recorded — round_record it first' })
    c.dispatch({ type: 'round', key: 'r1', title: 'lib changed' })
    expect(c.dispatch(carry('r1', ['b']))).toEqual({ ok: false, error: 'node "b" is pending — only a valid judgment can be carried' })
    expect(c.dispatch({ type: 'carry', round: 'r1', files: ['lib.ts'], pins: [] })).toEqual({ ok: false, error: 'a carry with no judgments carries nothing' })
    const before = JSON.stringify(c.current())
    const len = c.length
    expect(c.dispatch(carry('r1', ['a']))).toEqual({ ok: true })
    expect(c.length).toBe(len + 1)
    expect(JSON.stringify(c.current())).toBe(before) // the snapshot after a carry is the snapshot before it
    expect(opNotation(c.chain().at(-1)!.op)).toBe('Carry(r1)')
    expect(nodeChain(c, 'a').at(-1)).toMatchObject({ direct: true, kind: 'carried', ref: 'r1' })
    const again = EventChain.replay(c.dump())
    expect(again.chain().at(-1)!.op).toEqual(carry('r1', ['a']))
    expect(again.graph.verdict('a')).toBe('valid')
    expect(JSON.stringify(again.current())).toBe(before)
    // a carry naming a node the chain does not have is corrupt at replay, not dropped in silence
    const dump = c.dump()
    dump.events.push({ seq: dump.events.length + 1, prev: dump.events.length, op: carry('r1', ['ghost']) })
    expect(() => EventChain.replay(dump)).toThrow(/rejected: node "ghost" does not exist/)
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
