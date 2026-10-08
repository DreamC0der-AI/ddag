// The 3D graph view: a project's graph as a force-directed scene, served by the dashboard at /p/<name>/3d.
// It reads /api/graph/<name> (src/graph3d/flat.ts) — the chain replayed on the server into nodes, arcs and arc tags.
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import ForceGraph3D from '3d-force-graph'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const R = 120 // spacing between depth shells / layers

// ---------- color ----------
function oklch(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  const f = (x) => { x = Math.min(1, Math.max(0, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055 }
  return '#' + rgb.map((x) => Math.round(f(x) * 255).toString(16).padStart(2, '0')).join('')
}
const VERDICT = { valid: '#34d399', pending: '#fbbf24', invalid: '#f87171' }
const DEPTH = ['#ffffff', '#5eead4', '#818cf8', '#f472b6', '#fb923c', '#facc15']
const ROOT_COLOR = '#f4f6ff'

// ---------- state ----------
const st = { color: 'branch', layout: 'shells', labels: 'smart', quality: 'high', rotate: true, flow: true, glow: true, guides: false }
let G = null // { nodes, links, byId, root, branches, maxDepth }
let selected = null, hovered = null, hoverBranch = null
// anchor: whose lineage is lit. selected: the focused node (camera pivot, detail panel). Unlocked they are one node;
// locked, the lit set stays put and selected may move anywhere inside it.
let anchor = null, locked = false
// what the flow panel shows: the anchor's lineage (filtered by scope), or a set picked by hand
let flowMode = 'lineage' // 'lineage' | 'pick'
let scope = 'both' // lineage filter: 'both', 'down' (the concept and everything it needs), 'up' (and everything that needs it)
const picks = new Set()
// picking happens on a frozen copy of the diagram that was showing: its concepts, and the concept it was the lineage of
let pickCanvas = new Set(), canvasAnchor = null
let lockKind = null, lockedSet = null // what a lock froze: 'lineage' or 'branch', and the set it lit
const isolate = new Set() // legend keys isolated by click

// ---------- data ----------
function prepare(data) {
  const byId = new Map(data.nodes.map((n) => [n.id, { ...n, pred: [], succ: [] }]))
  // an arc's tags come from the chain's tag records (src/chain/tags.ts); strong and weak are read as weight, other tags are only shown
  const links = data.links.filter((l) => byId.has(l.source) && byId.has(l.target)).map((l) => {
    const tags = l.tags ?? []
    return { source: l.source, target: l.target, tags, strength: tags.includes('strong') ? 'strong' : tags.includes('weak') ? 'weak' : null }
  })
  const arcs = new Map(links.map((l) => [`${l.source}->${l.target}`, l]))
  for (const l of links) { byId.get(l.source).succ.push(l.target); byId.get(l.target).pred.push(l.source) }
  const rootId = data.root ?? data.nodes.find((n) => n.root)?.id ?? data.nodes[0].id
  const root = byId.get(rootId)
  // depth = hops from the root down the "needs" arcs
  for (const n of byId.values()) n.depth = Infinity
  root.depth = 0
  const q = [root]
  while (q.length) { const x = q.shift(); for (const p of x.pred) { const y = byId.get(p); if (y.depth === Infinity) { y.depth = x.depth + 1; q.push(y) } } }
  let maxDepth = 0
  for (const n of byId.values()) { if (n.depth === Infinity) n.depth = 1; maxDepth = Math.max(maxDepth, n.depth) }
  // branch = the level-1 concept(s) a node sits under; primary = the nearest one
  const l1 = root.pred.map((id) => byId.get(id))
  for (const n of byId.values()) n.branches = []
  for (const b of l1) {
    const seen = new Set([b.id]), stack = [[b, 0]]
    while (stack.length) {
      const [x, d] = stack.pop()
      x.branches.push({ id: b.id, d })
      for (const p of x.pred) if (!seen.has(p)) { seen.add(p); stack.push([byId.get(p), d + 1]) }
    }
  }
  for (const n of byId.values()) {
    n.branches.sort((a, b) => a.d - b.d)
    n.branch = n.branches[0]?.id ?? null
    n.branchSet = new Set(n.branches.map((b) => b.id))
  }
  // how deep a concept decomposes: the longest chain of "needs" below it (0 for a leaf)
  const down = new Map()
  const below = (n) => { if (!down.has(n)) down.set(n, n.pred.length ? 1 + Math.max(...n.pred.map((id) => below(byId.get(id)))) : 0); return down.get(n) }
  const sizes = l1.map((b) => ({ id: b.id, n: [...byId.values()].filter((x) => x.branch === b.id).length, deep: below(b) + 1 }))
  sizes.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
  // hues evenly round the wheel; neighbours in the list alternate lightness so they never blur together
  const branches = sizes.map((b, i) => ({ ...b, color: oklch(i % 2 ? 0.7 : 0.8, 0.15, (i * 360) / sizes.length + 15) }))
  const branchColor = new Map(branches.map((b) => [b.id, b.color]))
  for (const n of byId.values()) {
    const [name, ...def] = n.title.split(' — ')
    n.name = def.length ? name : n.id
    n.def = def.length ? def.join(' — ') : n.title
    n.deg = n.pred.length + n.succ.length
    n.r = n.id === rootId ? 11 : 2.6 + Math.sqrt(n.deg) * 1.55
    n.branchColor = branchColor.get(n.branch) ?? ROOT_COLOR
    // seed positions on the right shell so the first frames already read as layered
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, rad = n.depth * R
    n.x = rad * Math.sqrt(1 - u * u) * Math.cos(t); n.y = rad * u; n.z = rad * Math.sqrt(1 - u * u) * Math.sin(t)
  }
  // arcs point at their concepts from the start: the force engine would resolve the ids only on its next tick,
  // and a redraw of a changed chain reads the lit set and the chart before that
  for (const l of links) { l.source = byId.get(l.source); l.target = byId.get(l.target) }
  return { name: data.name ?? rootId, nodes: [...byId.values()], links, arcs, byId, root, branches, maxDepth }
}

// ---------- scene ----------
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.22, 'rgba(255,255,255,.55)'); grd.addColorStop(0.5, 'rgba(255,255,255,.12)'); grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
})()
const sphereGeo = new THREE.SphereGeometry(1, 32, 20)

const graph = new ForceGraph3D($('#stage'), {
  controlType: 'orbit',
  extraRenderers: [new CSS2DRenderer()],
  // every frame goes through the bloom composer, whose buffer carries its own MSAA (see applyQuality);
  // the canvas's own antialiasing would never be seen and only costs memory
  rendererConfig: { antialias: false, powerPreference: 'high-performance' },
})
  .backgroundColor('#04050b')
  .showNavInfo(false)
  .nodeLabel(() => '')
  .nodeThreeObject(makeNode)
  .linkWidth(0)
  .linkMaterial((l) => l.mat)
  .linkDirectionalParticleWidth((l) => (l.strength === 'strong' ? 2.3 : l.strength === 'weak' ? 1 : 1.5))
  .linkDirectionalParticleSpeed(0.0045)
  .linkDirectionalParticleResolution(6)
  .cooldownTicks(400)
  .onNodeHover(onHover)
  .onNodeClick((n) => select(n))
  .onBackgroundClick(() => select(null))
  .onNodeDragEnd((n) => { if (n !== G.root) { n.fx = n.fy = n.fz = undefined } })

const controls = graph.controls()
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.autoRotateSpeed = 0.55
const renderer = graph.renderer()
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.5, 0.3)
graph.postProcessingComposer().addPass(bloom)
const scene = graph.scene()
scene.fog = new THREE.FogExp2(0x04050b, 0.00055)

// guides: dotted spheres (shells) or dotted discs (layers), one per depth
const guides = new THREE.Group()
scene.add(guides)
function buildGuides() {
  guides.clear()
  if (!G) return
  const mat = new THREE.PointsMaterial({ size: 1.3, color: 0x8b9cff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending })
  for (let d = 1; d <= G.maxDepth; d++) {
    const pts = []
    if (st.layout === 'shells') {
      const N = 380 * d, rad = d * R
      for (let i = 0; i < N; i++) { // fibonacci sphere
        const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), t = i * 2.399963
        pts.push(rad * r * Math.cos(t), rad * y, rad * r * Math.sin(t))
      }
    } else if (st.layout === 'layers') {
      const y = layerY(d), rad = R * (1.1 + 0.55 * d)
      for (let ring = 1; ring <= 5; ring++) {
        const rr = (rad * ring) / 5, N = 40 * ring
        for (let i = 0; i < N; i++) pts.push(rr * Math.cos((i / N) * Math.PI * 2), y, rr * Math.sin((i / N) * Math.PI * 2))
      }
    }
    if (!pts.length) continue
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    guides.add(new THREE.Points(g, mat))
  }
  guides.visible = st.guides
}

