# jr2 is a library + CLI; an Orchestrator instance hosts many workflows

jr2 ships as a **library** (engine + agent-protocol) and a **CLI** (`jr2`). You don't build a workflow into its own
image. Instead you `jr2 init` an **Orchestrator instance** — a small, user-owned _code_ project (a folder) that imports
the kit, configures it, and holds one or more **workflows** (Machines authored via `jr2Setup`, ADR-0015). One instance
hosts **many** workflows; the CLI builds the engine + that instance's workflow modules into a single image and deploys
it. The instance folder is the **jr2 Application** — the GitOps unit; the same folder/manifests run on kind locally and
on a real cluster.

Machine definitions are **code, not declarative config.** We rejected expressing machines as YAML/CRD config: a useful
agentic Machine is mostly logic (guards, prompt-building, `assign`s), and a declarative form becomes a DSL-over-xstate
that loses type-safety and still cannot express branching. The instance is a code project (it imports `@jr2/*`), so
"code, not config" survives — machine definitions simply live in the user's instance folder rather than baked into the
kit.

## The Orchestrator instance

An instance is a **stateful, single-writer daemon**: it holds the live in-memory xstate actors, so it runs `replicas: 1`
and persists its snapshots to its store (sqlite by default, Postgres opt-in — ADR-0009). `replicas: 1` means single
_writer_ (no split-brain on the snapshot) — **not** one workflow per process. One instance registers N workflows and
**hosts many runs** of any of them. Work arrives two ways that both reduce to injecting events into an actor: a
**Source** (pull, ADR-0017) and the **HTTP API** (push) — so push/pull coexist with no special machinery. Isolation or
independent scaling is achieved by running **another instance**, not by replicating one run; the default is one
instance, many workflows.

## The Harness stays on the Agent side

The Agent/Sandbox Harness is jr2's own server, `@jr2/harness` (ADR-0002/0018/0027) — and the Orchestrator is **not** a
harness: its state is an xstate snapshot, not an agent session, and its loop is a deterministic state machine, not an
LLM-in-harness. The two share ergonomics, not implementation: the instance folder convention (`jr2.config.ts` + the
discovered `workflows/` dir — the Agents ride the Machines it holds, ADR-0049), the `jr2` CLI as the primary interface,
and an HTTP API shaped as "durable run addressed by id" (`POST` to start/feed, `GET /…/:id` for status, SSE for events)
— so both sides of the system speak one protocol without sharing a runtime.

## Consequences

- The deployable unit is an **instance image** (engine + the instance's workflow modules), built and delivered by
  `jr2 up` (ADR-0019; a CI-only `jr2 build` is planned), run as one `replicas: 1` `Deployment` + `Service`. The two-repo
  pattern (instance code → image; manifests → GitOps) is expected, and the instance folder carries both.
- Concrete workflows do **not** live in the jr2 source repo — only the kit, the Machines it ships (`@jr2/machines`,
  ADR-0054), and the `templates/default` model instance do. A user's workflows live in their `jr2 init` instance folder.
- jr2 ships and deploys only its **`Sandbox` operator** (its own CRD), deployed once per cluster. The snapshot store and
  the model backend are **dependencies you provide** — jr2 points at them (`DATABASE_URL`, model env), it does not own
  or operate them. Instances are deployed per user/project.
- Users interact through the **`jr2` CLI** far more than raw HTTP; the HTTP API is the machine-to-machine surface (push
  work, human-in-the-loop, status) the CLI itself sits on top of.
- Dynamic third-party workflow/plugin loading stays **deferred**; build-time-bake of the instance's code keeps full
  type-safety for now.
