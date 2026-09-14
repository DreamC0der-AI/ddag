import { useEffect, useState, type CSSProperties } from 'react'
import { GraphCanvas } from './GraphCanvas'
import { parseClaim } from '../chain/claim'
import { opNotation } from '../chain/notation'
import { groundsLabel } from '../chain/explain'
import { versionLabel } from '../chain/versions'
import { OPERATION_KINDS, describeDiff, kindOfEntry, useSim } from './store'

function OperationsPanel() {
  const sim = useSim()
  // the counts size the random stepper's action space (one Add per target
  // node, and so on); on a real project chain they read as move counts and
  // mislead, so live view shows the operations as a color key only
  const counted = !sim.isLive()
  const { total, byKind } = sim.menuCounts()
  return (
    <section className="panel">
      <h2 className="panel-title">
        Epistemic operations {counted && <span className="log-count">{total} enabled</span>}
      </h2>
      <ul className="ops-list">
        {OPERATION_KINDS.map((kind) => {
          const n = byKind.get(kind)!
          return (
            <li key={kind} className={counted && n === 0 ? 'ops-row ops-none' : 'ops-row'}>
              <span className={`ops-kind kind-${kind}`}>{kind}</span>
              {counted && <span className={`ops-count kind-${kind}`}>{n}</span>}
            </li>
          )
        })}
        <li className="ops-row" title="Doubt then Verify in one call: a valid claim re-judged on today's evidence (reverify)">
          <span className="ops-kind kind-Reverify">Reverify</span>
        </li>
        <li className="ops-row" title="Doubt then Verify(invalid) in one call: a valid claim withdrawn on a finding (refute)">
          <span className="ops-kind kind-Refute">Refute</span>
        </li>
      </ul>
      <h2 className="panel-title ops-sub">Records</h2>
      <ul className="ops-list">
        <li className="ops-row" title="a finding recorded with its detail (issue_open)">
          <span className="ops-kind kind-Issue">Issue</span>
        </li>
        <li className="ops-row" title="an issue closed with an outcome and resolution (issue_close)">
          <span className="ops-kind kind-Close">Close</span>
        </li>
        <li className="ops-row" title="a working version declared after a commit (version_mark)">
          <span className="ops-kind kind-Version">Version</span>
        </li>
      </ul>
    </section>
  )
}

function NodeChips({ ids, empty, onSelect }: { ids: string[]; empty: string; onSelect: (id: string) => void }) {
  const sim = useSim()
  if (ids.length === 0) return <span className="detail-none">{empty}</span>
  return (
    <>
      {ids.map((p) => (
        <button key={p} type="button" className="node-chip" onClick={() => onSelect(p)}>
          <span className={`dot dot-${sim.graph.verdict(p)}`} />
          {p}
        </button>
      ))}
    </>
  )
}