function makeNode(n) {
  const group = new THREE.Group()
  const color = new THREE.Color(n.branchColor)
  const core = new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.35, metalness: 0.15, transparent: true }))
  core.scale.setScalar(n.r)
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }))
  glow.scale.setScalar(n.r * 4)
  group.add(glow, core)
  if (n === G.root) {
    n.rings = [0, 1].map((i) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(n.r * (1.9 + i * 0.6), 0.32, 8, 128), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 - i * 0.2 }))
      ring.rotation.x = Math.PI / 2 + (i ? 0.5 : -0.3)
      group.add(ring)
      return ring
    })
  }
  const el = document.createElement('div')
  el.className = 'lbl' + (n === G.root ? ' root' : n.depth === 1 ? ' l1' : '')
  el.textContent = n.id
  const label = new CSS2DObject(el)
  label.center.set(0.5, -0.35)
  label.position.set(0, -n.r - 1, 0)
  group.add(label)
  Object.assign(n, { obj: group, core, glow, label, el, fade: 1, clear: false })
  n.labelOn = showLabel(n, !lit || lit.has(n))
  queueFocus() // built after the lit set was last applied (a redraw of a changed chain): apply it to the new objects too
  return group
}
let focusQueued = false
function queueFocus() {
  if (focusQueued) return
  focusQueued = true
  requestAnimationFrame(() => { focusQueued = false; focus() })
}

// ---------- forces ----------
const layerY = (d) => ((G.maxDepth / 2) - d) * R
function shellForce() {
  let nodes = []
  const f = (alpha) => {
    for (const n of nodes) {
      if (n === G.root) continue
      const d = Math.hypot(n.x, n.y, n.z) || 1e-6, k = ((n.depth * R - d) / d) * alpha * 0.85
      n.vx += n.x * k; n.vy += n.y * k; n.vz += n.z * k
    }
  }
  f.initialize = (ns) => (nodes = ns)
  return f
}
function layerForce() {
  let nodes = []
  const f = (alpha) => {
    for (const n of nodes) {
      if (n === G.root) continue
      n.vy += (layerY(n.depth) - n.y) * alpha * 0.9
      n.vx -= n.x * alpha * 0.012; n.vz -= n.z * alpha * 0.012
    }
  }
  f.initialize = (ns) => (nodes = ns)
  return f
}
function applyLayout() {
  const r = G.root
  r.fx = 0; r.fz = 0; r.fy = st.layout === 'layers' ? layerY(0) : 0
  graph.d3Force('shell', st.layout === 'shells' ? shellForce() : null)
  graph.d3Force('layer', st.layout === 'layers' ? layerForce() : null)
  graph.d3Force('charge').strength(st.layout === 'free' ? -90 : -55)
  graph.d3Force('link').distance((l) => (st.layout === 'free' ? 38 : R * 0.8 * Math.max(1, Math.abs(l.source.depth - l.target.depth)))).strength((l) => (st.layout === 'free' ? 0.5 : 0.12))
  buildGuides()
  graph.d3ReheatSimulation()
}

// ---------- coloring and the key ----------
function keyFor(n) {
  if (st.color === 'branch') return n === G.root ? null : n.branch
  if (st.color === 'depth') return String(n.depth)
  return n.verdict
}
function colorFor(n) {
  if (st.color === 'branch') return n === G.root ? ROOT_COLOR : n.branchColor
  if (st.color === 'depth') return DEPTH[Math.min(n.depth, DEPTH.length - 1)]
  return VERDICT[n.verdict] ?? '#9ca3af'
}
function keyEntries() {
  if (st.color === 'branch') return G.branches.map((b) => ({ key: b.id, label: b.id, color: b.color, n: b.n, deep: b.deep }))
  if (st.color === 'depth') {
    return Array.from({ length: G.maxDepth + 1 }, (_, d) => ({ key: String(d), label: d === 0 ? 'root' : `depth ${d}`, color: DEPTH[Math.min(d, DEPTH.length - 1)], n: G.nodes.filter((n) => n.depth === d).length }))
  }
  return Object.keys(VERDICT).map((v) => ({ key: v, label: v, color: VERDICT[v], n: G.nodes.filter((n) => n.verdict === v).length }))
}
// a node belongs to a key directly, or (for branches) by sitting anywhere under it
const inKey = (n, key) => (st.color === 'branch' ? n.branchSet.has(key) : keyFor(n) === key)

const WHITE = new THREE.Color('#fff')
// line opacity by weight: [no set lit, in the lit set, outside it]; additive blending makes opacity read as brightness
const LINK_ALPHA = { strong: [0.6, 1, 0.03], null: [0.2, 0.7, 0.02], weak: [0.05, 0.2, 0.01] }
const LINK_PARTICLES = { strong: [2, 4], null: [1, 3], weak: [0, 1] }
function recolor() {
  for (const n of G.nodes) {
    n.color = colorFor(n)
    if (!n.core) continue
    n.core.material.color.set(n.color); n.core.material.emissive.set(n.color); n.glow.material.color.set(n.color)
  }
  for (const l of G.links) {
    l.mat ??= new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    l.mat.color.set(l.source.color)
    if (l.strength === 'strong') l.mat.color.lerp(WHITE, 0.45)
  }
  renderKey()
  focus()
  renderFlow()
}

