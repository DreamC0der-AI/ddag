import { describe, expect, it } from 'vitest'
import { EventChain } from '../chain'
import { PROJECT_ID, coneOf, homesOf, mainTarget, migrateToProject, projectOf, targetsOf } from '../targets'
import { rankFrontier } from '../../kernel/ordering'

const add = (c: EventChain, id: string, successor: string, content = id) => {
  const r = c.dispatch({ type: 'add', id, content, successor })
  if (!r.ok) throw new Error(r.error)
}
const ok = (c: EventChain, op: Parameters<EventChain['dispatch']>[0]) => {
  const r = c.dispatch(op)
  if (!r.ok) throw new Error(r.error)
}

describe('targets — a reading of the shape (src/chain/targets.ts)', () => {
  it('a legacy chain has one target, its root; every node is homed there and in its cone', () => {
    const c = EventChain.create('build', 'the build')
    add(c, 'a', 'build')
    add(c, 'b', 'a')
    expect(projectOf(c)).toBeNull()
    expect(targetsOf(c)).toEqual(['build'])
    expect(mainTarget(c)).toBe('build')
    expect([...coneOf(c.graph, 'build')].sort()).toEqual(['a', 'b', 'build'])
    expect(Object.fromEntries(homesOf(c))).toEqual({ build: 'build', a: 'build', b: 'build' })
  })

  it('migration puts a project node above the old root, keeps every event, and the old root stays the main target', () => {
    const c = EventChain.create('build', 'the build')
    add(c, 'a', 'build')
    ok(c, { type: 'verify', id: 'a', result: 'valid' })
    ok(c, { type: 'verify', id: 'build', result: 'valid' })
    ok(c, { type: 'issue', action: 'open', key: 'I-1', title: 't', node: 'a' })
    const before = c.dump()
    const dump = migrateToProject(before, 'Project p')
    expect(dump.meta).toEqual({ project: PROJECT_ID })
    expect(dump.initial.root).toBe(PROJECT_ID)
    expect(dump.initial.arcs).toContainEqual({ from: 'build', to: PROJECT_ID })
    expect(JSON.stringify(dump.events)).toBe(JSON.stringify(before.events)) // byte-for-byte the same events
    const m = EventChain.replay(dump)
    expect(projectOf(m)).toBe(PROJECT_ID)
    expect(targetsOf(m)).toEqual(['build'])
    expect(m.graph.solid('build')).toBe(true)
    expect(m.graph.node('a').fingerprint).toEqual(c.graph.node('a').fingerprint)
    expect(m.graph.verdict(PROJECT_ID)).toBe('pending')
    expect(m.length).toBe(c.length)
    // the migrated dump round-trips through dump and replay with its meta
    expect(EventChain.replay(m.dump()).project).toBe(PROJECT_ID)
    // migrating twice is a no-op; a used id is refused
    expect(migrateToProject(dump, 'x')).toBe(dump)
    expect(() => migrateToProject(before, 'x', 'a')).toThrow(/already used/)
  })

  it('a node added under a sub-target is homed there; a linked node keeps its home; a cut-off subtree is re-homed', () => {
    const c = EventChain.replay(migrateToProject(EventChain.create('build', 'the build').dump(), 'Project p'))
    add(c, 'a', 'build')
    add(c, 'publish', PROJECT_ID, 'publish pipeline')
    add(c, 'npm', 'publish')
    expect(targetsOf(c)).toEqual(['build', 'publish'])
    let homes = homesOf(c)
    expect(homes.get('a')).toBe('build')
    expect(homes.get('publish')).toBe('publish')
    expect(homes.get('npm')).toBe('publish')
    expect(homes.has(PROJECT_ID)).toBe(false)
    // publish uses a: linked in, still homed in build, now in both cones
    ok(c, { type: 'link', from: 'a', to: 'publish' })
    homes = homesOf(c)
    expect(homes.get('a')).toBe('build')
    expect(coneOf(c.graph, 'publish').has('a')).toBe(true)
    expect(coneOf(c.graph, 'build').has('npm')).toBe(false)
    // a subtree moved out of its home is re-homed to the target it reaches
    add(c, 'moved', 'build')
    ok(c, { type: 'link', from: 'moved', to: 'publish' })
    ok(c, { type: 'unlink', from: 'moved', to: 'build' })
    expect(homesOf(c).get('moved')).toBe('publish')
  })

  it('rankFrontier with a target reports the win for that target and ranks only its cone', () => {
    const c = EventChain.replay(migrateToProject(EventChain.create('build', 'the build').dump(), 'Project p'))
    add(c, 'a', 'build')
    add(c, 'publish', PROJECT_ID, 'publish pipeline')
    add(c, 'npm', 'publish')
    ok(c, { type: 'verify', id: 'a', result: 'valid' })
    ok(c, { type: 'verify', id: 'build', result: 'valid' })
    const cone = coneOf(c.graph, 'publish')
    const ranks = rankFrontier(c.graph, { target: 'publish', only: new Set([...cone].filter((id) => homesOf(c).get(id) === 'publish')) })
    expect(ranks.map((r) => r.id)).toEqual(['npm'])
    expect(ranks[0]!.rootSolid).toBe(false)
    ok(c, { type: 'verify', id: 'npm', result: 'valid' })
    const next = rankFrontier(c.graph, { target: 'publish', only: cone })
    expect(next.map((r) => r.id)).toEqual(['publish'])
    expect(next[0]!.rootSolid).toBe(true)
    // the project node is never ranked for a target, and the kernel root's own frontier is not the target's
    expect(rankFrontier(c.graph, { target: 'build', only: coneOf(c.graph, 'build') }).map((r) => r.id)).toEqual([])
  })
})
