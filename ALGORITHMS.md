# Kernel Algorithms

This document specifies the algorithm of each operation, precisely enough to implement and test against. DESIGN.md is the normative spec of *what* must hold; this file defines *how* the kernel achieves it, citing DESIGN.md's named invariants (I1–I3), verdict rules (T1–T3), and theorems (D1–D2). Every operation follows the same three-step shape:

1. **Validate** — check every rule against the current graph. Any failure rejects the operation with a reason; the graph is untouched.
2. **Apply** — mutate structure / node fields.
3. **Propagate** — run the shared propagation passes to restore all invariants.

An operation is atomic: after `apply(op)` returns, either nothing changed (rejected) or all invariants hold (applied). Only applied operations become events on the chain.

## Kernel state

- `nodes: Map<id, {content, contentHash, version, verdict, fingerprint}>` — verdict ∈ {valid, invalid, pending}; `contentHash = h(content)` (SHA-256), maintained on create and Mutate, never serialized (recomputed on load); `version` is a counter incremented by Mutate (bookkeeping only); `fingerprint` is `{ownHash, preds: Map<id, hash>} | null`, recorded at the last valid Verify
- `succ: Map<id, Set<id>>` — out-arcs (arc A→B: A is predecessor of B, B is successor of A)
- `pred: Map<id, Set<id>>` — in-arcs (mirror of `succ`)
- `root: id`
- `solid: Map<id, boolean>` — cached computed state

**Determinism rule:** all Maps/Sets iterate in insertion order; every traversal below visits in that order. No clock, no randomness. Same graph + same operation ⇒ same result, always.

## Shared subroutines

### CanReach(x, y): boolean
DFS from `x` along `succ` arcs; true iff `y` is reached. Used by Link's cycle check (preserving I1).

### DropPass() → droppedNodes
Enforces the survival invariant I3: a node survives iff it has a path to root along `succ` arcs. This is one reachability pass — no-successor drops, cascades, and split-component drops all fall out of it.

1. `reachable` := BFS from `root` following `pred` arcs (this collects exactly the nodes with a `succ`-path to root).
2. For every node `n ∉ reachable` (insertion order): record `n` as dropped.
3. Delete dropped nodes and all their arcs from the state.

**D2 (drop closure) applied:** every successor of a dropped node is itself dropped — if a dropped node had a surviving successor, the successor's path to root would extend backward to it, contradicting the drop. So a drop cascade never removes an in-arc of a survivor (never fires T1 on one); survivors can only lose *successors*, which are irrelevant to verdict and solid. Consequently DropPass triggers no verdict resets and seeds no solid propagation.

### ResetVerdictStructural(n)
The valid ⇒ pending degrade of rule T1 (predecessor set changed): if `verdict(n) == valid` then set it to `pending`. (`invalid` and `pending` are untouched — only T3/Mutate resets unconditionally. Rule T2 is applied inline by PropagateSolid.)

### FingerprintMatches(n): boolean
True iff `fingerprint(n)` is non-null, `fingerprint(n).ownHash == contentHash(n)`, and `fingerprint(n).preds` has exactly the same id set as `pred(n)` with equal content hashes. A match means n's entire justification — its own content and every direct predecessor's content — is bit-for-bit what it was at the last valid verification.

Identity is by content, not by counter, which makes two edge cases correct by construction: a dropped id later re-added with different content hashes differently (no unsound restore), and content mutated back to its exact verified text matches again (restore fires — the justification really is identical). Fingerprints are written by Verify and cleared only by Doubt (a withdrawn judgment must not be resurrectable).

