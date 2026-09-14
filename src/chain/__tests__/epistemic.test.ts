import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { discard, merge, revert, substitute } from '../epistemic'
import type { Op } from '../../kernel/types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op =>
  ({ type: 'verify', id, result })

const mustDispatch = (c: EventChain, op: Op) => {
  const r = c.dispatch(op)
  if (!r.ok) throw new Error(`op ${op.type} rejected: ${r.error}`)
}

describe('Revert (epistemic operation)', () => {
  it('recovers the verified content from the chain and restores the whole chain of ancestors', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, verify('root'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'broken change' })
    expect(c.graph.solid('root')).toBe(false)

    const r = revert(c, 'a')
    expect(r.ok).toBe(true)
    expect(c.graph.node('a').content).toBe('content of a')
    expect(c.graph.verdict('a')).toBe('valid')
    expect(c.graph.solid('root')).toBe(true) // restore cascaded

    // recorded on the chain as its expansion: an ordinary Mutate event
    const last = c.chain()[c.length - 1]!
    expect(last.op).toEqual({ type: 'mutate', id: 'a', content: 'content of a' })
  })

  it('uses the LAST valid verification when a node was verified more than once', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'second text' })
    mustDispatch(c, verify('a'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'third text' })

    expect(revert(c, 'a').ok).toBe(true)
    expect(c.graph.node('a').content).toBe('second text')
    expect(c.graph.verdict('a')).toBe('valid')
  })

  it('rejects a node that was never verified valid, or does not exist', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    expect(revert(c, 'a').ok).toBe(false)
    mustDispatch(c, verify('a', 'invalid'))
    expect(revert(c, 'a').ok).toBe(false)
    expect(revert(c, 'ghost').ok).toBe(false)
  })

  it('rejects a doubted node — the judgment was withdrawn, nothing to revert to', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'changed' })
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'content of a' }) // revert-equivalent: restores
    mustDispatch(c, { type: 'doubt', id: 'a' })
    expect(revert(c, 'a').ok).toBe(false)
  })

  it('rejects a re-added id that has not been re-verified (no fingerprint)', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('keep', 'root'))
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, { type: 'unlink', from: 'a', to: 'root' }) // a drops
    mustDispatch(c, { type: 'add', id: 'a', content: 'new life', successor: 'root' })
    expect(revert(c, 'a').ok).toBe(false) // fresh node, fp = null — old verify must not leak in
  })

  it('marks its atom with the epistemic operation, and the marker survives dump/replay', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'changed' })
    expect(revert(c, 'a').ok).toBe(true)
    expect(c.chain()[c.length - 1]!.via).toBe('Revert(a)')

    const replayed = EventChain.replay(JSON.parse(JSON.stringify(c.dump())))
    expect(replayed.chain()[replayed.length - 1]!.via).toBe('Revert(a)')
    expect(replayed.current()).toEqual(c.current())
  })

  it('recovers from the initial snapshot when the chain starts at a mid-history keyframe', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    // new chain whose initial snapshot is the current state — no verify events on it
    const resumed = EventChain.replay({ initial: c.current(), events: [] })
    mustDispatch(resumed, { type: 'mutate', id: 'a', content: 'drift' })

    expect(revert(resumed, 'a').ok).toBe(true)
    expect(resumed.graph.verdict('a')).toBe('valid')
    expect(resumed.graph.node('a').content).toBe('content of a')
  })
})

describe('Discard (epistemic operation)', () => {
  it('abandons a node and its exclusive subtree in one decision', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('keep', 'root'))
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, add('b', 'a'))
    mustDispatch(c, add('x', 'b'))
    const r = discard(c, 'a')
    expect(r.ok).toBe(true)
    expect(c.graph.ids()).toEqual(['root', 'keep'])
    expect(c.chain()[c.length - 1]!.via).toBe('Discard(a)')
  })

  it('unlinks every out-arc when the node has several successors', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('k', 'root'))
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, { type: 'link', from: 'a', to: 'k' })
    const before = c.length
    expect(discard(c, 'a').ok).toBe(true)
    expect(c.length - before).toBe(2) // two unlink atoms under one decision
    expect(c.graph.has('a')).toBe(false)
    expect(c.graph.has('k')).toBe(true)
  })

  it('refuses the root and unknown nodes', () => {
    const c = EventChain.create('root', 'target')
    expect(discard(c, 'root').ok).toBe(false)
    expect(discard(c, 'ghost').ok).toBe(false)
  })
})

