import { isVersionOp, type EventChain } from './chain'
import { Graph } from '../kernel/graph'
import { issueSummary, readIssues } from './issues'

/**
 * Versions (shell view over version events): when the project was declared
 * a working version, after which commit, and what the chain said of it at
 * that moment — root solid or broken, issues open. The state is read from
 * the chain at the mark's seq, never stored: a version record cannot claim
 * a state the chain does not bear out.
 */
export interface Version {
  name: string
  commit?: string
  dirty?: boolean
  note?: string
  seq: number
  rootSolid: boolean
  openIssues: number
  /** events recorded after this mark */
  eventsSince: number
}

export function readVersions(chain: EventChain): Version[] {
  const events = chain.chain()
  const out: Version[] = []
  for (const ev of events) {
    const op = ev.op
    if (!isVersionOp(op)) continue
    const g = Graph.fromSnapshot(chain.snapshotAt(ev.seq))
    const v: Version = {
      name: op.name,
      seq: ev.seq,
      rootSolid: g.solid(g.root),
      openIssues: issueSummary(readIssues(chain, ev.seq)).open,
      eventsSince: events.length - ev.seq,
    }
    if (op.commit !== undefined) v.commit = op.commit
    if (op.dirty !== undefined) v.dirty = op.dirty
    if (op.note !== undefined) v.note = op.note
    out.push(v)
  }
  return out
}

export function latestVersion(chain: EventChain): Version | undefined {
  const all = readVersions(chain)
  return all[all.length - 1]
}

export function versionLabel(v: Version): string {
  return `${v.name}${v.commit ? ` @${v.commit.slice(0, 7)}${v.dirty ? '*' : ''}` : ''}`
}

/** Plain-text report for the MCP shell, newest first. */
export function versionsReport(versions: readonly Version[]): string {
  if (versions.length === 0) return 'No versions marked on this chain.'
  const lines = [`Versions (${versions.length}, newest first):`]
  for (const v of [...versions].reverse()) {
    lines.push(
      `- ${versionLabel(v)} at event ${v.seq}: root ${v.rootSolid ? 'solid' : 'broken'}, ${v.openIssues} open issue(s), ${v.eventsSince} event(s) since${v.note ? ` — ${v.note}` : ''}${v.dirty ? ' (marked on a dirty tree: the commit alone does not identify the code)' : ''}`,
    )
  }
  return lines.join('\n')
}
