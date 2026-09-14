import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { EventChain, Provenance } from '../chain/chain'
import type { NodeId } from '../kernel/types'

/**
 * Evidence provenance (doctrine hook P5): pin each judgment to the code state
 * its evidence was gathered against — git HEAD plus content hashes of the
 * artifacts the evidence cites — so `graph_audit` can later say which valid
 * judgments rest on artifacts that have since changed.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.playwright-mcp'])
const MAX_DIR_FILES = 500

function hashFile(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/** A directory hashes as the sorted list of (relative path, file hash) beneath it. */
export function hashPath(abs: string): string {
  if (statSync(abs).isFile()) return hashFile(abs)
  const h = createHash('sha256')
  const files: string[] = []
  const walk = (dir: string) => {
    if (files.length >= MAX_DIR_FILES) return
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue
      const p = join(dir, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue // a link may leave the root; a directory hash covers what is here
      if (st.isDirectory()) walk(p)
      else files.push(p)
      if (files.length >= MAX_DIR_FILES) return
    }
  }
  walk(abs)
  for (const f of files) h.update(relative(abs, f)).update('\0').update(hashFile(f)).update('\0')
  return h.digest('hex')
}

export function gitState(cwd: string): { head?: string; dirty?: boolean } {
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const head = git(['rev-parse', 'HEAD']).trim()
    const status = git(['status', '--porcelain'])
    return { head, dirty: status.trim().length > 0 }
  } catch {
    return {}
  }
}

const inside = (root: string, abs: string): boolean => abs === root || abs.startsWith(root + sep)

/**
 * Containment on real paths: a symlink inside the root that points outside
 * must not be pinned as its target (SEC-PIN-1). Returns the real path when
 * it lies under the real root, else null.
 */
function containedReal(root: string, abs: string): string | null {
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(abs)
    return inside(realRoot, real) ? real : null
  } catch {
    return null
  }
}

const MAX_INDEX_FILES = 5000

/** Every file under the root by basename — for resolving bare names like `lexer.ts`. */
function basenameIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>()
  let count = 0
  const walk = (dir: string) => {
    if (count >= MAX_INDEX_FILES) return
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const p = join(dir, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(p)
      else {
        if (!index.has(name)) index.set(name, [])
        index.get(name)!.push(relative(root, p))
        if (++count >= MAX_INDEX_FILES) return
      }
    }
  }
  walk(root)
  return index
}

export interface Cited {
  paths: string[]
  /** why some mentions could not be pinned — surfaced to the judge */
  warnings: string[]
}

/**
 * Paths the evidence text mentions: tokens that look like paths (contain a
 * slash, or carry a file extension). A token that does not resolve against
 * the root is looked up by basename across the project — people write
 * `balance.test.ts`, not its full path — and pinned when the name is
 * unique; an ambiguous name is reported, never guessed.
 */
/**
 * A path written relative to the repository top rather than the project
 * root — the habit of anyone whose project is a subfolder of a repository
 * — is accepted when it lands inside the project root, and pinned
 * root-relative (PIN-PATHS-1). Null when it does not.
 */
function fromRepoTop(root: string, token: string): string | null {
  const top = gitToplevel(root)
  if (top === null) return null
  const abs = resolve(top, token)
  if (!existsSync(abs)) return null
  const real = containedReal(root, abs)
  if (real === null) return null
  return relative(realpathSync(root), real) || '.'
}

