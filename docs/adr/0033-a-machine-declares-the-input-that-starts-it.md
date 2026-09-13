# A Machine declares the input that starts it

`POST /workflows/:name/runs` takes a JSON body and hands it to the machine as xstate `input` — unvalidated, and
undescribed: the module contract is `export const machine` alone (ADR-0011/0015), so nothing at runtime says what a run
of a given workflow should be started _with_. The Console's start form
([ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)) forced the question, but the gap predates it —
`j2 run` has the same blindness, and a typo'd input surfaces as a confusing mid-run failure instead of a refusal at the
door. Meanwhile every event a machine _accepts_ already carries a zod schema, attached to the machine itself
([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)'s vocabulary-on-the-machine). The input that starts a
machine is the one piece of its vocabulary that pattern missed.

## Decision

- **The schema rides the machine, like the rest of the vocabulary.** `j2Setup.createMachine` accepts an `input` (a zod
  object) and attaches it the same way event defs ride today (WeakMap-keyed on `machine.config`, so a `.provide()` clone
  keeps it — ADR-0011). `input` is deliberately xstate's own word for what a machine receives at creation — the
  authoring surface teaches nothing new.
- **A wrapper declares its own door; it never borrows its child's.** `workspace(body, { input, spec })` and
  `pool(worker, { input, … })` each take an `input` of their own, and neither propagates one upward. The reason is the
  same in both, at different strengths: a wrapper does not feed its child what a caller sent. `pool` is the sharp case —
  a worker is fed per-item, never the run body, so propagating its schema would demand fields the pool never passes and
  strip the pool-level fields `cap`/`itemInput` read. `workspace` is the mild one — its body gets the run input _plus_
  the injected `workspace` handles, so the body's contract is the door PLUS a field no caller can send (the handles do
  not exist until a Sandbox is provisioned and attached). Propagating it would make `createMachine({ input })` mean "my
  input" on a bare machine and "my input minus what my wrapper injects" on a wrapped body — a context-dependent
  contract, and a trap: a body that declared its input honestly, handles included, would 400 every valid run start. The
  vocabulary does not propagate either — event names resolve against the Machine that invoked the actor, so a body keeps
  its own defs and nothing is merged upward (ADR-0011, ADR-0049). The door is one more part a Machine carries and scopes
  to itself. The composition the body needs a name for is exported instead:
  `Workspaced<T, Slot> = T & { workspace: WorkspaceHandles<Slot> }`, the handles keyed by the Repo Slots the body names
  (ADR-0050, ADR-0051). A body that _still_ declares a schema is refused by `workspace()` with a message naming the fix:
  nothing would ever serve or validate it, and a contract nobody enforces is worse than none.
- **The door types the mapping, and constrains the body.** `WorkspaceOptions.spec` reads its `input` from the declared
  schema (`z.infer`), so a workflow states its shape once and the workspace mapping is checked against it — the drift
  this ADR exists to close, closed in the one place that used to re-declare the shape by hand. The same schema checks
  the _body_, in **one direction only**: the body may not demand more than the wrapper will hand it, which is
  `Workspaced<door, slots>`; demanding _less_ is safe, because it is fed a superset. So a body reading a field the door
  never carries is a build error at the `workspace()` call instead of an `undefined` mid-run. One field sits outside
  that check, named as `HostInjectedInput`: the host adds `instanceId` to the input of the machine a run _starts_ with,
  so a root-placed wrapper hands its body the door, the handles, _and_ that — while a nested one does not, and no type
  can see which. It is not door material either (no caller sends it, `start` overwrites it after the parse, nothing
  serves it), so widening the door would be the wrong fix. The guard takes the permissive answer: it counts those keys
  as _provided_, so a body may declare the field honestly. Counting them as provided rather than subtracting them from
  what the body demands is deliberate — subtraction would drop the keys from the comparison and with them two cases the
  check owns: a body that mistypes `instanceId`, and a body whose input is a union, which subtraction compares on its
  members' shared keys alone. The typed wrapper also checks the seam above it — a parent invoking a nested `workspace()`
  has its input mapper checked against that wrapper's door, and gets the body's output typed back. With no schema
  declared the door is permissive, so there is nothing to infer and the mapper's argument is `unknown` — an honest "j2
  does not know", not `any`; a wrapper fed by something other than a caller (a pool worker) states what it is fed by
  annotating the parameter, as `PoolSpec.cap`/`itemInput` do.
- **The schema is structure, so it is open.** Workflow-detail JSON (`GET /workflows/:name`, the address ADR-0032's
  negotiation kept) serves it as JSON Schema — same band as the Machine doc, and what drives the Console's start form
  before any token is entered. The _submit_ stays `authenticated`; schema open, trigger guarded.
- **A declared schema is enforced at the door.** `POST /workflows/:name/runs` validates the body and 400s naming the
  accepted shape — parity with what Gates already do for deliveries. No schema declared → accept anything (today's
  behavior), and the Console falls back from a generated form to a raw-JSON textarea.

## Considered options

- **`export const input` beside `export const machine`.** Rejected: it re-opens what ADR-0015 closed — a workflow's
  self-description split across module exports, when the machine object already carries every other piece of the
  workflow's self-description.
- **`workspace` propagates its body's schema onto the wrapper** (the shape this ADR first took, before `pool` forced the
  question and `workspace` turned out to be the same species). Rejected: the wrapper's pass-through is not the body's
  input — the body also gets the injected `workspace` field — so the propagated schema is right only for a body that
  under-declares its own contract. Two ways to declare one door also cost more than the line of ceremony they save: an
  author reading a wrapped workflow could not tell, without opening the factory, which declaration the runtime serves.
- **Derive from xstate's `types.input`.** Impossible: TypeScript types are erased; there is nothing at runtime to serve
  or validate with.
- **Constrain the body by pinning its `TInput` slot** (`body: StateMachine<…, Workspaced<door, slots>, …>`). Rejected as
  unsound, not as style: `StateMachine`'s members include methods, method parameters are bivariant, and a body demanding
  _more_ than the door provides therefore compiles — the one case the constraint exists to catch. The shipped
  formulation intersects the body with a conditional guard whose failure branch is an object type keyed by the sentence
  to read, so the diagnostic names the fix rather than printing a structural diff.
- **Require a schema on every workflow.** Rejected: it taxes the zero-ceremony hello-world for a guarantee only
  input-taking workflows need. Absence is permissive, and permissive is what the wire already was.

## Consequences

- **Both entry points sharpen for free**: the Console generates its form from the same JSON Schema `j2 run` can later
  use to refuse bad input client-side before the POST.
- **The open band grows a schema and nothing else** — the same class of thing as the Machine doc it sits beside;
  ADR-0014's projection is untouched.
- **Validation parity means error parity**: a bad run start and a bad gate delivery now fail the same way, a 400 naming
  what is accepted.