// the key has two views: the grid of entries, and (after a click) the list of one entry's concepts
let openKey = null
let keySort = 'n' // how the branch table is ordered: 'name', 'n' (concepts) or 'deep' (depth)
function renderKey() {
  const entries = keyEntries()
  const open = entries.find((e) => e.key === openKey)
  if (!open) openKey = null
  $('#key-title').textContent = { branch: 'Branches', depth: 'Depth from root', verdict: 'Verdicts' }[st.color]
  $('#key-hint').textContent = open ? 'click a concept to focus it' : st.color === 'branch' ? 'hover to trace · click to list' : 'click to list'
  const key = $('#key')
  $('#legend').classList.toggle('listing', !!open)
  key.classList.toggle('list', !!open)
  const table = !open && st.color === 'branch'
  key.classList.toggle('table', table)
  key.classList.toggle('single', !open && !table && entries.length <= 6)
  if (table) {
    // branches read as a table, sortable by any column, so full names fit
    const by = { name: (a, b) => a.label.localeCompare(b.label), n: (a, b) => b.n - a.n || a.label.localeCompare(b.label), deep: (a, b) => b.deep - a.deep || b.n - a.n }
    entries.sort(by[keySort])
  }
  key.classList.toggle('filtering', !open && isolate.size > 0)
  const head = table ? `<div class="kh">${[['name', 'branch'], ['n', 'concepts'], ['deep', 'depth']].map(([k, l]) => `<button type="button" data-sort="${k}" class="${keySort === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''
  key.innerHTML = open ? keyList(open) : head + entries.map((e) => `<div class="chip${isolate.has(e.key) ? ' on' : ''}" data-key="${esc(e.key)}" style="--c:${e.color}"><span class="dot"></span><span class="name">${esc(e.label)}</span><span class="n">${e.n}</span>${e.deep ? `<span class="dp" title="${e.deep} levels deep: the longest chain of needs from ${esc(e.label)} down">↓${e.deep}</span>` : ''}</div>`).join('')
  key.scrollTop = 0
  markRows()
  syncBranchLock()
}
// one entry's concepts, grouped by depth (or by branch, when the entries are depths)
// For a branch: first its own concepts (the ones drawn in its colour, as the key counts them), by depth; then
// the concepts it needs whose nearest branch is another one. For a depth or verdict: its concepts, grouped.
function keyList(entry) {
  const isBranch = st.color === 'branch', byBranch = st.color === 'depth'
  const members = G.nodes.filter((n) => n !== G.root && inKey(n, entry.key))
  const own = isBranch ? members.filter((n) => n.branch === entry.key) : members
  const borrowed = isBranch ? members.filter((n) => n.branch !== entry.key) : []
  const groups = new Map()
  for (const n of own) {
    const g = byBranch ? n.branch : n.depth
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(n)
  }
  const branchIx = new Map(G.branches.map((b, i) => [b.id, i]))
  const order = [...groups.keys()].sort((a, b) => (byBranch ? branchIx.get(a) - branchIx.get(b) : a - b))
  const gLabel = (g) => (byBranch ? g : `depth ${g}`)
  const row = (n, badge) => `<div class="row" data-go="${esc(n.id)}" style="--c:${n.color}" title="${esc(n.def)}"><span class="dot"></span><span class="name">${esc(n.id)}</span>${badge}</div>`
  let html = `<div class="kl-bar"><button class="kl-back" type="button">‹ All ${esc($('#key-title').textContent.toLowerCase())}</button>` +
    `<button class="kl-lock fbtn" type="button" title="keep this whole set lit (L) — clicking a concept then only moves the rotation point"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></svg><span>Lock</span></button></div>`
  html += `<div class="kl-title" style="--c:${entry.color}"><span class="dot"></span><b>${esc(entry.label)}</b><span>${own.length} concepts${entry.deep ? ` · ↓${entry.deep} levels deep` : ''}${borrowed.length ? ` · needs ${borrowed.length} more from other branches` : ''}</span></div>`
  html += `<div class="kl-pills">${order.map((g) => `<button type="button" data-jump="${esc(g)}">${esc(gLabel(g))} <b>${groups.get(g).length}</b></button>`).join('')}`
  html += `${borrowed.length ? `<button type="button" data-jump="borrowed">other branches <b>${borrowed.length}</b></button>` : ''}</div>`
  for (const g of order) {
    const rows = groups.get(g).sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id))
    html += `<div class="kl-group" data-g="${esc(g)}"><h4>${esc(gLabel(g))}<em>${rows.length}</em></h4>`
    for (const n of rows) {
      const others = n.branches.map((b) => b.id).filter((id) => id !== entry.key && id !== n.id)
      const badge = isBranch && n.id === entry.key ? '<span class="kb">branch</span>'
        : isBranch && others.length ? `<span class="kb" title="also needed by the branches ${esc(others.join(', '))}">+${others.length}</span>` : ''
      html += row(n, badge)
    }
    html += '</div>'
  }
  if (borrowed.length) {
    html += `<div class="kl-group" data-g="borrowed"><h4>needed from other branches<em>${borrowed.length}</em></h4>`
    for (const n of borrowed.sort((a, b) => a.depth - b.depth || (branchIx.get(a.branch) ?? 0) - (branchIx.get(b.branch) ?? 0) || a.id.localeCompare(b.id))) {
      html += row(n, `<span class="kb" title="its own branch, at depth ${n.depth}">${esc(n.branch === n.id ? 'branch' : n.branch)}</span>`)
    }
    html += '</div>'
  }
  return html
}
// which rows are the focused node, the anchor, or outside a locked set
function markRows() {
  for (const r of document.querySelectorAll('#key .row')) {
    const n = G.byId.get(r.dataset.go)
    r.classList.toggle('sel', n === selected)
    r.classList.toggle('anc', n === anchor && n !== selected)
    r.classList.toggle('out', locked && !!lit && !lit.has(n))
  }
}
function openList(k) {
  if (locked && lockKind === 'branch') setLock(false) // leaving or switching the list releases its lock
  openKey = k
  isolate.clear(); if (k) isolate.add(k)
  renderKey(); focus()
}
$('#key').addEventListener('click', (e) => {
  const sort = e.target.closest('[data-sort]')?.dataset.sort
  if (sort) { keySort = sort; return renderKey() }
  if (e.target.closest('.kl-back')) return openList(null)
  if (e.target.closest('.kl-lock')) return setLock(!(locked && lockKind === 'branch'), 'branch')
  const jump = e.target.closest('[data-jump]')?.dataset.jump
  if (jump != null) return $(`#key .kl-group[data-g="${CSS.escape(jump)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const go = e.target.closest('.row')?.dataset.go
  if (go) return select(G.byId.get(go))
  const chip = e.target.closest('.chip'); if (!chip) return
  const k = chip.dataset.key
  if (e.shiftKey || e.metaKey) { isolate.has(k) ? isolate.delete(k) : isolate.add(k); renderKey(); focus() } // isolate several, no list
  else openList(k)
})
$('#key').addEventListener('mouseover', (e) => {
  // hovering a row lights that concept's lineage; hovering a chip traces the entry
  const go = e.target.closest('.row')?.dataset.go
  const n = go ? G.byId.get(go) : null
  if (n !== hovered && (n || hovered)) { hovered = n; if (n) n.labelOn = true; focus() }
  const k = openKey ? null : e.target.closest('.chip')?.dataset.key ?? null
  if (k !== hoverBranch) { hoverBranch = k; focus() }
})
$('#key').addEventListener('mouseleave', () => { hovered = null; hoverBranch = null; focus() })

// ---------- focus: what is lit, what fades ----------
function lineage(n, sc = 'both') {
  // the concept, everything it needs (down: its predecessors) and everything that needs it (up: its successors, to the root)
  const set = new Set([n])
  const walk = (x, dir) => { for (const id of x[dir]) { const y = G.byId.get(id); if (!set.has(y)) { set.add(y); walk(y, dir) } } }
  if (sc !== 'up') walk(n, 'pred')
  if (sc !== 'down' && n !== G.root) walk(n, 'succ')
  return set
}
// the set the flow panel charts and the lock freezes
function flowSet() {
  if (flowMode === 'pick') return picks.size ? new Set(picks) : null // what Lock and Frame act on
  return anchor ? lineage(anchor, scope) : null
}
const neighbours = (n) => [...n.pred, ...n.succ].map((id) => G.byId.get(id))
// what can be picked next: anything in the diagram at first, then only concepts one link from a pick
function pickCandidates() {
  if (!picks.size) return new Set(pickCanvas)
  const c = new Set()
  for (const n of picks) for (const m of neighbours(n)) if (!picks.has(m) && pickCanvas.has(m)) c.add(m)
  return c
}
function connected(set) {
  if (set.size < 2) return true
  const [first] = set, seen = new Set([first]), stack = [first]
  while (stack.length) for (const m of neighbours(stack.pop())) if (set.has(m) && !seen.has(m)) { seen.add(m); stack.push(m) }
  return seen.size === set.size
}
function litSet() {
  if (locked) return lockedSet
  if (flowMode === 'pick') return picks // possibly empty: nothing lit until you pick
  if (anchor) return lineage(anchor, scope)
  if (hovered) return lineage(hovered)
  const keys = hoverBranch ? [hoverBranch] : [...isolate]
  if (keys.length) return new Set(G.nodes.filter((n) => n === G.root || keys.some((k) => inKey(n, k))))
  return null
}
let lit = null, cands = null
function focus() {
  if (!G) return
  lit = litSet()
  cands = flowMode === 'pick' && !locked ? pickCandidates() : null // the chart's pickable hints
  for (const n of G.nodes) {
    if (!n.core) continue
    const on = !lit || lit.has(n)
    n.core.material.opacity = on ? 1 : 0.07
    n.core.material.emissiveIntensity = n === selected && on ? 0.75 : on ? 0.4 : 0.08
    n.glow.material.opacity = on ? (n === selected ? 0.5 : 0.28) : 0.02
    if (n.rings) n.rings.forEach((r, i) => (r.material.opacity = on ? 0.55 - i * 0.2 : 0.05))
    n.el.classList.toggle('sel', n === selected && on)
    n.el.classList.toggle('anchor', n === anchor && n !== selected && flowMode !== 'pick')
    n.labelOn = showLabel(n, on)
  }
  for (const l of G.links) {
    const on = !lit || (lit.has(l.source) && lit.has(l.target))
    l.on = on
    if (l.mat) l.mat.opacity = LINK_ALPHA[l.strength][!lit ? 0 : on ? 1 : 2]
  }
  graph.linkDirectionalParticles((l) => (!st.flow ? 0 : lit ? (l.on ? LINK_PARTICLES[l.strength][1] : 0) : LINK_PARTICLES[l.strength][0]))
  graph.linkDirectionalParticleColor((l) => l.source.color)
  markRows()
}
function showLabel(n, on) {
  if (n === hovered) return true
  if (flowMode === 'pick') return on // while picking, only the picks are named
  if (n === selected || n === anchor || n === G.root) return true
  if (!on) return false
  if (st.labels === 'all') return true
  if (st.labels === 'off') return false
  return n.depth <= 1 || (lit !== null && lit.size < 60)
}

// ---------- hover, select, fly ----------
const hoverEl = $('#hover')
let mouse = { x: 0, y: 0 }
addEventListener('pointermove', (e) => {
  mouse = { x: e.clientX, y: e.clientY }
  if (hovered) placeHover(!!e.target.closest?.('#flow'))
})
// over the flow chart the card sits above the cursor, so it never covers the next row
function placeHover(above = false) {
  const w = hoverEl.offsetWidth, h = hoverEl.offsetHeight
  if (above) {
    hoverEl.style.left = Math.max(12, Math.min(mouse.x - w / 2, innerWidth - w - 12)) + 'px'
    hoverEl.style.top = Math.max(12, mouse.y - h - 18) + 'px'
    return
  }
  hoverEl.style.left = Math.min(mouse.x + 16, innerWidth - w - 12) + 'px'
  hoverEl.style.top = Math.min(mouse.y + 16, innerHeight - h - 12) + 'px'
}
function onHover(n) {
  if (n === hovered) return
  hovered = n
  const inside = locked ? !!(lit && n && lit.has(n)) : flowMode === 'pick' && n ? picks.has(n) || !!cands?.has(n) : true
  $('#stage').style.cursor = n ? (inside ? 'pointer' : 'not-allowed') : ''
  if (n) {
    const act = n === selected && flowMode !== 'pick' ? '' : locked ? (inside ? ' · click to pivot here' : ' · outside the locked set')
      : flowMode === 'pick' ? (picks.has(n) ? ' · click to unpick' : cands?.has(n) ? ' · click to pick' : pickCanvas.has(n) ? ' · not connected to your picks' : ' · not in this diagram')
      : ' · click to focus'
    hoverEl.innerHTML = `<b><span class="dot" style="--c:${n.color}"></span>${esc(n.id)}</b><p>${esc(n.def)}</p><small>depth ${n.depth} · needs ${n.pred.length} · needed by ${n.succ.length}${act}</small>`
    placeHover()
  }
  hoverEl.classList.toggle('show', !!n)
  if (!selected) focus()
  else if (n) n.labelOn = true
}
// the camera keeps following the focused node while the layout is still moving, until the user frames instead
let flownAt = 0, following = false, lastTick = 0
graph.onEngineTick(() => (lastTick = performance.now()))
function flyTo(n, ms = 1100) {
  // far enough back to keep the whole lit set of n in view, not just n
  const reach = Math.max(0, ...[...lineage(n)].map((m) => Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z)))
  const d = n === G.root ? R * 3.2 : Math.min(900, Math.max(140, n.r * 16, reach * 1.6))
  const out = new THREE.Vector3(n.x, n.y, n.z)
  // look from outside and to the side, so the bright root is never straight behind the node
  const side = new THREE.Vector3().crossVectors(out, new THREE.Vector3(0, 1, 0))
  if (side.length() < 1e-3) side.set(1, 0, 0)
  const dir = out.length() < 1 ? new THREE.Vector3(0.35, 0.3, 1).normalize() : out.normalize().add(side.normalize().multiplyScalar(0.9)).add(new THREE.Vector3(0, 0.35, 0)).normalize()
  flownAt = performance.now() + ms; following = true
  graph.cameraPosition({ x: n.x + dir.x * d, y: n.y + dir.y * d, z: n.z + dir.z * d }, { x: n.x, y: n.y, z: n.z }, ms)
}
// move the rotation point to n without zooming or turning: slide camera and target together
function pivotTo(n, ms = 800) {
  const c = graph.camera().position, t = controls.target
  flownAt = performance.now() + ms; following = true
  graph.cameraPosition({ x: c.x + n.x - t.x, y: c.y + n.y - t.y, z: c.z + n.z - t.z }, { x: n.x, y: n.y, z: n.z }, ms)
}
function frameSet() {
  following = false
  const set = lit?.size ? lit : flowMode === 'pick' ? pickCanvas : null
  // the scene is centred in freeRect (viewOffset); pad the fit so the set also shrinks to freeRect's size
  const f = freeRect ?? { w: innerWidth, h: innerHeight }
  const pad = (innerHeight * (1 - Math.min(f.w / innerWidth, f.h / innerHeight))) / 2 + 30
  graph.zoomToFit(900, pad, set?.size ? (n) => set.has(n) : () => true)
}
function select(n, fly = true) {
  if (locked) {
    if (!n) return // a background click keeps the locked set
    if (!lockedSet.has(n)) return nudgeLock()
    selected = n
    // a lineage lock keeps its anchor; under a branch lock the chart follows the concept you are looking at
    if (lockKind === 'branch') anchor = n
    controls.autoRotate = false
    if (fly) pivotTo(n)
    renderDetail(n)
    $('#detail').classList.add('open')
    focus(); renderFlow()
    return
  }
  if (flowMode === 'pick') return n ? togglePick(n) : undefined // a background click keeps the picks
  anchor = selected = n
  controls.autoRotate = st.rotate && !n
  if (n) { if (fly) flyTo(n); renderDetail(n) }
  $('#detail').classList.toggle('open', !!n)
  focus(); renderFlow()
}
// Picking: a click picks a concept of the diagram, a second click unpicks it. The first pick can be anywhere;
// after that a pick must link to an earlier one, and an unpick must not split the picks in two.
function togglePick(n) {
  if (!pickCanvas.has(n)) return flowToast(`${n.id} is not in this diagram — switch to Lineage to chart another one`)
  if (picks.has(n)) {
    const rest = new Set(picks); rest.delete(n)
    if (!connected(rest)) return flowToast(`unpicking ${n.id} would split your picks in two — unpick from an end first`)
    picks.delete(n)
  } else {
    if (picks.size && !neighbours(n).some((m) => picks.has(m))) return flowToast(`${n.id} is not connected to your picks — pick a concept between them first`)
    picks.add(n)
  }
  selected = n // the details follow the last concept you clicked; the camera stays where it is
  controls.autoRotate = false
  renderDetail(n)
  $('#detail').classList.add('open')
  focus(); renderFlow()
}
let toastTimer = 0
// a short refusal in the flow toolbar; shakes the lock button too
function flowToast(text) {
  const m = $('#flow-msg')
  m.textContent = text
  m.classList.add('show')
  nudgeLock()
  clearTimeout(toastTimer); toastTimer = setTimeout(() => m.classList.remove('show'), 2800)
}
// locking freezes what is lit right now: a concept's lineage ('lineage', from the flow chart) or a branch ('branch', from its list)
function setLock(v, kind = 'lineage') {
  if (v && kind === 'lineage' && !flowSet()) return
  if (v && kind === 'branch' && !isolate.size) return
  locked = v
  lockKind = v ? kind : null
  lockedSet = !v ? null : kind === 'branch' ? new Set(G.nodes.filter((n) => n === G.root || [...isolate].some((k) => inKey(n, k)))) : flowSet()
  $('#lock').classList.toggle('on', locked)
  $('#lock span').textContent = !locked ? 'Lock set' : lockKind === 'branch' ? 'Branch locked' : 'Locked'
  $('#lock-shackle').setAttribute('d', locked ? 'M8 11V7a4 4 0 0 1 8 0' : 'M8 11V7a4 4 0 0 1 7.5-2')
  $('#flow').classList.toggle('locked', locked)
  fab.classList.toggle('locked', locked)
  $('#flow-click').textContent = locked ? 'click: move the rotation point' : 'click: focus'
  syncBranchLock()
  if (G) { focus(); renderFlow() } else syncFlowTools()
}
function syncBranchLock() {
  const b = $('#key .kl-lock'); if (!b) return
  const on = locked && lockKind === 'branch'
  b.classList.toggle('on', on)
  b.querySelector('span').textContent = on ? 'Locked' : 'Lock'
  b.querySelector('path').setAttribute('d', on ? 'M8 11V7a4 4 0 0 1 8 0' : 'M8 11V7a4 4 0 0 1 7.5-2')
  $('#legend').classList.toggle('locked', on)
}
function nudgeLock() {
  for (const b of [$('#lock'), $('#key .kl-lock')]) {
    if (!b) continue
    b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge')
  }
}

// ---------- the lit set as a flow chart: root on top, each concept above what it needs ----------
const SVGNS = 'http://www.w3.org/2000/svg'
let flowView = null // { pos: Map(node -> {x, y, w}), W, H } of the last render
function layoutFlow(set) {
  const nodes = [...set]
  // layer = longest path down from the root inside the set, so every arc points strictly upward
  const layer = new Map()
  const layerOf = (n) => {
    if (layer.has(n)) return layer.get(n)
    layer.set(n, 0)
    const ups = n.succ.map((id) => G.byId.get(id)).filter((s) => set.has(s))
    const v = n === G.root || !ups.length ? 0 : 1 + Math.max(...ups.map(layerOf))
    layer.set(n, v)
    return v
  }
  nodes.forEach(layerOf)
  const rows = []
  for (const n of nodes) (rows[layer.get(n)] ??= []).push(n)
  const branchIx = new Map(G.branches.map((b, i) => [b.id, i]))
  rows.forEach((r) => r.sort((a, b) => (branchIx.get(a.branch) ?? -1) - (branchIx.get(b.branch) ?? -1) || a.id.localeCompare(b.id)))
  const GAP = 14, PAD = 22, ROW = 54, H = 26
  const width = (n) => n.id.length * 7 + 34
  const pos = new Map()
  const place = () => {
    const rowW = rows.map((r) => r.reduce((s, n) => s + width(n), 0) + GAP * (r.length - 1))
    const W = Math.max(...rowW) + PAD * 2
    rows.forEach((r, i) => {
      let x = (W - rowW[i]) / 2
      for (const n of r) { const w = width(n); pos.set(n, { x: x + w / 2, y: PAD + i * ROW + H / 2, w }); x += w + GAP }
    })
    return W
  }
  place()
  // barycentre sweeps: order each row by the mean x of its neighbours in the row above, then below
  const mean = (n, dir) => {
    const xs = n[dir].map((id) => G.byId.get(id)).filter((m) => set.has(m)).map((m) => pos.get(m).x)
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : pos.get(n).x
  }
  for (let it = 0; it < 4; it++) {
    for (let i = 1; i < rows.length; i++) { rows[i].sort((a, b) => mean(a, 'succ') - mean(b, 'succ')); place() }
    for (let i = rows.length - 2; i >= 0; i--) { rows[i].sort((a, b) => mean(a, 'pred') - mean(b, 'pred')); place() }
  }
  const W = place()
  return { pos, W, H: PAD * 2 + (rows.length - 1) * ROW + H, h: H }
}
function renderFlow() {
  const picking = flowMode === 'pick'
  document.body.classList.toggle('has-flow', !!anchor || picking)
  syncFlowTools()
  if (!anchor && !picking) { flowView = null; return }
  const body = $('#flow-body')
  const set = picking ? pickCanvas : flowSet() ?? new Set()
  const edges = G.links.filter((l) => set.has(l.source) && set.has(l.target))
  const pickedLinks = picking ? edges.filter((l) => picks.has(l.source) && picks.has(l.target)).length : 0
  const head = picking ? canvasAnchor : anchor
  $('#flow-title').textContent = picking ? 'Pick set' : 'Lineage'
  $('#flow-anchor').innerHTML = head ? `<span class="dot" style="--c:${head.color};display:inline-block;margin-right:7px"></span>${esc(head.id)}` : ''
  $('#flow-count').textContent = picking ? `${picks.size} picked of ${set.size} · ${pickedLinks} links` : `${set.size} concepts · ${edges.length} links`
  $('#fab-n').textContent = picking ? picks.size : set.size
  fab.title = `${picking ? `${picks.size} picked in the lineage of ${head?.id}` : `lineage of ${anchor.id} — ${set.size} concepts`} · click to expand, drag to move`
  if (!set.size) {
    flowView = null
    body.innerHTML = `<div class="fmsg">Nothing to pick from. Switch to Lineage, select a concept, then come back:<br>its diagram becomes the one you pick on.</div>`
    return
  }
  if (set.size > 200) {
    flowView = null
    body.innerHTML = `<div class="fmsg">The lineage of <b>${esc(anchor.id)}</b> is ${set.size} concepts — too many for a chart.<br>Select a concept further down to see its chain.</div>`
    return
  }
  const L = layoutFlow(set)
  // zoom: 'auto' fits with a readable floor, 'fit' shows the whole chart, a number is the user's own zoom.
  // A new chart starts at 'auto'; re-rendering the same chart keeps the zoom and the scroll position.
  // in pick mode the chart is one evolving set, so the zoom you chose carries across adds and removes
  const chartKey = picking ? `pick:${canvasAnchor?.id}:${pickCanvas.size}` : `lineage:${anchor.id}:${scope}`
  const sameChart = !!flowView && flowView.key === chartKey
  if (!sameChart) flowZoom = 'auto'
  const panel = $('#flow'), chrome = panel.offsetHeight - body.clientHeight
  const wFit = (body.clientWidth - 12) / L.W
  let bodyH = body.clientHeight
  if (!panel.classList.contains('floating')) {
    // docked, the panel grows to the chart, up to half the window. Use the target height, not a measured one:
    // the panel animates its height, so a measurement lags behind
    const drawn = typeof flowZoom === 'number' ? flowZoom : flowZoom === 'fit' ? Math.min(1.05, wFit) : Math.max(0.6, Math.min(1.05, wFit))
    const target = Math.round(Math.min(innerHeight * 0.62, Math.max(320, L.H * drawn + chrome + 14)))
    if (!document.body.classList.contains('flow-min')) panel.style.height = target + 'px'
    bodyH = target - chrome
  }
  const fit = Math.min(wFit, (bodyH - 12) / L.H)
  const scale = typeof flowZoom === 'number' ? flowZoom : flowZoom === 'fit' ? Math.min(fit, 1.5) : Math.max(0.6, Math.min(1.05, fit))
  const keep = sameChart && flowView.selected === selected ? { left: body.scrollLeft, top: body.scrollTop } : null
  flowView = { ...L, key: chartKey, selected, scale }
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.id = 'flow-svg'
  svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`)
  svg.setAttribute('width', L.W * scale); svg.setAttribute('height', L.H * scale)
  svg.classList.toggle('noflow', !st.flow)
  let html = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9 z" fill="context-stroke" /></marker></defs><g>`
  for (const l of edges) {
    const a = L.pos.get(l.source), b = L.pos.get(l.target) // source needs-of target: drawn from below up into it
    const y1 = a.y - L.h / 2, y2 = b.y + L.h / 2 + 2, dy = Math.max(24, (y1 - y2) / 2)
    const d = `M${a.x} ${y1} C${a.x} ${y1 - dy} ${b.x} ${y2 + dy} ${b.x} ${y2}`
    const key = `data-s="${esc(l.source.id)}" data-t="${esc(l.target.id)}"`
    const pk = picking ? (picks.has(l.source) && picks.has(l.target) ? ' pk' : ' unpk') : ''
    const w = l.strength ? ` s-${l.strength}` : ''
    const tip = l.tags?.length ? `<title>${esc(l.source.id)} → ${esc(l.target.id)}: ${esc(l.tags.join(', '))}</title>` : ''
    html += `<path class="edge${pk}${w}" ${key} d="${d}" stroke="${l.source.color}" marker-end="url(#arrow)">${tip}</path><path class="dash${pk}${w}" ${key} d="${d}" />`
  }
  html += '</g><g>'
  for (const [n, p] of L.pos) {
    const pickCls = !picking ? '' : picks.has(n) ? 'picked' : cands?.has(n) && !locked ? 'pickable' : 'unpicked'
    const cls = ['fn', n === G.root ? 'root' : '', n === selected && !picking ? 'sel' : '', locked && !lockedSet.has(n) ? 'out' : '', pickCls].join(' ')
    const x = p.x - p.w / 2, y = p.y - L.h / 2
    html += `<g class="${cls}" data-id="${esc(n.id)}">`
    if (n === head) html += `<rect class="ring" x="${x - 5}" y="${y - 5}" width="${p.w + 10}" height="${L.h + 10}" rx="${L.h / 2 + 5}" />`
    const fill = picking ? (picks.has(n) ? ` style="fill:${n.color}38"` : '') : n === selected ? ` style="fill:${n.color}33"` : ''
    html += `<rect x="${x}" y="${y}" width="${p.w}" height="${L.h}" rx="${L.h / 2}" stroke="${n.color}"${fill} />`
    html += `<circle cx="${x + 13}" cy="${p.y}" r="4" fill="${n.color}" /><text x="${x + 23}" y="${p.y}">${esc(n.id)}</text></g>`
  }
  svg.innerHTML = html + '</g>'
  body.replaceChildren(svg)
  $('#zoom-fit').textContent = `${Math.round(scale * 100)}%`
  // the same chart keeps where you were; a newly focused concept is brought into view
  const sp = L.pos.get(selected)
  if (keep) body.scrollTo(keep)
  else if (flowZoom === 'fit') body.scrollTo(0, 0)
  else if (sp) body.scrollTo({ left: sp.x * scale - body.clientWidth / 2, top: sp.y * scale - body.clientHeight / 2, behavior: 'smooth' })
}

// ---------- the flow panel: zoom and pan its chart, move and resize the panel itself ----------
const flowBody = $('#flow-body')
let flowZoom = 'auto'
// zoom about a point of the chart's viewport (default: its centre), keeping that point where it is
function zoomFlowTo(z, cx, cy) {
  const body = $('#flow-body'), svg = $('#flow-svg')
  if (!svg || !flowView) return
  const b = body.getBoundingClientRect(), r = svg.getBoundingClientRect(), old = flowView.scale
  if (cx == null) { cx = body.clientWidth / 2; cy = body.clientHeight / 2 }
  const px = (b.left + cx - r.left) / old, py = (b.top + cy - r.top) / old
  z = Math.max(0.2, Math.min(2.5, z))
  flowZoom = flowView.scale = z
  svg.setAttribute('width', flowView.W * z); svg.setAttribute('height', flowView.H * z)
  const r2 = svg.getBoundingClientRect()
  body.scrollLeft += r2.left + px * z - (b.left + cx)
  body.scrollTop += r2.top + py * z - (b.top + cy)
  $('#zoom-fit').textContent = `${Math.round(z * 100)}%`
}
$('#zoom-in').addEventListener('click', () => flowView && zoomFlowTo(flowView.scale * 1.25))
$('#zoom-out').addEventListener('click', () => flowView && zoomFlowTo(flowView.scale / 1.25))
$('#zoom-fit').addEventListener('click', () => { flowZoom = 'fit'; renderFlow() })
// pinch on a trackpad arrives as ctrl+wheel; ⌘/ctrl+wheel with a mouse
flowBody.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !flowView) return
  e.preventDefault()
  const b = flowBody.getBoundingClientRect()
  zoomFlowTo(flowView.scale * Math.exp(-e.deltaY * 0.0025), e.clientX - b.left, e.clientY - b.top)
}, { passive: false })
// drag empty chart space to pan
flowBody.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.fn')) return
  const start = { x: e.clientX, y: e.clientY, left: flowBody.scrollLeft, top: flowBody.scrollTop }
  flowBody.setPointerCapture(e.pointerId)
  flowBody.classList.add('panning')
  const move = (ev) => { flowBody.scrollLeft = start.left - (ev.clientX - start.x); flowBody.scrollTop = start.top - (ev.clientY - start.y) }
  const up = () => { flowBody.classList.remove('panning'); flowBody.removeEventListener('pointermove', move); flowBody.removeEventListener('pointerup', up); flowBody.removeEventListener('pointercancel', up) }
  flowBody.addEventListener('pointermove', move); flowBody.addEventListener('pointerup', up); flowBody.addEventListener('pointercancel', up)
})

