# An Agent's control credential lives only where no Workspace code runs

[ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md) scoped an Agent's control
credential to its Sandbox. That stops a coder in one Sandbox from delivering a pick to a reviewer in another Sandbox.
[ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md) made several Agents in one Sandbox normal:
concurrent coders in one clone, or a coder beside an independent reviewer. In one Sandbox the Sandbox scope is not
sufficient. Every Agent's `bash` is a child of the one Harness process, at the one uid, and it inherits the env of that
process. So a coder's `bash`, driven by a prompt injection, can read the Stand-in of the control credential, send
`POST /agents/<reviewer-iid>/events` through the Custodian, and approve its own review. The reviewer did nothing.

The attack does not need the coder's own `bash`. The Agents of one Workspace share a writable `/work`. Code that one
Agent writes there — a test file, a git hook, `core.fsmonitor`, a smudge filter — runs when another process runs on
`/work`: the reviewer's `bash`, its `node --test` or `git diff`, or a `command` Effect. That code then has whatever
credential its process can read. So the question is not which container holds the credential. It is which processes run
code from `/work`.

## Decision

- **The boundary.** A credential that lets a request act for an Agent lives only where no Workspace code runs.
  **Workspace code** is each process whose program or input comes from `/work`: the Working tools, tests, builds, git
  (its hooks, its filters, fsmonitor, textconv and each repository-local config) and `command` Effects. The boundary
  needs no separate container for each Agent.
- **One Harness container for each Sandbox.** It serves every workspace-ful Agent below the `workspace()`
  ([ADR-0005](0005-sandbox-pod-composition.md)). A Menu-only Agent has no Sandbox, and it runs on the Instance Harness,
  as before ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)).
- **The Harness process is trusted, and its children in `/work` are confined.** The Harness process runs jr2's code
  only. It runs the engine loop for each conversation, and it holds the control credential. Each process that it starts
  and that touches `/work` runs confined by the Effector's Landlock confiner, `effector confine` on the runtime volume
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). That is:
  - each `bash` call, and so each test, build, git hook and planted program that it runs;
  - each process of a search tool (`rg`, `grep`);
  - jr2's own git for the attach, the cut and the sync
    ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md),
    [ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)), because a smudge filter or a textconv
    in the shared `.git/config` runs in git's process;
  - each `command` Effect that is placed in the Harness, which is each `command` that names no secret.

  So the trust boundary is inside the Harness container: the Harness process on one side, its confined children on the
  other. [ADR-0077](0077-jr2-requires-landlock-on-every-sandbox-node.md) makes Landlock a requirement of jr2, so no path
  runs a child unconfined.

- **What a confined child can reach.** The Effector's rules (ADR-0068), with these paths and this env:
  - `/work`: read and write. `/repos/<key>`: read only. The image's system paths: read and execute. The child's `HOME`
    and `TMPDIR`: read and write.
  - Denied: the Stand-in files under `/run/jr2/` (the control one and each held secret's), the secret material of the
    runtime, the Harness's conversations, and each path that no rule names. A confined process cannot ptrace a process
    outside its domain, so `/proc/<harness>/environ` and `/proc/<harness>/mem` are closed.
  - Network: not restricted, as for the Effector's child. A request reaches a credential only through the Custodian
    ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)).
  - Env: explicit, never the Harness's own. It holds exactly the Stand-ins of the secrets that the `workspace()` grants
    (its `secrets` list), plus `PATH`, `HOME`, `TMPDIR`, and the proxy and CA variables that the toolchain needs
    (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and the others of ADR-0059). It never holds the control Stand-in. It holds
    the Stand-in of a model key only when the `secrets` list names that key.
- **The file tools resolve beneath `/work`.** The engine's read, write and edit tools run in the Harness process. They
  resolve each path beneath `/work`, with no escape by `..` or by a symbolic link. So a link that a child plants to
  `/proc/self/environ`, or to the file of the control Stand-in, fails. ADR-0067's opener (`beneath`) shows the method.
- **One secret control Stand-in for each Sandbox.** Only the Harness process holds it, as a file that no confined child
  can read. It is in no child's env. The Custodian puts the Sandbox's control token in its place on the control routes
  (ADR-0059), and the real token never leaves the Custodian.
- **The Harness states the slot.** On each control request, the Harness states the Agent that the conversation belongs
  to: its slot. It takes the slot from its own record of the conversation, never from the URL. The slot is the Agent's
  full identity below the run: the actor path of its Machine and its agent name, which is a continued conversation's
  Instance ID without the run id ([ADR-0057](0057-a-turn-is-its-frame-its-dials-and-whether-it-continues.md)). So two
  Agents with one key in two child Machines are two slots. The Orchestrator checks that the stated slot is the slot of
  the target registration, on the surface read, the pick, the delivery poll and the acknowledgment of a notice
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)). This check finds a routing fault. It is not
  the security boundary: the boundary is that only the Harness holds the credential.
