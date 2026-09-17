import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import type { Verdict } from '../kernel/types'
import { NODE_R, forceLayout } from './layout'
import { describeDiff, useSim } from './store'

interface SimNodeData extends Record<string, unknown> {
  content: string
  verdict: Verdict
  isRoot: boolean
  onFrontier: boolean
  isSelected: boolean
  /** heal: pending + justification intact (self-heals) · work: verified once, needs action */
  fpBar: 'heal' | 'work' | null
  /** ordering view: this frontier node's rank by the one-step lookahead */
  rank: { n: number; win: boolean; restores: number; unlocks: number } | null
  /** provenance audit: this valid judgment rests on artifacts that changed or vanished */
  stale: { changed: string[]; missing: string[]; detail?: string[] } | null
  /** recorded issues on this claim: open keys and closed count */
  issue: { open: string[]; closed: number } | null
  /** targets: this node is judged in another target (its home) and only used here */
  home: string | null
}

type SimRFNode = Node<SimNodeData, 'sim'>

function SimNodeView({ id, data }: NodeProps<SimRFNode>) {
  const cls = [
    'sim-node',
    `nv-${data.verdict}`,
    data.onFrontier ? 'on-frontier' : '',
    data.isRoot ? 'is-root' : '',
    data.isSelected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} title={`${data.content} — verdict: ${data.verdict}`}>
      {data.rank && (
        <span
          className={data.rank.win ? 'rank-badge rank-win' : 'rank-badge'}
          title={
            data.rank.win
              ? 'winning move — verifying this turns the root solid'
              : `best-judgment rank #${data.rank.n}${data.rank.restores > 0 ? ` · restores ${data.rank.restores}` : ''}${data.rank.unlocks > 0 ? ` · unlocks ${data.rank.unlocks}` : ''}`
          }
        >
          {data.rank.win ? '★' : data.rank.n}
        </span>
      )}
      {data.issue && (data.issue.open.length > 0 || data.issue.closed > 0) && (
        <span
          className={data.issue.open.length > 0 ? 'issue-badge issue-open' : 'issue-badge issue-fixed'}
          title={
            data.issue.open.length > 0
              ? `${data.issue.open.length} open issue(s) on this claim: ${data.issue.open.join(', ')}${data.issue.closed > 0 ? ` · ${data.issue.closed} closed` : ''}`
              : `${data.issue.closed} issue(s) recorded on this claim, all closed`
          }
        >
          {data.issue.open.length > 0 ? `${data.issue.open.length}!` : `${data.issue.closed}✓`}
        </span>
      )}
      {data.stale && (
        <span
          className="stale-badge"
          title={`judged against code that no longer exists — ${[
            ...(data.stale.detail ?? data.stale.changed.map((p) => `${p} changed`)),
            ...data.stale.missing.map((p) => `${p} missing`),
          ].join('\n')}`}
        >
          !
        </span>
      )}
      <Handle type="target" position={Position.Top} className="hidden-handle" />
      <div className="sim-node-core">
        <span className="sim-node-id">{id}</span>
        {data.fpBar && (
          <span
            className={`fp-bar fp-${data.fpBar}`}
            title={
              data.fpBar === 'heal'
                ? 'justification intact — heals via Restore, no action needed'
                : 'verified once, justification changed — re-verify or revert'
            }
          />
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="hidden-handle" />
      {data.home && (
        <span className="home-chip" title={`judged in target ${data.home} — used here, not verifiable here`}>
          home: {data.home}
        </span>
      )}
    </div>
  )
}

/** Straight edge from circle rim to circle rim, whatever the angle. */
function FloatingEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const sc = {
    x: s.internals.positionAbsolute.x + (s.measured.width ?? NODE_R * 2) / 2,
    y: s.internals.positionAbsolute.y + (s.measured.height ?? NODE_R * 2) / 2,
  }
  const tc = {
    x: t.internals.positionAbsolute.x + (t.measured.width ?? NODE_R * 2) / 2,
    y: t.internals.positionAbsolute.y + (t.measured.height ?? NODE_R * 2) / 2,
  }
  const dx = tc.x - sc.x
  const dy = tc.y - sc.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const path = `M ${sc.x + ux * NODE_R},${sc.y + uy * NODE_R} L ${tc.x - ux * (NODE_R + 3)},${tc.y - uy * (NODE_R + 3)}`
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
}

const nodeTypes = { sim: SimNodeView }
const edgeTypes = { floating: FloatingEdge }

/** Re-fit the viewport when the structure (not mere state) changes. */
function AutoFit({ structureKey }: { structureKey: string }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    void fitView({ padding: 0.15, maxZoom: 1, duration: 200 })
  }, [structureKey, fitView])
  return null
}