// the panel docks at the bottom until it is dragged or resized; then it floats where you put it (and is remembered)
const flowPanel = $('#flow')
function placeFlow(r) {
  const w = Math.min(Math.max(360, r.width), innerWidth - 16), h = Math.min(Math.max(140, r.height), innerHeight - 16)
  const left = Math.min(Math.max(8, r.left), innerWidth - w - 8), top = Math.min(Math.max(8, r.top), innerHeight - h - 8)
  Object.assign(flowPanel.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px', right: 'auto', bottom: 'auto' })
  flowPanel.classList.add('floating')
  return { left, top, width: w, height: h }
}
function saveFlowRect(r) { try { localStorage.setItem('ddag3d.flowRect', JSON.stringify(r)) } catch {} }
function dockFlow() {
  flowPanel.classList.remove('floating')
  for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) flowPanel.style[k] = ''
  try { localStorage.removeItem('ddag3d.flowRect') } catch {}
  renderFlow(); viewOffset()
}
let flowRaf = 0
const refitSoon = () => { cancelAnimationFrame(flowRaf); flowRaf = requestAnimationFrame(renderFlow) }
function dragFlow(e, dir) {
  // dir: null moves the panel; n/s/e/w and corners resize it
  if (e.button !== 0) return
  e.preventDefault()
  const s = flowPanel.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY
  let rect = placeFlow(s)
  flowPanel.classList.add('moving')
  const move = (ev) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0
    const r = { left: s.left, top: s.top, width: s.width, height: s.height }
    if (!dir) { r.left += dx; r.top += dy }
    else {
      // each dragged edge stops at the window border and at the minimum size; the opposite edge never moves
      if (dir.includes('e')) r.width = Math.min(s.width + dx, innerWidth - 8 - s.left)
      if (dir.includes('s')) r.height = Math.min(s.height + dy, innerHeight - 8 - s.top)
      if (dir.includes('w')) { r.left = Math.max(8, Math.min(s.left + dx, s.right - 360)); r.width = s.right - r.left }
      if (dir.includes('n')) { r.top = Math.max(8, Math.min(s.top + dy, s.bottom - 140)); r.height = s.bottom - r.top }
    }
    rect = placeFlow(r)
    if (dir) refitSoon()
  }
  const up = () => {
    flowPanel.classList.remove('moving')
    removeEventListener('pointermove', move); removeEventListener('pointerup', up)
    saveFlowRect(rect); viewOffset()
  }
  addEventListener('pointermove', move); addEventListener('pointerup', up)
}
$('#flow header').addEventListener('pointerdown', (e) => { if (!e.target.closest('button, .zoom')) dragFlow(e, null) })
$('#flow header').addEventListener('dblclick', (e) => { if (!e.target.closest('button, .zoom')) dockFlow() })
document.querySelectorAll('#flow .rz').forEach((h) => h.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragFlow(e, h.dataset.dir) }))
$('#flow-dock').addEventListener('click', dockFlow)
try { const r = JSON.parse(localStorage.getItem('ddag3d.flowRect')); if (r && r.width) placeFlow(r) } catch {}
flowBody.addEventListener('click', (e) => {
  const id = e.target.closest('.fn')?.dataset.id
  if (id) select(G.byId.get(id))
})
flowBody.addEventListener('mouseover', (e) => {
  const id = e.target.closest('.fn')?.dataset.id ?? null
  const n = id ? G.byId.get(id) : null
  if (n === hovered) return
  hovered = n
  const svg = $('#flow-svg')
  if (svg) {
    svg.classList.toggle('hovering', !!n)
    svg.querySelectorAll('.edge, .dash').forEach((p) => p.classList.toggle('hot', !!n && (p.dataset.s === id || p.dataset.t === id)))
  }
  if (n) {
    n.labelOn = true
    hoverEl.innerHTML = `<b><span class="dot" style="--c:${n.color}"></span>${esc(n.id)}</b><p>${esc(n.def)}</p><small>depth ${n.depth} · needs ${n.pred.length} · needed by ${n.succ.length}</small>`
    placeHover(true)
  }
  hoverEl.classList.toggle('show', !!n)
  focus()
})
flowBody.addEventListener('mouseleave', () => {
  hovered = null; hoverEl.classList.remove('show')
  $('#flow-svg')?.classList.remove('hovering')
  focus()
})
$('#lock').addEventListener('click', () => setLock(!locked))
// the toolbar under the flow header: lineage (with its scope filter) or a hand-picked set
function syncFlowTools() {
  for (const b of document.querySelectorAll('#flow-mode button')) b.classList.toggle('on', b.dataset.v === flowMode)
  for (const b of document.querySelectorAll('#flow-scope button')) b.classList.toggle('on', b.dataset.v === scope)
  $('#flow-scope').style.display = flowMode === 'lineage' ? '' : 'none'
  $('#pick-tools').style.display = flowMode === 'pick' ? '' : 'none'
  if (flowMode !== 'pick') { $('#flow-click').textContent = locked ? 'click: move the rotation point' : 'click: focus'; return }
  $('#pick-hint').textContent = locked ? 'locked — unlock to change your picks'
    : !picks.size ? 'click a concept to pick it · click again to unpick'
    : 'pick connected concepts · click a pick again to unpick it'
  $('#flow-click').textContent = locked ? 'click: move the rotation point' : 'click: pick / unpick'
}
$('#flow-mode').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v
  if (!v || v === flowMode) return
  const current = flowSet() // the chart as it stands, filter included
  if (locked) setLock(false)
  picks.clear()
  if (v === 'pick') {
    // the diagram that was showing becomes the one you pick on, with nothing picked yet
    pickCanvas = current ?? new Set(); canvasAnchor = anchor
  } else {
    // back to the lineage the picks were made on
    anchor = selected = canvasAnchor ?? selected
    pickCanvas = new Set(); canvasAnchor = null
    if (selected) renderDetail(selected)
  }
  flowMode = v
  focus(); renderFlow()
})
$('#flow-scope').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v
  if (!v || v === scope) return
  if (locked && lockKind === 'lineage') setLock(false) // the frozen set was the old filter's
  scope = v
  focus(); renderFlow()
})
$('#pick-clear').addEventListener('click', () => {
  if (locked) setLock(false)
  picks.clear()
  focus(); renderFlow()
})

