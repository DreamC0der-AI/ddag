import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { GraphCanvas } from './GraphCanvas'
import { parseClaim } from '../chain/claim'
import { opNotation } from '../chain/notation'
import { groundsLabel } from '../chain/explain'
import { versionLabel } from '../chain/versions'
import { firstSentence } from '../chain/reader'
import { OPERATION_KINDS, describeDiff, kindOfEntry, useSim, type FeedEntry, type Said, type TimelineRow } from './store'

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
        <li className="ops-row" title="a change described once — what moved and how it was checked — cited by the judgments re-anchored after it (round_record)">
          <span className="ops-kind kind-Round">Round</span>
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

type Judged = NonNullable<ReturnType<ReturnType<typeof useSim>['nodeHistory']>['judged']>

/** JUDGED: the verdict and the first sentence of its grounds; the whole text and the cited round open in place. */
function JudgedLine({ judged, showPin }: { judged: Judged | undefined; showPin: boolean }) {
  const sim = useSim()
  const [more, setMore] = useState(false)
  const [roundOpen, setRoundOpen] = useState(false)
  if (!judged) {
    return (
      <div className="detail-line">
        <span className="detail-label">judged</span>
        <span className="detail-none">never</span>
      </div>
    )
  }
  const whole = (judged.evidence ?? '').trim()
  const flat = whole.replace(/\s+/g, ' ')
  const first = flat === '' ? '' : firstSentence(flat)
  const long = first !== flat
  const round = judged.round !== undefined ? sim.roundOf(judged.round) : null
  return (
    <>
      <div className="detail-line">
        <span className="detail-label">judged</span>
        <span className="detail-text">
          {/* the whole text scrolls in its own box; the controls stay outside it, in reach */}
          <span className={more ? 'judged-body judged-full' : 'judged-body'}>
            <span className={`judged-word judged-${judged.result}`}>{judged.result}</span>
            {first !== '' && <> — {more ? whole : first}</>}
          </span>
          {long && (
            <button type="button" className="more-btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              {more ? 'less' : 'more'}
            </button>
          )}
          {showPin && judged.pin && <span className="pin-tag">pinned {judged.pin}</span>}
          {judged.round !== undefined && (
            <button
              type="button"
              className={roundOpen ? 'round-chip round-chip-on' : 'round-chip'}
              title={round ? `${round.title} — click for the round` : 'round record not found on this chain'}
              aria-expanded={roundOpen}
              onClick={() => setRoundOpen((o) => !o)}
            >
              round {judged.round}
            </button>
          )}
        </span>
      </div>
      {roundOpen && (
        <div className="round-body">
          <div className="round-title">
            <span className="kind-Round">◆ {judged.round}</span> {round ? round.title : 'not recorded on this chain'}
            {round && <span className="round-seq">event {round.seq}</span>}
          </div>
          {round?.detail && <pre className="round-detail">{round.detail}</pre>}
        </div>
      )}
    </>
  )
}

const TIMELINE_KEY = 'ddag.timelineOpen'

