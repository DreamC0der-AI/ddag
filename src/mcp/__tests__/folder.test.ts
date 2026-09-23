import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ChainDump } from '../../chain/chain'
import { buildServer } from '../server'
import { McpStore } from '../store'
import { Registry } from '../registry'
import { migrateToFolder, openChainPath } from '../folder'

async function connect(store: McpStore, chainRoot: string) {
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
const dump = (file: string): ChainDump => JSON.parse(readFileSync(file, 'utf8')) as ChainDump

/** A project written by an older shell: one ddag.json with two versions marked, judged claims, an issue and a round. */
async function legacyProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ddag-folder-'))
  writeFileSync(join(dir, 'lib.ts'), 'v1\n')
  const file = join(dir, 'ddag.json')
  const client = await connect(new McpStore(file, dir), dir)
  await call(client, 'add', { id: 'a', content: 'a holds', successor: 'target', rationale: 'first part' })
  await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'lib.ts examined', artifacts: ['lib.ts'] })
  await call(client, 'version_mark', { name: 'v1', note: 'first' })
  await call(client, 'issue_open', { key: 'I1', title: 'a finding', node: 'a' })
  await call(client, 'add', { id: 'b', content: 'b holds', successor: 'target' })
  await call(client, 'round_record', { key: 'r1', title: 'a change' })
  await call(client, 'verify', { id: 'b', result: 'valid', evidence: 'lib.ts examined for b', artifacts: ['lib.ts'], round: 'r1' })
  await call(client, 'version_mark', { name: 'v2' })
  await call(client, 'add', { id: 'c', content: 'c holds', successor: 'target' })
  expect(existsSync(join(dir, '.ddag'))).toBe(false) // a single-file chain never rolls
  return { dir, file }
}

