# The Agent's MCP surface lives in the Sandbox, not the Orchestrator

[ADR-0011](0011-workflow-defined-events.md) put the Agent's tool surface on the Orchestrator (`/mcp/:instanceId`), which
means an Agent must dial **into** the control plane to drive its Machine. Validating the workspace slice on kind
(2026-07-12) showed that leg does not exist and cannot be safely built as specified: nothing passes a callback URL into
a Sandbox, `j2 dev` binds loopback, and — the real problem — an Agent that can reach the delivery API can deliver to
**any** registration in its run, including its own human-review Gate. So we move the MCP server **into the Sandbox**: a
j2-owned **Adapter** sidecar serves the current turn's menu to the Agent over `localhost` and forwards its picks to the
Orchestrator, which stops speaking MCP entirely and keeps one HTTP surface over the registration table it already has.

## What flue makes possible (the enabling fact)

`defineAgent(initialize)` is an **initializer, not a constructor**: `openAgentSubmissionSession()` calls
`ctx.initializeRootHarness(agent)` on **every submission** (`packages/runtime/src/runtime/agent-submissions.ts`), and
the initializer context carries `{ id, env }` — where `id` **is** the agent instance id (j2's Instance ID). Meanwhile
`connectMcpServer({ url })` lists an MCP server's tools at connect and adapts them into flue tool definitions.

So one static persona template, identical for every Agent, gets a state-scoped menu for free:

```ts
export default defineAgent(async ({ id, env }) => ({
  model,
  instructions,
  tools: [await connectMcpServer({ url: `${env.J2_ADAPTER_URL}/mcp/${id}` })],
}));
```

The Harness names the iid itself, so the Adapter never has to _learn_ which turn is live — no push channel, no
long-poll, no `sandbox → active turn` index, no second inbound port on the pod.

**This corrects [ADR-0006](0006-agent-control-surface.md)'s mechanism.** It said state-scoped menus come from
"`tools/list`, refreshed with `list_changed` on transition". They don't need to: flue re-initializes (and so re-lists)
per submission, and a j2 menu only ever changes at turn boundaries. `list_changed` is unnecessary.

**[ADR-0014](0014-observation-is-open-run-state-is-not.md) finishes this one.** The tokens below are scoped for
**delivery** and say nothing about who may READ a run or CANCEL one; the code took "any token we minted", which handed a
Sandbox token every run's context and a kill switch. ADR-0014 splits the surface into three bands (open / any principal
/ Instance token) and adds the unauthenticated observation projection the visualizer reads.

## Decision

- **The Adapter is a j2-owned container in the Sandbox pod** (CONTEXT.md). It hosts the MCP server the Agent's Harness
  connects to on `localhost`, and it is the **only** thing in the pod that talks to the Orchestrator. The Agent's sole
  control-plane peer is a process it can reach but whose credential it cannot read.
- **It is a separate container from the Harness, and that is the whole point.** `local()` tools give the Agent code
  execution _in the Harness container_ — so a credential there is a credential the Agent holds. Split, and the Agent is
  confined to a `localhost` menu the Machine set for the turn it is already in. This is what makes ADR-0006's "the Agent
  never steers the workflow" **enforced** rather than advertised.
- **The Orchestrator drops its MCP mount.** The registration table stays the one internal primitive (`registration.ts`
  is already right about this); it keeps two thin HTTP adapters, neither of them MCP:

  ```
  # human / webhook / CI — the Gate resource of ADR-0011, unchanged, now authenticated
  GET  /runs/:id                       → open gates: accepts + schemas + meta     [Instance token]
  POST /runs/:id/gates/:gate/events    → validate + deliver                       [Instance token]

  # the Adapter — replaces /mcp/:instanceId
  GET  /agents/:iid/surface            → accepts + schemas + semantics            [Sandbox token]
  POST /agents/:iid/events             → validate + deliver → { deliveryId }      [Sandbox token]
  ```

  The Adapter renders `/agents/:iid/surface` as `tools/list` and a `tools/call` as `POST …/events`. Lookup, validation,
  delivery, and lifecycle stay implemented once, in the table.

- **Bearer tokens, because the boundary is otherwise theater.** The Harness container shares the pod's network
  namespace, so an Agent can `curl` the Orchestrator directly; a per-pod NetworkPolicy cannot distinguish it from the
  Adapter. Only authentication closes this.
  - **Sandbox token** — minted per Sandbox at provision, delivered as a Secret via the CR's `envFrom` into the **Adapter
    container only**. Authorizes exactly: deliver to `kind: "agent"` registrations **whose Sandbox is this one**. Never
    a Gate (they are not on that surface at all), never another Sandbox.
  - **Instance token** — the human/CLI credential for Gates and run control. `j2 dev` mints it into `.j2/dev.json`
    (0600), beside the `url` the CLI already reads from there.
  - Enforcing the Sandbox scope requires an agent registration to **record its Sandbox**, so `WorkspaceHandles` gains
    `sandbox` and `agentRun`'s input takes it (one more field in the same helper that already passes `endpoint` and
    `workdir`). A run-scoped token instead of a Sandbox-scoped one is genuinely exploitable: `coding.ts`'s iids are
    derivable (`<runIid>/<featureId>/<scope>/<role>`) and feature ids are readable from tk, so one feature's coder could
    inject a `review_verdict` into another feature's reviewer.