$('#frame').addEventListener('click', frameSet)
// collapse to a floating icon where the − button was (or where the icon was last dragged); a click brings the
// panel back exactly as it was — the panel itself is only hidden, so its size, place, zoom and scroll survive
const fab = $('#flow-fab')
let fabPos = null, flowScroll = null
try { fabPos = JSON.parse(localStorage.getItem('ddag3d.fabPos')) } catch {}
function placeFab(p) {
  const left = Math.min(Math.max(8, p.left), innerWidth - 60), top = Math.min(Math.max(8, p.top), innerHeight - 60)
  fab.style.left = left + 'px'; fab.style.top = top + 'px'
  return { left, top }
}
function collapseFlow() {
  const b = $('#flow-min').getBoundingClientRect()
  flowScroll = { left: flowBody.scrollLeft, top: flowBody.scrollTop, selected }
  placeFab(fabPos ?? { left: b.left + b.width / 2 - 26, top: b.top + b.height / 2 - 26 })
  document.body.classList.add('flow-min')
  fab.classList.remove('pop'); void fab.offsetWidth; fab.classList.add('pop')
  viewOffset()
}
function expandFlow() {
  document.body.classList.remove('flow-min')
  renderFlow() // re-measure now that the panel is visible again
  if (flowScroll && flowScroll.selected === selected) flowBody.scrollTo(flowScroll)
  viewOffset()
}
$('#flow-min').addEventListener('click', collapseFlow)
fab.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const r = fab.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY
  let moved = false
  fab.setPointerCapture(e.pointerId)
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
    moved = true
    fab.classList.add('dragging')
    fabPos = placeFab({ left: r.left + ev.clientX - x0, top: r.top + ev.clientY - y0 })
  }
  const up = () => {
    fab.removeEventListener('pointermove', move); fab.removeEventListener('pointerup', up); fab.removeEventListener('pointercancel', up)
    fab.classList.remove('dragging')
    if (moved) { try { localStorage.setItem('ddag3d.fabPos', JSON.stringify(fabPos)) } catch {} }
    else expandFlow()
  }
  fab.addEventListener('pointermove', move); fab.addEventListener('pointerup', up); fab.addEventListener('pointercancel', up)
})
// arcOf(x) names the arc between the concept on show and x, when the chips are its needs or its needed-by
function relChips(ids, arcOf) {
  if (!ids.length) return '<span class="none">none</span>'
  const rank = { strong: 0, null: 1, weak: 2 }
  return ids.map((id) => ({ x: G.byId.get(id), a: arcOf?.(id) })).sort((p, q) => rank[p.a?.strength ?? null] - rank[q.a?.strength ?? null] || p.x.depth - q.x.depth || p.x.id.localeCompare(q.x.id))
    .map(({ x, a }) => {
      const tags = a?.tags.length ? `<span class="atag">${esc(a.tags.join(' · '))}</span>` : ''
      return `<span class="chip${a?.strength ? ` s-${a.strength}` : ''}" data-go="${esc(x.id)}" style="--c:${x.color}" title="${esc(x.def)}"><span class="dot"></span><span class="name">${esc(x.id)}</span>${tags}</span>`
    }).join('')
}
function renderDetail(n) {
  const under = n.branches.filter((b) => b.id !== n.id).map((b) => b.id)
  $('#detail-body').innerHTML = `
    <div class="d-id"><span class="dot" style="--c:${n.color}"></span>${esc(n.id)}</div>
    <div class="d-name">${esc(n.name)}</div>
    <div class="d-def">${esc(n.def)}</div>
    <div class="d-meta">
      <span class="pill v-${esc(n.verdict)}">${esc(n.verdict)}</span>
      ${n === G.root ? `<span class="tag">root</span><span class="tag">${n.solid ? 'solid' : 'not solid'}</span>` : ''}
      <span class="tag">depth ${n.depth}</span>
      <span class="tag">${n.deg} links</span>
    </div>
    ${n.detail ? `<div class="d-extra">${esc(n.detail)}</div>` : ''}
    <div class="d-sec"><h3>Needs <em>${n.pred.length} · to understand this you need</em></h3><div class="rel">${relChips(n.pred, (p) => G.arcs.get(`${p}->${n.id}`))}</div></div>
    <div class="d-sec"><h3>Needed by <em>${n.succ.length}</em></h3><div class="rel">${relChips(n.succ, (s) => G.arcs.get(`${n.id}->${s}`))}</div></div>
    ${under.length > 1 ? `<div class="d-sec"><h3>Under branches <em>${under.length}</em></h3><div class="rel">${relChips(under)}</div></div>` : ''}`
}
$('#detail').addEventListener('click', (e) => {
  if (e.target.closest('.close')) {
    if (locked && lockKind === 'branch') { // put the concept down, keep the branch lit
      selected = anchor = null
      $('#detail').classList.remove('open')
      return (focus(), renderFlow())
    }
    setLock(false); return select(null)
  }
  const go = e.target.closest('[data-go]')?.dataset.go
  if (go) select(G.byId.get(go))
})

