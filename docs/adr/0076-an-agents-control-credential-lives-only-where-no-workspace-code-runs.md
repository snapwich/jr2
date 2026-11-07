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
  (its hooks, its filters, fsmonitor, textconv and each repository-local config), `command` Effects and stdio MCP
  servers. The boundary needs no separate container for each Agent.
- **One Harness container for each Sandbox.** It serves every workspace-ful Agent below the `workspace()`
  ([ADR-0005](0005-sandbox-pod-composition.md)). A Menu-only Agent has no Sandbox, and it runs on the Instance Harness,
  as before ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)).
- **The Harness process is trusted, and every program that a model drives runs confined.** The Harness process runs
  jr2's code only. It runs the engine loop for each conversation, and it holds the control credential. Each other
  process in the Harness container runs in one Landlock domain, which the Harness is not in:
  - each `bash` call, and so each test, build, git hook and planted program that it runs;
  - each process of a search tool (`rg`, `grep`);
  - the I/O of the file tools (read, write, edit);
  - jr2's own git for the attach, the cut and the sync
    ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md),
    [ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)), because a smudge filter or a textconv
    in the shared `.git/config` runs in git's process;
  - each `command` Effect that is placed in the Harness, which is each `command` that names no secret;
  - each stdio MCP server of an Agent
    ([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)),
    which the Harness starts through the spawner, never with its MCP client's own spawn.

  So the trust boundary is inside the Harness container: the Harness process on one side, the domain on the other.
  [ADR-0077](0077-jr2-requires-landlock-on-every-sandbox-node.md) makes Landlock a requirement of jr2, so no path runs a
  program unconfined.

- **One spawner makes the domain.** At its start, the Harness starts the **spawner**, `effector spawner` on the runtime
  volume ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)), confined once. The spawner
  starts each process that the Harness asks for, and it does each file tool's I/O and each read, list and remove of a
  path that the Harness needs in the Agent's files (the sync's git folders and its bundle). It sends back the output,
  the exit status, the file's bytes and the names in a folder. A process inherits its parent's domain, so every program
  of every Agent of the Sandbox is in the one domain. They see, signal and trace each other, as one user's processes do
  on a machine: a later `bash` call can `kill` or `lsof` a server that an earlier call started. The tools that the model
  calls do not change: `bash` takes a command, and `read`, `write` and `edit` take a path. If the spawner stops, the
  Harness starts it again, with the same rules. The new spawner makes a new domain, a sibling of the old one, and the
  processes that the old spawner started run on in the old domain. A process of the new domain cannot trace one of the
  old domain, or read its `/proc/<pid>/environ` or its open files. Below ABI 6 it can still signal it, so a later `bash`
  call can end a server from before the restart; at ABI 6 or later it cannot. The confiner never follows a symbolic link
  to find what a rule allows: a link gets no rule (what it names gets its own rule where it is allowed, and the kernel
  checks the path that a link resolves to), and the confiner refuses to start when a rule's path has a link on it. A
  rule on a link would allow what the link names at each restart, and a confined process can change that.
- **A person's shell is a process of the domain.** `jr2 workspace shell`
  ([ADR-0009](0009-cli-and-instance-interface.md)) is `kubectl exec -c harness` of a small client in `/opt/jr2`, which
  starts as the Harness starts (`effector nocore --harness-env`). The client starts nothing itself. It asks the Harness,
  on a Unix socket in `/run/jr2/shell`, for the shell or for the one command after `--`, and the Harness asks the
  spawner. So the shell is in the one domain, with the domain's env (the Stand-ins that the Workspace grants), its umask
  and git identity, and the Workspace's cwd. It sees, signals and traces the Agents' processes, as a later `bash` call
  does: a person can stop a dev server that an Agent left. With a terminal, the spawner opens a pseudo-terminal for the
  shell, as its controlling terminal in a session of its own. The client sends the keys, the terminal's size and the
  hang-up, and the spawner closes the terminal when the shell exits. The output has flow control: while the socket to
  the client is full, the Harness pauses the spawn, and the spawner reads none of its output until the resume. So the
  terminal fills and the shell's writes block, as on a slow terminal, and a fast shell does not fill the memory of the
  Harness that serves the Agents' Turns. `/run/jr2/shell` is an emptyDir of the Harness container alone, and the domain
  can make no file under `/run/jr2`, so no process of the domain listens in the Harness's place. A process of the domain
  can connect to the socket, because Landlock does not control a connect. So the client proves that it is not one: its
  first frame carries a digest of the control Stand-in, which it reads from the file and which the domain cannot read.
  The Stand-in itself never goes on the socket. Without the proof, the Harness starts nothing.
