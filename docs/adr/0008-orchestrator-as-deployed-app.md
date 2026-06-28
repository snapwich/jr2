# j2 is a library + CLI; an Orchestrator instance hosts many workflows

j2 ships as a **library** (engine + providers + agent-protocol + built-in templates) and a **CLI** (`j2`). You don't
build a workflow into its own image. Instead you `j2 init` an **Orchestrator instance** — a small, user-owned _code_
project (a folder) that imports the kit, configures it, and holds one or more **workflows** (Machines: type-safe xstate
wired to chosen providers). One instance hosts **many** workflows; the CLI builds the engine + that instance's workflow
modules into a single image and deploys it. The instance folder is the **j2 Application** — the GitOps unit; the same
folder/manifests run on kind locally and on a real cluster.

Machine definitions are **code, not declarative config.** We rejected expressing machines as YAML/CRD config: a useful
agentic Machine is mostly logic (guards, prompt-building, `assign`s), and a declarative form becomes a DSL-over-xstate
that loses type-safety and still cannot express branching. The instance is a code project (it imports `@j2/*`), so
"code, not config" survives — the machine definitions simply live in the user's instance folder rather than baked into
the kit. Built-in templates ship in the kit; the instance _assembles_ them with providers via the ADR-0003 `provide()`
seam.

## The Orchestrator instance

An instance is a **stateful, single-writer daemon**: it holds the live in-memory xstate actors, so it runs `replicas: 1`
and persists its snapshot to Postgres (ADR-0007). `replicas: 1` means single _writer_ (no split-brain on the snapshot) —
**not** one workflow per process. One instance registers N workflows and **hosts many runs** of any of them (each top
Machine spawns a Workspace child per piece of work). Work arrives two ways that both reduce to injecting events into an
actor: the **work source** (pull) and the **HTTP API** (push) — so push/pull coexist with no special machinery.
Isolation or independent scaling is achieved by running **another instance**, not by replicating one run; the default is
one instance, many workflows.

## Flue stays on the Agent side

The Agent/Sandbox Harness is flue (ADR-0002/0006) — its sweet spot. The Orchestrator is **not** flue: its state is an
xstate snapshot, not a flue session, and its loop is a deterministic state machine, not an LLM-in-harness; hosting it in
flue would mean fighting flue's session/agent model. We borrow flue's **ergonomics, not its implementation**: the
instance folder convention (`j2.config.ts` + a discovered `workflows/` dir, mirroring flue's `flue.config.ts` +
`agents/`), the `j2` CLI as the primary interface, and an HTTP API shaped like flue's "durable run addressed by id"
(`POST` to start/feed, `GET /…/:id` for status, SSE for events) — so both sides of the system speak one protocol,
without coupling the Orchestrator to flue.

## Consequences

- The deployable unit is an **instance image** (engine + the instance's workflow modules), built by `j2 build`, run as
  one `replicas: 1` `Deployment` + `Service`. The two-repo pattern (instance code → image; manifests → GitOps) is
  expected, and the instance folder carries both.
- Concrete workflows do **not** live in the j2 source repo — only reusable **templates** (kit) and `examples/` do. A
  user's workflows live in their `j2 init` instance folder.
- j2 ships and deploys only its **`Sandbox` operator** (its own CRD), deployed once per cluster. The snapshot store
  (sqlite by default, optional Postgres) and the model backend are **dependencies you provide** — j2 points at them
  (`DATABASE_URL`, model env), it does not own or operate them. Instances are deployed per user/project.
- Users interact through the **`j2` CLI** far more than raw HTTP; the HTTP API is the machine-to-machine surface (push
  work, human-in-the-loop, status) the CLI itself sits on top of.
- Custom third-party providers and the prebuilt-engine-that-dynamically-loads-workflow-plugins path stay **deferred**;
  build-time-bake of the instance's code keeps full type-safety for now.
