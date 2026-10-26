// The `fail()` Part (ADR-0073): the end that a Machine chooses for work that did not succeed — a
// Failure (GLOSSARY.md). It is a Part and not an Effect, because it does no work outside the
// Machine: its actor throws an error that carries a brand, and xstate sends that error up through
// each parent Machine by its own rules. An `onError` on the way catches it; `isFailure` tells it
// from a defect. When no state catches it, the run host ends the run `failed`.
//
// The brand is a registry symbol (`Symbol.for`), not a module symbol, for the reason the walk is
// structural (parts.ts): an Instance resolves its OWN `@jr2/orchestrator`, so the copy that throws
// and the copy that reads the error (the run host, the CLI's walk) can be two module instances. The
// brand is not exported: an author makes a Failure only with `fail()`.

import { fromPromise, type PromiseActorLogic } from "xstate";

const FAILURE: unique symbol = Symbol.for("jr2.failure") as never;
const FAIL_SLOT: unique symbol = Symbol.for("jr2.fail.slot") as never;

/** What a Failure carries: `reason`, text for a person, and `detail`, optional JSON for a machine
 * reader. The input of `fail()` and the output of a run that ends `failed`. */
export type FailureInput = { reason: string; detail?: unknown };

/** A Failure as `isFailure` narrows an error to it: the payload's fields, on the error itself. */
export type Failure = { readonly reason: string; readonly detail?: unknown };

/** Make the branded error. Only this module makes one. */
function failure(input: FailureInput): Error & Failure {
  const error = new Error(input.reason) as Error & Failure & { [FAILURE]: true };
  error.name = "Failure";
  Object.defineProperty(error, "reason", { value: input.reason, enumerable: true });
  if (input.detail !== undefined) Object.defineProperty(error, "detail", { value: input.detail, enumerable: true });
  Object.defineProperty(error, FAILURE, { value: true });
  return error;
}

/** Refuse an input that is not a Failure's. A defect of the Machine, not a Failure: it ends the run
 * `error`, with this text as the fault. */
