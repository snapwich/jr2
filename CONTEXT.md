# j2

A kit for building agentic workflows modeled as [xstate](https://stately.ai/docs) state machines. Provides composable,
xstate-compatible pieces (an Actor backed by a flue client, worktree creation, memory, etc.) that you assemble into a
Machine for any workflow — coding or otherwise. The feature/task coding flow is one example Machine, not the
architecture. Agents run in isolated pods (host-level sandbox), coordinated by an Orchestrator running a Machine, on
Kubernetes (kind locally).

## Language

**Machine**: The xstate state machine that defines a workflow. The unit a user authors or picks from provided defaults.
_Avoid_: workflow, graph

**Orchestrator**: The runtime that executes a Machine. Runs in its own pod. _Avoid_: runner, engine

**Actor**: An xstate actor inside a Machine that drives a remote worker via a flue client. The local handle in the
Orchestrator; the compute is remote. _Avoid_: agent actor

**Agent**: A configured worker persona — model + instructions + tools (e.g. coder, reviewer). What a user customizes.
Maps to a flue `createAgent` definition. _Avoid_: role, persona

**Sandbox**: The isolated pod that gives an Agent a host-level sandbox plus its own filesystem. The primary motivation
for the Kubernetes architecture — agents must not share host resources (ports, filesystem, process space). _Avoid_:
worker pod, container

**Harness**: Flue's long-running server process running inside a Sandbox. Hosts one or more Agents and serves them over
HTTP. _Avoid_: flue agent, server

**Workspace**: A long-lived Sandbox bound to a unit of work, modeled as a child Machine. Entering the state creates the
Sandbox and its worktree; the child Machine's states manage what happens inside (e.g. coding, review, merge); reaching
its final state cleans up the Sandbox. Coder and reviewer Agents share one Workspace (per-feature isolation, not
per-Agent-run). _Avoid_: workspace pod
