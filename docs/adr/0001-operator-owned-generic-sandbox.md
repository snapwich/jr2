# Sandboxes are provisioned by a Kubernetes operator via a generic CRD

A `Sandbox` custom resource describes infrastructure only — image, volumes, resources, secrets, idle timeout — and a
custom operator reconciles it into a Pod plus a Service, reporting a `status.endpoint` the Orchestrator uses to reach
the Harness. The CRD knows nothing about git, worktrees, or Agents; those are layered on by composable helpers after the
Sandbox reaches `Ready`.

We chose the operator over the Orchestrator calling the Kubernetes API directly because the custom resource _is_ the
durable desired state: Sandboxes survive an Orchestrator restart, and garbage collection / readiness / retries live in
one reconciler instead of being threaded through the Machine. We kept the CRD generic (rather than coding/worktree-aware
with an init-container clone) so the operator stays workflow-agnostic — matching j2's thesis that the framework is a
grab-bag of composable pieces, with git/worktree being just one piece a coding Machine bolts on. The cost is an extra
runtime step (worktree setup as its own state that can fail independently) and an operator to build and maintain.
