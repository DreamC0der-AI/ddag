import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EventChain } from '../../chain/chain'
import { auditChain, collectProvenance, diffSincePin } from '../provenance'

const scratch = () => mkdtempSync(join(tmpdir(), 'ddag-audit-'))
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

const RUST = `pub fn seal(key: &[u8]) -> Vec<u8> {
    key.to_vec()
}

pub fn sanitize_label(s: &str) -> String {
    s.trim().to_string()
}
`

describe('audit — what changed under a judgment, and what a judgment rests on', () => {
  it('names the function a stale file changed in, with line counts, from the pinned commit', () => {
    const dir = scratch()
    git(dir, 'init', '-q')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'auth.rs'), RUST)
    writeFileSync(join(dir, '.gitignore'), 'ddag.json\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'v1')
    const chain = EventChain.create('target', 'the target')
    chain.dispatch({ type: 'add', id: 'authz', content: 'labels are safe', successor: 'target' })
    const pin = collectProvenance('reviewed src/auth.rs', [], dir).provenance
    expect(pin.head).toBeDefined()
    expect(pin.dirty).toBe(false)
    chain.dispatch({ type: 'verify', id: 'authz', result: 'valid' }, undefined, 'reviewed src/auth.rs', pin)
    // clean tree → intact
    expect(auditChain(chain, dir).nodes['authz']).toMatchObject({ status: 'intact' })
    // edit one function only
    writeFileSync(join(dir, 'src', 'auth.rs'), RUST.replace('s.trim().to_string()', 's.trim().chars().filter(|c| !c.is_control()).collect()'))
    const cheap = auditChain(chain, dir)
    expect(cheap.nodes['authz']).toMatchObject({ status: 'stale', changed: ['src/auth.rs'] })
    expect(cheap.nodes['authz']!.diffs).toBeUndefined() // not asked for — git is not free
    const rich = auditChain(chain, dir, { diffs: true })
    const d = rich.nodes['authz']!.diffs!
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ path: 'src/auth.rs', added: 1, removed: 1, approximate: false })
    expect(d[0]!.where.join(' ')).toContain('sanitize_label')
    expect(d[0]!.where.join(' ')).not.toContain('seal')
  })

  it('marks a dirty-tree pin approximate, and says nothing about hunks without a commit', () => {
    const dir = scratch()
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'v1')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n') // dirty at pin time
    const chain = EventChain.create('target', 'the target')
    chain.dispatch({ type: 'add', id: 'a', content: 'a', successor: 'target' })
    chain.dispatch({ type: 'verify', id: 'a', result: 'valid' }, undefined, 'a.txt', collectProvenance('a.txt', [], dir).provenance)
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const a = auditChain(chain, dir, { diffs: true }).nodes['a']!
    expect(a.status).toBe('stale')
    expect(a.diffs![0]).toMatchObject({ path: 'a.txt', approximate: true })
    expect(a.diffs![0]!.added).toBeGreaterThanOrEqual(1)
    // no repository at all: change reported, no hunks
    const plain = scratch()
    writeFileSync(join(plain, 'b.txt'), 'x\n')
    const c2 = EventChain.create('target', 'the target')
    c2.dispatch({ type: 'add', id: 'b', content: 'b', successor: 'target' })
    c2.dispatch({ type: 'verify', id: 'b', result: 'valid' }, undefined, 'b.txt', collectProvenance('b.txt', [], plain).provenance)
    writeFileSync(join(plain, 'b.txt'), 'y\n')
    const b = auditChain(c2, plain, { diffs: true }).nodes['b']!
    expect(b).toMatchObject({ status: 'stale', changed: ['b.txt'] })
    expect(b.diffs).toBeUndefined() // no commit to diff from
    expect(diffSincePin(plain, 'deadbeef', 'b.txt')).toBeNull()
  })

  it('TypeScript hunks are named by the function or method changed, not the nearest top-level line', () => {
    const dir = scratch()
    git(dir, 'init', '-q')
    const TS = `import { x } from './x'\n\nconst INSTRUCTIONS = \`\nline one\nline two\n\`\n\nexport class Store {\n  private n = 0\n\n  standing(): string {\n    return 'a'\n  }\n\n  auditReport(): string {\n    const g = 1\n    return String(g)\n  }\n}\n\nexport function helper(a: number): number {\n  if (a > 1) {\n    return a\n  }\n  return 0\n}\n`
    writeFileSync(join(dir, 'store.ts'), TS)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'v1')
    writeFileSync(join(dir, 'store.ts'), TS.replace('line two', 'line two changed').replace("return 'a'", "return 'b'").replace('return 0', 'return -1'))
    const d = diffSincePin(dir, git(dir, 'rev-parse', 'HEAD'), 'store.ts')!
    expect(d.where).toEqual(['const INSTRUCTIONS', 'standing', 'export function helper'])
  })

  it('a path written relative to the repository top is pinned root-relative when it lands inside the project root', () => {
    const repo = scratch()
    git(repo, 'init', '-q')
    mkdirSync(join(repo, 'testcases', 'game', 'src'), { recursive: true })
    writeFileSync(join(repo, 'testcases', 'game', 'src', 'ai.ts'), 'ai')
    writeFileSync(join(repo, 'README.md'), 'top')
    const root = join(repo, 'testcases', 'game')
    const c = collectProvenance('reviewed testcases/game/src/ai.ts and README.md', ['testcases/game/src/ai.ts'], root)
    expect(c.provenance.artifacts.map((a) => a.path)).toEqual(['src/ai.ts'])
    // a repository file outside the project root is still not pinned
    expect(c.provenance.artifacts.some((a) => a.path.includes('README'))).toBe(false)
    const outside = collectProvenance('x', ['README.md'], root)
    expect(outside.warnings.join(' ')).toContain('paths are relative to it')
  })

  it('a folder pin leaves out the chain file: not stale on the event that records it, and code under the folder is still watched (WT-1)', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'greet.sh'), 'echo hello\n')
    const chainFile = join(dir, 'ddag.json')
    writeFileSync(chainFile, '{"events":[]}')
    const chain = EventChain.create('target', 'the target')
    chain.dispatch({ type: 'add', id: 'n1', content: 'greet works', successor: 'target' })
    const { provenance: pin, warnings } = collectProvenance(`ran ./greet.sh in ${dir}`, [], dir, chainFile)
    expect(pin.artifacts.map((a) => a.path)).toEqual(['.', 'greet.sh']) // the folder, and the file the prose names
    expect(warnings.join(' ')).not.toContain('chain itself')
    chain.dispatch({ type: 'verify', id: 'n1', result: 'valid' }, undefined, 'ran the folder', pin)
    // the recording event rewrites the chain file — the folder pin must not see it
    writeFileSync(chainFile, '{"events":[{"seq":1}]}')
    expect(auditChain(chain, dir, { chainFile }).nodes['n1']).toMatchObject({ status: 'intact' })
    // a second ddag.json that is not the chain is still part of the folder
    writeFileSync(join(dir, 'other-ddag.json'), '{}')
    expect(auditChain(chain, dir, { chainFile }).nodes['n1']).toMatchObject({ status: 'stale', changed: ['.'] })
    const pin2 = collectProvenance('ran the folder again', ['.'], dir, chainFile).provenance
    chain.dispatch({ type: 'doubt', id: 'n1' })
    chain.dispatch({ type: 'verify', id: 'n1', result: 'valid' }, undefined, 'ran the folder again', pin2)
    expect(auditChain(chain, dir, { chainFile }).nodes['n1']).toMatchObject({ status: 'intact' })
    // code under the folder moves: still watched
    writeFileSync(join(dir, 'greet.sh'), 'echo goodbye\n')
    expect(auditChain(chain, dir, { chainFile }).nodes['n1']).toMatchObject({ status: 'stale', changed: ['.'] })
  })

  it('a node with parts and no cited files rests on its parts; a leaf with none is unwatched', () => {
    const dir = scratch()
    const chain = EventChain.create('target', 'the target')
    chain.dispatch({ type: 'add', id: 'leaf', content: 'leaf', successor: 'target' })
    chain.dispatch({ type: 'add', id: 'group', content: 'group', successor: 'target' })
    chain.dispatch({ type: 'add', id: 'p1', content: 'p1', successor: 'group' })
    chain.dispatch({ type: 'add', id: 'p2', content: 'p2', successor: 'group' })
    const none = collectProvenance('argued', [], dir).provenance
    chain.dispatch({ type: 'verify', id: 'leaf', result: 'valid' }, undefined, 'argued', none)
    chain.dispatch({ type: 'verify', id: 'p1', result: 'valid' }, undefined, 'argued', none)
    chain.dispatch({ type: 'verify', id: 'p2', result: 'valid' }, undefined, 'argued', none)
    chain.dispatch({ type: 'verify', id: 'group', result: 'valid' }, undefined, 'both parts hold', none)
    const a = auditChain(chain, dir)
    expect(a.nodes['leaf']).toMatchObject({ status: 'unwatched' })
    expect(a.nodes['group']).toMatchObject({ status: 'parts', parts: 2 })
    expect(a.summary).toMatchObject({ valid: 4, unwatched: 3, parts: 1, stale: 0 })
  })
})
