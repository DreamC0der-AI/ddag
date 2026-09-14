import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EventChain, type ChainDump } from '../../chain/chain'
import { lockPathFor, withFileLock } from '../lock'
import { Registry } from '../registry'
import { McpStore } from '../store'

const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-conc-'))
const events = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as ChainDump).events.map((e) => e.op)

describe('two sessions on one chain file', () => {
  it('never lose each other: interleaved operations all survive, in order, and both sides end equal to the file', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const a = new McpStore(file, dir)
    const b = new McpStore(file, dir) // both loaded at genesis
    expect(a.dispatch({ type: 'add', id: 'x', content: 'x', successor: 'target' }).ok).toBe(true)
    const rb = b.dispatch({ type: 'add', id: 'y', content: 'y', successor: 'target' }) // b is behind by one
    expect(rb.ok).toBe(true)
    expect(rb.text).toContain('Caught up: 1 event(s) written by another session')
    const ra = a.dispatch({ type: 'verify', id: 'x', result: 'valid' }, 'checked x') // a is behind by one
    expect(ra.ok).toBe(true)
    expect(ra.text).toContain('Caught up: 1 event(s)')
    expect(events(file).map((o) => o.type + ':' + ('id' in o ? o.id : ''))).toEqual(['add:x', 'add:y', 'verify:x'])
    // both in-memory graphs equal the file's replay
    const truth = EventChain.replay(JSON.parse(readFileSync(file, 'utf8')) as ChainDump).graph.snapshot()
    a.stateReport() // reads catch up too
    b.stateReport()
    expect(a.graph.snapshot()).toEqual(truth)
    expect(b.graph.snapshot()).toEqual(truth)
    expect(a.graph.verdict('x')).toBe('valid')
    expect(b.graph.has('y')).toBe(true)
  })

  it('an operation another session made illegal is rejected against the truth, not applied to stale state', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const a = new McpStore(file, dir)
    a.dispatch({ type: 'add', id: 'n', content: 'n', successor: 'target' })
    const b = new McpStore(file, dir)
    a.dispatch({ type: 'verify', id: 'n', result: 'valid' }, 'a judged it')
    const r = b.dispatch({ type: 'verify', id: 'n', result: 'valid' }, 'b judges it too')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('already valid')
    expect(r.text).toContain('after taking on 1 event(s) another session wrote')
    expect(events(file)).toHaveLength(2) // nothing written for the rejection
  })

  it('a graph_new by one side is taken on by the other as a full reload', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const a = new McpStore(file, dir)
    a.dispatch({ type: 'add', id: 'old', content: 'old', successor: 'target' })
    const b = new McpStore(file, dir)
    a.newGraph('root2', 'a fresh target')
    const r = b.dispatch({ type: 'add', id: 'p', content: 'p', successor: 'root2' })
    expect(r.ok).toBe(true)
    expect(b.graph.root).toBe('root2')
    expect(b.graph.has('old')).toBe(false)
    expect(events(file)).toHaveLength(1)
  })

  it('leaves no lock or temp files behind', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const a = new McpStore(file, dir)
    for (let i = 0; i < 5; i++) a.dispatch({ type: 'add', id: `n${i}`, content: 'c', successor: 'target' })
    a.newGraph('t', 'x')
    expect(readdirSync(dir)).toEqual(['ddag.json'])
  })
})

describe('the file lock', () => {
  it('waits for a live lock and then fails honestly; reclaims a stale one', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const lock = lockPathFor(file)
    writeFileSync(lock, '4242 now') // a live holder
    const t0 = Date.now()
    expect(() => withFileLock(file, () => 1, { timeoutMs: 120 })).toThrow(/locked by another ddag session \(4242 now\)/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100) // it actually waited
    expect(existsSync(lock)).toBe(true) // someone else's lock is left alone
    // now the same lock, but abandoned long ago
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(withFileLock(file, () => 'ran', { timeoutMs: 120, staleMs: 10_000 })).toBe('ran')
    expect(existsSync(lock)).toBe(false)
  })

  it('a store reports the lock instead of crashing when the chain is held', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const a = new McpStore(file, dir)
    writeFileSync(lockPathFor(file), '7 held')
    // the store's own lock timeout is 5s; override via a short-timeout wrapper is not exposed, so
    // exercise the path with a stale-looking lock instead: it must be reclaimed and the op succeed
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPathFor(file), old, old)
    expect(a.dispatch({ type: 'add', id: 'q', content: 'q', successor: 'target' }).ok).toBe(true)
  })
})

describe('the registry under contention', () => {
  it('two registries on one file both keep every entry (lock + atomic write)', () => {
    const file = join(scratch(), 'projects.json')
    const r1 = new Registry(file)
    const r2 = new Registry(file)
    r1.register(join(scratch(), 'one', 'ddag.json'))
    r2.register(join(scratch(), 'two', 'ddag.json'))
    r1.register(join(scratch(), 'three', 'ddag.json'))
    expect(r2.read().map((p) => p.name).sort()).toEqual(['one', 'three', 'two'])
  })
})