describe('Substitute (epistemic operation)', () => {
  it('swaps a justification: y rests on z instead of x, staying connected throughout', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('y', 'root'))
    mustDispatch(c, add('x', 'y'))
    mustDispatch(c, add('z', 'root'))
    mustDispatch(c, verify('x'))
    mustDispatch(c, verify('y'))
    expect(substitute(c, 'y', 'x', 'z').ok).toBe(true)
    expect(c.graph.predecessors('y')).toEqual(['z'])
    expect(c.graph.has('x')).toBe(false) // exclusive part dropped
    expect(c.graph.verdict('y')).toBe('pending') // swapped justification must be re-judged
    expect(c.chain()[c.length - 1]!.via).toBe('Substitute(y: x->z)')
  })

  it('aborts before the unlink when the link is rejected (cycle)', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('y', 'root'))
    mustDispatch(c, add('x', 'y'))
    mustDispatch(c, add('deep', 'x'))
    // Link(root->y) would close a cycle (y ->+ root), so the swap must abort whole
    const r = substitute(c, 'y', 'x', 'root')
    expect(r.ok).toBe(false)
    expect(c.graph.predecessors('y')).toEqual(['x']) // untouched — no half-swap
  })
})

describe('Merge (epistemic operation)', () => {
  it('c takes over every role of d, then d is discarded', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('p1', 'root'))
    mustDispatch(c, add('p2', 'root'))
    mustDispatch(c, add('d', 'p1'))
    mustDispatch(c, { type: 'link', from: 'd', to: 'p2' })
    mustDispatch(c, add('canon', 'root'))
    expect(merge(c, 'd', 'canon').ok).toBe(true)
    expect(c.graph.has('d')).toBe(false)
    expect(c.graph.predecessors('p1')).toContain('canon')
    expect(c.graph.predecessors('p2')).toContain('canon')
    expect(c.graph.verdict('p1')).toBe('pending') // parents re-audit the sameness belief
    const vias = c.chain().filter((e) => e.via === 'Merge(d->canon)')
    expect(vias.length).toBe(4) // 2 links + 2 unlinks under one decision
  })

  it('skips roles already covered and refuses degenerate merges', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('p', 'root'))
    mustDispatch(c, add('d', 'p'))
    mustDispatch(c, add('canon', 'p'))
    expect(merge(c, 'd', 'd').ok).toBe(false)
    expect(merge(c, 'root', 'canon').ok).toBe(false)
    expect(merge(c, 'd', 'canon').ok).toBe(true) // canon->p already exists: only the unlink happens
    expect(c.graph.predecessors('p')).toEqual(['canon'])
  })
})

describe('epistemic operations × trust machinery (complex cases)', () => {
  it('Discard over a shared subtree: the shared survivor keeps its valid verdict (D2 at composite level)', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('keep', 'root'))
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, add('x', 'a'))
    mustDispatch(c, { type: 'link', from: 'x', to: 'keep' }) // x shared: supports a AND keep
    mustDispatch(c, verify('x'))
    expect(c.graph.solid('x')).toBe(true)

    expect(discard(c, 'a').ok).toBe(true)
    expect(c.graph.has('a')).toBe(false)
    expect(c.graph.has('x')).toBe(true) // survives via keep
    expect(c.graph.verdict('x')).toBe('valid') // lost only a successor — verdict untouched
    expect(c.graph.solid('x')).toBe(true)
  })

  it('substitute-back with identical content: Restore fires inside the composite and cascades to root', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('y', 'root'))
    mustDispatch(c, add('z', 'root')) // z alive independently, so swaps never drop it
    mustDispatch(c, add('x', 'y'))
    mustDispatch(c, verify('x'))
    mustDispatch(c, verify('z'))
    mustDispatch(c, verify('y'))
    mustDispatch(c, verify('root'))
    expect(c.graph.solid('root')).toBe(true) // fp(y) records part x; fp(root) records y,z

    // swap x out for z — y and root reopen, x drops (exclusive)
    expect(substitute(c, 'y', 'x', 'z').ok).toBe(true)
    expect(c.graph.verdict('y')).toBe('pending')
    expect(c.graph.verdict('root')).toBe('pending')
    expect(c.graph.has('x')).toBe(false)

    // re-articulate x with the EXACT verified content, re-verify it, swap back
    mustDispatch(c, { type: 'add', id: 'x', content: 'content of x', successor: 'y' })
    mustDispatch(c, verify('x'))
    mustDispatch(c, { type: 'unlink', from: 'z', to: 'y' }) // completes the swap-back

    // y's justification returned bit-for-bit -> Restore, cascading to root: ZERO re-verifies
    expect(c.graph.verdict('y')).toBe('valid')
    expect(c.graph.verdict('root')).toBe('valid')
    expect(c.graph.solid('root')).toBe(true)
  })

  it('substitute refuses upfront when the arc to swap out does not exist — no half-swap', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('y', 'root'))
    mustDispatch(c, add('z', 'root'))
    const before = c.length
    expect(substitute(c, 'y', 'ghost', 'z').ok).toBe(false)
    expect(substitute(c, 'y', 'z', 'z').ok).toBe(false) // x === z
    expect(c.length).toBe(before) // zero atoms dispatched
    expect(c.graph.predecessors('y')).toEqual([])
  })

  it('merge aborting on a cycle leaves an honest partial record', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('ok', 'root'))
    mustDispatch(c, add('canon', 'root'))
    mustDispatch(c, add('mid', 'canon')) // mid rests on canon, so canon->mid would cycle
    mustDispatch(c, add('d', 'ok'))
    mustDispatch(c, { type: 'link', from: 'd', to: 'mid' })

    const before = c.length
    const r = merge(c, 'd', 'canon')
    expect(r.ok).toBe(false) // link canon->mid rejected: mid ->+ canon
    // honest partial: the first role WAS transferred, nothing rolled back
    expect(c.length - before).toBe(1)
    expect(c.chain()[c.length - 1]!.via).toBe('Merge(d->canon)')
    expect(c.graph.predecessors('ok').sort()).toEqual(['canon', 'd'])
    expect(c.graph.has('d')).toBe(true) // d not discarded — the merge did not complete
    expect(c.rejectionLog().length).toBe(1)

    // the partial history replays exactly, markers included
    const replayed = EventChain.replay(JSON.parse(JSON.stringify(c.dump())))
    expect(replayed.current()).toEqual(c.current())
    expect(replayed.chain().map((e) => e.via)).toEqual(c.chain().map((e) => e.via))
  })
})

