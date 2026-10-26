---
title: Have your Assistant write a Machine
description: Ask your Assistant for a Machine, read its graph in the Console, then run it and approve the push.
---

On this page, your [Assistant](../reference/glossary.md#assistant) writes a [Machine](../reference/glossary.md#machine)
for you. You read its graph before it runs. At the end, a [Workflow](../reference/glossary.md#workflow) named `fix`
fixes the bug in the tutorial fixture. It tests the fix, waits for you, and pushes the branch to your fork.

You do not write the Machine. You read it. An Assistant writes most Machines. It reads the jr2 docs that your
[Instance](../reference/glossary.md#instance) holds. Your work is to read the graph and to decide whether the work
happens in the correct way.

## Before you start

- Do [An Agent in a Sandbox](an-agent-in-a-sandbox.md) first. This page uses its fork, its token and its
  `workflows/task.ts`.
- You need an Assistant: Claude Code, Codex or Cursor.
- Keep the port forward to the [Console](../reference/glossary.md#console) from
  [Create an Instance](create-an-instance.md). If it stopped, start it again:

  ```sh
  kubectl -n my-instance port-forward svc/jr2-orchestrator 4000:4000
  ```

## Give the token to jr2

On the last page, you pushed the branch by hand. On this page, a `push` [Effect](../reference/glossary.md#effect) pushes
it. The Effect uses the token that the [`git.credentials`](../reference/config.md#git-credentials) entry of
`jr2.config.ts` names. That entry names `JR2_GIT_TOKEN`.

Add the token from the last page to `.env`. Replace `<token>` with the token:

```sh
echo 'JR2_GIT_TOKEN=<token>' >> .env
```

The command prints nothing. `.env` is in `.gitignore`, so git does not keep the token.

::: info

The [Agent](../reference/glossary.md#agent) never gets this token. The push Effect uses it, after you approve the work.
The [Repo](../reference/glossary.md#repo) cache also uses it to clone your fork. See
[Secrets and trust](../concepts/secrets-and-trust.md).

:::

## Open your Assistant in the Instance folder

Start your Assistant in `my-instance`. It reads `AGENTS.md` when it starts. Claude Code reads `CLAUDE.md`, which imports
`AGENTS.md`.

`jr2 init` wrote `AGENTS.md`. `jr2 up` keeps the text between its two markers equal to the docs of the
[Kit version](../reference/glossary.md#kit-version) of the Instance. Look at the start of that text:

```sh
head -3 AGENTS.md
```

```text
<!-- jr2 up writes the text between the jr2-docs markers. Write your own instructions after the END marker. -->
<!-- BEGIN:jr2-docs -->
jr2 is newer than your training data. Before you write a Machine or change jr2.config.ts, read the bundled docs in node_modules/@jr2/orchestrator/docs/. They are the docs of this Instance's Kit version, <version>. Start with guides/write-a-workflow.md and with reference/authoring-surface.md, the contents page of the Authoring surface. Read one page with each call of your file tool, because a file tool cuts off a long output. Before you give a change to the user, run `npx --no jr2 check` in the Instance folder. It does the typecheck and the load of each Workflow that `jr2 up` does first, with no cluster, and it gives the same refusals.
```

The block also holds an index of those docs. They are the docs of the Kit version that your `package.json` pins. Thus
your Assistant reads the API that your Instance runs, not the API that its training data holds.

## Ask for the Machine

Give your Assistant this prompt. Replace `<you>` with your GitHub user name. Replace `<version>` with the Kit version.

```text
Write a workflow named fix, in workflows/fix.ts. A coder Agent works in a Workspace on my fork, https://github.com/<you>/jr2.git, from the ref v<version>, in the Repo Slot target. It uses the model that workflows/task.ts uses. The run input is { prompt }, as for the task workflow. When the coder finishes, run node --test in docs/site/tutorial/greet in its Worktree. If the tests fail, send the output back to the coder. If they pass, a human reviews at a Gate named review, with the events request_changes (with notes) and approve. On request_changes, the coder continues with the notes. On approve, push the branch to my fork.
```

Each Assistant writes a different file, and the same Assistant can write a different file on each try. This page cannot
show your file. It shows one result that typechecks, and it tells you what to look for in the graph. Your file can
differ in its names, its comments and its text, and still be correct. [Read one result](#read-one-result) walks through
it.

## Converge the Instance

Run [`jr2 up`](../reference/cli.md#up):

```sh
jr2 up
```

`jr2 up` typechecks the Instance first. Then it loads each Workflow and walks its Machine. If your Assistant wrote a
Machine that does not compile, `jr2 up` stops before it builds anything:

```text
…
typecheck: tsc --noEmit (the instance's own compiler)
refusing: this instance does not typecheck — nothing was built and nothing was applied
  workflows/fix.ts(69,87): error TS2339: Property 'app' does not exist on type 'Record<"target", string>'.
```

The lines after it are the errors of `tsc`. Here, the Machine reads a Repo Slot, `app`, that its Workspace does not
have. Give them to your Assistant. Then run `jr2 up` again.

The block tells your Assistant to run [`jr2 check`](../reference/cli.md#check) before it gives you the file. `jr2 check`
does these two steps of `jr2 up`, with no cluster, and gives the same refusals. Thus an Assistant that cannot run
`jr2 up` finds these errors itself.

When `fix` is correct, `jr2 up` tells you what the Machine runs outside itself, and who may send each event. Your lines
can differ when your Assistant used other names. Other Workflows of the Instance add lines too:

```text
…
typecheck: tsc --noEmit (the instance's own compiler)
effects: workflow "fix" — what it runs outside itself (ADR-0067)
  tests: command ["node","--test","docs/site/tutorial/greet/test/*.test.js"] — 300s, in the Harness
  publish: push — 300s, in the Sandbox Effector
seats: workflow "fix" — who may send what, per state (ADR-0015)
  fix.working agent:coder: [finish]
  fix.review gate: [approve, request_changes]
…
Workspace of workflow "fix": Sandbox Effector (image the Sandbox Image) holds no Effect secret; pushes Repo Slot "target" with git.credentials "*"
…
warning: git.credentials "*": the Secret "jr2-git-ssh" does not exist in namespace my-instance — a push that needs it is refused at provision until it exists and jr2 up runs again (ADR-0051)
git.credentials "*": push Secret jr2-git-push-684888c0 — pushes over https
…
```

Read these lines as a first check:

- `effects` shows two Effects: a command and a push. A Workflow that pushes with no
  [Gate](../reference/glossary.md#gate) before the push shows the same lines. The graph shows where the push is.
- `seats` shows that the coder can send only `finish`. Only the Gate in `review` can send `approve` and
  `request_changes`.
- The `warning` line is about git over ssh. The `jr2-git-ssh` Secret is for an ssh key, and it does not exist. Your fork
  uses `https://`, so the push does not need it. The last line says that the push uses the token over https.

If `JR2_GIT_TOKEN` is not set, `jr2 up` stops before it applies the
[Orchestrator](../reference/glossary.md#orchestrator), with this error:

```text
…
git.credentials "*": its token's variable JR2_GIT_TOKEN is not set — set it in .env
error: Workspace of workflow "fix": the push of Repo Slot "target" (https://github.com/<you>/jr2.git): git.credentials entry "*" cannot push — its token's variable JR2_GIT_TOKEN is not set — set it in .env (ADR-0051)
```

## Read the graph before you run it

This step is the most important step of the page. The Console draws a Machine as a graph, and you can read it before it
runs. Read how the work happens before you read the code that comes out of it.

Open the graph of `fix` in the Console:

```text
http://localhost:4000/workflows/fix
```

The Console shows the Machine with no run. The outer boxes are the states of the
[Workspace](../reference/glossary.md#workspace): `placing`, `provisioning`, `attaching`, `running`, `teardown`,
`failing` and `done`. jr2 makes them. The body of your Assistant's Machine is the box `▣ body`, inside `running`. Read
that box.

A box is a state. A line `⚙ <name>` in a box is what the state runs. An arrow is a transition. Its label is the event
that moves the run, and `[<name>]` is the guard that it must pass. Look for these facts:

1. **The coder works in one state.** `working` runs `⚙ coder`. The arrow `finish` is the coder's only pick. The coder
   cannot push, and it cannot approve its own work.
2. **The tests decide.** `testing` runs `⚙ tests`. The arrow `done: testing [testsPassed]` goes to `review`. The other
   `done: testing` arrow goes back to `working`. No arrow goes from `testing` to `pushing`.
3. **You decide at the Gate.** `review` runs `⚙ gate`. Its arrows are `approve` and `request_changes`. The run waits
   there until you send one of them.
4. **The push comes only after `approve`.** `pushing` runs `⚙ publish`. The only arrow into `pushing` is `approve`.
5. **Each failure has a place to go.** `agent.fault` goes from `working` to `review`. A push that fails goes back to
   `review`. The line `↺ workspace.lost` in the `▣ body` box applies to every state of the body. The graph does not show
   its target. In this file, it goes to `lost`, which invokes `fail`: the run ends `failed`.

Open **who may send what** in the pane of the graph. It shows the same seats as `jr2 up`:

```text
who may send what · 2 seats
fix.working agent:coder finish
fix.review gate approve, request_changes
```

An arrow can show `[?]` in place of a guard name. That guard is a function with no name. Read the guard in the file. You
can also ask your Assistant to give it a name.

Also look for a loop with no exit. In this result, `working` and `testing` can loop until the tests pass, and no count
stops them. If you want a limit, ask your Assistant for one. Then read the graph again.

## Run fix

Start the run in your first terminal. The prompt is the task text from the last page:

```sh
jr2 run fix --input '{"prompt":"In docs/site/tutorial/greet, one test fails. Fix the bug in docs/site/tutorial/greet/src/greet.js. To check your fix, run node --test in docs/site/tutorial/greet. Do not change files outside that folder. Do not run the tests of the repo root."}'
```

[`jr2 run`](../reference/cli.md#run) stays attached until the run ends. Your run id is different:

```text
…
→ context kind-jr2 / namespace my-instance
run b22cef63-1523-45f3-9c51-36c54b79ce36 (fix) — attached
  → active "placing"
  → active "provisioning"
  → active "attaching"
  → active "running"
…
```

Watch the run in the Console. The Console lights the state that the run is in. The run goes through `working` and
`testing`, and it can go back to `working` when the tests fail. Then it waits at `review`.

## Read the Gate

In a second terminal, read the Gate. Replace `<run id>` with the run id from the first terminal, or with its first 4
characters or more:

```sh
jr2 status <run id>
```

[`jr2 status`](../reference/cli.md#status) prints the status of the run as one line of JSON. Its `gates` list holds the
Gate of `review`. Its `gate` is `body.review`. Give that value to `--gate`. The `meta` of the Gate gives the coder's
`summary`, the `branch` and the `worktree`:

```text
…
→ context kind-jr2 / namespace my-instance
{…,"gates":[{"gate":"body.review",…,"meta":{"summary":"Fixed the \"trims the name\" test failure in docs/site/tutorial/greet/src/greet.js by adding .trim() to the name parsing. The name \" ada \" was not being trimmed, causing the greeting to include extra whitespace. Changed `args.find((a) => !a.startsWith(\"-\")) ?? \"world\"` to `(args.find((a) => !a.startsWith(\"-\")) ?? \"world\").trim()`.","branch":"jr2/fix-336ae477-2a46-49c2-b142-b81e705bb3f8","worktree":"/work/target/jr2-fix-336ae477-2a46-49c2-b142-b81e705bb3f8"}}]}
```

The `summary` is in the words of the model, so your summary is different.

## Approve

Send `approve` to the Gate with [`jr2 send`](../reference/cli.md#send):

```sh
jr2 send <run id> --gate body.review --event approve
```

```text
…
→ context kind-jr2 / namespace my-instance
delivered approve to gate "body.review" on b22cef63-1523-45f3-9c51-36c54b79ce36
```

The run goes to `pushing`, and the push Effect pushes the branch. Then the run ends, and jr2 removes the
[Sandbox](../reference/glossary.md#sandbox). In the first terminal, `jr2 run` prints its last line, then the final
status as one line of JSON:

```text
…
  → active "teardown"
  → done "done"
{"runId":"b22cef63-1523-45f3-9c51-36c54b79ce36","workflow":"fix",…,"output":{"outcome":"pushed","branch":"jr2/fix-336ae477-2a46-49c2-b142-b81e705bb3f8","commit":"03f8800ec105c98f612bd2c55687bb92db80357a"}}
```

In that JSON, `context.output` and `output` are the output of `fix`. In this result, it is
`{"outcome":"pushed","branch":"jr2/fix-<instance id>","commit":"<commit>"}`. `<instance id>` is the seed
[Instance ID](../reference/glossary.md#instance-id) of the run. It is not the run id. `<commit>` is the commit on your
fork.

## Find the branch on your fork

List the branches of `fix` on your fork:

```sh
git ls-remote https://github.com/<you>/jr2.git 'jr2/fix-*'
```

<!-- output: not run -->

```text
<commit>	refs/heads/jr2/fix-<instance id>
```

You can also open the branch on GitHub. The commit holds the coder's fix of `docs/site/tutorial/greet/src/greet.js`.

## Read one result

This is one `fix.ts` that does what the prompt asks, with the model of the tab:

::: tabs key:provider

== Anthropic

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts

== Local

<<< @/examples/get-started/have-your-assistant-write-a-machine/local/fix.ts

:::

Read it in the order of the graph. Each part below links to its entry in the Reference.

**The events.** Each [`defineEvent`](../reference/authoring-surface/defineevent.md) is an event that the Machine takes.
`finish` is in a state that invokes the coder, so it is a tool on the coder's [Menu](../reference/glossary.md#menu).
`approve` and `request_changes` are in a state that invokes the Gate, so only the Gate takes them. This file sets no
`audience` on its events, so the place of each event says who sends it. The `defineEvent` field `audience` can change
that. The seats show the result.

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#events

**The Effects.** `tests` and `publish` are actor slots, as the coder is. A state runs one when it invokes it.
[`command()`](../reference/authoring-surface/command.md) takes a list of arguments, not a line of shell text. It runs in
the [Worktree](../reference/glossary.md#worktree) of the one [Repo Slot](../reference/glossary.md#repo-slot). A command
runs in the root of the Worktree, so `tests` names the test files by their path from that root.
[`push()`](../reference/authoring-surface/push.md) pushes the tip of the coder's branch.
[`fail()`](../reference/authoring-surface/fail.md) is a Part, not an Effect. The `lost` state invokes it to end the run
`failed`, because a final state means `done`.

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#effects

**The coder's state.** `working` invokes the coder. Each [Turn](../reference/glossary.md#turn) gets a prompt and the
folder to work in. `continue: true` keeps one conversation, so the coder remembers its last Turn. `finish` is the
coder's pick: the run goes to `testing`. [`agent.fault`](../reference/mechanism-events.md#agent-fault) is an event from
jr2, when it cannot get a pick from the coder.

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#working

**The tests.** Every outcome of a command is output. A failed test is output too. The `onDone` list routes on that
output. The first transition whose guard passes is the one that the run takes. The second transition has no guard, so it
catches every other outcome. See [`CommandOutput`](../reference/authoring-surface/type-commandoutput.md).

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#testing

**The Gate.** `review` invokes `gate`. jr2 makes the id of the Gate from the invoke ids. `workspace()` runs your Machine
as `body`, and the state is `review`, so the id is `body.review`. You give `--gate body.review` to `jr2 send`. See
[the id of a Gate](../concepts/gates.md#the-id). `meta` is what `jr2 status` and the Console show you at the Gate.

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#review

**The push.** `pushing` invokes `publish`. A push that fails is output too: `rejected`, `diverged` or `unknown`. Here it
goes back to `review`, and the Sandbox stays. If the run went to a final state, jr2 would remove the Sandbox and the
commits in it. See [`PushOutput`](../reference/authoring-surface/type-pushoutput.md).

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#pushing

**The Workspace.** [`workspace()`](../reference/authoring-surface/workspace.md) runs the body in a Sandbox. `input` is
the schema of the run input that `jr2 run --input` sends. `repos` binds the Repo Slot `target` to your fork, at the
release tag. `spec` gives the branch. The input of `spec` also holds `instanceId`, an id that jr2 makes for each run, so
each run gets a branch of its own.

<<< @/examples/get-started/have-your-assistant-write-a-machine/anthropic/fix.ts#workspace

## What happened

- Your Assistant wrote a Machine from the docs that your Instance holds. `jr2 up` keeps the index of those docs in
  `AGENTS.md`, so the docs match the Kit version of the Instance.
- `jr2 up` typechecked the Machine and walked it before it built anything. It showed the Effects and the seats.
- You read the graph before the run. The graph showed that the push comes only after your `approve`.
- A `command` Effect ran the tests in the Sandbox, and a `push` Effect pushed the branch. Each Effect runs in a state of
  the graph, so you can see where it runs. See [Effects](../concepts/effects.md).
- The coder and you sent different events. In this Machine, the place of each event decides who sends it. See
  [The Menu](../concepts/the-menu.md) and [Gates](../concepts/gates.md).

To change a Machine with your Assistant on kind, see
[Iterate on a Machine on kind](../guides/iterate-on-a-machine-on-kind.md). The decision about the docs in the Kit is
[ADR-0072](../reference/decisions/0072-the-docs-ship-inside-the-kit-and-an-instances-agents-md-indexes-them.md).

## Next

Read [Machines and Workflows](../concepts/machines-and-workflows.md).
