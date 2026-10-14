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
| `test/`           | The tests for `sitemap.json` and for the tutorial fixture.                         |

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

The frontmatter holds only `title` and `description`:

```md
---
title: Workspaces
description: How a Workflow gets a git Worktree in a Sandbox, and how long it keeps it.
---
```

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

Put an example in a real file, so that it typechecks. Then include it on a line of its own:

```md
::include{file="./examples/fix.ts"}

::include{file="./examples/fix.ts" lines="3-20"}
```

`file` is relative to the page. `lines` is optional. `docs:build` puts the file, or the lines, in a fenced code block.
The language of the block comes from the file extension.

### Diagrams

Use a `mermaid` fenced code block. A diagram answers one question. Use few boxes. Do not put a label on an arrow when
the text gives the same information.

### What not to use

Do not use syntax that only one generator knows:

- No Vue components.
- No JSX and no MDX.
- No VitePress `<<<` code imports. Use `::include` instead.

## The tutorial fixture

`tutorial/greet/` is a small Node CLI. Get started gives it to an Agent as a task. It is not a member of the pnpm
workspace, so `pnpm -r test` does not run its tests directly.

Do not change what its failing test shows. `test/tutorial-fixture.test.ts` checks that exactly one test fails and that a
known fix makes all of the tests pass. If you change the fixture, keep that test green.
