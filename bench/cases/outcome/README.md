# Outcome cases (not built yet)

Agents as subjects, scored by machines only. Planned families, each with hidden
ground truth kept outside the agent's working folder:

- build from a spec with traps — metric: declared done while hidden tests fail
- audit a codebase with seeded defects — recall, precision, findings per round
- a change request that silently breaks an old property — regressions that escape
- a session killed mid-task, resumed by a fresh agent — work redone, work skipped
- a control: pure execution-shaped work, where DDAG should only cost tokens

Conditions: a careful agent with a checklist file, DDAG at the previous version,
DDAG at the new version. Several runs per cell; a pilot first, to learn the variance.
