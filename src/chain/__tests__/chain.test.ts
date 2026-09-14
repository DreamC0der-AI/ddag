import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { diffSnapshots, isEmptyDiff } from '../diff'
import type { Op } from '../../kernel/types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op =>
  ({ type: 'verify', id, result })

const mustDispatch = (c: EventChain, op: Op) => {
  const r = c.dispatch(op)
  if (!r.ok) throw new Error(`op ${op.type} rejected: ${r.error}`)
}

describe('EventChain provenance', () => {
  it('rides on the event as environment data and survives dump/replay', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    const prov = { head: 'abc123', dirty: false, artifacts: [{ path: 'src/a.ts', hash: 'deadbeef' }] }
    expect(c.dispatch(verify('a'), undefined, 'a-suite: green', prov).ok).toBe(true)
    const replayed = EventChain.replay(JSON.parse(JSON.stringify(c.dump())))
    expect(replayed.chain()[1]!.provenance).toEqual(prov)
    expect(replayed.chain()[0]!.provenance).toBeUndefined()
    expect(replayed.graph.snapshot()).toEqual(c.graph.snapshot()) // inert to the kernel
  })
})

describe('EventChain', () => {
  it('appends applied ops as seq-numbered chained events', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    expect(c.chain().map((e) => ({ seq: e.seq, prev: e.prev, type: e.op.type }))).toEqual([
      { seq: 1, prev: 0, type: 'add' },
      { seq: 2, prev: 1, type: 'verify' },
    ])
    expect(c.length).toBe(2)
  })

  it('records rejections separately — they are not events', () => {
    const c = EventChain.create('root', 'target')
    const r = c.dispatch({ type: 'link', from: 'root', to: 'root' })
    expect(r.ok).toBe(false)
    expect(c.length).toBe(0)
    expect(c.rejectionLog()).toHaveLength(1)
    expect(c.rejectionLog()[0]!.error).toMatch(/link/)
  })

  it('snapshotAt(0) is the initial state; snapshotAt(seq) is the state after that event', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, add('b', 'a'))
    expect(c.snapshotAt(0).nodes.map((n) => n.id)).toEqual(['root'])
    expect(c.snapshotAt(1).nodes.map((n) => n.id)).toEqual(['root', 'a'])
    expect(c.snapshotAt(2).nodes.map((n) => n.id)).toEqual(['root', 'a', 'b'])
    expect(c.current()).toEqual(c.snapshotAt(2))
    expect(() => c.snapshotAt(3)).toThrow()
  })

  it('records evidence citations as environment data and preserves them through replay', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    const r = c.dispatch(verify('a'), undefined, 'vitest run: 4 passed')
    expect(r.ok).toBe(true)
    expect(c.chain()[c.length - 1]!.evidence).toBe('vitest run: 4 passed')

    const replayed = EventChain.replay(JSON.parse(JSON.stringify(c.dump())))
    expect(replayed.chain()[replayed.length - 1]!.evidence).toBe('vitest run: 4 passed')
    expect(replayed.current()).toEqual(c.current())
  })

  it('replays a dump into an identical graph', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, add('b', 'a'))
    mustDispatch(c, verify('b'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, { type: 'mutate', id: 'b', content: 'changed' })
    mustDispatch(c, { type: 'unlink', from: 'b', to: 'a' })

    const dump = JSON.parse(JSON.stringify(c.dump())) // through JSON, as persistence would
    const replayed = EventChain.replay(dump)
    expect(replayed.current()).toEqual(c.current())
    expect(replayed.length).toBe(c.length)
  })

  it('rejects a broken chain (gap, wrong prev, or unapplicable event)', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    const dump = c.dump()

    const gap = { ...dump, events: [dump.events[1]!] }
    expect(() => EventChain.replay(gap)).toThrow(/chain broken/)

    const badPrev = { ...dump, events: [dump.events[0]!, { ...dump.events[1]!, prev: 5 }] }
    expect(() => EventChain.replay(badPrev)).toThrow(/chain broken/)

    const badOp = {
      ...dump,
      events: [dump.events[0]!, { seq: 2, prev: 1, op: add('a', 'root') }],
    }
    expect(() => EventChain.replay(badOp)).toThrow(/rejected/)
  })
})

describe('diffSnapshots', () => {
  it('reports added/dropped nodes and arcs', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    const d1 = diffSnapshots(c.snapshotAt(0), c.snapshotAt(1))
    expect(d1.addedNodes).toEqual(['a'])
    expect(d1.addedArcs).toEqual([{ from: 'a', to: 'root' }])

    mustDispatch(c, add('b', 'a'))
    mustDispatch(c, { type: 'unlink', from: 'a', to: 'root' }) // drops a and b
    const d2 = diffSnapshots(c.snapshotAt(2), c.snapshotAt(3))
    expect(d2.droppedNodes.sort()).toEqual(['a', 'b'])
    expect(d2.removedArcs).toHaveLength(2)
  })

  it('reports verdict and solid changes through a mutation cascade', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('mid', 'root'))
    mustDispatch(c, add('leaf', 'mid'))
    for (const id of ['leaf', 'mid', 'root']) mustDispatch(c, verify(id))
    const before = c.current()

    mustDispatch(c, { type: 'mutate', id: 'leaf', content: 'changed' })
    const d = diffSnapshots(before, c.current())
    expect(d.mutatedNodes).toEqual(['leaf'])
    expect(d.verdictChanged.map((v) => v.id).sort()).toEqual(['leaf', 'mid', 'root'])
    expect(d.solidChanged.map((s) => s.id).sort()).toEqual(['leaf', 'mid', 'root'])
    expect(d.solidChanged.every((s) => s.from && !s.to)).toBe(true)
  })

  it('reports a restore cascade as verdict/solid changes back to valid', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('p1', 'root'))
    mustDispatch(c, add('l', 'p1'))
    for (const id of ['l', 'p1', 'root']) mustDispatch(c, verify(id))
    mustDispatch(c, { type: 'mutate', id: 'l', content: 'changed' })
    mustDispatch(c, verify('l'))
    const before = c.current()
    mustDispatch(c, verify('p1'))
    // verifying p1 restores root automatically — the diff shows both flipping
    const d = diffSnapshots(before, c.current())
    expect(d.verdictChanged.map((v) => v.id).sort()).toEqual(['p1', 'root'])
    expect(d.solidChanged.map((s) => s.id).sort()).toEqual(['p1', 'root'])
  })

  it('diff of identical snapshots is empty', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    expect(isEmptyDiff(diffSnapshots(c.current(), c.current()))).toBe(true)
  })
})
