# Sandboxes are provisioned by a Kubernetes operator via a generic CRD

A `Sandbox` custom resource describes infrastructure only — a primary container, a generic list of additional sidecar
container specs, volumes, resources, secrets, idle timeout — and a custom operator reconciles it into a Pod plus a
Service, reporting a `status.endpoint` the Orchestrator uses to reach the Harness. The CRD knows nothing about git,
worktrees, or Agents; those are layered on by composable helpers after the Sandbox reaches `Ready`.

We chose the operator over the Orchestrator calling the Kubernetes API directly because the custom resource _is_ the
durable desired state: Sandboxes survive an Orchestrator restart, and garbage collection / readiness / retries live in
one reconciler instead of being threaded through the Machine. We kept the CRD generic (rather than coding/worktree-aware
with an init-container clone) so the operator stays workflow-agnostic — matching j2's thesis that the framework is a
grab-bag of composable pieces, with git/worktree being just one piece a coding Machine bolts on. The cost is an extra
runtime step (worktree setup as its own state that can fail independently) and an operator to build and maintain.

## Agents are sidecars, but the CRD stays agent-agnostic

Agents run as sidecar containers in the Sandbox pod (Kubernetes can't add containers to a live pod, so they must be in
the spec at spin-up). This does **not** make the CRD agent-aware: the spec enumerates plain Kubernetes `Container`
fragments (image, ports, env, volumeMounts), and the operator schedules them without knowing any are "agents." The
agent-awareness lives one layer up — the agent-aware "setup Sandbox" provider compiles the chosen Agents into container
specs and injects them into the CR's sidecar list, exactly as a Deployment's pod template carries arbitrary containers
without the controller understanding them. The trade is that agent-shape validation moves up into the provider/Machine
layer (where the domain types live) instead of the operator.
