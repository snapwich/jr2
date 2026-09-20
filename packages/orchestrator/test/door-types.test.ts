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
//   7. with no door declared the mapper's `input` is `unknown` — an honest "jr2 does not know",
//      not `any`;
//   8. what the HOST injects beside the door is outside the check — and only that;
//   9. a per-run Repo Slot's mapper reads the same PARSED door as `spec` (ADR-0051), on the
//      wrapper itself: `unknown` on the permissive path, and an annotation that contradicts the
//      door is refused;
//  10. the handles are keyed by the wrapper's DECLARED Repo Slots (ADR-0050): a body names the
//      slots it reads, an undeclared one is refused at the `workspace()` call — on BOTH overloads,
//      since the slots are declared on the door-less path exactly as on the other — and no type
//      on the seam defaults its slots to `string`, which would widen `repos` to `Record<string, …>`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, type InputFrom, type OutputFrom } from "xstate";
import { z } from "zod";
import { open } from "../src/parts.ts";
import {
  workspace,
  type PermissiveWorkspaceOptions,
  type SandboxOptions,
  type WorkspaceHandles,
  type WorkspaceMachine,
  type WorkspaceOptions,
  type WorkspaceSpec,
  type Workspaced,
} from "../src/workspace.ts";
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

// Every body below names the one slot the wrappers declare, `app` (claim 10).
const exact = bodyTakingInput<Workspaced<Door, "app">>();
const needsLess = bodyTakingInput<Workspaced<{ repo: string }, "app">>();
const needsMore = bodyTakingInput<Workspaced<Door & { reason: string }, "app">>();
const unrelated = bodyTakingInput<{ ticket: number }>();
const ignoresHandles = bodyTakingInput<Door>();

const outputting = setup({
  types: {} as { context: {}; input: Workspaced<Door, "app">; output: { outcome: "approved" } },
}).createMachine({
  context: {},
  initial: "done",
  states: { done: { type: "final" } },
  output: () => ({ outcome: "approved" as const }),
});

const specOf = (input: Door): WorkspaceSpec => ({ branch: input.branch });
/** Every wrapper below attaches one bound slot: these claims are about the DOOR, and a `workspace()`
 * always declares at least one Repo Slot (ADR-0051). */
const repos = { app: "https://example.test/app.git" } as const;

// --- 1/2: the door constrains the body, in ONE direction ---------------------------------------

const wrapped = workspace(exact, { input: door, repos, spec: ({ input }) => specOf(input) });
// Requiring a SUBSET is safe: the wrapper hands it the door plus the handles, a superset of what
// it asked for. This is why the check is assignability and not equality.
void workspace(needsLess, { input: door, repos, spec: ({ input }) => specOf(input) });
// A body that never reads the handles is the same case — it is simply fed more than it declared.
void workspace(ignoresHandles, { input: door, repos, spec: ({ input }) => specOf(input) });
// @ts-expect-error the body demands `reason`, which nothing at this door ever provides — rejected
// with the guard's named key ("the body's declared input must accept the door plus the injected
// handles"). This is the claim the whole formulation exists to make.
void workspace(needsMore, { input: door, repos, spec: ({ input }) => specOf(input) });
// @ts-expect-error no overlap at all, rejected the same way
void workspace(unrelated, { input: door, repos, spec: ({ input }) => specOf(input) });

// --- 10: the handles are keyed by the wrapper's DECLARED slots ----------------------------------

// The same check holds a body to the slots it will actually be handed (ADR-0050, ADR-0051):
// demanding a slot the wrapper never declared is refused, demanding the declared one — or fewer
// than the wrapper declares — is fine.
const wantsApp = bodyTakingInput<Workspaced<Door, "app">>();
const wantsDocs = bodyTakingInput<Workspaced<Door, "app" | "docs">>();
void workspace(wantsApp, { input: door, repos, spec: ({ input }) => specOf(input) });
void workspace(wantsApp, {
  input: door,
  repos: { app: "https://a.test/a.git", docs: "https://a.test/d.git" },
  spec: ({ input }) => specOf(input),
});
// @ts-expect-error `docs` is a slot this wrapper never declared — the body would read a path that does not exist
void workspace(wantsDocs, { input: door, repos, spec: ({ input }) => specOf(input) });

// The door-less overload leaves the DOOR unchecked because it is unknown (claim 7) — but the slots
// are declared on this path exactly as on the other, so it holds the body to them the same way:
// the handles it will inject must satisfy what the body declares for them. Every kind-tier
// workflow and jr's pool worker are this overload, so a hole here would be a hole everywhere.
void workspace(wantsApp, { repos, spec: () => ({ branch: "feat" }) });
void workspace(wantsApp, {
  repos: { app: "https://a.test/a.git", docs: "https://a.test/d.git" },
  spec: () => ({ branch: "feat" }),
});
// @ts-expect-error `docs` is a slot this wrapper never declared — refused on the door-less path too
void workspace(wantsDocs, { repos, spec: () => ({ branch: "feat" }) });
// And with the door stated by annotation (claim 7's `itemFed`), the slot check still runs.
// @ts-expect-error the mapper's annotation types the door; it does not excuse an undeclared slot
void workspace(wantsDocs, { repos, spec: ({ input }: { input: { ticket: Door } }) => specOf(input.ticket) });

