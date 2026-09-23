# Outcome cases

Agents as subjects, scored by machines only. A case is a folder:

    <task>/task.json        title, family, source, scoring command, traps, the prompt parts
    <task>/given/           everything the agent sees (copied into a fresh folder)
    <task>/hidden/          the judge: the test suite and a reference solution, never shown

No case is admitted yet.

## What a case must have

A case tests DDAG only if the work has something to decompose and something to
lose track of. A task one agent finishes in one pass measures the agent, not the
agent with DDAG. Admit a case only if at least one of these holds:

- it does not fit one pass: many interacting requirements, or more than one session
- a later change can silently falsify something already judged
- its claims are not all settled by one test suite the agent can re-run (review findings, design or security properties)
- the ground truth is seeded, so a machine can score what was found and what was missed

## Tried and removed

**forth** (Exercism's Forth evaluator, from Aider's polyglot set; 54 hidden tests;
2026-09-17, Sonnet 5, one run per condition). No DDAG, DDAG 0.3.2 and DDAG 0.4.1
all passed 52/54 and failed the same two tests, a reading of the spec none of them
made; all three said done, both chains ended SOLID with no invalid verdict. DDAG
cost 1.2–1.7x the baseline (13 turns and $0.32 against 31–35 turns and $0.39–0.55).
Removed: a 66-line solution written in one pass leaves nothing to decompose, so
only the agent mattered. Small single-function exercises (Exercism, HumanEval,
MBPP, QuixBugs) are out for the same reason.

## Planned families

- audit a codebase with seeded defects — recall, precision, findings per round
- a change request that silently breaks an old property — regressions that escape
- a session killed mid-task, resumed by a fresh agent — work redone, work skipped
