# A Harness answers the Orchestrator alone

A red-team review (2026-09-22) found that the Harness wire had no authentication. `POST /agents/:name/:id`, the stream
and history views, and `.../abort` checked no bearer, and the server bound `0.0.0.0:8080`. Iids are derivable
(`<runId>/<machine>/<agent>` for a continued conversation,
[ADR-0057](0057-a-turn-is-its-frame-its-dials-and-whether-it-continues.md)), so any pod that could reach a Harness could
admit a Turn into another conversation, read its history, or abort it. An Agent with bash in one Sandbox could do this
to another Sandbox, or to the Instance Harness, which holds every Menu-only conversation in the Instance
([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)). No NetworkPolicy existed to limit the reach. The
review also found that the echo ([ADR-0023](0023-the-harness-prints-the-conversation.md)) sent the raw Instance token to
every Sandbox Harness on each push. The env held only its digest, but the token itself passed through the process that
the Agent executes code beside. So we authenticate the wire with a bearer that each Harness can verify and cannot mint,
and we add an ingress NetworkPolicy that admits only the Orchestrator to a Harness pod.

## Decision

- **One bearer per placement.** The Orchestrator presents
  `harnessToken(key, placement) = HMAC(signing key, "harness:" + placement)` on every Harness wire call: admit, each
  long-poll, abort, and echo. `placement` is the name of the pod that hosts the Turn: the Sandbox's name, or
  `jr2-instance-harness`. This is the same name the registration records as its delivery scope
  ([ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md)), so one name scopes both directions. The Adapter there may
  speak for the Turn's picks, and only this bearer may drive the conversation there.
- **The Harness holds only the digest.** Its env carries `JR2_HARNESS_TOKEN_SHA256 = sha256(bearer)`. The Agent can read
  that env, and a digest inverts to nothing. So a Harness can verify its own bearer, and it can mint none, for itself or
  for another pod. The HMAC key never leaves the Orchestrator's Secret.
- **The bearer is derived, not stored.** This is the reason the Sandbox token is a signed name (`tokens.ts`). The
  Orchestrator holds no per-pod state. A restarted Orchestrator derives the same bearer that a live Harness already
  checks, so re-attach ([ADR-0012](0012-workspace-wrapper-machine.md)) survives with no change. The `harness:` prefix
  separates it from the Sandbox token: no DNS-label name produces it.
- **Every route is gated, and the gate runs first.** Admit, stream, history, abort and echo answer 401 without the
  bearer. A 401 comes before a 404, so a refused caller does not learn which conversations exist. A refused admission
  creates no conversation. The Harness requires `JR2_HARNESS_TOKEN_SHA256` at boot and fails loudly without it.
- **The echo uses the same bearer.** `JR2_ECHO_TOKEN_SHA256` is removed. The Instance token no longer enters any pod,
  which is what [ADR-0032](0032-the-console-unlocks-with-the-instance-token.md) and `docs/architecture.md` already said.
- **A refused stream is a fault, not a reconnect.** The bearer is derived, so a Harness that refuses it once refuses it
  on every retry. `wait` settles a 401 or 403 as a `SettlementFault` and does not park the Turn forever.
- **Ingress to every Harness pod comes from the Orchestrator alone.** `jr2 up` converges two NetworkPolicies in the
  instance namespace. `jr2-sandbox-ingress` selects every pod that has the operator's `sandbox.jr2.dev/name` label.
  `jr2-instance-harness-ingress` selects `app: jr2-instance-harness`. Both admit ingress only from this instance's
  Orchestrator pods (`app: jr2-orchestrator`, `jr2.dev/instance: <name>`). They are converged unconditionally, so a
  Harness pod is never created before its policy exists.
- **Starting a run needs the Instance token.** `POST /workflows/:name/runs` moves from `authenticated` to
  `instanceOnly`. The scope of a Sandbox token is its own agent surface. No Adapter forwarded this route, but that was
  not a control.

## Considered options

