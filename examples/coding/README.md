# example-coding

Two workflows on the settled ADR-0015..0019 surface:

- **`workflows/task-with-review.ts`** — the MVP validation loop: one run = one task prompt = one Workspace, coder ⇄
  reviewer under a round cap, ending at a human Gate. **Runs for real** against any cluster your kube context points at
  (kind locally), with Agents assembled from the definitions in [`agents/`](./agents) by the stock Harness image. Start
  here; the runbook is below.
- **`workflows/jr.ts`** — [jr](https://github.com/snapwich/jr)'s `start-work` orchestration as a j2 Machine (machine id
  `coding`). The j2 side is done; the workflow-owned side (tk actors, `openPr`/`pushBranch`) is sketched. Read it as the
  reference for a full-scale workflow shape: Pool over a tk Source, architect review, escalation parking. Its notes are
  at the bottom of that file.

## task-with-review

```
coding (agentRun coder) ──request_review──▶ reviewing (agentRun reviewer)
reviewing ──changes_requested (under cap)──▶ coding            [rounds++]
reviewing ──approved / cap hit──▶ humanReview (gate)
coding/reviewing ──agent.fault──▶ humanReview (gate)
humanReview ──approve──▶ done (final → Workspace teardown)
humanReview ──request_changes {notes}──▶ coding                [fresh cycle]
```

Input (`--input` JSON): `prompt` (the task), `repo` (a catalog name from `j2.config.ts`), `branch` — all required;
`baseRef` (default `main`), `reviewRounds` (default 3).

**The Gate park is the inspection window.** While `humanReview` is open the Sandbox stays alive: exec in, read the diff,
and push it if the work should outlive the run — `approve` reaches the final state, which tears the Workspace down, and
**unpushed commits go with it** (by design; agent-driven push is a follow-up).

## Runbook

The everyday story is two commands (ADR-0019): point kubectl at a cluster, `j2 up`. Everything below the fold is kit-dev
bring-up that exists only because nothing is published yet — the config pins locally built image tags, so the images
must be built + `kind load`ed first.

One-time setup (repo root):

```sh
# 0. a cluster — any vanilla one; kind locally. Nothing about it is j2- or instance-specific.
just kind-up

# 1. kit images (kit-dev only, until published <kitversion> images exist): the stock Harness
#    (assembles agents/ at pod start — ADR-0018), the Adapter, and the operator.
just harness-image-stock
just adapter-image
kind load docker-image j2-adapter:local --name j2
just operator-image

# 2. the model, in examples/coding/.env (uncommitted; the CLI loads the .env beside j2.config.ts
#    into the environment the config reads — ADR-0019):
#      VLLM_BASE_URL=https://<address>/v1             # reachable FROM PODS — never localhost
#      J2_MODEL=vllm/<model-id-as-served>
#    vLLM must run with --enable-auto-tool-choice and the matching --tool-call-parser; `j2 up`
#    preflights both from inside the cluster (one trivial tool-call completion) and fails loudly
#    if the endpoint or the parser is wrong.
#    An HTTPS endpoint signed by a private CA: commit the PEM beside the config and point
#    `harness.caBundle` at it (this instance does — `ca.crt`); pods and the preflight trust it
#    via NODE_EXTRA_CA_CERTS (ADR-0020). Token limits for the served model are committed in
#    j2.config.ts (`provider.models` — flue resolves them per model id; unset would mean 0,
#    starving auto-compaction).
#    (Anthropic instead: J2_MODEL=anthropic/claude-sonnet-4-6, create the `anthropic` Secret, and
#    add `envFrom: [{ secretRef: { name: "anthropic" } }]` to `harness` in j2.config.ts.)
```

Converge + run (from `examples/coding`, or any folder under it — the CLI walks up to `j2.config.ts` and loads the `.env`
beside it; a var already set in your shell wins over the file):

```sh
j2 up                 # converges the current context: operator → instance image → agents ConfigMap
                      # → Secrets (+ preflights) → provider preflight → rollout. Idempotent; re-run
                      # after any change. First contact asks; --yes for CI.

j2 run task-with-review --input '{"prompt":"Fix the ...","repo":"obsidian-tasks.nvim","branch":"task/mvp-1"}'
j2 visualize task-with-review             # the Machine + live runs panel (served by the orchestrator)
j2 logs <runId> -f                        # re-attach to the status feed
```

Every run-verb prints its target (`→ context kind-j2 / namespace coding`) on stderr — the cluster is always whatever
your kube context points at (`--context` / `-n` override; `--url`/`J2_URL` bypasses kube entirely).

At the Gate (`j2 status <runId>` shows the open gate, its accepts, and `meta.reason` — approved / review-cap /
agent-fault):

```sh
kubectl -n coding get sandboxes           # the run's Workspace pod
kubectl -n coding exec -it <pod> -c harness -- sh   # inspect: git -C /work/obsidian-tasks.nvim/<branch> log -p main..
# keep the work? push it from inside the pod (or from the User Container) BEFORE approving

j2 send <runId> --gate humanReview --event request_changes --input '{"notes":"..."}'   # loops the coder
j2 send <runId> --gate humanReview --event approve                                     # finals → Sandbox torn down
```

Verify teardown: `kubectl -n coding get sandboxes` is empty and `j2 status <runId>` reports the run settled with
`{ outcome: "approved", branch }`. `j2 down` removes the whole instance (namespace and all); `--all` takes the
per-cluster operator too.

## The surface (ADR-0015..0017), in brief

- **Six statically-imported names**: `defineEvent`, `j2Setup`, `agentRun` + `gate` (pre-registered, invoked by name),
  `workspace`, `pool`/`source`. The module contract is `export const machine`; the filename is the workflow name.
- **Events are the workflow's vocabulary**; `audience` tags who may deliver. A state that invokes `agentRun` gets the
  agent-events its transitions handle as its Agent's tool menu; a `gate` state gets the external set the same way.
- **`agentRun` takes `{ agent, prompt }`.** Sessions are fresh by default; endpoint and Sandbox resolve ambiently from
  the enclosing `workspace()`; the workflow sees ONE terminal `agent.fault { reason }`.
- **`workspace(body, spec)` owns Sandbox lifecycle only** and hands the body `{ workdir, repos, branch }`. A body that
  parks keeps its Sandbox alive — that _is_ the retain policy.
- **`j2.config.ts` `repos` is the catalog**: the boot reconcile clones each entry onto the in-cluster source volume
  (`repos/<name>/default`, read-only in pods — ADR-0004); the workflow's `workspace()` spec picks which entries a run
  mounts — task-with-review takes the name as run input.

## agents/ — the Agent definitions

Plain-data definitions (ADR-0018): `agents/<name>.ts` is `export default defineAgent({ instructions, … })` — filename =
Agent name, no flue imports, typechecked with the instance, `model` optional (inherits `harness.model`). `j2 up`
publishes them as a ConfigMap; the **stock Harness image** assembles them at pod start (one generated flue shim per
definition, carrying the Adapter leash — `connectMcpServer` against `$J2_ADAPTER_URL/mcp/<id>` per submission, ADR-0013)
and `flue build`s in ~0.5 s, offline. Editing a definition is a `j2 up` + pod restart — no image build anywhere.

## Follow-ups (deliberately out of scope here)

MCP server over the orchestrator API (kick off runs from a coding agent); a global runs-index web UI (the viz page is
per-workflow); `j2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb, ADR-0019); agent-driven
push (git credentials in the Sandbox); `--watch` (rebuild-redeploy inner loop).