/** TIMELINE: the claim's own chain, oldest first — re-anchoring runs one row each, causes as chips. */
function Timeline({ id, goTo, onReveal }: { id: string; goTo: (id: string) => void; onReveal: (seq: number) => void }) {
  const sim = useSim()
  const g = sim.graph
  const project = sim.projectNode()
  const rows = sim.timelineOf(id)
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TIMELINE_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [runsOpen, setRunsOpen] = useState<ReadonlySet<number>>(new Set())
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(TIMELINE_KEY, o ? '0' : '1')
      } catch {
        // per-browser convenience only
      }
      return !o
    })
  }
  const toggleRun = (first: number) =>
    setRunsOpen((s) => {
      const next = new Set(s)
      if (!next.delete(first)) next.add(first)
      return next
    })
  const seqBtn = (seq: number, label = `#${seq}`, inline = false) => (
    <button type="button" className={inline ? 'tl-seq tl-seq-inline' : 'tl-seq'} title={`show event ${seq} in the Actions log`} onClick={() => onReveal(seq)}>
      {label}
    </button>
  )
  const chip = (node: string) => {
    if (node === project) return <span className="tl-plain">the project</span>
    if (!g.has(node)) return <span className="tl-plain" title="no longer in the graph">{node}</span>
    const inCone = sim.cone().has(node)
    return (
      <button
        type="button"
        className={inCone ? 'node-chip tl-chip' : 'node-chip tl-chip tl-chip-away'}
        title={inCone ? 'select this claim' : `in target ${sim.targetLabel(sim.homeOf(node))} — click to view it there`}
        onClick={() => goTo(node)}
      >
        <span className={`dot dot-${g.verdict(node)}`} />
        {node}
      </button>
    )
  }
  const grounds = (s: Said | null) =>
    s && (
      <>
        {s.grounds !== null && (
          <span className="tl-grounds" title={s.full ?? undefined}>
            — {s.grounds}
          </span>
        )}
        {s.round !== null && (
          <span className="round-chip round-chip-static" title={sim.roundOf(s.round)?.title}>
            round {s.round}
          </span>
        )}
      </>
    )
  const render = (r: TimelineRow) => {
    if (r.type === 'noise') {
      return (
        <li key="noise" className="tl-row tl-noise">
          <span className="tl-seq tl-seq-none" />
          <span className="tl-what">
            reopened and restored {r.count} time{r.count === 1 ? '' : 's'} by re-anchorings beneath it, last at {seqBtn(r.last, `#${r.last}`, true)} — no
            judgment of its own moved
          </span>
        </li>
      )
    }
    if (r.type === 'run') {
      if (r.count === 1) {
        return (
          <li key={r.first} className="tl-row">
            {seqBtn(r.last)}
            <span className="tl-what">
              <span className="tl-verb">re-anchored</span> {grounds(r.items[0]!)}
            </span>
          </li>
        )
      }
      const isOpen = runsOpen.has(r.first)
      return (
        <li key={r.first} className="tl-row tl-run">
          {seqBtn(r.last, `#${r.first}–#${r.last}`)}
          <span className="tl-what">
            <button type="button" className="tl-run-btn" aria-expanded={isOpen} onClick={() => toggleRun(r.first)}>
              <span className="tl-caret">{isOpen ? '▾' : '▸'}</span> re-anchored {r.count} times
            </button>{' '}
            {!isOpen && <span className="tl-last">the last</span>} {!isOpen && grounds(r.items[r.items.length - 1]!)}
            {isOpen && (
              <ol className="tl-sub">
                {r.items.map((s) => (
                  <li key={s.seq} className="tl-row">
                    {seqBtn(s.seq)}
                    <span className="tl-what">
                      <span className="tl-verb">re-anchored</span> {grounds(s)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </span>
        </li>
      )
    }
    return (
      <li key={`${r.seq}:${r.what}`} className={r.direct ? 'tl-row' : 'tl-row tl-indirect'}>
        {seqBtn(r.seq)}
        <span className="tl-what">
          <span className="tl-verb">{r.what}</span> {r.node !== null && chip(r.node)}
          {r.via !== null && (
            <span className="tl-via" title={r.direct ? 'the operation this event was part of' : 'the operation the cause was part of'}>
              {r.via}
            </span>
          )}
          {r.tail !== null && <span className="tl-tail"> — {r.tail}</span>} {grounds(r.said)}
        </span>
      </li>
    )
  }
  return (
    <div className="timeline">
      <button type="button" className="tl-toggle" aria-expanded={open} onClick={toggle} title={open ? 'hide the timeline' : 'show the timeline'}>
        <span className="tl-caret">{open ? '▾' : '▸'}</span>
        <span className="detail-label">timeline</span>
        <span className="tl-count">
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (rows.length === 0 ? <span className="detail-none">present at genesis — no events of its own</span> : <ol className="tl-list">{rows.map(render)}</ol>)}
    </div>
  )
}

function DetailPanel({ id, onSelect, onReveal }: { id: string | null; onSelect: (id: string) => void; onReveal: (seq: number) => void }) {
  const sim = useSim()
  const g = sim.graph
  const project = sim.projectNode()
  // the project node is a reading device, never a claim: it is absent from every list
  const shown = (ids: string[]) => ids.filter((x) => x !== project)
  if (id === null || !g.has(id) || id === project) {
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
  const target = sim.currentTarget()
  const home = sim.homeOf(id)
  // a claim outside the viewed target's cone is reached the way the HOME chip reaches it: through its own target
  const goTo = (nid: string) => {
    if (!sim.cone().has(nid)) sim.selectTarget(sim.homeOf(nid))
    onSelect(nid)
  }
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
        {id === target && <span className="root-chip">root</span>}
        {home !== target && (
          <button
            type="button"
            className="home-chip home-chip-detail"
            title={`judged in target ${sim.targetLabel(home)} — click to view that target`}
            onClick={() => sim.selectTarget(home)}
          >
            home: {sim.targetLabel(home)}
          </button>
        )}
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
            {/* the pin is said once: by AUDIT when it reports one, else here */}
            <JudgedLine key={`${id}:${h.judged?.seq ?? 0}`} judged={h.judged} showPin={sim.auditOf(id)?.pin === undefined} />
            <Timeline key={id} id={id} goTo={goTo} onReveal={onReveal} />
            {home !== target && (
              <div className="detail-line">
                <span className="detail-label">home</span>
                <span className="detail-text">
                  {sim.targetLabel(home)} — {sim.cone().has(id) ? 'used here, judged there' : 'judged there; not part of this target'}
                </span>
              </div>
            )}
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
          <NodeChips ids={shown(g.predecessors(id))} empty="none — leaf" onSelect={onSelect} />
        </div>
        <div className="detail-row">
          <span className="detail-label">composes into</span>
          <NodeChips ids={shown(g.successors(id))} empty={project === null ? 'none — this is the root' : 'none — this is a target'} onSelect={onSelect} />
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
    <div className="legend-tip">
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
        <li>
          <span className="legend-chip home-chip">home</span> home chip — judged in another target, only used in this one
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

interface LogRow {
  entry: FeedEntry
  /** the Doubt of a Reverify/Refute pair, folded into its Verify's row */
  doubt?: FeedEntry
}

/** Compact rows: a Doubt+Verify pair under one Reverify(x)/Refute(x) label is one act, so one row. */
function compactRows(feed: readonly FeedEntry[]): LogRow[] {
  const rows: LogRow[] = []
  for (let i = 0; i < feed.length; i++) {
    const e = feed[i]!
    const next = feed[i + 1]
    const paired =
      e.op.type === 'doubt' &&
      e.via !== undefined &&
      (e.via.startsWith('Reverify(') || e.via.startsWith('Refute(')) &&
      next !== undefined &&
      next.via === e.via &&
      next.op.type === 'verify' &&
      next.op.id === e.op.id
    if (paired) {
      rows.push({ entry: next!, doubt: e })
      i++
    } else rows.push({ entry: e })
  }
  return rows
}

function ActionLog({ reveal }: { reveal: { seq: number; n: number } | null }) {
  const sim = useSim()
  const feed = sim.getFeed()
  const [verbose, setVerbose] = useState(false)
  const listRef = useRef<HTMLOListElement | null>(null)
  const [flash, setFlash] = useState<number | null>(null)
  // a #seq clicked in the timeline: bring that event's row into view and mark it for a moment
  useEffect(() => {
    if (reveal === null) return
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>(`[data-seqs~="${reveal.seq}"]`)
    if (!list || !el) return
    const lr = list.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    list.scrollTop += er.top - lr.top - (list.clientHeight - er.height) / 2
    setFlash(reveal.seq)
    const t = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(t)
  }, [reveal])
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
            title="every event with its decision, grounds, and consequences attributed to their causes (reopenings, Restore, drops, frontier)"
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
        <ol className="log-list" ref={listRef}>
          {[...feed].reverse().map((e) => (
            <li key={e.key} data-seqs={e.seq} className={`vlog-entry${e.op.type === 'round' ? ' log-round' : ''}${flash === e.seq ? ' log-flash' : ''}`}>
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
              {e.op.type === 'round' && e.op.detail && <div className="vlog-line vlog-round-detail">{e.op.detail}</div>}
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
        <ol className="log-list" ref={listRef}>
          {compactRows(feed)
            .reverse()
            .map(({ entry: e, doubt }) => {
              const band = e.op.type === 'version' ? ' log-version' : e.op.type === 'round' ? ' log-round' : ''
              const lit = flash !== null && (flash === e.seq || flash === doubt?.seq)
              return (
                <li
                  key={e.key}
                  data-seqs={doubt ? `${doubt.seq} ${e.seq}` : e.seq}
                  className={`log-entry${band}${lit ? ' log-flash' : ''}`}
                  title={e.evidence}
                >
                  <span className="log-seq" title={doubt ? `events ${doubt.seq}–${e.seq}: Doubt then Verify, one act` : undefined}>
                    {e.seq}
                  </span>
                  <span className={`log-short kind-${kindOfEntry(e)}`}>{e.short}</span>
                  <span className={e.via ? 'log-full log-via' : 'log-full'}>
                    {doubt && e.op.type === 'verify' ? `${e.via} ${e.op.result === 'valid' ? '✓' : '✗'}` : (e.via ?? opNotation(e.op))}
                  </span>
                </li>
              )
            })}
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
  /** every target on a multi-target chain, the main one first; absent on a legacy chain */
  targets?: { id: string; solid: boolean; frontier: number; nodes: number }[]
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
                      <span className={`state-lamp ${p.rootSolid ? 'lamp-solid' : 'lamp-broken'}`} title={p.targets ? `main target ${p.rootId}` : undefined}>
                        {p.rootSolid ? 'solid' : 'broken'}
                      </span>
                    )}
                    {/* sub-targets stand on their own: a pipeline's wait must not read as the build being broken */}
                    {p.targets?.slice(1).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`target-chip ${t.solid ? 'target-solid' : 'target-broken'}`}
                        title={`target ${t.id}: ${t.nodes} node(s), ${t.frontier} on the frontier — open it`}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          window.location.assign(`/p/${encodeURIComponent(p.name)}?target=${encodeURIComponent(t.id)}`)
                        }}
                      >
                        {t.id}: {t.solid ? 'solid' : 'broken'}
                      </button>
                    ))}
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

/** Toolbar jump between the chain's targets; absent on a legacy single-target chain. */
function TargetSwitcher() {
  const sim = useSim()
  const targets = sim.targets()
  if (targets.length < 2) return null
  const current = sim.currentTarget()
  return (
    <select
      className="btn target-switch"
      value={current}
      onChange={(e) => sim.selectTarget(e.target.value === targets[0] ? null : e.target.value)}
      title="switch target — the view shows one target's cone at a time"
    >
      {targets.map((t) => (
        <option key={t} value={t}>
          {sim.targetLabel(t)}
          {sim.graph.solid(t) ? ' ✓' : ''}
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

/** The tab title names what the tab shows, so several project tabs can be told apart. */
export function titleFor(loc: { pathname: string; search: string }): string {
  const route = routeOf(loc)
  if (route === 'home') return 'DDAG — Projects'
  if (route === 'sandbox') return 'DDAG — Sandbox'
  const m = /^\/p\/([^/]+)\/?$/.exec(loc.pathname)
  const name = m ? decodeURIComponent(m[1]!) : (new URLSearchParams(loc.search).get('chain') ?? 'chain')
  return `DDAG — ${name}`
}

export default function App() {
  const route = routeOf(window.location)
  useEffect(() => {
    document.title = titleFor(window.location)
  }, [route])
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
  // the standing shown is the viewed target's: on a multi-target chain the kernel root is the project node, never judged
  const multi = sim.targets().length > 1
  const rootSolid = sim.graph.solid(sim.currentTarget())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ seq: number; n: number } | null>(null)
  const selected = selectedId !== null && sim.graph.has(selectedId) ? selectedId : null
  // a project or chain URL is a dashboard link — open it live, no click needed
  useEffect(() => {
    if (sim.liveSource() && !sim.isLive()) sim.toggleLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // switching target drops a selection the new cone does not show (a chip can still reach one)
  const target = sim.currentTarget()
  useEffect(() => {
    setSelectedId((id) => (id !== null && !sim.cone().has(id) ? null : id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])
  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarW}px` } as CSSProperties}>
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark">◉</span> Decompose DAG{' '}
          <span className="brand-sub">{sim.liveSource() ? sim.liveChainPath() : 'sandbox'}</span>
        </div>
        <div className="toolbar-state" title={multi ? `target ${sim.currentTarget()}` : undefined}>
          {multi ? 'target' : 'root'}:{' '}
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
          <TargetSwitcher />

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
          <DetailPanel id={selected} onSelect={setSelectedId} onReveal={(seq) => setReveal((r) => ({ seq, n: (r?.n ?? 0) + 1 }))} />
        </div>
        <SidebarResizer onResize={resize} />
        <aside className="sidebar">
          <OperationsPanel />
          <ActionLog reveal={reveal} />
        </aside>
      </main>
    </div>
  )
}