describe('the .ddag folder — migration, rolling at a version mark, and sessions on a folder chain', () => {
  it('migrates a ddag.json into sealed segments per version plus the live chain, every number kept, and the views read through the checkpoint', async () => {
    const { dir, file } = await legacyProject()
    const total = dump(file).events.length
    const registry = new Registry(join(dir, 'registry.json'))
    registry.register(file)
    const opened = openChainPath(dir)
    expect(opened.file).toBe(join(dir, '.ddag', 'chain.json'))
    expect(opened.migrated).toMatchObject({ from: file, segments: 2, events: total })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(dir, '.ddag', 'migrated-ddag.json'))).toBe(true)
    const seg0 = dump(join(dir, '.ddag', 'archive', '000-v1.json'))
    const seg1 = dump(join(dir, '.ddag', 'archive', '001-v2.json'))
    const live = dump(opened.file)
    expect(seg0.checkpoint).toBeUndefined()
    expect(seg0.events.at(-1)?.op).toMatchObject({ type: 'version', name: 'v1' })
    expect(seg1.checkpoint).toMatchObject({ seq: seg0.events.length, segment: 1, parent: join('archive', '000-v1.json'), after: 'v1' })
    expect(seg1.events[0]?.seq).toBe(seg0.events.length + 1)
    expect(seg1.events.at(-1)?.op).toMatchObject({ type: 'version', name: 'v2' })
    expect(live.checkpoint).toMatchObject({ segment: 2, after: 'v2' })
    expect(live.checkpoint!.seq + live.events.length).toBe(total)
    expect(live.events.map((e) => e.op.type)).toEqual(['add'])
    // a second open is a plain open
    expect(openChainPath(dir).migrated).toBeUndefined()
    expect(() => migrateToFolder(opened.file)).toThrow(/already a segment/)
    // the registry entry followed the file
    const store = new McpStore(opened.file, dir, (f) => registry.register(f))
    expect(registry.read()).toHaveLength(1)
    expect(registry.read()[0]).toMatchObject({ chain: opened.file, dir })
    // the views: standing, claims judged before the roll, audit, issues, versions, rounds, history
    const client = await connect(store, dir)
    const state = await call(client, 'graph_state')
    expect(state).toContain(`at #${total}`)
    expect(state).toContain('- a [valid')
    expect(state).toContain('- c [pending')
    const a = await call(client, 'graph_state', { node: 'a' })
    expect(a).toContain('judged: valid — lib.ts examined [pinned no-git, 1 artifact]')
    expect(a).toContain('because: first part')
    expect(await call(client, 'graph_state', { node: 'b' })).toContain('judged: valid — [round r1: a change] lib.ts examined for b')
    const audit = await call(client, 'graph_audit')
    expect(audit).toContain('- a: intact — 1 artifact(s) unchanged since no-git, 1 artifact')
    expect(audit).toContain('- b: intact')
    expect(await call(client, 'issue_list')).toContain('I1')
    const versions = await call(client, 'version_list')
    expect(versions).toContain('- v2 at event')
    expect(versions).toContain('- v1 at event 3')
    expect(await call(client, 'graph_history', { node: 'a' })).toContain(`(entries up to #${live.checkpoint!.seq} are in the sealed segment ${join('archive', '001-v2.json')}`)
    // the code moves: the claim judged before the roll goes stale, and is re-anchored citing the round from before
    writeFileSync(join(dir, 'lib.ts'), 'v2\n')
    expect(await call(client, 'graph_audit')).toContain('- a: STALE?')
    expect(await call(client, 'reverify', { id: 'a', evidence: 'lib.ts v2 examined', artifacts: ['lib.ts'], round: 'r1' })).toContain('Verify(a)=valid [Reverify(a)]')
    expect(await call(client, 'round_record', { key: 'r1', title: 'again' })).toContain('already recorded')
  })

  it('a version mark on a folder chain rolls: the segment is sealed, the live chain restarts from a checkpoint, a second session catches up whole, and targets survive', async () => {
    const { dir } = await legacyProject()
    const opened = openChainPath(dir)
    const store = new McpStore(opened.file, dir)
    const client = await connect(store, dir)
    await call(client, 'verify', { id: 'c', result: 'valid', evidence: 'lib.ts examined for c', artifacts: ['lib.ts'] })
    // a sub-target beside the main one, with a claim of its own
    expect(await call(client, 'target_new', { id: 'publish', content: 'the project ships', rationale: 'consumes the build' })).toContain('Applied:')
    await call(client, 'add', { id: 'pub-a', content: 'the tarball is built', successor: 'publish' })
    await call(client, 'target_switch', { id: 'target' })
    const before = dump(opened.file)
    const position = before.checkpoint!.seq + before.events.length
    const marked = await call(client, 'version_mark', { name: 'v3', note: 'third' })
    expect(marked).toContain('Applied: Version(v3)')
    expect(marked).toContain(`Rolled: ${before.events.length + 1} event(s) up to #${position + 1} sealed into ${join('.ddag', 'archive', '002-v3.json')}`)
    const sealed = dump(join(dir, '.ddag', 'archive', '002-v3.json'))
    expect(sealed.events.at(-1)?.op).toMatchObject({ type: 'version', name: 'v3' })
    const live = dump(opened.file)
    expect(live.events).toEqual([])
    expect(live.checkpoint).toMatchObject({ seq: position + 1, segment: 3, after: 'v3', parent: join('archive', '002-v3.json') })
    expect(live.meta).toEqual(before.meta) // the project node and its targets ride in the checkpoint
    // the session that rolled continues on the new segment; its views still know the whole record
    expect(await call(client, 'graph_state')).toContain(`at #${position + 1}`)
    expect(await call(client, 'target_list')).toContain('publish')
    // homes survived the roll: the sub-target's claim is judged there, not in the main target
    expect(live.checkpoint!.homes).toMatchObject({ 'pub-a': 'publish', a: 'target', publish: 'publish' })
    expect(await call(client, 'verify', { id: 'pub-a', result: 'valid', evidence: 'built' })).toContain('judged in its home target')
    await call(client, 'target_switch', { id: 'publish' })
    expect(await call(client, 'graph_state')).toContain('- pub-a [pending')
    await call(client, 'target_switch', { id: 'target' })
    expect(await call(client, 'version_list')).toContain('- v1 at event 3')
    expect((await call(client, 'version_list')).match(/- v\d at event/g)).toHaveLength(3)
    // another session on the same folder loads the live segment and continues the numbering
    const other = await connect(new McpStore(opened.file, dir), dir)
    expect(await call(other, 'graph_state')).toContain(`at #${position + 1}`)
    expect(await call(other, 'add', { id: 'd', content: 'd holds', successor: 'target' })).toContain(`at #${position + 2}`)
    // the first session takes it on
    expect(await call(client, 'graph_state')).toContain('- d [pending')
    expect(await call(client, 'graph_state')).toContain(`at #${position + 2}`)
    // a version already marked before the roll is refused by name
    expect(await call(client, 'version_mark', { name: 'v1' })).toContain('already marked (at event 3)')
  })

  it('a chain given by an explicit file path is a single-file chain: it never rolls, and a directory or a .ddag path opens the folder chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-single-'))
    expect(openChainPath(dir, 'notes.json')).toEqual({ file: join(dir, 'notes.json') })
    expect(openChainPath(dir, '.ddag')).toEqual({ file: join(dir, '.ddag', 'chain.json') })
    expect(openChainPath(dir, 'ddag.json')).toEqual({ file: join(dir, '.ddag', 'chain.json') })
    expect(openChainPath(dir, join('.ddag', 'chain.json'))).toEqual({ file: join(dir, '.ddag', 'chain.json') })
    expect(openChainPath(dir)).toEqual({ file: join(dir, '.ddag', 'chain.json') })
    const single = new McpStore(join(dir, 'notes.json'), dir)
    const client = await connect(single, dir)
    await call(client, 'add', { id: 'a', content: 'a', successor: 'target' })
    expect(await call(client, 'version_mark', { name: 'v1' })).not.toContain('Rolled')
    expect(existsSync(join(dir, '.ddag'))).toBe(false)
  })
})
