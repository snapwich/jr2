# What code names, config declares; what the CLI names, discovery finds

A Machine names things outside itself by string, and until now the first sign of a wrong string was an invoke-time
failure mid-run. ADR-0049 moved Agents and Sandbox Images INTO the Machine — actor slots and a `workspace()` option — so
those names are typed by xstate's own `src` typing and by the Machine's own parts. One dependency stays outside, because
it is a deployment fact and not a Machine's: the **Repo**, an entry in the Instance's catalog (ADR-0004).

## Decision

- **One rule decides where a definition lives.** A thing that **code refers to by name** and that a Machine cannot carry
  is declared in `j2.config.ts`, so the type system sees the name. A thing that **only the CLI or HTTP API refers to by
  name** is discovered from files. Repos are the former. Workflows are the latter — `j2 run` and
  `POST /workflows/:name/runs` name them, a nested Machine is reached by `import` (ADR-0049) — so `workflows/` stays
  filename-discovered. Agents and images are neither: they ride the Machine (ADR-0049), and the `agents/` folder,
  `config.agents`, and `config.images` all retire.
- **The Register types repo names.** `@j2/orchestrator` exports an empty `interface Register {}`;
  `defineConfig<const T>` keeps literals, and the scaffold writes
  `declare module "@j2/orchestrator" { interface Register { config: typeof config } }` into `j2.config.ts`. `RepoName`
  derives from it by the same rule as `repoName()`, and `WorkspaceSpec.repos[].name` is typed by it. A repo entry whose
  url is not a literal must carry a literal `name`, enforced at `defineConfig`: an unregistered name is a compile error,
  never a silent widening to `string`. A door that takes a repo name uses `z.enum(repoNames)`.
- **`j2 up` typechecks the Instance before it builds anything**, and refuses on errors, naming them. The scaffold's
  `tsc --noEmit` and pinned compiler already exist (ADR-0043's rule for the checker); this makes them a gate instead of
  a script the user may run. A wrong slot name, a mistyped repo, a `customize()` of an Agent the Machine does not carry:
  all stop here.

## Considered options

- **A generated declaration** (`j2-env.d.ts` written by `init`/`up` from directory discovery), to keep `agents/` and
  `images/` as folders and still type their names. Rejected: a generated-file class j2 does not have, an editor
  staleness window, and — decisive — ADR-0049 removed the need by making the names part of the Machine.
- **Agents and images as config entries** (`agents: { scribe }`, `images: { default: "./images/default" }`), the shape
  this ADR first took. Rejected the same day: it typed the names but kept them Instance-scoped, so a packaged Machine
  still depended on someone else's config holding the right strings, and one run could not hold two Machines each
  carrying a `coder`.

## Consequences

- Only Machines the Instance's program typechecks get the compile-time guarantee — those under `workflows/` and what
  they import. A packaged Machine compiled elsewhere carries its own parts, so its internal names are checked where it
  was built; the repo it works on reaches it through its door, typed by the consumer's mapper.
- Runtime validation stays: the port still refuses an unknown repo at attach. The type error is the earlier check, not
  the only one.
