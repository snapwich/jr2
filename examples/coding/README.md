# example-coding

Four workflows on the settled ADR-0015..0019 surface:

- **`workflows/task-with-review.ts`** — the MVP validation loop: one run = one task prompt = one Workspace, coder ⇄
  reviewer under a round cap, ending at a human Gate. **Runs for real** against any cluster your kube context points at
  (kind locally), with the Agents the Machine carries as actor slots ([`workflows/_agents.ts`](./workflows/_agents.ts))
  assembled by the stock Harness image. Start here; the runbook is below.
- **`workflows/triaged-task.ts`** — task-with-review with a Menu-only triager in front (ADR-0031): a `triage` state
  OUTSIDE the `workspace()` invokes the `triager` slot (`workspace: "none"` → the Instance Harness) and either answers
  the task in place — no Sandbox ever — or routes to code; the body's `assess` state then CONTINUES that same
  conversation (`conversation: "triage"`) to pick ship-vs-review after each coder round. Its mechanics test in
  [`test/`](./test) runs in the default `pnpm -r test` gate, cluster-free.
- **`workflows/task-with-review-deep.ts`** — the same Machine, retuned: it imports `task-with-review`'s exported Machine
  and hands it to `customize()` with a frontier model behind both Agents (ADR-0049). The whole file is the override — no
  states, no door, no roster, and nothing restated — because a Machine carries everything it depends on, and importing
  it is importing all of it. Both workflows register, and each run carries the Agents its Machine was given. A run of
  this one needs the `anthropic` Secret (see `j2.config.ts`); registering it costs a vLLM-only converge nothing, since
  `j2 up` probes only the custom provider's own models.
- **`workflows/jr.ts`** — [jr](https://github.com/snapwich/jr)'s `start-work` orchestration as a j2 Machine (machine id
  `coding`). The j2 side is done; the workflow-owned side (tk actors, `openPr`/`pushBranch`) is sketched. Read it as the
  reference for a full-scale workflow shape: Pool over a tk Source, architect review, escalation parking. Its door is
  the Pool's — `maxConcurrent`, `reviewRounds`, both optional (jr's `JR_*` env knobs) — and it types `cap`/`itemInput`.
  Its notes are at the bottom of that file.

## task-with-review

```
coding (invoke coder) ──request_review──▶ reviewing (invoke reviewer)
reviewing ──changes_requested (under cap)──▶ coding            [rounds++]
reviewing ──approved / cap hit──▶ humanReview (gate)
coding/reviewing ──agent.fault──▶ humanReview (gate)
humanReview ──approve──▶ done (final → Workspace teardown)
humanReview ──request_changes {notes}──▶ coding                [fresh cycle]
```

