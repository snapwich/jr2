# Observation is open; run state and control need the Instance token

[ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md) minted two tokens and scoped them for **delivery** — a Sandbox
token may deliver to its own agent registrations, an Instance token may deliver to gates. It said nothing about who may
**read** a run or **cancel** one, and the code took the obvious shortcut: `authenticated`, meaning any token we minted.
That is a hole. It also left the visualizer with no way in at all, which is the same question from the other side.

Building `j2 visualize` (the Machine renderer and its live run highlighting) forced both halves at once: the page is a
**browser**, and a browser holds no token. So this ADR splits the HTTP surface into **three bands**, and adds an
**observation projection** — the page gets a view instead of a credential.

## Decision

**Three bands, and the middleware is what says which.**

```
open           /workflows, /workflows/:name/machine, /viz/*        structure
               /workflows/:name/runs, …/runs/:runId/events         OBSERVATION (new)
authenticated  /agents/:iid/*                                      the Agent's surface  [Sandbox token]
instanceOnly   /runs, /runs/:id, /runs/:id/events (GET + POST)     run state + control  [Instance token]
               /runs/:id/gates/:gate/events                        gates (ADR-0011/0013)
```

- **Run state and run control are the Instance token's alone.** `authenticated` accepts _any_ token we minted, so a
  Sandbox token — the one credential that sits in a pod an Agent shares a network namespace with — could read **every**
  run's context (other features' branches, ticket bodies, review verdicts, Harness endpoints) and **CANCEL any run**.
  Neither is on the Agent's surface, no more than a gate is: ADR-0013 scopes that token to delivering into registrations
  recorded against its _own_ Sandbox. This closes the same class of hole ADR-0013 closed for gates, on the routes it did
  not name. The band is named for the credential it requires, not for a role — "operator" in this repo is the Kubernetes
  operator (ADR-0001).

- **The observer gets a PROJECTION, not a credential.** `RunObservation` is
  `{ runId, workflow, status, value, children }` — identity, and where in the Machine the run is. What is absent is the
  point: `context` is the workflow's working data, and `instanceId`/`fault` name live infrastructure and leak error
  text. A state `value` (and the `children` tree of state values below it) is a tree of state **keys** — it is
  structure, and structure is already open at `/workflows/:name/machine`. So an observer learns nothing here it could
  not read from the Machine doc, except **which states are lit**. `observe()` is the one place that line is drawn, and
  `RunChild` has no context field at any depth — the redaction surface cannot grow by forgetting.

- **Observation is scoped to one workflow**, because that is what an observer already knows (it is in the page's path).
  There is no listing of everything an Orchestrator happens to be running, and the feed serves **live runs only** —
  reading a settled run's terminal status through the store stays on `/runs/:id`, which is guarded.

- **An `emit`'s payload does not cross.** The observation feed carries an emit's `type` alone: an author's emit payload
  is author data, the same class of thing as context.

## Considered options

- **Give the page a token.** It would have to be the **Instance** token — gates, cancel, every run's context — handed to
  whatever can load a URL. Putting it in `j2.config.ts` (checked in) is worse still, and the token is minted per boot,
  so the page would not have it anyway. Rejected: the visualizer needs to _see_ a run, and seeing is not a subset of the
  credential that steers it. That mismatch is the whole reason a projection exists.
- **Keep `/runs*` on `authenticated` and filter in the handler.** Rejected: the guard would then depend on every future
  handler remembering to redact. The band is a middleware precisely so the default is refusal.
- **A fourth "observer" token.** Rejected: it buys nothing today (the observation surface carries no secret) and costs a
  minting, distribution, and revocation story. If observation ever needs to be _private_ — a deployed j2 Application on
  a shared network — that is the ADR to write, and it is the same open question ADR-0013 left about authn for non-kube
  callers.

## Consequences

- **`auth.test.ts` changed its mind.** Its prose already said "Observation and control are the operator's, not the
  Agent's" directly above assertions that a Sandbox token gets **200** on a run read and **200** on CANCEL. Those are
  now **403**. The test pinned the hole.
- **The API is a cluster Service** (ADR-0019), so "open" means open to whoever can reach it — in-cluster peers, a
  port-forward, or an ingress — deliberately, since what is open is structure plus lit states. Anything that would
  embarrass a user if seen belongs behind `instanceOnly`, and that is where it is.
- **The CLI is unaffected.** It holds the Instance token from the in-cluster Secret (ADR-0019) and reads the guarded
  routes, as before.
- **Open, inherited from ADR-0013:** what a deployed j2 Application uses for human callers. Whatever it is, the band
  split survives it — only the credential in the `instanceOnly` band changes.

- **One scoped exception, and it does not live on this surface at all (ADR-0023).** The Harness prints each Agent's
  conversation — prompts, assistant text, thinking, tool calls — to container stdout, which leaves the pod for the
  cluster's log plane and lands in front of a reader this document never gets to check. That is a real exception to the
  rule above, and it is stated rather than reasoned away. Two things bound it. It is **not a new band**: the HTTP
  surface is untouched, nothing here is served, and a reader gets it from `kubectl logs`, holding cluster log access
  instead of a j2 credential. And **tool results are excluded** — file contents, command output, API responses never
  print, so the mechanical leak (an Agent `cat`s a config while debugging and its secrets ride a log shipper into 30-day
  retention) is off the table, leaving only what an Agent reasons aloud. What remains, deliberately, is that on a shared
  cluster the population who can read an Agent's reasoning is whoever can read pod logs. If that becomes unacceptable,
  the fix is the read-through ADR-0023 declined to build — `instanceOnly`, on this surface, where the band already
  works.

Evidence: `packages/orchestrator/src/http.ts` (the three middlewares), `run-host.ts` (`observe` / `RunObservation` /
`RunChild`), `test/auth.test.ts` (the boundary), `test/http-viz.test.ts` (a planted secret never reaches the feed, at
any depth of the child tree).
