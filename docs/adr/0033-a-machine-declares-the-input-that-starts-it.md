# A Machine declares the input that starts it

`POST /workflows/:name/runs` takes a JSON body and hands it to the machine as xstate `input` — unvalidated, and
undescribed: the module contract is `export const machine` alone (ADR-0011/0015), so nothing at runtime says what a run
of a given workflow should be started _with_. The Console's start form
([ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)) forced the question, but the gap predates it —
`j2 run` has the same blindness, and a typo'd input surfaces as a confusing mid-run failure instead of a refusal at the
door. Meanwhile every event a machine _accepts_ already carries a zod schema, attached to the machine object itself
([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)'s vocabulary-on-the-machine). The input that starts a
machine is the one piece of its vocabulary that pattern missed.

## Decision

- **The schema rides the machine object, like the rest of the vocabulary.** `j2Setup.createMachine` accepts an `input`
  (a zod object) and attaches it the same way event defs ride today (WeakMap-keyed on the machine object). `workspace`
  propagates the body's schema onto the wrapper it returns, exactly as it propagates vocabulary — its wrapper hands the
  run input to the body untouched, so the body's contract IS the door's. `pool` does not (amended): a worker is fed
  per-item, never the run body, so propagating its schema would demand fields the pool never passes and strip the
  pool-level fields `cap`/`itemInput` read; a pool declares its own door via `PoolSpec.input`. `input` is deliberately
  xstate's own word for what a machine receives at creation — the authoring surface teaches nothing new.
- **The schema is structure, so it is open.** Workflow-detail JSON (`GET /workflows/:name`, the address ADR-0032's
  negotiation kept) serves it as JSON Schema — same band as the Machine doc, and what drives the Console's start form
  before any token is entered. The _submit_ stays `authenticated`; schema open, trigger guarded.
- **A declared schema is enforced at the door.** `POST /workflows/:name/runs` validates the body and 400s naming the
  accepted shape — parity with what Gates already do for deliveries. No schema declared → accept anything (today's
  behavior), and the Console falls back from a generated form to a raw-JSON textarea.

## Considered options

- **`export const input` beside `export const machine`.** Rejected: it re-opens what ADR-0015 closed — a workflow's
  self-description split across module exports, and the factories would have nothing to propagate for a wrapped machine
  whose input contract belongs to its body.
- **Derive from xstate's `types.input`.** Impossible: TypeScript types are erased; there is nothing at runtime to serve
  or validate with.
- **Require a schema on every workflow.** Rejected: it taxes the zero-ceremony hello-world for a guarantee only
  input-taking workflows need. Absence is permissive, and permissive is what the wire already was.

## Consequences

- **Both entry points sharpen for free**: the Console generates its form from the same JSON Schema `j2 run` can later
  use to refuse bad input client-side before the POST.
- **The open band grows a schema and nothing else** — the same class of thing as the Machine doc it sits beside;
  ADR-0014's projection is untouched.
- **Validation parity means error parity**: a bad run start and a bad gate delivery now fail the same way, a 400 naming
  what is accepted.