- **Two tokens, each checked on its own routes.** This is defence in depth:
  - The **control token** is what the Custodian puts in place of the secret control Stand-in. It is valid only on the
    agent routes (`/agents/<iid>/surface`, `/agents/<iid>/events`, `/agents/<iid>/deliveries/<id>`, and the route on
    which the Harness acknowledges a notice), and it carries the stated slot.
  - The **fetch token** is what the Custodian puts in place of the public Sandbox Stand-in that `jr2-upload-pack` holds
    as a constant. It is valid only on `POST /sandboxes/<sandbox>/fetch`
    ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)). The Custodian
    accepts the public Stand-in on the fetch route only.
  - The Orchestrator accepts each token only on its own routes. A Gate accepts neither, and no other principal of an
    Agent: an Agent never reaches a Gate (ADR-0013).
- **Chart Agents and Pool workers need no provisioning.** The Agents that a Chart makes
  ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)) and each Turn of a Pool worker run in the one Harness, and
  the Harness states their slot. The provision knows nothing of the Agents of the Sandbox.

## Considered options

- **One Harness container for each agent slot, each with its own secret Stand-in.** Rejected. Kubernetes isolates one
  container from another, but all the slots share the writable `/work`. Code that one Agent plants there runs in a
  sibling's container when the sibling's `bash`, git or tests run, or when a `command` Effect runs there, and that code
  reads the credential of the container that runs it. So container isolation between Agents gives nothing against an
  attack that goes through `/work`. It also costs a container, a port, a Secret and a share of the Size for each slot,
  and it has no container for an Agent that a Chart makes at run time.
- **A trusted control container and a tools container with no credential.** Rejected. It gives the same protection as
  confinement: no Workspace code runs where the credential is. But it adds a container, it sends each tool call across a
  container edge, and it changes [ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md) (the
  Harness is one server). jr2 already confines the code that an Agent wrote in the Effector (ADR-0068). One mechanism
  serves one problem.
- **A second uid inside the Harness container**, so that `bash` runs as a uid that cannot read the credential. Rejected.
  Under `runAsNonRoot`, `allowPrivilegeEscalation: false` and `capabilities: drop ALL`, no process can `setuid` without
  `CAP_SETUID`, and under `no_new_privs` that likely also needs `allowPrivilegeEscalation: true`. It adds privilege to
  the container that runs code a model controls.
- **A user namespace**, so that the Harness maps a second uid with no host privilege. Rejected: the default seccomp
  profile (`RuntimeDefault`) blocks `unshare(CLONE_NEWUSER)` from a process with no privilege. It needs a custom seccomp
  profile and a kernel that permits it, so it is not portable to a self-hosted cluster.
- **The Custodian authenticates the caller.** Rejected alone: every process reaches the Custodian over the one pod
  loopback. The Custodian can tell the Harness from a child only by a secret that the child cannot read, which is this
  decision.
- **Keep the Sandbox-scoped credential, and call the Agents of one Workspace mutually trusting.** Rejected: a coder
  beside an independent reviewer in one Workspace is a motivating case.

## Consequences

- **No Workspace code can act as an Agent.** Planted code finds no control credential: not in its env, not in a file
  that it can read, not through the Harness's `/proc`. It cannot deliver a pick for any Agent, its own included. Only
  the Harness process delivers a pick, for the conversation whose model called the pick.
- **What remains.**
  - An Agent can still try to persuade another Agent through what that Agent reads: a file, a commit message, the output
    of a test. That is an attack on content, not a forged pick. The other Agent's model chooses each pick, and the
    Orchestrator judges it against that Turn's Allowed picks
    ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)).
  - A confined child can spend only a held secret that its `workspace()` grants. Every Stand-in but the fetch Stand-in
    is secret, and the child's env holds only the granted ones (ADR-0059). So code in `/work` reaches a model key only
    when the author grants that key.
  - Below Landlock ABI 6, a confined process can still send a signal to the Harness process, which has the same uid.
    That is a denial of service, not an impersonation. ABI 6 scopes signals to the domain, and the confiner uses it when
    the kernel offers it (ADR-0077).
- **The pod is ADR-0005's pod**: one Harness, a Custodian, and an optional User Container and Sandbox Effector. The
  count of Agents does not change it, and the Size splits as before
  ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)).
- **The Instance Harness runs no Workspace code.** A Menu-only Agent has no Working tools (ADR-0031), so the credential
  of the Instance Harness is already where no Workspace code runs.
- **Tests.** The `@kind` tier gains three cases: a coder's `bash` finds no control credential, in its env, in a file or
  through the Harness's `/proc`; code that the coder plants and the reviewer's own `bash` runs cannot deliver a pick as
  the reviewer, and the run does not settle; a second Agent runs git on its Worktree, and the step checks the output.
  The unit and conformance tests refuse the control token on the fetch route, the fetch token on an agent route, a
  stated slot that is not the registration's, and both tokens at a Gate, and they check the slot on the delivery poll.
- **The `@model` tier runs after the build.** The change alters what the Working tools can do and where a notice is
  delivered ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)), so it is a `@model`-tier change
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)).
