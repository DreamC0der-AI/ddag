import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { latestVersion, readVersions, versionLabel, versionsReport } from '../versions'
import { opNotation, opShort } from '../notation'
import { explainEvent } from '../explain'

function scripted(): EventChain {
  const c = EventChain.create('target', 'the target')
  c.dispatch({ type: 'add', id: 'a', content: 'part a', successor: 'target' })
  c.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'checked')
  c.dispatch({ type: 'verify', id: 'target', result: 'valid' }, undefined, 'parts hold')
  c.dispatch({ type: 'version', name: 'v0.1', commit: 'abc1234def', note: 'first working cut' })
  c.dispatch({ type: 'issue', action: 'open', key: 'A-1', title: 'a leaks', node: 'a' })
  c.dispatch({ type: 'doubt', id: 'a' })
  c.dispatch({ type: 'version', name: 'v0.2', commit: '9876543210', dirty: true })
  return c
}

describe('versions — a declaration that a commit concluded a working version', () => {
  it('reads each mark with the state the chain bore out at that moment', () => {
    const vs = readVersions(scripted())
    expect(vs.map((v) => [v.name, v.seq, v.rootSolid, v.openIssues, v.eventsSince])).toEqual([
      ['v0.1', 4, true, 0, 3],
      ['v0.2', 7, false, 1, 0],
    ])
    expect(vs[0]).toMatchObject({ commit: 'abc1234def', note: 'first working cut' })
    expect(versionLabel(vs[0]!)).toBe('v0.1 @abc1234')
    expect(versionLabel(vs[1]!)).toBe('v0.2 @9876543*')
    expect(latestVersion(scripted())?.name).toBe('v0.2')
  })

  it('leaves the graph unchanged, refuses a duplicate name, and round-trips through replay', () => {
    const c = scripted()
    expect(c.snapshotAt(4)).toEqual(c.snapshotAt(3))
    expect(c.dispatch({ type: 'version', name: 'v0.1' })).toEqual({ ok: false, error: 'version "v0.1" is already marked (at event 4)' })
    expect(readVersions(EventChain.replay(c.dump()))).toEqual(readVersions(c))
  })

  it('notates, explains, and reports newest first', () => {
    expect(opNotation({ type: 'version', name: 'v1' })).toBe('Version(v1)')
    expect(opShort({ type: 'version', name: 'v1' })).toBe('⚑v1')
    const c = scripted()
    const snap = c.snapshotAt(3)
    expect(explainEvent(snap, snap, { type: 'version', name: 'v0.1', commit: 'abc1234def' })[0]).toContain(
      'version v0.1 marked after commit abc1234 — the root was solid at this point',
    )
    const report = versionsReport(readVersions(c))
    expect(report.indexOf('v0.2')).toBeLessThan(report.indexOf('v0.1'))
    expect(report).toContain('- v0.1 @abc1234 at event 4: root solid, 0 open issue(s), 3 event(s) since — first working cut')
    expect(report).toContain('marked on a dirty tree')
  })
})
