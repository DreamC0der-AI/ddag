# DDAG benchmarks

Numbers per version, side by side. This folder is not part of the DDAG app and
is not in its npm package. It measures DDAG the way a user's agent meets it:
the harness starts a version as an MCP server over stdio and never imports
from `../src`, so the same harness and the same cases measure every version.

```sh
cd bench
npm run bench -- --version 0.3.2                                   # a published version, from npm
npm run bench -- --local ../dist/ddag-mcp.mjs --label 0.4.1-local  # an unreleased build
npm run view                                                       # http://localhost:5310/
```

(`@modelcontextprotocol/sdk` resolves from the repository's `node_modules`;
run `npm install` at the repository root once.)

## Layout

| Folder | What it holds |
|---|---|
| `harness/` | `run.mjs` runs every case against one version and writes a result; `lib.mjs` is the session, the scratch project and the metric helpers |
| `cases/mechanism/` | deterministic scripted sessions: no model, the same tool calls every time |
| `cases/outcome/` | agent tasks with hidden ground truth (not built yet) |
| `results/` | one JSON per suite and version, plus `index.json`; committed, so results sit in the same history as the versions they measure |
| `view/` | the comparison page and its small static server |

## The mechanism suite

**standard-session** — one working session as an agent runs it: a target with
three groups of three claims is decomposed, judged bottom-up, read back, then
one source file changes and the stale judgments are re-anchored. The evidence
texts are fixed and written the way agents write them: each names the file the
claim rests on and two related files read along the way. Measured: the context
cost of the whole session (every reply the server sent), the cost of each kind
of read, files pinned per judgment, judgments staled by a one-file edit (the
right answer is 1), latency, chain file size.

**scale** — 200 claims in groups of five, all judged; the size of `graph_state`
and the latency of a judgment at 60 and at 200 claims.

## Reading the view

Versions are columns, metrics are rows. The shown version is compared against a
baseline you choose; the change is coloured by whether it is good for that
metric and always carries its sign and direction in words. A timing difference
under 20% is labelled noise: timings come from single runs. A metric a version
cannot produce is "n/a", never zero. Start time is compared only between
results of the same source, since `npx` and a local bundle start differently.
Click a metric for its bars across versions and, for the session, the cost of
each step.

## The comparability guard

Each result stores a hash of the case file it ran. The view compares two
versions on a case only when the hashes match; otherwise the column is marked
"other case" and no change is shown. Editing a case cannot pass for an
improvement of the product: re-run every version after changing a case.

## What these numbers are not

They show that a mechanism works and catch regressions between releases. They
do not show that anyone builds better software with DDAG. That is the outcome
suite's job: agents as subjects, hidden acceptance tests and seeded defects,
several runs per cell, a checklist baseline.
