import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { discard, merge, refute, restructure, revert, reverify, substitute } from '../chain/epistemic'
import { composeClaim, parseClaim } from '../chain/claim'
import { collectProvenance, gitState } from './provenance'
import { chainPathWithin } from './containment'
import { Registry } from './registry'
import { McpStore } from './store'

/**
 * The Decompose DAG agent tool: the epistemic operation front served over MCP.
 * Tool list = the front (DESIGN.md "Epistemic Operations"); tool descriptions
 * carry the doctrine (DOCTRINE.md). The kernel stays deterministic — the
 * chain file is the complete, replayable history.
 */

const INSTRUCTIONS = `Decompose DAG — an epistemic scaffold for verified decomposition of a build target.

WHEN TO OPEN A GRAPH: use this tool for claim-shaped work — assertions whose verdicts are genuinely uncertain (theory with refutable sub-conjectures, designs whose assumptions may fail, multi-session efforts whose settled/open state must outlive memory). Do NOT graph execution-shaped work (a feature to build, a plan already believed): every claim would be born certain, and the chain degrades into a decorated todo list. Write the falsifiable prediction into an add's rationale BEFORE the evidence runs — the chain pins the exact statement, so a refutation lands on the recorded words, not on a memory that would soften. Record refutations as verify=invalid (+ discard for dead ends); they are first-class knowledge. The self-test: a healthy chain shows mid-task adds, honest invalids, and mutate-then-re-verify cycles — a chain of only planned-order add-then-verify-valid means the work was execution-shaped after all.

AUDITING — an audit is a claim graph, not a report. When asked to audit, follow this checklist in order; the chain's earlier rounds are not the protocol, even if they were done another way:
0. If the project already has an audit decomposed by TOPIC ("crypto is sound", "authz is correct"), restructure before examining anything: call restructure on each topic node with the PROPERTY claims it stands for, each with a Verify: that names the method — one call per topic; the topic becomes a group resting on its parts. Never open a finding on a topic. A claim whose Verify: names no method (no test, fuzz, injection, interleaving or named review) is a topic.
1. Root: one claim in scope with the attacker model in its text and the exclusions stated ("a stolen folder is useless without both factors; out of scope: another user on the same machine"). In the project's own chain, under its target.
2. Decompose by PROPERTY, never by topic ("a revoked device cannot read the vault", not "authz"), down to the method that settles each leaf: the leaf's Verify: names the method (crash injection after every write; an interleaving test; a fuzz harness; a review of named functions; a walkthrough through the real interface by a session without the source) and the result that counts. Write the whole tree BEFORE reporting any finding — the pending leaves are the audit plan.
3. Work the frontier bottom-up. A property that holds: verify it valid, citing what was run and the files. One shown false: verify it invalid (refute it, if it had already been judged valid), then issue_open the finding on that property — a finding always lands on the property it refutes, never on a group.
4. A finding that fits no claim reveals a missing property: add the claim (rationale: "found by …"), then refute it. Growth is visible and bounded by the tree.
5. The fixer never re-verifies its own fix: after issue_close, an independent re-examination (a fresh subagent, or the auditor) reverifies the claim, citing what it re-ran. The shell says so when a session verifies a claim whose issue it closed.
6. Done: the root is solid only when every property has been judged by its stated method. A method thought of later is a new leaf, and the root reopening is the honest signal, not a surprise round. Stop rule: a surface has converged when a fresh method on it finds nothing above Low; what remains is the methods not in the tree, visible as absence.

THE GAME: the root node is the build target. Decompose it into sub-claims (arcs point part -> whole), verify claims bottom-up against evidence, and win when the root turns solid. The frontier — nodes whose parts are all solid — is your complete worklist; nothing off it can be judged.

TWO PLANES: structure (add/link/unlink) settles nothing and can only reopen doubt; judgment (verify) is the only source of trust. Structure is cheap; judgment is scarce — spend it at the blast-radius boundary and let Restore cascade the rest.

DISCIPLINES:
- Work the frontier, bottom-up (enforced).
- At every verify, audit the parts: real? load-bearing (else unlink — prune)? complete (else add/link first)? A missing dependence is the one divergence the graph cannot warn about — when unsure, declare the arc.
- Repair cheapest-first: wait for Restore (intact nodes heal on their own) > revert > re-verify > restructure.
- Decompose to the evidence boundary and stop: every "because" in a claim's verification argument must point at evidence or a declared part. Prefer deep narrow structure over wide conjunctions. Decompose finely where change is expected; mirror real code structure when recording what exists.
- Verify only after actually examining evidence; record invalid honestly. Reopen a stale-but-unchanged claim with doubt, never with a cosmetic mutate.
- Every verify is pinned to the code state (git HEAD + hashes of the files it cites — mention paths in the evidence or pass artifacts). A claim WITH PARTS rests on its parts: cite the parts in its evidence, not files, so a code change under a leaf does not also stale every ancestor; the audit reports such a node as resting on parts. The standing line says "Stale: N" whenever judgments rest on code that changed since; graph_audit names them and shows what changed since each pin (hunks with their function names) — read that before re-examining. A stale judgment whose claim still holds is re-judged in one call with reverify; a valid claim a finding has shown false is withdrawn and judged in one call with refute. Verifying the root over stale judgments is allowed but warned. Fingerprints never see code; this does.
- When every issue on an invalid claim is closed, the standing line lists it as ready to re-verify — the fix is in, the judgment is not.
- Findings are recorded, not just judged: when an audit, a review or a failing check finds something wrong, issue_open records it with its full detail (key, title, severity, the claim it concerns) so it shows on the dashboard's issue pane; judge the refuted claim invalid as well. A fix closes the issue (issue_close, outcome fixed, what changed) and re-verifies the claim. Never add a "bug" node — a bug is not a part of correctness. issue_list is the fixer's worklist; the standing line counts open issues.
- A working version is a record too: after the commit that concludes it, version_mark names it (v0.3) with a note; version_list shows every version with what the chain said of it then. Mark after committing, not before.
- A target that ships has two standing parts besides its build, added PENDING at decomposition time and written into the root's own criterion: an audit decomposed by property (AUDITING above), and a WALKTHROUGH — "a new user with only the README can do everything the README says". Verifying the root over their absence verifies "built", not "done"; their pending leaves on the frontier are the honest signal.
- READ ONE CLAIM, NOT THE LOG: before re-judging a claim, graph_history {node} gives its own chain in a few lines; why {id} says what broke it; graph_history {since: N} catches up from the position the last standing line ended with ("at #N").
- ROUNDS: after a change that stales several judgments, round_record it ONCE (what moved, how it was checked), then reverify each claim with round: <key> and ONE sentence about that claim, passing artifacts with the files THAT claim rests on — never the round's file list, never a shared paragraph. Explicit artifacts are the whole pin set; a claim with parts pins none.
- TARGETS: one chain, one main target (graph_new), and sub-targets for pipelines that consume the build rather than belong to it (publish, deploy) — target_new, target_switch, target_list. A sub-target is never a part of the main target: its wait must not read as the build being broken. A claim is judged in one home target and only used, by link, in another.
- WALKTHROUGH: a claim, not a mechanism. The group is the README promise; each journey a real user takes is a leaf (install from a clean clone; first project to a solid root; a change that goes stale; an audit by the protocol; an issue opened and closed; a version marked), plus one leaf per tool or panel the journeys do not reach. Each leaf's Verify: names the observed outcome that counts. The tester session has NO source access, uses only the real interface (the tool over stdio, the dashboard, the binary) in a clean folder, and records: a journey that works is verified valid with the transcript written to a file and cited as evidence; one that breaks is refuted and issue_open records the exact steps and output; confusing-but-works is an issue at Low. The tester never fixes. Its workload is its own project with its own chain; the judgments go on the product's chain.
- One project, one chain: everything about a folder — its build, its audits, its fixes — goes on the folder's ddag.json. Do not graph_new or graph_open a second chain for a sub-effort; add the sub-effort as a part of the root.
- The root cannot be verified while undecomposed (P1) — decompose first.
- A node's content is its claim plus, after "Verify:", the criterion that settles it (pass \`verify\` on add/mutate/graph_new). Both are fingerprinted: changing what counts as proof reopens the judgment. The "why" stays on the add's rationale.
- Write evidence for a reader who was not there: outcome first, in plain words; numbers second; file paths so the judgment is pinned. No private shorthand.`

