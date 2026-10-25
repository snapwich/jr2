---
title: Give the cluster git credentials
description: Give the cluster a token or an ssh key to clone and push your Repos, and choose which Repos a run can name.
---

Give the cluster the credentials that it uses to clone and push your [Repos](../reference/glossary.md#repo).

The same list also sets which Repos a run can name. The credentials are the entries of
[`git.credentials`](../reference/config.md#git-credentials) in `jr2.config.ts`. It is not a list of Repos: a
[Machine](../reference/glossary.md#machine) names its Repos in the [Repo Slots](../reference/glossary.md#repo-slot) of
its [`workspace()`](../reference/authoring-surface/workspace.md). This example has three entries:

<<< @/examples/guides/give-the-cluster-git-credentials/jr2.config.ts

Write your GitHub user name in place of `<you>`.

## How an entry matches a Repo

`jr2 up` and the [Orchestrator](../reference/glossary.md#orchestrator) find the entry for a Repo from its identity. The
identity is the host and the path of the url, with no scheme, no user and no `.git`. For example,
`https://github.com/<you>/app.git` and `git@github.com:<you>/app.git` have the same identity, `github.com/<you>/app`.

- `match` is a prefix of the identity, such as `github.com/<you>/`, or `*` for each Repo.
- When two or more entries match, the longest `match` wins. When two have the same length, the first entry wins.
- The scheme of the url selects the credential. An `https://` url uses `token`. An ssh url uses `sshKey`.
- An entry with no `token` and no `sshKey` lets its Repos through the fence. The cluster clones them with no credential.
  If the entry also has no `push` field, the cluster never pushes to them.

`jr2 init` writes one entry, `{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }`. It matches each Repo.

## Use a token over https

Make a token at your git host. On GitHub, make a fine-grained personal access token for the repositories that the
cluster uses. Give it "Contents: Read-only" to clone, or "Contents: Read and write" to clone and push.

Put the token in `.env`, under the name that the entry gives in `token`:

```sh
GITHUB_TOKEN=<token>
```

Run `jr2 up`:

```sh
jr2 up
```

When a registered Machine has a [Workspace](../reference/glossary.md#workspace), `jr2 up` writes the token into a Secret
for its entry:

```text
…
git.credentials "github.com/<you>/": clone Secret jr2-git-<hash>
…
```

`<hash>` comes from the `match` of the entry, so it does not change between runs of `jr2 up`. Only the Repo cache reads
this Secret. The [Agent](../reference/glossary.md#agent) never sees the token. The token goes to the git host with the
user name `x-access-token`.

When the variable is not set, `jr2 up` writes no Secret for the entry, and the cluster clones with no credential. A
private Repo then fails to clone, and `jr2 status` shows the error of the Repo.

## Use an ssh deploy key

An ssh url uses the key in the Kubernetes Secret that `sshKey` names. The Secret holds the key under the key names that
Flux uses: `identity` (the private key), and, optionally, `identity.pub` and `known_hosts`.

### Let jr2 up make the key

A Machine can bind a Repo Slot to an ssh url. When the Secret of its entry does not exist, `jr2 up` asks where the key
comes from:

```text
git@github.com:<you>/app.git bind over ssh and the "github-deploy-key" Secret their git.credentials entry names does not exist.
  whichever key you pick lands in a Secret in namespace "my-instance" — readable by anyone with
  Secret read there, and at rest in etcd. A deploy key leaks read access to the repos you
  register it on; a personal key leaks everything it can reach.
where should the git ssh key come from?
❯ generate a fresh in-cluster deploy keypair (recommended — one registration per repo)
  use /home/<user>/.ssh/id_rsa
  use another local key (type a path)
  paste a private key (input hidden)
  (↑/↓ move · enter selects · esc cancels)
```

The list shows each private key in `~/.ssh`, so your list can be different. Select one of these choices:

- **Generate.** `jr2 up` makes a new ed25519 key pair in the Secret. This is the recommended choice. `jr2 up --yes`
  always selects it.
- **Use a local key.** `jr2 up` copies a key from your computer into the Secret.
- **Paste a private key.** `jr2 up` reads the key from the terminal and does not show it.

A deploy key that leaks gives read access only to the repositories that you register it on. A personal key that leaks
gives access to all that it can reach. Thus use a deploy key.

When you select "generate", `jr2 up` shows the public key and waits:

```text
generated deploy key SHA256:6AcfwCiKJORn3xak1nSIVWl6AxZ0F7xzDKm6OlpAoU8 — register this PUBLIC key (read access):
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeFTbAhIVF4+h0L0T+jix9DjRb6fZJuTO+YB/TLHYyk jr2-git-ssh
register this public key with your git host, then press enter to continue:
```

Each run of "generate" makes a new key, so your key and its fingerprint are different.

Add the public key to the repository as a deploy key. Then push Enter. At the end, `jr2 up` shows the key again:

```text
…
converged — `jr2 run <workflow>` when ready
git ssh: a deploy key was generated into "github-deploy-key" this converge and nothing has registered it yet:
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeFTbAhIVF4+h0L0T+jix9DjRb6fZJuTO+YB/TLHYyk jr2-git-ssh
  until it is registered, git@github.com:<you>/app.git will not sync (the Orchestrator serves anyway)
  the cache agent retries on its own — `jr2 status` reports each Repo's last error per node
```

`jr2 up` asks once for each Secret that does not exist. When the Secret exists, it does not ask again.

### Make the Secret yourself

Make the Secret yourself in these cases:

- A run gives the ssh url in its input. `jr2 up` does not see that url, so it does not ask.
- A script runs `jr2 up`, and you want a key other than a new one.

First, get the host keys of your git host into a `known_hosts` file. Write the host, such as `github.com`, in place of
`<host>`:

```sh
ssh-keyscan <host> > known_hosts
ssh-keygen -lf known_hosts
```

`ssh-keygen -lf` shows the fingerprints. Compare them with the fingerprints that your git host publishes. Do not use the
file if they are different.

Then make the Secret. Write the namespace of the [Instance](../reference/glossary.md#instance), the name that `sshKey`
gives, and the path to the private key:

```sh
kubectl -n <namespace> create secret generic <name> --from-file=identity=<private key> --from-file=known_hosts=known_hosts
```

With `known_hosts`, the Repo cache accepts only the host keys in that file. With no `known_hosts`, it accepts the host
key on the first connection, and keeps it while the Repo cache agent runs.

## Narrow the fence

The list is also a fence. A url that a Machine binds is code that your Instance typechecked. It needs no entry, and with
no entry it clones with no credential. A url that comes from the run input is different: a run could name any host. So
the url of a per-run Repo Slot must match an entry, or the [Sandbox](../reference/glossary.md#sandbox) refuses it.

The `*` entry of `jr2 init` lets each url through. Narrow it to your hosts before a person or a system that you do not
trust can start a run. The example on this page lets a run name only the repositories under `github.com/<you>/`,
`gitlab.example.com/team/` and `github.com/snapwich/`.

## Push with the same credentials

A [`push`](../reference/authoring-surface/push.md) [Effect](../reference/glossary.md#effect) uses the entry that its url
matches. By default, the clone credential of the entry pushes too. To push with a different credential, give the entry a
`push` field. The guide [Push and sign a branch](push-and-sign-a-branch.md) gives the push, the signing key and their
rules.

`jr2 up` tells you to give the key that it makes read access, and its Secret has no `known_hosts`. A push over ssh needs
write access and `known_hosts`. Thus, to push over ssh, make the Secret yourself.

## Rules

`jr2 up` prints each refusal after `error: `.

- The Sandbox refuses a per-run url that matches no entry, when it attaches the Repo. The run then faults:
  `Sandbox "<name>" refuses the per-run repo <url> for slot "<slot>": no git.credentials entry matches "<identity>" (entries: <entries>). A per-run url can spend the cluster's credential against any host, so jr2.config.ts must admit it by prefix (ADR-0051).`
- When `jr2 up` or the Orchestrator loads the config, it refuses an entry with a wrong shape:
  `<file> at git.credentials[<i>]<path>: <problem> — an entry is { match, token?, sshKey?, push?: { sshKey } | { token }, sign?: { sshKey | gpgKey, name, email }, committer?: { name, email } } (ADR-0051)`.
- `jr2 up` stops when you select no key source:
  `<urls> bind over ssh and need the "<secret>" Secret — re-run and pick a key source, create the Secret yourself (kubectl -n <namespace> create secret generic <secret> --from-file=identity=<path>), or bind the urls over https (+ a token in git.credentials)`.
- With no terminal and no `--yes`, `jr2 up` cannot ask. It prints this line, then stops with the refusal above:
  `where should the git ssh key come from? — not a tty; pass --yes to take the recommended option non-interactively`.
- `jr2 up` refuses a key that has a passphrase:
  `refusing the key from <where>: it is passphrase-protected. The in-cluster clone runs unattended and cannot answer a passphrase, and jr2 will not store a decrypted copy — use an unencrypted key, or let jr2 generate a deploy key`.
- When a [Workflow](../reference/glossary.md#workflow) pushes, `jr2 up` checks each push and signing Secret. It warns
  when a Secret does not exist, or when it does not hold a key that it needs, such as `known_hosts`. The Orchestrator
  then refuses a push under that entry until the Secret holds the key and you run `jr2 up` again:
  `warning: git.credentials "<match>": <why> — a push that needs it is refused at provision until it exists and jr2 up runs again (ADR-0051)`.
  `<why>` is `the Secret "<name>" does not exist in namespace <namespace>` or `the Secret "<name>" holds no key <key>`.
- `jr2 up` warns about an ssh url whose entry names no `sshKey`:
  `<url> is an ssh url and no git.credentials entry names a key for it — its cache clone will fail unless the host allows anonymous ssh`.
- `jr2 up` refuses a push over `https://` to a url that a Machine binds, when the token variable is not set:
  `Workspace of workflow "<workflow>": the push of Repo Slot "<slot>" (<url>): git.credentials entry "<match>" cannot push — its token's variable <NAME> is not set — set it in .env (ADR-0051)`.
  For a Workspace inside a different Machine, `Workspace of workflow "<workflow>"` continues with its route, such as
  ` → "<state>"`.

## Read next

- [Secrets and trust](../concepts/secrets-and-trust.md): who holds each credential.
- [Workspaces](../concepts/workspaces.md): Repos and Repo Slots.
- [Architecture](../concepts/architecture.md): the Repo cache.
- [Push and sign a branch](push-and-sign-a-branch.md): the `push` Effect.
- [`git.credentials`](../reference/config.md#git-credentials) in the `jr2.config.ts` Reference, and
  [`jr2 up`](../reference/cli.md#up) in the CLI Reference.
- [ADR-0051](../reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md): the entries, and
  the fence.
- [ADR-0047](../reference/decisions/0047-the-git-ssh-key-source-is-the-users-choice.md): the choice of the ssh key.
