// The seed Repo and the suite the @model tier's command-Effect claims run (ADR-0066, ADR-0067).
// `billing.git` is its own project in the seed (`features/steps/seed.ts`): `total()` truncates
// where it must round, so one of its two tests fails with a message that names the defect, and
// the Worktree holds nothing else to fix. `run_tests` runs that real suite, so the output the
// model reads names a test the Worktree holds. `features/lib/model-seed.test.ts` runs it against
// the seed and holds both claims to it.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.

/** The Repo Slot's Binding: the seed's billing project. */
export const billing = { url: "http://seed.jr2-e2e-seed.svc/billing.git", ref: "main" } as const;

/** The project's real suite, the argv `run_tests` runs in the Worktree. */
export const suite = ["node", "--test"] as const;