export function citedPaths(evidence: string, root: string): Cited {
  const out = new Set<string>()
  const warnings: string[] = []
  let index: Map<string, string[]> | null = null
  for (const raw of evidence.split(/[\s,;()'"`]+/)) {
    const token = raw.replace(/[.:]+$/, '')
    if (token.length < 3) continue
    if (!token.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(token)) continue
    if (token.startsWith('http')) continue
    const abs = resolve(root, token)
    if (inside(root, abs) && existsSync(abs)) {
      if (containedReal(root, abs) === null) {
        warnings.push(`'${token}' is a link that leaves the project root — not pinned`)
        continue
      }
      out.add(relative(root, abs) || '.')
      continue
    }
    if (token.includes('/')) {
      const viaTop = fromRepoTop(root, token)
      if (viaTop !== null) out.add(viaTop)
      continue // otherwise a path that does not exist: not ours to guess
    }
    index ??= basenameIndex(root)
    const hits = index.get(token) ?? []
    if (hits.length === 1) out.add(hits[0]!)
    else if (hits.length > 1)
      warnings.push(`'${token}' is ambiguous (${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ', …' : ''}) — cite the full path`)
  }
  return { paths: [...out], warnings }
}

export interface Collected {
  provenance: Provenance
  warnings: string[]
}

/**
 * Pin the evidence's artifacts. `chainFile` is the chain this judgment is
 * being recorded in: it is never pinned, because it changes with every
 * later operation — a judgment that cited it would go stale on the next
 * event, and the chain cannot be evidence for a judgment inside it.
 */
export function collectProvenance(
  evidence: string,
  explicit: readonly string[],
  root: string,
  chainFile?: string,
): Collected {
  const cited = citedPaths(evidence, root)
  const paths = new Set<string>(cited.paths)
  const warnings = [...cited.warnings]
  for (const p of explicit) {
    const abs = resolve(root, p)
    if (inside(root, abs) && existsSync(abs)) {
      if (containedReal(root, abs) === null) warnings.push(`artifact '${p}' is a link that leaves the project root — not pinned`)
      else paths.add(relative(root, abs) || '.')
      continue
    }
    const viaTop = fromRepoTop(root, p)
    if (viaTop !== null) paths.add(viaTop)
    else warnings.push(`artifact '${p}' not found under the project root (${root}) — paths are relative to it; not pinned`)
  }
  if (chainFile !== undefined) {
    const chainAbs = resolve(chainFile)
    for (const p of [...paths]) {
      if (resolve(root, p) !== chainAbs) continue
      paths.delete(p)
      warnings.push(`'${p}' is the chain itself — not pinned (it changes with every operation, so citing it would mark this judgment stale at once)`)
    }
  }
  const artifacts = [...paths].sort().map((path) => ({ path, hash: hashPath(resolve(root, path)) }))
  if (artifacts.length === 0)
    warnings.push(
      '0 artifacts pinned — cite file paths in the evidence (or pass `artifacts`) so graph_audit can watch this judgment; as recorded it is unwatched',
    )
  return { provenance: { ...gitState(root), artifacts, root: resolve(root) }, warnings }
}

/** "@abc1234*, 3 artifacts" — the asterisk marks a dirty tree. */
export function pinLabel(p: Provenance): string {
  const head = p.head ? `@${p.head.slice(0, 7)}${p.dirty ? '*' : ''}` : 'no-git'
  return `${head}, ${p.artifacts.length} artifact${p.artifacts.length === 1 ? '' : 's'}`
}

/**
 * The directory a judgment's artifact paths are relative to. New pins say
 * so; older ones were relative to the MCP server's cwd, which is usually
 * the chain's folder but not always (this repository pins its test cases
 * from the repository root). Fallback: the chain's folder, then each parent,
 * taking the first under which every cited path exists.
 */
export function resolveRoot(p: Provenance, defaultRoot: string): string {
  const base = resolve(defaultRoot)
  // a recorded root comes from the chain file, which a repository can ship:
  // honour it only when it is the opened folder or an ancestor within the
  // same repository — never an unrelated directory (SEC-CONT-2)
  if (p.root) return isTrustedRoot(p.root, base) ? resolve(p.root) : base
  if (p.artifacts.length === 0) return base
  let dir = base
  for (;;) {
    if (p.artifacts.every((a) => existsSync(resolve(dir, a.path)))) return dir
    const parent = dirname(dir)
    if (parent === dir || !isTrustedRoot(parent, base)) return base
    dir = parent
  }
}

/** The opened folder itself, or one of its ancestors that lies within the same git repository. */
function isTrustedRoot(candidate: string, base: string): boolean {
  let real: string
  let realBase: string
  try {
    real = realpathSync(resolve(candidate))
    realBase = realpathSync(base)
  } catch {
    return false
  }
  if (real === realBase) return true
  if (!inside(real, realBase)) return false // must be an ancestor
  const top = gitToplevel(base)
  return top !== null && inside(top, real)
}

function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return realpathSync(out)
  } catch {
    return null
  }
}

