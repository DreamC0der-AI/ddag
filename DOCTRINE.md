# Operating Doctrine

DESIGN.md is the machine: what each operation does, what the kernel guarantees. This document is how to play it well: when and how the epistemic operations should be performed. DESIGN.md is normative about mechanics (is); this file is normative about practice (ought). Nothing here changes what the kernel accepts — a doctrine violation is legal; it is merely unwise.

Three kinds of "should" appear, and they are marked:
- **[law]** — already enforced by the kernel; stated for awareness, impossible to violate.
- **[policy]** — mechanically enforceable by a shell that chooses to (see Policy Hooks).
- **[judgment]** — the real doctrine: unenforceable, decisive.

# When to Open a Graph

Before any discipline of play comes the question the disciplines assume away: whether this work should be on a graph at all. **[judgment]**

**Open a graph when the work is claim-shaped: it decomposes into assertions whose verdicts are genuinely uncertain.** Theory with refutable sub-conjectures, designs whose assumptions may not survive contact, multi-session efforts whose settled/open state must outlive any one participant's memory. **Don't open one for execution-shaped work** — a feature to build, a bug to fix, a plan already believed — where every "claim" would be born certain and verified the moment the code lands. A graph of certainties is a decorated todo list: it records motion, not knowledge, and its cost is pure ritual.

The boundary is earned, not guessed — the same project ran both experiments: a pure feature build touched the graph not once and lost nothing; the reachability theory work ran graph-first and the graph paid three times, in its three verified functions:

- **Precommitment.** A claim written on the chain *before* the evidence runs pins the exact statement — when the machine rules, it refutes the recorded words, not a memory that would quietly soften ("I always meant the weaker version"). Write the falsifiable prediction into the Add's rationale; let the verify citation answer it. This is the graph's sharpest cognitive service, and it works only in that order.
- **Failure as a first-class record.** `Verify = invalid` and `Discard` turn refutations into structured, addressable facts with evidence attached — not commit-message asides. Cheap honest failure is the feature; use it.
- **Ground truth across sessions.** The chain survives what working memory does not — compaction, restarts, handoffs. Mid-effort, the frontier *is* the state of knowledge; trust it over recollection.

