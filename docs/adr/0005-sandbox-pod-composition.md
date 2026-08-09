# The Sandbox pod's containers: Harness, Adapter, and a user container

A Sandbox pod composes up to three containers around one shared worktree volume (`/work`):

- **Harness container** — the CR's primary container (`spec.image`): j2's own server hosting the instance's Agents
  (ADR-0018/0027), _plus_ the **agent's own toolchain** — the build/test tools the agent invokes. It is not toolless: a
  coder Agent must build and run tests, and the working tools (read/write/edit/bash) execute inside this container, so
  the toolchain has to live in this image. "Lightweight" here means slim relative to a full human IDE — not without
  tools. This is also the container a human `kubectl exec`s into to inspect a parked run today.
- **Adapter container** — j2-owned sidecar (ADR-0013): serves the Agent its MCP tool menu on `localhost` and is the
  pod's only credential holder. It exists as a separate container precisely _because_ the working tools give the Agent
  code execution in the Harness container — the Orchestrator credential lives where the Agent cannot read it.
- **User Container** — ~~user-owned, customizable image (nvim, dotfiles, extra CLIs) for working alongside the agent
  with your own tools; configured per instance as `images.user` in `j2.config.ts` (ADR-0031) and mapped into the CR's
  generic sidecar list like the Adapter. Absent `images.user`, the pod runs two containers. j2 does not own the image's
  contents.~~ **Superseded by [ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)**: the
  User Container, `images.user`, and the "your entrypoint must block" contract are deleted. The Sandbox Image ate it —
  the primary container is now the _user's_ image with j2's runtime injected at `/opt/j2`, so `kubectl exec -c harness`
  gives a human the agent's tools, worktrees, and filesystem. The promise below (human and agent see identical files) is
  delivered by the image rather than by a second container sharing a volume with it.

All three mount the same `/work` volume, so human and agent see identical files.

## Why separate containers, not one image

- **Image ownership** — a slim, versioned, j2-controlled Harness vs a fat, user-controlled user container vs a tiny
  j2-owned Adapter. None bloats the others; each is rebuilt and versioned independently.
- **Independent resource limits** — the agent loop and a heavy interactive build get separate cpu/memory limits, so a
  runaway `make` in the user container can't starve the agent (and vice-versa).
- **Lifecycle independence** — a Harness crash restarts only the Harness; an interactive shell in the user container
  survives, and vice-versa.

## What the split is — and is not — a security boundary

The Harness/User-Container split is **not** one: containers in a pod share a kernel, network namespace, node, and the
worktree volume — the **pod** is the isolation unit (one per Workspace, the k8s north-star), and those two containers
are the same trust domain. The Harness/**Adapter** split **is** one, of exactly one kind: credential visibility. The
Agent executes code in the Harness and none in the Adapter, so the Adapter's env (the Sandbox token) is out of its reach
— that asymmetry, not the container boundary itself, is what ADR-0013 builds on.

## Consequences and open follow-up

- The generic `Sandbox` CRD composes all of this as plain container specs (ADR-0001 holds — the operator stays
  agent-agnostic); the Orchestrator's `kubectlSandbox` supplies the images.
- **Deferred probe:** a _truly_ minimal Harness (agent loop only, tool execution delegated to the user container) would
  require the Harness to execute tools in a sibling container — a cross-container transport j2 does not have. Not
  blocking: the agent toolchain lives in the Harness image; revisit only if image duplication between the Harness and
  user container becomes a real cost.
