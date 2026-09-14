import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { explainEvent } from '../explain'
import type { Op } from '../../kernel/types'

const add = (id: string, successor: string): Op =>
  ({ type: 'add', id, content: `content of ${id}`, successor })
const verify = (id: string, result: 'valid' | 'invalid' = 'valid'): Op =>
  ({ type: 'verify', id, result })

const mustDispatch = (c: EventChain, op: Op) => {
  const r = c.dispatch(op)
  if (!r.ok) throw new Error(`op ${op.type} rejected: ${r.error}`)
}

/** Explanation of the chain's last event, from its own snapshots. */
const lastExplained = (c: EventChain): string[] => {
  const seq = c.length
  const ev = c.chain()[seq - 1]!
  return explainEvent(c.snapshotAt(seq - 1), c.snapshotAt(seq), ev.op)
}

describe('explainEvent', () => {
  it('growth under an unjudged node is called out as vacuous T1 — the leaf vs non-leaf distinction', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('a added as a part of root')
    expect(lines).toContain('root unaffected')
    expect(lines).toContain('[T1 vacuous]')
    expect(lines).toContain('ready to verify now: a')
  })

  it('growth under a VALID node fires T1 and says so', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, verify('root'))
    mustDispatch(c, add('b', 'root'))
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('root needs a fresh judgment — its parts changed')
    expect(lines).not.toContain('[T1 vacuous]')
  })

  it('mutating a verified part names T3 on itself and T2 on the whole above it', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, verify('root'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'fresh claim' })
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('a restated — its valid verdict no longer applies')
    expect(lines).toContain('root needs a fresh judgment — its part a is no longer verified')
    // root's fingerprint recorded a's OLD content hash — a FRESH mutate below
    // means root cannot heal free; only a revert of a would restore it
    expect(lines).not.toContain('re-verify automatically')
  })

  it('reverting content explains the Restore cascade, self-heal included', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, verify('root'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'fresh claim' })
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'content of a' })
    const lines = lastExplained(c).join('\n')
    // a was already pending (the fresh mutate destroyed its judgment), so the
    // revert fires no T3 — it just heals: content back to the verified text
    expect(lines).toContain('a restated back to its verified wording — verified again automatically [Restore]')
    expect(lines).toContain('root verified again automatically')
    expect(lines).toContain('★ the target is verified')
  })

  it('unlink that strands a subtree names the drop cascade (I3)', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, add('b', 'a'))
    mustDispatch(c, { type: 'unlink', from: 'a', to: 'root' })
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('removed — no longer connected to the target [I3]')
    expect(lines).toContain('a')
    expect(lines).toContain('b')
  })

  it('doubt explains the withdrawal and its cost', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a'))
    mustDispatch(c, verify('root'))
    mustDispatch(c, { type: 'doubt', id: 'a' })
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('judgment on a withdrawn')
    expect(lines).toContain('[Doubt]')
    // root kept its fingerprint and a's content is unchanged — one re-verify
    // of a restores root for free, and the log says so
    expect(lines).toContain('root needs a fresh judgment')
    expect(lines).toContain('re-verify automatically once its parts are verified')
  })

  it('verify invalid is recorded honestly with no fingerprint', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, verify('a', 'invalid'))
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('a verified invalid')
    expect(lines).toContain('nothing is remembered')
  })

  it('mutating an already-pending node is vacuous T3', () => {
    const c = EventChain.create('root', 'target')
    mustDispatch(c, add('a', 'root'))
    mustDispatch(c, { type: 'mutate', id: 'a', content: 'v2' })
    const lines = lastExplained(c).join('\n')
    expect(lines).toContain('[T3 vacuous]')
    expect(lines).toContain('nothing to reopen')
  })
})