// No type on the seam defaults its slots to `string` either — `WorkspaceMachine` is what a package
// author annotates an export with, and under `JR2Repos<string>` `customize()` would offer every
// key exactly where the phantom exists to refuse them; an options value annotated with a `string`
// slot set types `repos` as `Record<string, RepoSlot>` and passes a body demanding any slot.
// The `workspace()` overloads infer the slots; an annotation names them.
// @ts-expect-error a `WorkspaceMachine` names its body and its slots; neither defaults
type DefaultedMachine = WorkspaceMachine<Door, unknown>;
// @ts-expect-error the same for the options a wrapper is built from
type DefaultedSandbox = SandboxOptions;
// @ts-expect-error the same for the declared-door options
type DefaultedOptions = WorkspaceOptions<typeof door>;
// @ts-expect-error the same for the door-less options
type DefaultedPermissive = PermissiveWorkspaceOptions;
type Defaulted = DefaultedMachine | DefaultedSandbox | DefaultedOptions | DefaultedPermissive;
void (null as unknown as Defaulted);
// Named, the slots type an options value as the inferred path would: `docs` is refused against it.
const namedOptions: PermissiveWorkspaceOptions<"app"> = { repos, spec: () => ({ branch: "feat" }) };
void workspace(wantsApp, namedOptions);
// @ts-expect-error `docs` is not a slot the annotated options declare
void workspace(wantsDocs, namedOptions);

// A body NAMES its slots: there is no default. `Workspaced<Door>` alone would have typed `repos`
// as `Record<string, string>`, under which a body's `repos.taregt` compiles and the wrapper accepts
// it (`Record<"app", string>` extends `Record<string, string>`) — the silent widening ADR-0050
// forbids. Refused where it is written, before any `workspace()` call could miss it.
// @ts-expect-error `Workspaced` takes the body's slots; a body with no slot named is not a body
type SlotlessBody = Workspaced<Door>;
// @ts-expect-error the same for the handles themselves
type SlotlessHandles = WorkspaceHandles;
type Slotless = SlotlessBody | SlotlessHandles | Misspelled;
void (null as unknown as Slotless);
// And a named slot is the only key the body can read: a misspelling is a compile error on the
// read, which is what lets a prompt name a path and be right everywhere (ADR-0051).
const appPathIsAString: Eq<WorkspaceHandles<"app">["repos"]["app"], string> = true;
// @ts-expect-error `taregt` is not a slot this body named
type Misspelled = WorkspaceHandles<"app">["repos"]["taregt"];

// --- 3: the handles are the wrapper's to inject, nobody else's ---------------------------------

const fromOutside: InputFrom<typeof wrapped> = {
  repo: "app",
  branch: "feat",
  // @ts-expect-error a caller cannot send `workspace` — the handles do not exist until a Sandbox
  // is provisioned and attached, which is the whole reason the door sits on the wrapper.
  workspace: { repos: {}, branch: "feat" },
};
void fromOutside;

// --- 4: the mapper reads the PARSED door, uninstructed -----------------------------------------

void workspace(exact, {
  input: door,
  repos,
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

const withOutput = workspace(outputting, { input: door, repos, spec: ({ input }) => specOf(input) });
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
  repos,
  spec: ({ input }) => {
    // @ts-expect-error nothing is known about what starts this wrapper; the mapper must narrow
    void input.repo;
    return { branch: "feat" };
  },
});
const permissiveDoorIsUnknown: Eq<InputFrom<typeof permissive>, unknown> = true;

// A wrapper fed by something other than a caller (a pool worker, a nested invoke) may STATE what
// it is fed by annotating the mapper — which types the wrapper's input too, without claiming a
// door that nothing serves or validates.
const itemFed = workspace(ignoresHandles, {
  repos,
  spec: ({ input }: { input: { ticket: Door } }) => specOf(input.ticket),
});
const annotatedInputFlows: Eq<InputFrom<typeof itemFed>, { ticket: Door }> = true;

// --- 8: the host's own injection is outside the check -------------------------------------------