Input (`--input` JSON): `prompt` (the task), `repo` (an enum of the repository URLS this instance works on — the url is
the Repo's identity, ADR-0051, so the Console offers a menu rather than a text box), `branch` — all required; `baseRef`
(default `main`), `reviewRounds` (default 3). The workflow declares this door itself (ADR-0033), so a bad `--input` is a
400 naming the shape, `GET /workflows/task-with-review` serves it as JSON Schema, and the Console renders typed fields
instead of a raw-JSON textarea.

**The Gate park is the inspection window.** While `humanReview` is open the Sandbox stays alive: exec in, read the diff,
and push it if the work should outlive the run — `approve` reaches the final state, which tears the Workspace down, and
**unpushed commits go with it** (by design; agent-driven push is a follow-up).

## Runbook

The whole story is two commands (ADR-0019): point kubectl at a cluster, `j2 up`. There is no image bring-up step —
`j2 up` builds every image it deploys (ADR-0038). Run from this checkout it builds the Harness, Adapter, and operator
from source too, plus this instance's own [`images/default/Dockerfile`](./images/default/Dockerfile) — each at a
content-addressed tag, each `kind load`ed for you, and each skipped on the next converge if nothing moved.

One-time setup (repo root):

```sh
# 0. a cluster — any vanilla one; kind locally. Nothing about it is j2- or instance-specific.
just kind-up

# 1. the ENDPOINT, in examples/coding/.env (uncommitted; the CLI loads the .env beside
#    j2.config.ts into the environment the config reads — ADR-0019):
#      VLLM_BASE_URL=https://<address>/v1             # reachable FROM PODS — never localhost
#    The MODEL is not here: each definition in workflows/_agents.ts names its own (ADR-0018), because an
#    address is a deployment fact and a model is a design decision. `j2 up` probes every model the
#    definitions name for this provider.
#    vLLM must run with --enable-auto-tool-choice and the matching --tool-call-parser; `j2 up`
#    preflights both from inside the cluster (one trivial tool-call completion per model) and
#    fails loudly if the endpoint, the model id, or the parser is wrong.
#    Token limits for the served model are committed in j2.config.ts (`provider.models` — the
#    Harness resolves them per model id; unset would mean 0, starving auto-compaction).
#    (Anthropic instead: point each definition's `model` at anthropic/claude-sonnet-4-6, create
#    the `anthropic` Secret, and add `envFrom: [{ secretRef: { name: "anthropic" } }]` to
#    `harness` in j2.config.ts. Two committed files, not one .env line — the cost of the model
#    belonging to the Agent.)
```

Converge + run (from `examples/coding`, or any folder under it — the CLI walks up to `j2.config.ts` and loads the `.env`
beside it; a var already set in your shell wins over the file):

```sh
j2 up                 # converges the current context: operator → kit images → instance image →
                      # Sandbox Images (+ their preflight) → the Machine walk → Secrets (+
                      # preflights) → provider preflight → rollout. Idempotent; re-run after any
                      # change — unmoved images cost no docker. First contact asks; --yes for CI.

j2 run task-with-review --input '{"prompt":"Fix the ...","repo":"obsidian-tasks.nvim","branch":"task/mvp-1"}'
j2 logs <runId> -f                        # re-attach to the status feed
```

The Console (Machine + live-runs panel) is served by the orchestrator itself. Reach it over your own forward:

```sh
kubectl port-forward -n coding svc/j2-orchestrator 8080:8080
open http://localhost:8080/workflows/task-with-review
```

Every run-verb prints its target (`→ context kind-j2 / namespace coding`) on stderr — the cluster is always whatever
your kube context points at (`--context` / `-n` override; `--url`/`J2_URL` bypasses kube entirely).

At the Gate (`j2 status <runId>` shows the open gate, its accepts, and `meta.reason` — approved / review-cap /
agent-fault):

```sh
kubectl -n coding get sandboxes           # the run's Workspace pod
kubectl -n coding exec -it <pod> -c harness -- sh   # inspect: git -C /work/obsidian-tasks.nvim/<branch> log -p main..
# keep the work? push it from inside the pod BEFORE approving — that shell is the agent's own
# container, with your images/default toolchain and the same worktrees (ADR-0037)

j2 send <runId> --gate body.humanReview --event request_changes --input '{"notes":"..."}'   # loops the coder
j2 send <runId> --gate body.humanReview --event approve                                     # finals → Sandbox torn down
# (gate ids derive from the actor path — the workspace() wrapper invokes the body as `body`;
#  a wrong id errors listing the open gates)
```

Verify teardown: `kubectl -n coding get sandboxes` is empty and `j2 status <runId>` reports the run settled with
`{ outcome: "approved", branch }`. `j2 down` removes the whole instance (namespace and all); `--all` takes the
per-cluster operator too.

## The surface (ADR-0015..0017), in brief

- **Six statically-imported names**: `defineEvent`, `j2Setup`, `agent` + `gate`, `workspace`, `pool`/`source`. The
  module contract is `export const machine`; the filename is the workflow name.
- **Events are the workflow's vocabulary**; `audience` tags who may deliver. A state that invokes an Agent slot gets the
  agent-events its transitions handle as its Agent's tool menu; a `gate` state gets the external set the same way.
- **An Agent is an actor slot** (ADR-0049): `actors: { coder: agent(def) }`, invoked as `src: "coder"` with `{ prompt }`
  — the slot key IS the Agent's name, so a name this Machine does not carry is a compile error. Plus the optional dials
  `model` and `thinkingLevel`, which turn this ONE turn up or down without changing who the Agent is (ADR-0018).
  Sessions are fresh by default; endpoint and Sandbox resolve ambiently from the enclosing `workspace()`; the workflow
  sees ONE terminal `agent.fault { reason }`.
- **`workspace(body, { input, repos, spec })` owns Sandbox lifecycle only** and hands the body
  `{ workdir, repos, branch }` on top of the run input — `Workspaced<RunInput, "target">`, the handles keyed by Repo
  Slot. `input` is the wrapper's own declared door (ADR-0033); it types `spec` and the slot mappers, and checks the
  body, which may not demand more than the door plus the handles (demanding less is fine). The body never declares the
  door — what it receives is the door plus handles nobody can send — and one that tries is refused. A body that parks
  keeps its Sandbox alive — that _is_ the retain policy.
- **A Repo is a slot on the `workspace()`** (ADR-0051): `repos: { target: … }` names the one repository this Machine
  works on, under the Machine's own word for it — `/work/target/<branch>` in the pod, `workspace.repos.target` in the
  body. A slot is _bound_ (a url the package writes), _open_ (`open` — a consumer binds it with
  `customize(machine, { repos })`), or _per-run_ (a mapper over the door — every workflow here, because the repository
  is run input). The url is the identity, and the only thing that names a Repo. `j2.config.ts` declares only
  `git.credentials`: how the cluster authenticates, matched by prefix, and the **fence** a per-run url must pass — a url
  matching no entry is refused at attach, so a ticket cannot spend this cluster's token against an arbitrary host.

## workflows/\_agents.ts — the Agent definitions

Plain-data definitions (ADR-0018) the Machines here carry as actor slots (ADR-0049): `model` and `instructions` are
required (there is no instance-wide model default), `workspace` is optional (ADR-0028), and the Agent's NAME is the slot
key — `actors: { coder: agent(coder) }`. They live in one `_`-prefixed module because three workflows share them (a `_`
prefix keeps discovery from registering it as a workflow); a Machine that shipped as a package would inline its own. A
workflow may turn the `model`/`thinkingLevel` dials for one turn; the rest of a definition is identity and only the
definition sets it. The **stock Harness image** (`@j2/harness`, ADR-0027) runs the definition it is handed — no build
step — and carries the mechanism: the Adapter leash (a fresh MCP connection to `$J2_ADAPTER_URL/mcp/<id>` per
Submission, ADR-0013) and the Working tools. Editing a definition is a `j2 up` — no image build anywhere: the definition
rides each Turn's admission, so the Harness pod learns it from the Turn and never from a roster (ADR-0049).

## Follow-ups (deliberately out of scope here)

MCP server over the orchestrator API (kick off runs from a coding agent); a global runs-index web UI (the Console page
is per-workflow); `j2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb, ADR-0019);
agent-driven push (git credentials in the Sandbox); `--watch` (rebuild-redeploy inner loop).
