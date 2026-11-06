# Observation is open; run state and control need a Caller's scope

[ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md) minted two tokens and scoped them
for **delivery** — a Sandbox token may deliver to its own agent registrations, an Instance token may deliver to gates.
It said nothing about who may **read** a run or **cancel** one, and the code took the obvious shortcut: `authenticated`,
meaning any token we minted. That is a hole. It also left the visualizer with no way in at all, which is the same
question from the other side.

Building `jr2 visualize` (the Machine renderer and its live run highlighting) forced both halves at once: the page is a
**browser**, and a browser holds no token. So this ADR splits the HTTP surface into **three bands**, and adds an
**observation projection** — the page gets a view instead of a credential.

## Decision

**Three bands, and the middleware is what says which.**

```
open           /workflows, /workflows/:name/machine, /viz/*        structure
               /console/config (the login's issuers, ADR-0032)     public values
               /workflows/:name/runs, …/runs/:runId/events         OBSERVATION (new)
authenticated  /agents/:iid/*                                      the Agent's surface  [Sandbox token]
guarded        each route below, opened by one scope of a Caller   run state + control  [a Caller, ADR-0078]
```

- **Run state and run control are a Caller's, and each route needs one scope.** `authenticated` accepts _any_ token we
  minted, so a Sandbox token — the one credential that sits in a pod an Agent shares a network namespace with — could
  read **every** run's context (other features' branches, ticket bodies, review verdicts, Harness endpoints) and
  **CANCEL any run**. Neither is on the Agent's surface, no more than a gate is: ADR-0013 scopes that token to
  delivering into registrations recorded against its _own_ Sandbox. This closes the same class of hole ADR-0013 closed
  for gates, on the routes it did not name. The guarded band takes only a Caller
  ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)): a Sandbox token is never
  one. Each route of the band needs one scope, checked against the Workflow of the run or the door that it addresses:

  ```
  start    POST /workflows/:name/runs, POST /workflows/:wrapper/charts/:name/runs
  read     GET /runs (summaries of the runs of its Workflows, live and ended), GET /runs/:id (the whole status),
           GET /runs/:id/events, GET /runs/:id/conversations[/:iid[/events]] (the kept conversations, ADR-0023)
  answer   POST /runs/:id/gates/:gate/events, GET /gates (the open Gates it may answer), and the `gates` of GET /runs/:id
  cancel   POST /runs/:id/events (CANCEL)
  steer    POST /runs/:id/steering, GET /runs/:id/agents (the slot list { agent, open, steerable }, ADR-0002)
  ```

  `answer` alone opens a run's `gates` and their routing, and never its `context`: a person who answers a Gate reads the
  Gate's `meta`, which the author wrote for that person. So `GET /runs/:id` gives `read` the status and `answer` the
  `gates`; with `answer` alone the answer is the run's observation (below) and its `gates`. `GET /runs` leaves out the
  runs of the Workflows that the Caller may not read; it refuses no run, and refuses only a Caller with no `read` scope
  at all (ADR-0078). `answer` can name single Gates of a Workflow (ADR-0078). Then the gate POST refuses another Gate of
  that Workflow, and `GET /gates` (its entries are ADR-0011's) and the `gates` of `GET /runs/:id` list only the Gates
  that the Caller may answer. Neither gives the run's `context`. `GET /runs/resolve` answers ids to a Caller with any
  scope, for the Workflows of its scopes. `GET /whoami` answers any Caller. A route that no scope names stays the
  Instance token's: the runtime Chart routes (`PUT` and `DELETE /workflows/:wrapper/charts/:name`), `GET /repos`, a
  Hook's log (`GET /hooks/:name`, which can hold a payload's fields and a handler's words), and the Instance-token door
  on `/agents/:iid/*` (ADR-0013) except the conversation route, which takes only a control token
  ([ADR-0023](0023-the-harness-prints-the-conversation.md)). `POST /hooks/:name` is outside the bands: the Hook's own
  verifier authenticates it ([ADR-0011](0011-workflow-defined-events.md)). The band is named for what it checks, not for
  a role — "operator" in this repo is the Kubernetes operator (ADR-0001).

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

- **Give the page a token.** It would be a credential — gates, cancel, every run's context — handed to whatever can load
  a URL. Putting it in `jr2.config.ts` (checked in) is worse still, and the token is minted per boot, so the page would
  not have it anyway. Rejected: the visualizer needs to _see_ a run, and seeing is not a subset of the credential that
  steers it. That mismatch is the whole reason a projection exists.
- **Keep `/runs*` on `authenticated` and filter in the handler.** Rejected: the guard would then depend on every future
  handler remembering to redact. The band is a middleware precisely so the default is refusal.
- **A fourth "observer" token.** Rejected: it buys nothing today (the observation surface carries no secret) and costs a
  minting, distribution, and revocation story. If observation ever needs to be _private_ — a deployed jr2 Application on
  a shared network — the guarded band and ADR-0078's scopes are already where it goes.

## Consequences

- **`auth.test.ts` changed its mind.** Its prose already said "Observation and control are the operator's, not the
  Agent's" directly above assertions that a Sandbox token gets **200** on a run read and **200** on CANCEL. Those are
  now **403**. The test pinned the hole.
- **The API is a cluster Service** (ADR-0019), so "open" means open to whoever can reach it — in-cluster peers, a
  port-forward, or an ingress — deliberately, since what is open is structure plus lit states. Anything that would
  embarrass a user if seen belongs in the guarded band, and that is where it is.
- **The CLI is unaffected.** It holds the Instance token from the in-cluster Secret (ADR-0019), which has every scope,
  and reads the guarded routes, as before.
- **A Caller without kube credentials is ADR-0078's:** a named token, a JWT, or a browser login. The band split holds
  for every Caller; what the guarded band checks is one scope for each route.

- **One scoped exception, and it does not live on this surface at all (ADR-0023).** The Harness prints each Agent's
  conversation — prompts, assistant text, thinking, tool calls, and the answer jr2 gave each Menu pick — to container
  stdout, which leaves the pod for the cluster's log plane and lands in front of a reader this document never gets to
  check. That is a real exception to the rule above, and it is stated rather than reasoned away. Two things bound it. It
  is **not a new band**: the HTTP surface is untouched, nothing here is served, and a reader gets it from
  `kubectl logs`, holding cluster log access instead of a jr2 credential. And **a Working tool's results are excluded**
  — the file contents, command output, API responses it returns never print, so the mechanical leak (an Agent `cat`s a
  config while debugging and its secrets ride a log shipper into 30-day retention) is off the table, leaving what an
  Agent reasons aloud and what jr2 answered its picks. What an Effector returns in that answer is scrubbed before it
  signs it as ADR-0068 claims: no secret the Effector holds, in the forms it sent or in common encodings. The scrub does
  not try to catch a transformed secret (a hash, a truncation, an encoding it does not list), a partial echo, or a side
  channel, and a credentialed command's child reads the secret its command names, so it can print that secret in such a
  form; then it prints there as the model read it. The answer also carries an Effect's output as the model read it: a
  `command` Effect's output prints there up to the bound, and a Held value an upstream echoed into that output prints
  with it (ADR-0023, ADR-0059). What remains, deliberately, is that on a shared cluster the population who can read an
  Agent's reasoning, and what its picks answered, is whoever can read pod logs. The Orchestrator's kept copy of the same
  conversation is not part of the exception: it is on this surface, behind `read`, and `jr2 logs` and the Console read
  it there (ADR-0023). Thus `read` opens the same residual of a pick's answer for as long as the run is kept
  (`runs.retain`, ADR-0065). If the pod-log audience becomes unacceptable, the print is what to turn off, and the record
  stays.

Evidence: `packages/orchestrator/src/http.ts` (the middlewares), `run-host.ts` (`observe` / `RunObservation` /
`RunChild`), `test/auth.test.ts` (the boundary), `test/callers.test.ts` (each scope on its routes),
`test/http-viz.test.ts` (a planted secret never reaches the feed, at any depth of the child tree).
