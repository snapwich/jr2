@kind
Feature: a workspace() run drives a real Sandbox on kind
  ADR-0012: a Workspace is ALWAYS a real Sandbox — there is no stubbed workspace mode — so this is
  the one tier where the data plane is real: the operator's Sandbox CR, a pod running the instance's
  own Sandbox Image with j2's runtime injected into it (ADR-0037), the read-only repos volume, a git
  worktree inside the pod, and the Harness endpoint the body's agent is admitted against.

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
  Bring-up is the product's own path (ADR-0010/0019/0038): each scenario runs `j2 up` into a fresh
  namespace of the shared cluster, and that converge builds and loads every image it deploys —
  Harness, Adapter, operator, the instance, and the instance's `images/default`. Nothing is
  instance-bound to the cluster itself.

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

  Rule: j2 mounts its runtime into the user's image, and the floor holds inside the pod
    ADR-0037. A Sandbox Image is the user's Dockerfile — zero j2 knowledge, any base — run
    byte-for-byte: an init container publishes /opt/j2 onto a volume the primary container mounts,
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
    filesystem — and, because j2 overrides the command and NOTHING else, the environment the
    image's author built: its own WORKDIR, its own tools. images/default puts WORKDIR at
    /srv/j2-e2e precisely because the retired wrap forced /work, so landing there is proof j2 built
    no stage on top of this image.

    Scenario: a human execs in, lands in the image's own WORKDIR, and has the image's own tools
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      And a human's shell in the Sandbox lands in "/srv/j2-e2e" with the image's own toolchain

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

    Scenario: j2 gc takes the unreachable image off every node and keeps what this instance runs
      Given the kind instance is serving
      # Labeled like an image `j2 up` built and then replaced — the iteration garbage the sweep
      # exists for — but named by no image map, Sandbox, or pod, on this instance or any other.
      And a labeled image no live root names is loaded onto every node
      When I sweep the cluster's images
      Then no node holds the unreachable image any more
      And every node still holds the images this instance's map names

  Rule: the Agent's Working tools reach the Sandbox Image's own toolchain
    ADR-0027/0037. Working tools execute in the Harness container, and that container runs the
    Sandbox Image itself with j2's runtime mounted beside it — which is the entire feature: what an
    Agent can DO stops being bounded by whatever the stock image happened to carry. `j2-toolchain`
    exists only in this instance's `images/default/Dockerfile`.

    Scenario: a bash Working tool runs a binary only images/default carries
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      When the Agent runs "j2-toolchain" through its bash Working tool
      Then the model was shown the tool result "j2-toolchain-ok"
