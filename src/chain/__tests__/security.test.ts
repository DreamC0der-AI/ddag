import { describe, expect, it } from 'vitest'
import { EventChain, type ChainDump } from '../chain'

function base(): ChainDump {
  const c = EventChain.create('t', 'the target')
  c.dispatch({ type: 'add', id: 'a', content: 'a', successor: 't' })
  return c.dump()
}

describe('security: records on replay are checked as strictly as live', () => {
  it('sec-records-inert: a close before its open, an open on a missing node, and a duplicate version all make replay throw', () => {
    const closeFirst = base()
    closeFirst.events.push({ seq: 2, prev: 1, op: { type: 'issue', action: 'close', key: 'X-1', outcome: 'fixed' } })
    expect(() => EventChain.replay(closeFirst)).toThrow(/rejected/)
    const ghost = base()
    ghost.events.push({ seq: 2, prev: 1, op: { type: 'issue', action: 'open', key: 'X-1', title: 't', node: 'ghost' } })
    expect(() => EventChain.replay(ghost)).toThrow(/rejected/)
    const twice = base()
    twice.events.push({ seq: 2, prev: 1, op: { type: 'version', name: 'v1' } })
    twice.events.push({ seq: 3, prev: 2, op: { type: 'version', name: 'v1' } })
    expect(() => EventChain.replay(twice)).toThrow(/rejected/)
  })

  it('sec-records-inert: a well-formed record never changes a snapshot', () => {
    const c = EventChain.replay(base())
    const before = c.current()
    c.dispatch({ type: 'issue', action: 'open', key: 'X-1', title: 't', node: 'a', detail: '<script>alert(1)</script>' })
    c.dispatch({ type: 'version', name: 'v1', note: 'n' })
    expect(c.current()).toEqual(before)
  })
})
