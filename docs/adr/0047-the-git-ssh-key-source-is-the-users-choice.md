# The git ssh key source is the user's choice

[ADR-0019](0019-one-converging-command-against-the-current-context.md) drew a flat line — "personal keys never enter a
cluster" — and gave ssh repos exactly one path: `j2 up` generates an in-cluster deploy keypair and prints the public key
to register. The line had a cost the flow could not pay: GitHub allows one deploy key on exactly one repo, so a
multi-repo instance means N registrations, and re-using the printed key across repos is rejected — the flow pushed users
toward machine accounts or hand-rolled Secrets anyway. A key already registered with the git host makes that friction
zero. The invariant is demoted to a default: j2 never lifts a personal key silently, but the user may hand one over,
warned and on purpose.

## Decision

- **Three sources, one prompt**, when `up`'s walk of the registered Machines finds an ssh url on a bound Repo Slot
  (ADR-0051) whose matching `git.credentials` entry names an `sshKey` Secret that does not exist (the scaffold's
  wildcard entry names `j2-git-ssh`): **generate a fresh in-cluster deploy keypair** (recommended, listed first, today's
  behavior); **use a local key** (discovered `~/.ssh` candidates plus "other path"); or **paste one on stdin, hidden**.
  Declining all three bails, as before — the cache agent would only fail on an unauthenticated clone later. A per-run
  slot's url is not on the walk and is never prompted for: an ssh url first seen at attach fails that attach with the
  key hint, as any unregistered key does. The scripting escape stays kubectl: create the Secret yourself,
  `kubectl create secret generic j2-git-ssh --from-file=identity=…` — the Secret carries Flux's key names
  ([ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md)), and the cache agent reads no other.
- **`--yes` means generate.** Non-interactive mode never selects a personal key — the dangerous option is never a
  default. There is no `--git-ssh-key` flag: a scripted supplied-key path is the kubectl escape.
- **A passphrase-protected key is refused by name** — the in-cluster clone cannot answer a passphrase — detected with
  `ssh-keygen -y -P ""` before anything is applied. Decrypting and storing plaintext would silently strip protection the
  user chose to have.
- **The supplied-key paths warn at choice time**: the key lands in a namespace Secret, readable by anyone with Secret
  read there and at rest in etcd — a generated deploy key leaks read access to some repos; a personal key leaks
  everything it can reach. The public half (`identity.pub`) is derived via `ssh-keygen -y`; output prints the
  fingerprint, never key material.
- **The generate path pauses at the moment of truth.** The printed key is useless until registered, and an unregistered
  key makes the repo sync fail ([ADR-0048](0048-the-orchestrator-boots-without-its-repos.md) keeps that from crashing
  the boot). So interactively, `up` prints the key and waits: "register this public key with your git host, then press
  enter to continue" — the wait sits exactly where the user must act anyway. `--yes` proceeds without pausing, and any
  converge that generated a keypair **ends** by repeating the warning: the key, the repos that will not sync until it is
  registered, and that the cache agent retries on its own.

## Considered options

- **Keep the invariant, improve the messaging.** Rejected: the multi-repo friction is structural (one deploy key, one
  repo), not informational — no message makes N registrations cheaper than zero.
- **Agent forwarding instead of copying** (the ADR-0005 pattern for Sandbox sessions). Rejected here: the cache agent
  fetches unattended, in-cluster, on a schedule the user is not present for — forwarding authenticates a session, not a
  daemon.
- **A `--git-ssh-key <path>` flag.** Rejected: it makes the personal-key path scriptable, which is exactly the silent
  lift the prompt exists to prevent; the kubectl escape already serves automation, with the user's own tooling holding
  the key.