- **Ed25519, one short-lived token per admission, scoped to one iid.** This was the first proposal. Rejected. `wait`
  reconnects indefinitely by design, and re-attach after a restart follows a ledgered admission of any age, so a short
  expiry breaks both unless each poll gets a new token. That adds a public key in every pod and a dependency on clock
  sync. What it buys over a per-placement bearer is scoping inside one pod. But the Agent already has code execution in
  that pod's Harness container, so that scope protects nothing.
- **The Instance token's digest, as the echo used.** Rejected. It is one secret for every pod, and it sends the Instance
  token, the full-trust credential, into each Harness process.
- **One Instance-wide Harness token.** Rejected. A digest does not let a Harness mint, but the bearer arrives in every
  Harness process on every call. A per-placement bearer that leaks from one pod opens only that pod, which the Agent
  there already controls.
- **NetworkPolicy alone.** Rejected, for the reason ADR-0013 gives: a policy bounds where a pod may talk, and only a
  token bounds what it may do. The policy cannot separate the Harness from the Adapter in one pod, and a cluster whose
  CNI does not enforce policy gets nothing from it.

## Consequences

- **The stub Harness checks nothing.** It is a host-side test fixture that is reached by an explicit `endpoint`, and a
  run on the stub path names no placement, so it sends no bearer. This is the second documented divergence from the
  normative model ([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)). Conformance tests
  inject the check (`checkBearer`), and `auth.test.ts` in `@jr2/harness` pins the routing of the gate.
- **kindnet enforces NetworkPolicy.** On the kind version this repo pins, a deny-ingress policy blocks pod-to-pod
  traffic, so the `@kind` tier proves both controls. A Sandbox's own Harness refuses an unauthenticated admission over
  loopback, where no policy applies. A Sandbox cannot connect to the Instance Harness at all. The second test asserts a
  transport failure, not a status, because a 401 would mean the bearer stopped it and the policy did not.
- **Port-forward and probes are not affected.** `kubectl port-forward` enters the pod's network namespace through the
  kubelet, and the kubelet's probes come from the node. On kind, neither is filtered by an ingress policy. So the CLI,
  the Console, and a human's shell into the User Container ([ADR-0005](0005-sandbox-pod-composition.md)) keep working.
  If routable access to the User Container is added later (ADR-0005 leaves it open), it must add its own ingress rule.
- **The `@kind` history reads present the bearer.** The steps derive it from the instance Secret's signing key, as the
  CLI reads the Instance token: over the kube API, with RBAC as the gate. A human reading a conversation does the same.
- **Open gaps, recorded here and not fixed:**
  - **Sandbox egress.** An Agent with bash can reach the internet and send out anything it can read. A default-deny
    egress policy needs an allowlist: DNS, the Orchestrator, the model provider, and whatever the work needs (package
    registries, for example). That needs a config surface and cluster CIDRs, so it is a separate decision.
  - **The model API key is in the Harness container.** `JR2_PROVIDER_API_KEY` and literal `harness.env` values come from
    `jr2-harness-env`, and Working-tool children inherit them, so the Agent can read the key and exfiltrate it. The
    chosen direction: **the Adapter relays model calls.** The Adapter already exists in both placements. It is already
    the container that holds a credential the Agent can reach but cannot read, and it already relays more than MCP
    ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)). The key would move
    to the Adapter's env, and the Harness's provider `baseUrl` would point at the Adapter. The Agent could still spend
    tokens through the relay while its Sandbox lives, but it could not take the key away. This changes the Adapter's
    glossary entry and ADR-0018's provider path, so it needs its own ADR.
  - **The Orchestrator's RBAC is namespace-wide.** Its Role can get, list, create and patch every Secret, and can
    `pods/exec` into every pod. `resourceNames` can pin only the fixed names; `create`, `list` and the per-Sandbox names
    cannot be narrowed that way. An attacker with code execution in the Orchestrator also has the signing key, so the
    gain is small. This stays as it is until a design removes the need.
