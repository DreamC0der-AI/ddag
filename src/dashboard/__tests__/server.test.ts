import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { Registry } from '../../mcp/registry'
import { McpStore } from '../../mcp/store'
import { _resetAuditCache, startDashboard, summarize } from '../server'
import { collectProvenance } from '../../mcp/provenance'
import { EventChain } from '../../chain/chain'
import { PROJECT_ID, migrateToProject } from '../../chain/targets'

const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-dash-'))

describe('dashboard server', () => {
  let server: Server
  let base: string
  let registry: Registry
  let chainA: string
  let staticDir: string

  beforeAll(async () => {
    registry = new Registry(join(scratch(), 'projects.json'))
    const hook = (f: string) => registry.register(f)
    const dirA = join(scratch(), 'alpha')
    const dirB = join(scratch(), 'beta')
    mkdirSync(dirA)
    mkdirSync(dirB)
    chainA = join(dirA, 'ddag.json')
    const a = new McpStore(chainA, dirA, hook)
    a.dispatch({ type: 'add', id: 'x', content: 'part x', successor: 'target' })
    a.dispatch({ type: 'add', id: 'w', content: 'part w', successor: 'target' })
    a.dispatch({ type: 'issue', action: 'open', key: 'W-1', title: 'w is broken', node: 'w' })
    a.dispatch({ type: 'issue', action: 'open', key: 'W-2', title: 'w is slow' })
    a.dispatch({ type: 'issue', action: 'close', key: 'W-2', outcome: 'wontfix', resolution: 'fast enough' })
    const b = new McpStore(join(dirB, 'ddag.json'), dirB, hook)
    b.dispatch({ type: 'add', id: 'y', content: 'part y', successor: 'target' })
    b.dispatch({ type: 'verify', id: 'y', result: 'valid' }, 'checked')
    b.dispatch({ type: 'verify', id: 'target', result: 'valid' }, 'checked')
    b.dispatch({ type: 'version', name: 'v1.0', commit: 'feedface0000', note: 'shipped' })
    // a registered path whose file vanished
    registry.register(join(scratch(), 'ghost', 'ddag.json'))

    staticDir = scratch()
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')
    server = await startDashboard({ registry, staticDir, port: 0 })
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
  })
  afterAll(() => server.close())

  it('a folder chain (.ddag/chain.json) is listed under its project name, served, audited and counted by its position across segments', async () => {
    const dirZ = join(scratch(), 'zeta')
    mkdirSync(join(dirZ, '.ddag'), { recursive: true })
    writeFileSync(join(dirZ, 'lib.ts'), 'v1\n')
    const chainZ = join(dirZ, '.ddag', 'chain.json')
    const g = new McpStore(chainZ, dirZ, (f) => registry.register(f))
    g.dispatch({ type: 'add', id: 'z', content: 'part z', successor: 'target' })
    g.dispatch({ type: 'verify', id: 'z', result: 'valid' }, 'lib.ts read', collectProvenance('lib.ts read', ['lib.ts'], dirZ, chainZ).provenance)
    g.dispatch({ type: 'verify', id: 'target', result: 'valid' }, 'its part holds')
    expect(g.markVersion({ type: 'version', name: 'v1' }).text).toContain('Rolled: 4 event(s) up to #4')
    g.dispatch({ type: 'add', id: 'q', content: 'part q', successor: 'target' })
    _resetAuditCache()
    const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as { projects: ReturnType<typeof summarize>[] }
    const gamma = projects.find((p) => p.name === 'zeta')!
    expect(gamma).toMatchObject({ exists: true, dir: dirZ, chain: chainZ, events: 5, lastEvent: 'Add(q)', stale: 0, version: { label: 'v1', eventsSince: 1 } })
    const served = (await (await fetch(`${base}/api/chain/zeta`)).json()) as { checkpoint?: { seq: number }; events: unknown[] }
    expect(served.checkpoint?.seq).toBe(4)
    expect(served.events).toHaveLength(1)
    const audit = (await (await fetch(`${base}/api/audit/zeta`)).json()) as { nodes: Record<string, { status: string }> }
    expect(audit.nodes['z']).toMatchObject({ status: 'intact' }) // the pin came through the checkpoint
    // the folder itself is never part of a directory hash, so the chain's own writes never stale a pin on the tree
    const treeBefore = collectProvenance('the tree', ['.'], dirZ, chainZ).provenance.artifacts[0]!.hash
    g.dispatch({ type: 'add', id: 'r', content: 'part r', successor: 'target' })
    expect(collectProvenance('the tree', ['.'], dirZ, chainZ).provenance.artifacts[0]!.hash).toBe(treeBefore)
  })

  it('/api/projects lists every registered project with a live summary', async () => {
    const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as { projects: ReturnType<typeof summarize>[] }
    const byName = Object.fromEntries(projects.map((p) => [p.name, p]))
    expect(byName['alpha']).toMatchObject({ exists: true, rootSolid: false, frontier: 2, events: 5, lastEvent: 'Close(W-2)=wontfix', openIssues: 1, closedIssues: 1 })
    expect(byName['beta']).toMatchObject({ exists: true, rootSolid: true, frontier: 0, events: 4, lastEvent: 'Version(v1.0)', openIssues: 0, version: { label: 'v1.0 @feedfac', eventsSince: 0, rootSolid: true } })
    expect(byName['ghost']).toMatchObject({ exists: false })
  })

  it('/api/chain/<name> serves a registered chain, 404s unknown names, and never leaves the allowlist', async () => {
    const ok = await fetch(`${base}/api/chain/alpha`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe(readFileSync(chainA, 'utf8'))
    expect((await fetch(`${base}/api/chain/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/chain/ghost`)).status).toBe(404)
    expect((await fetch(`${base}/api/chain/..%2Fprojects.json`)).status).toBe(404)
    expect((await fetch(`${base}/api/other`)).status).toBe(404)
  })

  it('/api/audit/<name> reports a judgment intact, then stale when its cited file changes, and unwatched when nothing was cited', async () => {
    const dir = join(scratch(), 'gamma')
    mkdirSync(dir)
    const src = join(dir, 'lexer.ts')
    writeFileSync(src, 'export const lex = 1\n')
    const store = new McpStore(join(dir, 'ddag.json'), dir, (f) => registry.register(f))
    store.dispatch({ type: 'add', id: 'lex', content: 'lexer tokenises', successor: 'target' })
    store.dispatch({ type: 'add', id: 'doc', content: 'docs written', successor: 'target' })
    // a pinned judgment citing lexer.ts, and one citing nothing
    const pinned = collectProvenance('lexer.test.ts green against lexer.ts', [], dir).provenance
    store.dispatch({ type: 'verify', id: 'lex', result: 'valid' }, 'tests green', pinned)
    store.dispatch({ type: 'verify', id: 'doc', result: 'valid' }, 'read it', collectProvenance('read it', [], dir).provenance)
    store.dispatch({ type: 'verify', id: 'target', result: 'valid' }, 'parts hold')

    type Audit = { nodes: Record<string, { status: string; changed: string[]; missing: string[] }>; summary: { stale: number; unwatched: number; unpinned: number } }
    let audit = (await (await fetch(`${base}/api/audit/gamma`)).json()) as Audit
    expect(audit.nodes['lex']).toMatchObject({ status: 'intact', changed: [], missing: [] })
    expect(audit.nodes['doc']).toMatchObject({ status: 'unwatched' })
    expect(audit.nodes['target']).toMatchObject({ status: 'unpinned' })
    expect(audit.summary).toMatchObject({ stale: 0, unwatched: 1, unpinned: 1 })
    let projects = (await (await fetch(`${base}/api/projects`)).json()) as { projects: ReturnType<typeof summarize>[] }
    expect(projects.projects.find((p) => p.name === 'gamma')).toMatchObject({ stale: 0 })

    // the code moves on under the judgment
    writeFileSync(src, 'export const lex = 2\n')
    _resetAuditCache()
    audit = (await (await fetch(`${base}/api/audit/gamma`)).json()) as Audit
    expect(audit.nodes['lex']).toMatchObject({ status: 'stale', changed: ['lexer.ts'], missing: [] })
    expect(audit.summary.stale).toBe(1)
    projects = (await (await fetch(`${base}/api/projects`)).json()) as { projects: ReturnType<typeof summarize>[] }
    expect(projects.projects.find((p) => p.name === 'gamma')).toMatchObject({ stale: 1 })

    // a vanished artifact is stale too, reported as missing
    rmSync(src)
    _resetAuditCache()
    audit = (await (await fetch(`${base}/api/audit/gamma`)).json()) as Audit
    expect(audit.nodes['lex']).toMatchObject({ status: 'stale', changed: [], missing: ['lexer.ts'] })

    expect((await fetch(`${base}/api/audit/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/audit/ghost`)).status).toBe(404)
  })

  it('the MCP graph_audit text and the API agree — one audit function', async () => {
    const dir = join(scratch(), 'delta')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    const store = new McpStore(join(dir, 'ddag.json'), dir, (f) => registry.register(f))
    store.dispatch({ type: 'add', id: 'p', content: 'part', successor: 'target' })
    store.dispatch({ type: 'verify', id: 'p', result: 'valid' }, 'a.txt checked', collectProvenance('a.txt checked', [], dir).provenance)
    writeFileSync(join(dir, 'a.txt'), 'b')
    _resetAuditCache()
    const audit = (await (await fetch(`${base}/api/audit/delta`)).json()) as { nodes: Record<string, { status: string }> }
    expect(audit.nodes['p']!.status).toBe('stale')
    expect(store.auditReport()).toContain('- p: STALE? — since')
    expect(store.auditReport()).toContain('a.txt changed')
  })

  it('/api/projects reads a multi-target chain per target: rootSolid is the main target, targets lists each; a legacy chain has no targets', async () => {
    const dir = join(scratch(), 'epsilon')
    mkdirSync(dir)
    // a project node with two targets: the main one (build) solid, the sub-target (publish) waiting on its part
    const chain = EventChain.replay(migrateToProject(EventChain.create('build', 'the build works').dump(), 'Project'))
    chain.dispatch({ type: 'add', id: 'lib', content: 'lib works', successor: 'build' })
    chain.dispatch({ type: 'verify', id: 'lib', result: 'valid' }, 'reviewed')
    chain.dispatch({ type: 'verify', id: 'build', result: 'valid' }, 'parts hold')
    chain.dispatch({ type: 'add', id: 'publish', content: 'the build is published', successor: PROJECT_ID })
    chain.dispatch({ type: 'add', id: 'npm', content: 'npm serves it', successor: 'publish' })
    chain.dispatch({ type: 'link', from: 'lib', to: 'publish' }) // used in publish, judged in build
    writeFileSync(join(dir, 'ddag.json'), JSON.stringify(chain.dump()))
    registry.register(join(dir, 'ddag.json'))

    const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as { projects: ReturnType<typeof summarize>[] }
    const byName = Object.fromEntries(projects.map((p) => [p.name, p]))
    const eps = byName['epsilon']!
    // the main target's standing, never the project node's (which is never judged) nor the sub-target's
    expect(eps).toMatchObject({ exists: true, rootId: 'build', rootClaim: 'the build works', rootSolid: true, frontier: 0, events: 6 })
    expect(eps.targets).toEqual([
      { id: 'build', solid: true, frontier: 0, nodes: 2 },
      { id: 'publish', solid: false, frontier: 1, nodes: 3 }, // publish, npm, and lib by link
    ])
    expect(eps.targets!.map((t) => t.id)).not.toContain(PROJECT_ID)
    // a legacy single-target chain carries no targets field at all
    expect(byName['alpha']).not.toHaveProperty('targets')
    expect(byName['beta']).not.toHaveProperty('targets')
  })

  it('/api/graph/<name> is one target\'s cone as a flat graph — claims, arcs and arc tags, the project node left out', async () => {
    const dir = join(scratch(), 'theta')
    mkdirSync(dir)
    const chain = EventChain.replay(migrateToProject(EventChain.create('build', 'the build works\nevery package compiles').dump(), 'Project'))
    chain.dispatch({ type: 'add', id: 'lib', content: 'lib works', successor: 'build' })
    chain.dispatch({ type: 'verify', id: 'lib', result: 'valid' }, 'reviewed')
    chain.dispatch({ type: 'add', id: 'publish', content: 'the build is published', successor: PROJECT_ID })
    chain.dispatch({ type: 'add', id: 'npm', content: 'npm serves it', successor: 'publish' })
    chain.dispatch({ type: 'link', from: 'lib', to: 'publish' })
    chain.dispatch({ type: 'tag', from: 'lib', to: 'build', tags: ['strong'] })
    chain.dispatch({ type: 'tag', from: 'lib', to: 'publish', tags: ['weak'] })
    writeFileSync(join(dir, 'ddag.json'), JSON.stringify(chain.dump()))
    registry.register(join(dir, 'ddag.json'))

    // no target named: the main target's cone
    const main = (await (await fetch(`${base}/api/graph/theta`)).json()) as Record<string, unknown>
    expect(main).toMatchObject({ name: 'theta', position: 7, root: 'build', targets: ['build', 'publish'] })
    expect(main['nodes']).toEqual([
      { id: 'build', title: 'the build works', detail: 'every package compiles', verdict: 'pending', solid: false, root: true },
      { id: 'lib', title: 'lib works', detail: '', verdict: 'valid', solid: true, root: false },
    ])
    expect(main['links']).toEqual([{ source: 'lib', target: 'build', tags: ['strong'] }]) // lib->publish leaves this cone
    // a named target: its own cone, the shared part included, with the tag of the arc into this target
    const pub = (await (await fetch(`${base}/api/graph/theta?target=publish`)).json()) as { root: string; nodes: { id: string }[]; links: unknown[] }
    expect(pub.root).toBe('publish')
    expect(pub.nodes.map((n) => n.id).sort()).toEqual(['lib', 'npm', 'publish'])
    expect(pub.links).toContainEqual({ source: 'lib', target: 'publish', tags: ['weak'] })
    expect(pub.links).toContainEqual({ source: 'npm', target: 'publish' })
    // the project node is no target, and neither is a part
    for (const t of [PROJECT_ID, 'lib', 'nope']) expect((await fetch(`${base}/api/graph/theta?target=${t}`)).status).toBe(404)
    expect((await fetch(`${base}/api/graph/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/graph/ghost`)).status).toBe(404)
    expect((await fetch(`${base}/api/graph/a/b`)).status).toBe(404)
    // a legacy single-target chain: its root is its one target
    expect(await (await fetch(`${base}/api/graph/alpha`)).json()).toMatchObject({ root: 'target', targets: ['target'] })
  })

  it('is read-only', async () => {
    expect((await fetch(`${base}/api/projects`, { method: 'POST' })).status).toBe(405)
  })

  it('DELETE /api/projects/<name> forgets a missing project and nothing else', async () => {
    const names = async () => ((await (await fetch(`${base}/api/projects`)).json()) as { projects: { name: string }[] }).projects.map((p) => p.name)
    // a project whose chain file exists is kept, and its file is untouched
    const before = readFileSync(chainA, 'utf8')
    expect((await fetch(`${base}/api/projects/alpha`, { method: 'DELETE' })).status).toBe(409)
    expect(readFileSync(chainA, 'utf8')).toBe(before)
    expect((await fetch(`${base}/api/projects/nobody`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/projects/a%2Fb`, { method: 'DELETE' })).status).toBe(404)
    // the other write methods stay refused on the same route
    expect((await fetch(`${base}/api/projects/ghost`, { method: 'POST' })).status).toBe(405)
    expect(await names()).toContain('ghost')
    const gone = await fetch(`${base}/api/projects/ghost`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(await gone.json()).toEqual({ removed: 'ghost' })
    expect(await names()).not.toContain('ghost')
    expect(await names()).toContain('alpha')
    expect((await fetch(`${base}/api/projects/ghost`, { method: 'DELETE' })).status).toBe(404)
  })

  it('serves assets under the build dir and the app shell for every route', async () => {
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe('console.log(1)')
    for (const route of ['/', '/p/alpha', '/p/does-not-matter', '/sandbox']) {
      const r = await fetch(`${base}${route}`)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain('<title>shell</title>')
    }
    expect((await fetch(`${base}/assets/../../etc/passwd`)).status).toBe(200) // normalised → shell, never a file outside
  })

  it('serves the 3D view\'s own page at /p/<name>/3d and the app shell everywhere else', async () => {
    writeFileSync(join(staticDir, 'graph3d.html'), '<!doctype html><title>3d</title>')
    for (const route of ['/p/alpha/3d', '/p/alpha/3d/', '/p/does-not-matter/3d']) expect(await (await fetch(`${base}${route}`)).text()).toContain('<title>3d</title>')
    for (const route of ['/p/alpha', '/p/alpha/3dx', '/p/alpha/3d/more', '/3d']) expect(await (await fetch(`${base}${route}`)).text()).toContain('<title>shell</title>')
  })
})