describe('Reverify(a) — re-judge a valid claim on today\'s evidence', () => {
  it('records Doubt then Verify under one label and leaves the graph as it began, with a fresh pin', async () => {
    const { reverify } = await import('../epistemic')
    const c = EventChain.create('root', 'the target')
    c.dispatch({ type: 'add', id: 'a', content: 'a holds', successor: 'root' })
    c.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'old run')
    c.dispatch({ type: 'verify', id: 'root', result: 'valid' }, undefined, 'parts hold')
    const before = c.length
    const r = reverify(c, 'a', 'fresh run today', { artifacts: [{ path: 'a.ts', hash: 'h2' }] })
    expect(r.ok).toBe(true)
    const tail = c.chain().slice(before)
    expect(tail.map((e) => [e.op.type, e.via, e.evidence])).toEqual([
      ['doubt', 'Reverify(a)', 'fresh run today'],
      ['verify', 'Reverify(a)', 'fresh run today'],
    ])
    expect(tail[1]!.provenance).toEqual({ artifacts: [{ path: 'a.ts', hash: 'h2' }] })
    expect(c.graph.verdict('a')).toBe('valid')
    expect(c.graph.solid('root')).toBe(true) // reopened at the doubt, restored at the verify
    expect(c.snapshotAt(before + 1).nodes.find((n) => n.id === 'root')!.verdict).toBe('pending')
  })

  it('refuses a claim that is not valid — that is a verify, not a re-verify', async () => {
    const { reverify } = await import('../epistemic')
    const c = EventChain.create('root', 'the target')
    c.dispatch({ type: 'add', id: 'a', content: 'a holds', successor: 'root' })
    expect(reverify(c, 'a', 'x')).toEqual({ ok: false, error: 'node "a" is pending — reverify re-judges a valid claim; use verify' })
    c.dispatch({ type: 'verify', id: 'a', result: 'invalid' })
    expect(reverify(c, 'a', 'x').ok).toBe(false)
    expect(reverify(c, 'ghost', 'x').ok).toBe(false)
    expect(c.length).toBe(2)
  })
})

describe('Refute(a) — withdraw a valid claim shown false', () => {
  it('records Doubt then Verify(invalid) under one label; ancestors reopen and stay reopened', async () => {
    const { refute } = await import('../epistemic')
    const c = EventChain.create('root', 'the target')
    c.dispatch({ type: 'add', id: 'a', content: 'a holds', successor: 'root' })
    c.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'old run')
    c.dispatch({ type: 'verify', id: 'root', result: 'valid' }, undefined, 'parts hold')
    const before = c.length
    const r = refute(c, 'a', 'the finding: a fails on empty input', { artifacts: [{ path: 'a.ts', hash: 'h' }] })
    expect(r.ok).toBe(true)
    expect(c.chain().slice(before).map((e) => [e.op.type, e.via, e.evidence])).toEqual([
      ['doubt', 'Refute(a)', 'the finding: a fails on empty input'],
      ['verify', 'Refute(a)', 'the finding: a fails on empty input'],
    ])
    expect(c.graph.verdict('a')).toBe('invalid')
    expect(c.graph.verdict('root')).toBe('pending')
  })

  it('refuses a claim that is not valid — that is a plain verify', async () => {
    const { refute } = await import('../epistemic')
    const c = EventChain.create('root', 'the target')
    c.dispatch({ type: 'add', id: 'a', content: 'a holds', successor: 'root' })
    expect(refute(c, 'a', 'x')).toEqual({ ok: false, error: 'node "a" is pending — refute withdraws a valid claim; use verify(invalid)' })
    expect(refute(c, 'ghost', 'x').ok).toBe(false)
    expect(c.length).toBe(1)
  })
})
