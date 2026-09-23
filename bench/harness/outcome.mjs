// Outcome runs: an agent is the subject, a hidden test suite is the judge.
// One run = one headless Claude Code session in a fresh folder under one condition:
//   none    — no DDAG; the agent keeps a checklist file
//   <x.y.z> — DDAG at that published version, as its only MCP server
// The budget rules: every run has a dollar cap, a turn cap and a wall-clock cap; runs go one at a
// time; each run's result is written before the next starts; a finished run is never run again.
// So a campaign stopped half way keeps everything it paid for, and the same command resumes it.
//
//   node harness/outcome.mjs --task <id> --plan
//   node harness/outcome.mjs --task <id> [--conditions none,0.3.2,0.4.1] [--model sonnet] [--runs 1]
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession, sha256 } from './lib.mjs'

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const taskId = arg('task')
if (!taskId) {
  console.error('Name a case: --task <id>, a folder under cases/outcome/')
  process.exit(2)
}
const conditions = arg('conditions', 'none,0.3.2,0.4.1').split(',')
const model = arg('model', 'sonnet')
const runs = Number(arg('runs', 1))
const CAP = { usd: Number(arg('max-usd', 2.5)), turns: Number(arg('max-turns', 80)), minutes: Number(arg('timeout-min', 25)), campaignUsd: Number(arg('campaign-usd', 8)) }

const caseDir = join(BENCH, 'cases/outcome', taskId)
const task = JSON.parse(readFileSync(join(caseDir, 'task.json'), 'utf8'))
const caseHash = sha256(['task.json', 'given/SPEC.md', `given/${task.solution}`, `hidden/${task.score.tests}`].map((f) => readFileSync(join(caseDir, f), 'utf8')).join('\0')).slice(0, 12)
const runsDir = join(BENCH, 'results/runs')
const outFile = join(BENCH, 'results/outcome', `${taskId}.json`)

// Tools that would let a run leave its folder or hand the work to someone else. Off in every condition.
const OFF = ['WebFetch', 'WebSearch', 'Task', 'Workflow', 'Skill', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'ScheduleWakeup', 'DesignSync', 'EnterWorktree', 'ExitWorktree', 'SendMessage', 'NotebookEdit']
// Fetching content could bring the hidden tests in: that voids a run. Installing a tool cannot; it is only noted.
const NETWORK = /\b(curl|wget|git clone|https?:\/\/)/
const INSTALL = /\b(pip3? install|npm (i|install)|brew install)\b/

const promptFor = (condition) => [task.prompt.task, condition === 'none' ? task.prompt.method.checklist : task.prompt.method.ddag, task.prompt.close].join('\n\n')
const runId = (condition, i) => `${taskId}-${model}-${condition === 'none' ? 'none' : `ddag-${condition}`}-r${i}`

function plan() {
  const n = conditions.length * runs
  console.log(`task ${taskId} (${caseHash}) · model ${model} · ${conditions.join(', ')} × ${runs} = ${n} runs, one at a time`)
  console.log(`caps per run: $${CAP.usd} · ${CAP.turns} turns · ${CAP.minutes} min   campaign cap: $${CAP.campaignUsd}`)
  console.log(`worst case: $${Math.min(n * CAP.usd, CAP.campaignUsd).toFixed(2)} and ${n * CAP.minutes} min; a finished run is kept and never repeated`)
}

function workFolder(condition) {
  const dir = mkdtempSync(join(tmpdir(), 'ddag-outcome-'))
  const home = mkdtempSync(join(tmpdir(), 'ddag-outcome-home-'))
  cpSync(join(caseDir, 'given'), dir, { recursive: true })
  writeFileSync(join(dir, '.gitignore'), 'ddag.json\n__pycache__/\n')
  const git = (...a) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...a], { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'task')
  const servers = condition === 'none' ? {} : { ddag: { command: 'npx', args: ['-y', `@dreamc0der/ddag@${condition}`], env: { DDAG_HOME: home, DDAG_NO_DASHBOARD: '1' } } }
  const mcp = join(home, 'mcp.json')
  writeFileSync(mcp, JSON.stringify({ mcpServers: servers }))
  return { dir, home, mcp }
}

function agent(condition, folder, transcript) {
  const args = ['-p', promptFor(condition), '--model', model, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', folder.mcp, '--setting-sources', 'project,local', '--no-session-persistence', '--max-turns', String(CAP.turns), '--max-budget-usd', String(CAP.usd), '--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'ToolSearch', 'mcp__ddag', '--disallowedTools', ...OFF]
  // A run is its own session, not a child of the one that started the harness.
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...env } = process.env
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd: folder.dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createWriteStream(transcript)
    child.stdout.pipe(out)
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    let timedOut = false
    const timer = setTimeout(() => ((timedOut = true), child.kill('SIGTERM')), CAP.minutes * 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      out.end(() => resolve({ code, timedOut, wallMs: Date.now() - started, stderr: err.slice(-2000) }))
    })
  })
}