- **The domain can do what the container's uid can do, except reach jr2's secrets.** The rules give every right on every
  path, with one exception: `/run/jr2`. There the domain can list the names in each folder, and do nothing else, except
  read the files in `/run/jr2/output` (below). Landlock only narrows the Unix permissions, so a confined program can do
  everything that the uid can do without Landlock, except:
  - reach the contents of `/run/jr2`: read, write, truncate, make, remove, move or link a file or a folder there.
    `/run/jr2` holds the control Stand-in, each held secret's Stand-in, the folder of the Custodian's control socket,
    the folder of the shell's socket, the Harness's conversations, and the Harness's output folder. Every path that jr2
    holds for the Harness alone is under `/run/jr2`. Landlock allows a path only by its rules, so the confiner allows
    every sibling of `/run/jr2` and of each folder above it, one level at a time. It also gives the root the right to
    list names on its whole tree, so `ls /`, `ls /run` and `find /` work as they do outside jr2. That right lists the
    names under `/run/jr2` too: a held secret's name, a conversation's file name. These names are not secrets.
  - trace the Harness process, or read its `/proc/<pid>/environ` or `/proc/<pid>/mem`. A confined process cannot ptrace
    a process outside its domain.
  - at Landlock ABI 6 or later, connect to an abstract Unix socket that a process outside the domain made. The
    containers of the pod share one network namespace, so this keeps the domain off the abstract sockets of the Harness
    and of the Custodian.

  Landlock does not limit a connect to a named Unix socket. So a confined program can connect to the Custodian's control
  socket. There the Custodian is the guard: it refuses a request that does not carry the secret control Stand-in, and
  the fetch Stand-in, which every confined program holds, is valid only on the fetch route. Each listener answers 404 to
  the other's routes, so the fetch Stand-in gets nothing on the control socket.

  The kernel, not the rules, keeps what other pods share. The Repo caches under `/repos`, the runtime under `/opt/jr2`
  and the CA bundles are mounted read-only, and the pod mounts no ServiceAccount token. The domain does not limit the
  network. A request reaches a held credential only through the Custodian
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)).

- **No Harness pod reaches a cloud metadata address.** Where the metadata service of a node answers pods, it gives the
  node's cloud credential, which no `workspace()` grants. The Custodian's dial guard (ADR-0059) applies only to a
  request that goes through the Custodian, and a program of the Agent can connect directly. So `jr2 up` converges an
  egress NetworkPolicy for each Harness pod: `jr2-sandbox-egress` selects each Sandbox pod,
  `jr2-instance-harness-egress` selects the Instance Harness, and each check pod of the provider preflight gets one of
  its own, before the pod. Each policy allows all egress except `169.254.169.254/32`, `fd00:ec2::254/128`,
  `169.254.170.2/32`, `169.254.170.23/32` and `100.100.100.200/32`: the metadata service of AWS, GCP and Azure, the
  credential agents of ECS and EKS Pod Identity, and the metadata service of Alibaba Cloud.
  - NetworkPolicy has no deny rule. So the rule allows `0.0.0.0/0` and `::/0`, each with its addresses as `except`, and
    it also allows every pod of the cluster (`namespaceSelector: {}`).
  - The Instance Harness and the check pod run no Workspace code. They get the policy because the check pod stands for
    every Harness pod ([ADR-0019](0019-one-converging-command-against-the-current-context.md)): a model that only the
    node's credential reaches must fail the check, not a Turn.
  - The block has two limits. The list is not complete for every cloud provider, and only a CNI that enforces
    NetworkPolicy applies it. So the shared-cluster guide tells the admin to check the metadata address of their
    provider, and to give pods no node credential: Workload Identity, or IMDSv2 with a hop limit of 1.

