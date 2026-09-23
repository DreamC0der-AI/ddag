import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../server'
import { McpStore } from '../store'

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
const project = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ddag-r-'))
  writeFileSync(join(dir, 'lib.ts'), 'v1\n')
  writeFileSync(join(dir, 'docs.md'), 'v1\n')
  const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
  await call(client, 'add', { id: 'group', content: 'the library is sound', successor: 'target' })
  await call(client, 'add', { id: 'lib', content: 'lib works', successor: 'group', rationale: 'the group cannot be judged without it. More.' })
  await call(client, 'add', { id: 'docs', content: 'docs ok', successor: 'target' })
  return { dir, client }
}

describe('reading the chain selectively, rounds, and the pin rule', () => {
  it('history by node, since a position, why, and the position on the standing line', async () => {
    const { client } = await project()
    const v = await call(client, 'verify', { id: 'lib', result: 'valid', evidence: 'lib.ts reviewed: 3 tests passed. A long tail.' })
    expect(v).toMatch(/· at #4$/m)
    await call(client, 'verify', { id: 'group', result: 'valid', evidence: 'its part holds' })
    await call(client, 'verify', { id: 'docs', result: 'valid', evidence: 'docs.md read' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold' })
    const lib = await call(client, 'graph_history', { node: 'lib' })
    expect(lib).toContain('History of lib — 2 entries')
    expect(lib).toContain('#2 added under group — the group cannot be judged without it.')
    expect(lib).toContain('#4 judged valid — lib.ts reviewed: 3 tests passed. [pinned no-git, 1 artifact]')
    expect(lib).not.toContain('docs')
    expect(lib).not.toContain('A long tail')
    expect(await call(client, 'graph_history', { node: 'lib', full: true })).toContain('A long tail.')
    expect(await call(client, 'graph_history', { since: 6 })).toBe('7. Verify(target)=valid — evidence: parts hold [pinned no-git, 0 artifacts]')
    expect(await call(client, 'graph_history', { since: 7 })).toContain('Nothing after #7')
    expect(await call(client, 'graph_history', { node: 'nope' })).toContain('no event on this chain names or reaches')
    // a restatement at the bottom: why on the root names the restated part and its event
    await call(client, 'mutate', { id: 'lib', content: 'lib works on windows too' })
    const why = await call(client, 'why', { id: 'target' })
    expect(why).toContain('target [pending]')
    expect(why).toContain('reopened at #8 by Mutate(lib)')
    expect(why).toContain('  lib [pending]')
    expect(why).toContain('restated at #8')
    expect(why).toContain('cannot be judged yet: waiting on group')
    const solid = await call(client, 'why', { id: 'docs' })
    expect(solid).toContain('docs [valid, solid]')
    expect(solid).toContain('judged valid at #6 — docs.md read')
    // the node view points at its chain
    expect(await call(client, 'graph_state', { node: 'lib' })).toContain('chain: 3 entries, last #8, judged #4')
  })

  it('a round is recorded once and cited: the judgment says one sentence, history and the node view show the round', async () => {
    const { client } = await project()
    await call(client, 'verify', { id: 'lib', result: 'valid', evidence: 'lib.ts reviewed' })
    expect(await call(client, 'reverify', { id: 'lib', evidence: 'x', round: 'nope' })).toContain('round "nope" is not recorded')
    const r = await call(client, 'round_record', { key: 'fmt-round', title: 'formatter pass over lib.ts', detail: 'lib.ts reformatted; suite 3 passed' })
    expect(r).toContain('Applied: Round(fmt-round) (round: formatter pass over lib.ts)')
    expect(await call(client, 'round_record', { key: 'fmt-round', title: 'again' })).toContain('already recorded')
    const auto = await call(client, 'round_record', { title: 'second change' })
    expect(auto).toContain('Round(R2)')
    const re = await call(client, 'reverify', { id: 'lib', evidence: 'whitespace only under this claim', round: 'fmt-round', artifacts: ['lib.ts'] })
    expect(re).toContain('Applied: Doubt(lib) [Reverify(lib)]; Verify(lib)=valid [Reverify(lib)] [pinned no-git, 1 artifact]')
    const h = await call(client, 'graph_history', { node: 'lib' })
    expect(h).toContain('re-anchored — whitespace only under this claim [pinned no-git, 1 artifact] [round fmt-round]')
    expect(await call(client, 'graph_state', { node: 'lib' })).toContain('judged: valid — [round fmt-round: formatter pass over lib.ts] whitespace only under this claim')
    expect(await call(client, 'why', { id: 'lib' })).toContain('[round fmt-round: formatter pass over lib.ts]')
    // a record: the graph never moved, and it replays
    expect(await call(client, 'graph_history', { limit: 5 })).toContain('Round(fmt-round) — round: formatter pass over lib.ts')
  })

  it('a round with files and claims carries the other judgments on those files, leaves the named ones stale, and every view says carried; without a round nothing changes', async () => {
    const { dir, client } = await project()
    await call(client, 'verify', { id: 'lib', result: 'valid', evidence: 'lib.ts reviewed', artifacts: ['lib.ts'] })
    await call(client, 'verify', { id: 'docs', result: 'valid', evidence: 'docs.md against lib.ts', artifacts: ['lib.ts', 'docs.md'] })
    await call(client, 'verify', { id: 'group', result: 'valid', evidence: 'its part holds, and lib.ts read', artifacts: ['lib.ts'] })
    writeFileSync(join(dir, 'lib.ts'), 'v2\n')
    expect(await call(client, 'graph_audit')).toContain('Evidence audit (3 judgment(s) resting on changed artifacts')
    // refusals write nothing
    const before = await call(client, 'graph_history', { limit: 1 })
    expect(await call(client, 'round_record', { title: 'x', files: ['nope.ts'], claims: ['lib'] })).toContain("Rejected: 'nope.ts' does not exist under the project root")
    expect(await call(client, 'round_record', { title: 'x', files: ['lib.ts'], claims: ['ghost'] })).toContain('Rejected: claim "ghost" does not exist')
    expect(await call(client, 'round_record', { title: 'x', claims: ['lib'] })).toContain('Rejected: `claims` needs `files`')
    expect(await call(client, 'graph_history', { limit: 1 })).toBe(before)
    // the round: one event for the change, one carry for the judgments it does not concern
    const r = await call(client, 'round_record', { key: 'fix-1', title: 'lib fix', detail: 'lib.ts v2; suite green', files: ['lib.ts'], claims: ['lib'] })
    expect(r).toContain('Applied: Round(fix-1) (round: lib fix); Carry(fix-1)')
    expect(r).toContain('Carried on your word, not re-examined: group, docs — pins moved over lib.ts.')
    expect(r).toContain('Left stale for re-examination: lib — reverify each with round "fix-1"')
    expect(r).toContain('Stale: 1 judgment(s)')
    const audit = await call(client, 'graph_audit')
    expect(audit).toContain("Evidence audit (1 judgment(s) resting on changed artifacts, 2 carried on the agent's word)")
    expect(audit).toContain('- lib: STALE? — since no-git, 1 artifact: lib.ts changed')
    expect(audit).toContain("- docs: intact — 2 artifact(s) unchanged since no-git, 2 artifacts (pin carried at #8 on round fix-1 — on the agent's word, not re-examined)")
    expect(await call(client, 'graph_history', { node: 'docs' })).toContain('#8 pin carried over lib.ts on round fix-1 — not re-examined [pinned no-git, 2 artifacts]')
    expect(await call(client, 'graph_state', { node: 'docs' })).toContain('[pinned no-git, 2 artifacts] — pin carried at #8 on round fix-1, not re-examined')
    expect(await call(client, 'graph_history', { limit: 1 })).toContain("8. Carry(fix-1) — carry: group, docs carried over lib.ts — pins moved on the agent's word, not re-examined")
    // the named claim is re-examined against the round, and the carry is then superseded by a judgment
    expect(await call(client, 'reverify', { id: 'lib', evidence: 'lib.ts v2 reviewed', round: 'fix-1', artifacts: ['lib.ts'] })).toContain('Verify(lib)=valid [Reverify(lib)]')
    expect(await call(client, 'graph_audit')).toContain('Evidence audit (0 judgment(s) resting on changed artifacts, 2 carried')
    // a round naming a claim that does not pin the file says so; a change nobody pins carries nothing
    const r2 = await call(client, 'round_record', { title: 'docs only', files: ['docs.md'], claims: ['lib'] })
    expect(r2).toContain('No valid judgment pinned to docs.md moved; nothing carried.')
    expect(r2).toContain('Named but not pinned to docs.md: lib')
    // a change with no round: the old price, every judgment on the file stale
    writeFileSync(join(dir, 'lib.ts'), 'v3\n')
    expect(await call(client, 'graph_audit')).toContain('Evidence audit (3 judgment(s) resting on changed artifacts')
  })

  it('PIN-3: a folder on a claim with parts is refused with no event written; a file its part pins is applied with the part named; graph_audit lists shared pins', async () => {
    const { dir, client } = await project()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'x.ts'), 'v1\n')
    await call(client, 'verify', { id: 'lib', result: 'valid', evidence: 'lib.ts reviewed', artifacts: ['lib.ts'] })
    const before = await call(client, 'graph_history', { limit: 1 })
    const refused = await call(client, 'verify', { id: 'group', result: 'valid', evidence: 'its part holds', artifacts: ['sub'] })
    expect(refused).toContain("Refused: 'sub' is a folder and this claim has parts (PIN-3)")
    expect(refused).toContain('Pass no artifacts to rest on the parts')
    expect(await call(client, 'graph_history', { limit: 1 })).toBe(before)
    expect(await call(client, 'graph_state', { node: 'group' })).toContain('- group [pending')
    // the same on reverify, once the group is judged
    const dup = await call(client, 'verify', { id: 'group', result: 'valid', evidence: 'its part holds, and lib.ts read', artifacts: ['lib.ts'] })
    expect(dup).toContain('[pinned no-git, 1 artifact]')
    expect(dup).toContain("'lib.ts' is already pinned by part 'lib'")
    expect(await call(client, 'reverify', { id: 'group', evidence: 'again', artifacts: ['sub'] })).toContain('Refused:')
    // three judgments on one file: the audit says so, widest first
    await call(client, 'verify', { id: 'docs', result: 'valid', evidence: 'docs.md and lib.ts read together', artifacts: ['lib.ts', 'docs.md'] })
    const audit = await call(client, 'graph_audit')
    expect(audit).toContain('Shared pins — one change stales every claim on the line:')
    expect(audit).toContain('    lib.ts: 3 claims (group, lib, docs)')
    expect(audit).not.toContain('docs.md:')
  })

  it('pins are what the judgment was given: explicit artifacts are the whole set; a claim with parts pins nothing from prose; a leaf falls back to its prose', async () => {
    const { client } = await project()
    // a leaf without explicit artifacts: prose paths, as before
    expect(await call(client, 'verify', { id: 'docs', result: 'valid', evidence: 'read docs.md and lib.ts side by side' })).toContain('2 artifacts]')
    // explicit artifacts win: the prose path is not added
    const lib = await call(client, 'verify', { id: 'lib', result: 'valid', evidence: 'lib.ts reviewed against docs.md', artifacts: ['lib.ts'] })
    expect(lib).toContain('[pinned no-git, 1 artifact]')
    // a claim with parts: prose paths are not pinned, and the reply says so without the unwatched warning
    const group = await call(client, 'verify', { id: 'group', result: 'valid', evidence: 'judged on its part lib; lib.ts is where it lives' })
    expect(group).toContain('[pinned no-git, 0 artifacts]')
    expect(group).toContain('a claim with parts rests on its parts — the paths in its evidence were not pinned')
    expect(group).not.toContain('it is unwatched')
    expect(await call(client, 'graph_audit')).toContain('- group: rests on its 1 part(s)')
    // re-anchoring a claim with parts says nothing about being unwatched either
    const regroup = await call(client, 'reverify', { id: 'group', evidence: 'judged on its part again' })
    expect(regroup).toContain('[pinned no-git, 0 artifacts]')
    expect(regroup).not.toContain('unwatched')
    // moving docs.md stales docs only
    const { writeFileSync: w } = await import('node:fs')
    void w
  })
})
