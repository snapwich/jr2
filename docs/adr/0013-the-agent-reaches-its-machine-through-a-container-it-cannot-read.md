# The Agent reaches its Machine through a container it cannot read

An earlier cut put the Agent's tool surface on the Orchestrator (`/mcp/:instanceId`), which meant an Agent must dial
**into** the control plane to drive its Machine. Validating the workspace slice on kind (2026-07-12) showed that leg did
not exist and could not be safely built as specified: nothing passed a callback URL into a Sandbox, `jr2 dev` bound
loopback, and — the real problem — an Agent that can reach the delivery API can deliver to **any** registration in its
run, including its own human-review Gate. The fix is not to hide the API from the Agent. Working tools give the Agent
code execution in the Harness container, which shares the pod's network namespace, so it can reach any address the pod
can. The fix is where the credential lives: in a container of the same pod that the Agent executes nothing in — the
**Custodian** ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). The Orchestrator speaks
no MCP, and keeps one HTTP surface over the registration table it already has
([ADR-0011](0011-workflow-defined-events.md)).

## The enabling fact: the Harness reads its Menu per Submission

Each Submission, the Harness reads `GET /agents/<iid>/surface` and presents the answer to its model as the turn's Menu,
as tools named `mcp__jr2__<event>` (shipped instructions and the printer's prefix-stripping depend on that name;
[ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md) states it as explicit jr2 code, never
written by users). The Harness names the iid itself, so nothing has to _learn_ which turn is live — no push channel, no
long-poll, no `sandbox → active turn` index, no second inbound port on the pod. And because the Harness re-reads per
Submission while a jr2 menu only changes at turn boundaries, no `list_changed` push is needed either (ADR-0006).

## Decision

- **The Custodian carries the Agent's Menu, and holds the credential that makes it work.** It is a jr2-composed
  container in every Harness pod ([ADR-0005](0005-sandbox-pod-composition.md)). The Sandbox token is mounted into it as
  a file, and into no other container. The Harness container holds the token's Stand-in,
  `JR2_SANDBOX_TOKEN=jr2-held-JR2_SANDBOX_TOKEN`, and reaches the Orchestrator only through the Custodian's control
  listener on `127.0.0.1:8081`. The Custodian forwards three routes, with the token put in place of the Stand-in, and
  answers every other route itself:

  ```
  GET  /agents/<iid>/surface   the Menu                                   → the Orchestrator
  POST /agents/<iid>/events    a pick                                     → the Orchestrator
  POST /fetch                  the ask (ADR-0053), for THIS pod's Sandbox → POST /sandboxes/<name>/fetch
  anything else                404
  ```

  So the Agent's sole control-plane peer is a container it can reach but whose credential it cannot read. That is what
  makes ADR-0006's "the Agent never steers the workflow" **enforced** rather than advertised.

- **The Harness presents the Menu to its model itself.** There is no MCP server and no MCP client. `menu.ts` turns each
  accepted event into a pi tool, with the event's JSON Schema as its parameters, and turns a call into one
  `POST …/events`. The receipt comes back as prose
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)). A 404 on the surface is an empty Menu
  ([ADR-0026](0026-a-turn-that-is-over-has-an-empty-menu.md)).
- **The Orchestrator hosts no MCP, and judges every pick.** The registration table stays the one internal primitive; it
  keeps two thin HTTP surfaces, neither of them MCP:

  ```
  # human / webhook / CI — the Gate resource of ADR-0011, authenticated
  GET  /runs/:id                       → open gates: accepts + schemas + meta     [Instance token]
  POST /runs/:id/gates/:gate/events    → validate + deliver                       [Instance token]

  # the Agent's, through its pod's Custodian
  GET  /agents/:iid/surface            → accepts + schemas + semantics            [Sandbox token]
  POST /agents/:iid/events             → validate + deliver → the receipt          [Sandbox token]
  ```

  The receipt is `{ delivered, event, moved, turnComplete, deliveryId }`. `deliveryId` is still the room a deferred
  result will need. Lookup, validation, delivery and lifecycle are implemented once, in the table. The token's scope,
  the live registration, and the event's name and payload are judged here and nowhere else; the Custodian forwards and
  decides nothing about a pick.

