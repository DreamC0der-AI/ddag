export type NodeId = string

export type Verdict = 'valid' | 'invalid' | 'pending'

/** Recorded at the last valid Verify: the node's entire justification, by content hash (SHA-256). */
export interface Fingerprint {
  ownHash: string
  preds: Record<NodeId, string>
}

export interface DagNode {
  id: NodeId
  content: string
  version: number
  verdict: Verdict
  fingerprint: Fingerprint | null
}

export type Op =
  | { type: 'add'; id: NodeId; content: string; successor: NodeId }
  | { type: 'link'; from: NodeId; to: NodeId }
  | { type: 'unlink'; from: NodeId; to: NodeId }
  | { type: 'mutate'; id: NodeId; content: string }
  | { type: 'verify'; id: NodeId; result: 'valid' | 'invalid' }
  | { type: 'doubt'; id: NodeId }

export type Result = { ok: true } | { ok: false; error: string }

export interface Arc {
  from: NodeId
  to: NodeId
}

/** Full graph serialization. Solid is never serialized — recomputed on load. */
export interface Snapshot {
  root: NodeId
  nodes: DagNode[]
  arcs: Arc[]
}
