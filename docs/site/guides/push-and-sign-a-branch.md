---
title: Push and sign a branch
description: Push the branch of a Workspace, and sign its commits with a key that the Agent never reads.
---

Push the branch of a [Workspace](../reference/glossary.md#workspace) with a `push`
[Effect](../reference/glossary.md#effect), signed with a key that the [Agent](../reference/glossary.md#agent) never
reads.

[`push(options)`](../reference/authoring-surface.md#push) pushes the branch to the [Repo](../reference/glossary.md#repo)
that the [Binding](../reference/glossary.md#binding) of its [Repo Slot](../reference/glossary.md#repo-slot) names. With
`sign: true`, it pushes signed copies of the Agent's commits. In this [Workflow](../reference/glossary.md#workflow), a
coder fixes the tests and commits. A person reads the branch at the [Gate](../reference/glossary.md#gate) of the state
`review`, then sends `approve`. Then the [Machine](../reference/glossary.md#machine) pushes the branch, signed. Save the
file as `workflows/publish.ts` in your [Instance](../reference/glossary.md#instance):

::::tabs

:::tab{label="Anthropic"}

::include{file="../examples/guides/push-and-sign-a-branch/anthropic/publish.ts"}

:::

:::tab{label="Local"}

::include{file="../examples/guides/push-and-sign-a-branch/local/publish.ts"}

:::

::::

Write your GitHub user name in place of `<you>`. The Agent uses the model of the tab.

The sections below give the push a credential and a signing key, and give the
[Sandbox Effector](../reference/glossary.md#sandbox-effector) the program that signs. In the commands, write the
namespace of your Instance in place of `<namespace>`. It is the [`name`](../reference/config.md#name) in
`jr2.config.ts`, or the name of the Instance folder when `jr2.config.ts` sets no `name`.

## Give the push a credential

A `push` uses the entry of [`git.credentials`](../reference/config.md#git-credentials) that the URL of the Repo Slot
matches. By default, the clone credential of the entry also pushes. To push with a different credential, give the entry
a [`push`](../reference/config.md#git-credentials-push) field.

The example pushes over `https://` with the token in `JR2_GIT_TOKEN`. On GitHub, make a token with "Contents: Read and
write" on the repository. Put it in `.env`, with the token in place of `<token>`:

```sh
JR2_GIT_TOKEN=<token>
```

[Give the cluster git credentials](give-the-cluster-git-credentials.md) tells how to use an ssh key, and how an entry
matches a URL.

## Make a signing key

jr2 never signs with the clone key or the push key. Make a key for signing only. Run this command outside the Instance
folder, so that the private key does not go into a commit. It writes the private key to `jr2-sign` and the public key to
`jr2-sign.pub`, with no passphrase. `-C` gives the key a label. With `-q`, it prints nothing:

```sh
ssh-keygen -q -t ed25519 -N "" -C "<your email>" -f jr2-sign
```

Add the public key in `jr2-sign.pub` to your account on the forge, as a signing key. On GitHub, add it in Settings,
under "SSH and GPG keys", with the key type "Signing Key".

Put the private key in a Secret, under the key `identity`. The namespace exists after the first `jr2 up`:

```sh
kubectl -n <namespace> create secret generic jr2-git-sign --from-file=identity=jr2-sign
```

<!-- output: not run -->

```text
secret/jr2-git-sign created
```

Then delete `jr2-sign`. The `jr2 up` in [Run jr2 up](#run-jr2-up) copies the key into the push Secret of the entry, and
the Sandbox Effector reads it from there.

## Add the key to git.credentials

Give the entry that matches your Repos a [`sign`](../reference/config.md#git-credentials-sign) field. `sshKey` is the
name of the Secret. `name` and `email` are the committer of each signed commit:

::include{file="../examples/guides/push-and-sign-a-branch/jr2.config.ts"}

The file shows only the `git` field. Keep the other fields of your `jr2.config.ts`. Write your name and the email of
your forge account in place of `<your name>` and `<your email>`. The forge checks the `email` of `sign`: it must be an
email of the account that holds the signing key. Otherwise the forge shows the signature as not verified. The longest
`match` wins, so the first entry is the entry for each Repo under `github.com/<you>/`.

To sign with GPG, write `sign: { gpgKey: "<secret>", name, email }`. The Secret holds the private key under the key
`private.asc`, with no passphrase. `<file>` is the private key, in ASCII armor:

```sh
kubectl -n <namespace> create secret generic <secret> --from-file=private.asc=<file>
```

## Give the Sandbox Effector the program that signs

A `push` runs in the Sandbox Effector of the Workspace. By default, the Sandbox Effector runs in the
[Sandbox Image](../reference/glossary.md#sandbox-image). It runs the programs of a push only from `/usr/local/bin`,
`/usr/bin` and `/bin`. Each form of push needs these programs in the image:

| The push                          | The programs                          | The Debian package |
| --------------------------------- | ------------------------------------- | ------------------ |
| Over `https://`, with a token     | `git`                                 | `git`              |
| Over ssh                          | `ssh`, and a passwd entry for its uid | `openssh-client`   |
| Signed with an ssh key (`sshKey`) | `ssh-keygen`                          | `openssh-client`   |
| Signed with GPG (`gpgKey`)        | `gpg` and `gpg-agent`                 | `gnupg`            |

The `images/default/Dockerfile` that `jr2 init` writes installs `git` and no ssh. Add `openssh-client` to its
`apt-get install` line. The example shows the file without the comments that `jr2 init` writes:

::include{file="../examples/guides/push-and-sign-a-branch/images/default/Dockerfile"}

To keep these programs out of the Sandbox Image, give the `workspace()` an image for the Sandbox Effector only:
`effector: { image }` (see [`SandboxOptions`](../reference/authoring-surface.md#type-sandboxoptions)).
[Add tools to the Sandbox](add-tools-to-the-sandbox.md) tells how to change an image.

## Run jr2 up

Run [`jr2 up`](../reference/cli.md#up). It shows the push, and the push Secret of the entry:

```sh
jr2 up
```

<!-- output: not run -->

```text
…
effects: workflow "publish" — what it runs outside itself (ADR-0067)
  publish: push (sign) — 300s, in the Sandbox Effector
…
git.credentials "github.com/<you>/": push Secret jr2-git-push-<hash> — pushes over https; signs with ssh
…
```

`<hash>` comes from the `match` of the entry. `jr2 up` reads the image of the Sandbox Effector when `jr2 up` built that
image. When the Workspace names no image and the Instance has no `images/default`, the Sandbox Effector runs in the
stock [Harness](../reference/glossary.md#harness) image. `jr2 up` knows what that image holds. When the image does not
hold a program that the push needs, `jr2 up` stops. See [Rules](#rules).

## Run the Workflow

Start the run. Write the task in place of `<task>`. Write the name of the coder's branch in place of `<branch>`:

```sh
jr2 run publish --input '{"prompt":"<task>","branch":"<branch>"}' --detach
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
{"runId":"<run id>"}
```

`<context>` is your kubectl context, and `<namespace>` is the namespace of the Instance. `<run id>` is the id of the new
run. Give `<run id>` to the next commands.

The Machine is the body of a `workspace()`, so the id of the Gate of the state `review` is `body.review`.
[`jr2 status <run id>`](../reference/cli.md#status) shows it under `gates`. When the run waits at this Gate, read the
branch in the [Sandbox](../reference/glossary.md#sandbox). The branch is not on the remote yet.
[Look inside a Sandbox](look-inside-a-sandbox.md) tells how. Then send `approve`:

```sh
jr2 send <run id> --gate body.review --event approve
```

<!-- output: not run -->

```text
→ context <context> / namespace <namespace>
delivered approve to gate "body.review" on <run id>
```

[Answer a Gate](answer-a-gate.md) tells how to find the open Gate, and how to answer from the
[Console](../reference/glossary.md#console).

## Read the output of the push

Each outcome is output for `onDone`. Route on `outcome`
([`PushOutput`](../reference/authoring-surface.md#type-pushoutput)):

- `pushed`: the remote has the commit. `published` is the commit on the remote, and `source` is the Agent's commit.
- `rejected`: git, the remote or the Sandbox Effector refused the push. `stage` tells where, and `reason` tells why.
- `diverged`: in a signed push, the commit on the remote is not in the history of the Agent's branch, and jr2 cannot
  pair it with an Agent commit. jr2 pushed nothing. An unsigned push to a remote branch that moved is `rejected`.
- `unknown`: jr2 cannot tell what the push did.

After a signed push, the commits on the remote are signed copies, with new ids. jr2 then moves the Agent's branch to
them, and `sync` tells the result. The files, the index and the stash of the Agent do not change. jr2 tells the Agent
what moved.

After a signed push, when the Agent amends, rebases or resets a commit that it pushed, the next push is `diverged`. Then
jr2 pushes nothing, also with `force`.

When the push did not succeed, the example waits at the Gate of the state `notPushed`. Its id is `body.notPushed`. A
final state ends the Workspace, and jr2 then deletes the Sandbox with the commits in it. At the Gate, the Sandbox stays.
To push again, send `approve`:

```sh
jr2 send <run id> --gate body.notPushed --event approve
```

## Other options

- `pin: true`: push the commit that the input of the Effect names, `{ sha: "<full commit id>" }`. Use it for a commit
  that a Gate approved. Without `pin`, jr2 pushes the tip of the branch when the Effect starts.
- `squash: true`: push one commit that holds all of the changes. The input gives its message, `{ message: "<text>" }`.
  Without `sign`, the [`committer`](../reference/config.md#git-credentials-committer) of the entry commits it.
- `force: true`: replace what the remote branch holds.
- `slot`: the Repo Slot to push. Write it only when the Workspace has more than one Repo Slot.
- `timeout`: how long jr2 waits for the push. The default is `"5m"`. After it, the outcome is `unknown`.

## Rules

`jr2 up` refuses:

- a signed push whose entry has no `sign` field. `<push>` is
  `workflow "<workflow>": push "<slot>" pushes Repo Slot "<name>" (<url>)`:
  `<push> signed, and git.credentials entry "<match>" holds no sign field — add sign: { sshKey: "<a Secret with identity>", name: "<committer name>", email: "<committer email>" } to it; the email must belong to the forge account that holds the key (ADR-0051, ADR-0067)`
- a squashed push without `sign`, whose entry has no `sign` and no `committer`:
  `<push> squashed without sign, and git.credentials entry "<match>" holds neither sign nor committer — the squashed commit is new and needs a committer; add committer: { name: "<committer name>", email: "<committer email>" } to it, or sign the push — push({ squash: true, sign: true }) — and add sign: { sshKey: "<a Secret with identity>", name: "<committer name>", email: "<committer email>" } to it (ADR-0051, ADR-0067)`
- a push to a local path:
  `<push>, a local path — jr2 never pushes to one: git's local transport runs that repository's config and hooks (ADR-0067)`
- a push over `git://`: `<push> over git://, which carries no credential — bind the slot over https or ssh (ADR-0051)`
- a push over `http://`. The text continues with the fix for the entry that the URL matches, such as
  `bind the slot to the https url`:
  `<push> over http://, and jr2 sends a push credential over https or ssh only — a token over http is the token in the clear, and no ssh key is spent over http; <fix> (ADR-0051)`
- a push to a URL that no entry matches. `<field>` is a `token` or an `sshKey` field:
  `<push>, and no git.credentials entry matches "<identity>" — a push spends the entry its url matches; add one: git: { credentials: [{ match: "<match>", <field> }] } (ADR-0051)`
- a push over a scheme for which the entry holds no credential. For example, the slot binds an ssh URL, and the entry
  holds only a `token`. `<scheme>` is `ssh` or `https`. `<field>` is
  `sshKey: "<a Secret with identity and known_hosts>"` or `token: "<the env var that holds the token>"`, in a
  `push: { … }` field when the entry has one:
  `<push>, and git.credentials entry "<match>" holds no credential a push over <scheme> can spend; add <field> to it (ADR-0051)`
- a push over `https://` when the variable of the token is not set:
  `Workspace of workflow "<workflow>": the push of Repo Slot "<slot>" (<url>): git.credentials entry "<match>" cannot push — its token's variable <NAME> is not set — set it in .env (ADR-0051)`
- an image with no program that the push needs. `<program>` is `ssh`, `ssh-keygen`, `gpg` or `gpg-agent`, and `<form>`
  is `over ssh`, `signed with an ssh key` or `signed with GPG`. `<package>` is the package to install, for example
  `openssh-client` or `gnupg`:
  `Workspace of workflow "<workflow>": the push of Repo Slot "<slot>" (<url>) <form> needs <program>, and its Sandbox Effector's image <ref> holds none in /usr/local/bin, /usr/bin, /bin — the Effector runs jr2's programs from there alone; install it in the image (<package>) (ADR-0068)`
- the same, when the Sandbox Effector runs in the stock Harness image:
  `Workspace of workflow "<workflow>": the push of Repo Slot "<slot>" (<url>) <form> needs <program>, and its Sandbox Effector runs in the stock Harness image <ref>, which holds git alone — the Workspace names no image and the instance has no images/default; give it an image that holds <program> (<package>): an images/default Sandbox Image, the workspace()'s image, or its effector: { image } (ADR-0068)`
- for a push over ssh, an image with no user for the uid that the Sandbox Effector runs as:
  `Workspace of workflow "<workflow>": the push of Repo Slot "<slot>" (<url>) over ssh needs a passwd entry for the <user> the Sandbox Effector runs as, and its image <ref> has none — ssh exits "No user exists for uid" before it connects; add <fix> (ADR-0068)`.
  `<user>` is `user <name>` when the image has a `USER` line with a name, or `uid <uid>`. `<fix>` is
  `a USER line naming a user the image's /etc/passwd holds`, or `RUN adduser -D -u <uid> <name> in the image`.

`jr2 up` checks an image that it built, or the stock Harness image. It does not check an image that is a registry ref.
It checks only a Repo Slot that the Machine binds. It does not check a URL that the run input or `customize()` gives.

When the Secret of the signing key does not exist, `jr2 up` does not stop. It shows this warning:
`warning: git.credentials "<match>": the Secret "<secret>" does not exist in namespace <namespace> — a push that needs it is refused at provision until it exists and jr2 up runs again (ADR-0051)`.
Then the [Orchestrator](../reference/glossary.md#orchestrator) refuses the push when it makes the Sandbox:
`Sandbox "<name>" refuses the push of Repo Slot "<slot>" (<url>), and jr2 up placed no signing key for git.credentials entry "<match>" — its token's variable was not set, or a Secret it names did not exist, when jr2 up last ran; set it or create it, and run jr2 up again (ADR-0051)`

When a `push` starts, it refuses:

- a state outside a `workspace()`:
  `push "<slot>" runs in the Sandbox Effector of a Workspace, and its state is not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`
- no `slot` under a Workspace with more than one Repo Slot:
  `push "<slot>" runs under a Workspace carrying more than one Repo Slot (<slots>) — say which: { slot: "<slot>" } (ADR-0051)`
- a `slot` that the Workspace does not have:
  `push "<slot>" names Repo Slot "<name>", which its Workspace does not carry (<slots>)`
- with `pin: true`, a `sha` that is not a full commit id:
  `push({ pin: true }): its input's sha is not a full commit id (got <sha>)`
- with `squash: true`, an input with no message: `push({ squash: true }): its input carries no message`

`push()` refuses a timeout that is not a positive duration:
`timeout "<timeout>" is not a positive duration (like "30s", "5m")`

A GPG key with a passphrase cannot sign. The push is `rejected`, with `stage` `sign` and this `reason`:
`the GPG signing key "<name>" has a passphrase, or does not sign; jr2 signs only with a key that has none`. `<name>` is
the push Secret of the entry, `jr2-git-push-<hash>`, as `jr2 up` shows it. It is not the Secret that `gpgKey` names.

## Read next

- [Effects](../concepts/effects.md): the `push` Effect, where it runs, and at most once.
- [Secrets and trust](../concepts/secrets-and-trust.md): who holds the push credential and the signing key.
- [Give the cluster git credentials](give-the-cluster-git-credentials.md): the entries of `git.credentials`.
- [Add tools to the Sandbox](add-tools-to-the-sandbox.md): the Sandbox Image.
- Reference: [`push`](../reference/authoring-surface.md#push),
  [`PushOptions`](../reference/authoring-surface.md#type-pushoptions),
  [`PushOutput`](../reference/authoring-surface.md#type-pushoutput) and
  [`git.credentials[].sign`](../reference/config.md#git-credentials-sign).
- [ADR-0067](../reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md):
  the `push` Effect, signed copies and the sync of the branch.
- [ADR-0068](../reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md): the Sandbox
  Effector and its image.
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): the credential
  entries.
