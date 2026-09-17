// Growth: how the cost of reading the graph grows with its size. 200 claims in groups of five, all judged.
import { median, metric } from '../../harness/lib.mjs'

export const name = 'scale'
export const title = 'Growth: reading and writing a graph of 60 and 200 claims'

export function files() {
  return { 'README.md': '# fixture\n', 'src/core.ts': 'export const core = 1\n' }
}

export async function run(s) {
  await s.call('new', 'graph_new', { content: 'The system is correct', root_id: 'sys', verify: 'every group solid' })
  const sample = {}
  let claims = 0
  for (let g = 1; g <= 40; g++) {
    await s.call('add group', 'add', { id: `g${g}`, successor: 'sys', content: `Area ${g} is correct`, verify: 'its five claims are verified' })
    for (let k = 1; k <= 5; k++) {
      const id = `c${g}_${k}`
      await s.call('add claim', 'add', { id, successor: `g${g}`, content: `Claim ${k} of area ${g} holds for every input`, verify: 'its unit tests pass' })
      await s.call('judge claim', 'verify', { id, result: 'valid', evidence: `Ran the tests for claim ${k} of area ${g}: 8 passed. The boundary case is covered by the third test.`, artifacts: ['src/core.ts'] })
      claims++
    }
    await s.call('judge group', 'verify', { id: `g${g}`, result: 'valid', evidence: 'Judged on its five parts, all solid.' })
    if (claims === 60 || claims === 200) {
      const st = await s.call(`read state at ${claims}`, 'graph_state')
      const lat = s.steps.filter((x) => x.tool === 'verify' && !x.na).slice(-6).map((x) => x.ms)
      sample[claims] = { state: st.step.bytes, latency: median(lat), chain: s.chainBytes() }
    }
  }
  return {
    state_bytes_at_60: metric(sample[60].state, 'bytes', 'lower', 'graph_state at 60 claims'),
    state_bytes_at_200: metric(sample[200].state, 'bytes', 'lower', 'graph_state at 200 claims'),
    op_latency_ms_at_60: metric(Math.round(sample[60].latency * 10) / 10, 'ms', 'lower', 'Judgment latency at 60 claims'),
    op_latency_ms_at_200: metric(Math.round(sample[200].latency * 10) / 10, 'ms', 'lower', 'Judgment latency at 200 claims'),
    chain_file_bytes_at_200: metric(sample[200].chain, 'bytes', 'lower', 'Chain file at 200 claims'),
  }
}