/**
 * A finding or a refutation on a claim that has parts is the old way — a
 * report hung on a topic. The nudge names the property the finding should
 * land on, at the moment it is being recorded (PROTO-1).
 */
function groupNudge(store: McpStore, id: string, what: 'finding' | 'refutation'): string | null {
  const g = store.graph
  if (!g.has(id)) return null
  const parts = g.predecessors(id)
  if (parts.length === 0) return null
  return `Protocol: ${id} is a group with ${parts.length} part(s) (${parts.slice(0, 5).join(', ')}${parts.length > 5 ? ', …' : ''}). A ${what} belongs on the property it refutes, not on the group — if one of the parts is that property, ${what === 'finding' ? 'open the issue there' : 'refute it instead'}; if none is, add the missing property under ${id} with a Verify: that names the method, then ${what === 'finding' ? 'open the issue on it' : 'refute it'}.`
}

/** A node with parts rests on them: no artifacts cited is the right pin there, not a warning. */
function partsAware(warnings: string[], parts: number, artifacts: number): string[] {
  if (parts === 0 || artifacts > 0) return warnings
  return warnings.filter((w) => !w.startsWith('0 artifacts pinned'))
}

export function buildServer(store: McpStore, opts: { chainRoot?: string } = {}): McpServer {
  const chainRoot = resolve(opts.chainRoot ?? process.cwd())
  const server = new McpServer(
    { name: 'ddag', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )

  const text = (r: { ok: boolean; text: string }) => ({
    content: [{ type: 'text' as const, text: r.text }],
    isError: !r.ok,
  })
  // a claim without a criterion is legal but unfinished: say so, like a 0-artifact pin
  const withCriterionNote = (r: { ok: boolean; text: string }, verify: string | undefined, content?: string) =>
    text(
      r.ok && !verify && !(content && parseClaim(content).criterion)
        ? { ...r, text: `${r.text}\nNote: no verification criterion recorded — say how this claim will be judged (the \`verify\` parameter); the criterion is fingerprinted with the claim` }
        : r,
    )
  const VERIFY_PARAM = z
    .string()
    .optional()
    .describe(
      'how this claim will be judged: what evidence settles it, and the prediction — stored after "Verify:" in the content and fingerprinted with the claim, so changing what counts as proof reopens the judgment',
    )

  server.registerTool(
    'add',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Add — articulate a new sub-task',
      description:
        'Create a new claim as a part of an existing node (arc new->successor). Use when a claim is too large to verify directly, or a new requirement must go on the record. The successor and its valid ancestors reopen (pending) — that is the meaning of decomposing, not a side effect. Do not add a duplicate of an existing claim (use link to reuse it). Omit id to auto-mint one.',
      inputSchema: {
        content: z.string().describe('the claim text of the new sub-task'),
        successor: z.string().describe('the node this new part supports'),
        id: z.string().optional().describe('node id; auto-minted when omitted'),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
        verify: VERIFY_PARAM,
      },
    },
    async ({ content, successor, id, rationale, verify }) => {
      store.refresh()
      const out = store.notInCone(successor, 'successor')
      if (out) return text({ ok: false, text: out })
      return withCriterionNote(
        store.dispatch({ type: 'add', id: id ?? store.mintId(), content: composeClaim(content, verify), successor }, rationale),
        verify,
        content,
      )
    },
  )

  server.registerTool(
    'link',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Link — reuse an existing claim as a part',
      description:
        'Declare that b rests on the already-tracked claim a (arc a->b). Prefer over re-articulating duplicates: one verification then serves every parent. Rejected if it would create a cycle (circular justification). b and its valid ancestors reopen. A reused part that is already solid brings instant progress.',
      inputSchema: {
        from: z.string().describe('the existing part (a)'),
        to: z.string().describe('the node that reuses it (b)'),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
      },
    },
    async ({ from, to, rationale }) => {
      store.refresh()
      if (to === store.project()) return text({ ok: false, text: 'Refused: targets are added with target_new, not by linking to the project node' })
      const out = store.notInCone(to, 'whole')
      if (out) return text({ ok: false, text: out })
      return text(store.dispatch({ type: 'link', from, to }, rationale))
    },
  )

  server.registerTool(
    'unlink',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Unlink — withdraw support',
      description:
        'Remove arc a->b: b no longer rests on a. The strictest reset — a premise was revoked. Nodes losing their last path to root drop, cascading (exclusive subtrees vanish; shared survivors are untouched). Never unlink to hide a real code dependence — an undeclared dependence is the one unsoundness the graph cannot warn about. Pruning a superfluous part is: unlink, then verify(b) to confirm.',
      inputSchema: {
        from: z.string().describe('the part being withdrawn (a)'),
        to: z.string().describe('the node it supported (b)'),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
      },
    },
    async ({ from, to, rationale }) => {
      store.refresh()
      if (to === store.project()) return text({ ok: false, text: `Refused: "${from}" is a target — a target is not unlinked from the project node` })
      const out = store.notInCone(to, 'whole')
      if (out) return text({ ok: false, text: out })
      return text(store.dispatch({ type: 'unlink', from, to }, rationale))
    },
  )

  server.registerTool(
    'mutate',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Mutate — the claim now reads differently',
      description:
        'Replace a node\'s claim text. Its verdict resets unconditionally and every valid ancestor reopens; direct successors will need fresh verification, higher ancestors become restorable. Use for real restatements only — for "evidence went stale but the claim is unchanged" use doubt; to undo a restatement use revert.',
      inputSchema: {
        id: z.string(),
        content: z.string().describe('the new claim text'),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
        verify: VERIFY_PARAM,
      },
    },
    async ({ id, content, rationale, verify }) => {
      store.refresh()
      const out = store.notHome(id)
      if (out) return text({ ok: false, text: out })
      return withCriterionNote(store.dispatch({ type: 'mutate', id, content: composeClaim(content, verify) }, rationale), verify, content)
    },
  )

  server.registerTool(
    'verify',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Verify — submit a judgment',
      description:
        'Record the outcome of actually examining a claim against evidence (tests, code, argument) — never bookkeeping. The evidence citation is REQUIRED (doctrine hook P2) and is recorded on the chain event as the judgment\'s grounds — cite what was actually examined ("vitest run testbed: 16 passed", "reviewed against CommonMark §4.1"). Only frontier nodes (all parts solid, verdict pending/invalid) are verifiable. Before submitting, audit the parts: real, load-bearing, complete. Record invalid honestly — red is information. A valid result may Restore a chain of ancestors for free. WRITE THE EVIDENCE FOR A READER WHO WAS NOT THERE: first sentence = what was examined and what it showed, in plain words; then the numbers; pass the files the claim rests on as artifacts (they pin the judgment). No private shorthand, version tags, or doctrine labels.',
      inputSchema: {
        id: z.string(),
        result: z.enum(['valid', 'invalid']).describe('what the examination found'),
        evidence: z
          .string()
          .min(1)
          .describe('what was examined — the grounds of this judgment, recorded on the chain'),
        artifacts: z
          .array(z.string())
          .optional()
          .describe(
            'the files or directories THIS claim rests on (paths under the project root), pinned by content hash so graph_audit can tell when they change. When given, they are the whole pin set. Without them, a leaf falls back to the paths its evidence names; a claim with parts pins nothing and rests on its parts',
          ),
        round: z.string().optional().describe('the key of the round_record this judgment cites — the change is described there once; the evidence here is one sentence about this claim'),
      },
    },
    async ({ id, result, evidence, artifacts, round }) => {
      store.refresh() // judge the caught-up graph: another session may have decomposed since
      const g = store.graph
      const home = store.notHome(id)
      if (home) return text({ ok: false, text: home })
      if (id === store.target() && g.predecessors(id).length === 0) {
        return text({
          ok: false,
          text: 'Refused (doctrine P1, no trivial win): the root is undecomposed — verifying it bare would end the game without a single part on the record. Add its parts first.',
        })
      }
      const { provenance, warnings: raw } = collectProvenance(evidence, artifacts ?? [], store.root, store.file, { group: g.has(id) && g.predecessors(id).length > 0 })
      const warnings = partsAware(raw, g.has(id) ? g.predecessors(id).length : 0, provenance.artifacts.length)
      const staleBelow = id === store.target() && result === 'valid' ? store.staleCount() : 0
      const nudge = result === 'invalid' ? groupNudge(store, id, 'refutation') : store.selfFixNudge(id)
      const r = store.dispatch({ type: 'verify', id, result }, evidence, provenance, round)
      if (r.ok && nudge) r.text += `\n${nudge}`
      if (r.ok && warnings.length > 0) r.text += `\nProvenance: ${warnings.join('; ')}`
      if (r.ok && staleBelow > 0)
        r.text += `\nAudit: ${staleBelow} judgment(s) beneath the root rest on code that changed since they were made — this root stands on them; reverify them before trusting it.`
      return text(r)
    },
  )

  server.registerTool(
    'refute',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Refute — withdraw a valid claim shown false',
      description:
        'The mirror of reverify: a finding (an audit, a failing test, a review) has shown a valid claim false. One call withdraws the judgment and records the refutation — Doubt then Verify(invalid) under the label Refute(a) — with the finding as evidence and its pin. Ancestors reopen and stay reopened until the claim is repaired and re-judged. Record the finding itself with issue_open as well, so it has a lifecycle. For a claim that is pending or already invalid, use verify.',
      inputSchema: {
        id: z.string(),
        evidence: z.string().min(1).describe('the finding — what was examined and what showed the claim false, for a reader who was not there'),
        artifacts: z.array(z.string()).optional().describe('the files or directories the finding rests on; when given, they are the whole pin set — without them a leaf falls back to the paths its evidence names, and a claim with parts pins nothing'),
        round: z.string().optional().describe('the key of the round_record this judgment cites — the change is described there once; the evidence here is one sentence about this claim'),
      },
    },
    async ({ id, evidence, artifacts, round }) => {
      store.refresh()
      const home = store.notHome(id)
      if (home) return text({ ok: false, text: home })
      const { provenance, warnings: raw } = collectProvenance(evidence, artifacts ?? [], store.root, store.file, { group: store.graph.has(id) && store.graph.predecessors(id).length > 0 })
      const warnings = partsAware(raw, store.graph.has(id) ? store.graph.predecessors(id).length : 0, provenance.artifacts.length)
      const nudge = groupNudge(store, id, 'refutation')
      const r = store.perform((chain) => refute(chain, id, evidence, provenance, round))
      if (r.ok && warnings.length > 0) r.text += `\nProvenance: ${warnings.join('; ')}`
      if (r.ok && nudge) r.text += `\n${nudge}`
      return text(r)
    },
  )

  server.registerTool(
    'restructure',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Restructure — give a topic-shaped claim its property parts',
      description:
        'Step 0 of the audit protocol in one call: under a claim that was decomposed by topic ("crypto is sound"), add the PROPERTY claims it stands for ("a revoked device cannot read the vault"), each with a Verify: that names the method that settles it. The topic becomes a group resting on its parts and reopens until they are judged. All-or-nothing: refused before anything is written if the node is missing or a part id exists. Findings then land on the properties, never on the topic.',
      inputSchema: {
        node: z.string().describe('the topic-shaped claim to decompose'),
        parts: z
          .array(
            z.object({
              id: z.string().min(1),
              claim: z.string().min(1).describe('the property, as a falsifiable statement'),
              verify: z.string().min(1).describe('the method that settles it and the result that counts'),
              rationale: z.string().optional().describe('why this property, e.g. "found by round 3"'),
            }),
          )
          .min(1),
      },
    },
    async ({ node, parts }) => {
      store.refresh()
      const out = store.notHome(node)
      if (out) return text({ ok: false, text: out })
      const r = store.perform((chain) =>
        restructure(
          chain,
          node,
          parts.map((p) => ({ id: p.id, content: composeClaim(p.claim, p.verify), ...(p.rationale !== undefined ? { rationale: p.rationale } : {}) })),
        ),
      )
      return text(r)
    },
  )

  server.registerTool(
    'reverify',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Reverify — re-judge a valid claim on today\'s evidence',
      description:
        'For a valid claim whose evidence has aged (graph_audit or the standing line says its artifacts changed) while the claim itself still holds: one call withdraws the old judgment and records a fresh one with new evidence and a new pin — Doubt then Verify under the label Reverify(a). Ancestors reopen and restore within the same call. Not for a claim you now think is wrong: doubt it, then verify it invalid. Evidence is required and is written for a reader who was not there, like any verify.',
      inputSchema: {
        id: z.string(),
        evidence: z.string().min(1).describe('what was examined today — the grounds of the fresh judgment, recorded on the chain'),
        artifacts: z.array(z.string()).optional().describe('the files or directories THIS claim rests on; when given, they are the whole pin set — without them a leaf falls back to the paths its evidence names, and a claim with parts pins nothing'),
        round: z.string().optional().describe('the key of the round_record this judgment cites — the change is described there once; the evidence here is one sentence about this claim'),
      },
    },
    async ({ id, evidence, artifacts, round }) => {
      store.refresh()
      const home = store.notHome(id)
      if (home) return text({ ok: false, text: home })
      const { provenance, warnings: raw } = collectProvenance(evidence, artifacts ?? [], store.root, store.file, { group: store.graph.has(id) && store.graph.predecessors(id).length > 0 })
      const warnings = partsAware(raw, store.graph.has(id) ? store.graph.predecessors(id).length : 0, provenance.artifacts.length)
      const selfFix = store.selfFixNudge(id)
      const r = store.perform((chain) => reverify(chain, id, evidence, provenance, round))
      if (r.ok && warnings.length > 0) r.text += `\nProvenance: ${warnings.join('; ')}`
      if (r.ok && selfFix) r.text += `\n${selfFix}`
      return text(r)
    },
  )

  server.registerTool(
    'doubt',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Doubt — withdraw a judgment',
      description:
        'The honest reopening of a valid node whose evidence went stale (code drifted, tests aged) while the claim itself is unchanged. Verdict returns to pending and the fingerprint is cleared — nothing can resurrect the withdrawn judgment; re-examination is the only way forward. Ancestors reopen but stay restorable: a confirmed doubt costs exactly one re-verification. To declare a claim wrong: doubt, then verify invalid. Optionally cite why the old evidence is no longer trusted — recorded on the chain.',
      inputSchema: {
        id: z.string(),
        evidence: z.string().optional().describe('why trust was withdrawn (recorded on the chain)'),
      },
    },
    async ({ id, evidence }) => {
      store.refresh()
      const out = store.notHome(id)
      if (out) return text({ ok: false, text: out })
      return text(store.dispatch({ type: 'doubt', id }, evidence))
    },
  )

  server.registerTool(
    'revert',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Revert — back to the verified claim',
      description:
        'Restore a node\'s content to the text it carried at its last valid verification (recovered from the chain). Use when a restatement did not pan out — it asserts "the old claim was right", not "I prefer the old color". If structure is unchanged the verdict restores instantly and may cascade.',
      inputSchema: {
        id: z.string(),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
      },
    },
    async ({ id, rationale }) => {
      store.refresh()
      const out = store.notHome(id)
      if (out) return text({ ok: false, text: out })
      return text(store.perform((chain) => revert(chain, id, rationale)))
    },
  )

  server.registerTool(
    'discard',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Discard — abandon a line of work',
      description:
        'Unlink every out-arc of a node: it and its exclusive subtree drop; shared survivors keep their verdicts untouched. Check the blast first. Nothing is lost from the recorded history — discard prunes the present, not the past.',
      inputSchema: {
        id: z.string(),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
      },
    },
    async ({ id, rationale }) => {
      store.refresh()
      if (store.targets().includes(id)) return text({ ok: false, text: `Refused: "${id}" is a target — targets live on; discard the claims under it instead` })
      const out = store.notHome(id)
      if (out) return text({ ok: false, text: out })
      return text(store.perform((chain) => discard(chain, id, rationale)))
    },
  )

  server.registerTool(
    'substitute',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Substitute — swap a justification',
      description:
        'y rests on z instead of x, as one decision: link z->y then unlink x->y (link first keeps y connected; an illegal swap aborts whole). y reopens; x drops if exclusive. Swapping back to identical content later is free (Restore) — substitution is a reversible experiment.',
      inputSchema: {
        y: z.string().describe('the node whose justification is being swapped'),
        x: z.string().describe('the part being swapped out'),
        z: z.string().describe('the part being swapped in'),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
      },
    },
    async ({ y, x, z: zz, rationale }) => {
      store.refresh()
      const out = store.notInCone(y, 'whole')
      if (out) return text({ ok: false, text: out })
      return text(store.perform((chain) => substitute(chain, y, x, zz, rationale)))
    },
  )

  server.registerTool(
    'merge',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Merge — these are the same claim',
      description:
        'Canon takes over every role of dup, then dup is discarded. Merge duplicates EARLY — the cost (reopened parents) only grows as both copies accumulate trust. The sameness belief is audited, not trusted: every affected parent reopens and is re-judged against canon. When in doubt whether two claims are really the same, they are not.',
      inputSchema: {
        dup: z.string().describe('the duplicate to merge away'),
        canon: z.string().describe('the canonical claim that takes over'),
        rationale: z.string().optional().describe('why this decision — recorded on the chain'),
      },
    },
    async ({ dup, canon, rationale }) => {
      store.refresh()
      const out = store.notHome(dup) ?? store.notHome(canon)
      if (out) return text({ ok: false, text: out })
      return text(store.perform((chain) => merge(chain, dup, canon, rationale)))
    },
  )

  server.registerTool(
    'graph_state',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Graph state',
      description:
        'The graph as a worklist: one line per node (verdict, solidity, parts, STALE / open-issue / FRONTIER markers), the frontier nodes in full (claim, criterion, rationale, last judgment), and the standing line. Pass `node` for one node in full, or `full: true` for every node in full.',
      inputSchema: {
        node: z.string().optional().describe('show this one node in full'),
        full: z.boolean().optional().describe('show every node in full (long on a large graph)'),
      },
    },
    async ({ node, full }) => ({ content: [{ type: 'text' as const, text: store.stateReport({ node, full }) }] }),
  )

  server.registerTool(
    'graph_audit',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Evidence audit — which judgments rest on changed code?',
      description:
        'For every valid node, re-hash the artifacts its judgment was pinned to at verification (git HEAD + cited files/directories) and report the ones that changed or vanished since. Fingerprints cover claims and parts, never code — this is the only signal that a green node\'s evidence was gathered against code that no longer exists. Run it after any change under verified claims; a STALE? line is the prompt for doubt, not a refutation.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text' as const, text: store.auditReport() }] }),
  )

  server.registerTool(
    'issue_open',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Record a finding',
      description:
        'Open an issue: a finding from an audit, a review or a failing check, recorded on the chain with its full detail so it is visible on the dashboard\'s issue pane and to every later session. Not a node — a bug is not a part of correctness — and not a judgment: the graph is unchanged. Name the claim it concerns with `node` when there is one; judge that claim invalid separately if the finding refutes it. Give the finding its own key (AUTHZ-1) or let one be assigned (I7).',
      inputSchema: {
        title: z.string().min(1).describe('one line: what is wrong'),
        key: z.string().min(1).optional().describe('the issue\'s key, e.g. AUTHZ-1; assigned (I1, I2, …) when omitted'),
        node: z.string().optional().describe('the claim this finding concerns'),
        severity: z.string().optional().describe('e.g. Critical / High / Med / Low, in the project\'s own scale'),
        detail: z.string().optional().describe('the finding in full — what, where (file:line), why it matters, recommended fix; markdown is fine'),
      },
    },
    async ({ title, key, node, severity, detail }) => {
      store.refresh()
      const k = key ?? store.nextIssueKey()
      const op = { type: 'issue' as const, action: 'open' as const, key: k, title, ...(node !== undefined ? { node } : {}), ...(severity !== undefined ? { severity } : {}), ...(detail !== undefined ? { detail } : {}) }
      const r = store.dispatch(op)
      const nudge = node !== undefined ? groupNudge(store, node, 'finding') : null
      if (r.ok && nudge) r.text += `\n${nudge}`
      return text(r)
    },
  )

  server.registerTool(
    'issue_close',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Close an issue',
      description:
        'Close a recorded issue with its outcome — fixed (say what changed and how it was checked), wontfix (say why it is accepted), invalid (the finding was wrong), or duplicate (name the surviving key). Closing an issue does not judge any claim: if a fix makes a refuted claim true again, verify that claim valid as well.',
      inputSchema: {
        key: z.string().min(1),
        outcome: z.enum(['fixed', 'wontfix', 'invalid', 'duplicate']),
        resolution: z.string().optional().describe('what was done, or why nothing will be'),
      },
    },
    async ({ key, outcome, resolution }) => {
      store.refresh()
      if (outcome === 'fixed') store.noteClosedHere(key)
      return text(store.dispatch({ type: 'issue', action: 'close', key, outcome, ...(resolution !== undefined ? { resolution } : {}) }))
    },
  )

  server.registerTool(
    'issue_list',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Issues — recorded findings and their state',
      description:
        'Every issue recorded on the chain, open first: key, status, severity, the claim it concerns, title. Pass `detail` to include each finding\'s full text, or `key` for one issue in full. Open issues are the worklist a fixing session starts from.',
      inputSchema: {
        detail: z.boolean().optional().describe('include the full detail of every issue'),
        key: z.string().optional().describe('show this one issue in full'),
      },
    },
    async ({ detail, key }) => ({
      content: [{ type: 'text' as const, text: store.issuesReport({ ...(detail !== undefined ? { detail } : {}), ...(key !== undefined ? { key } : {}) }) }],
    }),
  )

  server.registerTool(
    'version_mark',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Mark a version',
      description:
        'Declare that the project, as of a commit, is a working version with a name (v0.3). Git knows commits but not which one concluded a version; this records it on the chain. The commit is read from the project\'s repository unless given; marking on a tree with uncommitted changes is allowed but warned, because then the commit alone does not identify the code — the clean order is: commit the working version, then mark it (the mark itself lands in the next commit). What the version was (root solid or broken, open issues) is read from the chain at the mark, never stored. A record: the graph is unchanged.',
      inputSchema: {
        name: z.string().min(1).describe('the version name, e.g. v0.3'),
        note: z.string().optional().describe('what this version is — one or two lines for a reader who was not there'),
        commit: z.string().optional().describe('the commit the version sits after; defaults to HEAD of the project root'),
      },
    },
    async ({ name, note, commit }) => {
      store.refresh()
      const git = gitState(store.root)
      const op = {
        type: 'version' as const,
        name,
        ...(commit !== undefined ? { commit } : git.head !== undefined ? { commit: git.head } : {}),
        ...(git.dirty !== undefined ? { dirty: git.dirty } : {}),
        ...(note !== undefined ? { note } : {}),
      }
      const r = store.dispatch(op)
      if (!r.ok) return text(r)
      const warnings: string[] = []
      if (op.commit === undefined) warnings.push('no commit recorded — the project root is not a git repository, or git is unavailable; pass `commit` to name one')
      if (git.dirty) warnings.push('marked on a dirty tree: uncommitted changes are present, so the commit alone does not identify this version\'s code — commit first next time, then mark')
      return text({ ok: true, text: warnings.length > 0 ? `${r.text}\nVersion: ${warnings.join('; ')}` : r.text })
    },
  )

  server.registerTool(
    'version_list',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Versions — when the project was a working version',
      description: 'Every version marked on the chain, newest first, with the commit it sits after, what the chain said of it at that moment (root solid or broken, open issues) and how many events have happened since.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text' as const, text: store.versionsReport() }] }),
  )

  server.registerTool(
    'graph_history',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Graph history',
      description:
        'The event chain, read selectively. `node`: that one claim\'s own chain — the events that named it and the ones that reached it (reopened, restored), each with the operation that caused it, re-anchoring runs collapsed; read it before re-judging a claim. `cone`: only the current target\'s events. `since`: only events after that position (the standing line ends with the chain\'s position, "at #N") — the cheap way to catch up. Default: the last `limit` events. Evidence shows as its first sentence; `full` gives whole texts.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('default 30'),
        node: z.string().optional().describe("one claim's own chain"),
        cone: z.boolean().optional().describe("only the current target's events"),
        since: z.number().int().min(0).optional().describe('only events after this position'),
        full: z.boolean().optional().describe('whole evidence texts instead of first sentences'),
      },
    },
    async ({ limit, node, cone, since, full }) => ({
      content: [{ type: 'text' as const, text: store.historyReport({ limit, node, cone, since, full }) }],
    }),
  )

  server.registerTool(
    'why',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Why — the causal slice behind a claim\'s state',
      description:
        'Why a claim is valid, pending or invalid right now, in a few lines: what it was last judged on, or the event that reopened it and the claim that event was about, or the parts it is waiting on. The answer to "what broke this?" without reading the log.',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => ({ content: [{ type: 'text' as const, text: store.whyReport(id) }] }),
  )

  server.registerTool(
    'round_record',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Record a round — a change described once',
      description:
        'Before re-anchoring several judgments after one change, record the change ONCE: what moved (files, functions, in words) and how it was checked (the suite result). Then pass its key as `round` to each verify / reverify / refute, whose evidence is ONE sentence about that claim — never the round again. A record like an issue or a version: the graph is unchanged.',
      inputSchema: {
        key: z.string().min(1).optional().describe('the round\'s key, e.g. targets-round; assigned (R1, R2, ...) when omitted'),
        title: z.string().min(1).describe('one line: what this change was'),
        detail: z.string().optional().describe('what moved and how it was checked, in full'),
      },
    },
    async ({ key, title, detail }) => text(store.roundRecord(key, title, detail)),
  )

  server.registerTool(
    'graph_open',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'Open a chain file',
      description:
        "Point the server at another project's chain file without restarting — runtime project switching. The path resolves against the server's working directory and must stay inside it. Opening a path with no existing file starts a fresh graph there (written on the first applied operation).",
      inputSchema: {
        path: z.string().describe('chain file path, e.g. ./ddag.json or testbed/ddag.json'),
      },
    },
    async ({ path }) => {
      const resolved = chainPathWithin(chainRoot, path)
      if (resolved === null) {
        return {
          content: [
            { type: 'text' as const, text: `Refused: "${path}" resolves outside the working directory (${chainRoot})` },
          ],
          isError: true,
        }
      }
      store.switchFile(resolved)
      return {
        content: [{ type: 'text' as const, text: `Chain file: ${resolved}\n${store.standing()}` }],
      }
    },
  )

  server.registerTool(
    'target_new',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: 'New target — a second pipeline on this chain',
      description:
        'Add a sub-target: its own root, standing and frontier beside the main target, for work that consumes the build rather than being part of it (publishing, deploying, a benchmark campaign). The main target is what graph_new created. Named <project>/<id>; selected on creation. A legacy single-target chain is migrated first: a project node is placed above the old root, which stays the main target, and every event replays unchanged. Claims from another target can be linked in as parts but are judged only in their home target.',
      inputSchema: {
        id: z.string().min(1).describe('the target id, e.g. publish; with adopt, an existing claim'),
        content: z.string().optional().describe('the target claim — what done means for this pipeline (not used with adopt: the claim keeps its text)'),
        verify: z.string().optional().describe('how the target will be judged'),
        rationale: z.string().optional().describe('why this is a target of its own and not a part of the main target'),
        adopt: z
          .boolean()
          .optional()
          .describe('make an EXISTING claim a target: it is linked under the project node and released from every whole it was a part of, its subtree and their judgments intact — for a pipeline that was decomposed under the build by mistake'),
      },
    },
    async ({ id, content, verify, rationale, adopt }) => {
      if (!adopt && (content === undefined || content === '')) return text({ ok: false, text: 'Rejected: a new target needs its claim text (content), or pass adopt to promote an existing claim' })
      return withCriterionNote(store.targetNew(id, composeClaim(content ?? '', verify), rationale, adopt === true), verify, content ?? '')
    },
  )

  server.registerTool(
    'target_switch',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Switch target',
      description:
        'Select the target this session works on: graph_state, graph_audit, the frontier and the standing line then speak for that target, and judgments are accepted only on claims whose home it is. Session state, not a chain event.',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => text(store.targetSwitch(id)),
  )

  server.registerTool(
    'target_list',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: 'Targets — every pipeline on this chain with its standing',
      description: 'The main target and every sub-target, each with solid or broken, the size of its cone, its frontier and its open issues; the current one marked.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text' as const, text: store.targetList() }] }),
  )

  server.registerTool(
    'graph_new',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      title: 'New graph',
      description:
        'Start a fresh graph with the given build target as root, REPLACING the current graph and its history file. Use only when beginning a genuinely new decomposition.',
      inputSchema: {
        content: z.string().describe('the build target claim (root content)'),
        root_id: z.string().optional().describe('root node id; default "target"'),
        verify: VERIFY_PARAM,
      },
    },
    async ({ content, root_id, verify }) => {
      store.newGraph(root_id ?? 'target', composeClaim(content, verify))
      return withCriterionNote({ ok: true, text: `New graph started.\n${store.standing()}` }, verify, content)
    },
  )

  return server
}

