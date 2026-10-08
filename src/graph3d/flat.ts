import type { EventChain } from '../chain/chain'
import { arcKey, readTags } from '../chain/tags'
import { coneOf, mainTarget, targetsOf } from '../chain/targets'
import type { NodeId, Verdict } from '../kernel/types'

/**
 * A chain as the flat graph the 3D view draws (src/graph3d/main.js): one
 * target's cone — its claims, the arcs between them and each arc's tags —
 * with the project node left out, as every view leaves it out. A reading of
 * the chain, computed per request and never stored.
 */
export interface FlatGraph {
  name: string
  /** the chain's position: the view polls, and redraws when what it reads has changed */
  position: number
  /** the target whose cone this is — the root the view is drawn around */
  root: NodeId
  /** every target, the main one first; a single entry on a single-target chain */
  targets: NodeId[]
  nodes: { id: NodeId; title: string; detail: string; verdict: Verdict; solid: boolean; root: boolean }[]
  /** source is the part, target the whole that rests on it */
  links: { source: NodeId; target: NodeId; tags?: string[] }[]
}

/** The cone of `target` (default: the main target); null when the chain has no such target. */
export function flatGraph(chain: EventChain, name: string, target?: NodeId): FlatGraph | null {
  const g = chain.graph
  const targets = targetsOf(chain)
  const root = target ?? mainTarget(chain)
  if (!targets.includes(root)) return null
  const cone = coneOf(g, root)
  const tags = readTags(chain)
  const ids = g.ids().filter((id) => cone.has(id))
  const nodes = ids.map((id) => {
    const n = g.node(id)
    const [title = '', ...rest] = n.content.split('\n')
    return { id, title, detail: rest.join('\n'), verdict: n.verdict, solid: g.solid(id), root: id === root }
  })
  const links = ids.flatMap((id) =>
    g
      .successors(id)
      .filter((s) => cone.has(s))
      .map((s) => {
        const t = tags.get(arcKey(id, s))?.tags
        return t ? { source: id, target: s, tags: t } : { source: id, target: s }
      }),
  )
  return { name, position: chain.position, root, targets, nodes, links }
}