// ---------- search ----------
const q = $('#q'), results = $('#results')
let hits = [], active = 0
function search() {
  const s = q.value.trim().toLowerCase()
  if (!s) { results.classList.remove('open'); return }
  hits = G.nodes.map((n) => {
    const id = n.id.toLowerCase(), t = n.title.toLowerCase()
    const score = id === s ? 0 : id.startsWith(s) ? 1 : id.includes(s) ? 2 : t.includes(s) ? 3 : 9
    return { n, score }
  }).filter((h) => h.score < 9).sort((a, b) => a.score - b.score || a.n.id.localeCompare(b.n.id)).slice(0, 12).map((h) => h.n)
  active = 0
  results.innerHTML = hits.length
    ? hits.map((n, i) => `<div class="result${i === active ? ' active' : ''}" data-go="${esc(n.id)}"><span class="dot" style="--c:${n.color}"></span><b>${esc(n.id)}</b><span>${esc(n.def)}</span></div>`).join('')
    : '<div class="result"><span>no match</span></div>'
  results.classList.add('open')
}
q.addEventListener('input', search)
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length)
    results.querySelectorAll('.result').forEach((r, i) => r.classList.toggle('active', i === active))
  } else if (e.key === 'Enter' && hits[active]) { pick(hits[active]) }
  else if (e.key === 'Escape') { q.value = ''; results.classList.remove('open'); q.blur() }
})
results.addEventListener('mousedown', (e) => { const go = e.target.closest('[data-go]')?.dataset.go; if (go) { e.preventDefault(); pick(G.byId.get(go)) } })
q.addEventListener('blur', () => setTimeout(() => results.classList.remove('open'), 100))
function pick(n) { q.value = ''; results.classList.remove('open'); q.blur(); select(n) }

