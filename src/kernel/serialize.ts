import { Graph } from './graph'
import type { Snapshot } from './types'

export function serializeGraph(g: Graph): string {
  return JSON.stringify(g.snapshot())
}

export function deserializeGraph(json: string): Graph {
  const snap = JSON.parse(json) as Snapshot
  return Graph.fromSnapshot(snap)
}