interface CanvasProps {
  selected: string | null
  onSelect: (id: string | null) => void
}

export function GraphCanvas({ selected, onSelect }: CanvasProps) {
  const sim = useSim()
  const version = sim.getVersion()
  const centersRef = useRef(new Map<string, { x: number; y: number }>())
  const pinnedRef = useRef(new Map<string, { x: number; y: number }>())

  // one target's cone at a time: the target is the root, other targets' nodes are absent
  const { snap, structureKey } = useMemo(() => {
    const snap = sim.viewSnapshot()
    return { snap, structureKey: JSON.stringify([snap.root, snap.nodes.map((n) => n.id), snap.arcs]) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // Physics runs ONLY on structural change — verify/mutate must not shift the
  // picture (re-running the simulation resumes annealing and drifts positions).
  // User-dragged nodes are pinned and hold their positions across re-layouts.
  const centers = useMemo(() => {
    const c = forceLayout(snap, centersRef.current, pinnedRef.current)
    centersRef.current = c
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  const buildView = () => {
    const g = sim.graph
    const front = sim.onFrontier()
    const ranks = sim.frontierRanks()
    const target = snap.root
    const nodes: SimRFNode[] = snap.nodes.map((n) => {
      const c = centersRef.current.get(n.id) ?? centers.get(n.id)!
      return {
        id: n.id,
        type: 'sim',
        position: { x: c.x - NODE_R, y: c.y - NODE_R },
        data: {
          content: n.content,
          verdict: n.verdict,
          isRoot: n.id === snap.root,
          onFrontier: front.has(n.id),
          isSelected: n.id === selected,
          // underlines are a yellow-only signal: on pending nodes with a
          // fingerprint, solid = heals via Restore, dashed = needs action
          fpBar:
            n.verdict !== 'pending' || n.fingerprint === null
              ? null
              : sim.fingerprintIntact(n.id)
                ? 'heal'
                : 'work',
          rank: ranks.get(n.id) ?? null,
          issue: (() => {
            const list = sim.issuesOf(n.id)
            if (list.length === 0) return null
            const open = list.filter((i) => i.status === 'open').map((i) => i.key)
            return { open, closed: list.length - open.length }
          })(),
          stale: (() => {
            const a = sim.auditOf(n.id)
            if (!a || a.status !== 'stale') return null
            return {
              changed: a.changed,
              missing: a.missing,
              ...(a.diffs && a.diffs.length > 0 ? { detail: a.diffs.map(describeDiff) } : {}),
            }
          })(),
          home: (() => {
            const h = sim.homeOf(n.id)
            return h === target ? null : sim.targetLabel(h)
          })(),
        },
        draggable: true,
        selectable: false,
        connectable: false,
        deletable: false,
      }
    })
    const edges: Edge[] = snap.arcs.map((a) => ({
      id: `${a.from}->${a.to}`,
      source: a.from,
      target: a.to,
      type: 'floating',
      selectable: false,
      deletable: false,
      focusable: false,
      className: g.verdict(a.from) === 'valid' ? 'arc-solid' : 'arc-broken',
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    }))
    return { nodes, edges }
  }

  // Canonical controlled pattern: the view arrays are rebuilt from the kernel
  // only when the graph or selection changes; drag events PATCH the existing
  // array via applyNodeChanges. Rebuilding per drag-move makes React Flow
  // re-adopt (and re-measure) every node, blanking the canvas mid-drag.
  const [view, setView] = useState<{ nodes: SimRFNode[]; edges: Edge[] }>(buildView)

  useEffect(() => {
    setView(buildView())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, centers, selected])

  const onNodesChange = useCallback((changes: NodeChange<SimRFNode>[]) => {
    for (const ch of changes) {
      if (ch.type === 'position' && ch.position) {
        centersRef.current.set(ch.id, { x: ch.position.x + NODE_R, y: ch.position.y + NODE_R })
      }
    }
    setView((v) => ({ ...v, nodes: applyNodeChanges(changes, v.nodes) }))
  }, [])

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, n) => {
          // a dragged node is pinned: future re-layouts hold it where you put it
          pinnedRef.current.set(n.id, { x: n.position.x + NODE_R, y: n.position.y + NODE_R })
        }}
        onNodeDoubleClick={(_, n) => {
          // double-click releases the pin — physics takes the node back
          pinnedRef.current.delete(n.id)
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
        <Controls showInteractive={false} />
        <AutoFit structureKey={structureKey} />
      </ReactFlow>
    </div>
  )
}
