# A Turn that is over is never prompted, and only a Turn that is over answers 404

The Harness reads its surface at the start of each Submission: `GET /agents/<iid>/surface`, through the pod's Custodian
([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)). An iid with no registration
answers **HTTP 404**. The Orchestrator registers the surface before every admission — the first, a reroll's, and a
nudge's, which reuses the live one — and removes it only when the invocation ends, which sends
[ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)'s abort. So a 404 at the start of a Submission
is one race: the state exited (an `after:` timeout, an ancestor or sibling transition, the Agent's own pick) before the
read landed, and the abort is on its way.

This ADR's first form read that 404 as an empty Menu and prompted the model anyway. That spent a model call on a Turn
nobody waited on, wrote a dead Turn's prompt into a continued conversation's history, and — once the Menu became fixed
for a conversation ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)) —
presented a tools block that broke its cache.

One case broke the premise. A stopping Orchestrator stops its runs **before** it closes its listener (the feeds need
that order), and `hostStopping` removes their registrations with no abort, because ADR-0007's restore re-attaches. In
that window a surface read answered 404 for a Turn that was not over, and a pick was told "this turn is over". Both were
false: the Orchestrator was going away, not the Turn.

## Decision

- **A 404 at Submission start settles the Submission `aborted`, and the model is never asked.** Nothing is written to
  the conversation. It is not `failed`: nothing is wrong, and a signal that cries wolf cannot also be the alarm.
  ADR-0024 already says jr2 never observes the settlement of a Turn it aborted, so the Orchestrator side does not
  change.
- **Only a Turn that is over answers 404.** While its host is stopping, the Orchestrator answers `/agents/*` with
  **503**, not 404. The Harness treats a 503 on the surface read as unanswered and re-asks on ADR-0042's ladder, which
  outlasts a rollout; the restarted Orchestrator restores its runs before it listens, so the re-ask finds the live
  surface. A pick that gets 503 fails with "try it again", as a transport failure does — `deliver` still never retries
  on its own (ADR-0042).
- **Acting against a Turn that is over still fails loudly.** A pick delivered after the state moved on gets 404 on
  `POST /agents/:iid/events`, and the Harness throws it to the model as "this turn is over".
- **`GET /agents/:iid/surface` on the Orchestrator stays a plain REST resource,** 404 for no registration; the mechanics
  tier asserts against it.

## Considered options

- **Read the 404 as an empty Menu and prompt anyway** (this ADR's first form). Rejected: a model call and a history
  entry for a Turn that is over, and a tools block that differs from the conversation's Menu.
- **Keep the conversation's last Menu and state "Allowed picks: none".** Rejected: it presents a dead Turn more
  carefully instead of not presenting it.
- **Settle the Submission `failed`.** Rejected: the 404 is routine; a failure there hides the one that means something.
- **Hold the registration open one extra round trip.** Rejected: it makes Turn lifetime depend on connection timing, and
  any window is a guess.
- **Close the listener before stopping the runs.** Rejected: it would reorder shutdown against the feeds, and a Harness
  would see transport failures it already retries — the 503 says the same thing without moving shutdown.

## Consequences

- **A failed surface read means something.** An unanswered read past ADR-0042's window, a 403, or a surface offering an
  event the Harness refuses to present (a `deferred`/`poll` def, ADR-0013) settles the Submission `failed` before the
  model is asked.
- **An Orchestrator rollout no longer tells a live Turn it is over.** The surface read waits it out; a pick in the
  window is retried by the model on a clear transport-class error, and the no-signal nudge (ADR-0016) still catches a
  Turn that ended without one.
