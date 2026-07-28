# A turn that is over has an empty menu, not an error

[ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md) put the Agent's MCP surface in the Adapter and made it stateless
per connection: every `/mcp/:iid` request builds that turn's server from the Orchestrator's live registration. An iid
with no registration answered **HTTP 404** — the reasoning being that "no menu" and "an empty menu" are different
claims, and an Agent whose turn is over should be told the first one.

The reasoning was sound and the outcome was not, because of who else connects. flue re-runs a `defineAgent` initializer
whenever it needs a session for that agent instance — including the session it opens to write its own
`submission_aborted` advisory, **after** the turn ends. j2's initializer connects to the Adapter (`harness/boot.mjs`),
so every turn ended by [ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)'s abort produced:

```
[flue:submission-abort] Failed to record abort advisory for submission <id>
  StreamableHTTPError: ... {"error":"no live surface for agent ..."}  code: 404
```

That is the **happy path**. An Agent ending its turn by calling the tool that moves the Machine is the common case, so
the error fired on every successful turn. A signal that cries wolf on the happy path cannot also be the alarm: the one
case where the 404 meant something real — an Agent acting against a turn nobody waits on — became indistinguishable from
routine noise.

## Decision

- **A surface request for a dead iid is answered, not refused.** `serverForTurn` swallows `NoSurfaceError` from the
  surface read and returns a server with **zero tools**. The Harness connects, lists nothing, and gets on with whatever
  it opened the session for.
- **Acting against a dead turn still fails, and that is where the claim belongs.** Nothing is registered, so a
  `tools/call` is an unknown tool; and the delivery path keeps its own `NoSurfaceError`, which is the check that
  actually matters — the difference between listing and acting is the difference between asking and doing.
- **`GET /agents/:iid/surface` on the Orchestrator stays 404.** It is a plain REST resource with no transport
  reinterpreting its status, and it is what the mechanics tier asserts against. Only the Adapter's MCP endpoint changes.
- **404 was the wrong status for this endpoint regardless.** In Streamable HTTP it is how a server says _your session
  expired, reinitialize_ — so "your turn is over" was an application claim wearing a transport signal's clothes.

## Considered options

- **Leave it and filter the log.** Rejected: the noise is a symptom. The Adapter is answering a well-formed question
  ("what can I call?") with an error, and the true answer — nothing — is one it can give.
- **Hold the registration open one extra round trip** so the advisory's connect finds a live surface. Rejected: it makes
  turn lifetime depend on an internal detail of how flue opens sessions, and any window is a guess.
- **Distinguish the advisory's connect from a real turn's.** Rejected as impossible: it is the same initializer, the
  same URL, the same request. There is nothing on the wire to branch on.
- **Serve a tombstone tool** (`your_turn_is_over`) instead of an empty list. Rejected: it hands a model something to
  call at the exact moment the goal is that it stop calling things.

## Consequences

- **The Adapter's error log means something again.** Any 500 from `/mcp/:iid` is now a genuine fault — the Orchestrator
  unreachable, or a turn declaring an event the Adapter refuses to serve (a `deferred`/`poll` def, ADR-0013).
- **flue's abort advisory records** instead of failing, so the abort is visible in the conversation timeline.
- **This fixes noise, not correctness.** The advisory failing was never the cause of anything: on the pinned
  `@flue/runtime` 1.0.0-beta.9, an abort that lands while the model is still _streaming_ a tool call strands that call
  and the conversation projection then drops the whole assistant message from later turns — and it does so identically
  when the advisory succeeds. That defect is flue's, is fixed on its unreleased line, and is covered separately by the
  wire-contract check; it is recorded here only so this ADR is not mistaken for its remedy.
- **An Agent that connects at turn start to an already-dead iid now sees an empty menu rather than a connect failure.**
  That race means the state exited before the Harness dialed, so the turn was already over and ADR-0024 aborts it; an
  empty menu describes it accurately.
