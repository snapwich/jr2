# docs/site

This folder holds the source of the jr2 docs: the hand-written pages and the navigation. `docs:build` reads it and makes
the docs bundle that `@jr2/orchestrator` ships. VitePress renders the same pages, with the Reference of the bundle, as
the site ([ADR-0072](../adr/0072-the-docs-ship-inside-the-kit-and-an-instances-agents-md-indexes-them.md)). This README
is for contributors. It is not a page of the docs.

## Layout

| Path              | Contents                                                                           |
| ----------------- | ---------------------------------------------------------------------------------- |
| `sitemap.json`    | The navigation: the sections, the groups, and the pages, in order.                 |
| `index.md`        | Home.                                                                              |
| `why.md`          | Why jr2.                                                                           |
| `get-started/`    | The tutorial pages.                                                                |
| `concepts/`       | The Concepts pages.                                                                |
| `guides/`         | The Guides pages.                                                                  |
| `tutorial/greet/` | The tutorial fixture: a small Node CLI with one failing test. Get started uses it. |
| `examples/`       | The code that a page imports. `pnpm typecheck` checks it against the Kit.          |
| `build/`          | `docs:build`: it makes the bundle and generates the Reference.                     |
| `.vitepress/`     | The site: the VitePress config, the theme, and the nav from `sitemap.json`.        |
| `test/`           | The tests for `sitemap.json`, the tutorial fixture, `docs:build`, and the nav.     |

A Reference page has no source file here. `docs:build` makes the Reference pages from the code, from `GLOSSARY.md`, and
from `docs/adr/`. `pnpm docs:site` writes them to `reference/` for VitePress. That folder is not in git.

## The navigation

`sitemap.json` is the navigation. `docs:build` reads it, and `.vitepress/nav.ts` makes the nav and the sidebar of the
site from it. A page that is not in `sitemap.json` is not in the docs.

- A section has `pages`, or `groups` that each have `pages`. It does not have both.
- A page has a `slug`, a `title`, and a `source`.
- The `slug` is the path of the file relative to this folder, without `.md`. For example, `concepts/workspaces` is
  `concepts/workspaces.md`.
- The `source` is `page` for a file in this folder, or `generated` for a page that `docs:build` makes.

To add a page, write the file and add it to `sitemap.json`. `pnpm --filter @jr2/docs-site test` checks the shape of
`sitemap.json`, and that the site shows each page one time.

## Writing pages