// ---------- controls ----------
function syncControls() {
  document.querySelectorAll('.seg[data-ctl]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', st[seg.dataset.ctl] === b.dataset.v)))
  document.querySelectorAll('.tog').forEach((b) => b.classList.toggle('on', !!st[b.dataset.tog]))
}
document.querySelectorAll('.seg[data-ctl]').forEach((seg) => seg.addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return
  const ctl = seg.dataset.ctl
  if (st[ctl] === v) return
  st[ctl] = v
  if (ctl === 'color') { if (lockKind === 'branch') setLock(false); isolate.clear(); openKey = null; recolor() }
  if (ctl === 'layout') { applyLayout(); setTimeout(() => !selected && graph.zoomToFit(900, 10), 1600) }
  if (ctl === 'labels') focus()
  if (ctl === 'quality') applyQuality()
  syncControls()
}))
document.querySelectorAll('.tog').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.tog)))
function toggle(k) {
  st[k] = !st[k]
  if (k === 'rotate') controls.autoRotate = st.rotate && !selected
  if (k === 'glow') bloom.enabled = st.glow
  if (k === 'guides') guides.visible = st.guides
  if (k === 'flow') { focus(); $('#flow-svg')?.classList.toggle('noflow', !st.flow) }
  syncControls()
}
function reset() {
  isolate.clear(); openKey = null; hoverBranch = null; hovered = null; hoverEl.classList.remove('show')
  setLock(false)
  flowMode = 'lineage'; picks.clear(); pickCanvas = new Set(); canvasAnchor = null
  select(null)
  renderKey()
  graph.zoomToFit(900, 10)
}
addEventListener('keydown', (e) => {
  if (e.target === q) return
  if (e.key === '/') { e.preventDefault(); q.focus() }
  else if (e.key === 'Escape') reset()
  else if (e.key === 'r' || e.key === 'R') toggle('rotate')
  else if (e.key === 'f' || e.key === 'F') (anchor ? frameSet() : graph.zoomToFit(900, 10))
  else if (e.key === 'l' || e.key === 'L') locked ? setLock(false) : anchor ? setLock(true) : openKey ? setLock(true, 'branch') : null
})
addEventListener('resize', () => { graph.width(innerWidth).height(innerHeight); bloom.resolution.set(innerWidth, innerHeight); renderFlow(); viewOffset(); applyQuality(); if (flowPanel.classList.contains('floating')) placeFlow(flowPanel.getBoundingClientRect()); if (document.body.classList.contains('flow-min')) placeFab(fab.getBoundingClientRect()) })
// shift the 3D view up by half the flow panel, so the scene centres in the space left above it
// While the flow panel shows, docked or floating, the scene centres in the largest uncovered strip beside it
// (above, below, left or right), and Frame fits into that strip. freeRect is that strip, in window pixels.
let freeRect = null
function viewOffset() {
  const p = $('#flow'), W = innerWidth, H = innerHeight
  const shown = document.body.classList.contains('has-flow') && !document.body.classList.contains('flow-min')
  const docked = shown && !p.classList.contains('floating')
  // the detail panel gives way to a docked panel only
  document.body.style.setProperty('--flow-space', (docked ? p.offsetHeight + 16 : 0) + 'px')
  freeRect = { x: 0, y: 0, w: W, h: H }
  if (shown) {
    const r = p.getBoundingClientRect(), m = 8
    const strips = [
      { x: 0, y: 0, w: W, h: r.top - m },
      { x: 0, y: r.bottom + m, w: W, h: H - r.bottom - m },
      { x: 0, y: 0, w: r.left - m, h: H },
      { x: r.right + m, y: 0, w: W - r.right - m, h: H },
    ].filter((o) => o.w > 160 && o.h > 160)
    if (strips.length) freeRect = strips.sort((a, b) => b.w * b.h - a.w * a.h)[0]
  }
  const cam = graph.camera()
  cam.setViewOffset(W, H, W / 2 - (freeRect.x + freeRect.w / 2), H / 2 - (freeRect.y + freeRect.h / 2), W, H)
  cam.updateProjectionMatrix()
}
new ResizeObserver(viewOffset).observe($('#flow'))
// the canvas never hears the pointer leave a node when it leaves onto a panel
document.querySelectorAll('.panel').forEach((p) => p.addEventListener('pointerenter', () => p.id !== 'flow' && onHover(null)))

// ---------- labels: screen-space declutter, most important first ----------
const proj = new THREE.Vector3()
let lastDeclutter = 0
function declutter() {
  const cam = graph.camera(), W = innerWidth, H = innerHeight, placed = []
  const prio = (n) => (n === selected ? 0 : n === hovered ? 1 : n === G.root ? 2 : lit && lit.has(n) ? 3 : 4) * 1000 + n.depth * 100 - n.deg
  for (const n of [...G.nodes].filter((n) => n.labelOn).sort((a, b) => prio(a) - prio(b))) {
    proj.set(n.x, n.y, n.z).project(cam)
    const forced = n === selected || n === hovered
    if (proj.z > 1) { n.clear = false; continue }
    const w = n.id.length * (n === G.root ? 8 : 6.6) + 16, h = 19
    const x = ((proj.x + 1) / 2) * W - w / 2, y = ((1 - proj.y) / 2) * H + 6
    const hit = placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y)
    n.clear = forced || !hit
    if (n.clear) placed.push({ x, y, w, h })
  }
}