function DetailPanel({ id, onSelect }: { id: string | null; onSelect: (id: string) => void }) {
  const sim = useSim()
  const g = sim.graph
  if (id === null || !g.has(id)) {
    return (
      <footer className="detail detail-empty">
        Click a node to inspect it. Drag to arrange — a dragged node stays where you put it;
        double-click it to hand it back to the layout.
      </footer>
    )
  }
  const n = g.node(id)
  const solid = g.solid(id)
  const onFrontier = sim.onFrontier().has(id)
  const fpText =
    n.fingerprint === null
      ? 'no fingerprint — never verified valid, or judgment withdrawn (Doubt)'
      : sim.fingerprintIntact(id)
        ? 'fingerprint intact — justification unchanged since its last valid verification'
        : 'fingerprint stale — justification changed since its last valid verification'
  return (
    <footer className="detail">
      <div className="detail-head">
        <span className="detail-id">{id}</span>
        <span className={`vc vc-${n.verdict}`}>{n.verdict}</span>
        <span className={`state-lamp ${solid ? 'lamp-solid' : 'lamp-broken'}`}>
          {solid ? 'solid' : 'broken'}
        </span>
        {onFrontier && <span className="frontier-chip">verifiable now</span>}
        {id === g.root && <span className="root-chip">root</span>}
        <span className="detail-version">v{n.version}</span>
      </div>
      {(() => {
        const { claim, criterion } = parseClaim(n.content)
        const h = sim.nodeHistory(id)
        return (
          <div className="detail-claim">
            <div className="detail-content">“{claim}”</div>
            <div className="detail-line">
              <span className="detail-label">verify by</span>
              <span className={criterion ? 'detail-text' : 'detail-none'}>{criterion ?? 'no criterion recorded'}</span>
            </div>
            {h.because && (
              <div className="detail-line">
                <span className="detail-label">because</span>
                <span className="detail-text">{h.because}</span>
              </div>
            )}
            <div className="detail-line">
              <span className="detail-label">judged</span>
              <span className={h.judged ? 'detail-text' : 'detail-none'}>
                {h.judged ? `${h.judged.result}${h.judged.evidence ? ` — ${h.judged.evidence}` : ''}` : 'never'}
              </span>
            </div>
            {(() => {
              const a = sim.auditOf(id)
              if (!a) return null
              const text =
                a.status === 'stale'
                  ? `STALE — since ${a.pin}: ${
                      a.diffs && a.diffs.length > 0
                        ? a.diffs.map(describeDiff).join('; ')
                        : a.changed.map((p) => `${p} changed`).join(', ')
                    }${a.missing.length > 0 ? `${a.changed.length > 0 ? '; ' : ''}${a.missing.map((p) => `${p} missing`).join(', ')}` : ''}. Re-examine what changed; reverify if the claim still holds, refute if not.`
                  : a.status === 'intact'
                    ? `pinned ${a.pin}, all unchanged since`
                    : a.status === 'parts'
                      ? `rests on its ${a.parts} part(s) — each carries its own pin; a part's restatement reopens this claim`
                      : a.status === 'unwatched'
                        ? `pinned ${a.pin} but no artifacts cited — drift under this judgment is invisible`
                        : 'unpinned — judged without provenance (Restore, or an older shell)'
              return (
                <div className="detail-line">
                  <span className="detail-label">audit</span>
                  <span className={`detail-text audit-${a.status}`}>{text}</span>
                </div>
              )
            })()}
          </div>
        )
      })()}
      <div className="detail-meta">
        {sim.issuesOf(id).length > 0 && (
          <div className="detail-row">
            <span className="detail-label">issues</span>
            <span className="detail-text">
              {sim.issuesOf(id).map((i) => (
                <span key={i.key} className={`issue-chip ${i.status === 'open' ? 'issue-open' : 'issue-closed'}`} title={i.title}>
                  {i.key} {i.status}{' '}
                </span>
              ))}
            </span>
          </div>
        )}
        <div className="detail-row">
          <span className="detail-label">parts</span>
          <NodeChips ids={g.predecessors(id)} empty="none — leaf" onSelect={onSelect} />
        </div>
        <div className="detail-row">
          <span className="detail-label">composes into</span>
          <NodeChips ids={g.successors(id)} empty="none — this is the root" onSelect={onSelect} />
        </div>
        <div className="detail-row">
          <span className="detail-label">memory</span>
          <span className="detail-fp">{fpText}</span>
        </div>
      </div>
    </footer>
  )
}

/** The legend never changes, so it lives behind an "i" on the canvas instead of taking sidebar space. */
function LegendTip() {
  const [open, setOpen] = useState(false)
  return (
    <div className="legend-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="legend-btn"
        aria-label="legend"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        i
      </button>
      {open && (
        <div className="legend-pop">
          <div className="legend-pop-title">Legend</div>
          <ul className="legend">
        <li>
          <span className="swatch nv-valid" /> valid — green
        </li>
        <li>
          <span className="swatch nv-pending" /> pending — yellow
        </li>
        <li>
          <span className="swatch nv-invalid" /> invalid — red
        </li>
        <li>
          <span className="swatch sw-frontier" /> shadow — verifiable now (frontier)
        </li>
        <li>
          <span className="swatch sw-root" /> inner ring — root
        </li>
        <li>
          <span className="legend-bar fp-bar fp-heal" /> underline solid — heals via Restore
        </li>
        <li>
          <span className="legend-bar fp-bar fp-work" /> underline dashed — needs re-verify / revert
        </li>
        <li>
          <span className="swatch sw-stale">!</span> stale — judged against code that has since changed
        </li>
        <li>
          <span className="swatch sw-issue">!</span> issues — red: open issues recorded on this claim; grey: all closed
        </li>
      </ul>
        </div>
      )}
    </div>
  )
}

