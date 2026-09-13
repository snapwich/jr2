# The Orchestrator boots without its repos

The Orchestrator's boot-time repo sync was awaited before the server served: a repo that could not clone — an
unregistered deploy key, a wrong url, a git host outage — threw, the container exited, and the kubelet crash-looped the
Orchestrator. So one unreachable repo killed the daemon that hosts every Workflow, including ones that never touch a
repo, and a first converge with a freshly generated deploy key
([ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)) was guaranteed to time out its rollout unless the user
registered the key inside the wait. The codebase already names the correct blast pattern, four lines below the
violation: a missing `j2-images` ConfigMap does not stop the boot — the instance serves, and only a provision fails,
pointing at `j2 up`.

## Decision

- **A failed repo sync does not stop the boot.** The Orchestrator boots, serves, and creates the `Repo` resources its
  Machines bind ([ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md)); it does not sync them.
  The operator's cache agent clones and fetches each onto its node, retries a failure with backoff, and writes every
  result — synced, or git's own error — to the resource's status. The same blast pattern as the images ConfigMap —
  degrade the capability, not the daemon.
- **A Workspace provision needing an unsynced repo fails pointedly**, naming the repo and the last sync error — the
  moment the degradation actually bites is the moment it is reported, to the run that owns the consequence. The line is
  the clone (ADR-0051): a cold node whose clone fails fails the provision; a warm cache whose fetch fails lets the
  attach proceed on the objects it holds, announced as stale with git's error — the worktree's `origin` is the real
  remote, so the Agent's own `git fetch` still reaches the truth.
- **Repo sync state is observable**: it lives on each `Repo` resource's status, per node, and `j2 status` reports repos
  that are not synced with their last error — the place ADR-0047's "register the key, the cache agent retries" points
  at.

## Considered options

- **Fail-fast boot, kept.** Rejected: a boot failure is invisible except as a rollout timeout, reported to whoever
  converged, not whoever needs the repo — and it takes unrelated Workflows down with it. Fail-fast is right when serving
  would be wrong; an Orchestrator without one repo serves everything else correctly.
- **`j2 up` verifies the clone before finishing.** Rejected: registration is a human act on an external system with no
  deadline — a converge that waits on it hangs CI and re-runs teach nothing. The converge reports the window (ADR-0047);
  the cache agent closes it on its own.
