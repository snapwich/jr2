// The OPEN sentinel (ADR-0051, widened by ADR-0054) — one value, its own module.
//
// It lives alone here because both of the parts it marks must read it and they sit on opposite
// sides of the package: `agent()`'s declaration (agent.ts, a pure leaf that pulls no wire client)
// and a `workspace()`'s Repo Slots (parts.ts, which already imports agent.ts). A module with
// nothing but the sentinel in it is what lets both import it and neither import the other.

// `Symbol.for`, so an Instance's own copy of this module and the CLI's walk agree on it — a
// packaged Machine may be built against one and walked by the other.
/**
 * Leave a part of a Machine Open: for the Instance that registers the Machine to bind with
 * `customize()`. Write it where a value goes, in a Machine that you publish as a package, for a
 * part that the package cannot know or pay for:
 * - a Repo Slot: `repos: { app: open }`, or the whole map: `repos: open`;
 * - an Agent's model: `agent({ model: open, … })`;
 * - an Effect's url or argv: `http({ url: open, … })`, `command(open)`;
 * - the secret of an Effect's auth, of a header, or of a command's `env`: `secret(open)`.
 *
 * `jr2 up` refuses a Workflow with an Open part that nobody bound, and prints the `customize()`
 * line that binds it: ``refusing: workflow "<name>" leaves <part> open — bind it where the Machine
 * is registered: export const machine = customize(<import>, …)  (<adr>)``. A run never sees an
 * Open part.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, customize, defineEvent, jr2Setup, open, workspace } from "@jr2/orchestrator";
 *
 * const finish = defineEvent({
 *   name: "finish",
 *   description: "Call this when `node --test` passes.",
 *   input: z.object({}),
 * });
 *
 * const body = jr2Setup({
 *   events: [finish],
 *   actors: { coder: agent({ model: open, instructions: "You fix the failing test." }) },
 * }).createMachine({
 *   id: "fix",
 *   initial: "coding",
 *   states: {
 *     coding: {
 *       invoke: { src: "coder", input: { prompt: "Make `node --test` pass." } },
 *       on: { finish: "done" },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 *
 * // What a package exports: the repository and the model are Open.
 * export const fix = workspace(body, {
 *   repos: { app: open },
 *   spec: () => ({ branch: "jr2/fix" }),
 * });
 *
 * // What an Instance's `workflows/fix.ts` exports: the same Machine, its Open parts bound.
 * export const machine = customize(fix, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   agents: { coder: { model: "anthropic/claude-sonnet-5-5" } },
 * });
 * ```
 *
 * @see docs/guides/bind-open-parts.md
 * @see docs/concepts/composition.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export const open: unique symbol = Symbol.for("jr2.open");