Every hand-written page obeys these rules, so that the pages agree. [Tutorial facts](#tutorial-facts) gives the names
that the Get started pages share. [The source format](#the-source-format) gives the syntax.

### The readers

- The reader is the Instance user. This person installs the jr2 CLI, makes an Instance, and runs `jr2 up` against a
  cluster.
- Home and Why jr2 also serve the evaluator. The evaluator wants to know why jr2 exists before they install it.
- A contributor to jr2 is not a reader. The repo serves the contributors.
- An Assistant writes most Machines. The person asks for a Machine and reads its graph. Thus a Guide has one text for
  the person and for the Assistant. The bundle gives the same file to the Assistant.

### The voice

- Speak to the reader as "you".
- Write a step in the imperative: "Run `jr2 up`."
- Use the present tense.
- Obey ASD-STE100 Simplified Technical English:
  - A procedural sentence has 20 words or fewer. A descriptive sentence has 25 words or fewer.
  - Give one instruction in each sentence.
  - Use the active voice.
  - Use approved words, with one meaning for each word. A technical name stays as it is: a glossary term, a command, a
    field, a file name.
  - Code, commands and refusal text are not sentences. Do not count their words.
- Spell each glossary term as [GLOSSARY.md](../../GLOSSARY.md) spells it, with its capital letters. Do not use a word
  from its _Avoid_ list in its place. For example, write "Workflow" and not "pipeline". Write "Effect" and not "side
  effect" or "step".
- Do not write "agent" alone. An Agent works inside a run. An Assistant works for you in the Instance folder.
- Write "converge" for what `jr2 up` does to a cluster. Do not write "deploy".
- Do not write "operate" or "operations" for the work of a person. In jr2, the operator is the Kubernetes operator.

### The latest release only

The site and the bundle describe the release that they ship in, and nothing else.

- Describe only the features of this release.
- Do not write "coming soon", "new in", "since", "planned", or a version notice.
- Do not describe a feature that does not exist. If a page needs one, stop and tell the maintainer. For this reason,
  "Test a Machine" is not in `sitemap.json`.
- Do not compare this release with an earlier release. The ADRs keep the history.

### Glossary links

- On each page, link the first use of each glossary term to its Glossary entry. Do not link the uses after it.
- Use the path rule in [Links](#links). For example, from a page in `guides/`,
  `[Repo Slot](../reference/glossary.md#repo-slot)`.
- Do not put a link in a heading. If a term is first in a heading, link its first use in the text.
- A name in code, such as `customize()`, links to its Reference entry, not to the Glossary.
- Do not copy a Glossary definition or the reasons of an ADR. Explain the idea in your own words, and link to them.

### The kinds of page

#### Home

`index.md` serves the evaluator and the Instance user. It has these parts, in this order:

1. What jr2 is, in one paragraph. jr2 is a Kit. You write agentic workflows as xstate Machines, and jr2 runs them on
   Kubernetes. An Agent that works on a Repo works in a Sandbox.
2. The start, in three commands. Link to [Install](get-started/install.md) for the tools that they need first:

   ```sh
   npm i -g @jr2/cli
   jr2 init my-instance && cd my-instance && npm install
   jr2 up
   ```

3. Links to Why jr2, Get started, Concepts, Guides and Reference, with one sentence for each.

Home has no diagram. Only four diagrams exist, and each is on its Concept page. Link to Architecture for the picture of
what runs where.

#### Why jr2

`why.md` serves the evaluator. It explains the problems that jr2 solves. Give each problem a section. A section states
the problem, then says how jr2 answers it, then links to the Concept. The problems are:

1. **Non-determinism.** A Machine is a graph that you can read before it runs. The Console draws the run while it runs.
   You review how the work happens, not only the code that comes out.
2. **Isolation.** A filesystem sandbox is not isolation. An Agent that works on a Repo works in a Sandbox: a pod with
   its own filesystem, network and processes, one for each Workspace. A Menu-only Agent has no Sandbox. An Agent never
   holds a model key. When a Lease lapses, the operator removes what the Agents left behind.
3. **Distribution.** The compute is remote. The Orchestrator holds only the Actor, and the Harness runs where the
   cluster puts it.
4. **Composition.** Workspace, Pool, Source and Gate wrap a body that does not know about them. Each state frames one
   Turn, so that an Agent does one thing at a time.
5. **Model agnostic.** One Harness, jr2's own, speaks to each provider. An Agent is a model and its instructions.
6. **Headless.** The Orchestrator is an HTTP API. The CLI, the Console and a webhook are its clients.
7. **One converging command.** `jr2 up` converges the same Instance folder into kind on a laptop or into a shared
   cluster. Only the kubectl context changes.
8. **A typed Instance.** The typecheck and `jr2 up` find an error in a Machine or in the config before a run starts.

The sources are the talk (`docs/intro/slides/index.html`) and "The problems" in `docs/architecture.md` before commit
`9dfe862`. Use their text only. Why jr2 has no diagram. Do not name other products, and do not judge them.

#### Get started

The six pages are one tutorial. The reader does each page in order, and each page adds one idea:

| Page                                | The reader                                                                     | The new idea                   |
| ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------ |
| Install                             | installs the tools and the jr2 CLI, and makes the kind cluster                 | none                           |
| Create an Instance                  | runs `jr2 init`, reads the folder, runs `jr2 up` and `ping`, opens the Console | Instance, Workflow, converge   |
| Connect a model                     | adds the model to `jr2.config.ts` and `.env`, and runs `jr2 up` again          | Held secret, custom provider   |
| A model decides                     | writes `triage.ts`, runs it, and answers the `clarify` Gate                    | Agent, Menu, Gate              |
| An Agent in a Sandbox               | forks jr2, binds `task`, runs it, sends `request_changes`, pushes, approves    | Workspace, Sandbox, Open parts |
| Have your Assistant write a Machine | asks the Assistant for `fix`, reads its graph, runs it, approves               | Assistant, `AGENTS.md`, Effect |

Each page has these parts, in this order:

1. A first paragraph that says what you have at the end of the page.
2. `## Before you start`: the page before it, and each tool or account that the page needs.
3. One `##` section for each step. A step gives one command in a `sh` block, then the output that you see.
4. `## What happened`: a short explanation, with links to the Concepts.
5. `## Next`: one link, to the next page. The last page links to the Concepts.

The tutorial has one path. Do not give options, other than the provider tabs and, in the Local tab of page 3, the two
servers. Use the names in [Tutorial facts](#tutorial-facts), and no other names.

#### Concept

A Concept page explains one idea. It has these parts, in this order:

1. What it is. The first paragraph links the term to its Glossary entry.
2. Why it exists: the problem that it solves.
3. How it behaves.
4. Its rules: what jr2 does, and what it refuses. Give the rule. The Guide gives the refusal text.
5. `## Read next`: links to the Guides, to the Reference entries, and to the ADRs.

A Concept page has no procedure. The Guides hold the procedures. A Concept page has one diagram at most, and only the
four pages in [The four diagrams](#the-four-diagrams) have one.

Each term has one Concept page that explains it. The table gives the terms that each page owns (from grill Q7). Another
page that uses a term links to the page that owns it, and does not explain the term again.

| Concept                           | The terms that it owns                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `concepts/machines-and-workflows` | Machine, Workflow, the door (the run input), Vocabulary, Emit                                                  |
| `concepts/agents-and-turns`       | Agent, Dials, Frame, Turn, `continue`, Briefing, Working tools, Runaway, Compaction                            |
| `concepts/the-menu`               | Menu, Allowed picks, mode, Rest, outstanding, Sender, `answer`                                                 |
| `concepts/gates`                  | Gate: an external input from a human, the CLI, the Console or a webhook                                        |
| `concepts/effects`                | Effect: `command`, `http`, `push`, `dispatch`, dispatched by, at-most-once, `fromPick`                         |
| `concepts/workspaces`             | Workspace, Sandbox, Repo, Repo Slot, Worktree, Size, Placing, Lease, Continuity, Sandbox Image, User Container |
| `concepts/composition`            | nesting by invoke, `customize`, Open parts, `@jr2/machines`, a Machine as an npm package                       |
| `concepts/charts`                 | Chart, Chart wrapper, Open body, Reference, the Chart door, ceilings, Chart file, runtime Chart                |
| `concepts/pools-and-sources`      | Pool, Source, Work Source, Ready-set                                                                           |
| `concepts/architecture`           | Orchestrator, Harness, Instance Harness, Custodian, Effector, the operator, the Repo cache                     |
| `concepts/secrets-and-trust`      | Held secret, Stand-in, Effect secret, the tokens, open observation and guarded control                         |
| `concepts/converge`               | `jr2 up`, Assembly, Kit version, Handoff, Kit image, Pinned image, Sandbox Image as an image to build, `gc`    |
| `concepts/durable-runs`           | snapshots, restart and re-attach, Machine shape and drift, `CANCEL` and stop, the week of history              |

Workspaces owns the Sandbox Image as a part of the Sandbox. Converge owns only how `jr2 up` builds and loads it.

#### Guide

A Guide does one task. It has these parts, in this order:

1. The task, in one sentence, as the first paragraph.
2. One full example that typechecks, from `examples/<page-slug>/`. It has no fragment and no `…`. A Guide for a task
   that you do with commands shows the commands and their output.
3. `## Rules`: a list. Each item says what the compiler, `jr2 up` or the Orchestrator refuses. It gives the exact
   refusal text, as jr2 prints it, in a code span. Copy the text from the code. Write each part that changes as a
   `<placeholder>`, as the TSDoc does. An Assistant searches for this text when it gets an error. A Guide for a task
   that you do only with commands, such as `open-the-console`, can also give in `## Rules` a behavior that has no
   refusal text, such as what the Console shows without the token.
4. `## Read next`: the Concept and the ADR. Do not explain the reason again. The Concept and the ADR give it.

The first link in `## Read next` is the Concept in this table. A Guide can link to more Concepts after it.

| Guides                                                                                   | The Concept                       |
| ---------------------------------------------------------------------------------------- | --------------------------------- |
| `start-a-run`, `write-a-workflow`                                                        | `concepts/machines-and-workflows` |
| `set-an-agents-access-and-dials`                                                         | `concepts/agents-and-turns`       |
| `answer-a-gate`                                                                          | `concepts/gates`                  |
| `run-a-command-or-call-a-url`, `push-and-sign-a-branch`, `start-a-run-from-a-run`        | `concepts/effects`                |
| `look-inside-a-sandbox`, `add-tools-to-the-sandbox`, `size-a-workspace`                  | `concepts/workspaces`             |
| `bind-open-parts`, `publish-a-machine-as-an-npm-package`                                 | `concepts/composition`            |
| `let-an-agent-write-a-chart`, `run-a-chart-by-name`                                      | `concepts/charts`                 |
| `run-one-worker-per-item`                                                                | `concepts/pools-and-sources`      |
| `open-the-console`                                                                       | `concepts/architecture`           |
| `use-a-local-model`, `use-a-hosted-provider`, `give-the-cluster-git-credentials`         | `concepts/secrets-and-trust`      |
| `move-from-kind-to-a-shared-cluster`, `mirror-the-kit-images`, `upgrade-the-kit-version` | `concepts/converge`               |
| `clean-up`, `fix-a-failed-converge`, `iterate-on-a-machine-on-kind`                      | `concepts/converge`               |
| `watch-a-run`, `cancel-a-run`                                                            | `concepts/durable-runs`           |

### Citations

Cite an ADR with a link to its bundle path. From a page one folder deep, such as `concepts/gates.md`, the path is
`../reference/decisions/<file>.md`. From `index.md` or `why.md`, it is `reference/decisions/<file>.md`. `<file>` is the
full file name in `docs/adr/`. The link text is the number:
`[ADR-0054](../reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)`.

Cite a Reference entry with a link to its page and its anchor, such as `../reference/config.md#secrets`. `docs:build`
makes each anchor from a name. It joins the parts with a hyphen and changes the result to lower case. Then it changes
each run of characters that are not `a`–`z` or `0`–`9` to one hyphen. It also removes a hyphen at the start and at the
end (`anchorOf` in `build/reference/context.ts`). The table gives the name for each kind of entry:

| Page                                  | Entry                 | The anchor is                                    | Example                                                                        |
| ------------------------------------- | --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `authoring-surface.md`, `machines.md` | a function or a const | the name                                         | `jr2Setup` is `#jr2setup`                                                      |
| each Reference page                   | a type                | `type-`, then the name                           | `RepoSlot` is `#type-reposlot`                                                 |
| `config.md`                           | a field               | the path, without `[]`, with `name` for `<name>` | `harness.provider.baseUrl` is `#harness-provider-baseurl`                      |
| `cli.md`                              | a command             | the command, without `jr2`                       | `jr2 kit push` is `#kit-push`                                                  |
| `cli.md`                              | a section             | its title                                        | `#global-options`, `#run-ids`, `#env`, `#output`, `#exit-codes`                |
| `http-api.md`                         | a route               | the method and the path                          | `POST /runs/:runId/gates/:gate/events` is `#post-runs-runid-gates-gate-events` |
| `http-api.md`                         | an access band        | `band-`, then the band                           | `#band-open`, `#band-authenticated`, `#band-instanceonly`                      |
| `mechanism-events.md`                 | an event              | the event type                                   | `agent.fault` is `#agent-fault`                                                |
| `glossary.md`                         | a term                | the rule in [Links](#links)                      | `Repo Slot` is `#repo-slot`                                                    |

- A flag has no anchor. Link to its command.
- An anchor in an ADR is the slug that GitHub gives its heading.
- `docs:build` fails on an anchor that is not in a Reference page, in the Glossary or in an ADR. It does not check an
  anchor in a hand-written page. Link only to a heading of a hand-written page, and check the link yourself.
- To see every anchor, run `pnpm docs:build --partial --out <dir>`. Then search `<dir>/reference/` for `<a id=`.

### Provider tabs

A page that names a model, or that shows the config of a model, has two provider tabs. Use these labels, in this order,
and the key `provider`:

```md
::: tabs key:provider

== Anthropic

Text and code for Anthropic.

== Local

Text and code for a local model.

:::
```

The key `provider` makes each tab set on the site show the tab that the reader chose last, on each page.

- **Anthropic.** The model is `anthropic/claude-haiku-5-5`. `jr2.config.ts` adds one `secrets` line, and `.env` holds
  `ANTHROPIC_API_KEY`. The id is an open item: see [Open items](#open-items).
- **Local.** The model is Qwen3.6-35B-A3B, on an OpenAI-compatible endpoint (vLLM or llama.cpp) over plain `http://`,
  with no key. Its specifier is `local/qwen3.6-35b-a3b`. `jr2.config.ts` sets `harness.provider`, and `.env` holds
  `LOCAL_MODEL_URL`. The guide "Use a local model" gives TLS and a key.
- Import `jr2.config.ts` from `examples/shared/anthropic/` or `examples/shared/local/`.
  [Tutorial facts](#tutorial-facts) gives the `.env` lines.
- Put in a tab only the text and the code that change with the provider. Put the rest outside the tabs.
- For [Glossary links](#glossary-links), each tab counts as a page. Link the first use of a term in each tab, because
  the reader sees only one tab.
- A guide for one provider, such as "Use a hosted provider or a gateway", has no tabs.

### Command output

- Show the real output. Run the command and copy what it prints. Do not write output from memory. When you cannot run
  the command, obey the output rule in [Open items](#open-items).
- Put the command in a `sh` block with no prompt, so that the reader can copy it. Put its output in a `text` block after
  it.
- Mark each place where you remove lines with a line that holds only `…`.
- A value that changes on each run, such as a run id or a time, stays as your run printed it. Tell the reader that their
  value is different.
- Write a value that the reader supplies as `<name>`, such as `<you>` or `<run id>`. Say what to put there at its first
  use on the page.

### Examples

- Put each file that a page imports in `examples/<page-slug>/`. For example,
  `examples/get-started/a-model-decides/anthropic/triage.ts`.
- Put a file that two or more pages import in `examples/shared/`. Do not make a second copy of it.
- Give the file the name that the reader saves it as. When each provider tab needs its own form of a file, use one
  folder for each tab: `anthropic/` and `local/`.
- A Machine example is a complete workflow module: its imports, its Vocabulary, its Agents and `export const machine`.
- Import only what a scaffolded Instance can import: `@jr2/orchestrator` (its root, never `/internal`), `xstate`, `zod`,
  `@jr2/machines` and `node:` modules. A page that imports `@jr2/machines` tells the reader to install it.
- A comment in an example speaks to the reader. Put the ADR links in the page, not in the comments.
- To show a part of a file, mark the part as a region: `// #region <name>` on the line before it, and
  `// #endregion <name>` on the line after it. Give the region the name of what it holds, such as `imports` or `review`.
  The site and the bundle do not show the marker lines.
- `pnpm typecheck` checks each `.ts` file in `examples/`. Run `pnpm --filter @jr2/docs-site typecheck` after you change
  one. `pnpm format` formats them.

### The four diagrams

A diagram answers one question. Use few boxes. Do not put a label on an arrow when the text gives the same information.
Use a `mermaid` code block.

Only these four diagrams exist. Each one is on one page:

| Diagram              | Page                        | The question                                                              |
| -------------------- | --------------------------- | ------------------------------------------------------------------------- |
| One Turn             | `concepts/agents-and-turns` | What happens in one Turn, from the Frame to the Agent's pick?             |
| Composing a Workflow | `concepts/composition`      | How do a Workflow, the Machines in it and their bound parts fit together? |
| What runs where      | `concepts/architecture`     | What runs on your computer, in the cluster, and in a Sandbox?             |
| Setup and usage      | `concepts/converge`         | What does `jr2 up` make, and what do `jr2 run` and `jr2 send` use?        |

- Do not add a diagram. Do not copy a diagram to a different page. Link to it.
- Do not use the old diagrams from git history, such as those in `docs/architecture.md` before commit `9dfe862`. Draw
  each diagram again, from the code.

## The source format

Every page is VitePress Markdown, and uses only the forms in this section. `docs:build` changes each form to plain
Markdown for the bundle, and refuses the other VitePress forms in [What not to use](#what-not-to-use). The site turns
off the emoji shortcodes (`:tada:`), which `docs:build` does not refuse. Thus the bundle and the `.md` URLs of the site
have no syntax of the generator.

### Markdown

Use CommonMark with the GitHub Flavored Markdown extensions (tables, task lists, strikethrough, autolinks).

The frontmatter holds only `title` and `description`. The `title` is the same as the page's `title` in `sitemap.json`.
VitePress reads the frontmatter as YAML. Put a value in double quotes when it holds `: ` or ` #`, or when it starts with
a character such as `-`, `[`, `{` or `` ` ``:

```md
---
title: Workspaces
description: How a Workflow gets a git Worktree in a Sandbox, and how long it keeps it.
---
```

A page has no H1 (`# Title`). The title is in the frontmatter. `docs:build` adds the H1 in the bundle, and the site adds
it on the page. Start the body with text or with an H2.

### Links

A link to another page is a relative path to its `.md` file. A link to a hand-written page works on GitHub, in the
bundle, and in the site. A link to a Reference page works in the bundle and in the site only, because `docs:build`
generates that page:

```md
See [the Lease](../concepts/workspaces.md#lease).
```

A link to a term in the Glossary is the relative path from the page to `reference/glossary.md`, then `#<term-slug>`. The
slug is the term in lower case, with a hyphen for each space. For example, from a page in `concepts/`,
`Authoring surface` is `../reference/glossary.md#authoring-surface`. From `index.md`, it is
`reference/glossary.md#authoring-surface`.

The site makes the anchor of a heading with the rule of GitHub, as the bundle does. Thus an anchor that works on GitHub
also works on the site.

### Containers and lines of their own

The asides, the tabs and `<<<` are the VitePress forms. Each line of a form is a paragraph of its own: put an empty line
before it and after it. Prettier formats these pages with `proseWrap: always`, and it joins lines that are not separated
by an empty line into one paragraph. A joined line is text, not a form.

A container starts with three colons and closes with the same number of colons. VitePress closes a container at the
first line of colons that is long enough, and it does not count the containers inside it. Thus a container inside
another container has fewer colons than its parent: write the parent as `:::: tabs key:provider` and its close as
`::::`.

### Asides

Use one of `::: info`, `::: tip`, `::: warning`, and `::: danger`, with no title. Close it with `:::`.

```md
::: warning

Read this before you continue.

:::
```

### Tabs

Start the tabs with `::: tabs key:provider`. Start each tab with `== <label>`. Close the tabs with `:::`. A tab holds
text, code, lists, and `<<<`. See [Provider tabs](#provider-tabs) for the labels.

```md
::: tabs key:provider

== Anthropic

Text for Anthropic.

== Local

Text for a local model.

:::
```

The tabs come from the plugin `vitepress-plugin-tabs`. VitePress's own `::: code-group` holds code only, and it does not
keep the reader's choice, so the provider tabs do not use it. For alternatives that are only code, and that are not
providers, use `::: code-group`. Give each fence or `<<<` in it a title, which is the label of its tab:

````md
::: code-group

```sh [npm]
npm install --save-exact @jr2/machines@<version>
```

<<< @/examples/guides/x/pnpm.sh [pnpm]

:::
````

### Code from a file

Put an example in a real file, so that it typechecks. Then import it with `<<<` on a line of its own. The path starts
with `@/`, which is this folder:

```md
<<< @/examples/concepts/workspaces/anthropic/docs-fix.ts

<<< @/examples/concepts/composition/anthropic/route.ts#imports

<<< @/examples/guides/add-tools-to-the-sandbox/images/default/Dockerfile{dockerfile}
```

- `#<name>` imports only the region `<name>` of the file. See [Examples](#examples) for the markers.
- The language of the block comes from the file extension. A file with no extension, such as a `Dockerfile`, gives its
  language as `{<language>}` after the path.
- A title, `[<label>]`, is only for a `<<<` inside `::: code-group`.
- Do not give line numbers to highlight (`{1,3}`). The bundle has no highlight.

VitePress shows the whole file when the region does not exist, and does not fail. When the file does not exist, the site
build fails. `docs:build` fails in both cases, so `pnpm --filter @jr2/docs-site test` finds the problem.

Put the file in `examples/<page-slug>/`, or in `examples/shared/` when two or more pages import it. `pnpm typecheck`
checks every `.ts` file in `examples/` against `@jr2/orchestrator` and `@jr2/machines`. See [Examples](#examples).

### Diagrams

Use a `mermaid` fenced code block. The plugin `vitepress-plugin-mermaid` draws it on the site, in the light theme and in
the dark theme. Only four diagrams exist. See [Diagrams](#the-four-diagrams) for the rule and the list.

### What not to use

Do not use a form that the bundle cannot show. `docs:build` refuses each of these in the text of a page:

- A Vue interpolation (`{{ }}`) in the text. In a code span or a code block, `{{ }}` is text: the site gives each one
  `v-pre`, so Vue does not compile it.
- A raw HTML tag in the text, such as `<Badge>`, `<script>`, `<br>` or `<n>`. Vue compiles each one, and a tag that is
  not closed fails the site build. Put it in a code span, or write `&lt;`. Only the anchor `<a id="<id>"></a>` is
  permitted.
- A GitHub alert (`> [!NOTE]`). Use an aside.
- `[[toc]]`, and the Markdown include `<!--@include: …-->`. Use `<<<` for code.
- A fence with more than a language in its info, such as ` ```ts{1,3} `, ` ```ts [title] ` or ` ```ts:line-numbers `,
  outside `::: code-group`.
- A line of text that starts with a tag, such as `<run id>` at the start of a wrapped line in a code span. VitePress
  reads that line as a Vue component and ends the paragraph. Change the words so that the line starts with a different
  word.

The site also turns off the `{.class}` attributes of `markdown-it-attrs`, the GitHub alerts and the emoji shortcodes
(`:tada:`). The bundle cannot show them, so the site shows them as text, as the bundle does.

## The bundle

`docs:build` makes the docs bundle that `@jr2/orchestrator` ships. Its inputs are the pages in this folder, the code,
`GLOSSARY.md`, and `docs/adr/`. Its output is plain Markdown (CommonMark and GFM), with no syntax of a site generator:

| Bundle path                    | Contents                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `<slug>.md`                    | Each page of `sitemap.json`, at its slug.                                         |
| `reference/*.md`               | The Reference, generated from the code. See ADR-0072 for the source of each page. |
| `reference/glossary.md`        | `GLOSSARY.md`, with an anchor before each term.                                   |
| `reference/decisions.md`       | An index of the ADRs.                                                             |
| `reference/decisions/<adr>.md` | Each ADR, with its links changed for the bundle.                                  |
| `llms.txt`                     | An index of the pages in the llmstxt.org format.                                  |
| `agents-block.md`              | The text that `jr2 up` writes between the markers in an Instance's `AGENTS.md`.   |

A page in the bundle keeps its frontmatter, then gets its title as its H1. `docs:build` changes the VitePress forms
(`build/vitepress.ts`):

- An aside becomes a blockquote. Its first line is the label in bold: `> **Note**` (for `::: info`), `> **Tip**`,
  `> **Caution**` (for `::: warning`) or `> **Danger**`. The site shows the same labels.
- In tabs, each tab becomes a line with its label in bold, then the content of the tab. In a code group, each fence
  becomes a line with its title in bold, then the fence with only its language.
- `<<<` becomes a fenced code block of the file or of its region, without the region markers.
- A `mermaid` code block does not change.

It also changes each relative link:

- A link to a page that `--partial` skipped becomes its text.

- A link to a file in the docs set goes to the bundle path of that file. `docs/adr/X.md` becomes
  `reference/decisions/X.md`, `GLOSSARY.md` becomes `reference/glossary.md`, and a page becomes its slug. The anchor
  does not change. An anchor in the Glossary, in a Reference page or in an ADR must exist.
- A link to a different file of the repo becomes a GitHub URL at the release tag:
  `https://github.com/snapwich/jr2/blob/v<version>/<path>`.

`docs:build` fails, and writes nothing, when it finds one of these problems. It shows each one as `file:line: message`:

- a link that goes to no file, or to an anchor that is not in a Reference page, the Glossary or an ADR
- frontmatter that holds a key other than `title` and `description`, or a `title` that is not the title in
  `sitemap.json`
- an H1 in a page
- a container, a tab line or a `<<<` that is not a form of [The source format](#the-source-format), that is not closed,
  that has as many colons as its parent, or that has no empty line before it and after it
- a `<<<` of a file that does not exist, or of a region that is not in the file
- frontmatter that YAML does not read as the text that it shows
- a form in [What not to use](#what-not-to-use)
- a TSDoc `@see` that is not a sitemap page (`docs/<slug>.md`) or an ADR (`docs/reference/decisions/<file>`). A `@see`
  path is relative to the root of `@jr2/orchestrator`, which holds the bundle. In the TSDoc of another package, such as
  `@jr2/machines`, write the path with the package name, `@jr2/orchestrator/docs/<slug>.md`, so that an Assistant who
  reads the file in `node_modules` can find the page. A `docs/` path there is an error.
- a TSDoc block tag on the Authoring surface or on `@jr2/machines` other than `@remarks`, `@param`, `@returns`,
  `@example` and `@see`: the Reference does not show it
- a TSDoc block tag on a type in a Types section, or on a Mechanism event, other than `@remarks`, `@example` and `@see`
- a repo path or a commit id in the TSDoc that a Reference page shows, such as `test/x.test.ts`, `parts.ts` or
  `baba71f`. `jr2.config.ts`, `AGENTS.md` and `CLAUDE.md` are the author's files, so they are not errors. The code of an
  `@example` and the target of a `@see` are not checked.
- two entries of a generated page with the same anchor
- a group or a page that the `AGENTS.md` block puts first (the Reference pages for an author, Write Machines, What you
  write) that `sitemap.json` does not have

### Run docs:build

```sh
pnpm docs:build                       # write the bundle to packages/orchestrator/docs/
pnpm docs:build --out <dir>           # write it to <dir>
pnpm docs:build --partial --out <dir> # skip the pages that have no file yet
```

By default, a page in `sitemap.json` with no file is an error. With `--partial`, `docs:build` skips that page, and a
link to it becomes its text, so that the bundle has no broken link. Use `--partial` only while you write the pages.

The output folder is not in git. `docs:build` deletes the folder before it writes. It does not delete a folder that
holds other files and no `agents-block.md`.

`pnpm --filter @jr2/docs-site test` runs the tests of `docs:build`. They do not write to the output folder.

### Build the site

```sh
pnpm docs:dev                                # serve the site at http://localhost:5173/jr2/, and reload it on a change
pnpm docs:site                               # build the site into docs/site/.vitepress/dist/
pnpm --filter @jr2/docs-site docs:preview    # serve the built site
```

`docs:dev` and `docs:site` first run `build/site.ts`. It builds the bundle, strict, into `.vitepress/bundle/`, and
writes the Reference of the bundle into `reference/`. A Reference page is not VitePress Markdown, so `build/site.ts`
changes two things that Vue cannot compile: it joins a line that starts with a tag to the line before it, and it escapes
a tag in the text. The bundle does not change.

VitePress then builds the site with the base `/jr2/`. The build fails on a link to a page that does not exist. After the
build, it copies each file of the bundle, but `agents-block.md`, next to its HTML. Thus each page is also at its `.md`
URL, with the text that the Kit ships, and `llms.txt` is at the root of the site. Each page names its `.md` URL in a
`<link rel="alternate" type="text/markdown">`. The 404 page has no `.md` URL.

`docs:site` is a step of the CI gate (`.github/workflows/ci.yml`) and of the release gate, before the release changes
anything. Thus a page that VitePress cannot compile, or a dead link in the site, stops a change before a tag.

The `pages` job of `.github/workflows/release.yml` runs `pnpm docs:site` and deploys the result to GitHub Pages, at
`https://snapwich.github.io/jr2/`.

### The TSDoc that the Reference shows

The Reference shows the TSDoc of each export of the Authoring surface and of `@jr2/machines`, and of each Kit type that
their signatures and fields name, to any depth. Write that TSDoc for the author: what the name does, what it refuses,
with the full text, and what to read next. Put the reasoning of a maintainer in `//` comments above it.

Mark with `@internal` a type that only computes a type from other types, such as the type of a Machine's actors. An
author never writes such a type. The Reference shows its declaration only, in the list "Type plumbing", and does not
follow the types that it names. Its TSDoc is not shown, so it can stay a maintainer's note.

## The tutorial fixture

`tutorial/greet/` is a small Node CLI. Get started gives it to an Agent as a task. It is not a member of the pnpm
workspace, so `pnpm -r test` does not run its tests directly.

Do not change what its failing test shows. `test/tutorial-fixture.test.ts` checks that exactly one test fails and that a
known fix makes all of the tests pass. If you change the fixture, keep that test green.

## Tutorial facts

The six Get started pages use these names and values. A page uses no other name for the same thing. To change a fact,
change it here and on each page that uses it.

### Open items

The user must decide these items. Until then, obey the rule for each item.

- **The Anthropic model id.** The pinned Harness does not know `anthropic/claude-sonnet-5-5`. Its pi catalog has
  `anthropic/claude-sonnet-5`. `jr2 up` does not check a catalog model, so the first Turn faults. The user chooses
  `anthropic/claude-sonnet-5`, or a new pi pin. Until then, write the id only in example files and in the table in
  [The models](#the-models). In the text of a page, write "the model of the tab". The same id is in the TSDoc `@example`
  blocks of the Authoring surface and of `@jr2/machines`, which the Reference shows (for example,
  `packages/orchestrator/src/customize.ts` and `packages/machines/src/task.ts`). A change of the id changes those
  examples too.
- **The fork and its tags.** No test shows that a fork with "Copy the main branch only" cleared has the release tags.
  The manual check confirms it.
- **`git push` in `kubectl exec`.** No test shows that `git push` asks for a user name and a password inside
  `kubectl exec -it`. The manual check confirms it.
- **The diagram of Home.** Grill Q4 gave Home one diagram. The rule of four diagrams gives Home none. Until the user
  decides, Home has no diagram and links to Architecture.
- **Enter in the token box.** The Console commits the token on the native `change` event of its box. The e2e step
  commits it with a blur, so no test shows that Enter commits it. The pages tell the reader to push Enter. The manual
  check confirms that the badge then shows `live`. If it does not, the pages say "Click outside the box."
- **The address of vLLM.** The pages say that llama.cpp listens on its loopback address by default. The manual check
  confirms that vLLM listens on all addresses by default.
- **The output.** The writers of stage 3 have no cluster, no key and no model endpoint. Write the output from the code,
  and mark each output block with the comment `<!-- output: not run -->` on the line before it. The manual check runs
  each command, replaces the output, and removes the comment. `scripts/publish.sh` refuses a release while a page of the
  bundle has this comment.

### The tools and the cluster

| Fact                | Value                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| The tools (page 1)  | Node.js 24 or later, Docker, kind and kubectl.                                           |
| The jr2 CLI         | `npm i -g @jr2/cli`                                                                      |
| The kind cluster    | `kind create cluster --name jr2`. Its kubectl context is `kind-jr2`.                     |
| The package manager | npm.                                                                                     |
| The Sandbox Image   | The `images/default/Dockerfile` that `jr2 init` writes. The tutorial does not change it. |

`jr2 up` converges into the current kubectl context. `kind create cluster` makes `kind-jr2` the current context.

### The Instance

| Fact                | Value                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| The Instance folder | `my-instance`. Make it with `jr2 init my-instance`, then run `cd my-instance` and `npm install`.             |
| The namespace       | `my-instance`. `jr2.config.ts` sets no `name`, so the namespace is the name of the folder.                   |
| The first Workflow  | `ping`, which `jr2 init` writes. Run it with `jr2 run ping --input '{"message":"hi"}'`.                      |
| The Console         | Run `kubectl -n my-instance port-forward svc/jr2-orchestrator 4000:4000`, then open `http://localhost:4000`. |
| The Instance token  | See the command below. Type the token in the Console nav to send events from the Console.                    |
| The Kit version     | `<version>`: the version that `package.json` gives for `@jr2/orchestrator`, such as `0.4.1`.                 |

`jr2 init` pins `@jr2/orchestrator` and `@jr2/cli` to one exact version, so `package.json` shows the Kit version. No jr2
command opens the Console. The Console shows a run without the token. To answer a Gate from the Console, you need the
Instance token:

```sh
kubectl -n my-instance get secret jr2-instance -o jsonpath='{.data.JR2_INSTANCE_TOKEN}' | base64 -d
```

`jr2 run` stays attached to the run and returns only when the run ends. A run that waits at a Gate does not end. Thus
pages 4, 5 and 6 start each run in one terminal, and give each `jr2 send` and `kubectl exec` in a second terminal. The
pages do not use `--detach`.

### The models

| Tab       | Model                        | `jr2.config.ts`                           | `.env`                                     |
| --------- | ---------------------------- | ----------------------------------------- | ------------------------------------------ |
| Anthropic | `anthropic/claude-haiku-5-5` | `examples/shared/anthropic/jr2.config.ts` | `ANTHROPIC_API_KEY=<your key>`             |
| Local     | `local/qwen3.6-35b-a3b`      | `examples/shared/local/jr2.config.ts`     | `LOCAL_MODEL_URL=http://<address>:8000/v1` |

- Page 3 adds the model to the Instance. Each page after it uses the model of the tab.
- The two `jr2.config.ts` files show only the result. The file that `jr2 init` writes has more comments, and you keep
  them. For Anthropic, the scaffold has the `secrets` line as a comment: page 3 tells the reader to remove the `//`. For
  Local, page 3 tells the reader to add the `harness` entry. Neither tab replaces the whole file.
- For Local, `local` is the provider id in `jr2.config.ts`. The part after `local/` is the name that the endpoint gives
  for `GET /v1/models`.
- `<address>` is an address that a pod can reach, such as the LAN address of your computer. `localhost` does not work
  from a pod. Thus the server listens on `0.0.0.0`. llama.cpp listens on its loopback address by default.
- The server serves the model as `qwen3.6-35b-a3b`, on port 8000, with a context window of 65536 tokens. It must
  complete a tool call: `jr2 up` sends one tool call to the endpoint before it converges, and stops when it fails.
- Page 3 gives one start command for each server, in the Local tab. The guide "Use a local model" gives the same
  commands. Both pages import the same files, so that they agree:
  - `examples/shared/local/llama-server.sh` starts llama.cpp. `--jinja` lets the model call tools. `--temp 0.6` and
    `--presence-penalty 1.0` are the sampling settings for Qwen. `-ctk q8_0 -ctv q8_0 -fa on` make the KV cache smaller,
    so that 65536 tokens fit in memory. These are the settings of the intro Instance
    (`docs/intro/instance/package.json`), without its TLS and key flags.
  - `examples/shared/local/vllm.sh` starts vLLM. `--enable-auto-tool-choice` and `--tool-call-parser` let the model call
    tools. The manual check confirms the parser name, and if vLLM needs a reasoning parser.

  Page 3 does not install the server. It links to the install page of vLLM and of llama.cpp.

- Page 3's `jr2 up` cannot reach the model yet, because no Workflow names it. For Anthropic, it prints a warning that
  starts with `warning: secrets[0] (ANTHROPIC_API_KEY) is named by nothing; goes nowhere`. For Local, it prints
  `provider: <url> configured, but no carried Agent names a "local/…" model — skipped`. Page 3 shows this line and says
  that page 4 uses the model. The claim of each tab is different:
  - Anthropic: `jr2 up` does not check a catalog model. Page 4's `jr2 up` gives the key to the Custodian of the pod
    where the Agent works, and the first Turn of the run is the first call to the model.
  - Local: page 4's `jr2 up` checks the endpoint before it converges. It is the first `jr2 up` that reaches the model.
- Page 3's `jr2 up` publishes `jr2.config.ts` in the Assembly, and the Orchestrator loads it with no restart. Thus the
  port forward stays open. Each page whose `jr2 up` changes only the Instance folder says the same.

### Page 4: A model decides

| Fact          | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| The file      | `workflows/triage.ts`, so the Workflow is `triage`.                                                    |
| The Agent     | `triager`, a Menu-only Agent (`workspace: "none"`). Its picks are `accept`, `needs_info` and `reject`. |
| The Gate      | `clarify`. It takes the event `answer`, with the input `{ "info": "<text>" }`.                         |
| The run input | `{"request":"People keep asking what version they are running."}`                                      |
| The answer    | `{"info":"Add a --version flag to the CLI. It prints the installed version and exits."}`               |
| Run 2 input   | `{"request":"The greeting looks wrong sometimes."}`                                                    |
| Run 2 answer  | `{"info":"Spaces around the name show in the greeting. Trim the name."}`                               |

The page has two runs. The reader answers the first run's Gate from the CLI, in a second terminal:

```sh
jr2 run triage --input '{"request":"People keep asking what version they are running."}'
jr2 send <run id> --gate clarify --event answer --input '{"info":"Add a --version flag to the CLI. It prints the installed version and exits."}'
```

The reader starts the second run, then answers its Gate from the Console, with the Instance token and the run 2 answer:

```sh
jr2 run triage --input '{"request":"The greeting looks wrong sometimes."}'
```

- `<run id>` can be a prefix of the run id, 4 characters or more.
- The model decides. It can pick `accept` or `reject` first, and then the run ends with no Gate. The page says this. It
  shows the output of a run that ends at `accept`, and tells the reader to start the run again.
- The example starts from `docs/intro/instance/workflows/triage.ts`, with the model of the tab.

### Page 5: An Agent in a Sandbox

| Fact          | Value                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| The fork      | The reader's fork of `snapwich/jr2`: `https://github.com/<you>/jr2.git`. `<you>` is the GitHub user name. |
| The ref       | `v<version>`: the release tag of the Kit that the reader installed.                                       |
| The file      | `workflows/task.ts`, so the Workflow is `task`. It binds the shipped Machine `task`.                      |
| The Repo Slot | `target`.                                                                                                 |
| The fixture   | `docs/site/tutorial/greet/` in the fork. Its failing test is `trims the name`.                            |
| The branch    | `jr2/task-<instance id>`, which `task` makes when the input has no `branch`. See below.                   |
| The Gate      | `review`, with the id `body.review`, because `workspace()` runs the body as `body`.                       |
| The events    | `request_changes`, with `{ "notes": "<text>" }`, and `approve`, with no input.                            |
| The notes     | `{"notes":"Also add a test that trims the name when you pass --shout."}`                                  |
| The token     | A GitHub fine-grained personal access token for the fork only, with "Contents: Read and write".           |

- To fork, clear "Copy the main branch only" on GitHub, so that the fork has the release tags.
- The Agent's branch starts from the ref. Thus each reader of a release starts from the same fixture.
- Install `@jr2/machines` at the Kit version first: `npm install --save-exact @jr2/machines@<version>`.
- The file binds the two Open parts of `task`:

  ```ts
  import { customize } from "@jr2/orchestrator";
  import { task } from "@jr2/machines";

  export const machine = customize(task, {
    repos: { target: { url: "https://github.com/<you>/jr2.git", ref: "v<version>" } },
    agents: { coder: { model: "<the model of the tab>" } },
  });
  ```

- The fixture's bug: `greet([" ada "])` gives `hello,  ada `, not `hello, ada`. Only the tutorial owns this bug, and
  `test/tutorial-fixture.test.ts` keeps it.
- The clone needs no token, because the fork is public. The reader pushes the branch by hand, from the Sandbox, while
  the run waits at `review`. `git push` asks for a user name and a password: give `<you>` and the token.
- The branch is named after the seed Instance ID of the run, not after the run id. These are two different ids. Do not
  tell the reader to make the branch name or the Worktree path from the run id. The `review` Gate gives both in its
  `meta`, as `branch` and `worktree`. `jr2 status <run id>` prints them under `gates`, and the drawer of the Console
  shows them.
- To push, the reader reads `branch` and `worktree` from the Gate. Then the reader finds the Sandbox, goes into its
  `harness` container, and pushes from the Worktree. The label `jr2.dev/run` holds the full run id, not a prefix. The
  pod has the name of the Sandbox:

  ```sh
  jr2 status <run id>
  kubectl -n my-instance get sandboxes -l jr2.dev/run=<run id>
  kubectl -n my-instance exec -it <sandbox> -c harness -- bash
  cd <worktree>
  git push origin <branch>
  ```

  The Worktree is `/work/<Repo Slot>/<branch>`, with each `/` in the branch changed to `-`. `origin` fetches through the
  Repo cache of the node, and pushes to the fork. The guide "Look inside a Sandbox" gives the same commands.

- `approve` ends the run and removes the Sandbox. A commit that the reader did not push is lost.

### The task text

Pages 5 and 6 give the Agent this text, as the `prompt` of the run:

```text
In docs/site/tutorial/greet, one test fails. Fix the bug in docs/site/tutorial/greet/src/greet.js. To check your fix, run node --test in docs/site/tutorial/greet. Do not change files outside that folder. Do not run the tests of the repo root.
```

The text keeps the Agent's check to `node --test` in the fixture folder. A `pnpm -r test` at the root of the fork fails
after the fix, because the guard test expects the bug. The text holds no double quote, so it goes into the JSON of
`--input` with no escape:

```sh
jr2 run task --input '{"prompt":"In docs/site/tutorial/greet, one test fails. Fix the bug in docs/site/tutorial/greet/src/greet.js. To check your fix, run node --test in docs/site/tutorial/greet. Do not change files outside that folder. Do not run the tests of the repo root."}'
```

### Page 6: Have your Assistant write a Machine

| Fact          | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| The Assistant | Claude Code, Codex or Cursor, opened in `my-instance`. It reads the `AGENTS.md` that `jr2 init` wrote. |
| The file      | `workflows/fix.ts`, so the Workflow is `fix`.                                                          |
| The Gate      | `review`, with the id `body.review`, because `workspace()` runs the body as `body`.                    |
| The events    | `request_changes`, with `{ "notes": "<text>" }`, and `approve`, with no input.                         |
| The token     | The token from page 5, in `.env` as `JR2_GIT_TOKEN=<token>`.                                           |
| The example   | `examples/get-started/have-your-assistant-write-a-machine/<tab>/fix.ts`: one result that typechecks.   |

The reader gives the Assistant this prompt, with `<you>` and `<version>` replaced:

```text
Write a workflow named fix, in workflows/fix.ts. A coder Agent works in a Workspace on my fork, https://github.com/<you>/jr2.git, from the ref v<version>, in the Repo Slot target. It uses the model that workflows/task.ts uses. The run input is { prompt }, as for the task workflow. When the coder finishes, run node --test in docs/site/tutorial/greet in its Worktree. If the tests fail, send the output back to the coder. If they pass, a human reviews at a Gate named review, with the events request_changes (with notes) and approve. On request_changes, the coder continues with the notes. On approve, push the branch to my fork.
```

- The `git.credentials` entry that `jr2 init` writes names `JR2_GIT_TOKEN`. The `push` Effect uses that token. `jr2 up`
  refuses a push over `https://` when the token is not set.
- The steps: `jr2 up`, then read the graph in the Console before the run. Then run `fix` with the task text, send
  `approve` at `review`, and find the branch on the fork.
- The Assistant of each reader writes a different file. The page shows the prompt, the example result, and what to check
  in the graph.
- The page ends with a short annotated walk through the example `fix.ts`. It shows how to read the states, the picks,
  the `review` Gate and the `push` Effect. Reading a Machine is the skill of the person. Writing one is the work of the
  Assistant.