export async function main(): Promise<void> {
  // default ./ddag.json resolved against the working directory: Claude Code
  // spawns local MCP servers in the project dir, so one no-argument
  // registration serves every project, each with its chain beside its code
  const raw = process.argv[2] ?? process.env['DDAG_FILE'] ?? './ddag.json'
  const file = resolve(process.cwd(), raw)
  // every chain this server loads or writes is registered for the dashboard
  const registry = new Registry()
  const store = new McpStore(file, process.cwd(), (f) => {
    try {
      registry.register(f)
    } catch (e) {
      console.error(`ddag: registry write failed: ${String(e)}`)
    }
  })
  const server = buildServer(store)
  await server.connect(new StdioServerTransport())
  // stdout is the protocol channel — boot notices go to stderr
  console.error(`ddag MCP server ready — cwd: ${process.cwd()} — chain file: ${file}`)
  ensureDashboard()
}

/**
 * The dashboard is one long-lived local process shared by every session. When
 * nothing is listening on its port, this server starts it detached beside its
 * own bundle (dist/ddag-dashboard.mjs), so installing the tool is the whole
 * setup; a running one is left alone. DDAG_NO_DASHBOARD=1 opts out.
 */
function ensureDashboard(): void {
  if (process.env['DDAG_NO_DASHBOARD']) return
  const port = Number(process.env['PORT'] ?? 5199)
  const probe = createConnection({ host: '127.0.0.1', port })
  probe.once('connect', () => probe.destroy())
  probe.once('error', () => {
    const bundle = join(dirname(fileURLToPath(import.meta.url)), 'ddag-dashboard.mjs')
    if (!existsSync(bundle)) return
    try {
      const child = spawn(process.execPath, [bundle], { detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(port) } })
      child.unref()
      console.error(`ddag: dashboard started — http://localhost:${port}/`)
    } catch (e) {
      console.error(`ddag: dashboard could not be started: ${String(e)}`)
    }
  })
}
