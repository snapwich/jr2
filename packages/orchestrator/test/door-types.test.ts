// The door's TYPE-level claims (ADR-0033), asserted by the compiler. `pnpm typecheck` is what
// runs this file: every `@ts-expect-error` below fails the build if the error it names stops
// happening, and every unannotated call fails if the inference it relies on breaks. The obvious
// formulation — pinning the body's TInput slot — cannot make claim 1: `StateMachine`'s members are
// methods, method parameters are bivariant, and a body demanding MORE than the door provides slips
// through. The guard formulation `workspace()` uses checks both directions, which is what the
// paired cases below hold it to.
//
// The claims:
//   1. a body that demands MORE than the door provides is rejected, naming the fix;
//   2. a body that demands LESS is accepted — it is fed a superset;
//   3. the injected handles cannot be passed from outside; the door never asks for them;
//   4. the spec mapper's `input` is the PARSED door, with no annotation at the call site;
//   5. the wrapper's output is the body's, so a parent's `onDone` is typed;
//   6. a parent invoking the wrapper has its input mapper checked against the door;
//   7. with no door declared the mapper's `input` is `unknown` — an honest "j2 does not know",
//      not `any`;
//   8. what the HOST injects beside the door is outside the check — and only that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, type InputFrom, type OutputFrom } from "xstate";
import { z } from "zod";
import { workspace, type WorkspaceSpec, type Workspaced } from "../src/workspace.ts";
import { inputSchemaOf, type HostInjectedInput } from "../src/vocabulary.ts";

const door = z.object({ repo: z.string(), branch: z.string() });
type Door = z.infer<typeof door>;

/** A body parameterized on what it declares it is started with — the only axis under test. */
const bodyTakingInput = <TInput>() =>
  setup({ types: {} as { context: {}; input: TInput } }).createMachine({
    context: {},
    initial: "idle",
    states: { idle: {} },
  });

const exact = bodyTakingInput<Workspaced<Door>>();
const needsLess = bodyTakingInput<Workspaced<{ repo: string }>>();
const needsMore = bodyTakingInput<Workspaced<Door & { reason: string }>>();
const unrelated = bodyTakingInput<{ ticket: number }>();
const ignoresHandles = bodyTakingInput<Door>();

const outputting = setup({
  types: {} as { context: {}; input: Workspaced<Door>; output: { outcome: "approved" } },
}).createMachine({
  context: {},
  initial: "done",
  states: { done: { type: "final" } },
  output: () => ({ outcome: "approved" as const }),
});

const specOf = (input: Door): WorkspaceSpec => ({
  repos: [{ name: input.repo, baseRef: "main" }],
  branch: input.branch,
});

// --- 1/2: the door constrains the body, in ONE direction ---------------------------------------

const wrapped = workspace(exact, { input: door, spec: ({ input }) => specOf(input) });
// Requiring a SUBSET is safe: the wrapper hands it the door plus the handles, a superset of what
// it asked for. This is why the check is assignability and not equality.
void workspace(needsLess, { input: door, spec: ({ input }) => specOf(input) });
// A body that never reads the handles is the same case — it is simply fed more than it declared.
void workspace(ignoresHandles, { input: door, spec: ({ input }) => specOf(input) });
// @ts-expect-error the body demands `reason`, which nothing at this door ever provides — rejected
// with the guard's named key ("the body's declared input must accept the door plus the injected
// handles"). This is the claim the whole formulation exists to make.
void workspace(needsMore, { input: door, spec: ({ input }) => specOf(input) });
// @ts-expect-error no overlap at all, rejected the same way
void workspace(unrelated, { input: door, spec: ({ input }) => specOf(input) });

// --- 3: the handles are the wrapper's to inject, nobody else's ---------------------------------

const fromOutside: InputFrom<typeof wrapped> = {
  repo: "app",
  branch: "feat",
  // @ts-expect-error a caller cannot send `workspace` — the handles do not exist until a Sandbox
  // is provisioned and attached, which is the whole reason the door sits on the wrapper.
  workspace: { workdir: "/w", repos: {}, branch: "feat" },
};
void fromOutside;

// --- 4: the mapper reads the PARSED door, uninstructed -----------------------------------------

void workspace(exact, {
  input: door,
  spec: ({ input }) => {
    const repo: string = input.repo; // inferred from the schema; no annotation anywhere
    void repo;
    // @ts-expect-error `title` is not on this door
    void input.title;
    return specOf(input);
  },
});

// --- 5: the wrapper's output is the body's, verbatim -------------------------------------------

/** True only when A and B are the same type, both ways — assignability would let `any` pass. */
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const withOutput = workspace(outputting, { input: door, spec: ({ input }) => specOf(input) });
const doorIsTheInput: Eq<InputFrom<typeof wrapped>, Door> = true;
const bodyOutputIsTheOutput: Eq<OutputFrom<typeof withOutput>, { outcome: "approved" }> = true;