function checked(raw: unknown): FailureInput {
  const input = raw as Partial<FailureInput> | undefined;
  if (typeof input !== "object" || input === null || typeof input.reason !== "string" || input.reason === "") {
    throw new Error(
      `fail: the input must be { reason: string; detail?: unknown } with a reason that is not empty (got ${describe(raw)}) — ` +
        `invoke: { src: "fail", input: { reason: "the tests failed" } } (ADR-0073)`,
    );
  }
  return input.detail === undefined ? { reason: input.reason } : { reason: input.reason, detail: input.detail };
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The actor logic that throws. Unbranded: what `workspace()` invokes to send a caught Failure up
 * again, which is the wrapper's mechanism and no state of the author's that fails the run. */
export const failLogic: PromiseActorLogic<never, FailureInput> = fromPromise<never, FailureInput>(async ({ input }) => {
  throw failure(checked(input));
});

/** The logic `fail()` returns: {@link failLogic} with the brand the walk reads. */
export type FailSlot = PromiseActorLogic<never, FailureInput> & { readonly [FAIL_SLOT]: true };

/**
 * Fail the run: the Part a Machine invokes to end work that did not succeed. Put it in `actors`
 * under a name, and invoke it from any state, at any depth: `actors: { fail: fail() }`, then
 * `invoke: { src: "fail", input: { reason } }`.
 *
 * The input is `{ reason: string; detail?: unknown }`. `reason` is text for a person, and it must
 * not be empty. `detail` is optional JSON for a machine reader.
 *
 * The Failure goes up from the state that invokes `fail`, through each parent Machine, as an error
 * does. An `onError` on the way catches it; {@link isFailure} tells it from a defect. When no state
 * catches it, the run ends `failed`: its output is `{ reason, detail }`, and `jr2 run` exits 1. A
 * `workspace()` that a Failure goes through deletes its Sandbox first.
 *
 * To fail, invoke `fail`. Do not throw from a promise to fail: a throw is a defect, and the run
 * ends `error`. A final state means `done`: do not use one for work that did not succeed. To keep
 * the work for a person to read, wait at a Gate before the state that fails.
 *
 * It refuses an input that is not a Failure's, and the run ends `error`: ``fail: the input must be
 * { reason: string; detail?: unknown } with a reason that is not empty (got <value>) — invoke:
 * { src: "fail", input: { reason: "the tests failed" } } (ADR-0073)``.
 *
 * @returns The actor logic of the slot.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { command, fail, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";
 *
 * const runInput = z.object({ branch: z.string() });
 *
 * const body = jr2Setup({
 *   types: {} as { input: Workspaced<z.infer<typeof runInput>, "app"> },
 *   actors: {
 *     tests: command(["npm", "test"], { timeout: "15m" }),
 *     fail: fail(),
 *   },
 * }).createMachine({
 *   id: "check",
 *   on: { "workspace.lost": ".lost" },
 *   initial: "testing",
 *   states: {
 *     testing: {
 *       invoke: {
 *         src: "tests",
 *         onDone: [
 *           {
 *             guard: ({ event }) => event.output.outcome === "exited" && event.output.code === 0,
 *             target: "passed",
 *           },
 *           { target: "failing" },
 *         ],
 *       },
 *     },
 *     // Not a final state: the run ends `failed`, and the Workspace deletes the Sandbox.
 *     failing: { invoke: { src: "fail", input: { reason: "npm test did not pass" } } },
 *     passed: { type: "final" },
 *     lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   input: runInput,
 *   repos: { app: "https://github.com/you/app.git" },
 *   spec: ({ input }) => ({ branch: input.branch }),
 * });
 * ```
 *
 * @see docs/reference/decisions/0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md
 */
export function fail(): FailSlot {
  // Logic of its own per slot, so the brand is on this slot's logic and on no other's.
  const logic = fromPromise<never, FailureInput>(async ({ input }) => {
    throw failure(checked(input));
  });
  return Object.defineProperty(logic, FAIL_SLOT, { value: true }) as FailSlot;
}

/** Is this actor logic a `fail()` slot? A test on the brand, like `isAgent`: what the walk reads to
 * list each state that can fail the run (ADR-0073). */
export function isFailSlot(logic: unknown): logic is FailSlot {
  return typeof logic === "object" && logic !== null && (logic as { [FAIL_SLOT]?: unknown })[FAIL_SLOT] === true;
}

/**
 * Is this error a Failure, which a state invoked `fail` to make? A defect — any other error — is
 * not. Use it in the guard of an `onError` to catch a Failure and let a defect go up, and read the
 * Failure's `reason` and `detail` from the error it narrows.
 *
 * @param error - The error of an error event: `event.error` in an `onError`.
 * @returns True for a Failure, with `error` narrowed to `{ reason, detail? }`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { defineEvent, fail, isFailure, jr2Setup } from "@jr2/orchestrator";
 *
 * const retry = defineEvent({ name: "retry", description: "Try the plan again.", input: z.object({}) });
 *
 * const attempt = jr2Setup({ actors: { fail: fail() } }).createMachine({
 *   id: "attempt",
 *   initial: "stuck",
 *   states: { stuck: { invoke: { src: "fail", input: { reason: "no plan fits the ticket" } } } },
 * });
 *
 * export const machine = jr2Setup({ events: [retry], actors: { attempt } }).createMachine({
 *   id: "planner",
 *   initial: "planning",
 *   states: {
 *     planning: {
 *       invoke: {
 *         src: "attempt",
 *         onDone: "planned",
 *         // A Failure waits for a person; a defect has no route, so it goes up and the run ends `error`.
 *         onError: { guard: ({ event }) => isFailure(event.error), target: "asking" },
 *       },
 *     },
 *     asking: { invoke: { src: "gate" }, on: { retry: "planning" } },
 *     planned: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/reference/decisions/0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md
 */
export function isFailure(error: unknown): error is Failure {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [FAILURE]?: unknown })[FAILURE] === true &&
    typeof (error as { reason?: unknown }).reason === "string"
  );
}

/** The name of the guard that every Chart has (ADR-0070, ADR-0073): {@link isFailure} on the
 * event's `error`, so a Chart's `onError` can tell a Failure from a defect. It is a predicate and
 * gives no capability, so it is never lent, as `jr2.sentBy` is not. */
export const FAILURE_GUARD = "jr2.failure";

/** The implementation of {@link FAILURE_GUARD}: true when the event's `error` is a Failure. */
export const failureGuard = ({ event }: { event: { error?: unknown } }): boolean => isFailure(event.error);

/** A Failure's payload as plain JSON data: what a failed run's output is, and what `workspace()`
 * keeps to send it up again. */
export function failurePayload(error: Failure): FailureInput {
  return error.detail === undefined ? { reason: error.reason } : { reason: error.reason, detail: error.detail };
}