- **The env of the domain is the container's own env, with the granted Stand-ins.** A program in the domain gets the env
  that the container started with: the image's `ENV`, `harness.env` and `envFrom`, the proxy and CA variables. jr2's own
  `JR2_*` names are removed, except `JR2_CUSTODIAN_URL`. It also gets `HOME`, `TMPDIR`, and the Stand-ins of the secrets
  that the `workspace()` grants (its `secrets` list), each under its own name. It never gets what the Harness process
  added to its own env after the start, and so it never gets the control Stand-in, or the Stand-in of a model key that
  the `secrets` list does not name. A toolchain and a bring-your-own image work as they work outside jr2.
- **The Harness process runs with jr2's env alone.** node, glibc and OpenSSL read names from the env that load code or
  configuration from a path: `NODE_OPTIONS=--require /app/x.js`, `LD_PRELOAD`, `OPENSSL_CONF`. The image's `ENV` can
  name a file that the domain writes. So the Harness starts as `effector nocore --harness-env -- node …`. The effector
  and tini are static binaries, so no `LD_*` name changes them. Before it starts node, the effector:
  - gives node only the names that jr2 composed for the container: each name of its `env`, which the Orchestrator lists
    in `JR2_HARNESS_ENV_NAMES`, and each key of its `envFrom`, to which the Orchestrator gives the prefix
    `JR2_ENVFROM_`. The image's `ENV` can also hold a name with that prefix, and node then gets it. The marks keep out a
    name that an image sets by accident, not one that its author sets to attack: the image's author already controls the
    Harness process through the image's glibc
    ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)).
  - stops, and starts nothing, on an `envFrom` key that starts with `JR2_`. jr2's own names, such as `JR2_MENU_ONLY`,
    which turns the domain off, come from the container's `env` alone, so a shared Secret cannot set one. `jr2 up`
    refuses a `JR2_` name in `harness.env`, and a `JR2_` key of a Secret or a ConfigMap that `harness.envFrom` loads.
  - removes from them each name that loads code or configuration from a path, or writes to one: every `LD_*` and
    `MALLOC_*` name, `NODE_OPTIONS`, `NODE_PATH`, `NODE_COMPILE_CACHE`, `OPENSSL_CONF`, `GCONV_PATH` and the others of
    its list, and a `TZ` that names a file.
  - gives node `HOME=/run/jr2/home`, whatever the start env holds. node reads `HOME` once, at its start, into the
    folders where a bare `require()` looks last: `$HOME/.node_modules` and `$HOME/.node_libraries`. A provider module
    that pi-ai loads on its first Turn can miss in `node_modules` and fall through to them. So a Harness process with a
    `HOME` that the domain writes runs a module that the domain put there.
  - puts the container's whole start env, each `envFrom` key under its own name, in `JR2_START_ENV`, as base64. The
    domain's env is made from it, so the image's `ENV` and the container's `HOME` reach each program of the domain. No
    program reads that name. A `JR2_START_ENV` that the start env already holds is dropped. Without
    `JR2_HARNESS_ENV_NAMES` the effector starts nothing.

  At its start, before it loads any other module, the Harness refuses to run when a folder where node looks for a module
  is outside `/opt/jr2` and `/run/jr2`, and it checks that its `HOME` is `/run/jr2/home`. One folder is trusted where it
  is: node's own `<prefix>/lib/node`, beside node's binary, because a process that can write there can also replace
  node. In a pod it is `/opt/jr2/lib/node`. A change of `HOME` after node started is too late, so the Harness never
  makes one.

  A name of jr2's env that names a credential file which the Harness process reads (`AWS_CONFIG_FILE`,
  `GOOGLE_APPLICATION_CREDENTIALS`, and the others) is the admin's choice. `jr2 up` refuses such a path in a folder that
  the domain writes in every pod (`/work`, `/tmp`, `/dev/shm`, `/home/jr2`), and warns on any other path: whether the
  Sandbox's uid can write a folder of the image is the image's, and jr2 cannot read it.

