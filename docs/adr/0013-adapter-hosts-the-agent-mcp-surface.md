# The Agent's MCP surface lives in the Sandbox, not the Orchestrator

An earlier cut put the Agent's tool surface on the Orchestrator (`/mcp/:instanceId`), which meant an Agent must dial
**into** the control plane to drive its Machine. Validating the workspace slice on kind (2026-07-12) showed that leg did
not exist and could not be safely built as specified: nothing passed a callback URL into a Sandbox, `j2 dev` bound
loopback, and — the real problem — an Agent that can reach the delivery API can deliver to **any** registration in its
run, including its own human-review Gate. So the MCP server lives **in the Sandbox**: a j2-owned **Adapter** sidecar
serves the current turn's menu to the Agent over `localhost` and forwards its picks to the Orchestrator, which speaks no
MCP at all and keeps one HTTP surface over the registration table it already has (ADR-0011).

## What flue makes possible (the enabling fact)

`defineAgent(initialize)` is an **initializer, not a constructor**: flue calls it on **every submission**, and the
initializer context carries `{ id, env }` — where `id` **is** the agent instance id (j2's Instance ID). Meanwhile
`connectMcpServer(name, { url })` lists an MCP server's tools at connect and adapts them into flue tool definitions
(named `mcp__<name>__<tool>`, so the server key is visible to the model). So one static shim, identical for every Agent
— generated at pod start by the stock Harness image's boot assembly (ADR-0018), never written by users — gets a
state-scoped menu for free:

```ts
export default defineAgent(async ({ id }) => ({
  ...definition, // the instance's plain-data Agent definition
  tools: (await connectMcpServer("j2", { url: `${process.env.J2_ADAPTER_URL}/mcp/${id}` })).tools,
}));
```

The Harness names the iid itself, so the Adapter never has to _learn_ which turn is live — no push channel, no
long-poll, no `sandbox → active turn` index, no second inbound port on the pod. And because flue re-initializes (and so
re-lists) per submission while a j2 menu only changes at turn boundaries, no `list_changed` push is needed either
(ADR-0006).

## Decision

- **The Adapter is a j2-owned container in the Sandbox pod** (ADR-0005). It hosts the MCP server the Agent's Harness
  connects to on `localhost`, and it is the **only** thing in the pod that talks to the Orchestrator. The Agent's sole
  control-plane peer is a process it can reach but whose credential it cannot read.
- **It is a separate container from the Harness, and that is the whole point.** `local()` tools give the Agent code
  execution _in the Harness container_ — so a credential there is a credential the Agent holds. Split, and the Agent is
  confined to a `localhost` menu the Machine set for the turn it is already in. This is what makes ADR-0006's "the Agent
  never steers the workflow" **enforced** rather than advertised.
- **The Orchestrator hosts no MCP.** The registration table stays the one internal primitive; it keeps two thin HTTP
  adapters, neither of them MCP:

  ```
  # human / webhook / CI — the Gate resource of ADR-0011, authenticated
  GET  /runs/:id                       → open gates: accepts + schemas + meta     [Instance token]
  POST /runs/:id/gates/:gate/events    → validate + deliver                       [Instance token]

  # the Adapter's surface
  GET  /agents/:iid/surface            → accepts + schemas + semantics            [Sandbox token]
  POST /agents/:iid/events             → validate + deliver → { deliveryId }      [Sandbox token]
  ```

  The receipt grew in [ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md):
  `{ delivered, event, turnComplete, deliveryId }`, rendered as prose by the Adapter. `deliveryId` is unchanged and
  still the room a deferred result will need.

  The Adapter renders `/agents/:iid/surface` as `tools/list` and a `tools/call` as `POST …/events`. Lookup, validation,
  delivery, and lifecycle stay implemented once, in the table.

  An iid with no live registration used to make the Adapter's `/mcp/:iid` answer 404. It now serves an **empty menu**
  ([ADR-0026](0026-a-turn-that-is-over-has-an-empty-menu.md)) — the Harness re-connects after the turn ends, so the
  refusal fired on every successful turn. The Orchestrator's own `GET /agents/:iid/surface` above is unchanged.

- **Bearer tokens, because the boundary is otherwise theater.** The Harness container shares the pod's network
  namespace, so an Agent can `curl` the Orchestrator directly; a per-pod NetworkPolicy cannot distinguish it from the
  Adapter. Only authentication closes this.
  - **Sandbox token** — minted per Sandbox at provision (a signed Sandbox name, so re-provision after a restart yields
    the same token), delivered as a Secret via the CR's `envFrom` into the **Adapter container only** — user
    `sandbox.env`/`envFrom` land on the Harness container, never the Adapter. Authorizes exactly: deliver to agent
    registrations **whose Sandbox is this one**. Never a Gate (they are not on that surface at all), never another
    Sandbox.
  - **Instance token** — the human/CLI credential for Gates and run control. Minted into an in-cluster Secret at
    `j2 up`; the CLI reads it over the kube API (RBAC is the gate) while port-forwarding the Service (ADR-0019).
  - An agent registration records its Sandbox **ambiently**: `agentRun` resolves the enclosing `workspace()` and records
    the same deterministic name the token was minted for (ADR-0016), so forgetting to pass it is unrepresentable (the
    pre-ambient version shipped exactly that footgun: `sandbox` omitted, every tool call 403'd — fail-closed but
    silent). A run-scoped token instead of a Sandbox-scoped one would be genuinely exploitable: derivable iids plus
    readable ticket ids would let one feature's coder inject a `review_verdict` into another feature's reviewer.
- **Reachability, narrowed to one caller.** The Orchestrator is always in-cluster (ADR-0019), so the route home is
  simply **Service DNS**; the Sandbox CR carries it to the Adapter as env (`J2_ORCHESTRATOR_URL`). The Agent still never
  makes this call: the Adapter does.
- **Deferred tool results are reserved, not built.** ADR-0006's `deferred`/`poll` semantics stay in the model and the
  wire leaves room for them: the surface listing ships each def's `semantics` (so the Adapter can tell an awaiting tool
  from a fire-and-forget one), and an agent-surface delivery returns a **receipt with a `deliveryId`** (so an outcome is
  addressable after the fact; the gates surface answers `{ ok: true }` — external callers need no receipt). Registering
  a `deferred` or `poll` def **fails loudly as unimplemented** — a silent downgrade to `ack` would be a lying tool
  contract. How a _Machine_ answers a deferred call is deliberately left open: flue's 60 s MCP `timeoutMs` means the
  answer will be poll-with-progress, not a held socket (ADR-0002) — an Adapter concern when it lands.

