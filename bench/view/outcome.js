// The outcome section: one task per block, the conditions side by side, every run listed under it.
// A cell shows the median over that condition's valid runs; with one run it shows that run and says so.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const label = (c) => (c === 'none' ? 'No DDAG (checklist)' : `DDAG ${c}`)
const order = (a, b) => (a === 'none' ? -1 : b === 'none' ? 1 : a.localeCompare(b, undefined, { numeric: true }))
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} K` : String(n))

const ROWS = [
  ['Hidden tests passed', (r) => r.hidden.passed, (v, r) => `${v} / ${r.hidden.total}`, 'higher'],
  ['Said done while hidden tests fail', (r) => (r.falseDone ? 1 : 0), null, 'count'],
  ['Root SOLID while hidden tests fail', (r) => (r.falseSolid === null ? null : r.falseSolid ? 1 : 0), null, 'count'],
  ['Turns', (r) => r.turns, (v) => String(v), 'lower'],
  ['Wall time', (r) => r.wallMs / 1000, (v) => (v >= 90 ? `${(v / 60).toFixed(1)} min` : `${Math.round(v)} s`), 'lower'],
  ['Cost at API prices', (r) => r.costUsd, (v) => `$${v.toFixed(2)}`, 'lower'],
  ['Tokens written (input, cache write, output)', (r) => r.tokens.input + r.tokens.cacheWrite + r.tokens.output, (v) => k(v), 'lower'],
  ['Tokens re-read from cache', (r) => r.tokens.cacheRead, (v) => k(v), 'lower'],
  ['Output tokens', (r) => r.tokens.output, (v) => k(v), 'lower'],
  ['DDAG tool calls', (r) => (r.condition === 'none' ? null : r.ddagCalls), (v) => String(v), null],
  ['Claims · judged valid · judged invalid', (r) => (r.chain ? r.chain.claims : null), (v, r) => `${r.chain.claims} · ${r.chain.valid} · ${r.chain.invalid}`, null],
]

function block(file) {
  const box = el('section', 'outcome-task')
  box.append(el('h2', '', `Outcome · ${file.task.title}`))
  const conditions = [...new Set(file.runs.map((r) => r.condition))].sort(order)
  const valid = (c) => file.runs.filter((r) => r.condition === c && r.valid)
  const n = Math.max(...conditions.map((c) => valid(c).length), 0)
  const note = el('p', 'outcome-note')
  note.textContent = `${file.task.family}. ${file.task.score.total} hidden tests, never shown to the agent. Same task text in every condition; only the method paragraph differs. Model: ${[...new Set(file.runs.map((r) => r.model))].join(', ')}. `
  note.append(el('strong', '', n <= 1 ? 'One run per condition: a spike. It shows the pipeline works and what a run costs; it cannot show which condition is better.' : `${n} runs per condition; cells show the median.`))
  box.append(note)

  const wrap = el('div', 'scroll')
  const table = el('table')
  const head = el('tr')
  head.append(el('th', '', 'Metric'))
  for (const c of conditions) {
    const th = el('th', '', label(c))
    th.append(el('span', 'src', `${valid(c).length} valid run${valid(c).length === 1 ? '' : 's'}`))
    head.append(th)
  }
  const thead = el('thead')
  thead.append(head)
  const body = el('tbody')
  for (const [name, pick, show, kind] of ROWS) {
    const tr = el('tr')
    tr.style.cursor = 'default'
    tr.append(el('td', '', name))
    for (const c of conditions) {
      const rs = valid(c)
      const vs = rs.map(pick)
      const present = vs.filter((v) => v !== null && v !== undefined)
      let text = '—'
      if (present.length) text = kind === 'count' ? `${present.reduce((a, b) => a + b, 0)} of ${present.length}` : show(median(present), rs[0])
      const td = el('td', present.length ? '' : 'na', text)
      if (kind === 'count' && present.some((v) => v > 0)) td.classList.add('bad')
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(thead, body)
  wrap.append(table)
  box.append(wrap)

  box.append(el('h3', '', 'Runs'))
  const list = el('div', 'runs')
  for (const r of [...file.runs].sort((a, b) => order(a.condition, b.condition) || a.run - b.run)) {
    const d = el('details', 'run')
    const s = el('summary')
    s.append(el('span', 'run-name', `${label(r.condition)} · run ${r.run}`), el('span', 'run-score', `${r.hidden.passed}/${r.hidden.total}`), el('span', 'run-meta', `said ${r.declared} · ${r.turns ?? '?'} turns · $${(r.costUsd ?? 0).toFixed(2)} · ${r.end}`))
    if (!r.valid) s.append(el('span', 'warn', 'not a valid run'))
    d.append(s)
    const lines = []
    if (r.hidden.failed.length) lines.push(['Hidden tests failed', r.hidden.failed.join(', ')])
    if (r.chain) lines.push(['Chain', `${r.chain.events} events, ${r.chain.claims} claims, ${r.chain.valid} valid, ${r.chain.invalid} invalid, ${r.chain.restated} restated — ${r.chain.standing ?? ''}`])
    lines.push(['Tool calls', Object.entries(r.calls).map(([t, c]) => `${t.replace('mcp__ddag__', 'ddag:')} ${c}`).join(' · ') || 'none'])
    lines.push(['Files left', r.files.map((f) => f.path).join(', ')])
    if (r.flags.network.length || r.flags.outsideReads) lines.push(['Flags', `network: ${r.flags.network.join(' ; ') || 'none'} · reads outside the folder: ${r.flags.outsideReads}`])
    if (r.flags.installs?.length) lines.push(['Tried to install', r.flags.installs.join(' ; ')])
    lines.push(['Last words', r.finalMessage])
    const dl = el('dl')
    for (const [a, b] of lines) dl.append(el('dt', '', a), el('dd', '', b))
    d.append(dl)
    list.append(d)
  }
  box.append(list)
  const traps = el('p', 'outcome-note', `Traps in the spec: ${file.task.traps.join('; ')}. Source: ${file.task.source}`)
  box.append(traps)
  return box
}

export async function loadOutcome() {
  const index = await (await fetch('/results/index.json', { cache: 'no-store' })).json()
  const host = $('outcome')
  if (!host || !index.outcome?.length) return
  const files = await Promise.all(index.outcome.map(async (f) => (await fetch(`/results/${f}`, { cache: 'no-store' })).json()))
  host.replaceChildren(...files.filter((f) => f.runs.length).map(block))
}