- **The file tools reach what `bash` reaches.** Their I/O runs in the spawner, so the kernel applies the domain's rules
  to them. A path under `/run/jr2`, or a symbolic link to one, fails with the error that an unreadable file gives:
  Landlock does not stop `stat`, so pi's check that a file is there passes, and the open fails
  (`EACCES: permission denied, open '<path>'`). `~` in a path is the domain's `HOME`, as it is for `bash`: pi expands
  `~` to the `HOME` of the process that runs it, which is the Harness's, so jr2 expands it first.
- **The project context is read in the domain.** pi-coding-agent's `loadProjectContextFiles` and `loadSkills` read an
  Agent's `AGENTS.md`, `CLAUDE.md` and skills in the process that calls them
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)). So the Harness runs them in a child that the
  spawner starts, with the module check above as its first import and `HOME=/run/jr2/home` as its whole env. The child
  writes one line of JSON, and the Harness reads it as untrusted data, at most 256 KiB. An `AGENTS.md` that links to a
  file under `/run/jr2` fails at the open, in the domain, and pi goes on to the next name. When the Sandbox Image's user
  has a context folder (`~/.pi/agent`, ADR-0062), the child is confined further: `effector confine`, run in the domain,
  adds rules that deny that folder except the names that pi's loaders read there (its context file and `skills/`), each
  only to read. Landlock adds a ruleset to the domain's, so the child keeps no right that the domain does not have. A
  name that is a symbolic link gets no rule, so a read through it is a read of the path that it names: a link to
  `auth.json` fails. The Harness computes these rules at each load, and a link that appears on a ruled path before the
  confiner opens it stops the child (ELOOP): no project context, and one line in the pod log.
- **The Harness process touches no path that the domain can write.** Each path in the Agent's files that the Harness
  reads, lists or removes goes through the spawner. pi's Working tools look at a path in the Harness process: `read`
  tries the variants of a name with `access`, and `write` and `edit` order their calls by the `realpath` of the file.
  These tell only whether a name is there and where a link points, which `stat` in the domain tells too, and they read
  no content. The file that holds the full output of a `bash` call is the Harness's own. pi's `bash` makes it in the
  Harness process's `TMPDIR` and opens it by its path again to read it, so the Harness's `TMPDIR` is `/run/jr2/output`:
  an emptyDir of the Harness container alone, where the domain reads a file and writes, makes, removes, moves and links
  nothing. So no command can put a link or a FIFO in the place of that file. The model reads the file by the path in the
  result, with `read` or `bash`. A Harness without that folder refuses to serve. The domain keeps the `TMPDIR` that the
  container started with, so an image's own `TMPDIR` works as it works outside jr2. The Harness process has its own
  `HOME`, `/run/jr2/home`, from its start (above), which does not exist and which no process can make, because code in
  the Harness process reads files under `HOME`: node looks for modules in `~/.node_modules`, the AWS SDK reads
  `~/.aws/config`, which can name a `credential_process` to run, and Google's library reads `~/.config/gcloud`. The
  domain keeps the Workspace's `HOME`.
- **One secret control Stand-in for each Sandbox.** Only the Harness process holds it, as a file under `/run/jr2`. It is
  in no env of the domain. The Custodian puts the Sandbox's control token in its place on the control routes (ADR-0059),
  and the real token never leaves the Custodian.
