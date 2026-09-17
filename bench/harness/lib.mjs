// The harness talks to DDAG the way any MCP client does: a server process over stdio.
// It never imports from ../src — a version is measured through its public interface only,
// so the same harness measures every version and the comparison is like for like.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')
export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
export const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)

/** How a version is started: from npm (what users run) or from a local bundle (an unreleased build). */
export function serverCommand(target) {
  return target.local ? { command: process.execPath, args: [target.local] } : { command: 'npx', args: ['-y', `@dreamc0der/ddag@${target.version}`] }
}

/** A scratch project: fixture files, a git repository with one commit, and a private DDAG_HOME so no registry is touched. */
export function scratchProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ddag-bench-'))
  const home = mkdtempSync(join(tmpdir(), 'ddag-bench-home-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const git = (...a) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...a], { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, '.gitignore'), 'ddag.json\n')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  return { dir, home }
}

/** One session: one server process, as one Claude Code session has. Every call is timed and its reply measured. */
export async function openSession(target, project) {
  const { command, args } = serverCommand(target)
  const started = performance.now()
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: project.dir,
    env: { ...process.env, DDAG_HOME: project.home, DDAG_NO_DASHBOARD: '1' },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'ddag-bench', version: '1' })
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((t) => t.name)
  const startMs = performance.now() - started
  const steps = []
  const call = async (name, tool, args = {}) => {
    if (!tools.includes(tool)) {
      steps.push({ name, tool, na: true })
      return null
    }
    const t0 = performance.now()
    const r = await client.callTool({ name: tool, arguments: args })
    const ms = performance.now() - t0
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    const step = { name, tool, bytes: Buffer.byteLength(text), ms: Math.round(ms * 10) / 10, ok: !r.isError && !/^(Rejected|Refused|ERROR)/.test(text) }
    steps.push(step)
    return { text, step }
  }
  return { tools, startMs, steps, call, close: () => client.close(), chainBytes: () => statSync(join(project.dir, 'ddag.json')).size, chainEvents: () => JSON.parse(readFileSync(join(project.dir, 'ddag.json'), 'utf8')).events.length }
}

export const metric = (value, unit, better, label, note) => ({ value, unit, better, label, ...(note ? { note } : {}) })
