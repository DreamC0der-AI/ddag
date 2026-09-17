// The standard session: what one working session costs an agent in context, and how the record behaves.
// A target with three groups of three claims is decomposed, judged bottom-up, read back, then one source
// file changes and the stale judgments are re-anchored. The evidence texts are fixed, and written the way
// agents write them: each names the file the claim rests on AND two related files it read along the way.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { mean, median, metric } from '../../harness/lib.mjs'

export const name = 'standard-session'
export const title = 'One working session: decompose, judge, read back, a file changes, re-anchor'

export function files() {
  const f = { 'README.md': '# fixture\nA small library of nine modules.\n', 'src/shared.ts': 'export const shared = 1\n', 'src/util.ts': 'export const util = (x: number) => x + 1\n' }
  for (let i = 1; i <= 9; i++) f[`src/m${i}.ts`] = `import { shared } from './shared'\nexport const m${i} = () => shared + ${i}\n`
  return f
}

const evidence = (i) =>
  `Ran the unit tests for src/m${i}.ts: 12 passed, 0 failed, covering the empty input, the boundary at ${i} and the error path. ` +
  `Also re-read src/shared.ts and src/util.ts, which this module imports, and the README.md section that documents the behaviour; nothing there contradicts the claim. ` +
  `The one open question, whether the rounding in the boundary case is intended, is answered by the spec's second example, which the third test reproduces exactly.`

export async function run(s, project) {
  await s.call('new', 'graph_new', { content: 'The library is correct and documented', root_id: 'lib', verify: 'every group solid' })
  for (let g = 1; g <= 3; g++) await s.call(`add group ${g}`, 'add', { id: `g${g}`, successor: 'lib', content: `Group ${g} of modules behaves as specified`, verify: 'its three modules are verified', rationale: `the library splits into three areas; this is area ${g}` })
  for (let i = 1; i <= 9; i++) await s.call(`add claim ${i}`, 'add', { id: `m${i}`, successor: `g${Math.ceil(i / 3)}`, content: `Module m${i} returns shared + ${i} for every input`, verify: `unit tests for src/m${i}.ts pass, including the boundary`, rationale: `m${i} is used by the public API` })
  const judged = []
  for (let i = 1; i <= 9; i++) judged.push(await s.call(`judge claim ${i}`, 'verify', { id: `m${i}`, result: 'valid', evidence: evidence(i), artifacts: i === 1 ? ['src/m1.ts', 'src/shared.ts'] : [`src/m${i}.ts`] }))
  const groups = []
  for (let g = 1; g <= 3; g++) groups.push(await s.call(`judge group ${g}`, 'verify', { id: `g${g}`, result: 'valid', evidence: `Judged on its three parts, all solid; src/m${g * 3}.ts is where the last of them lives.` }))
  await s.call('judge target', 'verify', { id: 'lib', result: 'valid', evidence: 'Judged on its three groups, all solid.' })
  const state = await s.call('read state', 'graph_state')
  const history = await s.call('read history', 'graph_history')
  const claimHistory = await s.call('read one claim history', 'graph_history', { node: 'm5' })
  await s.call('why', 'why', { id: 'lib' })
  await s.call('audit (clean)', 'graph_audit')
  // one source file changes: the one every evidence text mentions in passing, and one claim rests on
  appendFileSync(join(project.dir, 'src/shared.ts'), '// a comment\n')
  const audit = await s.call('audit (after one file changed)', 'graph_audit')
  const stale = audit ? [...audit.text.matchAll(/^- (\S+): STALE\?/gm)].map((m) => m[1]) : []
  const re = []
  for (const id of stale) re.push(await s.call(`re-anchor ${id}`, 'reverify', { id, evidence: `src/shared.ts changed by one comment line; ${id} does not depend on comments. Re-ran its tests: 12 passed.`, artifacts: id === 'm1' ? ['src/m1.ts', 'src/shared.ts'] : id.startsWith('m') ? [`src/${id}.ts`] : [] }))
  await s.call('read state again', 'graph_state')

  const pins = (r) => (r ? Number(/\[pinned [^\]]*?, (\d+) artifacts?\]/.exec(r.text)?.[1] ?? NaN) : NaN)
  const replyBytes = s.steps.filter((x) => !x.na).reduce((a, x) => a + x.bytes, 0)
  const verifySteps = s.steps.filter((x) => x.tool === 'verify' && !x.na)
  return {
    session_reply_bytes: metric(replyBytes, 'bytes', 'lower', 'Context cost of the whole session', 'sum of every reply the server sent during the session'),
    state_bytes: metric(state?.step.bytes ?? null, 'bytes', 'lower', 'graph_state, 13 claims judged'),
    history_bytes: metric(history?.step.bytes ?? null, 'bytes', 'lower', 'graph_history, default call'),
    claim_history_bytes: metric(claimHistory && claimHistory.step.ok && claimHistory.step.bytes < (history?.step.bytes ?? Infinity) ? claimHistory.step.bytes : null, 'bytes', 'lower', "One claim's own history", 'not available before graph_history took a node'),
    judgment_reply_bytes: metric(Math.round(mean(judged.filter(Boolean).map((r) => r.step.bytes))), 'bytes', 'lower', 'Reply to one judgment', 'evidence text is 483 bytes; a reply that quotes it back costs more'),
    reanchor_reply_bytes: metric(re.length ? Math.round(mean(re.filter(Boolean).map((r) => r.step.bytes))) : null, 'bytes', 'lower', 'Reply to one re-anchoring'),
    pins_per_judgment: metric(Math.round(mean(judged.map(pins).filter((n) => !Number.isNaN(n))) * 10) / 10, 'files', 'lower', 'Files pinned per leaf judgment', 'one artifact passed explicitly (two for m1); the evidence text names three more files'),
    pins_on_a_group: metric(Math.round(mean(groups.map(pins).filter((n) => !Number.isNaN(n))) * 10) / 10, 'files', 'lower', 'Files pinned on a group judgment', 'a claim with parts should rest on its parts'),
    stale_after_one_file_edit: metric(stale.length, 'judgments', 'lower', 'Judgments staled by editing one file', 'of 13; exactly one claim, m1, rests on the edited file — the right answer is 1'),
    op_latency_ms: metric(Math.round(median(verifySteps.map((x) => x.ms)) * 10) / 10, 'ms', 'lower', 'Median latency of a judgment'),
    chain_bytes_per_event: metric(Math.round(s.chainBytes() / s.chainEvents()), 'bytes', 'lower', 'Chain file size per event'),
  }
}
