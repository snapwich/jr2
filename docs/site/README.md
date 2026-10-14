# docs/site

This folder holds the source of the jr2 docs: the hand-written pages and the navigation. `docs:build` reads it and makes
the docs bundle that `@jr2/orchestrator` ships, and the site builds from that bundle
([ADR-0072](../adr/0072-the-docs-ship-inside-the-kit-and-an-instances-agents-md-indexes-them.md)). This README is for
contributors. It is not a page of the docs.

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
| `examples/`       | The code that a page includes. `pnpm typecheck` checks it against the kit.         |
| `build/`          | `docs:build`: it makes the bundle and generates the Reference.                     |
| `test/`           | The tests for `sitemap.json`, the tutorial fixture, and `docs:build`.              |

There is no `reference/` folder. `docs:build` makes the Reference pages from the code, from `CONTEXT.md`, and from
`docs/adr/`. A Reference page has no source file here.

## The navigation

`sitemap.json` is the navigation. `docs:build` and the site generator read it. A page that is not in `sitemap.json` is
not in the docs.

- A section has `pages`, or `groups` that each have `pages`. It does not have both.
- A page has a `slug`, a `title`, and a `source`.
- The `slug` is the path of the file relative to this folder, without `.md`. For example, `concepts/workspaces` is
  `concepts/workspaces.md`.
- The `source` is `page` for a file in this folder, or `generated` for a page that `docs:build` makes.

To add a page, write the file and add it to `sitemap.json`. `pnpm --filter @jr2/docs-site test` checks the shape of
`sitemap.json`.

## The source format

Every page follows this format. The bundle is plain Markdown, and each site generator converts the directives below to
its own syntax. Thus a page does not use the syntax of one generator.

### Markdown

Use CommonMark with the GitHub Flavored Markdown extensions (tables, task lists, strikethrough, autolinks).

The frontmatter holds only `title` and `description`. The `title` is the same as the page's `title` in `sitemap.json`:

```md
---
title: Workspaces
description: How a Workflow gets a git Worktree in a Sandbox, and how long it keeps it.
---
```

A page has no H1 (`# Title`). The title is in the frontmatter, and `docs:build` adds the H1 in the bundle. Start the
body with text or with an H2.

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

### Directives

The asides, the tabs, and `::include` are directives. Each directive line is a paragraph of its own: put an empty line
before it and after it. Prettier formats these pages with `proseWrap: always`, and it joins lines that are not separated
by an empty line into one paragraph. A joined directive is text, not a directive.

### Asides

Use one of `:::note`, `:::tip`, `:::caution`, and `:::danger`. Close it with `:::`.

```md
:::caution

Read this before you continue.

:::
```

### Tabs

Start with `::::tabs`. Start each tab with `:::tab{label="..."}` and close it with `:::`. Close the tabs with `::::`.

```md
::::tabs

:::tab{label="Anthropic"}

Text for Anthropic.

:::

:::tab{label="Local"}

Text for a local model.

:::

::::
```

### Code from a file

Put an example in a real file, so that it typechecks. Then include it on a line of its own. This example is from a page
in a section folder, such as `concepts/workspaces.md`:

```md
::include{file="../examples/fix.ts"}

::include{file="../examples/fix.ts" lines="3-20"}
```

`file` is relative to the page. From `index.md` or `why.md`, the path is `./examples/fix.ts`. `lines` is optional:
`"3-20"`, or `"3"` for one line. `docs:build` puts the file, or the lines, in a fenced code block. The language of the
block comes from the file extension. Put the file in `examples/`: `pnpm typecheck` checks every file in it against
`@jr2/orchestrator` and `@jr2/machines`.

### Diagrams

Use a `mermaid` fenced code block. A diagram answers one question. Use few boxes. Do not put a label on an arrow when
the text gives the same information.

### What not to use

Do not use syntax that only one generator knows:

- No Vue components.
- No JSX and no MDX.
- No VitePress `<<<` code imports. Use `::include` instead.

## The bundle

`docs:build` makes the docs bundle that `@jr2/orchestrator` ships. Its inputs are the pages in this folder, the code,
`CONTEXT.md`, and `docs/adr/`. Its output is plain Markdown (CommonMark and GFM), with no directive and no syntax of a
site generator:

| Bundle path                    | Contents                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `<slug>.md`                    | Each page of `sitemap.json`, at its slug.                                         |
| `reference/*.md`               | The Reference, generated from the code. See ADR-0072 for the source of each page. |
| `reference/glossary.md`        | `CONTEXT.md`, with an anchor before each term.                                    |
| `reference/decisions.md`       | An index of the ADRs.                                                             |
| `reference/decisions/<adr>.md` | Each ADR, with its links changed for the bundle.                                  |
| `llms.txt`                     | An index of the pages in the llmstxt.org format.                                  |
| `agents-block.md`              | The text that `jr2 up` writes between the markers in an Instance's `AGENTS.md`.   |

A page in the bundle keeps its frontmatter, then gets its title as its H1. `docs:build` changes the directives:

- An aside becomes a blockquote. Its first line is the kind in bold: `> **Note**`, `> **Tip**`, `> **Caution**` or
  `> **Danger**`.
- In tabs, each tab becomes a line with its label in bold, then the content of the tab.
- `::include` becomes a fenced code block.
- A `mermaid` code block does not change.

It also changes each relative link:

- A link to a page that `--partial` skipped becomes its text.

- A link to a file in the docs set goes to the bundle path of that file. `docs/adr/X.md` becomes
  `reference/decisions/X.md`, `CONTEXT.md` becomes `reference/glossary.md`, and a page becomes its slug. The anchor does
  not change. An anchor in the Glossary, in a Reference page or in an ADR must exist.
- A link to a different file of the repo becomes a GitHub URL at the release tag:
  `https://github.com/snapwich/jr2/blob/v<version>/<path>`.

`docs:build` fails, and writes nothing, when it finds one of these problems. It shows each one as `file:line: message`:

- a link that goes to no file, or to an anchor that is not in a Reference page, the Glossary or an ADR
- frontmatter that holds a key other than `title` and `description`, or a `title` that is not the title in
  `sitemap.json`
- an H1 in a page
- a directive that is not correct or not closed, or that has no empty line before it and after it
- an `::include` of a file that does not exist, or of lines that are not in the file
- syntax of one site generator in the text: a Vue `{{ }}`, a JSX or MDX tag, `<<<`, or an `import` or `export` line at
  the start of a paragraph. A wrapped line of a paragraph can start with the word "import" or "export".
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

### The TSDoc that the Reference shows

The Reference shows the TSDoc of each export of the Authoring surface and of `@jr2/machines`, and of each kit type that
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