- **Bearer tokens, because the boundary is otherwise theater.** The Harness container shares the pod's network
  namespace, so an Agent can `curl` the Orchestrator directly; a per-pod NetworkPolicy cannot distinguish it from the
  Custodian. Only authentication closes this.
  - **Sandbox token** — minted per Sandbox at provision (a signed Sandbox name, so re-provision after a restart yields
    the same token), delivered as a Secret mounted into the **Custodian container only**. User `harness.env`/`envFrom`
    land on the Harness container, never the Custodian. Authorizes exactly: deliver to agent registrations **whose
    Sandbox is this one**, and ask for this Sandbox's fetch. Never a Gate (they are not on that surface at all), never
    another Sandbox. The Stand-in the Harness holds is refused on every route.
  - **Instance token** — the human/CLI credential for Gates and run control. Minted into an in-cluster Secret at
    `jr2 up`; the CLI reads it over the kube API (RBAC is the gate) while port-forwarding the Service (ADR-0019).
  - An agent registration records its Sandbox **ambiently**: `agentRun` resolves the enclosing `workspace()` and records
    the same deterministic name the token was minted for (ADR-0016), so forgetting to pass it is unrepresentable (the
    pre-ambient version shipped exactly that footgun: `sandbox` omitted, every tool call 403'd — fail-closed but
    silent). A run-scoped token instead of a Sandbox-scoped one would be genuinely exploitable: derivable iids plus
    readable ticket ids would let one feature's coder inject a `review_verdict` into another feature's reviewer.
- **Reachability, narrowed to one caller.** The Orchestrator is always in-cluster (ADR-0019), so the route home is
  simply **Service DNS**, which `jr2 up` writes into the Custodian's configuration. The Harness is told the Custodian's
  loopback address (`JR2_CUSTODIAN_URL`) and nothing else.
- **Deferred tool results are reserved, not built.** ADR-0006's `deferred`/`poll` semantics stay in the model and the
  wire leaves room for them: the surface listing ships each def's `semantics`, and an agent-surface delivery returns a
  **receipt with a `deliveryId`** (so an outcome is addressable after the fact; the gates surface answers `{ ok: true }`
  — external callers need no receipt). Registering a `deferred` or `poll` def **fails loudly as unimplemented** — a
  silent downgrade to `ack` would be a lying tool contract — and the Harness refuses a turn whose surface offers one.

## Considered options

- **Agent talks to the Orchestrator directly** (the original cut, plus a callback URL). Rejected: the credential lands
  in a container where the Agent has code execution, so the Agent can deliver `approve` to its own human-review Gate —
  it merges its own PR. The tool menu is advisory once you hold the key to the API.
- **A jr2-owned Adapter container that serves the Menu over MCP on loopback and holds the token.** It meets the claim,
  but a whole container, image and package exist to translate two HTTP calls into MCP and back. Model keys need a
  container the Agent executes nothing in anyway (ADR-0059); one container can hold every credential, and the
  translation then has no reason to live outside the Harness.
- **Translation inside the Harness, with the credential there too.** Rejected — same container, same code execution,
  same credential. The translation is inside the Harness now; the credential is not.
- **The Orchestrator serves MCP, and the Custodian forwards it.** Rejected: it keeps the MCP transport and its session
  handling in the control plane and on both ends, to carry two plain HTTP calls.
- **A uniform `/registrations/:address` API** for every caller. Rejected: it dissolves the run-scoped, discoverable Gate
  resource ADR-0011 designed on purpose (a webhook translator finds its Gate by `meta.prUrl`; `GET /runs/:id` lists open
  decisions) in exchange for aesthetic symmetry.

## Consequences

- **The operator needs no change.** ADR-0001 made sidecars generic container fragments the operator schedules without
  understanding; the Custodian is exactly that. `kubectlSandbox` composes it (plus the token Secret, minted before the
  CR so the pod never waits on it, and owner-ref'd to the CR so Kubernetes reaps it with the Sandbox).
- **Nothing in jr2 speaks MCP.** The Orchestrator, the Harness and the CLI carry no MCP dependency.
- **One container holds the Sandbox token and every model key.** A fault in the Custodian's engine is a fault in the one
  container that holds both. ADR-0059 records the trade.
- **The `@kind` e2e tier owns the pod → Orchestrator leg** — the pod's Harness actually calls its tool through the
  Custodian, so a broken leg is a red test, and a Harness container that posts a pick straight to the Orchestrator with
  the Stand-in it holds is refused. The mechanics tier plays `/agents/:iid/*` from the host, which is honestly
  simulating the Harness's Menu, not an Agent.
- **NetworkPolicy is a second layer, not the control.** It bounds where a pod may talk; only the token bounds what it
  may _do_. `jr2 up` converges ingress policies that admit only the Orchestrator to a Harness pod
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)); the Orchestrator itself is left reachable, because a
  Custodian in every Harness pod must reach it and no policy can tell the Custodian's packets from the Agent's.
- **The Harness wire is authenticated in the other direction.** The Orchestrator bears a token derived for the placement
  on every Harness call, and the Harness holds only its digest (ADR-0058). Same signed-name idea, reversed caller.
- **Open: authn for non-kube callers.** The Instance token rides kube RBAC for anyone with cluster creds; what an
  ingress-exposed jr2 Application uses for human/webhook callers without them (`--url` mode) is out of scope here
  (ADR-0014 inherits the same question).