// --- 6: a parent invoking the wrapper is checked against the door -------------------------------

void setup({ actors: { work: withOutput } }).createMachine({
  initial: "working",
  states: {
    working: {
      invoke: {
        src: "work",
        input: { repo: "app", branch: "feat" },
        // The body's output reaches the parent typed — no cast at the seam.
        onDone: { target: "done", actions: ({ event }) => void (event.output.outcome satisfies "approved") },
      },
    },
    done: { type: "final" },
  },
});

void setup({ actors: { work: wrapped } }).createMachine({
  initial: "working",
  states: {
    working: {
      // @ts-expect-error `branch` is missing from the invoke input — a nested wrapper's door is
      // checked by the compiler, not by a comment (triaged-task.ts's seam).
      invoke: { src: "work", input: { repo: "app" } },
    },
  },
});

// --- 7: no door declared → `unknown`, not `any` -------------------------------------------------

const permissive = workspace(ignoresHandles, {
  spec: ({ input }) => {
    // @ts-expect-error nothing is known about what starts this wrapper; the mapper must narrow
    void input.repo;
    return { repos: [{ name: "app", baseRef: "main" }], branch: "feat" };
  },
});
const permissiveDoorIsUnknown: Eq<InputFrom<typeof permissive>, unknown> = true;

// A wrapper fed by something other than a caller (a pool worker, a nested invoke) may STATE what
// it is fed by annotating the mapper — which types the wrapper's input too, without claiming a
// door that nothing serves or validates.
const itemFed = workspace(ignoresHandles, {
  spec: ({ input }: { input: { ticket: Door } }) => specOf(input.ticket),
});
const annotatedInputFlows: Eq<InputFrom<typeof itemFed>, { ticket: Door }> = true;

// --- 8: the host's own injection is outside the check -------------------------------------------

// `RunHost.start` hands the ROOT machine `{ ...runInput, instanceId }` and the wrapper passes its
// input through untouched, so a root-placed wrapper feeds its body that field too — while a nested
// one does not, and no type can see which. A body that declares it honestly (the kind tier's
// workflows do) must NOT be told to widen its door: the field is host-supplied, never sent, never
// served (ADR-0033). So the guard adds those keys to what it counts as PROVIDED.
const wantsHostInjection = bodyTakingInput<Workspaced<Door> & HostInjectedInput>();
void workspace(wantsHostInjection, { input: door, spec: ({ input }) => specOf(input) });
// Exactly those keys and no more: one extra field beside them is still rejected, so the carve-out
// is not a hole in claim 1.
const wantsMoreThanHostInjection = bodyTakingInput<Workspaced<Door> & HostInjectedInput & { reason: string }>();
// @ts-expect-error `reason` is nobody's to inject — neither the door, the handles, nor the host
void workspace(wantsMoreThanHostInjection, { input: door, spec: ({ input }) => specOf(input) });
// And the keys are still TYPED. Widening the provided side is what buys this: SUBTRACTING them
// from what the body demands (`Omit<InputFrom<TBody>, keyof HostInjectedInput>`) would drop the
// wrong declaration along with the key, and admit this.
const mistypesHostInjection = bodyTakingInput<Workspaced<Door> & { instanceId: number }>();
// @ts-expect-error the host injects an Instance ID string; a body asking for a number never gets one
void workspace(mistypesHostInjection, { input: door, spec: ({ input }) => specOf(input) });

// A UNION input is checked member-by-member, for the same reason. Subtracting keys compares
// against a union's SHARED keys only, so `reason`/`other` would vanish from the check and every
// member could demand a field the door never carries — the exact hole claim 1 exists to close.
const unionDemandsMore = bodyTakingInput<
  Workspaced<Door & { reason: string }> | Workspaced<Door & { other: string }>
>();
// @ts-expect-error no member of the union is satisfied by the door plus the handles
void workspace(unionDemandsMore, { input: door, spec: ({ input }) => specOf(input) });
// A union whose members are each satisfied is still fine — one direction, as ever.
const unionNeedsLess = bodyTakingInput<Workspaced<{ repo: string }> | Workspaced<Door>>();
void workspace(unionNeedsLess, { input: door, spec: ({ input }) => specOf(input) });

test("the door's type-level claims are the compiler's; this run pins the runtime half", () => {
  assert.equal(inputSchemaOf(wrapped), door, "the declared door rides the WRAPPER, not the body");
  assert.equal(inputSchemaOf(permissive), undefined, "no schema declared → the door stays permissive");
  assert.ok(doorIsTheInput && bodyOutputIsTheOutput && permissiveDoorIsUnknown && annotatedInputFlows);
});
