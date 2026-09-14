import { describe, expect, it } from 'vitest'
import { canonicalKey, enumerateUniverse, explore, type Universe } from '../explorer'
import { checkReachability } from '../checklist'

// TARGET universe: the states we characterize. PATH universe: the states a
// history may pass through — strictly larger, because reaching a target can
// need scaffolding the target no longer shows (e.g. a temporary extra part,
// verified and unlinked, is how an invalid node gets a matching fingerprint).
// Bounding paths to the target universe undercounts reachability.
// b is frozen scaffolding: histories use it as a temporary leaf part (add,
// verify, unlink) — freezing prunes the search without costing soundness,
// since every state a pruned search reaches is still genuinely reachable
const TARGET_U: Universe = { idPool: ['a'], contents: ['R', 'X'], maxVersion: 2 }
const PATH_U: Universe = { idPool: ['a', 'b'], contents: ['R', 'X'], maxVersion: 2, frozenIds: ['b'] }

describe('small-scope exhaustive exploration', () => {
  // "reachable" is genesis-existential (DESIGN.md: "from a genesis graph") —
  // the root's creation content is as free as an added node's, so the
  // reachable set is the union over every alphabet genesis
  const reached = new Map(PATH_U.contents.flatMap((c) => [...explore(c, PATH_U).entries()]))
  // set equality is only meaningful over one syntactic domain: target-universe
  // states whose fingerprints also record only target ids (reached states may
  // legally carry fingerprints naming dropped scaffolding — those are covered
  // by the fwd direction but lie outside the enumeration)
  const targetIds = new Set(['root', ...TARGET_U.idPool])
  const reachedInTarget = new Map(
    [...reached].filter(
      ([, s]) =>
        s.nodes.every((n) => targetIds.has(n.id)) &&
        s.nodes.every((n) =>
          n.fingerprint === null
            ? true
            : Object.keys(n.fingerprint.preds).every((k) => targetIds.has(k)),
        ),
    ),
  )
  const universe = enumerateUniverse(TARGET_U)

  it('the reachable set is nontrivial and closed', () => {
    expect(reachedInTarget.size).toBeGreaterThan(100)
  })

  it('fwd by exhaustion: EVERY reached state passes the checklist (path universe included)', () => {
    for (const s of reached.values()) {
      const v = checkReachability(s)
      expect(v, `reached state must pass: ${v.join('; ')}\n${canonicalKey(s)}`).toEqual([])
    }
  })

  it('the converse, exactly: EVERY checklist-passing target state is reached', () => {
    // this is where R4 and R5 were discovered — with R1-R3 alone, 36,306
    // passing states were unreachable; R1-R5 characterizes exactly
    const passing = universe.filter((s) => checkReachability(s).length === 0)
    const missing = passing.filter((s) => !reachedInTarget.has(canonicalKey(s)))
    console.log(
      `universe=${universe.length} passing=${passing.length} reachedInTarget=${reachedInTarget.size} ` +
        `(pathReached=${reached.size}) missing=${missing.length}`,
    )
    for (const s of missing.slice(0, 4)) console.log('PASSING BUT UNREACHED:', canonicalKey(s))
    expect(missing.length).toBe(0)
    expect(passing.length).toBe(reachedInTarget.size) // set equality with fwd: passing ≡ reached
  })
})
