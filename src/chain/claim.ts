/**
 * Node content convention (shell-level; the kernel sees one opaque string):
 *
 *   <claim — what must be true>
 *   Verify: <criterion — what evidence settles it, and the prediction>
 *
 * Both halves are fingerprinted together, on purpose: changing what counts
 * as proof reopens the judgment just as changing the claim does. The "why"
 * (the node's role in its parent's argument) is NOT here — it lives on the
 * Add event's rationale, because rewording a reason must not reset a verdict.
 */
export interface ClaimParts {
  claim: string
  criterion: string | null
}

const CRITERION_LINE = /^[ \t]*Verify:[ \t]*/im

export function parseClaim(content: string): ClaimParts {
  const m = CRITERION_LINE.exec(content)
  if (!m) return { claim: content.trim(), criterion: null }
  const claim = content.slice(0, m.index).trim()
  const criterion = content.slice(m.index + m[0].length).trim()
  return { claim, criterion: criterion.length > 0 ? criterion : null }
}

export function composeClaim(claim: string, criterion?: string | null): string {
  const c = claim.trim()
  const v = criterion?.trim()
  return v ? `${c}\nVerify: ${v}` : c
}
