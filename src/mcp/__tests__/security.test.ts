import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EventChain } from '../../chain/chain'
import { chainPathWithin } from '../containment'
import { withFileLock, lockPathFor } from '../lock'
import { auditChain, collectProvenance } from '../provenance'
import { McpStore } from '../store'

const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-sec-'))

describe('security: the MCP shell on hostile input', () => {
  it('sec-containment: explicit artifacts and cited paths outside the root are never pinned', () => {
    const root = join(scratch(), 'proj')
    mkdirSync(root)
    writeFileSync(join(root, 'ok.ts'), 'fine')
    const secret = join(scratch(), 'secret.txt')
    writeFileSync(secret, 'TOP SECRET')
    // explicit artifacts outside the root: refused, with the reason; and since explicit artifacts are
    // the whole pin set (PIN-2), nothing else is pinned in their place
    const c = collectProvenance(`reviewed ok.ts and ../secret.txt and ${secret}`, ['../secret.txt', secret], root)
    expect(c.provenance.artifacts.map((a) => a.path)).toEqual([])
    expect(c.warnings.join(' ')).toContain('not found under the project root')
    // paths cited in prose outside the root: never pinned; the one inside is
    const prose = collectProvenance(`reviewed ok.ts and ../secret.txt and ${secret}`, [], root)
    expect(prose.provenance.artifacts.map((a) => a.path)).toEqual(['ok.ts'])
    // an explicit inside path beside an outside one: only the inside one
    const mixed = collectProvenance('x', ['ok.ts', secret], root)
    expect(mixed.provenance.artifacts.map((a) => a.path)).toEqual(['ok.ts'])
  })

  it('sec-containment: a symlink inside the root that points outside is not pinned as the target', () => {
    const root = join(scratch(), 'proj')
    mkdirSync(root)
    const secret = join(scratch(), 'secret.txt')
    writeFileSync(secret, 'TOP SECRET')
    symlinkSync(secret, join(root, 'link.txt'))
    const c = collectProvenance('reviewed link.txt', [], root)
    const pinned = c.provenance.artifacts.find((a) => a.path === 'link.txt')
    const outsideHash = createHash('sha256').update('TOP SECRET').digest('hex')
    expect(pinned?.hash).not.toBe(outsideHash)
  })

  it('sec-corrupt-chain: an unreadable chain file is refused, never overwritten with a fresh graph', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    writeFileSync(file, '{"initial": {"root": "t", "nodes": [')
    const before = readFileSync(file, 'utf8')
    const store = new McpStore(file, dir)
    const r = store.dispatch({ type: 'add', id: 'a', content: 'a', successor: 'target' })
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('sec-corrupt-chain: a chain whose events do not replay is refused, never overwritten', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const good = EventChain.create('t', 'the target')
    good.dispatch({ type: 'add', id: 'a', content: 'a', successor: 't' })
    const dump = good.dump()
    dump.events.push({ seq: 2, prev: 1, op: { type: 'verify', id: 'ghost', result: 'valid' } })
    writeFileSync(file, JSON.stringify(dump))
    const before = readFileSync(file, 'utf8')
    const store = new McpStore(file, dir)
    const r = store.dispatch({ type: 'add', id: 'b', content: 'b', successor: 'target' })
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('sec-git-args: a commit hash or artifact path from the chain never reaches git as an option', () => {
    const dir = scratch()
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
    git('init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'v1')
    const target = join(scratch(), 'pwned.txt')
    const chain = EventChain.create('t', 'the target')
    chain.dispatch({ type: 'add', id: 'a', content: 'a', successor: 't' })
    chain.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'a.txt', {
      head: `--output=${target}`,
      dirty: false,
      artifacts: [{ path: 'a.txt', hash: 'stale-hash-so-it-is-stale' }],
      root: dir,
    })
    const audit = auditChain(chain, dir, { diffs: true })
    expect(audit.nodes['a']!.status).toBe('stale')
    expect(existsSync(target)).toBe(false)
  })

  it('sec-containment: a recorded provenance root outside the opened folder does not steer the audit there', () => {
    const a = join(scratch(), 'a')
    mkdirSync(a)
    const b = join(scratch(), 'b')
    mkdirSync(b)
    writeFileSync(join(b, 'secret.ts'), 'export function originalSecretFunction() {}\n')
    const secretHash = createHash('sha256').update(readFileSync(join(b, 'secret.ts'))).digest('hex')
    const chain = EventChain.create('t', 'the target')
    chain.dispatch({ type: 'add', id: 'x', content: 'x', successor: 't' })
    chain.dispatch({ type: 'verify', id: 'x', result: 'valid' }, undefined, 'secret.ts', { artifacts: [{ path: 'secret.ts', hash: secretHash }], root: b })
    const audit = auditChain(chain, a, { diffs: true })
    // never "intact": the audit must not have hashed b/secret.ts
    expect(audit.nodes['x']!.status).toBe('stale')
    expect(audit.nodes['x']!.missing).toEqual(['secret.ts'])
    expect(audit.nodes['x']!.diffs ?? []).toEqual([])
  })

  it('sec-containment: a symlinked directory inside the working directory cannot take the chain outside it', () => {
    const cwd = join(scratch(), 'cwd')
    mkdirSync(cwd)
    const elsewhere = join(scratch(), 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(cwd, 'sub'))
    expect(chainPathWithin(cwd, 'sub/ddag.json')).toBeNull()
    expect(chainPathWithin(cwd, 'ddag.json')).toBe(join(cwd, 'ddag.json'))
    expect(chainPathWithin(cwd, 'nested/ddag.json')).toBe(join(cwd, 'nested', 'ddag.json'))
    expect(chainPathWithin(cwd, '../ddag.json')).toBeNull()
  })

  it('sec-corrupt-chain: valid JSON that is not a chain gets the refusal text from every report, never a raw error', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    writeFileSync(file, '{}')
    const store = new McpStore(file, dir)
    for (const report of [() => store.stateReport(), () => store.historyReport({ limit: 20 }), () => store.auditReport(), () => store.issuesReport(), () => store.versionsReport()]) {
      let text = ''
      expect(() => (text = report())).not.toThrow()
      expect(text).toContain('Refused: the chain file')
    }
    expect(readFileSync(file, 'utf8')).toBe('{}')
  })

  it('sec-lock: a garbage lock file with an old mtime is reclaimed; a fresh foreign lock makes the caller wait then fail', () => {
    const dir = scratch()
    const file = join(dir, 'ddag.json')
    const lock = lockPathFor(file)
    writeFileSync(lock, 'not a pid at all ##### garbage')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(withFileLock(file, () => 'ran', { staleMs: 10_000 })).toBe('ran')
    expect(existsSync(lock)).toBe(false)
    writeFileSync(lock, 'someone else')
    const t0 = Date.now()
    expect(() => withFileLock(file, () => 'ran', { timeoutMs: 150, staleMs: 60_000 })).toThrow(/locked by another ddag session/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
  })
})
