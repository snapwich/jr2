---
title: Fix a failed converge
description: Read what jr2 up prints when it refuses or fails, and fix the cause.
---

Find the cause of a failed `jr2 up` in its output, and fix it.

The examples on this page use the [Get started](../get-started/install.md) names: the
[Instance](../reference/glossary.md#instance) `my-instance` and the kubectl context `kind-jr2`.

## Read the output

[`jr2 up`](../reference/cli.md#up) prints one line for each step. When it refuses, the line starts with `refusing:`.
When a step fails, the line starts with `error:`. In the two cases, `jr2 up` exits with the code 1, and the line tells
you what to change. Many lines end with the ADR that gives the rule.

For example, change `input.message` to `input.mesage` in the `context` line of `workflows/ping.ts`. Then run `jr2 up`:

```sh
jr2 up
```

```text
…
jr2 up — instance "my-instance" → context kind-jr2 / namespace my-instance
typecheck: tsc --noEmit (the instance's own compiler)
refusing: this instance does not typecheck — nothing was built and nothing was applied
  workflows/ping.ts(45,45): error TS2551: Property 'mesage' does not exist on type 'Input'. Did you mean 'message'?
```

The first line (`…`) is the `.env` line, when `.env` sets a variable that your shell does not set. The refusal comes
before `jr2 up` reads the cluster, so the cluster did not change. Each line after it is a line from the TypeScript
compiler of the Instance. To see the same errors without `jr2 up`, run `npm run typecheck`.

Correct the typo. Then run `jr2 up` again. You can run `jr2 up` again after each fix. It does not build an image again
when the inputs of the image did not change.

The checks of the config, the compiler and the [Machines](../reference/glossary.md#machine) come before `jr2 up` reads
the cluster. The checks of the context, the API server, the Kubernetes version and the namespace come before `jr2 up`
changes the cluster. Thus these refusals change nothing in the cluster. The pod-level resources refusal comes after
`jr2 up` makes the namespace. Other errors can come after `jr2 up` applied some parts. When you fix the cause, run
`jr2 up` again. A converge that fails removes no image. [Converge](../concepts/converge.md#what-jr2-up-does) gives the
order of the steps.

## Fix a rollout that does not complete

After `jr2 up` applies each part, it waits for the rollout of that part. When a rollout does not complete in time,
`jr2 up` reads the pods and prints what they say:

<!-- output: not run -->

```text
…
orchestrator: waiting for rollout
error: jr2-orchestrator: rollout did not complete in namespace my-instance — the pods say:

  pod <pod> (<phase>) on node <node> (<arch>)
    container <container>: <reason>
      image <image>
      <message>
    event <event>
    logs (<container>, last lines):
      | <log line>

diagnosis: <the cause>
  <the fix>

<the error of kubectl>
```

The first line names the part: `jr2-orchestrator`, `jr2-controller-manager` (the operator, in `jr2-system`),
`jr2-repo-cache`, `jr2-instance-harness` or `jr2-instance-effector`. Read the reason, the events and the logs of the
pod. When `jr2 up` knows the cause, it adds a `diagnosis:` line. The diagnosis explains only the evidence above it.

| The diagnosis starts with                                      | The cause and the fix                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnosis: <pod> carries an image built for another platform` | The image is for a different CPU architecture than the node. Run `jr2 up --force` to build the image again. Or set [`platforms`](../reference/config.md#platforms).                                                                                                                                      |
| `diagnosis: the kubelet could not pull <image>.`               | The node cannot get the image. The next line gives the full address. On kind, for an image that jr2 built, run `jr2 up --force` to build the image and load it again. With a [`registry`](../reference/config.md#registry), check that the push arrived and that the cluster can pull from the registry. |
| `diagnosis: <pod> starts and exits`                            | The container stops after it starts. The log lines above give the reason. When there are no log lines, run the `kubectl -n <namespace> logs <pod> --previous` command that the diagnosis gives, after the pod starts again.                                                                              |
| `diagnosis: the pod's env references <kind> "<name>"`          | The pod names a Secret or a ConfigMap that is not in the namespace. Make it. Then run `jr2 up` again.                                                                                                                                                                                                    |
| `diagnosis: the container's configuration cannot be built`     | The pod names an object that the namespace does not have. The message above names the object. Make it. Then run `jr2 up` again.                                                                                                                                                                          |

A [Kit image](../reference/glossary.md#kit-image) that the cluster cannot pull is at `ghcr.io/snapwich`, or at the
[`kitRegistry`](../reference/config.md#kitregistry) mirror. See [Mirror the Kit images](mirror-the-kit-images.md).

## Rules

The list gives the refusals and the errors in the order that `jr2 up` meets them. Each `refusing:` line and each
`error:` line makes `jr2 up` exit with the code 1. A `warning:` line does not stop the converge.
[Give the cluster git credentials](give-the-cluster-git-credentials.md) gives the refusals of `git.credentials` and of
the git ssh key. [Use a hosted provider](use-a-hosted-provider.md) gives the other refusals of `secrets` and
`harness.env`. [Run a command or call a URL with an Effect](run-a-command-or-call-a-url.md) gives the refusals of an
[Effect secret](../reference/glossary.md#effect-secret). [Write a Workflow](write-a-workflow.md) gives the refusals of a
[Workflow](../reference/glossary.md#workflow) module. [Push and sign a branch](push-and-sign-a-branch.md) gives the
refusals of a push and of the [Effector](../reference/glossary.md#effector) image.
[Use a local model](use-a-local-model.md) gives the refusals of `caBundle`.

- `jr2 up` runs only in an Instance folder:
  `error: not inside a jr2 instance — no jr2.config.ts found walking up from cwd`
- The Instance and the [jr2 CLI](../reference/glossary.md#jr2-cli) must use the same
  [Kit version](../reference/glossary.md#kit-version). If not, `jr2 up` prints
  `error: Kit version mismatch — an Instance has one (ADR-0056):`, then three lines. The third line is one of these
  fixes:
  - `install the Instance's dependencies (<folder>/package.json pins "@jr2/orchestrator" and "@jr2/cli" at one exact version)`.
    Run `npm install` in the Instance folder.
  - `pin "@jr2/orchestrator" and "@jr2/cli" at ONE exact version in <folder>/package.json and reinstall`. Give the two
    packages the same version. Then run `npm install`.
  - `add "@jr2/cli": "<version>" to devDependencies in <folder>/package.json and reinstall — the Instance's own jr2 then runs`
- `jr2.config.ts` must have a default export:
  ``error: <folder>/jr2.config.ts has no default export (use `export default defineConfig({…})`)``
- `jr2 up` checks the shape of `git`, `secrets`, `harness`, `sandbox` and `priorityClasses` when it loads
  `jr2.config.ts`. The error names the field, and then the problem:
  `error: <folder>/jr2.config.ts at <field>: <problem>`. See [`jr2.config.ts`](../reference/config.md).
- `jr2 up` needs a kubectl context:
  `` error: no kube context — `kind create cluster` (or point kubectl at one), then re-run `jr2 up` ``. See
  [Install](../get-started/install.md).
- The Instance must have the `tsconfig.json` that `jr2 init` writes:
  ``error: this instance has no tsconfig.json — `jr2 init` scaffolds one that extends `@jr2/orchestrator/tsconfig.instance.json`, and `jr2 up` typechecks the folder before it builds anything``
- The Instance must install its TypeScript compiler. Run `npm install`. The refusal starts with:
  ``error: this instance's TypeScript compiler is missing — install its dependencies (npm, pnpm, or bun), then re-run `jr2 up`.``
- The Instance must typecheck: `refusing: this instance does not typecheck — nothing was built and nothing was applied`
- A registered Machine must have no [Open](../reference/glossary.md#open) part. The refusal gives the
  [`customize()`](../reference/authoring-surface.md#customize) line that binds the part. Put it in
  `workflows/<workflow>.ts`. Replace `<import>` with the name that you import the Machine as. Give the values in the
  `<>`. See [Bind a shipped Machine's Open parts](bind-open-parts.md).
  - `refusing: workflow "<workflow>" leaves Repo Slot "<slot>" open — bind it where the Machine is registered: export const machine = customize(<import>, { repos: { <slot>: "<url>" } })  (ADR-0051)`
  - `refusing: workflow "<workflow>" leaves its Repo Slots open — bind it where the Machine is registered: export const machine = customize(<import>, { repos: { <slot>: "<url>" } })  (ADR-0051)`
  - `refusing: workflow "<workflow>" leaves Agent "<agent>" open — bind it where the Machine is registered: export const machine = customize(<import>, { agents: { <agent>: { model: "<provider>/<model>" } } })  (ADR-0054)`
  - An [Effect](../reference/glossary.md#effect). `<parts>` is `url`, `argv`, `secret`, `url and secret` or
    `argv and secret`. The binding object has one sample for each part, from `url: "https://<host>/<path>"`,
    `argv: ["<program>", "<arg>"]` and `secret: "<name>"`. For example:
    `refusing: workflow "<workflow>" leaves the url and secret of Effect "<effect>" open — bind it where the Machine is registered: export const machine = customize(<import>, { effects: { <effect>: { url: "https://<host>/<path>", secret: "<name>" } } })  (ADR-0054)`
  - When the part is on a Machine that a different Machine invokes, the refusal adds
    `(on the Machine composed as "<slot>")` after `open`. Its `customize()` line binds the part through `actors`, for
    example `customize(<import>, { actors: { <slot>: { repos: { <repo slot>: "<url>" } } } })`. At each deeper level,
    the parenthetical adds ` → "<slot>"`, and the `customize()` line adds one more `actors`.
  - When the Machine is invoked inline, no `customize()` line can reach it:
    `refusing: workflow "<workflow>" leaves <part> open on a Machine invoked inline — no customize() reaches an actor without a slot key; declare that Machine under setup({ actors }) and bind it there  (ADR-0049, <ADR>)`
- The [Size](../reference/glossary.md#size) of each [Workspace](../reference/glossary.md#workspace) must leave the
  [Harness](../reference/glossary.md#harness) container enough memory and cpu. The refusal starts with
  `refusing: workflow "<workflow>": the Size leaves the Harness container`. It gives the numbers that it subtracts and
  where each one comes from, and the field to make larger. See [Size a Workspace](size-a-workspace.md). It ends with
  this text:
  `; a composer retunes it where the Machine is registered: export const machine = customize(<import>, { resources: { limits: { memory: "<memory>" } } })`
  When the Machine is invoked inline, the refusal has no `customize()` line.
  - When the Size is on a Machine that a different Machine invokes, the refusal starts with
    `refusing: workflow "<workflow>" (on the Machine composed as "<slot>"): the Size leaves the Harness container`. Its
    `customize()` line sets the memory of the Size through `actors`:
    `customize(<import>, { actors: { <slot>: { resources: { limits: { memory: "<memory>" } } } } })`. At each deeper
    level, the parenthetical adds ` → "<slot>"`, and the `customize()` line adds one more `actors`.
- `jr2 up` makes the [Assembly](../reference/glossary.md#assembly) before it reads the cluster. The Assembly must not
  hold a second copy of a Kit package, such as `@jr2/orchestrator`, `xstate` or `zod`:
  `error: cannot stage the Assembly: it would carry a second copy of a Kit package (ADR-0069)`. Each line after it names
  one copy:
  `<path> is a second copy of <package>, nested by <package>: the Orchestrator's image ships <package> for @jr2/orchestrator <version>, and an Assembly that carries its own copy loads Machines whose Menus are empty (ADR-0054) — align that dependency with the <package> @jr2/orchestrator uses, or remove it, and reinstall`.
  Give the dependency that nests the copy a version that uses the same `<package>` as `@jr2/orchestrator`. Then run
  `npm install`.
- A symlink in the Assembly must stay in the Assembly:
  `error: cannot seal the Assembly: the symlink <path> points outside the Assembly ("<target>") — an Assembly carries only what it holds; <fix>`.
  The fix is `install that dependency as a copy, not a link` for a link in `node_modules`, and
  `make the link relative, with a target inside the Instance` for a different link.
- A file in the Assembly must not hold the path where `jr2 up` makes the Assembly. The refusal starts with
  `error: cannot seal the Assembly: <file> holds the staging path (<path>)`. A `postinstall` step of a dependency is the
  usual cause.
- The Assembly must hold each Workflow of the folder. The refusal starts with
  `refusing: the staged Assembly does not hold the Workflows this folder holds (ADR-0069)`, and names each file. It ends
  with ``— the Assembly holds what the Instance's install keeps; check the `files:` list in package.json``.
- `jr2 up` must reach the API server of the context:
  `refusing: cannot reach the API server of <context> (<error>). Nothing was applied.` For example, with
  `--context nope`, the error is `error: context "nope" does not exist`. Check the context with
  `kubectl config current-context`. Check that the cluster runs.
- The cluster must run Kubernetes 1.35 or later:
  `refusing: <context> runs Kubernetes <version>; jr2 needs Kubernetes 1.35 or newer (every Sandbox mounts jr2's runtime as an image volume, ADR-0037). Nothing was applied.`
  For kind, install a newer kind release. Then make the cluster again.
- The namespace must not belong to a different Instance:
  `refusing: namespace "<namespace>" on <context> belongs to another instance ("<owner>")`, then
  `  pick a different namespace (-n) or context (--context)`. Set [`name`](../reference/config.md#name) in
  `jr2.config.ts`, or add `-n <namespace>`.
- Before `jr2 up` uses a namespace for the first time, it asks:
  `first contact: deploy instance "<instance>" to context <context> (create namespace "<namespace>")? [y/N]`. For a
  namespace that exists but holds no Instance, it asks to `adopt existing namespace "<namespace>"`. When you do not type
  `y`, it prints `aborted — nothing was changed`. When no terminal is attached, it prints
  `<question> — not a tty; pass --yes to proceed non-interactively` first. In CI, add `--yes`.
- The cluster must keep pod-level resources. `jr2 up` makes the namespace, and then it stops:
  `refusing: <context> (Kubernetes <version>) drops pod-level resources — the PodLevelResources feature gate is off, and a Workspace's Size cannot hold (ADR-0060). Enable the gate on the API server and kubelets. The namespace was created; nothing else was applied.`
- When `jr2 up` cannot confirm pod-level resources, it warns and continues:
  `warning: could not confirm pod-level resources on <context>: <error>`
- jr2 builds only for the platforms that the Kit releases images for:
  ``error: <what> — the kit releases images for <kit platforms> and nothing else, so an image built for anything else could not be joined by a Kit image in the same pod. Set `platforms` in jr2.config.ts (docker platform strings, e.g. "linux/arm64") to name the set to build for.``
  `<what>` is `` `platforms` names <platforms> ``, or `this cluster's schedulable nodes report <architectures>`. Set
  [`platforms`](../reference/config.md#platforms) to platforms from the list after `the kit releases images for`.
- When no node can hold a [Sandbox](../reference/glossary.md#sandbox), `jr2 up` warns and continues:
  `warning: no Sandbox node right now — a Sandbox stays Pending until one appears:`. Each line after it gives a node,
  and why a Sandbox cannot use it. A [Sandbox node](../reference/glossary.md#sandbox-node) can appear later. To admit a
  node with a taint or a label, set [`sandbox`](../reference/config.md#sandbox) in `jr2.config.ts`.
- When no Sandbox node has the memory and cpu for a Size, `jr2 up` warns and continues:
  `warning: no Sandbox node right now has the allocatable for a Size of <size> (workflow "<workflow>") — its Sandbox stays Pending until one does`
- Images for two or more platforms need a `registry`:
  `` error: this cluster needs a <platforms> build, which docker buildx delivers by PUSHING a manifest list (kind load cannot carry one) — set `registry` in jr2.config.ts, or name a single platform with `platforms` ``
- A cluster that is not kind needs a [`registry`](../reference/config.md#registry):
  ``error: context <context> is not a kind cluster and no `registry` is configured — set `registry` in jr2.config.ts (from env) so the image can be pushed (ADR-0019)``.
  jr2 knows a kind cluster by its context name, which starts with `kind-`. See
  [Move from kind to a shared cluster](move-from-kind-to-a-shared-cluster.md).
- The Instance folder must hold the lockfile of one package manager. `<folder>` is the path of the Instance folder:
  - Lockfiles of two managers:
    `error: <folder> holds lockfiles from more than one package manager (<manager>: <lockfile>; <manager>: <lockfile>) — delete the stale one, so the bundle installs the dependency graph the instance really uses`.
    Delete the lockfile of the manager that you do not use.
  - A `yarn.lock`: `error: <folder> has a yarn.lock, and yarn is not supported — use npm, pnpm, or bun`. Install with
    npm, pnpm or bun, and delete `yarn.lock`.
  - No lockfile:
    `error: <folder> has no lockfile — jr2 installs the instance's dependencies from npm (package-lock.json), pnpm (pnpm-lock.yaml), bun (bun.lock or bun.lockb); run your package manager's install and commit the lockfile it writes`.
    Run `npm install`, and commit `package-lock.json`.
- To build for a different CPU architecture, docker needs qemu emulation. The refusal gives the command that installs
  it:
  `error: this host cannot build for <missing platforms>: a foreign architecture's RUN steps need qemu binfmt emulation, and none is registered (this builder targets <builder platforms>). Install it, then re-run:`,
  then `  docker run --privileged --rm tonistiigi/binfmt --install <arch>`
- The folder of each [Sandbox Image](../reference/glossary.md#sandbox-image) that a
  [`workspace()`](../reference/authoring-surface.md#workspace) names must exist:
  ``error: the Sandbox Image context <folder> cannot be read (<code>) — a `workspace()` names its image with `import.meta.resolve("./<dir>")`, so that directory must exist beside the Machine's own module (ADR-0037/0049).``
  See [Add tools to the Sandbox](add-tools-to-the-sandbox.md).
- Each Secret that [`harness.envFrom`](../reference/config.md#harness-envfrom) names must exist:
  `error: harness.envFrom references Secret "<name>", which does not exist in namespace "<namespace>" — create it first: kubectl -n <namespace> create secret generic <name> --from-literal=KEY=...`
- Each [`secrets`](../reference/config.md#secrets) entry that a pod or an Effect uses needs one value. A variable that
  is not set in `.env` gives no value:
  `error: secrets[<i>] needs exactly one of value or valueFrom — <NAME> has neither, which is what an unset .env variable reads as: set <NAME> in .env, or reference a Secret with valueFrom: { secretKeyRef: { name, key } } (ADR-0059)`.
  Add the variable to `.env`. An entry with the two gives `not both` in place of the text after the dash.
- A value must not be empty: `error: secrets[<i>].value is empty — set <NAME> in .env (ADR-0059)`
- A value must hold only printable ASCII, with no space at its start or end:
  `error: secrets[<i>].value holds a character a header cannot carry (outside printable ASCII) or leading or trailing space — a pasted newline, most likely; the value itself is not shown (ADR-0059)`.
  Remove the newline or the space from the value in `.env`.
- The Secret that a `valueFrom` names must exist, with its key:
  `error: secrets[<i>].valueFrom names Secret "<name>", which does not exist in the instance's namespace — create it first: kubectl create secret generic <name> --from-literal=<key>=... (ADR-0019, ADR-0059)`,
  and `error: secrets[<i>].valueFrom names key "<key>" of Secret "<name>", which has no such key (ADR-0059)`
- When [`harness.provider`](../reference/config.md#harness-provider) is set and an
  [Agent](../reference/glossary.md#agent) uses its models, a pod in the cluster asks the provider for one tool call.
  When the call fails:
  `error: provider preflight failed for model "<model>" against <url> (from inside the cluster): <error>`. Four lines
  follow, with the usual causes:

  ```text
    - localhost never works from a pod; use a LAN address
    - the model id must be exactly what the endpoint serves (vLLM: GET /v1/models)
    - vLLM needs --enable-auto-tool-choice and a matching --tool-call-parser
    - finish_reason "length" means the model ran out of tokens before the call (a thinking model reasons first)
  ```

  See [Use a local model](use-a-local-model.md).

- Each rollout must complete. The error starts with
  `error: <part>: rollout did not complete in namespace <namespace> — the pods say:`. See
  [Fix a rollout that does not complete](#fix-a-rollout-that-does-not-complete). The rollout of the operator
  (`jr2-controller-manager`) comes before the check of the Sandbox Images. With an installed Kit, it also comes before
  the lockfile check, the registry check of a cluster that is not kind, and the qemu check. The other rollouts come
  after the provider check.
- When the rollout made no pod, the error says:
  `no pod matches <selector> — the ReplicaSet made none (check quota, node taints, and the selector)`. For the Repo
  cache and the [Instance Harness](../reference/glossary.md#instance-harness), it names the DaemonSet or the
  StatefulSet.
- After each rollout, the pods must run the image that `jr2 up` expected. `<layer>` is `operator`, `orchestrator`,
  `repo cache`, `instance harness` or `instance effector`:
  ``error: <layer>: rollout reported success, but the running pod carries <images> — expected <image>. The cluster is serving code this converge did not deploy; `kubectl -n <namespace> rollout restart deploy` and re-run `jr2 up` to resolve it.``
- When the rollout completes but no pod matches, `jr2 up` cannot check the image. It continues:
  `<layer>: WARNING — rollout succeeded but no pod matched <selector> (nothing verified)`
- Before the publish, the Orchestrator must read the image map that `jr2 up` wrote. When it does not read it in time,
  `jr2 up` publishes nothing:
  ``refusing: after <seconds>s the Orchestrator still reads an older <maps> from its mount — the kubelet has not refreshed it; nothing was published, and the previous Assembly is still current. Run `jr2 up` again``
- The Orchestrator checks the Assembly again before it makes it current. It loads each Workflow and `jr2.config.ts`. It
  refuses an [Open](../reference/glossary.md#open) part that nobody bound, a secret that the config does not declare,
  and a Kit version that is not its own. The refusal gives the status code and the reason, then one line for each
  problem:
  `refusing: the Orchestrator refused Assembly <hash> (HTTP <status>): <error> — the previous Assembly is still current`.
  Fix each problem. Then run `jr2 up` again.

## Read next

- [Converge](../concepts/converge.md)
- [ADR-0046](../reference/decisions/0046-a-converge-failure-carries-its-diagnosis.md): why a failed rollout prints the
  evidence of its pods.
- [ADR-0050](../reference/decisions/0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md): why
  `jr2 up` typechecks the Instance first.
- [ADR-0054](../reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md): why
  `jr2 up` refuses an Open part.
- [ADR-0056](../reference/decisions/0056-a-global-jr2-hands-off-to-the-instances-own-and-an-instance-has-one-kit-version.md):
  why an Instance has one Kit version.
- [ADR-0069](../reference/decisions/0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md): why
  `jr2 up` makes an Assembly and publishes it.
- [ADR-0019](../reference/decisions/0019-one-converging-command-against-the-current-context.md): the current context and
  the namespace.
- [ADR-0045](../reference/decisions/0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md): how
  `jr2 up` chooses the platforms.
- [`jr2 up`](../reference/cli.md#up), [`jr2.config.ts`](../reference/config.md)
- [Clean up](clean-up.md)
