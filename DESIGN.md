# Decompose DAG
  The decompose DAG (graph for short) is a tool that can help human developer and coding agent to reason about the composition of a build target. Decompose DAG works at epistemic level, guarded by tests/evidences.

  A graph has two important aspects, the structure of the graph and the state of nodes. The graph structure shows the dependences between nodes. The node color shows the state of a node.

  Throughout this document, each rule is stated once in prose (the intent) and once formally (the exact meaning). The notation is standard: sets (`∈ ∉ ⊆ ∪ \ ∅`), logic (`∧ ∨ ¬ ∀ ∃ ⟹ ≡`), paths (`→⁺` one or more arcs, `→*` zero or more arcs), and primes (`x'`) for the value of `x` after an operation. `⊥` means "absent".

# Kernel
  The kernel is the pure state machine of the graph: it holds the structure and node states, validates operations, and applies them with deterministic propagation. The kernel has no I/O, no clock, no randomness — applying the same operation to the same graph always produces the same result. Everything else (event chain, agent tool, UI) is a shell built around the kernel.

  The kernel state:

  ```
  G = (N, A, root)          A ⊆ N × N          root ∈ N
  ```

  An arc `(a,b) ∈ A`, written `a->b`, makes `a` a part of `b`:

  ```
  pred(n) = { p | (p,n) ∈ A }        the parts of n
  succ(n) = { s | (n,s) ∈ A }        what n composes into
  ```

  ## Two Planes
  Operations act on two different planes:

  - Structural change — Add, Link, Unlink — reshapes the architecture of justification: what rests on what. Structure settles nothing: no arc makes a claim true; it only determines what would have to be settled, and in what order.
  - Epistemic change — Verify records a judgment; Doubt withdraws one; Mutate changes the claim there is to judge, voiding the old judgment.

  The verdict rules T1–T3 are the bridge between the planes, and the bridge is one-way and destructive-only:

  ```
  structural or content change   ⟹   can only destroy trust (valid ⇒ pending)      (T1, T2, T3)
  withdrawal (Doubt)             ⟹   destroys one judgment directly
  judgment (Verify)              —    the only source of trust
  ```

  No structural act can ever turn a node valid; only Verify does. Restore obeys the law: it does not create trust, it revives a judgment Verify created, and only when the judged situation has returned bit-for-bit — the fingerprint is the bridge's ledger, a judgment recorded together with the structural and content situation it was made in.

  Consequence for use: structural work is cheap, reversible, exploratory — rearranging freely costs at worst pending. Judgment is the scarce resource, and the machinery (frontier ordering, blast-radius invalidation, Restore) exists to spend it efficiently and never counterfeit it.

  ## Structure

  ### Root Node
  The first node in the graph is root node. Root must have 0 successor.

  ### Invariants
  Three invariants hold after every operation:

  ```
  I1 (acyclic)     ¬∃n ∈ N:  n →⁺ n
  I2 (root sink)   succ(root) = ∅
  I3 (survival)    ∀n ∈ N \ {root}:  n →⁺ root
  ```

  I1: no node can reach itself. I2: nothing composes the root into anything further. I3: every other node contributes, through one or more arcs, to the root.

  ### Path to Root
  There is a single survival rule: I3. Any node without a path to root is dropped, together with its arcs.

  This one rule subsumes the rest: a non-root node with no successor has no path to root, so it is dropped; the drop can cascade; and when an operation splits the graph into disconnected sub-graphs, only the sub-graph containing the root survives. The graph is therefore always connected, orphan nodes / sub-graphs cannot exist.

  ### Graph Operations
  There are 3 types of operations that can apply in the graph. Each is specified by its precondition (`requires` — if any clause fails, the operation is rejected and nothing changes) and its effect on the state.

  #### Add — `Add(A)`
  Add a node in the graph with exactly one out-arc, to an existing node — its first successor. The newly added node has no predecessor and verdict pending. Operations are atoms: adding a node with multiple successors is not a basic operation but a combination, `Add` followed by `Link` for each further successor.

  ```
  Add(a, content, s)
    requires:  a ∉ N,   s ∈ N
    effects:   N' = N ∪ {a};   A' = A ∪ {(a,s)}
               content'(a) = content;   version'(a) = 0
               verdict'(a) = pending;   fp'(a) = ⊥
  ```

  #### Link — `Link(A->B)`
  Add an arc between 2 nodes, only valid if no cycle created.

  ```
  Link(a->b)
    requires:  a,b ∈ N,   a ≠ b,   a ≠ root,   (a,b) ∉ A,   ¬(b →⁺ a)
    effects:   A' = A ∪ {(a,b)}
  ```

  `a ≠ root` preserves I2; `¬(b →⁺ a)` preserves I1.

  #### Unlink — `Unlink(A||B)`
  Remove an arc, it may result in dropping a node / a sub-graph.

  ```
  Unlink(a||b)
    requires:  (a,b) ∈ A
    effects:   A' = A \ {(a,b)};   then every n violating I3 is dropped (cascade)
  ```

  ## Node
  A node is composed by:
  - id: unique across the graph (node identity — `N` is a set of ids)
  - content: the load of the node
  - version: content version counter, `version(n) ∈ ℕ`, starts at 0, incremented on every mutate (bookkeeping for display and diffs — soundness rests on content hashes, see Restore)
  - verdict: `verdict(n) ∈ {valid, invalid, pending}`. See below.
  - solid: boolean, a computed value (see State)
  - fingerprint: `fp(n)`, recorded at the last valid verification; `⊥` if never verified valid, or after Doubt. See Restore.

  ### Verdict
  The verdict of a node degrades from valid to pending when its justification is disturbed — by a structural change to its predecessor set, by a predecessor turning unsolid, or by its own content mutating:

  ```
  T1 (structure)   pred'(n) ≠ pred(n)                        ⟹  verdict'(n): valid ⇒ pending
  T2 (upstream)    ∃p ∈ pred(n): solid(p) ∧ ¬solid'(p)       ⟹  verdict'(n): valid ⇒ pending
  T3 (content)     Mutate(n)                                 ⟹  verdict'(n) = pending
  ```

  T1 covers a new added node pointing at n, a link gaining a predecessor, and an unlink (or cascade) losing one. T1 and T2 degrade only valid; T3 is unconditional — it resets valid and invalid alike.

  ### State
  The state is a computed value of boolean:

  ```
  solid(n)  ≡  verdict(n) = valid  ∧  ∀p ∈ pred(n): solid(p)
  ```

  The `∀` over an empty set is vacuously true, so a node with no predecessor is solid iff its verdict is valid — the leaf rule needs no special case, and root follows the same formula as every other node. The recursion is well-founded because of I1.

  ### Restore (verification cascade)
  Verification axiom: verification of a node depends only on its own content and the contents of its direct predecessors — never anything deeper. Restore is sound only under this axiom.

  The fingerprint freezes a node's entire justification, by content identity. `h` is a collision-resistant hash (SHA-256) — a pure function, so kernel determinism is preserved:

  ```
  fp(n) = ( h(content(n)),  { (p, h(content(p))) | p ∈ pred(n) } )        recorded at Verify(n) = valid
  ```

  When a pending node's justification is bit-for-bit what it was at its last valid verification, and its parts are solid again, the verdict restores with no re-verification:

  ```
  verdict(n) = pending  ∧  (∀p ∈ pred(n): solid(p))  ∧  fp_now(n) = fp_recorded(n)
    ⟹  verdict'(n) = valid
  ```

  The single equality `fp_now = fp_recorded` simultaneously guarantees: no predecessor added or removed, every predecessor's content identical, own content identical — by content, not by counter. Two consequences: a dropped id that is later re-added with different content can never impersonate the verified predecessor (its hash differs), and mutating a node back to its exact verified content is restorable, because the justification really is unchanged.

  Restore is propagation (a deterministic consequence inside the kernel), not an event. It can cascade: one verify can restore a whole chain of ancestors in a single wave. Result: re-verification work is proportional to the blast radius of a change (the mutated node and its direct successors), not the depth of the graph.

  ### Node Operations

  #### Mutate — `Mutate(A)`
  Mutate changes the content of the node, increments its version, also changes the verdict to pending.

  ```
  Mutate(a, content)
    requires:  a ∈ N
    effects:   content'(a) = content;   version'(a) = version(a) + 1
               verdict'(a) = pending                                   (T3)
  ```

  #### Verify — `Verify(A)`
  Verify the content of the node, when the node's predecessors are all solid and the verdict is currently pending / invalid. The result can either be valid or invalid, can't return to pending. The judgment `r` comes from outside the kernel.

  ```
  Verify(a) = r,   r ∈ {valid, invalid}
    requires:  a ∈ N,   verdict(a) ∈ {pending, invalid},   ∀p ∈ pred(a): solid(p)
    effects:   verdict'(a) = r
               if r = valid:   fp'(a) = ( h(content(a)), { (p, h(content(p))) | p ∈ pred(a) } )
  ```

  #### Doubt — `Doubt(A)`
  Withdraw the judgment on node A: the claim and its parts stand as written, but the recorded verification is no longer trusted — the evidence went stale, or confidence in the examination was lost. This is the only honest reopening of a valid node.

  ```
  Doubt(a)
    requires:  a ∈ N,   verdict(a) = valid
    effects:   verdict'(a) = pending;   fp'(a) = ⊥
  ```

  Clearing the fingerprint is the essence: the fingerprint is the judgment's ledger entry, so it dies with the judgment — Restore can never resurrect a withdrawn verdict. Ancestors reopen through T2 but keep their fingerprints; a's content is unchanged, so re-verifying a valid restores the whole tower in one wave — a confirmed doubt costs exactly one re-verification, a disconfirmed one correctly holds everything above open. Doubt does not propagate downward: doubting a judgment says nothing about the judgments of its parts.

  ## Theorems
  Two properties follow from the rules above; they are theorems, not extra rules:

  ```
  D1 (justified validity)   verdict(n) = valid  ⟹  ∀p ∈ pred(n): solid(p)
  D2 (drop closure)         n dropped  ⟹  ∀s ∈ succ(n): s dropped
  ```

  D1: a valid verdict can only be created above solid parts (Verify's precondition) and is destroyed the moment a part turns unsolid (T1/T2) — so validity is always currently justified, and `solid(n) ≡ verdict(n) = valid` holds as a corollary. D2: if a dropped node had a surviving successor, that successor's path to root would extend backward to it, contradicting the drop — so a drop cascade never removes a predecessor of a survivor, and drops never trigger T1 on surviving nodes beyond the unlinked arc itself.

  ## Enabled Actions
  Every operation's `requires` clause is decidable from the current graph, so the set of legal next operations — the action space — is computable. This is what a shell enumerates: a simulator presents it as the move menu, an agent plans over it, an exhaustive test walks it. It is a read-only computed view; the kernel's operations are unchanged.

  ```
  enabled(G) =
      { Add(a, s)        |  s ∈ N }                       (a: any fresh id — fresh ids are interchangeable)
    ∪ { Link(a->b)       |  a,b ∈ N,  a ≠ b,  a ≠ root,  (a,b) ∉ A,  ¬(b →⁺ a) }
    ∪ { Unlink(a||b)     |  (a,b) ∈ A }
    ∪ { Mutate(a): fresh |  a ∈ N }                       (content of a new class)
    ∪ { Mutate(a): revert|  a ∈ N,  fp(a) ≠ ⊥ }           (content = a's verified content — triggers Restore)
    ∪ { Verify(a) = r    |  a ∈ frontier(G),  r ∈ {valid, invalid} }
    ∪ { Doubt(a)         |  a ∈ N,  verdict(a) = valid }

  frontier(G) = { a ∈ N  |  verdict(a) ∈ {pending, invalid}  ∧  ∀p ∈ pred(a): solid(p) }
  ```

  `frontier(G)` — the verifiable frontier — is where verification can proceed right now: the natural worklist for an agent.

  `Mutate` forks into two actions because contents quotient by behavior: the kernel only ever compares contents by hash against live fingerprints (the Restore rule), so a content is either *fresh* (a new class — the verdict degrades and stays pending) or *equal to the recorded verified content* (Restore fires). The same quotient applies to `Add`: re-adding an id with the exact content some live fingerprint recorded for it is a distinct action from adding it with fresh content. With fresh ids interchangeable and contents quotiented, `enabled(G)` is finite, of size O(|N|²).

  ## Epistemic Operations
  The epistemic operations are the operation front: the only surface a human or agent operates. The admission criterion — an operation earns a name of its own iff its intention exceeds one atom's mechanics: its payload must be computed, or it spans multiple atoms under one decision. One basic operation with a freely supplied payload IS its own epistemic operation (renaming it would manufacture a distinction that does not exist). A move that contains a judgment step is not an operation at all but a pattern — judgments are performed, never bundled.

  The front has three tiers.

  Tier 1 — the 6 basic operations, as themselves. Each already carries exactly one decision:
  - `Add(a, b)` — articulate a new sub-task of b. The decision itself declares b's standalone verification insufficient (T1 is its meaning, not a side effect). Breaking a task into several parts is a sequence of Adds/Links — one decision each.
  - `Link(a->b)` — b reuses the existing claim a as a part. The act of recognition and sharing; the cycle rejection reads "b cannot rest on something that rests on b".
  - `Unlink(a||b)` — b shall no longer rest on a. The strictest reset case: a premise was revoked, and the kernel cannot know whether the judgment used it.
  - `Mutate(a)` — the claim now reads differently. The dual of Verify: content is authored, judgment is submitted.
  - `Verify(a) = r` — submit the judgment. One act; the result comes from the world, not the actor.
  - `Doubt(a)` — withdraw a judgment: the claim stands, the evidence is no longer trusted. The only honest reopening of a valid node.

  Tier 2 — computed-payload operations:

  ```
  Revert(a)  ≜  Mutate(a, c)        where c = a's content at its last Verify(a) = valid
  ```

  Enabled iff `fp(a) ≠ ⊥`. The kernel stores only the hash of the verified content, so the shell recovers the text `c` from the event chain. Supplying the exact verified content makes Restore fire (`Mutate(a): revert` in Enabled Actions); supplying anything else is an ordinary fresh Mutate — a wrong recovery is never unsound.

  Tier 3 — composite operations, one decision spanning several atoms:

  ```
  Discard(a)           ≜  Unlink(a||s) for every successor s of a
  Substitute(y: x→z)   ≜  Link(z->y);  Unlink(x||y)
  Merge(d→c)           ≜  Link(c->s) for each successor s of d (where absent);  then Discard(d)
  ```

  - Discard: "abandon this line of work" — a and its exclusive subtree drop by I3.
  - Substitute: "y rests on z instead of x" — linking first keeps y connected throughout; both T1 resets are the correct price of a swapped justification.
  - Merge: "d and c are the same claim" — every affected parent is T1-reset, so the sameness belief is audited by the verifications that follow, never smuggled past them. Rejected atoms (e.g. a link that would create a cycle) abort the remainder; the record shows the honest partial execution.

  Recorded history: every event on the chain remains an atom; an event dispatched as part of a Tier 2/3 operation carries a shell-attached marker naming that operation, so history reads at the level of decisions while the atoms stay inside the records for debugging. Markers are environment data — inert to the kernel, preserved by replay.

  What triggers Unlink: nothing inside the graph can. Node uselessness is structural (no path to root) and decidable, so I3 prunes nodes automatically; arc uselessness is semantic — invisible to the kernel — so it is only ever discovered on the epistemic plane: by a verifier auditing y's parts at Verify time, by re-articulation after a Mutate, by the composite operations, or by outside evidence such as code analysis. The prune pattern is `Unlink(x||y)` followed by `Verify(y) = valid` — its signature is readable directly from the history.

  Excluded by the criterion: `Prune` (contains a judgment — a pattern, above), `Reuse` (is Link), `Decompose`-of-one-part (is Add), `Refine`/`Split` (sequences of decisions, nothing computed, nothing bundled).

  ## Reachability (open conjecture)
  A state is reachable iff some operation sequence from a genesis graph produces it. Reachability is genesis-existential: the genesis root carries the state's root id, but its content is existentially quantified — the root's creation content is as free as an added node's. One direction is established by induction over the operations — every reachable state passes this candidate checklist (genesis passes it, and each operation preserves each condition):

  ```
  R1 (structure)      I1 ∧ I2 ∧ I3
  R2 (justification)  verdict(n) = valid  ⟹  fp(n) ≠ ⊥  ∧  fp_now(n) = fp_recorded(n)  ∧  ∀p ∈ pred(n): solid(p)
  R3 (bookkeeping)    fp(n) ≠ ⊥  ∧  fp(n).ownHash ≠ h(content(n))  ⟹  version(n) ≥ 1
  R4 (restore exhaustion)  fp(n) ≠ ⊥  ∧  fp_now(n) = fp_recorded(n)  ∧  ∀p ∈ pred(n): solid(p)  ⟹  verdict(n) ≠ pending
  R5 (honest records)      fp(n) ≠ ⊥  ⟹  root ∉ keys(fp(n).preds)  ∧  n ∉ keys(fp(n).preds)
  R6 (record order)        the record graph — m → k when k, itself fingerprinted, ∈ keys(fp(m).preds) —
                           is acyclic
  ```

  R4 and R5 were discovered by the builder work, exactly as the conjecture's failure modes promised — in both directions. R4 because Restore is eager: `PropagateSolid` leaves no restorable *pending* node unrestored. Its first, wider statement (`⟹ valid`, forbidding invalid too) was refuted by the explorer with a reachable counterexample: `Verify(n)=invalid` indeed never lands on a matching-fingerprint node (Restore steals it first as pending), but a *structural round-trip afterwards* — verify valid, add a part (T1 reopens, fingerprint kept), verify the part, verify invalid, unlink the part (the drop returns the pred set to the recorded shape) — re-matches the fingerprint while Restore's pending-only guard leaves `invalid` untouched. Invalid is a verdict with memory: no structural repair can silently lift it. R5 because a fingerprint is written at Verify from the then-current pred set, which never contains the root (I2 holds at all times) or the node itself (a self-arc is a cycle, I1).

  Conjecture (unproven in general): the converse — every state passing the checklist is reachable. The intended proof is a builder: an algorithm that constructs any checklist-passing state from genesis. Either failure mode is informative: a builder stuck on a passing state reveals a missing condition (a newly discovered invariant of the system, to be added to the checklist); a guided walk reaching a failing state reveals the checklist is too strict.

  The builder (`src/theory/synth.ts`) exists and constructs every tested target. Its load-bearing device is **re-incarnation**: dropping and re-adding an id resets its version to 0 while other nodes' fingerprint records of it persist, so any "serving" appearance (a node showing some content inside another node's record moment) can ride a throwaway incarnation at zero version cost — which refuted the natural "version budget" checklist candidate (R3 already covers the final incarnation's spend of at most one mutate).

  Why R6 holds — one unified theorem: **any cycle in the record graph is unreachable, matched or mismatched hashes alike.** Every final fingerprint has a unique last write; take the cycle member whose final record was written last, aₙ, at moment tₙ. The verify guard at tₙ needs the cycle-successor a₁ solid. R2 is an invariant of every reachable state, and at tₙ every other member's fingerprint is already final, so R2 chains around the cycle: a₁ valid ⟹ fp(a₁) matches now ⟹ pred(a₁) = {a₂} ∧ a₂ solid ⟹ … ⟹ aₙ solid — but then aₙ is already valid and the verify is refused; and if any member is non-valid the chain breaks and the guard itself fails. Withdrawing aₙ first (Doubt) T2-cascades the whole cycle to pending, leaving the restore dependencies circular with no leaf to start from. Either way the last record never lands. Two earlier, narrower proofs survive as corollaries: mismatched cycles also die by content contradiction (Restore pins a member to its own record content while its recorder saw another), and two-cycles also die by I1 (the restore arc and the record arc coexisting is a graph cycle). The matched two-cycle was long believed reachable by "arc flipping"; writing its witness as the intended reachable *control* refuted that belief, and the matched three-cycle — briefly held open — fell to the unified theorem.

  Machine verdicts (bounded exhaustion, `src/theory/__tests__/r6.test.ts`): on the path universe of two free ids, a frozen scaffolding id, and an inert root (lossless by I2 + R5) — 2,430,568 reachable states across both geneses — both two-cycle witnesses pass R1-R5 yet are never reached while the one-way stale-record control is reached; on the single-content universe of three free ids and no scaffolding (every hash h(X), which is what keeps three ids exhaustible) — 329,317 reachable states — the matched three-cycle is never reached while the acyclic three-chain of records is. In both universes every reached state passes R1-R6 — the condition forbids nothing reachable.

  Path universe vs target universe: reaching a target state can require scaffolding the target no longer shows — the R4 counterexample's history needs a temporary extra part, verified and unlinked away — so bounding the search to the target universe undercounts reachability. The explorer therefore walks a strictly larger path universe (an extra frozen scaffolding id: one content, never mutated, never given parts — pruning that costs no soundness, since every state a pruned search reaches is still genuinely reachable), and set equality is asserted over one syntactic domain: target states whose fingerprints also record only target ids (reached states legally carry fingerprints naming dropped scaffolding; the fwd direction covers them).

  Small-scope result (exhaustive): on the target universe of one pool id, a two-letter content alphabet, and versions ≤ 2 (117,306 syntactic states), BFS closure from every alphabet genesis over the scaffolded path universe reaches 69,168 states, all passing R1-R5 (fwd by exhaustion); within the shared domain, the R1-R5-passing set equals the reached set exactly, 2,376 states each. R1-R3 alone had admitted 36,306 unreachable target states, all violating R4 or R5; R4's first, wider statement was refuted by 42 reached states.

  Until settled in general, the checklist is safe only as a necessary-condition filter: failing it proves a state impossible; passing it proves nothing beyond the explored scope.

  Domain refinement (witnessed snapshots): fingerprints record hashes, not contents, so a checklist-passing snapshot may contain a stale fingerprint hash whose preimage is unknown — rebuilding that state would invert `h`, which is infeasible and possibly impossible (`h` is not known to be surjective). The conjecture is therefore stated over *witnessed* snapshots: every fingerprint hash in the state comes with a content preimage (`h` treated as a free constructor — collision-free, inverted only by exhibiting the witness). Nothing observable is excluded: every state that arises from a history is witnessed by the contents in that history.

  The explorer (built, `src/theory/explorer.ts`): BFS over concrete instantiations of `enabled(G)` from genesis, deduplicating states by canonical snapshot, bounded to a universe (id pool, content alphabet, version cap). It decides reachability by search for small graphs and tests the checklist from both sides — every reached state must pass (fwd, by exhaustion), every passing universe state must be reached (the converse, exactly, within the bounds). The small-scope result above is its output.

# Event
  The event mechanism is not part of the kernel. It is a layer around the kernel that records what happened as an event chain, for replay and analysis. It relies on the kernel's determinism: `apply` is a function — same graph, same operation, same result.

  ## Emission
  An event is the record of one applied operation. Events are named after their trigger, so there are exactly 6 event types, written in operation notation: `Add(A)`, `Link(A->B)`, `Unlink(A||B)`, `Mutate(A)`, `Verify(A)`, `Doubt(A)`.

  For compact display, each event also has a short notation:
  - `Add(A)`: `+A`
  - `Link(A->B)`: `A->B`
  - `Unlink(A||B)`: `A||B`
  - `Mutate(A)`: `A*`
  - `Verify(A)`: `A✓` when the result is valid, `A✗` when invalid
  - `Doubt(A)`: `A?`

  Propagation (verdict resets, solid flips, cascade drops, restore) is the deterministic consequence of the trigger inside the kernel — it does not emit events of its own.

  A rejected operation is not an event: it changed nothing. The rejection and its reason are returned to the caller (and may be logged separately by a shell for analysis).

  ## Event Chain
  Events form an append-only chain, like a blockchain: every event carries a sequence number assigned in application order and links to its predecessor event. The chain is the history of the graph — it is never reordered or rewritten, only appended to.

  ```
  chain = ⟨ e₁, e₂, …, e_k ⟩,      e_i = (seq: i,  prev: i−1,  op_i)
  ```

  (A shell may additionally hash-link entries for tamper evidence; the kernel-level requirement is only the total order.)

  ## Many sessions, one chain
  Several agents may hold the same chain file at once — two Claude Code sessions opened in one folder, a subagent beside its parent. Because the chain is append-only and every server writes the file on every operation, a server's in-memory chain is always a *prefix* of the file: catching up is a replay of the tail, never a merge. The shell therefore runs each operation as: take a lock on the file, replay whatever events appeared since this server last wrote, apply the operation against that caught-up graph, write atomically (temp file and rename), release. An operation that another session made illegal in the meantime — verifying a node they already verified, judging a part they just changed — is rejected by the kernel's own guards, which is the correct answer when someone else moved. A file whose prefix no longer matches (a `graph_new`) is reloaded whole. Nothing here touches the kernel; it is the persistence discipline of a shell that must never lose a judgment.

  Timestamps and other environment data are attached by the shell, outside the kernel — e.g. `via` markers naming the epistemic operation an atom was dispatched under, evidence citations recording the grounds of a judgment or a withdrawal, and **provenance** pinning a judgment to the code state its evidence was gathered against (git HEAD, content hashes of the cited artifacts). Environment data is inert to the kernel and preserved by replay. Provenance closes a blind spot the kernel has by design: fingerprints cover a claim's text and parts, never the code beneath it, so a change under a verified claim is invisible to Restore and to every trigger — only a shell audit comparing recorded and current artifact hashes can raise it, and it raises a prompt (Doubt), never a verdict.

  ## Snapshot and Replay
  A snapshot serializes the whole graph: nodes (id, content, version, verdict, fingerprint) and arcs. Solid is not serialized — it is recomputed on load, as are content hashes (recomputable from content). The fingerprint is serialized: it is history, not recomputable, and losing it would lose restorability across reload. Version is serialized as bookkeeping.

  A snapshot plus the events after it fully determine the graph:

  ```
  G₀ = fromSnapshot(S₀);    G_i = apply(G_{i−1}, op_i)    ⟹    G_k = current graph
  ```

  A consumer that wants to know what an event changed (e.g. UI coloring, dropped nodes) diffs the snapshots before and after the event.