function readTranscript(file) {
  const events = readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  const result = events.find((e) => e.type === 'result')
  const calls = {}
  const network = []
  const installs = []
  let outside = 0
  for (const e of events) {
    if (e.type !== 'assistant') continue
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_use') continue
      calls[c.name] = (calls[c.name] ?? 0) + 1
      const text = JSON.stringify(c.input ?? {})
      if (c.name === 'Bash' && NETWORK.test(c.input?.command ?? '')) network.push(c.input.command.slice(0, 200))
      if (c.name === 'Bash' && INSTALL.test(c.input?.command ?? '')) installs.push(c.input.command.slice(0, 200))
      if ((c.name === 'Bash' || c.name === 'Read') && /cases\/outcome|polyglot|exercism/i.test(text)) outside++
    }
  }
  return { init, result, calls, network, installs, outside }
}

function score(folder, solution = join(folder.dir, task.solution)) {
  const dir = mkdtempSync(join(tmpdir(), 'ddag-outcome-score-'))
  if (!existsSync(solution)) return { passed: 0, total: task.score.total, failed: ['(no solution file)'] }
  cpSync(solution, join(dir, task.solution))
  cpSync(join(caseDir, 'hidden', task.score.tests), join(dir, task.score.tests))
  const [cmd, ...rest] = task.score.command
  const ran = spawnSync(cmd, rest, { cwd: dir, timeout: 60_000, encoding: 'utf8' })
  const text = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`
  const lines = [...text.matchAll(/^(test_\w+) .*\.\.\. (ok|FAIL|ERROR)$/gm)]
  const failed = lines.filter((m) => m[2] !== 'ok').map((m) => m[1].replace(/^test_/, ''))
  const passed = lines.length - failed.length
  return lines.length === 0 ? { passed: 0, total: task.score.total, failed: ['(the suite did not load)'], tail: text.slice(-600) } : { passed, total: task.score.total, failed }
}

async function chainOf(condition, folder) {
  const file = join(folder.dir, 'ddag.json')
  if (condition === 'none' || !existsSync(file)) return null
  const events = JSON.parse(readFileSync(file, 'utf8')).events
  const count = (f) => events.filter(f).length
  const chain = {
    events: events.length,
    bytes: statSync(file).size,
    claims: count((e) => e.op.type === 'add'),
    valid: count((e) => e.op.type === 'verify' && e.op.result === 'valid'),
    invalid: count((e) => e.op.type === 'verify' && e.op.result === 'invalid'),
    restated: count((e) => e.op.type === 'mutate'),
    issues: count((e) => e.op.type === 'issue'),
  }
  try {
    const s = await openSession({ version: condition }, folder)
    const r = await s.call('state', 'graph_state', {})
    await s.close()
    // 0.4 says it in the standing line; 0.3 says it on the root's own line, which is printed first.
    const text = r?.text ?? ''
    const rootLine = text.split('\n').find((l) => l.startsWith('- ')) ?? ''
    chain.rootSolid = /SOLID — the target is verified/.test(text) || /\[[^\]]*(^|, )solid[^\]]*\]/.test(rootLine.match(/\[[^\]]*\]/)?.[0] ?? '')
    chain.standing = chain.rootSolid ? 'root SOLID' : 'root not solid'
  } catch (e) {
    chain.standing = `(could not read: ${String(e).slice(0, 120)})`
  }
  return chain
}

const filesOf = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === '.git' || d.name === '__pycache__' ? [] : d.isDirectory() ? filesOf(join(dir, d.name), base) : [{ path: relative(base, join(dir, d.name)), bytes: statSync(join(dir, d.name)).size }]))

async function one(condition, i) {
  const id = runId(condition, i)
  const keep = join(runsDir, id)
  const summary = join(keep, 'run.json')
  if (existsSync(summary)) return { ...JSON.parse(readFileSync(summary, 'utf8')), reused: true }
  mkdirSync(keep, { recursive: true })
  const folder = workFolder(condition)
  console.log(`▶ ${id}  (${folder.dir})`)
  const ran = await agent(condition, folder, join(keep, 'transcript.jsonl'))
  cpSync(folder.dir, join(keep, 'work'), { recursive: true, filter: (p) => !p.includes('/.git') && !p.includes('__pycache__') })
  return summarize(condition, i, folder, ran)
}

/** Everything in a run's summary is read from what the run left behind, so a summary can be rebuilt without running the agent again. */
async function summarize(condition, i, folder, ran) {
  const id = runId(condition, i)
  const keep = join(runsDir, id)
  const summary = join(keep, 'run.json')
  const t = readTranscript(join(keep, 'transcript.jsonl'))
  const final = (t.result?.result ?? '').trim()
  const lastLine = final.split('\n').filter((l) => l.trim()).pop()?.replace(/[`*]/g, '').trim() ?? ''
  const declared = /^DONE\b/.test(lastLine) ? 'done' : /^NOT DONE/.test(lastLine) ? 'not done' : 'unclear'
  const s = score(folder)
  const chain = await chainOf(condition, folder)
  const u = t.result?.usage ?? {}
  const ddagServer = (t.init?.mcp_servers ?? []).find((m) => m.name === 'ddag')
  const run = {
    id, task: taskId, caseHash, condition, model: t.init?.model ?? model, run: i, at: ran.at ?? new Date().toISOString(),
    end: ran.timedOut ? 'wall-clock cap' : (t.result?.subtype ?? `exit ${ran.code}`),
    valid: !ran.timedOut && t.result?.subtype === 'success' && (condition === 'none' || ddagServer?.status === 'connected') && t.network.length === 0 && t.outside === 0,
    hidden: s, declared, falseDone: declared === 'done' && s.passed < s.total,
    falseSolid: chain ? chain.rootSolid === true && s.passed < s.total : null,
    turns: t.result?.num_turns ?? null, wallMs: ran.wallMs, apiMs: t.result?.duration_api_ms ?? null,
    costUsd: t.result?.total_cost_usd ?? null,
    tokens: { input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
    calls: t.calls, ddagCalls: Object.entries(t.calls).filter(([k]) => k.startsWith('mcp__ddag')).reduce((a, [, v]) => a + v, 0),
    chain, files: filesOf(folder.dir), flags: { network: t.network, installs: t.installs, outsideReads: t.outside, ddagServer: ddagServer?.status ?? null, stderr: ran.code === 0 ? undefined : ran.stderr },
    finalMessage: final.slice(-700),
  }
  writeFileSync(summary, JSON.stringify(run, null, 1))
  return run
}