## Considered options

- **Agent talks to the Orchestrator directly** (the original cut, plus a callback URL). Rejected: the credential lands
  in a container where the Agent has code execution, so the Agent can deliver `approve` to its own human-review Gate —
  it merges its own PR. The tool menu is advisory once you hold the key to the API.
- **Translation inside the flue Harness process** (it already knows the iid and the tools). Rejected for the same reason
  — same container, same code execution, same credential. And the knowledge locality is illusory: the menu originates in
  the _Machine_, so it must travel Orchestrator → pod regardless; hosting the server in the Harness only changes which
  container it lands in.
- **Adapter as a transparent MCP relay** (proxy `/mcp/:iid` to an Orchestrator MCP server, adding auth). Tempting
  because deferred results would work for free. Rejected: it keeps the Orchestrator bilingual and keeps the MCP
  transport in the control plane, while still requiring the separate container for the credential — so it pays the
  Adapter's full cost and collects none of the simplification.
- **A uniform `/registrations/:address` API** for every caller. Rejected: it dissolves the run-scoped, discoverable Gate
  resource ADR-0011 designed on purpose (a webhook translator finds its Gate by `meta.prUrl`; `GET /runs/:id` lists open
  decisions) in exchange for aesthetic symmetry. The win here is "no MCP in the Orchestrator", not "one URL".

## Consequences

- **The operator needs no change.** ADR-0001 made sidecars generic container fragments the operator schedules without
  understanding; the Adapter is exactly that. `kubectlSandbox` injects it (plus the token Secret, minted before the CR
  so the pod never waits on it, and owner-ref'd to the CR so Kubernetes reaps it with the Sandbox).
- **The Orchestrator carries no MCP dependency**; the Adapter (its own package + published image,
  `j2-adapter:<kitversion>` — ADR-0019) does.
- **The `@kind` e2e tier owns the pod → Orchestrator leg** — the dev Harness image carries a scripted agent that
  actually calls its tool through the Adapter, so a broken leg is a red test. The mechanics tier plays `/agents/:iid/*`
  from the host, which is honestly simulating the Adapter, not an Agent.
- **NetworkPolicy (ADR-0001's next isolation layer) is still wanted, but it is not the control.** It bounds where the
  pod may talk; only the token bounds what it may _do_.
- **Open: authn for non-kube callers.** The Instance token rides kube RBAC for anyone with cluster creds; what an
  ingress-exposed j2 Application uses for human/webhook callers without them (`--url` mode) is out of scope here
  (ADR-0014 inherits the same question).
