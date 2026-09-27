# A turn that is over has an empty menu, not an error

The Harness reads its Menu at the start of each Submission: `GET /agents/<iid>/surface`, through the pod's Custodian
([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)). An iid with no registration
answers **HTTP 404** — and there was a reasonable case that the Harness should treat that as a failure, because "no
menu" and "an empty menu" are different claims, and an Agent whose turn is over should be told the first one.

The case was sound and the outcome is not, because of when reads happen. A state can exit before the read lands — an
`after:` timeout on the agent state, an ancestor or sibling transition,
[ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)'s abort racing the read. A refusal then answers
a well-formed question — "what can I call?" — with a failure on a path where nothing is wrong, and settles the
Submission `failed`. A signal that cries wolf cannot also be the alarm: the one case where the 404 means something real
— an Agent acting against a turn nobody waits on — becomes indistinguishable from routine noise.

## Decision

- **A surface read for a dead iid is answered, not refused.** The Harness reads a 404 as a Menu with **zero tools** and
  gets on with the turn it opened — which ADR-0024 is already ending.
- **Acting against a dead turn still fails, and that is where the claim belongs.** A pick delivered after the state
  moved on gets 404 on `POST /agents/:iid/events`, and the Harness throws it to the model as a tool error ("this turn is
  over") — the difference between listing and acting is the difference between asking and doing.
- **`GET /agents/:iid/surface` on the Orchestrator stays 404.** It is a plain REST resource, and it is what the
  mechanics tier asserts against. Only the Harness's reading of it is the empty Menu.

## Considered options

- **Settle the turn `failed` and filter the log.** Rejected: the noise is a symptom. The read asks a well-formed
  question ("what can I call?"), and the true answer — nothing — is one the Harness can give.
- **Hold the registration open one extra round trip** so a late read finds a live surface. Rejected: it makes turn
  lifetime depend on connection-timing internals, and any window is a guess.
- **Serve a tombstone tool** (`your_turn_is_over`) instead of an empty list. Rejected: it hands a model something to
  call at the exact moment the goal is that it stop calling things.

## Consequences

- **A failed Menu read means something.** Any other failure — the Orchestrator never answered after the ADR-0042 ladder,
  a 403, or a turn offering an event the Harness refuses to present (a `deferred`/`poll` def, ADR-0013) — settles the
  Submission `failed` before the model is asked.
- **An Agent whose turn is dead at start sees an empty Menu rather than a failure.** That race means the state exited
  before the Harness read, so the turn was already over and ADR-0024 aborts it; an empty Menu describes it accurately.