### PropagateSolid(seeds: Set<id>)
Restores the solid definition `solid(n) ≡ verdict(n) = valid ∧ ∀p ∈ pred(n): solid(p)` everywhere, applying two verdict rules along the way: T2 (predecessor's solid flips true→false ⇒ successor's valid verdict → pending) and Restore (pending + all preds solid + fingerprint match ⇒ valid, no re-verification needed — sound under DESIGN.md's verification axiom).

```
worklist := seeds (insertion order, deduplicated)
while worklist not empty:
    n := pop front
    if verdict(n) == pending
       and every p in pred(n) has solid(p) == true
       and FingerprintMatches(n):
        verdict(n) := valid                // Restore — justification unchanged
    newSolid := verdict(n) == valid AND every p in pred(n) has solid(p) == true
                (no predecessors ⇒ the predecessor condition is vacuously true)
    if newSolid == solid(n): continue
    solid(n) := newSolid
    for s in succ(n):
        if newSolid == false and verdict(s) == valid:
            verdict(s) := pending          // T2 — the true→false trigger
        push s onto worklist
```

Terminates because the graph is acyclic and each node's solid can only flip a bounded number of times per operation.

Propagation is asymmetric, in a way Restore reshapes: a plain **false→true** flip cascades only through *restorable* nodes. When `solid(A)` flips true, a successor `s` newly becomes solid only if its verdict is (or restores to) valid — for non-restorable nodes a fresh Verify is still required, one node at a time. So one Verify at the blast-radius boundary can turn a whole restorable ancestor chain green in a single wave, while genuinely changed nodes (changed content ⇒ hash mismatch) each demand their own Verify. Re-verification work is proportional to the blast radius of a change — the mutated node and its direct successors — not the depth of the graph.

## Operations

### Add(A) — payload: id, content, successor s

Operations are atoms: a node with multiple successors is built by `Add` then `Link` per further successor, one event each.

**Validate**
- `A` not already in `nodes`
- `s` exists
- (cycle impossible: `A` is new, so no arc can return to it)

**Apply**
- create node `A` with the given content, `version := 0`, `verdict := pending`, `fingerprint := null`
- add arc `A→s`

**Propagate**
- `ResetVerdictStructural(s)` (T1: gained a predecessor)
- `solid(A) := false` (pending verdict)
- `PropagateSolid({A, s})`
- (no drops possible: no arc was removed)

### Link(A->B) — payload: from A, to B

**Validate**
- `A` and `B` exist, `A ≠ B`
- `A ≠ root` (preserves I2)
- arc `A→B` absent
- no cycle: `CanReach(B, A)` must be false (preserves I1)

**Apply**
- add arc `A→B`

**Propagate**
- `ResetVerdictStructural(B)` (T1: gained a predecessor)
- `PropagateSolid({B})`
- (no drops possible)

### Unlink(A||B) — payload: from A, to B

**Validate**
- arc `A→B` exists

**Apply**
- remove arc `A→B`

**Propagate**
- `DropPass()` — `A` may have lost its last successor and drop, cascading through its predecessors; a split-off component drops entirely. (`B` always survives: its own out-arcs are untouched, so its path to root is intact. `root` always survives by definition.) By D2, the cascade itself causes no verdict resets on survivors.
- `ResetVerdictStructural(B)` (T1: lost predecessor `A` — by D2 the only pred-loss a survivor can experience)
- `PropagateSolid({B})`

### Mutate(A) — payload: id, new content

**Validate**
- `A` exists

**Apply**
- `content(A) :=` new content; `contentHash(A) := h(new content)`
- `version(A) := version(A) + 1`
- `verdict(A) := pending` (T3: unconditionally — from valid *or* invalid)

**Propagate**
- `PropagateSolid({A})` (if `solid(A)` was true it flips false and ripples resets toward root; if already false, nothing changes downstream. `A` restores immediately iff the new content is exactly the verified content — hash match — otherwise it must be re-verified)

### Verify(A) — payload: id, result ∈ {valid, invalid}

The judgment itself comes from outside the kernel (agent, human); the kernel only enforces when a judgment may be recorded.

**Validate**
- `A` exists
- `verdict(A) ∈ {pending, invalid}` (a valid node is not re-verified)
- every `p ∈ pred(A)` has `solid(p) == true` (vacuous for leaves)

**Apply**
- `verdict(A) := result`
- if `result == valid`: `fingerprint(A) := { ownHash: contentHash(A), preds: Map of (p → contentHash(p)) for p in pred(A) }`

**Propagate**
- `PropagateSolid({A})` (result valid ⇒ `solid(A)` flips true and may cascade Restore through ancestors whose fingerprints still match; result invalid ⇒ solid stays false, no downstream change)

### Doubt(A) — payload: id

**Validate**
- `A` exists
- `verdict(A) == valid` (pending is vacuous; invalid is already re-verifiable)

**Apply**
- `verdict(A) := pending`
- `fingerprint(A) := null` (the judgment's ledger entry dies with the judgment — Restore must never resurrect a withdrawn verdict)

**Propagate**
- `PropagateSolid({A})` (`A` was solid — D1 — so it flips false and T2 reopens the valid ancestors; they keep their fingerprints, so a later re-verification of `A` restores them in one wave. `A` itself cannot Restore: its fingerprint is gone)

## Replay

`Replay(snapshot, events)`:
1. Load the snapshot: rebuild `nodes` (including `version` and `fingerprint` — the fingerprint is serialized history, or restorability would be lost across reload; `contentHash` is recomputed from content) and `succ`/`pred`, then recompute `solid` for all nodes in topological order (predecessors before successors) — solid is never trusted from serialized data.
2. For each event in chain order: `apply(event.op)` through the exact same code path as live operation. Every event must apply successfully — a rejection during replay means the chain or snapshot is corrupt, and replay aborts with an error.

Determinism of the kernel guarantees the replayed graph is identical (same snapshot output) to the live graph that produced the chain.
