import { isIssueOp, type EventChain } from './chain'
import type { NodeId } from '../kernel/types'

/**
 * Issues (shell view over issue events): a finding recorded by an agent or
 * a person, with a lifecycle. Not a node — arcs mean part-of, and a bug is
 * not a part of correctness — and not a kernel concept: the kernel does not
 * care about meaning. Read from the chain's issue events, so any chain that
 * carries them shows the same list everywhere.
 */

export type IssueStatus = 'open' | 'fixed' | 'wontfix' | 'invalid' | 'duplicate'

export interface Issue {
  key: string
  title: string
  node?: NodeId
  severity?: string
  detail?: string
  status: IssueStatus
  /** seq of the opening event */
  openedAt: number
  closedAt?: number
  resolution?: string
}

export function readIssues(chain: EventChain, upToSeq?: number): Issue[] {
  const byKey = new Map<string, Issue>()
  for (const ev of chain.chain()) {
    if (upToSeq !== undefined && ev.seq > upToSeq) break
    const op = ev.op
    if (!isIssueOp(op)) continue
    if (op.action === 'open') {
      const issue: Issue = { key: op.key, title: op.title, status: 'open', openedAt: ev.seq }
      if (op.node !== undefined) issue.node = op.node
      if (op.severity !== undefined) issue.severity = op.severity
      if (op.detail !== undefined) issue.detail = op.detail
      byKey.set(op.key, issue)
    } else {
      const issue = byKey.get(op.key)
      if (!issue) continue // cannot happen on a chain built through dispatch
      issue.status = op.outcome
      issue.closedAt = ev.seq
      if (op.resolution !== undefined) issue.resolution = op.resolution
    }
  }
  return [...byKey.values()]
}

export function issueSummary(issues: readonly Issue[]): { open: number; closed: number } {
  let open = 0
  for (const i of issues) if (i.status === 'open') open++
  return { open, closed: issues.length - open }
}

/** Issues by node — for badges and the detail panel. */
export function issuesByNode(issues: readonly Issue[]): Map<NodeId, Issue[]> {
  const m = new Map<NodeId, Issue[]>()
  for (const i of issues) {
    if (i.node === undefined) continue
    if (!m.has(i.node)) m.set(i.node, [])
    m.get(i.node)!.push(i)
  }
  return m
}

/** The next assigned key, I1, I2, … skipping any the chain already uses. */
export function nextIssueKey(issues: readonly Issue[]): string {
  const used = new Set(issues.map((i) => i.key))
  for (let k = 1; ; k++) if (!used.has(`I${k}`)) return `I${k}`
}

/** Plain-text report for the MCP shell: open first, full detail on request. */
export function issuesReport(issues: readonly Issue[], opts: { detail?: boolean } = {}): string {
  if (issues.length === 0) return 'No issues recorded on this chain.'
  const s = issueSummary(issues)
  const lines = [`Issues (${s.open} open, ${s.closed} closed):`]
  const sorted = [...issues].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.openedAt - b.openedAt)
  for (const i of sorted) {
    let line = `- ${i.key} [${i.status}]${i.severity ? ` ${i.severity}` : ''}${i.node ? ` on ${i.node}` : ''}: ${i.title}`
    if (i.status !== 'open') line += `\n    closed at #${i.closedAt}${i.resolution ? `: ${i.resolution}` : ''}`
    if (opts.detail && i.detail) line += `\n    ${i.detail.split('\n').join('\n    ')}`
    lines.push(line)
  }
  return lines.join('\n')
}
