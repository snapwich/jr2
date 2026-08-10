# Ready is not routable: the two calls a turn starts with re-ask a Service that has not answered

[ADR-0016](0016-agent-turn-mechanics-are-internal.md) sorted an Agent run's failures into classes and said which ones j2
absorbs. Its **infra** class is stated as already-covered: _"provider-stream retry lives inside the turn in the Harness,
and `wait` reconnects indefinitely from the offset ledger; a dead Harness surfaces as a fault"_. That sentence walks the
turn from its stream backwards and never reaches the two steps in front of it. **Both legs that run BEFORE a model is
ever asked were single, unretried `fetch`es** — the Orchestrator's admission POST to the Workspace Harness, and the
Adapter's `GET /agents/:iid/surface` that builds the turn's Menu — and either one rejecting settles the turn, which
`actor.ts` reports as the terminal `agent.fault`. One dropped packet, one lost turn.

The gap is not theoretical and not rare, because both of those calls dial a **Service that has only just started
mattering**. The admission is the FIRST HTTP request j2 ever sends over a Workspace's Service: the wrapper waits on the
Sandbox CR's `phase: Ready`, which the operator computes from the POD's readiness, and the attach then reaches into the
pod through the API server (`kubectl exec`) — neither proves the Service dialable. The surface read dials the
Orchestrator's Service, which is between EndpointSlices every time the Orchestrator restarts, and restarting is ordinary
([ADR-0007](0007-durable-machine-state.md)'s restore is built on it). Kubernetes programs the EndpointSlice behind a
ClusterIP **after** the pod passes its probe, and until it does, kube-proxy REJECTs. **Ready is a statement about a pod;
routable is a statement about a Service, and j2 was reading the first as the second — at both ends of the same turn.**

Measured: this is what cost the `@kind` tier its parallel default ([ADR-0010](0010-bdd-acceptance-tests.md)). Roughly
one parallel run in three lost a scenario whose first turn never reached the scripted model, and the symptom was read
for a long time as "a slow first turn". It is not. It is a lost turn, and the tier's failure dump caught both legs
losing it:

- **The admission**, three times. The pod's Harness answered `?view=history` with **404 — no conversation** (POST is
  what creates one), the scripted model had received **zero** streaming requests, and the run settled
  `{"outcome":"faulted","reason":"fetch failed"}`. In the same window the run-narrative echo — un-retried, and the only
  other thing that dials that Service — logged the same `fetch failed` against the same address. Nothing had reached the
  pod at all.
- **The surface read**, once the admission was fixed and the tier ran again:
  `submission settled failed: Streamable HTTP error: Error POSTing to endpoint: {"error":"fetch failed"}` — the
  Adapter's 500, wrapped by the MCP client, in the scenario that RESTARTS the Orchestrator. Which is the same defect one
  hop over, and it retired this ADR's first draft, where the Menu leg was written off as "pod-local to a Service that
  has been serving all along". It is not pod-local: the Adapter's hop leaves the pod.

Parallelism causes neither; it multiplies the number of Services crossing into service at once, so it samples both
windows more often. That is why the flake was degree-independent and serial runs never saw it.

## Decision

- **A never-delivered admission is re-sent.** `send` re-POSTs while the request demonstrably never left the host,
  backing off on the same capped ladder `wait` uses. This is `wait`'s own rule applied one step earlier and for the same
  reason: a request that could not connect is not a Harness that refused the prompt.
- **Only never-delivered.** Admission is accept-and-queue
  ([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)): a POST the Harness received but could
  not answer has already queued a Submission, so re-sending it would run the turn **twice** — a worse failure than
  losing it. The test is therefore the narrow structural question "did any byte reach the wire" (the errno's
  `syscall`/`code`, read down the `cause` chain), never the broad "does this look transient". A reset connection is not
  retried.