// ---------- per-frame: root rings, pulse, label fade by distance ----------
const camPos = new THREE.Vector3()
const pulsing = new Set()
function frame(t) {
  requestAnimationFrame(frame)
  if (!G) return
  if (G.root.rings) { G.root.rings[0].rotation.z = t * 0.00025; G.root.rings[1].rotation.z = -t * 0.00018; G.root.rings[1].rotation.y = Math.sin(t * 0.0003) * 0.3 }
  for (const n of pulsing) if (n !== selected && n !== hovered) { n.glow.scale.setScalar(n.r * 4); pulsing.delete(n) }
  if (selected?.glow) { pulsing.add(selected); selected.glow.scale.setScalar(selected.r * (4.5 + Math.sin(t * 0.004) * 1)) }
  if (hovered?.glow && hovered !== selected) { pulsing.add(hovered); hovered.glow.scale.setScalar(hovered.r * (6 + Math.sin(t * 0.008) * 1.5)) }
  // once the flight lands, keep the selected node centred while the layout is still settling
  if (selected && following && performance.now() > flownAt && performance.now() - lastTick < 200) controls.target.lerp(proj.set(selected.x, selected.y, selected.z), 0.1)
  if (t - lastDeclutter > 90) { lastDeclutter = t; declutter() }
  camPos.copy(graph.camera().position)
  const far = Math.max(380, camPos.length() * 0.9)
  for (const n of G.nodes) {
    if (!n.el) continue
    const near = n === selected || n === hovered || n === G.root || n.depth <= 1 || lit
    const d = Math.hypot(n.x - camPos.x, n.y - camPos.y, n.z - camPos.z)
    const a = !n.labelOn || !n.clear ? 0 : near ? 1 : Math.max(0.12, Math.min(1, 1.5 - d / far))
    if (Math.abs(a - n.fade) > 0.03) { n.fade = a; n.el.style.opacity = a.toFixed(2) }
    n.label.visible = a > 0
  }
}
requestAnimationFrame(frame)

// ---------- quality: render resolution and anti-aliasing, and what they cost ----------
// The scene renders into the bloom composer's buffer, not the canvas, so smoothing has to live there:
// MSAA samples on that buffer smooth sphere edges and lines; a pixel ratio above the screen's supersamples.
const QUALITY = { standard: { scale: 1, samples: 0 }, high: { scale: 1, samples: 4 }, ultra: { scale: 1.5, samples: 4 } }
try { const saved = localStorage.getItem('ddag3d.quality'); if (saved in QUALITY) st.quality = saved } catch {}
function applyQuality() {
  const q = QUALITY[st.quality], composer = graph.postProcessingComposer()
  const pr = Math.min(3, (window.devicePixelRatio || 1) * q.scale)
  renderer.setPixelRatio(pr)
  composer.setPixelRatio(pr)
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) { rt.samples = Math.min(q.samples, renderer.capabilities.maxSamples); rt.dispose() }
  try { localStorage.setItem('ddag3d.quality', st.quality) } catch {}
  showPerf()
}
let fps = 0, frames = 0, fpsFrom = performance.now()
function showPerf() {
  const pr = renderer.getPixelRatio(), w = Math.round(innerWidth * pr), h = Math.round(innerHeight * pr), px = w * h
  const s = graph.postProcessingComposer().renderTarget1.samples
  // bytes per pixel: canvas colour+depth 8 · scene buffer half-float colour 8 + depth 4, times samples when MSAA (+ resolve 8) · bloom mips ≈ 7.3
  const mb = (px * (8 + (s ? 8 + s * 12 : 12) + 7.3)) / 1048576
  $('#perf').innerHTML = `<span><b>${w}×${h}</b> px</span><span>MSAA <b>${s ? s + '×' : 'off'}</b></span><span>~<b>${Math.round(mb)}</b> MB GPU</span>` +
    `<span class="${fps && fps < 45 ? 'slow' : ''}"><b>${fps ? Math.round(fps) : '–'}</b> fps</span>`
}
;(function countFps(t) {
  requestAnimationFrame(countFps)
  frames++
  if (t - fpsFrom >= 1000) { fps = (frames * 1000) / (t - fpsFrom); frames = 0; fpsFrom = t; showPerf() }
})(performance.now())
applyQuality()

// ---------- load ----------
function renderHead() {
  $('#project').textContent = G.name
  $('#stats').innerHTML = [[G.nodes.length, 'concepts'], [G.links.length, 'links'], [G.branches.length, 'branches']]
    .map(([v, k]) => `<div class="stat"><b>${v}</b><small>${k}</small></div>`).join('')
  $('#rootline').innerHTML = `root <b style="font-family:var(--mono);color:var(--text)">${esc(G.root.id)}</b><span class="pill v-${esc(G.root.verdict)}">${esc(G.root.verdict)}</span>${G.root.solid ? '' : '<span class="tag">not solid</span>'}`
  document.title = `DDAG — ${G.name} 3D`
  const w = { strong: 0, null: 0, weak: 0 }
  for (const l of G.links) w[l.strength]++
  const line = (o, wd) => `<svg class="glyph" viewBox="0 0 22 14"><line x1="1" y1="7" x2="21" y2="7" stroke="#c9cdf0" stroke-opacity="${o}" stroke-width="${wd}" /></svg>`
  $('#enc-links').innerHTML = `<b>LINKS</b><span>${line(1, 2.2)}strong ${w.strong}</span><span>${line(0.45, 1.2)}untagged ${w.null}</span><span>${line(0.15, 1)}weak ${w.weak}</span>`
}

// keep: the same project redrawn after its claims or arcs changed — every concept that is still there stays where it
// was, and so do the camera, the selection, a lock and a picked set
function load(data, keep = false) {
  const old = keep ? G : null
  G = prepare(data)
  if (old) {
    // a label is a DOM element the scene does not own: the graph drops a replaced node's objects, never its label
    for (const n of old.nodes) n.el?.remove()
    const at = (n) => (n ? (G.byId.get(n.id) ?? null) : null)
    const remap = (set) => new Set([...set].map(at).filter(Boolean))
    for (const n of G.nodes) { const o = old.byId.get(n.id); if (o && o.x !== undefined) { n.x = o.x; n.y = o.y; n.z = o.z } }
    selected = at(selected); anchor = at(anchor); canvasAnchor = at(canvasAnchor); hovered = hoverBranch = null
    const kept = remap(picks); picks.clear(); for (const n of kept) picks.add(n)
    pickCanvas = remap(pickCanvas)
    if (locked) { lockedSet = remap(lockedSet); if (!lockedSet.size) setLock(false) }
    if (!selected) $('#detail').classList.remove('open')
  } else {
    selected = hovered = hoverBranch = anchor = null; isolate.clear(); setLock(false)
    $('#detail').classList.remove('open')
    const verdicts = new Set(G.nodes.map((n) => n.verdict))
    st.color = verdicts.size > 1 ? 'verdict' : 'branch' // when every claim shares a verdict, branch carries more
  }
  renderHead()
  graph.graphData({ nodes: G.nodes, links: G.links })
  recolor()
  applyLayout()
  if (old) { if (selected) renderDetail(selected); return }
  controls.autoRotate = st.rotate
  syncControls()
  graph.cameraPosition({ x: 0, y: R * 1.2, z: R * 6.5 })
  let first = true
  setTimeout(() => !selected && graph.zoomToFit(1400, 10), 1800)
  graph.onEngineStop(() => { if (first) { first = false; if (!selected) graph.zoomToFit(1200, 10) } })
}

// the same claims and arcs with new judgments: nothing moves, the colours and the panels follow
function patch(data) {
  for (const d of data.nodes) { const n = G.byId.get(d.id); n.verdict = d.verdict; n.solid = d.solid; n.detail = d.detail }
  renderHead()
  recolor()
  if (selected) renderDetail(selected)
}

// ---------- live ----------
// /p/<name>/3d on the dashboard; the dev server has no such route and takes graph3d.html?p=<name>
const params = new URLSearchParams(location.search)
const project = (() => {
  const m = /^\/p\/([^/]+)\/3d\/?$/.exec(location.pathname)
  try { return m ? decodeURIComponent(m[1]) : params.get('p') } catch { return null }
})()
const target = params.get('target')
const withTarget = (path, t) => (t ? `${path}?target=${encodeURIComponent(t)}` : path)
const fail = (text) => { $('#error').style.display = 'grid'; $('#error').textContent = text }
let shown = null // what is on screen: its claims and arcs, and their judgments, as strings to compare the next read with

function show(data) {
  const shape = JSON.stringify([data.root, data.nodes.map((n) => [n.id, n.title]), data.links.map((l) => [l.source, l.target, l.tags ?? []])])
  const state = JSON.stringify(data.nodes.map((n) => [n.verdict, n.solid, n.detail]))
  if (!shown) {
    load(data)
    $('#to-2d').href = withTarget(`/p/${encodeURIComponent(project)}`, target)
    const sel = $('#target')
    if (data.targets.length > 1) {
      sel.innerHTML = data.targets.map((t, i) => `<option value="${esc(t)}"${t === data.root ? ' selected' : ''}>${esc(t)}${i === 0 ? ' (main)' : ''}</option>`).join('')
      sel.hidden = false
      sel.onchange = () => {
        const u = new URL(location.href)
        if (sel.value === data.targets[0]) u.searchParams.delete('target')
        else u.searchParams.set('target', sel.value)
        location.assign(u)
      }
    }
  } else if (shape !== shown.shape) load(data, true)
  else if (state !== shown.state) patch(data)
  shown = { shape, state }
}

async function pull() {
  const r = await fetch(withTarget(`/api/graph/${encodeURIComponent(project)}`, target), { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `${r.status}`)
  return r.json()
}

if (!project) fail('No project named — open the 3D view from a project on the dashboard.')
else {
  pull().then(show).catch((e) => fail(`${project}: ${e.message}`))
  // the chain moves while agents work: read it again as the 2D view does, and keep the last graph when a read fails
  setInterval(() => { if (shown && !document.hidden) pull().then(show).catch(() => {}) }, 1500)
}
