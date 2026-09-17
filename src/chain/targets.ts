import type { Graph } from '../kernel/graph'
import type { NodeId, Snapshot } from '../kernel/types'
import type { ChainDump, EventChain } from './chain'

/**
 * Targets are a reading of the shape, not a kernel notion (DESIGN.md
 * "Targets"). A chain either has a project node — recorded in the dump's
 * meta, shown and judged by no shell — whose direct parts are the targets in
 * creation order, the first being the main target; or it is a legacy
 * single-target chain whose kernel root is its main target. A forest of
 * sinks is the same shape as one root whose parts are the sinks, so the
 * kernel, its invariants and the reachability theory are untouched.
 */

/** The project node's id; kept out of the way of user ids. */
export const PROJECT_ID: NodeId = '_project'

export function projectOf(chain: EventChain): NodeId | null {
  const p = chain.project
  return p !== undefined && chain.graph.has(p) ? p : null
}

/** The targets in creation order; the first is the main target. */
export function targetsOf(chain: EventChain): NodeId[] {
  const p = projectOf(chain)
  return p === null ? [chain.graph.root] : chain.graph.predecessors(p)
}

export function mainTarget(chain: EventChain): NodeId {
  return targetsOf(chain)[0]!
}

/** A target's cone: every node with a path to it, the target included. */
export function coneOf(g: Graph, target: NodeId): Set<NodeId> {
  const seen = new Set<NodeId>([target])
  const queue: NodeId[] = [target]
  while (queue.length > 0) {
    const n = queue.shift()!
    for (const p of g.predecessors(n)) {
      if (!seen.has(p)) {
        seen.add(p)
        queue.push(p)
      }
    }
  }
  return seen
}

/**
 * Every node's home target: the target it was created under, read off the
 * add events — a node added under the project node is a target and its own
 * home — and re-homed to the first target it still reaches when it no longer
 * reaches its home (a subtree moved between targets). Derived, never stored.
 * The project node has no home and is absent from the map.
 */
export function homesOf(chain: EventChain): Map<NodeId, NodeId> {
  const g = chain.graph
  const p = projectOf(chain)
  const targets = targetsOf(chain)
  const main = targets[0]!
  const sticky = new Map<NodeId, NodeId>()
  for (const n of chain.snapshotAt(0).nodes) if (n.id !== p) sticky.set(n.id, main)
  for (const e of chain.chain()) {
    if (e.op.type !== 'add') continue
    const s = e.op.successor
    sticky.set(e.op.id, s === p ? e.op.id : (sticky.get(s) ?? main))
  }
  const cones = new Map<NodeId, Set<NodeId>>(targets.map((t) => [t, coneOf(g, t)]))
  const out = new Map<NodeId, NodeId>()
  for (const id of g.ids()) {
    if (id === p) continue
    const t = targets.find((x) => x === id)
    if (t !== undefined) {
      out.set(id, id)
      continue
    }
    let h = sticky.get(id)
    if (h === undefined || !cones.has(h) || !cones.get(h)!.has(id)) h = targets.find((x) => cones.get(x)!.has(id)) ?? main
    out.set(id, h)
  }
  return out
}

/**
 * Turn a legacy single-target dump into a project dump without touching an
 * event: the initial snapshot becomes a keyframe holding the project node
 * with the old root as its part, meta names the project node, and the events
 * replay unchanged (they never reference the project node). Every state
 * reachable from the keyframe is reachable from a plain genesis by one add.
 */
export function migrateToProject(dump: ChainDump, projectContent: string, projectId: NodeId = PROJECT_ID): ChainDump {
  if (dump.meta?.project !== undefined) return dump
  const initial = dump.initial
  const taken =
    initial.nodes.some((n) => n.id === projectId) ||
    dump.events.some((e) => e.op.type === 'add' && e.op.id === projectId)
  if (taken) throw new Error(`cannot migrate: the id "${projectId}" is already used on this chain`)
  const keyframe: Snapshot = {
    root: projectId,
    nodes: [{ id: projectId, content: projectContent, version: 0, verdict: 'pending', fingerprint: null }, ...initial.nodes],
    arcs: [...initial.arcs, { from: initial.root, to: projectId }],
  }
  return { initial: keyframe, events: dump.events, meta: { project: projectId } }
}