- **The control routes are a Unix socket under `/run/jr2`.** The Harness sends each control request to the Custodian's
  control socket, not to a loopback port. A confined program cannot make a socket under `/run/jr2`, so it cannot take
  the control listener's place while the Custodian restarts, and it cannot receive the control Stand-in. It can connect
  to the socket, and the Custodian refuses what it sends (above). The fetch route stays on loopback, because its
  Stand-in is public.
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
    agent routes (`/agents/<iid>/surface`, `/agents/<iid>/events`, `/agents/<iid>/deliveries/<id>`, the route on which
    the Harness acknowledges a notice, and `/agents/<iid>/conversation`, on which it sends the entries of the
    conversation, [ADR-0023](0023-the-harness-prints-the-conversation.md)), and it carries the stated slot.
  - The **fetch token** is what the Custodian puts in place of the public Sandbox Stand-in that `jr2-upload-pack` holds
    as a constant. It is valid only on `POST /sandboxes/<sandbox>/fetch`
    ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)). The Custodian
    accepts the public Stand-in on the fetch route only.
  - The Orchestrator accepts each token only on its own routes. A Gate accepts neither, and no other principal of an
    Agent: an Agent never reaches a Gate (ADR-0013).
- **An engine runs its loop in the Harness process.** pi does: its loop is in the Harness process, and only its tools
  run in the domain. Each engine adapter states where its loop runs, and `engine.ts` refuses an adapter whose engine
  runs in the domain. Every process of the one domain can see, trace and signal every other one, so another Agent's code
  could write such an engine's stdin, read its environ and forge its Menu calls.
- **An engine with its own process, such as Claude Code, needs a domain for each Agent first.** The root domain then
  holds only the spawner, which no process can trace or read (`PR_SET_DUMPABLE 0`). For each conversation, the spawner
  starts a sub-spawner one Landlock layer deeper, with a socket pair as its stdio and as the subreaper
  (`PR_SET_CHILD_SUBREAPER`) of what it starts. Every process of that Agent comes from its sub-spawner: the engine, its
  `bash` and its git. Landlock denies a process of one nested domain the `/proc/<pid>/fd` and the environ of a process
  in a sibling domain, so an Agent's code cannot drive another Agent's engine. They still share `/work`. Such an engine
  also needs these, as mechanisms:
  - **Authority stays in the Harness.** The engine holds no token in its env, its argv or a file. The Harness knows the
    engine by the socket that it gave it. The Harness accepts a Menu call only when it matches a tool call of a model
    answer that the Harness relayed, and only the first pick of that answer
    ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)). The Turn's safety hooks become decisions
    of the relay and of the Menu server.
  - **The model endpoint is not a proxy.** It sets the path, the model and the Dials, and refuses every other API of the
    provider (files, batches, fine-tuning). It counts the usage into the Settlement, and it refuses a request outside a
    Turn. The context of each request comes from jr2's record: the engine's own session file is a cache that jr2 does
    not trust. It is never on the Harness's wire port.
  - **Spawns go through the spawner.** An adapter starts its engine through the spawner, with the domain's env, never
    with the Harness process's env.
  - **No such engine on the Instance Harness.** The Instance Harness has no domain, and its control Stand-in is valid
    for each Menu-only Agent of the Instance. A Menu-only Agent's engine runs its loop in the Harness process
    ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)).
- **Chart Agents and Pool workers need no provisioning.** The Agents that a Chart makes
  ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)) and each Turn of a Pool worker run in the one Harness, and
  the Harness states their slot. The provision knows nothing of the Agents of the Sandbox.

## Considered options

- **A raw `kubectl exec -c harness` shell (the old `jr2 ssh`).** Rejected: it runs outside the Landlock domain and can
  read `/run/jr2`, so a person's shell, and any code that the person runs in it, reaches the control Stand-in.
  `jr2 workspace shell` is a process of the spawner's domain ([ADR-0009](0009-cli-and-instance-interface.md)).