What the graph never does: suggest a discovery. Evidence and reasoning find; the graph binds. Expect it to work at the theorem grain — the micro-decisions inside one sitting stay off the record, and forcing them on is granularity abuse (D5 applies below the graph's floor too).

The self-test, applied while playing: a live graph shows **mid-task Adds** (structure discovered, not planned), **honest invalids and Doubts**, and mutate-then-re-verify cycles. A chain containing only planned-order add-then-verify-valid is the tell that the work was execution-shaped after all — close the graph without shame and record the lesson.

# The Game

The goal state is a solid root: the build target verified through its whole decomposition. The loop:

1. Look at the frontier — the nodes verifiable right now. It is the complete worklist **[law]**: nothing off the frontier can be judged, and everything needed eventually passes through it.
2. If the frontier has what you can judge, judge it (Verify). If a claim on the frontier is too large to judge directly, decompose it (Add / Link) — which moves the frontier down into its parts.
3. When the world or your understanding changes, restate claims (Mutate / Revert), withdraw stale judgments (Doubt), and restructure (Unlink / Substitute / Merge / Discard) — then repair by the cheapest sound route.

The economy, from Two Planes: **structure is cheap, judgment is scarce.** Every structural act at worst turns things pending; only Verify creates trust, and nothing counterfeits it. Play accordingly: explore structure freely, spend judgment deliberately, and never perform an operation whose purpose is to make something green without a judgment — the kernel makes that impossible, and doctrine adds: do not try.

# The Operations: when and when not

## Add(a, b) — articulate a new sub-task
**Reach for it when** b's claim is too large or compound to judge in one sitting; when judging b would require establishing something not yet tracked; when you understand a new requirement of b and want it on the record. **[judgment]**

**Don't** when an equivalent claim already exists — that is Link; duplicated claims split trust and must be verified twice, then drift. Don't articulate parts for decoration: every part is an obligation — it must become real and verified before b can be trusted again. And don't use Add to change what b means; that is Mutate, possibly alongside.

**Cost**: b and all its valid ancestors reopen (T1, T2). The new part is born on the frontier — the operation that creates work also points at it.

## Link(a->b) — reuse an existing claim as a part
**Reach for it when** the part b needs is already tracked — sharing is the point of the DAG: one verification serves every parent, and one invalidation warns them all. When decomposing, look for reuse before articulating. **[judgment]**

**Don't** when the claims merely look similar but assert different things — false sharing couples unrelated blast radii, and every parent inherits doubt whenever the shared node moves. The cycle rejection **[law]** reads: b cannot rest on something that rests on b.

**Cost**: b and its valid ancestors reopen. A reused part that is already solid brings b instant progress — reuse imports trust; articulation manufactures work.

## Unlink(a||b) — withdraw support
**Reach for it when** a verification audit found a superfluous, when restructuring b's justification, or as part of abandoning a line (Discard). **[judgment]**

**Don't** unlink to "fix" a broken part by disowning it: if b's code really depends on a, removing the arc does not remove the dependence — it makes the graph lie, and under-declaration is the one divergence that costs soundness (a change in a will no longer warn b). Repair the part or substitute it; don't erase it from the record.

**Cost**: the strictest reset — a premise was revoked and the kernel cannot know whether b's judgment used it **[law]**. Check the cascade before performing: an exclusive subtree drops entirely; shared nodes survive untouched (D2).

## Mutate(a) — the claim now reads differently
**Reach for it when** the claim is wrong, imprecise, or its scope changed. Restating claims is normal work, not failure. **[judgment]**

**Don't** mutate as a substitute for structural operations (moving a dependence is Link/Unlink, not editing the text), and don't mutate to force re-examination of an unchanged claim — mutating to identical content is an epistemic no-op (instant self-restore), and mutating to cosmetically different content pollutes the record. Reopening an unchanged claim whose *evidence* went stale is what `Doubt` is for.

**Cost**: the full blast radius — every ancestor reopens. Direct successors of the change need real re-verification (their fingerprints break); everything above them is restorable and heals as the boundary is re-judged. Read the underline forecast before mutating inside a large solid region.

## Verify(a) = r — submit the judgment
**Reach for it when** a is on the frontier and you have actually examined the evidence — tests, code, argument. A verdict is a record of an examination, never bookkeeping. **[judgment; evidence requirements are a policy hook]**

**How** — the verification audit, every time (see Disciplines): are the declared parts *real*, *load-bearing*, and *complete*? A Verify is also a dependency audit; it is the scheduled place where superfluous and missing arcs get caught.

Record invalid honestly. Red is information — "examined and found wrong" is worth more than an unexamined yellow, and invalid nodes remain re-verifiable after repair.

**A claim with parts rests on its parts.** Its judgment is "the parts hold and compose into this," so its evidence names the parts, not files: the parts carry their own pins, and a part's restatement reopens the node through its fingerprint. The audit reports such a judgment as *resting on parts*, not unwatched. Citing files on a group claim only makes every ancestor go stale whenever a leaf's code moves. (Found on the vault-cli record: the audit and target claims were re-anchored after every round because they cited nine files they never rested on — twenty ceremonial events over five rounds.)

**The audit says what changed, not only that something did.** A stale judgment's pin holds the commit; the audit shows the hunks since it, with the function or section each falls in, so a re-examination starts from "the only change in auth.rs is sanitize_label" rather than from a file name. (Found the same way: about 140 of 231 events were re-anchoring pairs whose evidence found that fact by hand.)

**A finding is recorded, not only judged.** When an audit, a review or a failing check finds something wrong, two things happen. The claim it refutes is judged invalid, with the finding as evidence — that is the graph's truth. And the finding itself is recorded as an *issue* on the chain (`issue_open`: a key such as AUTHZ-1, a title, the claim it concerns, a severity, and the full detail as written), because a red node that later turns green looks exactly like one that was never broken, and nobody reads the log. Issues are chain events inert to the kernel — the graph is unchanged by them — ordered with the operations, locked, fast-forwarded and replayed like them, and shown in one place: the dashboard's issue pane, the node's badge, the home card's count, `issue_list`, and the standing line's open count. A fix closes the issue (`issue_close`, outcome fixed, what changed and how it was checked) and re-verifies the claim; an accepted risk closes it as wontfix with the reason. Never add a "bug" node: arcs mean part-of, and a bug is not a part of correctness. (Found by the vault-cli audit: thirty-seven findings written in detail into docs/audit/*.md, invisible on the graph; and a first attempt that *derived* issues from invalid verdicts, refuted on sight — it listed a discarded spike as an issue while the real findings stayed in the documents.)

**A version is a record, not a commit.** Git holds every commit and no notion of which one concluded a working version; the chain holds every judgment and, with `version_mark`, when the project was a version: a name (v0.3), the commit it sits after, a note. What the version *was* — root solid or broken, issues open — is never stored; the chain at that mark bears it out or does not. Mark after the commit that concludes the version, not before: a mark on a dirty tree is allowed but warned, because then the commit alone does not identify the code. The mark itself lands in the next commit, which is fine — a version is a point in the record, and the record continues.

**One project, one chain.** Everything about a folder — its build, its audits, its fixes — goes on the folder's own chain. A sub-effort is a part of the root, never a second chain: two chains in one folder split the record the tool exists to keep in one place. (Found the same way: the audit had been started as a second chain, which surfaced on the dashboard as a second project with a "-2" suffix.)

**Cost**: none structurally. A valid result may restore a chain of ancestors for free — judgment spent at the blast-radius boundary is the highest-leverage act in the game.

## Doubt(a) — withdraw a judgment
**Reach for it when** the claim and its parts stand as written but the evidence behind the verdict is no longer trusted: code drifted under the claim, tests aged, the original examination lost your confidence. Doubt is the honest reopening — no cosmetic mutate, no structural wiggle. **[judgment]**

**Don't** doubt to declare a claim wrong — that is itself a judgment, and it takes two honest steps: `Doubt(a)`, then examine and `Verify(a) = invalid`. And don't doubt downward on suspicion: doubt the node whose evidence you distrust; its parts' judgments are their own decisions.

**Cost**: the doubted node needs one fresh judgment. Ancestors reopen but keep their fingerprints, so a *confirmed* doubt (re-verified valid) restores the whole tower in one wave — total price, one Verify. A *disconfirmed* doubt correctly holds everything above open. The fingerprint is cleared: after Doubt there is nothing for Restore to resurrect and nothing for Revert to return to — re-examination is the only way forward, which is the point.

## Reverify(a) — re-judge on today's evidence
**Reach for it when** a is valid, its claim still holds, and its evidence has aged: the audit says the files it cited changed since the judgment. One call records Doubt then Verify(valid) under the label Reverify(a), with fresh evidence and a fresh pin; ancestors reopen and restore within the call. **[judgment]**

**Don't** reverify a claim you now suspect: that is Doubt, then an honest Verify. Reverify asserts "examined again today, still true," and its evidence must say what was examined, like any verify. (Found on the vault-cli record: fourteen adjacent doubt-then-verify pairs, each saying the same thing twice — the intent was one act.)

## Refute(a) — withdraw a valid claim shown false
**Reach for it when** a finding — an audit, a failing test, a review — has shown a valid claim false. One call records Doubt then Verify(invalid) under the label Refute(a), with the finding as evidence and its pin; ancestors reopen and stay reopened until the claim is repaired and re-judged. Record the finding with `issue_open` too, so it has a lifecycle. **[judgment]**

**Don't** refute a claim that merely aged: that is Reverify if it still holds. Refute asserts "examined, and it is false." (Found on the vault-cli record: thirteen refutations each written as "doubt: reopening to record invalid" then "verify invalid" — one act in two operations.)

## Restructure(a) — a topic gets its properties
**Reach for it when** a claim is a topic — "crypto is sound", a criterion that names no method — and the audit protocol needs the properties it stands for. One call adds them as parts under a, each with its own criterion, labelled Restructure(a); a reopens through the kernel's own trigger and becomes a group resting on its parts. **[structure]**

**Don't** restructure a claim that already names its method; that is a property, and its parts, if any, come from Add in the ordinary way. (Found by the second protocol test: step 0 cost five separate adds and was skipped.)

## Revert(a) — back to the verified claim
**Reach for it when** a restatement didn't pan out and the previously verified claim was right after all. It is the cheapest repair that involves acting on the node: if the structure around a is unchanged, restoration is immediate and can cascade. **[judgment]**

**Don't** revert to make things green: Revert asserts "the old claim is the right claim," not "I prefer the old color." If the new claim is right and merely unverified, verify it.

## Discard(a) — abandon a line of work
**Reach for it when** a line of decomposition is a dead end, or as cleanup after Merge. Check first what actually drops: exclusive subtree goes, shared survivors keep their verdicts untouched (D2 at composite level). **[judgment; large discards are a policy hook]**

Nothing is lost from the record — the chain keeps the entire explored branch. Discard prunes the *present*, not the history; dead ends recorded honestly are part of the epistemic value.

## Substitute(y: x->z) — swap a justification
**Reach for it when** a better or already-established alternative exists for a part's role. Prefer it over bare Unlink-then-Link: it is one decision, it keeps y connected throughout, and it aborts whole on an illegal swap. **[judgment]**

**Cost**: y reopens; x drops if exclusive. Swapping back to an identical part later is free (Restore) — substitution is a reversible experiment.

## Merge(d->c) — these are the same claim
**Reach for it when** independent decomposition produced duplicates. Merge **early**: the cost is the reopened parents, and it only grows as more parents verify against the duplicate — dedupe before both copies accumulate trust. **[judgment]**

**Don't** merge near-duplicates whose claims genuinely differ: Merge asserts identity, and every parent will afterwards be judged against c's claim, not d's. When in doubt, it is not the same claim.

The sameness belief is audited, not trusted: every affected parent reopens and must be re-verified over c **[law]**.

# Auditing with the Graph

An audit is the most claim-shaped work there is: every line of it is an assertion whose verdict is genuinely uncertain. Yet the first five audits run with this tool ignored it — each produced a report, then used the graph as a scoreboard: topic nodes judged by "we read it", findings hung on them, and a new method invented every round because nothing said what the audit had to cover. The audit never had a definition of done. The protocol below is what the record asked for. **[judgment]**

**First, if an old-style audit already exists, restructure it.** A project audited by topic before the protocol has topic nodes judged by reading; do not continue them. `restructure` does it in one call per topic: under the topic node it adds the property claims it stands for, each with a method-level criterion, so the topic becomes a group resting on its parts. A claim whose criterion names no method is a topic. The chain's earlier rounds are not the protocol. (Found by the first test of this protocol: a fresh session on the vault-cli folder, which held five rounds of topic-shaped audit, ran a sixth the same way with the new tools, because "first write the tree" had no defined first step where a tree of the wrong shape already stood.)

**The audit is a subtree of the project's own chain**, under its target — one project, one chain. Its root is the claim in scope, with the attacker model in the text: "a stolen at-rest folder and a copy held by a revoked device are useless without the password and an enrolled Mac's Touch ID". Exclusions live in that text too; a wontfix lands on them.

**Decompose by property, not by topic.** "A revoked device cannot read the vault", never "authz". A topic cannot be false; a property can. Go down to the method boundary: a leaf's `Verify:` names the method that settles it — crash injection after every durable write, an interleaving of two mutating commands, a fuzz harness on the parser, a review of named functions — and the result that counts. Written this way the tree is the threat model, and its pending leaves are the audit plan. Decomposing by method is the step the five rounds skipped: each round *was* a method, discovered after the fact.

**Work the frontier bottom-up.** A property that holds is verified valid with evidence naming what was run and which files, so the judgment is pinned. A property shown false is refuted — one operation — and its finding recorded with `issue_open` on that claim, so the finding has a lifecycle. A finding always lands on the property it refutes, never on a group: the shells say so at the moment a finding or a refutation is recorded on a claim that has parts, and name the parts it should land on. A finding that fits no claim has found a missing property: add the claim, rationale "found by …", then refute it. Growth is visible and bounded by the tree, instead of arriving as a surprise round.

**Done is defined.** The root turns solid when every property has been judged by its stated method — not when the last round happened to be quiet. A method thought of later is a new leaf under its property; adding it reopens the root, which is the honest signal. Under this rule "solid" means "every named method has been run", and the residual risk is the methods nobody named, visible as an absence in a tree rather than as a feeling.

**The fixer never judges the fix.** About a third of the findings in rounds two to five were earlier fixes being incomplete or over-corrected, and a review of the round-two fixes found four at once. So the fixer closes the issue (`issue_close`, fixed, what changed and how it was checked) and an independent re-examination — a fresh subagent, or the auditor — reverifies the claim, citing what it re-ran. A claim re-verified by the hand that fixed it is the old way with a green label; the shell says so when a session verifies a claim whose issue it closed, and the evidence of a re-verification names the re-examination that made it.

**Stop rule.** A surface has converged when a fresh method on it finds nothing above Low. Until then the frontier says what to run next; after it, the tree says what was never named. Both answer "should we audit again?" with something a person can read.

**Self-test.** A healthy audit graph shows properties pending *before* any finding, refutes on specific claims, and additions for findings that fit none. A graph that grows only topic nodes after the report is written is a report with a scoreboard.

# Disciplines

**D1 — Work the frontier.** The frontier is the complete, kernel-guaranteed worklist. Scan it before every judgment session; if it is empty and the root is not solid, the graph is telling you something is invalid or missing — diagnose, don't wander.

**D2 — The verification audit.** At every Verify(y), three questions before the verdict: are the declared parts **real** (they exist beyond declaration)? **load-bearing** (y actually uses each — superfluous ⇒ prune pattern)? **complete** (nothing y really rests on is missing ⇒ Add/Link first, then judge)? The third question is the important one: a missing arc is the only divergence the kernel cannot warn about.

**D3 — Repair by the cheapest sound route.** When a region breaks, in order: (1) **wait** — solid-underlined nodes heal by Restore when their parts recover; acting on them wastes judgment; (2) **Revert** — if the change was wrong, the old claim returns and may cascade; (3) **re-Verify** — dashed-underlined and fresh nodes need real judgment, bottom-up from the blast boundary; (4) **restructure** — only when the justification itself was wrong. The underlines are this discipline rendered visible: dashed marks are the repair bill; solid marks are dominoes that fall on their own.

**D4 — Declaration bias.** Unsure whether b depends on a? Declare the arc. Over-declaration costs re-verification (noise); under-declaration costs soundness (silent stale trust). The audit (D2) prunes over-declaration later; nothing rescues under-declaration.

**D5 — Granularity: decompose to the evidence boundary, shaped by change.** Settled as five rules:

- *The "because" test (stop rule).* Write the claim's verification argument. Every "because" in it must point at **evidence** you can obtain or a **declared part**. A "because" pointing at an untracked claim is a part waiting to be articulated. No untracked "becauses" left — you hold a leaf; stop.
- *Claim and criterion, together.* A node's content is its claim plus the criterion that settles it ("Verify: …" — what evidence, and the prediction). Both are fingerprinted on purpose: changing what counts as proof reopens the judgment exactly as changing the claim does. The *why* — the node's role in its parent's argument — is deliberately not in the content: it lives on the Add's rationale, because rewording a reason must never reset a verdict. Shells render all three (claim, criterion, because) plus the last judgment from the node's view, so the node reads whole without walking the history.
- *Rationale on the record.* Structural decisions accept a rationale (recorded on the chain event as environment data, like evidence on judgments) — a split's reasoning travels with its Adds. A deliberate no-split leaves no event, so its reasoning has one honest home: the verify citation, which should enumerate a lumped conjunction's parts and their shared fate.
- *The conjunction tiebreaker.* The because-test is silent on a claim whose becauses all terminate directly in evidence but number more than one — a conjunction of independently-evidenced facts. Split when the parts' evidence has **different fates**: different arrival times, different aging, different owners — separate fates deserve separate nodes, so each can be judged, invalidated, and healed on its own schedule. Lump when they share one verifier, one sitting, one fate — structure that will always be judged together and then settle earns nothing. (Earned by the `usage` workstream: two parts' evidence existed immediately, the third's only after a restart — a lumped claim sat wholly yellow while two-thirds proven.)
- *Judge-relative.* "Directly verifiable" means by the judge who will actually verify it, with evidence they can actually obtain — a claim has no intrinsic grain. For agent shells: a leaf ≈ one task, one test run, one review session. And frontier width is available parallelism — decomposition is also how parallel work is manufactured.
- *Churn-adaptive.* Fine structure localizes blast radius (only the direct successors of a change need fresh judgment; everything above restores); coarse structure makes every change a full re-judgment. Decompose finely where change is expected; let settled, verified regions stay chunky. Decomposition on demand, as work approaches — not upfront completeness.
- *Depth over width.* A parent with many parts is a conjunction: Verify needs all of them solid at once, and any part-set churn reopens it. Depth is nearly free — intermediate layers are restorable, and a healed leaf cascades up the spine — while width is conjunctive fragility. The width test: if the parts' joint sufficiency cannot be stated in one argument, the parent is too wide — introduce intermediate grouping claims.
- *Descriptive decomposition mirrors reality.* When recording existing code, the grain follows the real module boundaries. This is D4's honesty extended from arcs to shape: invented groupings that exist in no code make the graph lie structurally even when every arc is individually true — and the D2 audit at Verify time can then never reconcile the graph against anything real.

**D6 — Read the blast radius before you swing.** Before mutating or restructuring inside a solid region, forecast: which nodes reopen, which are restorable (◆-class), which will demand fresh judgment (◇-class)? Structure is cheap, but structure that burns accumulated judgment is not. The forecast is computable from fingerprints — a shell can display it.

# Patterns and their history signatures

The chain records atoms and markers; intentions read off as patterns:

- **Prune**: `Unlink(x||y)` then `Verify(y)=valid` — a dependence audited away.
- **Reversible experiment**: `Substitute(y: x->z)` … later the mirror swap with identical content, closing with Restore and **zero verify events** — an exploration that cost nothing permanent.
- **Refactor under a stable claim**: structural operations with no Mutate of the parent, ending in re-verifies of the touched boundary only — the target's meaning never moved.
- **Deepen**: Add under a frontier leaf, then verifies climbing back up.
- **Honest dead end**: an articulated cluster followed by `Discard` — exploration on the record, pruned from the present.

# Policy Hooks

The enforceable subset — shells adopt per taste; the kernel-truth of the menu is never altered, only the shell's willingness:

- **P1 — No trivial win**: refuse Verify(root) while the root is undecomposed. *Implemented*: the simulator's draw policy, and the MCP shell refuses the verify outright; the ordering view in both shells leaves a bare root out of the ranking rather than advertising it as the winning move. (Found by the roguelike case: a fresh graph's standing line read "roguelike (WINS — root turns solid)".)
- **P2 — Evidence required**: a Verify must cite evidence (test run, review note) before the shell forwards it. Natural fit for agent shells. *Implemented*: the MCP shell requires an evidence citation on verify and records it on the chain event as environment data (like `via`); doubt accepts an optional citation of why trust was withdrawn. The chain layer itself stays policy-free — evidence is available to any shell, mandated by this one.
- **P3 — Big-discard confirmation**: a Discard whose cascade exceeds N nodes requires explicit confirmation, with the drop list shown.
- **P4 — Audit prompt**: at Verify time, surface D2's three questions (and the parts list) to the judge.
- **P5 — Evidence provenance**: pin every judgment to the code state its evidence was gathered against — git HEAD and content hashes of the artifacts the evidence cites — and offer an audit that lists valid judgments whose artifacts changed since. *Implemented*: the MCP shell records provenance on each verify (paths mentioned in the evidence are pinned automatically; `artifacts` pins explicitly) and `graph_audit` reports STALE? judgments. This is the mechanical prompt for Doubt that D3 was missing: fingerprints never see code, so without it a tuning pass under green claims leaves the graph green and the evidence silently stale. (Found by the roguelike case: four balance-tuning rounds changed the stat table under `combat`, `items` and `loop` while their verdicts stayed green.) A judgment that cites no artifacts is reported as *unwatched*, not intact — an empty pin must never read as a passed audit — and bare file names are resolved by basename when unique, reported when ambiguous. The audit prompts; it never judges. The dashboard shows it where the work is watched: a valid node whose cited files changed or vanished carries a `!` marker on the graph and a plain audit line in its detail panel, and the home page counts each project's stale judgments — the same audit function behind `graph_audit`, so the text and the picture cannot disagree.

# Open Questions

None currently open.

*(O1 — granularity — resolved into D5's settled form: the "because" test, judge-relativity, churn-adaptive grain, depth-over-width, descriptive mirroring. O2 — reopening a valid claim whose world changed — resolved by adopting `Doubt` as the sixth basic operation; see its sections here and in DESIGN.md.)*
