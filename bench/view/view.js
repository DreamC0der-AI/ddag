// The benchmark view: versions side by side. Reads results/index.json and the result files it lists.
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
const svgEl = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  return n
}

const HEADLINES = [
  ['standard-session', 'session_reply_bytes'],
  ['scale', 'state_bytes_at_200'],
  ['standard-session', 'stale_after_one_file_edit'],
  ['standard-session', 'pins_per_judgment'],
]

/** Versions in release order: numeric parts first, a "-local" build after the release it precedes. */
const versionKey = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1))
const byVersion = (a, b) => {
  const [x, y] = [versionKey(a.version), versionKey(b.version)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

function fmt(value, unit) {
  if (value === null || value === undefined) return { text: 'n/a', unit: '' }
  if (unit === 'bytes') return value >= 1024 * 1024 ? { text: (value / 1048576).toFixed(2), unit: 'MB' } : value >= 1024 ? { text: (value / 1024).toFixed(1), unit: 'KB' } : { text: String(value), unit: 'B' }
  return { text: Number.isInteger(value) ? value.toLocaleString('en-US') : String(value), unit: unit === 'ms' ? 'ms' : unit }
}
const fmtFlat = (value, unit) => {
  const f = fmt(value, unit)
  return f.unit && !['files', 'judgments', 'tools'].includes(f.unit) ? `${f.text} ${f.unit}` : f.text
}

/** The change from base to current, and whether that direction is good for this metric. */
/** Timings come from single runs on a busy machine: a difference inside this band is not a finding. */
const NOISE = { ms: 0.2 }

function change(cur, base, better, unit) {
  if (cur === null || cur === undefined || base === null || base === undefined) return { cls: 'na', text: 'no baseline' }
  if (cur === base) return { cls: 'flat', text: '= unchanged' }
  const up = cur > base
  const pct = base === 0 ? null : Math.round(((cur - base) / base) * 100)
  if (pct !== null && NOISE[unit] !== undefined && Math.abs(pct) <= NOISE[unit] * 100) return { cls: 'flat', text: `≈ within noise (${up ? '+' : '−'}${Math.abs(pct)}%)` }
  const good = better === 'neutral' ? null : better === 'lower' ? !up : up
  const amount = pct === null ? `${up ? '+' : '−'}${Math.abs(cur - base)}` : `${up ? '+' : '−'}${Math.abs(pct)}%`
  return { cls: good === null ? 'flat' : good ? 'good' : 'bad', text: `${up ? '▲' : '▼'} ${amount}${good === null ? '' : good ? ' better' : ' worse'}` }
}

/** A sparkline across versions: the series in the quiet hue, the shown version's point in the accent. */
function sparkline(points, currentIndex, w = 96, h = 26) {
  const svg = svgEl('svg', { class: 'spark', width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' })
  const known = points.map((p, i) => ({ ...p, i })).filter((p) => p.value !== null && p.value !== undefined)
  if (known.length === 0) return svg
  const max = Math.max(...known.map((p) => p.value))
  const min = Math.min(0, ...known.map((p) => p.value))
  const x = (i) => (points.length === 1 ? w / 2 : 5 + (i * (w - 10)) / (points.length - 1))
  const y = (v) => h - 5 - ((v - min) / (max - min || 1)) * (h - 10)
  svg.setAttribute('aria-label', known.map((p) => `${p.version}: ${p.label}`).join(', '))
  if (known.length > 1) svg.append(svgEl('polyline', { points: known.map((p) => `${x(p.i)},${y(p.value)}`).join(' '), fill: 'none', stroke: 'var(--quiet)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }))
  for (const p of known) {
    const cur = p.i === currentIndex
    const dot = svgEl('circle', { cx: x(p.i), cy: y(p.value), r: cur ? 4 : 2.5, fill: cur ? 'var(--accent)' : 'var(--quiet)', stroke: 'var(--surface)', 'stroke-width': 2 })
    const hit = svgEl('circle', { cx: x(p.i), cy: y(p.value), r: 9, fill: 'transparent', tabindex: 0 })
    tipOn(hit, () => [p.label, p.version])
    svg.append(dot, hit)
  }
  return svg
}

const tip = $('tip')
function tipOn(node, content) {
  const show = (e) => {
    const [value, label] = content()
    tip.replaceChildren(el('b', '', value), document.createTextNode(label))
    const r = e.target.getBoundingClientRect()
    tip.style.left = `${r.left + r.width / 2}px`
    tip.style.top = `${r.top}px`
    tip.hidden = false
  }
  node.addEventListener('pointerenter', show)
  node.addEventListener('focus', show)
  node.addEventListener('pointerleave', () => (tip.hidden = true))
  node.addEventListener('blur', () => (tip.hidden = true))
}

const state = { results: [], current: null, base: null, selected: null }

async function load() {
  const index = await (await fetch('/results/index.json', { cache: 'no-store' })).json()
  const results = await Promise.all(index.mechanism.map(async (f) => (await fetch(`/results/${f}`, { cache: 'no-store' })).json()))
  state.results = results.sort(byVersion)
  state.current = state.results.at(-1).version
  state.base = (state.results.at(-2) ?? state.results.at(-1)).version
  for (const [sel, key] of [[$('sel-current'), 'current'], [$('sel-base'), 'base']]) {
    for (const r of state.results) sel.append(new Option(`${r.version}${r.source === 'npm' ? '' : ' (local build)'}`, r.version))
    sel.value = state[key]
    sel.addEventListener('change', () => {
      state[key] = sel.value
      render()
    })
  }
  render()
}

const get = (r, c, k) => r.cases[c]?.metrics[k]
/** Results only compare when they ran the same case: a changed case must not pass for a changed product. */
const comparable = (a, b, c) => a.cases[c] && b.cases[c] && a.cases[c].hash === b.cases[c].hash

function render() {
  const rs = state.results
  const cur = rs.find((r) => r.version === state.current)
  const base = rs.find((r) => r.version === state.base)
  const curIndex = rs.indexOf(cur)

  const tiles = $('tiles')
  tiles.replaceChildren()
  for (const [c, k] of HEADLINES) {
    const m = get(cur, c, k)
    if (!m) continue
    const f = fmt(m.value, m.unit)
    const tile = el('article', 'tile')
    tile.append(el('div', 'label', m.label))
    const value = el('div', 'value', f.text)
    value.append(el('small', '', f.unit))
    const row = el('div', 'row')
    const d = comparable(cur, base, c) && cur !== base ? change(m.value, get(base, c, k)?.value, m.better, m.unit) : { cls: 'na', text: cur === base ? 'same version' : 'case changed' }
    const delta = el('span', `delta ${d.cls}`, d.text)
    if (d.cls !== 'na') delta.append(el('span', 'vs', `vs ${base.version}`))
    row.append(delta, sparkline(rs.map((r) => ({ version: r.version, value: get(r, c, k)?.value, label: fmtFlat(get(r, c, k)?.value, m.unit) })), curIndex))
    tile.append(value, row)
    tiles.append(tile)
  }

  const tables = $('tables')
  tables.replaceChildren()
  const ORDER = ['standard-session', 'scale']
  const cases = Object.keys(cur.cases).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
  for (const c of cases) {
    tables.append(el('h2', '', cur.cases[c].title))
    const wrap = el('div', 'scroll')
    const table = el('table')
    const head = el('tr')
    head.append(el('th', '', 'Metric'))
    for (const r of rs) {
      const th = el('th', r === cur ? 'cur' : '', r.version)
      th.append(el('span', 'src', r.source === 'npm' ? 'npm' : 'local build'))
      if (!comparable(r, cur, c)) th.append(el('span', 'warn', 'other case'))
      head.append(th)
    }
    head.append(el('th', '', `Change vs ${base.version}`), el('th', '', 'Across versions'))
    const thead = el('thead')
    thead.append(head)
    const body = el('tbody')
    for (const [k, m] of Object.entries(cur.cases[c].metrics)) {
      const tr = el('tr')
      tr.tabIndex = 0
      tr.setAttribute('aria-selected', String(state.selected === `${c}/${k}`))
      const name = el('td', '', m.label)
      if (m.note) name.append(el('span', 'metric-note', m.note))
      tr.append(name)
      for (const r of rs) {
        const v = get(r, c, k)?.value
        tr.append(el('td', `${r === cur ? 'cur' : ''} ${v === null || v === undefined ? 'na' : ''}`.trim(), fmtFlat(v, m.unit)))
      }
      const d = cur === base ? { cls: 'na', text: '—' } : m.compare === 'same-source' && cur.source !== base.source ? { cls: 'na', text: 'not comparable: npm vs local build' } : comparable(cur, base, c) ? change(m.value, get(base, c, k)?.value, m.better, m.unit) : { cls: 'na', text: 'case changed' }
      const dc = el('td')
      dc.append(el('span', `delta ${d.cls}`, d.text))
      const sp = el('td')
      sp.append(sparkline(rs.map((r) => ({ version: r.version, value: get(r, c, k)?.value, label: fmtFlat(get(r, c, k)?.value, m.unit) })), curIndex))
      tr.append(dc, sp)
      const pick = () => {
        state.selected = `${c}/${k}`
        render()
        $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
      tr.addEventListener('click', pick)
      tr.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()))
      body.append(tr)
    }
    table.append(thead, body)
    wrap.append(table)
    tables.append(wrap)
  }

  renderDetail(rs, cur, base)
  $('foot').textContent = `Harness ${cur.harness}. ${cur.version}: ${cur.source}, measured ${cur.date.slice(0, 10)} on ${cur.env.cpu}, Node ${cur.env.node}. Start time through npx is not comparable with a local bundle. Click a metric for its bars and, for the session, the cost of each step.`
}

function renderDetail(rs, cur, base) {
  const box = $('detail')
  if (!state.selected) return void (box.hidden = true)
  const [c, k] = state.selected.split('/')
  const m = get(cur, c, k)
  if (!m) return void (box.hidden = true)
  box.hidden = false
  box.replaceChildren(el('h3', '', m.label), el('p', '', `${m.note ? `${m.note}. ` : ''}${m.better === 'lower' ? 'Lower is better.' : m.better === 'higher' ? 'Higher is better.' : ''}`))
  const bars = el('div', 'bars')
  const max = Math.max(...rs.map((r) => get(r, c, k)?.value ?? 0)) || 1
  for (const r of rs) {
    const v = get(r, c, k)?.value
    const track = el('div', 'track')
    if (v !== null && v !== undefined) {
      const bar = el('div', `bar ${r === cur ? 'cur' : ''}`.trim())
      bar.style.width = `${(v / max) * 100}%`
      bar.tabIndex = 0
      tipOn(bar, () => [fmtFlat(v, m.unit), r.version])
      track.append(bar)
    }
    bars.append(el('div', `name ${r === cur ? 'cur' : ''}`.trim(), r.version), track, el('div', 'num', fmtFlat(v, m.unit)))
  }
  box.append(bars)

  if (c === 'standard-session' && cur !== base && comparable(cur, base, c)) {
    const steps = el('div', 'steps')
    steps.append(el('h3', '', 'Where the session spends its context'), el('p', '', `Reply size of each step, ${cur.version} against ${base.version}. A step a version does not offer is not available.`))
    const legend = el('div', 'legend')
    legend.append(el('span', '', base.version), el('span', 'cur', cur.version))
    const wrap = el('div', 'scroll')
    const t = el('table')
    const h = el('tr')
    h.append(el('th', '', 'Step'), el('th', '', base.version), el('th', '', cur.version), el('th', '', ''))
    const th = el('thead')
    th.append(h)
    const tb = el('tbody')
    const group = (r) => {
      const out = new Map()
      for (const s of r.cases[c].steps) {
        const key = s.name.replace(/ \d+$| (m|g)\d+$/, '')
        const g = out.get(key) ?? { bytes: 0, n: 0, na: true }
        if (!s.na) {
          g.bytes += s.bytes
          g.na = false
        }
        g.n++
        out.set(key, g)
      }
      return out
    }
    const [gb, gc] = [group(base), group(cur)]
    const keys = [...new Set([...gc.keys(), ...gb.keys()])]
    const top = Math.max(...keys.map((x) => Math.max(gb.get(x)?.bytes ?? 0, gc.get(x)?.bytes ?? 0))) || 1
    for (const key of keys) {
      const [b, n] = [gb.get(key), gc.get(key)]
      const tr = el('tr')
      tr.style.cursor = 'default'
      const same = b && n && b.n === n.n
      const times = (g) => (g && g.n > 1 && !same ? ` · ×${g.n}` : '')
      tr.append(el('td', '', same && n.n > 1 ? `${key} × ${n.n}` : key))
      tr.append(el('td', b && !b.na ? '' : 'na', b && !b.na ? `${fmtFlat(b.bytes, 'bytes')}${times(b)}` : b ? 'n/a' : '—'), el('td', n && !n.na ? 'cur' : 'na', n && !n.na ? `${fmtFlat(n.bytes, 'bytes')}${times(n)}` : n ? 'n/a' : '—'))
      const pair = el('span', 'pair')
      const i1 = el('i')
      i1.style.width = `${((b?.bytes ?? 0) / top) * 100}%`
      const i2 = el('i', 'cur')
      i2.style.width = `${((n?.bytes ?? 0) / top) * 100}%`
      pair.append(i1, i2)
      const td = el('td')
      td.style.textAlign = 'left'
      td.append(pair)
      tr.append(td)
      tb.append(tr)
    }
    t.append(th, tb)
    wrap.append(t)
    steps.append(legend, wrap)
    box.append(steps)
  }
}

load().catch((e) => {
  $('tables').replaceChildren(el('p', '', `Could not load results: ${e.message}. Run "npm run bench -- --version <x>" in bench/ first.`))
})