- **Reachability (the ADR-0009 "reverse ingress" item), narrowed to one caller.** `j2 dev` binds `0.0.0.0` when the
  instance has a `sandbox` backend (that flag is already the "this instance has a cluster" switch); `j2 cluster up`
  records the pod→host address (only it knows, since it creates the cluster); the Sandbox CR carries it to the Adapter
  as env. Deployed, it is Service DNS — same code path, different string. The Agent still never makes this call: the
  Adapter does.
- **Deferred tool results are reserved, not built.** ADR-0006's `deferred`/`poll` semantics stay in the model and the
  wire leaves room for them: the surface listing ships each def's `semantics` (so the Adapter can tell an awaiting tool
  from a fire-and-forget one), and a delivery always returns a **receipt with a `deliveryId`** (so an outcome is
  addressable after the fact). Registering a `deferred` or `poll` def **fails loudly as unimplemented** — a silent
  downgrade to `ack` would be a lying tool contract. How a _Machine_ answers a deferred call is deliberately left open:
  there is no consumer to design it against yet, and flue's 60s MCP `timeoutMs` means the answer will be
  poll-with-progress, not a held socket — an Adapter concern when it lands.

## Considered options

- **Agent talks to the Orchestrator directly** (ADR-0011 as written, plus a callback URL). Rejected: the credential
  lands in a container where the Agent has code execution, so the Agent can deliver `approve` to its own human-review
  Gate — it merges its own PR. The tool menu is advisory once you hold the key to the API.
- **Translation inside the flue Harness process** (it already knows the iid and the tools). Rejected for the same reason
  — same container, same code execution, same credential. And the knowledge locality is illusory: the menu originates in
  the _Machine_, so it must travel Orchestrator → pod regardless; hosting the server in the Harness only changes which
  container it lands in.
- **Adapter as a transparent MCP relay** (proxy `/mcp/:iid` to the Orchestrator's MCP server, adding auth). Tempting
  because deferred results would work for free. Rejected: it keeps the Orchestrator bilingual and keeps the MCP
  transport in the control plane, while still requiring the separate container for the credential — so it pays the
  Adapter's full cost and collects none of the simplification.
- **A uniform `/registrations/:address` API** for every caller. Rejected: it dissolves the run-scoped, discoverable Gate
  resource ADR-0011 designed on purpose (a webhook translator finds its Gate by `meta.prUrl`; `GET /runs/:id` lists open
  decisions) in exchange for aesthetic symmetry. The win here is "no MCP in the Orchestrator", not "one URL".

## Consequences

- **The Sandbox pod is three containers** — Harness, User Container, Adapter (ADR-0005's "the pod, not the container, is
  the isolation unit" now has a third resident).
- **The operator needs no change.** ADR-0001 made `Sidecars` generic container fragments the operator schedules without
  understanding; the Adapter is exactly that. `kubectlSandbox` injects it (plus the token Secret) when it builds the CR.
- **The Orchestrator loses its MCP dependency** (`@modelcontextprotocol/sdk`, streamable-HTTP transport, session
  handling) and the Adapter gains it — a new j2 package and image.
- **The e2e mechanics tier moves off MCP.** Its scenarios play the Agent against `/mcp/:iid` today; they will drive
  `/agents/:iid/*` instead. That is more honest — those steps were always simulating the _Adapter_, not an Agent.
- **The `@kind` tier grows the leg nothing currently tests.** No test today can fail on this bug: the scenarios play the
  Agent from the host, so the pod never originates a connection. The dev Harness image (`deploy/harness-dev`) gains the
  persona template and a scripted agent that actually calls its tool through the Adapter — making the pod → Orchestrator
  path a red test before it is a green one.
- **NetworkPolicy (ADR-0001's next isolation layer) is still wanted, but it is not the control.** It bounds where the
  pod may talk; only the token bounds what it may _do_.
- **Open: authn beyond dev.** The Instance token is a local-dev credential (a file in `.j2/`). What a deployed j2
  Application uses for human/webhook callers is out of scope here.

Evidence: flue's per-submission initializer (`agent-submissions.ts:150,178,842`, `agent-definition.ts:90`,
`types.ts:103`) and `connectMcpServer` (`packages/runtime/src/mcp.ts`); the kind validation that found the missing leg
(`features/kind.feature`, ADR-0012's `@kind` tier).