/**
 * unpinned: judged without provenance · unwatched: a leaf pinned to no
 * files · parts: a node with parts pinned to no files — it rests on its
 * parts, which carry their own pins and reopen it when their claims change ·
 * intact · stale: cited files changed or vanished since the judgment.
 */
export type AuditStatus = 'unpinned' | 'unwatched' | 'parts' | 'intact' | 'stale'

/** What changed in one stale file since its pin, from git. */
export interface ArtifactDiff {
  path: string
  added: number
  removed: number
  /** hunk headers' context — the function or section each change falls in, deduplicated */
  where: string[]
  /** the pin was made on a dirty tree, so the diff from its commit is approximate */
  approximate: boolean
}

export interface NodeAudit {
  status: AuditStatus
  /** "@abc1234*, 3 artifacts" when pinned */
  pin?: string
  artifacts: number
  /** parts the node rests on, for status 'parts' */
  parts?: number
  changed: string[]
  missing: string[]
  /** per changed file, what changed since the pin — only when asked for (git is not free) */
  diffs?: ArtifactDiff[]
}

export interface ChainAudit {
  nodes: Record<NodeId, NodeAudit>
  summary: { valid: number; intact: number; stale: number; unwatched: number; parts: number; unpinned: number }
}

/**
 * The hunks of `path` between the pinned commit and the working tree. Hunk
 * headers carry git's function-name context ("@@ -10,3 +10,4 @@ fn seal"),
 * which is what a re-examination wants first. Empty when git cannot say.
 */
const NAME = '[A-Za-z_$][A-Za-z0-9_$]*'
/**
 * Function-name patterns for git's hunk headers. Git's built-in drivers
 * cover Rust, Python, Go and friends; TypeScript and JavaScript get a
 * pattern of their own, because the default heuristic names the nearest
 * top-level line (an import, a describe) rather than the method changed.
 * Negative lines (leading "!") keep control flow from posing as a name;
 * the first group is what git shows.
 */
const TS_XFUNCNAME = [
  '!^[ \\t]*(if|for|while|switch|catch|else|return|try|await)[ \\t(]',
  '!^[ \\t]+(const|let|var)[ \\t]', // a local binding is not a name; a top-level one is
  `^((export[ \\t]+)?(default[ \\t]+)?(async[ \\t]+)?(function[ \\t]*\\*?[ \\t]*${NAME}|(abstract[ \\t]+)?class[ \\t]+${NAME}|interface[ \\t]+${NAME}|type[ \\t]+${NAME}|enum[ \\t]+${NAME}|(const|let|var)[ \\t]+${NAME}))`,
  `^  (((static|async|public|private|protected|readonly|get|set|override)[ \\t]+)*${NAME})[ \\t]*(<[^>]*>)?[ \\t]*\\([^)]*\\)[ \\t]*(:[^{=]*)?[ \\t]*\\{[ \\t]*$`,
  // test blocks: the case a change falls in is what a reader wants
  `^[ \\t]*((it|test|describe)\\(['"\`][^'"\`]*)`,
].join('\n')
const SWIFT_XFUNCNAME = '^[ \\t]*(((public|private|internal|fileprivate|open|static|final|override|mutating)[ \\t]+)*(func|class|struct|enum|protocol|extension|init)[ \\t][^{]*)'
const ATTRIBUTES = [
  '*.ts diff=ts', '*.tsx diff=ts', '*.js diff=ts', '*.jsx diff=ts', '*.mjs diff=ts', '*.cjs diff=ts',
  '*.rs diff=rust', '*.py diff=python', '*.go diff=golang', '*.java diff=java', '*.kt diff=kotlin',
  '*.c diff=cpp', '*.h diff=cpp', '*.cc diff=cpp', '*.cpp diff=cpp', '*.hpp diff=cpp', '*.cs diff=csharp',
  '*.rb diff=ruby', '*.php diff=php', '*.swift diff=swift', '*.css diff=css', '*.md diff=markdown', '*.sh diff=bash',
].join('\n')
let attributesFile: string | null = null
function gitDiffArgs(): string[] {
  if (attributesFile === null) {
    // a private directory with a random name: no pre-planted link can be followed (SEC-GIT-2)
    const dir = mkdtempSync(join(tmpdir(), 'ddag-attributes-'))
    attributesFile = join(dir, 'attributes')
    writeFileSync(attributesFile, ATTRIBUTES + '\n', { flag: 'wx' })
    process.on('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    })
  }
  return ['-c', `core.attributesFile=${attributesFile}`, '-c', `diff.ts.xfuncname=${TS_XFUNCNAME}`, '-c', `diff.swift.xfuncname=${SWIFT_XFUNCNAME}`]
}

const COMMIT_HASH = /^[0-9a-f]{7,64}$/

export function diffSincePin(root: string, commit: string, path: string): { added: number; removed: number; where: string[] } | null {
  // the commit and the path come from a chain file, which a repository can ship:
  // neither may ever be read by git as an option (SEC-GIT-1)
  if (!COMMIT_HASH.test(commit) || path.startsWith('-')) return null
  try {
    const out = execFileSync('git', [...gitDiffArgs(), 'diff', '-U0', '--no-color', '--end-of-options', commit, '--', path], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    }).toString()
    let added = 0
    let removed = 0
    const where = new Set<string>()
    for (const line of out.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('@@')) {
        const ctx = line.replace(/^@@[^@]*@@\s?/, '').trim()
        if (ctx.length > 0) where.add(ctx.length > 80 ? ctx.slice(0, 77) + '…' : ctx)
      } else if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
    return { added, removed, where: [...where] }
  } catch {
    return null
  }
}

