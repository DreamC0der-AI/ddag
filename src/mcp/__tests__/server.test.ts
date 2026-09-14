import { mkdtempSync } from 'node:fs'
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
  const first = (r.content as { type: string; text: string }[])[0]!
  return { isError: r.isError === true, text: first.text }
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ddag-')), 'chain.json')

describe('ddag MCP server', () => {
  it('serves the epistemic front as the tool list', async () => {
    const client = await connect(new McpStore(tmpFile()))
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(
      [
        'add',
        'link',
        'unlink',
        'mutate',
        'verify',
        'doubt',
        'revert',
        'reverify',
        'refute',
        'restructure',
        'discard',
        'substitute',
        'merge',
        'graph_state',
        'graph_history',
        'graph_audit',
        'issue_open',
        'issue_close',
        'issue_list',
        'version_mark',
        'version_list',
        'graph_new',
        'graph_open',
      ].sort(),
    )
  })

  it('graph_open switches chains at runtime, isolated per file, and refuses escapes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const client = await connect(new McpStore(join(dir, 'a.json')), dir)

    await call(client, 'add', { content: 'claim in A', successor: 'target' })
    await call(client, 'verify', { id: 'n1', result: 'valid', evidence: 'a-suite: green' })

    // switch to a fresh project — no restart
    const opened = await call(client, 'graph_open', { path: 'b.json' })
    expect(opened.isError).toBe(false)
    expect(opened.text).toContain('b.json')
    expect((await call(client, 'graph_state')).text).not.toContain('claim in A')
    await call(client, 'add', { content: 'claim in B', successor: 'target' })

    // switch back — A's state is exactly as left
    await call(client, 'graph_open', { path: 'a.json' })
    const state = await call(client, 'graph_state')
    expect(state.text).toContain('claim in A')
    expect(state.text).toContain('n1 [valid, solid]')
    expect(state.text).not.toContain('claim in B')

    // containment: paths may not escape the working directory
    const escape = await call(client, 'graph_open', { path: '../evil.json' })
    expect(escape.isError).toBe(true)
    expect(escape.text).toContain('Refused')
  })

  it('plays a full round: decompose, verify bottom-up, win', async () => {
    const client = await connect(new McpStore(tmpFile()))
    await call(client, 'graph_new', { content: 'ship the parser' })

    const add = await call(client, 'add', { content: 'lexer is correct', successor: 'target' })
    expect(add.isError).toBe(false)
    expect(add.text).toContain('Add(n1)')
    expect(add.text).toContain('Frontier')

    await call(client, 'add', { content: 'grammar is complete', successor: 'target' })
    expect((await call(client, 'verify', { id: 'n1', result: 'valid', evidence: 'lexer tests: green' })).isError).toBe(false)
    expect((await call(client, 'verify', { id: 'n2', result: 'valid', evidence: 'grammar tests: green' })).isError).toBe(false)
    const win = await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'integration suite: green' })
    expect(win.text).toContain('SOLID — the target is verified')
  })

  it('P1: a bare root cannot be verified, and the standing does not advertise it', async () => {
    const client = await connect(new McpStore(tmpFile()))
    const bare = await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'looks done' })
    expect(bare.isError).toBe(true)
    expect(bare.text).toContain('P1')
    const state = await call(client, 'graph_state')
    expect(state.text).toContain('decompose the root first')
    expect(state.text).not.toContain('WINS')
    await call(client, 'add', { id: 'a', content: 'the one part', successor: 'target' })
    await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'part tests: green' })
    const win = await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'integration: green' })
    expect(win.isError).toBe(false)
    expect(win.text).toContain('SOLID')
  })

  it('P5: verify pins cited artifacts; graph_audit flags the ones that change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'lexer.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'notes.md'), 'reviewed\n')
    const client = await connect(new McpStore(join(dir, 'chain.json'), dir), dir)
    await call(client, 'add', { id: 'lex', content: 'lexer is correct', successor: 'target' })
    await call(client, 'add', { id: 'doc', content: 'notes are accurate', successor: 'target' })
    // path mentioned in the evidence text is pinned automatically
    const v1 = await call(client, 'verify', { id: 'lex', result: 'valid', evidence: 'vitest lexer.ts: 12 passed' })
    expect(v1.text).toContain('[pinned no-git, 1 artifact]')
    // explicit artifacts pin too
    await call(client, 'verify', { id: 'doc', result: 'valid', evidence: 'read it twice', artifacts: ['notes.md'] })

    const clean = await call(client, 'graph_audit')
    expect(clean.text).toContain('lex: intact')
    expect(clean.text).toContain('doc: intact')
    expect(clean.text).toContain('(0 judgment(s) resting on changed artifacts)')

    writeFileSync(join(dir, 'lexer.ts'), 'export const a = 2\n') // code drifts under a green claim
    const dirty = await call(client, 'graph_audit')
    expect(dirty.text).toContain('lex: STALE? — since no-git, 1 artifact: lexer.ts changed → reverify(lex) if it still holds, refute(lex) if not')
    expect(dirty.text).toContain('doc: intact')
    expect(dirty.text).toContain('(1 judgment(s) resting on changed artifacts)')

    // provenance survives the file round-trip
    const history = await call(client, 'graph_history')
    expect(history.text).toContain('Verify(lex)=valid — evidence: vitest lexer.ts: 12 passed [pinned no-git, 1 artifact]')
  })

  it('issues: findings are recorded with detail, closed with an outcome, listed open-first, and counted in the standing line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'authz', content: 'authz correct', successor: 'target' })
    const opened = await call(client, 'issue_open', {
      key: 'AUTHZ-1',
      title: 'scripted revoke drops the recovery slot',
      node: 'authz',
      severity: 'Med',
      detail: 'src/main.rs revoke treats every prompt error as "leave empty"…\nRecommended fix: distinguish empty from error.',
    })
    expect(opened.text).toContain('Applied: Issue(AUTHZ-1)')
    expect(opened.text).toContain('Issues: 1 open.')
    const assigned = await call(client, 'issue_open', { title: 'no dirsync after rename' })
    expect(assigned.text).toContain('Applied: Issue(I1)')
    expect(assigned.text).toContain('Issues: 2 open.')
    const dup = await call(client, 'issue_open', { key: 'AUTHZ-1', title: 'again' })
    expect(dup.text).toContain('already open')
    const unknownNode = await call(client, 'issue_open', { title: 'x', node: 'nope' })
    expect(unknownNode.text).toContain('does not exist')

    let list = await call(client, 'issue_list')
    expect(list.text).toContain('Issues (2 open, 0 closed):')
    expect(list.text).toContain('- AUTHZ-1 [open] Med on authz: scripted revoke drops the recovery slot')
    expect(list.text).not.toContain('Recommended fix')
    const one = await call(client, 'issue_list', { key: 'AUTHZ-1' })
    expect(one.text).toContain('Recommended fix: distinguish empty from error.')

    const closed = await call(client, 'issue_close', { key: 'AUTHZ-1', outcome: 'fixed', resolution: 'errors now abort the revoke; test added' })
    expect(closed.text).toContain('Applied: Close(AUTHZ-1)=fixed')
    expect(closed.text).toContain('Issues: 1 open.')
    expect((await call(client, 'issue_close', { key: 'AUTHZ-1', outcome: 'fixed' })).text).toContain('is not open')
    list = await call(client, 'issue_list')
    expect(list.text).toContain('Issues (1 open, 1 closed):')
    expect(list.text.indexOf('- I1 [open]')).toBeLessThan(list.text.indexOf('- AUTHZ-1 [fixed]'))
    expect(list.text).toContain('closed at #4: errors now abort the revoke; test added')

    // the graph never moved
    const state = await call(client, 'graph_state')
    expect(state.text).toContain('- authz [pending')
  })

  it('reverify re-judges in one call; the standing line counts stale judgments and names claims ready to re-verify; a root verify over stale parts is warned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'lib.ts'), 'v1\n')
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'a', content: 'lib works', successor: 'target' })
    await call(client, 'add', { id: 'b', content: 'docs ok', successor: 'target' })
    const first = await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'lib.ts reviewed' })
    expect(first.text).not.toContain('Stale:')
    // the code moves under the judgment: the very next operation says so
    writeFileSync(join(dir, 'lib.ts'), 'v2\n')
    const found = await call(client, 'verify', { id: 'b', result: 'invalid', evidence: 'typo in docs' })
    expect(found.text).toContain('Stale: 1 judgment(s) rest on changed code')
    // an issue on b, closed: b becomes ready to re-verify
    await call(client, 'issue_open', { key: 'D-1', title: 'typo', node: 'b' })
    const closed = await call(client, 'issue_close', { key: 'D-1', outcome: 'fixed', resolution: 'fixed the typo' })
    expect(closed.text).toContain('Ready to re-verify (issues all closed): b.')
    const bOk = await call(client, 'verify', { id: 'b', result: 'valid', evidence: 'docs re-read' })
    expect(bOk.text).not.toContain('Ready to re-verify')
    // the root over a stale part: allowed, warned
    const root = await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold' })
    expect(root.text).toContain('Audit: 1 judgment(s) beneath the root rest on code that changed')
    // one call re-anchors a
    const re = await call(client, 'reverify', { id: 'a', evidence: 'lib.ts re-reviewed on the new version' })
    expect(re.text).toContain('Applied: Doubt(a) [Reverify(a)] (evidence: lib.ts re-reviewed on the new version); Verify(a)=valid [Reverify(a)] (evidence: lib.ts re-reviewed on the new version) [pinned no-git, 1 artifact]')
    expect(re.text).toContain('Root target: SOLID')
    expect(re.text).not.toContain('Stale:')
    expect((await call(client, 'reverify', { id: 'b', evidence: 'x' })).text).not.toContain('Rejected') // b is valid now → fine
    expect((await call(client, 'reverify', { id: 'ghost', evidence: 'x' })).text).toContain('Rejected')
  })

  it('refute withdraws and judges in one call; a group claim citing only its parts gets no 0-artifact warning; graph_audit shows hunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const { writeFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    git('init', '-q')
    writeFileSync(join(dir, 'lib.ts'), 'export function parse(s: string) {\n  return s\n}\n\nexport function render(x: string) {\n  return x\n}\n')
    writeFileSync(join(dir, '.gitignore'), 'ddag.json\n')
    git('add', '.')
    git('commit', '-q', '-m', 'v1')
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'lib', content: 'lib parses', successor: 'target' })
    await call(client, 'verify', { id: 'lib', result: 'valid', evidence: 'lib.ts reviewed' })
    // the group claim rests on its part: no warning about artifacts
    const group = await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'its one part, lib, holds and is the whole target' })
    expect(group.text).not.toContain('0 artifacts pinned')
    expect(group.text).toContain('[pinned @')
    let audit = await call(client, 'graph_audit')
    expect(audit.text).toContain('- target: rests on its 1 part(s)')
    expect(audit.text).toContain('1 resting on parts')
    // the code moves in one function; the audit says which
    writeFileSync(join(dir, 'lib.ts'), 'export function parse(s: string) {\n  return s.trim()\n}\n\nexport function render(x: string) {\n  return x\n}\n')
    audit = await call(client, 'graph_audit')
    expect(audit.text).toContain('- lib: STALE? — since')
    expect(audit.text).toContain('lib.ts: +1/-1 in')
    expect(audit.text).toContain('parse')
    expect(audit.text).not.toContain('render')
    // a finding refutes the claim in one call
    const r = await call(client, 'refute', { id: 'lib', evidence: 'parse drops leading spaces the spec keeps — lib.ts' })
    expect(r.text).toContain('Applied: Doubt(lib) [Refute(lib)] (evidence: parse drops leading spaces the spec keeps — lib.ts); Verify(lib)=invalid [Refute(lib)]')
    expect(r.text).toContain('Root target: broken')
    expect(r.text).toContain('Frontier (best judgment first): lib')
    expect((await call(client, 'refute', { id: 'lib', evidence: 'again' })).text).toContain('Rejected')
  })

  it('protocol nudge: a finding or refutation on a claim with parts names the property it should land on; a leaf gets none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'authz', content: 'authz is correct', successor: 'target' })
    await call(client, 'add', { id: 'revoked-cannot-read', content: 'a revoked device cannot read the vault', successor: 'authz' })
    const onGroup = await call(client, 'issue_open', { title: 'revoke drops recovery', node: 'authz' })
    expect(onGroup.text).toContain('Applied: Issue(I1)')
    expect(onGroup.text).toContain('Protocol: authz is a group with 1 part(s) (revoked-cannot-read). A finding belongs on the property it refutes')
    const onLeaf = await call(client, 'issue_open', { title: 'revoke drops recovery', node: 'revoked-cannot-read' })
    expect(onLeaf.text).not.toContain('Protocol:')
    await call(client, 'verify', { id: 'revoked-cannot-read', result: 'valid', evidence: 'tested' })
    await call(client, 'verify', { id: 'authz', result: 'valid', evidence: 'its part holds' })
    const refuteGroup = await call(client, 'refute', { id: 'authz', evidence: 'a finding' })
    expect(refuteGroup.text).toContain('A refutation belongs on the property it refutes')
    const invalidLeaf = await call(client, 'verify', { id: 'revoked-cannot-read', result: 'invalid', evidence: 'x' })
    expect(invalidLeaf.text).not.toContain('Protocol:')
  })

  it('restructure gives a topic its property parts in one call, all-or-nothing; the self-fix nudge names the issues this session closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'authz', content: 'authz is correct', successor: 'target', verify: 'we read it' })
    const parts = [
      { id: 'revoked-cannot-read', claim: 'a revoked device cannot read the vault', verify: 'interleaving test: revoke then open with the old blob fails', rationale: 'found by round 1' },
      { id: 'rotation-atomic', claim: 'rotation survives a crash after every write', verify: 'crash injection after each durable write' },
    ]
    const r = await call(client, 'restructure', { node: 'authz', parts })
    expect(r.text).toContain('Applied: Add(revoked-cannot-read) [Restructure(authz)] (rationale: found by round 1); Add(rotation-atomic) [Restructure(authz)]')
    expect(r.text).toContain('Frontier (best judgment first): revoked-cannot-read, rotation-atomic')
    const state = await call(client, 'graph_state')
    expect(state.text).toContain('verify: interleaving test: revoke then open with the old blob fails')
    // all-or-nothing: a duplicate part id refuses before anything is written
    const dup = await call(client, 'restructure', { node: 'authz', parts: [{ id: 'fresh', claim: 'x', verify: 'y' }, { id: 'rotation-atomic', claim: 'x', verify: 'y' }] })
    expect(dup.text).toContain('Rejected: restructure: node "rotation-atomic" already exists')
    expect((await call(client, 'graph_state')).text).not.toContain('- fresh ')
    expect((await call(client, 'restructure', { node: 'ghost', parts: [{ id: 'a1', claim: 'x', verify: 'y' }] })).text).toContain('Rejected')

    // the self-fix nudge: close an issue here, then verify the claim
    await call(client, 'issue_open', { key: 'R-1', title: 'old blob still opens', node: 'revoked-cannot-read' })
    await call(client, 'verify', { id: 'revoked-cannot-read', result: 'invalid', evidence: 'R-1' })
    await call(client, 'issue_close', { key: 'R-1', outcome: 'fixed', resolution: 'rotation now re-wraps' })
    const own = await call(client, 'verify', { id: 'revoked-cannot-read', result: 'valid', evidence: 'test green' })
    expect(own.text).toContain('Protocol: this session closed R-1 on revoked-cannot-read — a fixer re-verifying its own fix')
    // a claim whose issue this session did not close gets no nudge
    const other = await call(client, 'verify', { id: 'rotation-atomic', result: 'valid', evidence: 'crash fuzz green' })
    expect(other.text).not.toContain('Protocol:')
    // reverify carries it too
    const again = await call(client, 'reverify', { id: 'revoked-cannot-read', evidence: 'independent re-examination by a fresh subagent: test re-run' })
    expect(again.text).toContain('a fixer re-verifying its own fix')
  })

  it('versions: version_mark records the commit and warns on a dirty tree; version_list reads the state from the chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const { writeFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'working version')
    const head = git('rev-parse', 'HEAD')
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'a', content: 'part a', successor: 'target' })
    await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'checked' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'parts hold' })
    // the chain file itself is untracked → dirty tree, which is the expected first-mark situation
    const marked = await call(client, 'version_mark', { name: 'v0.1', note: 'first cut' })
    expect(marked.text).toContain('Applied: Version(v0.1) (note: first cut)')
    expect(marked.text).toContain('marked on a dirty tree')
    writeFileSync(join(dir, '.gitignore'), 'ddag.json\n')
    git('add', '.gitignore')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore chain')
    const clean = await call(client, 'version_mark', { name: 'v0.2' })
    expect(clean.text).not.toContain('dirty')
    expect((await call(client, 'version_mark', { name: 'v0.2' })).text).toContain('already marked')
    const list = await call(client, 'version_list')
    expect(list.text).toContain(`- v0.1 @${head.slice(0, 7)}* at event 4: root solid, 0 open issue(s), 1 event(s) since — first cut`)
    expect(list.text.indexOf('v0.2')).toBeLessThan(list.text.indexOf('v0.1'))
    const state = await call(client, 'graph_state')
    expect(state.text).toContain('Root target: SOLID')
  })

  it('P5: the chain a judgment is recorded in is never pinned — it changes with every operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'lib.ts'), 'l1\n')
    const client = await connect(new McpStore(join(dir, 'ddag.json'), dir), dir)
    await call(client, 'add', { id: 'a', content: 'lib ok', successor: 'target' })
    await call(client, 'add', { id: 'b', content: 'also ok', successor: 'target' })
    const r = await call(client, 'verify', { id: 'a', result: 'valid', evidence: 'lib.ts checked; the chain is ddag.json' })
    expect(r.text).toContain('[pinned no-git, 1 artifact]')
    expect(r.text).toContain("'ddag.json' is the chain itself — not pinned")
    // the next operation grows the chain — the judgment must stay intact
    await call(client, 'verify', { id: 'b', result: 'valid', evidence: 'argued' })
    const audit = await call(client, 'graph_audit')
    expect(audit.text).toContain('a: intact — 1 artifact(s)')
    expect(audit.text).not.toContain('STALE?')
  })

  it('P5: bare basenames resolve when unique, warn when ambiguous; 0-artifact pins are called out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ddag-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, 'deep', 'er'), { recursive: true })
    mkdirSync(join(dir, 'other'), { recursive: true })
    writeFileSync(join(dir, 'deep', 'er', 'parser.ts'), 'p1\n')
    writeFileSync(join(dir, 'deep', 'util.ts'), 'u1\n')
    writeFileSync(join(dir, 'other', 'util.ts'), 'u2\n')
    const client = await connect(new McpStore(join(dir, 'chain.json'), dir), dir)
    await call(client, 'add', { id: 'p', content: 'parser ok', successor: 'target' })
    await call(client, 'add', { id: 'u', content: 'util ok', successor: 'target' })
    await call(client, 'add', { id: 'z', content: 'argued', successor: 'target' })

    const unique = await call(client, 'verify', { id: 'p', result: 'valid', evidence: 'vitest parser.ts: green' })
    expect(unique.text).toContain('[pinned no-git, 1 artifact]')
    expect(unique.text).not.toContain('Provenance:')

    const ambiguous = await call(client, 'verify', { id: 'u', result: 'valid', evidence: 'vitest util.ts: green' })
    expect(ambiguous.text).toContain('[pinned no-git, 0 artifacts]')
    expect(ambiguous.text).toContain("'util.ts' is ambiguous (deep/util.ts, other/util.ts) — cite the full path")

    const bare = await call(client, 'verify', { id: 'z', result: 'valid', evidence: 'reviewed the argument' })
    expect(bare.text).toContain('0 artifacts pinned — cite file paths')

    const audit = await call(client, 'graph_audit')
    expect(audit.text).toContain('p: intact — 1 artifact(s)')
    expect(audit.text).toContain('u: unwatched — pinned to no-git, 0 artifacts but no artifacts cited')
    expect(audit.text).toContain('z: unwatched')
    expect(audit.text).toContain('(0 judgment(s) resting on changed artifacts, 2 unwatched)')

    writeFileSync(join(dir, 'deep', 'er', 'parser.ts'), 'p2\n')
    expect((await call(client, 'graph_audit')).text).toContain('p: STALE? — since no-git, 1 artifact: deep/er/parser.ts changed')
  })

  it('claims carry their criterion; the state report shows claim, criterion, because, and judgment', async () => {
    const client = await connect(new McpStore(tmpFile()))
    const bare = await call(client, 'add', { id: 'a', content: 'lexer is correct', successor: 'target' })
    expect(bare.text).toContain('no verification criterion recorded')
    const withCrit = await call(client, 'add', {
      id: 'b',
      content: 'grammar is complete',
      successor: 'target',
      verify: 'every construct in the spec parses; prediction: left recursion is the risk',
      rationale: 'the parser cannot be judged without it',
    })
    expect(withCrit.text).not.toContain('no verification criterion')
    await call(client, 'verify', { id: 'b', result: 'valid', evidence: 'Parsed all 40 spec constructs; left recursion handled by the loop form.' })
    const state = (await call(client, 'graph_state')).text
    expect(state).toContain('- b [valid, solid]')
    expect(state).toContain('    claim: grammar is complete')
    expect(state).toContain('    verify: every construct in the spec parses; prediction: left recursion is the risk')
    expect(state).toContain('    because: the parser cannot be judged without it')
    expect(state).toContain('    judged: valid — Parsed all 40 spec constructs')
    expect(state).toContain('    verify: (no criterion recorded)') // node a
    expect(state).toContain('    judged: never')
    // the criterion is fingerprinted: restating it reopens the judgment
    const restated = await call(client, 'mutate', { id: 'b', content: 'grammar is complete', verify: 'every construct parses AND round-trips through the printer' })
    expect(restated.text).toContain('b: valid→pending')
  })

  it('standing ranks the frontier by the one-step lookahead, winning move first', async () => {
    const client = await connect(new McpStore(tmpFile()))
    // c1 -> m -> target and d -> target: judging c1 unlocks m; d unlocks nothing
    await call(client, 'add', { id: 'm', content: 'middle claim', successor: 'target' })
    await call(client, 'add', { id: 'c1', content: 'deep claim', successor: 'm' })
    const state = await call(client, 'add', { id: 'd', content: 'flat claim', successor: 'target' })
    expect(state.text).toContain('Frontier (best judgment first): c1 (unlocks 1), d')

    // a confirmed-doubt tower: the boundary judgment advertises the win
    await call(client, 'verify', { id: 'c1', result: 'valid', evidence: 'deep tests: green' })
    await call(client, 'verify', { id: 'm', result: 'valid', evidence: 'middle tests: green' })
    await call(client, 'verify', { id: 'd', result: 'valid', evidence: 'flat tests: green' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'e2e: green' })
    const doubted = await call(client, 'doubt', { id: 'd', evidence: 'flat tests aged' })
    expect(doubted.text).toContain('Frontier (best judgment first): d (WINS — root turns solid)')
  })

  it('narrates consequences: mutate cascade and restore', async () => {
    const client = await connect(new McpStore(tmpFile()))
    await call(client, 'add', { content: 'leaf claim', successor: 'target' })
    await call(client, 'verify', { id: 'n1', result: 'valid', evidence: 'leaf tests: green' })
    await call(client, 'verify', { id: 'target', result: 'valid', evidence: 'e2e: green' })

    const mut = await call(client, 'mutate', { id: 'n1', content: 'leaf claim v2' })
    expect(mut.text).toContain('target: valid→pending')

    const rev = await call(client, 'revert', { id: 'n1' })
    expect(rev.isError).toBe(false)
    expect(rev.text).toContain('[Revert(n1)]')
    expect(rev.text).toContain('SOLID')
  })

  it('rejects illegal operations with the kernel reason', async () => {
    const client = await connect(new McpStore(tmpFile()))
    const r = await call(client, 'verify', { id: 'ghost', result: 'valid', evidence: 'n/a' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('does not exist')
  })

  it('doubt reopens; graph_state and graph_history report it', async () => {
    const client = await connect(new McpStore(tmpFile()))
    await call(client, 'add', { content: 'claim', successor: 'target' })
    await call(client, 'verify', { id: 'n1', result: 'valid', evidence: 'claim tests: green' })
    const d = await call(client, 'doubt', { id: 'n1', evidence: 'tests aged after refactor' })
    expect(d.text).toContain('Doubt(n1)')

    const state = await call(client, 'graph_state')
    expect(state.text).toContain('n1 [pending]')
    expect(state.text).toContain('no fingerprint')

    const history = await call(client, 'graph_history')
    expect(history.text).toContain('Doubt(n1)')
  })


  it('enforces P2: verify without an evidence citation is refused by the shell', async () => {
    const client = await connect(new McpStore(tmpFile()))
    await call(client, 'add', { content: 'claim', successor: 'target' })
    const failed = await client
      .callTool({ name: 'verify', arguments: { id: 'n1', result: 'valid' } })
      .then((r) => r.isError === true)
      .catch(() => true)
    expect(failed).toBe(true)
    const state = await call(client, 'graph_state')
    expect(state.text).toContain('n1 [pending]') // nothing was recorded
  })

  it('records citations on the chain: narration and history carry them, replay preserves them', async () => {
    const file = tmpFile()
    const client = await connect(new McpStore(file))
    await call(client, 'add', { content: 'claim', successor: 'target' })
    const v = await call(client, 'verify', { id: 'n1', result: 'valid', evidence: 'vitest: 9 passed' })
    expect(v.text).toContain('(evidence: vitest: 9 passed)')

    await call(client, 'doubt', { id: 'n1', evidence: 'suite predates the refactor' })
    const history = await call(client, 'graph_history')
    expect(history.text).toContain('Verify(n1)=valid — evidence: vitest: 9 passed')
    expect(history.text).toContain('Doubt(n1) — evidence: suite predates the refactor')

    const client2 = await connect(new McpStore(file)) // restart: citations survive replay
    const history2 = await call(client2, 'graph_history')
    expect(history2.text).toContain('evidence: vitest: 9 passed')
  })

  it('records rationale on structural decisions, labeled apart from judgment evidence', async () => {
    const client = await connect(new McpStore(tmpFile()))
    const a = await call(client, 'add', {
      content: 'part claim',
      successor: 'target',
      rationale: "target's argument had an untracked because",
    })
    expect(a.text).toContain("(rationale: target's argument had an untracked because)")

    await call(client, 'add', { content: 'sub', successor: 'n1' })
    const d = await call(client, 'discard', { id: 'n1', rationale: 'dead end after review' })
    expect(d.text).toContain('(rationale: dead end after review)')

    const history = await call(client, 'graph_history')
    expect(history.text).toContain("Add(n1) — rationale: target's argument had an untracked because")
    expect(history.text).toContain('[Discard(n1)] — rationale: dead end after review')
  })

  it('persists across restarts via chain replay', async () => {
    const file = tmpFile()
    const client1 = await connect(new McpStore(file))
    await call(client1, 'add', { content: 'persistent claim', successor: 'target' })
    await call(client1, 'verify', { id: 'n1', result: 'valid', evidence: 'suite: green' })

    const client2 = await connect(new McpStore(file)) // fresh store, same file
    const state = await call(client2, 'graph_state')
    expect(state.text).toContain('n1 [valid, solid]')
    expect(state.text).toContain('persistent claim')
  })

  it('composites narrate their whole expansion under the marker', async () => {
    const client = await connect(new McpStore(tmpFile()))
    await call(client, 'add', { content: 'p1', successor: 'target' })
    await call(client, 'add', { content: 'p2', successor: 'target' })
    await call(client, 'add', { content: 'dup', successor: 'n1' })
    await call(client, 'link', { from: 'n3', to: 'n2' })
    await call(client, 'add', { content: 'canon', successor: 'target' })

    const m = await call(client, 'merge', { dup: 'n3', canon: 'n4' })
    expect(m.isError).toBe(false)
    expect(m.text).toContain('[Merge(n3->n4)]')
    expect(m.text).toContain('dropped n3')
  })
})
