# The docs ship inside the Kit, and an Instance's `AGENTS.md` indexes them

Most Machines will be written by an Assistant, not by a human: the human asks for a Machine and reviews its graph. No
model's training data holds jr2's API, so an Assistant needs the docs for the exact Kit version the Instance resolves,
and it must find them without being told to look. The docs-site grill of 2026-10 settled where those docs live and how
an Assistant reaches them. Its evidence is Vercel's evals on APIs that are not in training data: a compressed docs index
inline in `AGENTS.md` passed 100% of cases; skills passed 79% at best, because the agent did not invoke the skill in 56%
of cases; no docs passed 53% ([Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)).
Next.js ships the same design: its docs as Markdown inside the `next` package, and a managed block in the project's
`AGENTS.md` ([Next.js](https://nextjs.org/docs/app/guides/ai-agents)).

## Decision

- **One Markdown source, three outputs.**
  - **The bundle.** `@jr2/orchestrator` ships `docs/`: the Concepts, Guides and Reference pages, the Glossary, and the
    Decisions, as plain Markdown. No site-generator syntax reaches it. It is the main channel for an Assistant.
  - **The `AGENTS.md` block.** A compressed index of the bundle, and one instruction: jr2 is newer than your training
    data, so read the bundled docs before you write a Machine or config.
  - **The site**, on GitHub Pages. HTML for humans, and every page also at a `.md` URL, plus `llms.txt`, for tools that
    read over the network.
- **The docs ride `@jr2/orchestrator`, not a package of their own.** The Kit version _is_ the `@jr2/orchestrator` the
  Instance resolves, so the bundle matches the code the Assistant writes against by construction. There is nothing else
  to pin.
- **`jr2 init` writes the block, and `jr2 up` keeps it current.** `init` writes `AGENTS.md` with the block between two
  markers, and a `CLAUDE.md` that holds `@AGENTS.md`, because Claude Code reads `AGENTS.md` only when no `CLAUDE.md`
  exists. `up` rewrites the text between the markers when it differs from its Kit version's block, changes nothing
  outside them, and prints one line: `AGENTS.md: jr2 block updated for <version>`. `up` is the verb because every
  upgrade ends in `up`. A folder without the markers has opted out: `up` never creates the file or the markers, and no
  config key exists for it.
- **The Reference is generated from the code wherever the code holds the facts.**

  | Page                               | Source                                                          |
  | ---------------------------------- | --------------------------------------------------------------- |
  | Authoring surface, `@jr2/machines` | TSDoc on the exports — for the surface, exactly the root's list |
  | `jr2.config.ts`                    | TSDoc on the `JR2Config` fields                                 |
  | CLI                                | a structured command table, which also prints `--help`          |
  | HTTP API                           | the route table in `http.ts`, made data                         |
  | Mechanism events                   | the code that defines them                                      |
  | Glossary, Decisions                | `GLOSSARY.md` and `docs/adr/`, rendered as they are             |

  The TSDoc on an Authoring surface export is written for the author: what it does, what it refuses, what to read next,
  and one example. Maintainer reasoning goes in `//` comments in the body. The packages ship their `.ts` source, so an
  Assistant that follows an import into `node_modules` reads the same text the site shows. The Authoring surface is
  exactly what `@jr2/orchestrator` exports from its root: what the kit's packages share is internal even where it can be
  imported, and `@jr2/machines` is not part of it, because it ships Machines, not names to author with.

- **`docs:build` assembles the bundle at pack time.** Its inputs are the hand-written pages in `docs/site/`, the
  generated Reference, `GLOSSARY.md`, and `docs/adr/`. It runs in `@jr2/orchestrator`'s `prepack` and before the site
  build. Its output is gitignored, and no generated file is committed. A link that leaves the docs set becomes a GitHub
  URL at the release tag; a link that resolves nowhere fails the build. The `@dist` tier asserts that the packed bundle
  exists and that the `AGENTS.md` from `jr2 init` indexes it.
- **The site describes the latest release and deploys on its tag**, in a `pages` job in `release.yml` that needs the
  release job, so a failed gate deploys nothing. It does not wait for the staged packages' approval
  ([ADR-0055](0055-a-release-is-a-pushed-tag-and-the-publish-guard-is-the-credential.md)).

## Considered options

- **Skills.** Rejected as the channel for API knowledge: the Vercel evals above, and an agent decides whether to invoke
  a skill, where it always reads `AGENTS.md`. Skills stay possible for a multi-step job, such as an upgrade.
- **A docs MCP server.** Rejected: one more process to run for text that can sit on disk. MCP is for acting on a running
  system, not for reading docs.
- **The site and `llms.txt` only.** Rejected: the site describes the latest release, and an Instance can pin an older
  one. An Assistant also fetches over the network inconsistently, and some run without network.
- **A separate `@jr2/docs` package.** Rejected: the Instance must install it and pin it to the Kit version, and a
  mismatch is silent. Inside `@jr2/orchestrator`, it cannot mismatch.
- **A hand-written Reference.** Rejected: it drifts from the code, and the Reference is what an Assistant trusts most.
- **Copies of the Glossary and the ADRs committed inside the package**, kept equal by a drift check. Rejected: two
  copies of one text, to avoid one pack-time step.
- **`AGENTS.md` written once by `init`.** Rejected: it goes stale at the first upgrade. **A `jr2 docs` command to
  refresh it** is rejected too: a step that someone must remember.
- **Deploy when npm serves the version** — an hourly job that compares `npm view` with the deployed version. Rejected:
  more machinery to close a window of minutes.

## Consequences

- `jr2 up` writes into the Instance folder, and only between the markers.
- `@jr2/orchestrator` gains its first pack-time step. Its source still ships as `.ts`; only `docs/` is assembled.
- The tarball grows by the docs, most of it the ADRs (about 0.7 MB of text today).
- A TSDoc edit on the Authoring surface is a docs edit. `--help` and the CLI Reference come from one table, so they
  cannot disagree.
- A docs fix goes live with the next release, not on merge.
- A rejected stage leaves the site describing a version that npm does not serve, until the next tag. Accepted: the
  window is short, and a rejected stage is rare.
- The site generator is chosen separately. This decision holds for any generator, because the bundle is plain Markdown.