/**
 * The audit of every valid node's last valid judgment — one function behind
 * the MCP graph_audit text and the dashboard's /api/audit.
 */
export function auditChain(chain: EventChain, defaultRoot: string, opts: { diffs?: boolean } = {}): ChainAudit {
  const g = chain.graph
  const events = chain.chain()
  const nodes: Record<NodeId, NodeAudit> = {}
  const summary = { valid: 0, intact: 0, stale: 0, unwatched: 0, parts: 0, unpinned: 0 }
  for (const id of g.ids()) {
    if (g.verdict(id) !== 'valid') continue
    summary.valid++
    let last: (typeof events)[number] | undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (e.op.type === 'verify' && e.op.id === id && e.op.result === 'valid') {
        last = e
        break
      }
    }
    const p = last?.provenance
    if (!p) {
      nodes[id] = { status: 'unpinned', artifacts: 0, changed: [], missing: [] }
      summary.unpinned++
      continue
    }
    const pin = pinLabel(p)
    if (p.artifacts.length === 0) {
      const parts = g.predecessors(id).length
      if (parts > 0) {
        nodes[id] = { status: 'parts', pin, artifacts: 0, parts, changed: [], missing: [] }
        summary.parts++
      } else {
        nodes[id] = { status: 'unwatched', pin, artifacts: 0, changed: [], missing: [] }
        summary.unwatched++
      }
      continue
    }
    const root = resolveRoot(p, defaultRoot)
    const audit = auditProvenance(p, root)
    const changed = audit.filter((a) => a.status === 'changed').map((a) => a.path)
    const missing = audit.filter((a) => a.status === 'missing').map((a) => a.path)
    const stale = changed.length + missing.length > 0
    const node: NodeAudit = { status: stale ? 'stale' : 'intact', pin, artifacts: p.artifacts.length, changed, missing }
    if (stale && opts.diffs && p.head !== undefined) {
      node.diffs = []
      for (const path of changed) {
        const d = diffSincePin(root, p.head, path)
        if (d) node.diffs.push({ path, ...d, approximate: p.dirty === true })
      }
    }
    nodes[id] = node
    if (stale) summary.stale++
    else summary.intact++
  }
  return { nodes, summary }
}

export interface ArtifactAudit {
  path: string
  status: 'unchanged' | 'changed' | 'missing'
}

/** Re-hash the recorded artifacts against the working tree. */
export function auditProvenance(p: Provenance, root: string): ArtifactAudit[] {
  return p.artifacts.map(({ path, hash }) => {
    const abs = resolve(root, path)
    if (!existsSync(abs) || containedReal(root, abs) === null) return { path, status: 'missing' }
    return { path, status: hashPath(abs) === hash ? 'unchanged' : 'changed' }
  })
}
