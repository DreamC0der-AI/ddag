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
| `harness/` | `run.mjs` runs every mechanism case against one version and writes a result; `outcome.mjs` runs an agent on a task under each condition and scores it; `lib.mjs` is the session, the scratch project and the metric helpers |
| `cases/mechanism/` | deterministic scripted sessions: no model, the same tool calls every time |
| `cases/outcome/` | agent tasks with hidden ground truth: `given/` is all the agent sees, `hidden/` is the judge (none admitted yet) |
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

## The outcome suite

An agent is the subject and a hidden test suite is the judge. One run is one
headless Claude Code session (`claude -p`) in a fresh folder outside this
repository, holding only the task's `given/` files. Three conditions, the same
task text in each, only the method paragraph differs:

- **none** — no DDAG; the agent is told to keep a checklist file and verify each line with its own tests
- **DDAG at the previous version** and **DDAG at the new version** — that npm version is the session's only MCP server

After the session ends the harness copies the solution next to the hidden tests
and runs them. Recorded per run: hidden tests passed, whether the agent said
DONE, *said done while hidden tests fail*, *root SOLID while hidden tests fail*,
turns, wall time, tokens, cost at API prices, DDAG calls and what the chain holds.
A run is marked not valid if it hit a cap, if DDAG did not connect, or if its
transcript shows a network command or a read of the benchmark's own files.

    npm run outcome -- --task <id> --plan        # what it would run and the worst case, spends nothing
    npm run outcome -- --task <id> --selfcheck   # the judge judged: reference passes, stub fails
    npm run outcome -- --task <id>               # none, 0.3.2, 0.4.1, one run each, on Sonnet
    npm run outcome -- --task <id> --runs 5      # adds runs 2..5; finished runs are kept
    npm run outcome -- --task <id> --rescore     # rebuild summaries from kept transcripts, spends nothing

The runner is built; no case is admitted yet. `cases/outcome/README.md` says what
a case must have, and why the first one tried was removed.

**The budget rules.** Every run has a dollar cap (`--max-usd`, 2.5), a turn cap
(`--max-turns`, 80) and a wall-clock cap (`--timeout-min`, 25); the campaign has
its own cap (`--campaign-usd`, 8) and no run starts that could pass it. Runs go
one at a time and each is written to `results/runs/<id>/run.json` before the
next starts, so a campaign stopped half way keeps what it paid for and the same
command resumes it. Raw transcripts and work folders stay in `results/runs/`
(not committed); `results/outcome/<task>.json` is the committed summary.

Public tasks are in the models' training data, so the absolute pass rate means
little; the comparison between conditions on the same task is what is read.

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
suite's job, and one run per condition cannot do it either: agents vary from
run to run, so a claim about quality needs several runs per cell and a task
hard enough that the baseline fails some of it.
