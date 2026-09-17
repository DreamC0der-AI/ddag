import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../server'
import { McpStore } from '../store'
import { PROJECT_ID } from '../../chain/targets'

async function connect(store: McpStore, chainRoot?: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer(store, { chainRoot })
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return (r.content as { type: string; text: string }[])[0]!.text
}
const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-t-'))

describe('targets in the MCP shell', () => {
  it('a legacy chain is migrated by the first target_new; every judgment, pin and record survives; a second store reloads', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'lib.ts'), 'v1\n')
    const file = join(dir, 'ddag.json')
    const client = await connect(new McpStore(file, dir), dir)
    await call(client, 'add', { id: 'a', content: 'lib works', successor: 'target' })
    await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'lib.ts reviewed' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold' })
    await call(client, 'issue_open', { key: 'I-1', title: 'note', node: 'a' })
    await call(client, 'version_mark', { name: 'v1' })
    const other = new McpStore(file, dir) // a second session on the same file
    const eventsBefore = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).events)
    const historyBefore = await call(client, 'graph_history', { limit: 50 })

    const t = await call(client, 'target_new', { id: 'publish', content: 'the build is published', rationale: 'a pipeline, not a part' })
    expect(t).toContain(`Migrated: the chain now has a project node "${PROJECT_ID}" above target`)
    expect(t).toContain('Target ' + require('node:path').basename(dir) + '/publish created and selected')
    expect(t).toContain('Target ' + require('node:path').basename(dir) + '/publish: broken')
    const dump = JSON.parse(readFileSync(file, 'utf8'))
    expect(dump.meta).toEqual({ project: PROJECT_ID })
    expect(JSON.stringify(dump.events.slice(0, -1))).toBe(eventsBefore) // the old events are byte-for-byte the same
    expect(await call(client, 'graph_history', { limit: 50 })).toContain(historyBefore.split('\n')[0]!)
    // the main target is untouched and still solid
    await call(client, 'target_switch', { id: 'target' })
    expect(await call(client, 'graph_state')).toContain('- target [valid, solid]')
    expect(await call(client, 'graph_state')).not.toContain('- publish')
    expect(await call(client, 'graph_audit')).toContain('- a: intact')
    expect(await call(client, 'version_list')).toContain('v1')
    // the other session catches up by reloading whole
    other.refresh()
    expect(other.project()).toBe(PROJECT_ID)
    expect(other.targets()).toEqual(['target', 'publish'])
    expect(other.graph.solid('target')).toBe(true)
    // a fresh store loads the migrated file
    expect(new McpStore(file, dir).targets()).toEqual(['target', 'publish'])
  })

  it('a second target has its own frontier and standing; the first stays solid; the names', async () => {
    const dir = scratch()
    const name = require('node:path').basename(dir)
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'a', content: 'lib works', successor: 'target' })
    await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'reviewed' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold' })
    await call(client, 'target_new', { id: 'publish', content: 'the build is published' })
    const npm = await call(client, 'add', { id: 'npm', content: 'npm serves it', successor: 'publish' })
    expect(npm).toContain(`Target ${name}/publish: broken`)
    expect(npm).toContain('Frontier (best judgment first): npm')
    const list = await call(client, 'target_list')
    expect(list).toContain('- target: SOLID')
    expect(list).toContain(`- ${name}/publish (current): broken`)
    // judging the sub-target's leaf turns it solid, and says so; the main target is unaffected
    await call(client, 'verify', { id: 'npm', result: 'valid', evidence: 'npm view says 1.0' })
    const done = await call(client, 'verify', { id: 'publish', result: 'valid', evidence: 'its part holds' })
    expect(done).toContain(`★ target ${name}/publish is verified`)
    expect(done).toContain(`Target ${name}/publish: SOLID`)
    expect(await call(client, 'target_switch', { id: 'target' })).toContain('Root target: SOLID')
    expect(await call(client, 'target_switch', { id: 'nope' })).toContain('is not a target')
    // graph_state on the main target shows no publish node; on publish, only its cone
    expect(await call(client, 'graph_state')).not.toContain('npm')
    await call(client, 'target_switch', { id: 'publish' })
    const st = await call(client, 'graph_state')
    expect(st).toContain(`Target ${name}/publish (other targets: target; target_switch to view)`)
    expect(st).toContain('- npm [valid, solid]')
    expect(st).not.toContain('- a [')
    expect(st).not.toContain(PROJECT_ID)
    // the version record lists both targets
    await call(client, 'version_mark', { name: 'v2' })
    expect(await call(client, 'version_list')).toContain('(targets: target solid, publish solid)')
  })

  it('a shared claim is judged only in its home; structure lands only inside the current cone; targets live on', async () => {
    const dir = scratch()
    const name = require('node:path').basename(dir)
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'a', content: 'lib works', successor: 'target' })
    await call(client, 'target_new', { id: 'publish', content: 'the build is published' })
    // publish uses a: link is allowed from another home
    expect(await call(client, 'link', { from: 'a', to: 'publish' })).toContain('Applied: Link(a->publish)')
    const st = await call(client, 'graph_state')
    expect(st).toContain('- a [pending] · leaf · home: target')
    // ... but a is judged in target, not here
    const v = await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'reviewed' })
    expect(v).toContain('Refused: "a" is judged in its home target target — target_switch there first')
    expect(await call(client, 'doubt', { id: 'a' })).toContain('Refused: "a" is judged in its home target')
    expect(await call(client, 'mutate', { id: 'a', content: 'x' })).toContain('Refused: "a" is judged in its home target')
    // structure outside the cone is refused
    expect(await call(client, 'add', { content: 'b', successor: 'target' })).toContain('Refused: successor "target" is not in target')
    expect(await call(client, 'add', { content: 'b', successor: PROJECT_ID })).toContain('Refused: "_project" is the project node')
    expect(await call(client, 'link', { from: 'a', to: PROJECT_ID })).toContain('Refused: targets are added with target_new')
    expect(await call(client, 'unlink', { from: 'publish', to: PROJECT_ID })).toContain('is a target — a target is not unlinked')
    expect(await call(client, 'discard', { id: 'publish' })).toContain('is a target — targets live on')
    expect(await call(client, 'verify', { id: PROJECT_ID, result: 'valid', evidence: 'x' })).toContain('is the project node')
    // from its home, a is judged, and publish restores nothing until judged itself
    await call(client, 'target_switch', { id: 'target' })
    expect(await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'reviewed' })).toContain('Applied: Verify(a)=valid')
    await call(client, 'target_switch', { id: 'publish' })
    expect(await call(client, 'graph_state')).toContain('- a [valid, solid] · leaf · home: target')
    expect(await call(client, 'target_list')).toContain(`- ${name}/publish (current): broken`)
  })

  it('target_new with adopt makes an existing claim a target: its subtree keeps its judgments and is re-homed; the old whole reopens', async () => {
    const dir = scratch()
    const name = require('node:path').basename(dir)
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'a', content: 'lib works', successor: 'target' })
    await call(client, 'add', { id: 'publish', content: 'published', successor: 'target' })
    await call(client, 'add', { id: 'npm', content: 'npm serves it', successor: 'publish' })
    await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'reviewed' })
    await call(client, 'verify', { id: 'npm', result: 'valid', evidence: 'npm view' })
    await call(client, 'verify', { id: 'publish', result: 'valid', evidence: 'its part holds' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold' })
    expect(await call(client, 'target_new', { id: 'publish', content: 'x' })).toContain('already exists — pass adopt')
    expect(await call(client, 'target_new', { id: 'fresh' })).toContain('needs its claim text')
    expect(await call(client, 'target_new', { id: 'nope', adopt: true })).toContain('does not exist')
    const r = await call(client, 'target_new', { id: 'publish', adopt: true, rationale: 'a pipeline, not a part' })
    expect(r).toContain('Migrated:')
    expect(r).toContain('Applied: Link(publish->_project) [Target(publish)]')
    expect(r).toContain('Unlink(publish||target) [Target(publish)]')
    expect(r).toContain(`Target ${name}/publish: SOLID`)
    const list = await call(client, 'target_list')
    expect(list).toContain('- target: broken') // its parts changed: one fresh judgment due
    expect(list).toContain(`- ${name}/publish (current): SOLID`)
    const st = await call(client, 'graph_state')
    expect(st).toContain('- npm [valid, solid]')
    expect(st).not.toContain('home:')
    await call(client, 'target_switch', { id: 'target' })
    const main = await call(client, 'graph_state')
    expect(main).not.toContain('- npm')
    expect(main).toContain('- target [pending] · FRONTIER')
    expect(main).toContain('    parts: a ·')
    expect(await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold without publish' })).toContain('Root target: SOLID')
  })
})
