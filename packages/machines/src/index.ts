// @jr2/machines — the Machines the kit ships (ADR-0054). A fourth published package beside
// `@jr2/{cli,orchestrator,agent-protocol}` (ADR-0043), on the same release train, exporting named
// Machines from this index: `import { task } from "@jr2/machines"`.
//
// It ships MACHINES and never Workflows. A Workflow is the name an Instance registers a Machine
// under, and only the Instance's `workflows/` file can do that (CONTEXT.md) — so what a consumer
// receives is a Machine object, and the line that turns it into a Workflow is theirs:
//
//   import { customize } from "@jr2/orchestrator";
//   import { task } from "@jr2/machines";
//   export const machine = customize(task, { repos: { target: { url } }, agents: { coder: { model } } });
//
// PEER DEPENDENCIES, NO REGULAR ONES — the one fact about this package's manifest that a comment
// has to carry, because `package.json` cannot hold one. Every part a Machine here carries is keyed
// in maps `@jr2/orchestrator` holds (vocabulary.ts, parts.ts) and in `xstate`'s own `provide` and
// machine tests. A SECOND copy of either — which a regular dependency installs the moment the
// consumer's version skews from ours — is a Machine whose Menus are empty and whose Gates accept
// nothing, with no error anywhere: the walk finds no vocabulary, the Gate resolves no names, and
// the run parks on a surface that accepts nothing. Peer deps state the fact instead, and are the
// shape a user's own Machine package copies. Regular deps pinned at the exact kit version were
// rejected for working by the ACCIDENT of equal versions and installing two copies silently on
// skew (ADR-0054).
//
// Every Machine exported here leaves its unfillable parts OPEN (CONTEXT.md, ADR-0054): a package
// cannot know the repository or pay for the model, so it says so rather than guessing. `jr2 up`
// refuses an Open part nobody bound and prints the `customize` line that binds it.

export * from "./task.ts";
