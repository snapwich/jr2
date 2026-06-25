# A Sandbox runs two containers: a Harness and a user container

A Sandbox pod runs two containers sharing the worktree volume:

- **Harness container** — j2-owned, reusable, versioned image. Runs the flue server _and_ the **agent's own toolchain**
  (the build/test tools the agent invokes). It is not toolless: the coder Agent must build and run tests, and flue's
  `local()` sandbox executes those tools inside this container (PoC #3/#4), so the toolchain has to live in this image.
  "Lightweight" here means slim relative to a full human IDE — not without tools.
- **User container** — user-owned, customizable image (nvim, dotfiles, extra CLIs). The container you `exec`/SSH into to
  work alongside the agent. j2 does not own it.

Both mount the same worktree volume, so the human and the agent see identical files. flue's session / durable-execution
log (`sqlite()`, also used for Harness-restart durability — ADR-0002) lives on that shared volume, so agent runs can be
inspected from the user container with your own tools.

## Why two containers, not one

- **Image ownership** — a slim, versioned, j2-controlled Harness vs a fat, user-controlled user container. Neither
  bloats the other, and each is rebuilt/owned independently.
- **Independent resource limits** — the agent loop and a heavy interactive build get separate cpu/memory limits, so a
  runaway `make` in the user container can't starve the agent (and vice-versa).
- **Lifecycle independence** — a Harness crash restarts only the Harness; an interactive shell or build in the user
  container survives, and vice-versa.

## What this is NOT

The two-container split is **not** a security boundary. Containers in a pod share a kernel, network namespace, node, and
the worktree volume — the **pod** is the isolation unit (one per Workspace, the k8s north-star). The Harness and user
container are the same trust domain; the split buys ownership/resources/lifecycle, not isolation between agent and
human.

## Consequences and open follow-up

- The generic `Sandbox` CRD composes both as plain container specs (ADR-0001 holds — the operator stays agent-agnostic);
  the "setup Sandbox" provider supplies both images.
- **Deferred probe:** a _truly_ minimal Harness (agent loop only, tool execution delegated to the user container) would
  require flue to run tools in a sibling container — an unproven capability (flue's container sandboxes are remote-VM
  style, not sibling-container). Not blocking: start with the agent toolchain in the Harness image; revisit only if
  image duplication between the Harness and user container becomes a real cost.
