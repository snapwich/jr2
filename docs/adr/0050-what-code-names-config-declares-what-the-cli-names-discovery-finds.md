# What code names, config declares; what the CLI names, discovery finds

A Machine names things outside itself by string, and until now the first sign of a wrong string was an invoke-time
failure mid-run. ADR-0049 moved Agents and Sandbox Images INTO the Machine — actor slots and a `workspace()` option — so
those names are typed by xstate's own `src` typing and by the Machine's own parts. ADR-0051 moved the last one, the
**Repo**, the same way: a slot on the `workspace()`, bound by url. What this decision fixes is the rule that says where
a definition lives, and the gate that enforces it.

## Decision

- **One rule decides where a definition lives.** A thing that **code refers to by name** and that a Machine cannot carry
  is declared in `j2.config.ts`, so the type system sees the name. A thing that **only the CLI or HTTP API refers to by
  name** is discovered from files. Workflows are the latter — `j2 run` and `POST /workflows/:name/runs` name them, a
  nested Machine is reached by `import` (ADR-0049) — so `workflows/` stays filename-discovered. Agents, images, and
  Repos are neither: they ride the Machine (ADR-0049, ADR-0051), and the `agents/` folder, `config.agents`,
  `config.images`, and `config.repos` all retire. Nothing is left that code names and a Machine cannot carry, so the
  first clause holds vacuously — and stays, so the next dependency lands on the right side of it. `j2.config.ts` holds
  reach and credentials (`harness`, `git.credentials`, `registry`), which no code names.
- **The slot key types a Repo.** A `workspace()` declares its Repos as slots —
  `repos: { target: open, docs: { url, ref } }` — and the keys are a phantom on the wrapper type, read through
  `pool()`'s `worker` and `workspace()`'s `body` as the image is (ADR-0049). A
  `customize(machine, { repos: { <slot>: url } })` of a slot the Machine does not declare is a compile error, never a
  silent widening to `string`, and the body's `workspace.repos.<slot>` handle is typed by the same keys. There is no
  `Register`, no `RepoName`, and no `repoNames()`: the url a Machine writes is the thing, not a reference into someone
  else's file (ADR-0051). A door that offers a menu of Repos is the Instance's own `z.enum` of urls.
- **`j2 up` typechecks the Instance before it builds anything**, and refuses on errors, naming them. The scaffold's
  `tsc --noEmit` and pinned compiler already exist (ADR-0043's rule for the checker); this makes them a gate instead of
  a script the user may run. A wrong slot name, a `customize()` of an Agent or a Repo Slot the Machine does not carry:
  all stop here. One Repo check is converge-time and not compile-time: a registered Machine with an open slot nobody
  bound. A `workflows/` export has no type to hang it on, so the walk that follows the typecheck refuses it, before it
  builds anything, naming the Machine, the slot, and the `customize` line that fixes it (ADR-0051).

## Considered options

- **A generated declaration** (`j2-env.d.ts` written by `init`/`up` from directory discovery), to keep `agents/` and
  `images/` as folders and still type their names. Rejected: a generated-file class j2 does not have, an editor
  staleness window, and — decisive — ADR-0049 removed the need by making the names part of the Machine.
- **Agents and images as config entries** (`agents: { scribe }`, `images: { default: "./images/default" }`), the shape
  this ADR first took. Rejected the same day: it typed the names but kept them Instance-scoped, so a packaged Machine
  still depended on someone else's config holding the right strings, and one run could not hold two Machines each
  carrying a `coder`.
- **A Repo catalog in config, typed back through a `Register` interface** (`repos: [{ name, url }]`, a `RepoName`
  derived from `typeof config`, `z.enum(repoNames(config))` on a door), the shape this ADR took for the one dependency
  it left in config. Rejected in ADR-0051 by the argument above: a packaged Machine still could not say which repository
  it works on, and a consumer could bind one only by holding the right NAME. The slot key is the type now.

## Consequences

- Only Machines the Instance's program typechecks get the compile-time guarantee — those under `workflows/` and what
  they import. A packaged Machine compiled elsewhere carries its own parts, so its internal names are checked where it
  was built; the Repo it works on is an open slot the consumer binds with `customize`, typed by the package's own slot
  keys, or a per-run slot typed by the consumer's mapper over the door.
- Runtime validation stays: an open slot nobody bound is a `j2 up` walk refusal, and the attach still refuses a per-run
  url no `git.credentials` entry matches (ADR-0051). The type error is the earlier check, not the only one.
