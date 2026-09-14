import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { issueSummary, issuesReport, nextIssueKey, readIssues } from '../issues'
import { opNotation, opShort } from '../notation'
import { explainEvent } from '../explain'

function scripted(): EventChain {
  const c = EventChain.create('target', 'the target')
  c.dispatch({ type: 'add', id: 'authz', content: 'authz correct', successor: 'target' })
  c.dispatch({ type: 'issue', action: 'open', key: 'AUTHZ-1', title: 'revoke drops recovery', node: 'authz', severity: 'Med', detail: 'full text' })
  c.dispatch({ type: 'issue', action: 'open', key: 'I1', title: 'no dirsync' })
  c.dispatch({ type: 'verify', id: 'authz', result: 'invalid' }, undefined, 'AUTHZ-1')
  c.dispatch({ type: 'issue', action: 'close', key: 'AUTHZ-1', outcome: 'fixed', resolution: 'abort on error' })
  c.dispatch({ type: 'verify', id: 'authz', result: 'valid' }, undefined, 'fixed and tested')
  return c
}

describe('issues — recorded findings with a lifecycle, inert to the kernel', () => {
  it('records, closes, and reads back open-first with detail', () => {
    const issues = readIssues(scripted())
    expect(issues.map((i) => [i.key, i.status, i.node, i.severity])).toEqual([
      ['AUTHZ-1', 'fixed', 'authz', 'Med'],
      ['I1', 'open', undefined, undefined],
    ])
    expect(issues[0]).toMatchObject({ openedAt: 2, closedAt: 5, resolution: 'abort on error', detail: 'full text' })
    expect(issueSummary(issues)).toEqual({ open: 1, closed: 1 })
    expect(nextIssueKey(issues)).toBe('I2')
    const report = issuesReport(issues)
    expect(report.indexOf('- I1 [open]')).toBeLessThan(report.indexOf('- AUTHZ-1 [fixed]'))
    expect(report).not.toContain('full text')
    expect(issuesReport(issues, { detail: true })).toContain('full text')
  })

  it('never changes the graph: the snapshot after an issue event equals the one before', () => {
    const c = scripted()
    expect(c.snapshotAt(2)).toEqual(c.snapshotAt(1))
    expect(c.snapshotAt(5)).toEqual(c.snapshotAt(4))
    expect(c.graph.verdict('authz')).toBe('valid')
  })

  it('refuses a double open, a close of something not open, and an unknown node — as rejections, not events', () => {
    const c = scripted()
    const len = c.length
    expect(c.dispatch({ type: 'issue', action: 'open', key: 'I1', title: 'again' })).toEqual({ ok: false, error: 'issue "I1" is already open' })
    expect(c.dispatch({ type: 'issue', action: 'close', key: 'AUTHZ-1', outcome: 'fixed' })).toEqual({ ok: false, error: 'issue "AUTHZ-1" is not open' })
    expect(c.dispatch({ type: 'issue', action: 'open', key: 'X', title: 'x', node: 'ghost' }).ok).toBe(false)
    expect(c.length).toBe(len)
    expect(c.rejectionLog().length).toBe(3)
  })

  it('round-trips through dump and replay, and notates', () => {
    const c = scripted()
    const again = EventChain.replay(c.dump())
    expect(readIssues(again)).toEqual(readIssues(c))
    expect(again.chain()).toEqual(c.chain())
    expect(opNotation({ type: 'issue', action: 'open', key: 'A-1', title: 't' })).toBe('Issue(A-1)')
    expect(opNotation({ type: 'issue', action: 'close', key: 'A-1', outcome: 'wontfix' })).toBe('Close(A-1)=wontfix')
    expect(opShort({ type: 'issue', action: 'open', key: 'A-1', title: 't' })).toBe('!A-1')
    expect(opShort({ type: 'issue', action: 'close', key: 'A-1', outcome: 'fixed' })).toBe('A-1✓')
    const snap = c.snapshotAt(1)
    expect(explainEvent(snap, snap, { type: 'issue', action: 'open', key: 'A-1', title: 'bad', node: 'authz', severity: 'High' })[0]).toContain(
      'issue A-1 opened on authz (High): bad',
    )
  })
})
