@kind
Feature: a workspace() run drives a real Sandbox on kind
  ADR-0012: a Workspace is ALWAYS a real Sandbox — there is no stubbed workspace mode — so this is
  the one tier where the data plane is real: the operator's Sandbox CR, a pod running the instance's
  own Sandbox Image with jr2's runtime injected into it (ADR-0037), the node's Repo cache mounted
  read-only (ADR-0051), a git worktree inside the pod, and the Harness endpoint the body's agent is
  admitted against.

  It is also the only tier where the AGENT is real in the way that matters (ADR-0013): the pod
  originates its own tool calls. Since ADR-0038 the pod runs the STOCK Harness — pi, the real Menu
  over MCP to the Adapter on localhost, the real Working tools — and the ONLY thing still faked is
  the model: a scripted OpenAI-compatible endpoint the World serves from the host. "The Agent calls
  X" means that model now answers with a tool call; the wire, the container boundary, the MCP
  connection and the tool call are all real. Which makes this tier a SECOND pi canary beside the
  conformance suite (ADR-0027): a pi bump can break it.

  This tier is opt-in (`@kind`, excluded from the default suite) because it needs infrastructure:
    just e2e-kind-up      # a VANILLA kind cluster; nothing is built or loaded here
    just e2e-kind
  Bring-up is the product's own path (ADR-0010/0019/0038): each scenario runs `jr2 up` into a fresh
  namespace of the shared cluster, and that converge builds and loads every image it deploys —
  Harness, Adapter, operator, the instance, and the instance's own images (`images/default`, and
  `images/user` for the one workflow that seats a human). Nothing is instance-bound to the cluster
  itself.

  Rule: the wrapper provisions a real Sandbox, attaches the worktree, and destroys it on final

    Scenario: the body works in a real worktree, and its Sandbox is reaped when it finishes
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's body settled as "finished"
      And the run's Sandbox is destroyed

  Rule: a per-run Repo passes the credentials fence or is refused
    ADR-0051. A bound slot is code the instance typechecked and deployed; a PER-RUN slot is a
    mapper over the door, so its url is run input — a ticket field — and otherwise a way to spend
    the cluster's credential against any host. `git.credentials` is the fence: the kind instance
    admits the seed's host by prefix and nothing else, so the same workflow either provisions a
    Sandbox whose node cache holds the Repo or faults at attach naming the list.

    Scenario: a url no git.credentials entry admits is refused at attach, naming the fence
      Given the kind instance is serving
      When I start the "perrun" workflow with repo "https://github.com/nobody/x.git" detached
      Then the run faults mentioning "git.credentials"
      And no Sandbox was re-provisioned for the run

    Scenario: an admitted url is cloned onto the node the Sandbox lands on, and jr2 status says so
      Given the kind instance is serving
      When I start the "perrun" workflow with repo "http://seed.jr2-e2e-seed.svc/app.git" detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      # The cache agent's own account, read the way a human reads it — the Sandbox went Ready only
      # once the Repo was present and fetched on its node (ADR-0048/0051).
      And jr2 status reports repo "http://seed.jr2-e2e-seed.svc/app.git" present on the node

  Rule: a fetch inside the pod reaches the remote's now
    ADR-0053. `origin`'s fetch url is a COMMAND, not a path: git runs the program on the runtime
    volume, which asks the Adapter on localhost, waits for the landing, and only then execs
    `git upload-pack` against the node cache. So the ask crosses a loopback route, a Sandbox-token
    route, an annotation on the CR, the operator's copy of it onto the pod, a DaemonSet, and a real
    remote — and every one of those is real only here. What it buys is the case the grill took: a
    human pushes a fix, and the Agent's next `git fetch` has it, in seconds rather than at the
    5-minute interval or the next attach.

    The seed is WRITTEN to for the first time (steps/seed.ts), always on a branch of the pushing
    scenario's own: one repository is shared by every worker, so a scenario moves no ref another
    scenario's Sandbox has cloned.

    Scenario: a commit pushed a moment ago arrives on the next git fetch in the pod
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      When a commit is pushed to the seed on a branch of its own
      And the Harness container fetches "origin" in repo "app"
      # NO polling: one fetch returned, and the ref is already there. A cache that only refreshed
      # on its interval would answer the same fetch with the objects it happened to hold, and pass
      # a polling version of this scenario five minutes later.
      Then the pushed commit is the head of that branch in repo "app"
      And the fetch cost seconds, not the cache's refresh interval
      # The mark and the landing, read off the CR the way a human reads it: the Orchestrator wrote
      # one annotation per Repo key, and the operator's standing entry says which fetch answered it
      # — a fetch that STARTED before the ask does not (ADR-0053).
      And the Sandbox's ask for repo "http://seed.jr2-e2e-seed.svc/app.git" is answered by the fetch its status reports

    Scenario: origin fetches through the program and pushes to the remote itself
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      # What `git remote -v` shows a human: the program named by absolute path with the Repo's
      # IDENTITY as its argument — never the cache key, which is a derived directory name (ADR-0004)
      # — and, on the push line, the Binding's own spelling, unchanged. A push still goes to the
      # remote with the caller's own credential, never the Agent's (ADR-0005).
      Then origin in repo "app" fetches through the program and pushes to "http://seed.jr2-e2e-seed.svc/app.git"

    Scenario: the human's seat fetches the same way, from a read-only runtime
      Given the kind instance is serving
      # The one kind workflow that composes the third seat: a musl image with git, no jr2 knowledge,
      # and nothing injected into its process (ADR-0005).
      When I start the "seated" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      When a commit is pushed to the seed on a branch of its own
      # The fetch url lives in the SHARED `default/.git/config`, so this seat runs the same program
      # the Agent's does — a static binary, because the libc here is not jr2's (ADR-0037) — and
      # lands the refs in the one worktree both seats mount.
      And the User Container fetches "origin" in repo "app"
      Then the pushed commit is the head of that branch in repo "app"
      And the User Container holds the program, on a read-only "/opt/jr2"

  Rule: a live Sandbox survives an orchestrator restart, and the run re-attaches to it

    Scenario: restore re-attaches to the same Sandbox at the same endpoint
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the orchestrator restarts
      # Same CR (never re-provisioned) at the same endpoint: the port-forward is derived from the
      # Sandbox name, so the endpoint persisted in the snapshot is still the one that works.
      Then the run's Sandbox is the same one, at the same endpoint
      # And the Agent still reaches its Machine: its Adapter's token outlives the process that
      # minted it, so a turn played after the restart still lands (ADR-0013).
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's Sandbox is destroyed

  Rule: a Sandbox reaped while the orchestrator is down is never silently re-provisioned

    Scenario: the restored body is told its workspace is lost
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the orchestrator stops
      And the run's Sandbox is reaped behind its back
      And the orchestrator starts again
      # The reconcile probe found the CR gone and delivered `workspace.lost` INTO the body, whose
      # policy settled it. The unpushed commits are gone; resuming would have been a lie.
      Then the run's body settled as "lost"
      And no Sandbox was re-provisioned for the run

  Rule: the Agent's only control-plane peer is the Adapter on localhost
    ADR-0013. The Agent reaches its Machine through a process it can talk to but whose credential
    it cannot read. Nothing else in the pod can deliver — which is what makes "the Agent never
    steers the workflow" enforced rather than advertised.

    Scenario: the tool call originates inside the pod and drives the Machine
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox runs the Adapter beside the Harness
      # The pod dialed out and listed its Menu over MCP before the model ever spoke — visible here
      # as the tool set the Harness put on the provider request (ADR-0015/0028/0029).
      And the model was offered "finish" from the Menu and its Working tools
      # The pod dials out; the host dials nothing. Its Harness was served this state's menu and
      # called from it — and the Machine moved.
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's body settled as "finished"

    Scenario: the Harness container cannot deliver to the Orchestrator itself
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      # Working tools give the Agent code execution in the Harness container, which shares the
      # pod's network namespace — so it CAN reach the Orchestrator, address and all. It simply has
      # no credential: the Sandbox token is delivered into the Adapter container only.
      When the Harness container posts "finish" straight to the Orchestrator
      Then the delivery is refused as unauthorized
      And the run has not settled

  Rule: an Agent's turn ends when the state that asked for it stops waiting
    ADR-0024. Leaving an Agent invoke means "I am no longer interested in this answer", so the
    submission behind it is ended — at the Harness, which is the only place that end is observable
    (the Orchestrator is already gone by then, by construction). The `handoff` workflow parks
    WITHOUT settling, so the Workspace survives the whole scenario: that is the shape where an
    un-ended turn would still be a live writer in the worktree the Machine believes is idle.

    Scenario: the pick that moves the Machine ends the turn behind it, and the next turn survives
      Given the kind instance is serving
      When I start the "handoff" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's body is in "coding"
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's body is in "shipping"
      # ONE submission per state: the script rides the provider now, not a second submission, and
      # the Harness queues per conversation in admission order (ADR-0027). The turn `coding` asked
      # for is over on the pod — not merely forgotten by the Orchestrator — and its model is still
      # parked mid-turn, which is the shape an abort has to be able to end.
      And the Harness reports 1 of the Agent's turns settled as "aborted"
      # …and the turn `shipping` asked for is NOT among them, on the SAME instance id. The abort was
      # ordered ahead of it, so it never settled work that had not run.
      When the Agent in the Sandbox calls "ship" with summary "ok"
      Then the run's body is in "parked"
      And the Harness reports 2 of the Agent's turns settled as "aborted"
      And the run's Sandbox is still there

  Rule: a write from the review worktree cannot reach the branch or the coder's worktree
    ADR-0028. The tool layer (`workspace: "read"`) states intent and stops the honest path; the
    detached review worktree is the containment. It sits beside the branch worktree at the sha
    under review with a DETACHED HEAD, so a rogue write cannot move the branch and a rogue commit
    lands on a detached HEAD — it evaporates with the checkout.

    Scenario: a write probe and a commit from the review worktree leave the branch untouched
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      # The same idempotent lines attachScript emits (ADR-0028), played in the pod. The Workspace
      # -port verb that requests this per review round is a later, workflow-driven change; what
      # this scenario pins is the containment property those lines buy.
      When a detached review worktree is attached for repo "app" at the head of branch "feat-e2e"
      And the review worktree gets a write probe and a commit
      Then the branch ref of repo "app" branch "feat-e2e" is unmoved
      And the coder's worktree for repo "app" branch "feat-e2e" is untouched

  Rule: jr2 mounts its runtime into the user's image, and the floor holds inside the pod
    ADR-0037. A Sandbox Image is the user's Dockerfile — zero jr2 knowledge, any base — run
    byte-for-byte: an init container publishes /opt/jr2 onto a volume the primary container mounts,
    and only the container's COMMAND is overridden. So the floor is a composition, not a build, and
    every line of it is a SILENT failure when wrong: it surfaces inside a turn, as a tool error the
    model has to interpret. Only a real pod can prove the pieces met.

    Scenario: the mounted runtime gives the pod git, a home, node, rg, and an APPENDED PATH
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the Harness container satisfies the injection contracts

  Rule: exec into the Harness container lands in the image's own environment
    ADR-0037/0005. `kubectl exec -c harness` gives a human the agent's tools, worktrees, and
    filesystem — and, because jr2 overrides the command and NOTHING else, the environment the
    image's author built: its own WORKDIR, its own tools. images/default puts WORKDIR at
    /srv/jr2-e2e precisely because the retired wrap forced /work, so landing there is proof jr2 built
    no stage on top of this image.

    Scenario: a human execs in, lands in the image's own WORKDIR, and has the image's own tools
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      And a human's shell in the Sandbox lands in "/srv/jr2-e2e" with the image's own toolchain

  Rule: a repo tree is group-writable for the work group, whatever the writer's umask
    ADR-0005. The attach stamps a default ACL on each repo root before the clone fills it, and
    POSIX ignores the process umask where a default ACL exists — so cross-uid sharing on /work
    needs zero umask lines in any image: no login-shell discipline in a User Container, nothing.
    Only a real pod can prove it: ACL inheritance is filesystem physics, invisible to every
    socket-free test.

    Scenario: a file created under a hostile umask still lands group-writable
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      And a file created under umask 077 in repo "app" branch "feat-e2e" is group-writable

  Rule: the sweep takes a node image no live root names, and leaves the ones a root does
    ADR-0039. Reachability is decided from Kubernetes, but the removal happens in a node's
    containerd — the one store no socket-free test can hold. Its physics are why: CRI cannot untag,
    a `kind load`ed image is held under an `import-<date>@<digest>` ref CRI never reports, and
    `crictl rmi` exits 0 either way. So "the sweep removed it" is only checkable on a real node, by
    asking containerd itself what it still holds afterwards.

    Scenario: jr2 gc takes the unreachable image off every node and keeps what this instance runs
      Given the kind instance is serving
      # Labeled like an image `jr2 up` built and then replaced — the iteration garbage the sweep
      # exists for — but named by no image map, Sandbox, or pod, on this instance or any other.
      And a labeled image no live root names is loaded onto every node
      When I sweep the cluster's images
      Then no node holds the unreachable image any more
      And every node still holds the images this instance's map names

  Rule: the Agent's Working tools reach the Sandbox Image's own toolchain
    ADR-0027/0037. Working tools execute in the Harness container, and that container runs the
    Sandbox Image itself with jr2's runtime mounted beside it — which is the entire feature: what an
    Agent can DO stops being bounded by whatever the stock image happened to carry. `jr2-toolchain`
    exists only in this instance's `images/default/Dockerfile`.

    Scenario: a bash Working tool runs a binary only images/default carries
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      When the Agent runs "jr2-toolchain" through its bash Working tool
      Then the model was shown the tool result "jr2-toolchain-ok"

  Rule: a Menu-only Agent's Turn runs on the Instance Harness, and needs no Sandbox
    ADR-0031. An Agent whose definition declares `workspace: "none"` (ADR-0028) has no worktree to
    run in, so `jr2 up` converges an Instance Harness — a Harness + Adapter pod with no Workspace —
    whenever a registered Machine carries such a definition, and the Turn is admitted THERE. No
    config names or enables it: the kind instance's `advisor` definition is the whole reason the
    Deployment exists in every scenario's namespace. Placement is definition-wins: even invoked
    inside a `workspace()`, the advisor's conversation lives on the Instance Harness and never on
    the run's Sandbox, because a conversation is an Instance ID on ONE server.

    Scenario: a workflow with no Workspace runs its Agent on the Instance Harness
      Given the kind instance is serving
      When I start the "advised" workflow detached
      Then the model was offered "advise" from the Menu and no Working tools
      And the Instance Harness holds the "advisor" conversation of the run
      When the model answers "advise" with summary "ship it"
      Then the run's status shows "done"
      And no Sandbox was provisioned for the run

    Scenario: inside a Workspace, the Menu-only Agent still runs on the Instance Harness
      Given the kind instance is serving
      When I start the "consulted" workflow detached
      Then the run's Sandbox becomes Ready
      And the model was offered "advise" from the Menu and no Working tools
      And the Instance Harness holds the "advisor" conversation of the run
      And the run's Sandbox holds no "advisor" conversation
      When the model answers "advise" with summary "keep it small"
      And the Agent in the Sandbox calls "finish" with summary "done"
      Then the run's body settled as "finished"
      And the run's Sandbox is destroyed

  Rule: a Repo that cannot sync degrades the instance, never the boot
    ADR-0048. The Orchestrator states its bound Repos at boot and never syncs them; the cache agent
    does, retries a failure with backoff, and writes git's own words to the resource. The kind
    instance binds one url its fence admits and nothing serves (`unsynced`), so EVERY scenario's
    boot carries a Repo that fails its probe — and serves anyway: that is the claim, and the rest
    of this file passing is its evidence. `jr2 status` names the Repo with the error, and the one
    run that needs the cache faults at provision naming both, while no other run is held on it.

    Scenario: the instance serves, status names git's error, and the run that needs the Repo faults by name
      Given the kind instance is serving
      Then jr2 status reports repo "http://seed.jr2-e2e-seed.svc/missing.git" absent with git's error
      When I start the "unsynced" workflow detached
      Then the run faults naming repo "http://seed.jr2-e2e-seed.svc/missing.git" and git's error

  Rule: the Repo sweep takes a Repo nothing binds and no run attached lately, resource and node copy both
    ADR-0051. Eviction is reachability plus age: `jr2 gc --repo-ttl` deletes a `Repo` resource no
    registered Machine binds and no run has attached within the TTL, and that deletion is what
    lets each node's cache agent remove its bare clone once nothing there mounts it. A per-run
    Repo is the one on that clock — a bound one (`app.git`, in every namespace) never is. The
    other seed repository is named so the per-run identity is one no Machine binds; the same
    url spelled differently would be the bound Repo.

    Scenario: a per-run Repo outlives its run until the sweep, and the sweep clears it off the node
      Given the kind instance is serving
      When I start the "perrun" workflow with repo "http://seed.jr2-e2e-seed.svc/other.git" detached
      Then the run's Sandbox becomes Ready
      And jr2 status reports repo "http://seed.jr2-e2e-seed.svc/other.git" present on the node
      When the Agent in the Sandbox calls "finish" with summary "done"
      Then the run's body settled as "finished"
      And the run's Sandbox is destroyed
      And a node still holds the cache of repo "http://seed.jr2-e2e-seed.svc/other.git"
      When I sweep Repos no run attached within "1m", once repo "http://seed.jr2-e2e-seed.svc/other.git" is that old
      Then jr2 status no longer lists repo "http://seed.jr2-e2e-seed.svc/other.git"
      And jr2 status still lists repo "http://seed.jr2-e2e-seed.svc/app.git" as bound
      And no node holds the cache of repo "http://seed.jr2-e2e-seed.svc/other.git" any more

  Rule: a shipped Machine runs as a consumer registers it
    ADR-0054. `@jr2/machines` ships Machines for END USERS, and an example nobody can import is not
    a shipped Machine — so the kit packages them, and the only proof one works in jr2 is the stock
    Harness driving it in a real Sandbox. Every Machine the kit ships owns a scenario here.

    `workflows/task.ts` in this instance is the whole consumer story: `customize(task, { repos,
    agents })`, binding the two parts the package left Open — the repository it cannot know and the
    model it cannot pay for — over this tier's fixture repo and scripted model. Registering it is
    ONE line, and this Rule walks what that line bought.

    The loop is the claim. One human steers one Agent, so `request_changes` continues the SAME
    conversation rather than briefing a fresh coder — and a conversation is a fact about the
    Harness on the pod, invisible to the Orchestrator, which sees two invokes either way.

    Scenario: the kit's task Machine walks its review Gate and ends where the human says
      Given the kind instance is serving
      When I start the "task" workflow with prompt "add a --json flag to the status command" detached
      Then the run's Sandbox becomes Ready
      And the model's first turn carries the prompt "add a --json flag to the status command"
      When the Agent in the Sandbox calls "finish" with summary "added the flag"
      Then the run parks at the "review" Gate, with summary "added the flag"
      And the Gate names the branch jr2/task-<run id> and the worktree it was cut in
      And the turn behind it is over at the Harness
      When I send "request_changes" to the Gate with notes "rename the flag to --format"
      # Continuity, not merely a second request: ONE conversation holds the first prompt, the turn
      # that ended on it, and the notes. A coder briefed from scratch would derive another iid, and
      # the prompt would be nowhere on the pod.
      Then the coder's conversation carries the prompt "add a --json flag to the status command" and then the notes "rename the flag to --format"
      When the Agent in the Sandbox calls "finish" with summary "renamed it to --format"
      And I send "approve" to the Gate
      # approve reaches a final state, which is what tears the Workspace down (ADR-0012) — the
      # branch and anything unpushed on it go with the pod, as the Gate's park was the window to
      # act on them.
      Then the run's status shows "done"
      And the run's body settled as "approved"
      And the run's Sandbox is destroyed
