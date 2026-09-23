import { describe, expect, it } from 'vitest'
import { EventChain, type ChainDump } from '../chain'
import { checkpointOf, nextSegment } from '../segments'
import { readIssues } from '../issues'
import { readVersions } from '../versions'
import { lastPin } from '../pins'
import { renderNodeChain, roundTitle } from '../reader'
import { reverify, revert } from '../epistemic'

/** A chain with one claim judged, one issue open and one closed, a round and a version: the shape a roll starts from. */
function before(): EventChain {
  const c = EventChain.create('root', 'the target')
  c.dispatch({ type: 'add', id: 'a', content: 'a v1', successor: 'root' }, undefined, 'because a')
  c.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'examined a', { artifacts: [{ path: 'a.ts', hash: 'h1' }] })
  c.dispatch({ type: 'issue', action: 'open', key: 'I1', title: 'open one' })
  c.dispatch({ type: 'issue', action: 'open', key: 'I2', title: 'closed one' })
  c.dispatch({ type: 'issue', action: 'close', key: 'I2', outcome: 'fixed' })
  c.dispatch({ type: 'round', key: 'r1', title: 'first change' })
  c.dispatch({ type: 'version', name: 'v1' })
  return c
}

describe('segments — a chain rolled at a version mark starts again from a checkpoint', () => {
  it('the checkpoint carries the position, memos, issues, versions and rounds; the next segment numbers from it and answers for what came before', () => {
    const c = before()
    const cp = checkpointOf(c, { segment: 1, parent: 'archive/000-v1.json', after: 'v1' })
    expect(cp.seq).toBe(7)
    expect(cp.rounds).toEqual([{ key: 'r1', title: 'first change', seq: 6 }])
    expect(cp.issues.map((i) => [i.key, i.status])).toEqual([
      ['I1', 'open'],
      ['I2', 'fixed'],
    ])
    expect(cp.versions.map((v) => [v.name, v.seq])).toEqual([['v1', 7]])
    expect(cp.nodes['a']).toMatchObject({
      because: 'because a',
      judged: { seq: 2, result: 'valid', content: 'a v1', evidence: 'examined a', provenance: { artifacts: [{ path: 'a.ts', hash: 'h1' }] } },
    })
    const next = EventChain.replay(nextSegment(c, cp))
    expect(next.base).toBe(7)
    expect(next.position).toBe(7)
    expect(next.length).toBe(0)
    expect(next.graph.verdict('a')).toBe('valid')
    expect(next.checkpoint).toEqual(cp)
    // numbering continues from the checkpoint
    expect(next.dispatch({ type: 'add', id: 'b', content: 'b', successor: 'root' })).toEqual({ ok: true })
    expect(next.chain()[0]).toMatchObject({ seq: 8, prev: 7 })
    expect(next.snapshotAt(7).nodes.map((n) => n.id).sort()).toEqual(['a', 'root'])
    expect(() => next.snapshotAt(6)).toThrow(/starts after #7/)
    expect(next.eventAt(8)?.seq).toBe(8)
    expect(next.eventAt(7)).toBeUndefined()
    // what came before is known: rounds, versions, issues
    expect(roundTitle(next, 'r1')).toBe('first change')
    expect(next.dispatch({ type: 'round', key: 'r1', title: 'again' })).toEqual({ ok: false, error: 'round "r1" is already recorded' })
    expect(next.dispatch({ type: 'version', name: 'v1' })).toEqual({ ok: false, error: 'version "v1" is already marked (at event 7)' })
    expect(next.dispatch({ type: 'issue', action: 'open', key: 'I1', title: 'again' })).toMatchObject({ ok: false })
    expect(next.dispatch({ type: 'issue', action: 'close', key: 'I1', outcome: 'fixed' })).toEqual({ ok: true })
    expect(readIssues(next).map((i) => [i.key, i.status])).toEqual([
      ['I1', 'fixed'],
      ['I2', 'fixed'],
    ])
    expect(readVersions(next)[0]).toMatchObject({ name: 'v1', seq: 7, eventsSince: 2 })
    // the pin of a claim judged before the segment, and a re-anchoring that cites a round from before
    expect(lastPin(next, 'a')).toEqual({ provenance: { artifacts: [{ path: 'a.ts', hash: 'h1' }] } })
    expect(reverify(next, 'a', 'still fine', { artifacts: [{ path: 'a.ts', hash: 'h2' }] }, 'r1')).toEqual({ ok: true })
    expect(lastPin(next, 'a')).toEqual({ provenance: { artifacts: [{ path: 'a.ts', hash: 'h2' }] } })
    // the claim's own chain says where the rest is
    expect(renderNodeChain(next, 'a')[0]).toContain('entries up to #7 are in the sealed segment archive/000-v1.json')
    expect(renderNodeChain(next, 'b')[0]).not.toContain('sealed segment')
    // dump and replay keep the checkpoint; a segment whose events do not start after the base is corrupt
    const again = EventChain.replay(next.dump())
    expect(again.base).toBe(7)
    expect(again.position).toBe(next.position)
    expect(again.checkpoint).toEqual(cp)
    const broken: ChainDump = { ...nextSegment(c, cp), events: [{ seq: 1, prev: 0, op: { type: 'add', id: 'x', content: 'x', successor: 'root' } }] }
    expect(() => EventChain.replay(broken)).toThrow(/segment base 7/)
  })

  it('revert on a claim judged before the segment restores the content the checkpoint remembers', () => {
    const c = before()
    const next = EventChain.replay(nextSegment(c, checkpointOf(c, { segment: 1 })))
    expect(next.dispatch({ type: 'mutate', id: 'a', content: 'a v2' })).toEqual({ ok: true })
    expect(next.graph.verdict('a')).toBe('pending')
    expect(revert(next, 'a', 'back to the judged words')).toEqual({ ok: true })
    expect(next.graph.node('a').content).toBe('a v1')
    expect(next.graph.verdict('a')).toBe('valid')
  })

  it('a checkpoint of a segment that itself started from a checkpoint keeps everything from both, carries included', () => {
    const c = before()
    const seg1 = EventChain.replay(nextSegment(c, checkpointOf(c, { segment: 1, after: 'v1' })))
    seg1.dispatch({ type: 'round', key: 'r2', title: 'second change' })
    seg1.dispatch({ type: 'carry', round: 'r2', files: ['a.ts'], pins: [{ id: 'a', provenance: { artifacts: [{ path: 'a.ts', hash: 'h3' }] } }] })
    seg1.dispatch({ type: 'version', name: 'v2' })
    const cp2 = checkpointOf(seg1, { segment: 2, after: 'v2' })
    expect(cp2.seq).toBe(10)
    expect(cp2.rounds.map((r) => r.key)).toEqual(['r1', 'r2'])
    expect(cp2.versions.map((v) => v.name)).toEqual(['v1', 'v2'])
    expect(cp2.issues.map((i) => i.key)).toEqual(['I1', 'I2'])
    expect(cp2.nodes['a']?.judged).toMatchObject({ seq: 2, result: 'valid', provenance: { artifacts: [{ path: 'a.ts', hash: 'h3' }] }, carried: { seq: 9, round: 'r2' } })
    const seg2 = EventChain.replay(nextSegment(seg1, cp2))
    expect(lastPin(seg2, 'a')).toEqual({ provenance: { artifacts: [{ path: 'a.ts', hash: 'h3' }] }, carried: { seq: 9, round: 'r2' } })
  })
})