- **The window is bounded, where `wait`'s is not.** `wait` may reconnect forever because its Submission is already
  admitted, so the lease owns the reporting ([ADR-0021](0021-workspace-continuity-is-a-lease-that-answers-back.md)'s
  `workspace.lost`). Nothing is admitted yet at this seat, so there is no turn for a lease to be about: an address that
  never answers is a fault this call must name itself, and it names the address it kept trying. **90 seconds — a
  measurement, not a derivation.** The mechanism argues for far less: kube-proxy programs the EndpointSlice in well
  under a second, and CoreDNS's 30s negative TTL is the only other obvious floor. Reasoning from the mechanism alone is
  how this ADR first arrived at 60s, and 60s clears neither number the field has actually recorded —
  [kubernetes#88986](https://github.com/kubernetes/kubernetes/issues/88986) measures **63s** on bare metal (a
  SYN-retransmit ladder, 1-2-4-8-16-32, so those packets were DROPPED rather than refused), and
  [kind#2280](https://github.com/kubernetes-sigs/kind/issues/2280) measures **up to 77s** with the EndpointSlices
  already populated. The bound covers both. Its cost is paid only by an address that is genuinely wrong, and that one
  faults with the address in hand either way.
- **The ladder is jittered, because the callers arrive together.** Sandboxes that converge together cross the same
  window together, and every Adapter in the cluster dials the same Orchestrator Service — so an un-jittered ladder does
  not merely fail to help, it organizes the callers into a herd that retries and misses in lockstep. Each sleep is drawn
  from the TOP HALF of its rung (equal jitter). The random half decorrelates them; the half that stays a floor is the
  deliberate part, and it is what full jitter would give away — it is what still holds four clients off a Service that
  is genuinely down.
- **A transport failure says what it was.** `fetch` reports every one of them as the same three words, and
  `reason: "fetch failed"` on a run is a diagnosis of nothing — the errno one level down (`connect ECONNREFUSED …`,
  `getaddrinfo ENOTFOUND …`) is the whole answer. Both the admission fault and the echo's log line now carry it.
- **The Adapter re-asks an unanswered surface read, on ANY transport failure.** A GET is idempotent, so the narrow
  never-delivered test the admission needs buys nothing here — there is no second turn to accidentally start, so the
  rule is simply "an answered request is an answer". A 404 stays ADR-0026's turn-is-over and a 403 stays a scope
  refusal: both are answers, and neither is re-asked.
- **`deliver` does not retry, and that is not an oversight.** A failed pick reaches the model as a tool error it can act
  on — pick again, or pick differently — so the turn survives one; and a POST that may have been delivered must never be
  re-sent, because a duplicate pick is a duplicate transition. The asymmetry between the Adapter's two calls is the same
  one between `send` and `wait`: what may be re-asked is decided by what a second copy would do, never by how transient
  the failure looks.
- **The fault class is unchanged.** Exhausting either window is still ADR-0016's single terminal `agent.fault`, and
  where it routes is still workflow policy. What changes is that it now means "this endpoint never answered", not "the
  EndpointSlice was a few hundred milliseconds behind".

## What this does not fix

**An unrouted `agent.fault` is still silent.** A workflow with no `agent.fault` policy does not report a lost turn; it
stops waiting, and the run sits `active` forever with the reason nowhere `j2 status` can show it (a child machine's
state value is served, its context is not). That is what made this class of failure undiagnosable for as long as it was
— the tier's own workflow now routes the fault, which is a fixture change, not a product one. Whether the run feed
should carry a terminal fault of its own accord is [ADR-0022](0022-observation-is-a-level-triggered-feed.md)'s territory
and is not decided here.

## Consequences

- The `@kind` tier's wired default becomes `--parallel 4` (ADR-0010 carries the measurements).
- A genuinely wrong address at either seat now costs up to its window before it faults, instead of failing at once. That
  is the intended trade: the address is right and the Service is late far more often than the address is wrong, and the
  fault message names the address either way.
- **The rule generalizes, and the next seat to need it should say so out loud.** Two hops needed this and were found one
  at a time, each by a failure. The claim is not "retry the network"; it is that j2 dials Services at the exact moment
  they come into existence, and that a call which never got an answer has learned nothing worth acting on. Any new
  j2→Service call made at a lifecycle edge starts with that exposure until someone decides otherwise.
- The retry is invisible to the workflow by construction (ADR-0016's absorption principle): no new event, no new budget
  on the authoring surface, no bookkeeping in Machine context. **But absorbed is not the same as unmeasured, and the
  difference is load-bearing.** Absorption alone would leave the tier benefiting from a window it cannot see: if
  routability got twice as slow tomorrow, all 88 scenarios would still pass, a little slower, in silence, until the day
  the window finally closed and the suite went red as a fresh mystery. Being unseeable is precisely how this class
  survived three sessions, so each seat emits ONE line when a retry actually cost something —
  `j2.routability seat=… attempts=… ms=… url=…` — and the `@kind` tier holds a budget against it (4 attempts), judged
  once per worker in `AfterAll`. A log line, not a run-feed event: the authoring surface is untouched, so nothing above
  contradicts itself. What the tier now asserts is not that the retry worked — the scenarios already assert that — but
  **how much of the window is being spent**, which is what turns 90s from a number read off two GitHub issues into a
  measurement of the cluster in front of us.
- **This is the ecosystem's answer, not a j2 workaround**, which is worth recording because "retry" reads as a patch.
  [kind#2280](https://github.com/kubernetes-sigs/kind/issues/2280) is this defect exactly — EndpointSlices populated,
  connection still refused, up to 77s — and it establishes that waiting for the EndpointSlice is NOT sufficient, which
  retires gating the CR's `phase: Ready` on it as a narrowing rather than a fix. Knative's activator arrives at the same
  place from the other side: it
  [probes the pod itself and treats its own successful probe as authoritative](https://knative.dev/blog/articles/demystifying-activator-on-path/)
  regardless of what Kubernetes says, exactly so traffic can start before the control plane catches up. j2's version is
  that with one fewer moving part — the first real request IS the probe — which is only safe because `neverDelivered` is
  what makes it re-sendable. A separate probe would add a round trip and put the race back (probe succeeds, the rule
  changes, the real request lands).