const ISSUES_KEY = 'ddag.issuesOpen'

function IssuePane({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const sim = useSim()
  const issues = sim.issues()
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ISSUES_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all')
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(ISSUES_KEY, o ? '0' : '1')
      } catch {
        // per-browser convenience only
      }
      return !o
    })
  }
  const nOpen = issues.filter((i) => i.status === 'open').length
  if (!open) {
    return (
      <div className="issue-pane issue-pane-collapsed">
        <button type="button" className="issue-toggle" onClick={toggle} title="show issues">
          <span className="issue-toggle-label">Issues</span>
          {issues.length > 0 && <span className={nOpen > 0 ? 'issue-count issue-count-open' : 'issue-count'}>{nOpen > 0 ? nOpen : issues.length}</span>}
        </button>
      </div>
    )
  }
  const shown = issues
    .filter((i) => filter === 'all' || (filter === 'open') === (i.status === 'open'))
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.openedAt - b.openedAt)
  return (
    <div className="issue-pane">
      <div className="issue-pane-head">
        <h2 className="panel-title">
          Issues <span className="log-count">{nOpen} open · {issues.length - nOpen} closed</span>
        </h2>
        <span className="issue-filters">
          {(['all', 'open', 'closed'] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? 'log-tab log-tab-on' : 'log-tab'} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </span>
        <button type="button" className="issue-hide" onClick={toggle} title="hide issues">
          ‹
        </button>
      </div>
      {issues.length === 0 ? (
        <p className="panel-empty">
          No issues recorded. An agent records a finding with <code>issue_open</code>; it appears here with its full detail.
        </p>
      ) : (
        <ol className="issue-list">
          {shown.map((i) => {
            const isOpen = i.status === 'open'
            const isExpanded = expanded === i.key
            return (
              <li key={i.key} className={`issue-row ${isOpen ? 'issue-open' : 'issue-closed'}${i.node && i.node === selected ? ' issue-on-selected' : ''}`}>
                <div className="issue-head" onClick={() => setExpanded(isExpanded ? null : i.key)} title={isExpanded ? 'collapse' : 'expand the finding'}>
                  <span className="issue-key">{i.key}</span>
                  <span className={`issue-status issue-status-${i.status}`}>{i.status}</span>
                  {i.severity && <span className="issue-sev">{i.severity}</span>}
                  {i.node && sim.readyToReverify().has(i.node) && (
                    <span className="issue-ready" title="every issue on this claim is closed, but the claim is still judged invalid — re-verify it">
                      ready to re-verify
                    </span>
                  )}
                  {i.node && (
                    <button
                      type="button"
                      className="issue-node"
                      title="select this claim on the graph"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(i.node!)
                      }}
                    >
                      {i.node}
                    </button>
                  )}
                  <span className="issue-title">{i.title}</span>
                </div>
                {isExpanded && (
                  <div className="issue-body">
                    {i.detail ? <pre className="issue-detail">{i.detail}</pre> : <p className="panel-empty">No detail recorded.</p>}
                    {i.status !== 'open' && (
                      <p className="issue-resolution">
                        <strong>{i.status}</strong>
                        {i.resolution ? ` — ${i.resolution}` : ''}
                        <span className="issue-seq"> (event {i.closedAt})</span>
                      </p>
                    )}
                    <p className="issue-seq">opened at event {i.openedAt}</p>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function ActionLog() {
  const sim = useSim()
  const feed = sim.getFeed()
  const [verbose, setVerbose] = useState(false)
  return (
    <section className="panel log-panel">
      <h2 className="panel-title">
        Actions <span className="log-count">{sim.eventCount} events</span>
        <span className="log-tabs">
          <button
            type="button"
            className={verbose ? 'log-tab' : 'log-tab log-tab-on'}
            onClick={() => setVerbose(false)}
          >
            compact
          </button>
          <button
            type="button"
            className={verbose ? 'log-tab log-tab-on' : 'log-tab'}
            title="every event with its decision, grounds, and consequences attributed to their causes (T1/T2/T3, Restore, drops, frontier)"
            onClick={() => setVerbose(true)}
          >
            verbose
          </button>
        </span>
      </h2>
      {feed.length === 0 ? (
        <p className="panel-empty">
          {sim.liveSource() ? (
            'No events yet — the chain is at genesis.'
          ) : (
            <>
              Press <strong>Random action</strong> — each click performs one legal action drawn from the
              current menu.
            </>
          )}
        </p>
      ) : verbose ? (
        <ol className="log-list">
          {[...feed].reverse().map((e) => (
            <li key={e.key} className="vlog-entry">
              <div className="vlog-head">
                <span className="log-seq">{e.seq}</span>
                <span className={`log-short kind-${kindOfEntry(e)}`}>{e.short}</span>
                <span className={e.via ? 'log-full log-via' : 'log-full'}>
                  {e.via ?? opNotation(e.op)}
                </span>
              </div>
              {e.decision?.map((line, i) => (
                <div key={i} className="vlog-line vlog-decision">
                  {line}
                </div>
              ))}
              {e.evidence !== undefined && (
                <div className="vlog-line vlog-grounds">
                  {groundsLabel(e.op)}: {e.evidence}
                </div>
              )}
              {e.explain.map((line, i) => {
                const m = /^(.*?)\s*\[([^\]]+)\]$/.exec(line)
                return (
                  <div key={i} className="vlog-line">
                    {m ? m[1] : line}
                    {m && <span className="vlog-tag">{m[2]}</span>}
                  </div>
                )
              })}
            </li>
          ))}
        </ol>
      ) : (
        <ol className="log-list">
          {[...feed].reverse().map((e) => (
            <li key={e.key} className={e.op.type === 'version' ? 'log-entry log-version' : 'log-entry'} title={e.evidence}>
              <span className="log-seq">{e.seq}</span>
              <span className={`log-short kind-${kindOfEntry(e)}`}>{e.short}</span>
              <span className={e.via ? 'log-full log-via' : 'log-full'}>
                {e.via ?? opNotation(e.op)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** What the URL asks for: the project overview, a live project view, or the sandbox. */
export function routeOf(loc: { pathname: string; search: string }): 'home' | 'live' | 'sandbox' {
  if (/^\/p\/[^/]+\/?$/.test(loc.pathname)) return 'live'
  if (new URLSearchParams(loc.search).has('chain')) return 'live'
  if (loc.pathname === '/sandbox') return 'sandbox'
  return 'home'
}

interface ProjectSummary {
  name: string
  dir: string
  chain: string
  lastSeen: string
  exists: boolean
  rootId?: string
  rootClaim?: string
  rootSolid?: boolean
  frontier?: number
  events?: number
  lastEvent?: string
  stale?: number
  openIssues?: number
  closedIssues?: number
  version?: { label: string; eventsSince: number; rootSolid: boolean }
  error?: string
}

/** Poll the dashboard API for the registry; null while unreachable (no dashboard server running). */
function useProjects(intervalMs = 3000): { projects: ProjectSummary[] | null; error: string | null } {
  const [state, setState] = useState<{ projects: ProjectSummary[] | null; error: string | null }>({ projects: null, error: null })
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(`/api/projects?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`${res.status}`)
        const body = (await res.json()) as { projects: ProjectSummary[] }
        if (alive) setState({ projects: body.projects, error: null })
      } catch (e) {
        if (alive) setState((s) => ({ projects: s.projects, error: String(e) }))
      }
    }
    void tick()
    const id = setInterval(() => void tick(), intervalMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [intervalMs])
  return state
}

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** / — every registered project at a glance; each card opens its live view at /p/<name>. */
function Home() {
  const { projects, error } = useProjects()
  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark">◉</span> Decompose DAG <span className="brand-sub">projects</span>
        </div>
        <div className="toolbar-actions">
          <a className="btn" href="/sandbox">
            ⚄ Sandbox
          </a>
        </div>
      </header>
      <main className="home">
        {projects === null && !error && <p className="panel-empty">Loading the registry…</p>}
        {error && projects === null && (
          <p className="panel-empty">
            The dashboard server is not reachable ({error}). Start it with <code>npm run dashboard</code> — it lists
            every project Claude Code has opened with ddag.
          </p>
        )}
        {projects && projects.length === 0 && (
          <p className="panel-empty">
            No projects registered yet. Open any folder in Claude Code and use ddag — its chain registers itself.
          </p>
        )}
        {projects && projects.length > 0 && (
          <ul className="home-list">
            {projects.map((p) => (
              <li key={p.chain} className="home-card">
                <a className="home-link" href={`/p/${encodeURIComponent(p.name)}`}>
                  <div className="home-head">
                    <span className="home-name">{p.name}</span>
                    {p.exists && !p.error && (
                      <span className={`state-lamp ${p.rootSolid ? 'lamp-solid' : 'lamp-broken'}`}>
                        {p.rootSolid ? 'solid' : 'broken'}
                      </span>
                    )}
                    {p.version && (
                      <span className="version-chip" title={`latest version mark; root was ${p.version.rootSolid ? 'solid' : 'broken'} then; ${p.version.eventsSince} event(s) since`}>
                        {p.version.label}
                      </span>
                    )}
                    {!p.exists && <span className="home-missing">chain file missing</span>}
                    {p.error && <span className="home-missing">unreadable</span>}
                    <span className="home-ago">{ago(p.lastSeen)}</span>
                  </div>
                  {p.rootClaim && <div className="home-claim">{p.rootClaim}</div>}
                  <div className="home-meta">
                    {p.exists && !p.error && (
                      <>
                        <span>{p.events} events</span>
                        <span>{p.frontier} on the frontier</span>
                        {(p.openIssues ?? 0) > 0 && (
                          <span className="home-issues" title="recorded issues still open">
                            {p.openIssues} open issue{p.openIssues === 1 ? '' : 's'}
                          </span>
                        )}
                        {(p.closedIssues ?? 0) > 0 && (
                          <span className="home-fixed" title="recorded issues closed">
                            {p.closedIssues} closed
                          </span>
                        )}
                        {(p.stale ?? 0) > 0 && (
                          <span className="home-stale" title="valid judgments whose cited files changed or vanished since">
                            {p.stale} stale
                          </span>
                        )}
                        {p.lastEvent && <span className="home-last">last: {p.lastEvent}</span>}
                      </>
                    )}
                    <span className="home-path">{p.dir}</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

/** Toolbar jump between registered projects (only when the dashboard API is reachable). */
function ProjectSwitcher({ current }: { current: string | undefined }) {
  const { projects } = useProjects(10000)
  if (!projects || projects.length === 0) return null
  return (
    <select
      className="btn project-switch"
      value={current ?? ''}
      onChange={(e) => {
        if (e.target.value) window.location.assign(`/p/${encodeURIComponent(e.target.value)}`)
      }}
      title="switch project"
    >
      {current === undefined && <option value="">project…</option>}
      {projects.map((p) => (
        <option key={p.chain} value={p.name}>
          {p.name}
          {p.exists && !p.error ? (p.rootSolid ? ' ✓' : '') : ' (missing)'}
        </option>
      ))}
    </select>
  )
}

const SIDEBAR_KEY = 'ddag.sidebarWidth'
const clampSidebar = (w: number) => Math.max(240, Math.min(window.innerWidth * 0.7, w))

/** The sidebar's left edge is a drag handle; the chosen width is remembered per browser. */
function SidebarResizer({ onResize }: { onResize: (w: number) => void }) {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={dragging ? 'sidebar-resizer dragging' : 'sidebar-resizer'}
      role="separator"
      aria-orientation="vertical"
      aria-label="resize sidebar"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        onResize(clampSidebar(window.innerWidth - e.clientX))
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDragging(false)
      }}
    />
  )
}

export default function App() {
  const route = routeOf(window.location)
  if (route === 'home') return <Home />
  return <Workbench />
}

/** The graph view — live for /p/<name> and ?chain=, the random sandbox otherwise. */
function Workbench() {
  const sim = useSim()
  const [sidebarW, setSidebarW] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_KEY))
      return saved > 0 ? saved : 300
    } catch {
      return 300
    }
  })
  const resize = (w: number) => {
    setSidebarW(w)
    try {
      localStorage.setItem(SIDEBAR_KEY, String(Math.round(w)))
    } catch {
      // per-browser convenience only
    }
  }
  const rootSolid = sim.graph.solid(sim.graph.root)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId !== null && sim.graph.has(selectedId) ? selectedId : null
  // a project or chain URL is a dashboard link — open it live, no click needed
  useEffect(() => {
    if (sim.liveSource() && !sim.isLive()) sim.toggleLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarW}px` } as CSSProperties}>
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark">◉</span> Decompose DAG{' '}
          <span className="brand-sub">{sim.liveSource() ? sim.liveChainPath() : 'sandbox'}</span>
        </div>
        <div className="toolbar-state">
          root:{' '}
          <span className={`state-lamp ${rootSolid ? 'lamp-solid' : 'lamp-broken'}`}>
            {rootSolid ? 'solid' : 'broken'}
          </span>
        </div>
        {(() => {
          const v = sim.latestVersion()
          if (!v) return null
          return (
            <div
              className="toolbar-state"
              title={`${v.note ?? 'latest version'}${v.commit ? `\nafter commit ${v.commit}` : ''}\nat event ${v.seq}: root ${v.rootSolid ? 'solid' : 'broken'}, ${v.openIssues} open issue(s)${v.dirty ? '\nmarked on a dirty tree' : ''}`}
            >
              version: <span className="version-chip">{versionLabel(v)}</span>
              {v.eventsSince > 0 && <span className="version-since">+{v.eventsSince} since</span>}
            </div>
          )
        })()}
        {!sim.isLive() && <div className="toolbar-state">menu: {sim.menuCounts().total} operations</div>}
        <div className="toolbar-actions">
          <a className="btn" href="/" title="all projects">
            ⌂
          </a>
          <ProjectSwitcher current={sim.liveSource()?.project} />

          {/* the random stepper belongs to the sandbox; a project view is a dashboard, not a playground */}
          {!sim.liveSource() && (
            <>
              <button
                type="button"
                className={`btn ${rootSolid ? 'btn-done' : 'btn-primary'}`}
                disabled={rootSolid}
                title={rootSolid ? 'the target is solid — decomposition verified, simulation stops' : undefined}
                onClick={() => sim.randomStep()}
              >
                {rootSolid ? '✓ target solid — done' : '⚄ Random action'}
              </button>
              <button type="button" className="btn" onClick={() => sim.reset()}>
                Reset
              </button>
            </>
          )}
        </div>
      </header>
      <main className="main">
        <IssuePane selected={selected} onSelect={setSelectedId} />
        <div className="canvas-col">
          <div className="canvas-stage">
            <GraphCanvas selected={selected} onSelect={setSelectedId} />
            <LegendTip />
          </div>
          <DetailPanel id={selected} onSelect={setSelectedId} />
        </div>
        <SidebarResizer onResize={resize} />
        <aside className="sidebar">
          <OperationsPanel />
          <ActionLog />
        </aside>
      </main>
    </div>
  )
}