- **A person's shell in a sibling domain with the same rules**, which the client makes again with the confiner, so the
  spawner needs no pseudo-terminal and the Harness needs no socket. Rejected: the shell reaches what an Agent's `bash`
  reaches and nothing more, but it is not in the Agents' domain. It cannot trace their processes, and at ABI 6 or later
  it cannot signal them, so a person cannot stop a runaway dev server, which is a usual reason to open a shell.
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
- **No right to list `/` and the folders above `/run/jr2`.** Rejected. `ls /`, `ls /run`, `find /` and a glob such as
  `/*` then fail, which stops normal work. Landlock can only add rights, and a right on a folder holds on its whole
  tree, so a right to list `/` also lists `/run/jr2`. The names there are not secrets.
- **The Harness process inherits the image's env.** Rejected: the image's `ENV` can hold
  `NODE_OPTIONS=--require /app/x.js`, and `/app` can be a folder that the Sandbox's uid owns. Workspace code writes
  `/app/x.js`, ends the Harness (below ABI 6 a signal can), and the restarted Harness runs that file with the control
  Stand-in in its memory. A deny-list alone on the image's env is not sufficient: the next name that loads code is not
  on it.
- **The Harness process keeps the domain's `HOME`, or takes its own after node starts.** Rejected: the domain writes
  that folder, and code in the Harness process reads files there. A planted `~/.aws/config` with a `credential_process`
  would run a program outside the domain. node reads `HOME` once, at its start: a module planted in
  `$HOME/.node_modules` or `$HOME/.node_libraries` would run in the Harness process, as one named by `NODE_OPTIONS` or
  `NODE_PATH` would. So the Harness gets its `HOME` when it is started.
- **Rules that allow only `/work`, `HOME`, `TMPDIR` and the system paths.** Rejected. It stops what an Agent does on a
  machine: a write to a folder of the image that the uid owns (`/app`, a virtualenv, `/usr/local`), a read of `/var` or
  `/srv`, a write to `/proc/self/oom_score_adj`. A bring-your-own image breaks in ways that its author cannot see. The
  secrets are under one path, so a rule that denies that path is sufficient.
- **A new domain for each process that the Harness starts.** Rejected. Each `bash` call is then its own domain, so a
  later call cannot signal, trace or `lsof` the server that an earlier call started. That is normal behaviour for an
  Agent.
- **One spawner for each conversation, today.** Rejected while every engine runs its loop in the Harness process. Then
  an Agent's processes hold nothing that another Agent's code can use to act as that Agent: the credential and the loop
  are in the Harness, and each process gets the one env of the Sandbox. Through `/work`, one Agent can only try to
  persuade another Agent's model. The separation costs a process and a layer for each conversation. It is the path for
  an engine with its own process (above): there, a sibling in the one domain forges the engine's Menu calls at once.
- **The file tools do their I/O in the Harness, with a check of the path.** Rejected. It puts the rule in two places,
  the kernel and jr2's code, and the check in code must handle each symbolic link and each race.
- **The full output of a `bash` call in the domain's `TMPDIR`, with a check after the command.** Rejected. pi's `bash`
  opens the file by its path again after the command ends, and a process that the command left running can put a link to
  `/dev/zero` or a FIFO in its place between the check and that open. The Harness then reads without end, or waits for
  ever. It also needs the Harness's `TMPDIR` to be the domain's, so a Sandbox Image with its own `TMPDIR` cannot serve.
  A folder that the domain only reads closes both.
- **The control routes on a loopback port.** Rejected. A confined program can bind `127.0.0.1:<port>` while the
  Custodian restarts, and it then receives the secret control Stand-in on the Harness's next request.
- **The Custodian authenticates the caller.** Rejected alone: every process reaches the Custodian over the one pod
  loopback. The Custodian can tell the Harness from a child only by a secret that the child cannot read, which is this
  decision.
- **Keep the Sandbox-scoped credential, and call the Agents of one Workspace mutually trusting.** Rejected: a coder
  beside an independent reviewer in one Workspace is a motivating case.
- **Refuse all of `169.254.0.0/16` at the egress.** Rejected: NodeLocal DNSCache answers on `169.254.20.10`, so the pods
  of a cluster that runs it lose DNS.
