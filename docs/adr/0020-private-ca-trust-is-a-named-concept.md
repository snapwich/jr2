# Private-CA trust is a named concept, not volume plumbing

Running the jr-parity exercise against a real vLLM (2026-07-19) hit an endpoint that is HTTPS-only behind an ingress
whose cert chains to a private CA. The host trusts that CA; pods do not — so every j2-owned egress point fails the same
way: the Harness's model calls, and `j2 up`'s own provider preflight (which probes from a throwaway in-cluster pod,
ADR-0019). The tempting fix was generic `volumes`/`volumeMounts` passthrough on `sandbox` — the CRD already carries
both, and `harness.env`/`envFrom` set the precedent of corev1 shapes passed through verbatim. But trusting a CA is not
pod-shaped config: it is an _intent_ ("this instance's egress must trust this CA") that j2 alone can thread through
every place it owns an outbound TLS connection — including the preflight pod, which no instance-authored volume can ever
reach. A passthrough would also make the one-intent story a three-part incantation (hand-managed ConfigMap + mount +
`NODE_EXTRA_CA_CERTS` via `harness.env`), the runbook shape ADR-0019 exists to kill.

## Decision

- **`harness.caBundle` is the surface**: a path to a PEM bundle, **relative to the instance folder**, committed (CA
  certs are public data — never a Secret). One file may carry multiple certs; that is what a PEM bundle is.
- **Only `j2 up` reads the file, host-side.** `j2.config.ts` is evaluated in two worlds — by the CLI on the host and by
  the deployed orchestrator in-cluster — so the config carries a _path_, not file contents: the in-cluster evaluation
  checks presence and never touches the filesystem. `up` fails loudly on an unreadable path.
- **`up` materializes the `j2-ca` ConfigMap** beside the agents ConfigMap; `kubectlSandbox` mounts it at `/etc/j2/ca`
  and sets `NODE_EXTRA_CA_CERTS=/etc/j2/ca/ca.crt` — on the **Harness container only**. CR-level `volumeMounts` land on
  the primary container by the operator's contract, so the asymmetry costs no operator change: the Adapter (plain HTTP
  to the Orchestrator's Service) and the User Container (user-owned image — same rule as `harness.env`, ADR-0005/0013)
  never inherit the trust path.
- **The provider preflight trusts the same bundle the same way** (`NODE_EXTRA_CA_CERTS` on the probe pod, the PEM riding
  an env var). A preflight that fails where the Harness would succeed — or passes where it would fail — is a broken
  promise; sharing the mechanism keeps the two verdicts identical. (Node 24's `fetch` honoring `NODE_EXTRA_CA_CERTS` was
  verified live against the real endpoint before this landed.)

## Considered options

- **Generic `sandbox.volumes`/`volumeMounts` passthrough.** More powerful and precedent-consistent, but it cannot reach
  the preflight pod, splits one intent across three keys, and adds a forever-surface for a need that has appeared
  exactly once. Deferred until a second real need for arbitrary volumes shows up — the CRD support is already there when
  it does.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` via `harness.env`.** Zero kit change, but it disables verification for _every_ TLS
  connection the Harness makes (git, MCP, everything), and the preflight still fails — `up` would refuse to converge an
  instance whose pods would work.
- **Baking the CA into the Harness image.** Contradicts ADR-0018's stock published image — a per-instance CA means a
  per-instance image, the exact build ADR-0018 deleted.

## Consequences

- Rotating or adding a CA is a `ca.crt` edit + `j2 up` + pod restart — the same ConfigMap-update path as Agent
  definition edits (ADR-0018).
- `NODE_EXTRA_CA_CERTS` _adds to_ Node's trust store, so public endpoints keep working; but it only reaches Node
  processes — an agent shelling out to `curl`/`git` against the private CA would need the system store, which is the
  Harness image's business, not config's. Not blocking: git speaks to the RO repos volume and public hosts today.
- The orchestrator pod itself (boot-reconcile `git clone`) does not consume the bundle yet; repos behind a private CA
  would extend the same ConfigMap to the orchestrator Deployment — a deliberate later step, same concept.