// `RunHost.start` hands the ROOT machine `{ ...runInput, instanceId }` and the wrapper passes its
// input through untouched, so a root-placed wrapper feeds its body that field too — while a nested
// one does not, and no type can see which. A body that declares it honestly (the kind tier's
// workflows do) must NOT be told to widen its door: the field is host-supplied, never sent, never
// served (ADR-0033). So the guard adds those keys to what it counts as PROVIDED.
const wantsHostInjection = bodyTakingInput<Workspaced<Door, "app"> & HostInjectedInput>();
void workspace(wantsHostInjection, { input: door, repos, spec: ({ input }) => specOf(input) });
// Exactly those keys and no more: one extra field beside them is still rejected, so the carve-out
// is not a hole in claim 1.
const wantsMoreThanHostInjection = bodyTakingInput<Workspaced<Door, "app"> & HostInjectedInput & { reason: string }>();
// @ts-expect-error `reason` is nobody's to inject — neither the door, the handles, nor the host
void workspace(wantsMoreThanHostInjection, { input: door, repos, spec: ({ input }) => specOf(input) });
// And the keys are still TYPED. Widening the provided side is what buys this: SUBTRACTING them
// from what the body demands (`Omit<InputFrom<TBody>, keyof HostInjectedInput>`) would drop the
// wrong declaration along with the key, and admit this.
const mistypesHostInjection = bodyTakingInput<Workspaced<Door, "app"> & { instanceId: number }>();
// @ts-expect-error the host injects an Instance ID string; a body asking for a number never gets one
void workspace(mistypesHostInjection, { input: door, repos, spec: ({ input }) => specOf(input) });

// A UNION input is checked member-by-member, for the same reason. Subtracting keys compares
// against a union's SHARED keys only, so `reason`/`other` would vanish from the check and every
// member could demand a field the door never carries — the exact hole claim 1 exists to close.
const unionDemandsMore = bodyTakingInput<
  Workspaced<Door & { reason: string }, "app"> | Workspaced<Door & { other: string }, "app">
>();
// @ts-expect-error no member of the union is satisfied by the door plus the handles
void workspace(unionDemandsMore, { input: door, repos, spec: ({ input }) => specOf(input) });
// A union whose members are each satisfied is still fine — one direction, as ever.
const unionNeedsLess = bodyTakingInput<Workspaced<{ repo: string }, "app"> | Workspaced<Door, "app">>();
void workspace(unionNeedsLess, { input: door, repos, spec: ({ input }) => specOf(input) });

// --- 9: a per-run slot's mapper reads the door, on the wrapper itself ---------------------------

// The slot seat is `SandboxOptions<TSlots, TInput>` threading the door into `RepoSlot<TInput>`.
// customize-types.test.ts pins the same mapper through `WorkspaceOf<M>` — a different seat — so a
// slip to `RepoSlot<any>` here would pass every other pin (a real Instance's mappers compile under
// `any`). The mapper's `input` is the PARSED door, uninstructed, and an open slot rides beside it.
const perRun = workspace(wantsApp, {
  input: door,
  repos: { app: ({ input }) => input.repo, docs: open },
  spec: ({ input }) => specOf(input),
});
// The per-run and open slots are slots like any other: the body is handed their handles too.
const mapperSlotsAreSlots: Eq<InputFrom<typeof perRun>, Door> = true;
void workspace(wantsDocs, {
  input: door,
  repos: { app: ({ input }) => ({ url: input.repo, ref: input.branch }), docs: open },
  spec: ({ input }) => specOf(input),
});
void workspace(wantsApp, {
  input: door,
  // @ts-expect-error `title` is not on this door — the mapper reads what the schema parses, nothing more
  repos: { app: ({ input }) => input.title },
  spec: ({ input }) => specOf(input),
});
void workspace(wantsApp, {
  input: door,
  // @ts-expect-error a mapper annotated against a shape the door does not serve is refused, like a body would be
  repos: { app: ({ input }: { input: { other: string } }) => input.other },
  spec: ({ input }) => specOf(input),
});
// No door declared → the mapper's `input` is `unknown`, the same honesty as `spec`'s (claim 7).
void workspace(ignoresHandles, {
  repos: {
    app: ({ input }) => {
      // @ts-expect-error nothing is known about what starts this wrapper; the mapper must narrow
      return input.repo;
    },
  },
  spec: () => ({ branch: "feat" }),
});
// And when the permissive path is annotated, the slot mapper and `spec` state the SAME thing.
void workspace(ignoresHandles, {
  repos: { app: ({ input }: { input: { ticket: Door } }) => input.ticket.repo },
  spec: ({ input }: { input: { ticket: Door } }) => specOf(input.ticket),
});

test("the door's type-level claims are the compiler's; this run pins the runtime half", () => {
  assert.equal(inputSchemaOf(wrapped), door, "the declared door rides the WRAPPER, not the body");
  assert.equal(inputSchemaOf(permissive), undefined, "no schema declared → the door stays permissive");
  assert.ok(
    doorIsTheInput &&
      bodyOutputIsTheOutput &&
      permissiveDoorIsUnknown &&
      annotatedInputFlows &&
      mapperSlotsAreSlots &&
      appPathIsAString,
  );
});