- **An egress policy with `ipBlock` peers only.** Rejected: a CNI that applies an `ipBlock` to the address of a pod
  (Cilium) then cuts DNS, the Orchestrator and each Service. So the rule also allows every pod of the cluster.
- **The egress policy on the Sandbox pods only.** Rejected: the check pod of the provider preflight stands for every
  Harness pod. Without the policy there, a model that only the node's credential reaches passes the check and fails in a
  Turn.

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
  - Below Landlock ABI 6, a confined process can still send a signal to the Harness process, which has the same uid. So
    the Harness starts with no core file (`effector nocore`, a core limit of zero), and with Node's `--disable-sigusr1`.
    Without them, a dumping signal writes the Harness's memory, with its Stand-ins, to a file in its working folder, and
    SIGUSR1 opens Node's inspector on the pod loopback, which runs the child's code in the Harness. What a signal can
    still do is stop or end the Harness. That is a denial of service in the Agent's own Sandbox, not an impersonation.
    The Harness names its process `jr2-harness`, so an Agent's `pkill node` does not end it by accident. ABI 6 scopes
    signals and abstract Unix sockets to the domain, and the confiner uses both scopes when the kernel offers them
    (ADR-0077): the Harness is then outside each signal from the domain.
  - The domain can connect to the Custodian's control socket. The Custodian refuses each request that does not carry the
    control Stand-in, which no process of the domain holds.
  - The domain can see that a path under `/run/jr2` exists, by its name or by `stat`, and its size. It cannot read what
    is in it.
  - The node's cloud credential is closed only at the metadata addresses that jr2 knows, and only on a CNI that enforces
    NetworkPolicy (the decision above).
- **The pod is ADR-0005's pod**: one Harness, a Custodian, and an optional User Container and Sandbox Effector. The
  count of Agents does not change it, and the Size splits as before
  ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)).
- **The Instance Harness runs no Workspace code.** A Menu-only Agent has no Working tools (ADR-0031), so the credential
  of the Instance Harness is already where no Workspace code runs.
- **Tests.** The `@kind` tier proves the boundary from the model's own `bash`: it finds no Stand-in of the pod in its
  env, in a file or through the Harness's `/proc`; a test that the coder plants and the reviewer's own `node --test`
  runs cannot deliver a pick as the reviewer, and the run does not settle; a granted held secret works, and no model key
  is in the env; a second Agent runs git on its Worktree, and the step checks the output. It also proves that the domain
  does not stop normal work: a server that one `bash` call starts is found and ended by a later call; a write to a
  folder of the image that the uid owns, outside `/work`, succeeds; a move of a file into another folder succeeds;
  `ls /` and `ls /run` succeed; and `read` reads the full output of a `bash` call. It proves the metadata block: kind
  has no metadata service, so the step gives `169.254.169.254` to the node, and a pod that the policy does not select
  gets the node's refusal there. The Agent's `bash` does not, and it still connects to the model's host and to the
  Orchestrator's Service. A unit test pins the policy that `jr2 up` composes. The unit and conformance tests refuse the
  control token on the fetch route, the fetch token on an agent route, a stated slot that is not the registration's, and
  both tokens at a Gate, and they check the slot on the delivery poll. A test reads the Harness container's mounts from
  the pod spec. It fails on a mount that is not read-only, not under `/run/jr2`, and not the Workspace's own (`/work`,
  `HOME`), so a new mount is classified before it ships. Unit tests start node through `effector nocore --harness-env`
  with a `HOME` that holds a planted `.node_modules`, and check that node looks for no module there; they also retarget
  a link onto `/run/jr2`, restart the spawner, and check that the new domain reads nothing there. The `@kind` tier reads
  the Harness process's environ from outside the pod and checks its `HOME`.
- **The `@model` tier runs after the build.** The change alters what the Working tools can do and where a notice is
  delivered ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)), so it is a `@model`-tier change
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)).
