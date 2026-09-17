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

    const staticDir = scratch()
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')
    server = await startDashboard({ registry, staticDir, port: 0 })
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
  })
  afterAll(() => server.close())

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

  it('is read-only', async () => {
    expect((await fetch(`${base}/api/projects`, { method: 'POST' })).status).toBe(405)
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
})