function publish() {
  const all = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => d.startsWith(`${taskId}-`) && existsSync(join(runsDir, d, 'run.json'))).map((d) => JSON.parse(readFileSync(join(runsDir, d, 'run.json'), 'utf8'))) : []
  mkdirSync(dirname(outFile), { recursive: true })
  const { prompt, ...about } = task
  writeFileSync(outFile, JSON.stringify({ kind: 'outcome', task: about, caseHash, prompts: { none: promptFor('none'), ddag: promptFor('0.0.0') }, runs: all.sort((a, b) => a.id.localeCompare(b.id)) }, null, 1))
  const indexFile = join(BENCH, 'results/index.json')
  const index = JSON.parse(readFileSync(indexFile, 'utf8'))
  index.outcome = [...new Set([...(index.outcome ?? []), `outcome/${taskId}.json`])].sort()
  writeFileSync(indexFile, JSON.stringify(index, null, 1))
}

plan()
if (has('plan')) process.exit(0)
if (has('rescore')) {
  // Rebuild every kept run's summary from its transcript and work folder. Costs nothing.
  for (const d of readdirSync(runsDir).filter((d) => d.startsWith(`${taskId}-`) && existsSync(join(runsDir, d, 'run.json')))) {
    const old = JSON.parse(readFileSync(join(runsDir, d, 'run.json'), 'utf8'))
    if (runId(old.condition, old.run) !== d) continue
    const r = await summarize(old.condition, old.run, { dir: join(runsDir, d, 'work'), home: mkdtempSync(join(tmpdir(), 'ddag-outcome-home-')) }, { timedOut: old.end === 'wall-clock cap', wallMs: old.wallMs, code: 0, at: old.at })
    console.log(`↻ ${r.id}  hidden ${r.hidden.passed}/${r.hidden.total} · said ${r.declared}${r.chain ? ` · ${r.chain.standing}` : ''}${r.valid ? '' : ' · NOT A VALID RUN'}`)
  }
  publish()
  process.exit(0)
}
if (has('selfcheck')) {
  // The judge is checked before anyone is judged: the reference must pass in full, the untouched stub must not.
  const ref = score(null, join(caseDir, 'hidden/reference.py'))
  const stub = score(null, join(caseDir, 'given', task.solution))
  console.log(`reference ${ref.passed}/${ref.total} · stub ${stub.passed}/${stub.total}`)
  process.exit(ref.passed === ref.total && stub.passed === 0 ? 0 : 1)
}
let spent = 0
for (let i = 1; i <= runs; i++) {
  for (const condition of conditions) {
    if (spent + CAP.usd > CAP.campaignUsd) { console.log(`■ campaign cap reached at $${spent.toFixed(2)}; stopping. The same command resumes.`); publish(); process.exit(0) }
    const r = await one(condition, i)
    if (!r.reused) spent += r.costUsd ?? 0
    publish()
    console.log(`${r.reused ? '·' : '✔'} ${r.id}  hidden ${r.hidden.passed}/${r.hidden.total} · said ${r.declared} · ${r.turns} turns · ${Math.round(r.wallMs / 1000)} s · $${(r.costUsd ?? 0).toFixed(2)} · ${r.end}${r.valid ? '' : ' · NOT A VALID RUN'}`)
  }
}
console.log(`spent this invocation: $${spent.toFixed(2)}`)
