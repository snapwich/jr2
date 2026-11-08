@kind
Feature: a workspace() run drives a real Sandbox on kind
  ADR-0012: a Workspace is ALWAYS a real Sandbox — there is no stubbed workspace mode — so this is
  the one tier where the data plane is real: the operator's Sandbox CR, a pod running the instance's
  own Sandbox Image with jr2's runtime injected into it (ADR-0037), the node's Repo cache mounted
  read-only (ADR-0051), a git worktree inside the pod, and the Harness endpoint the body's agent is
  admitted against.

  It is also the only tier where the AGENT is real in the way that matters (ADR-0013): the pod
  originates its own tool calls. Since ADR-0038 the pod runs the STOCK Harness — pi, the real Menu
  read through the Custodian on localhost, the real Working tools — and the ONLY thing still faked
  is the model: a scripted OpenAI-compatible endpoint the World serves from the host, over HTTPS,
  behind a key only the Custodian holds (ADR-0059). "The Agent calls X" means that model now
  answers with a tool call; the wire, the container boundary, the Custodian and the tool call are
  all real. Which makes this tier a SECOND pi canary beside the conformance suite (ADR-0027): a pi
  bump can break it.

  This tier is opt-in (`@kind`, excluded from the default suite) because it needs infrastructure:
    just e2e-kind-up      # a VANILLA kind cluster; nothing is built or loaded here
    just e2e-kind
  Bring-up is the product's own path (ADR-0010/0019/0038): each scenario runs `jr2 up` into a fresh
  namespace of the shared cluster, and that converge builds and loads every image it builds — the
  Kit images (Harness, operator, Orchestrator) and the instance's own Sandbox Images
  (`images/default`, and `images/user` for the one workflow that seats a human) — then publishes the
  instance's Assembly to the running Orchestrator (ADR-0069). The one image it deploys and never
  builds, the Custodian's pinned Envoy, a node pulls itself. Nothing is instance-bound to the
  cluster itself.

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
      And no Secret in the namespace has a last-applied-configuration annotation

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
    volume, which asks the Custodian on localhost, waits for the landing, and only then execs
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
      # And the Agent still reaches its Machine: its Custodian's token outlives the process that
      # minted it, so a turn played after the restart still lands (ADR-0013).
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's Sandbox is destroyed

  Rule: a command Effect runs in the Harness container of its Workspace, at most once
    ADR-0067. `command(argv)` is an actor slot: the Harness spawns argv[0] with no shell, as the
    Agent's user, in the Worktree its input names, and every outcome is output the Machine routes
    on. The `commanded` workflow has no Agent; its body's final output IS the command's output.

    Scenario: the exit code is output, and the Machine routes on it
      Given the kind instance is serving
      When I start the "commanded" workflow with input '{"mode":"exit","code":"3"}' detached
      Then the command exited with code 3
      And the run's Sandbox is destroyed

    Scenario: an argument with shell metacharacters stays one argument
      Given the kind instance is serving
      When I start the "commanded" workflow with input '{"mode":"argv","text":"a; touch /tmp/pwned && echo $(id) | cat"}' detached
      Then the command received "a; touch /tmp/pwned && echo $(id) | cat" as one argument

    Scenario: the timeout kills the process group and settles as output
      Given the kind instance is serving
      When I start the "commanded" workflow with input '{"mode":"timeout"}' detached
      Then the run's body settled as "timeout"

    Scenario: an orchestrator restart in the middle of a command gives one run
      Given the kind instance is serving
      When I start the "commanded" workflow with input '{"mode":"restart"}' detached
      Then the run's body is in "restart"
      And the command has started in the Sandbox
      When the orchestrator restarts
      # The command counts its own runs in the Worktree and prints the count when it ends: a second
      # run would have appended a second mark before either printed.
      Then the command's tail is "x"

  Rule: an http Effect runs in the Instance Effector, which returns no form of a secret it holds
    ADR-0068. The kind instance's `echo-token` is an Effect secret: the `called` and `asked`
    workflows name it with `secret("echo-token")`, so `jr2 up` places it in the Instance Effector and
    in no other pod. The echo server in the seed namespace answers with every header and the url it
    received, each in the encodings the Effector scrubs, so what comes back is the scrubbing proof: the
    Bearer the Effector built, base64(user:password), the url with the secret in its path, a header
    it filled from the secret — each named, never the value — in the run's snapshot, its feed, and
    the answer the model reads. A step decodes every base64 and percent-encoded run it reads and
    looks for the value inside, so a leak of what the Effector built cannot pass as clean.

    Scenario: a Bearer call's echo comes back with the secret named, in every form
      Given the kind instance is serving
      When I start the "called" workflow in mode "bearer" detached
      Then the http Effect's answer is a response from the echo
      And no form of the echo token reached the run, and the answer names it "[secret:echo-token]"
      And the run's feed carries no form of the echo token

    Scenario: a secret in the url's path, in a Basic pair and in a header comes back named, in every form
      Given the kind instance is serving
      When I start the "called" workflow in mode "inpath" detached
      Then the http Effect's answer is a response from the echo
      And no form of the echo token reached the run, and the answer names it "[secret:echo-token]"

    Scenario: a packaged Machine's Open secret, bound by the composer, reaches the echo and no Agent container
      ADR-0054. The `opensecret` workflow is a composer's file: it binds the packaged `notifier`'s
      `bearer(secret(open))` to `echo-token` with `customize()`. The Effect's Effector holds that
      secret, no Agent's Harness container holds any form of it — the run's Sandbox's, or the
      Instance Harness's — and the echo received it as the Bearer: the answer names it where the
      Authorization header carried the value.
      Given the kind instance is serving
      When I start the "opensecret" workflow in mode "bearer" detached
      Then the echo token is nowhere in the Sandbox's Harness container
      And the echo token is nowhere in the Instance Harness's Harness container
      When the held Effect is released
      Then the http Effect's answer is a response from the echo
      And the echo received the bound secret as the Bearer in its Authorization header
      And no form of the echo token reached the run, and the answer names it "[secret:echo-token]"

    Scenario: the answer an Agent reads is scrubbed
      Given the kind instance is serving
      When I start the "asked" workflow detached
      And the model answers "call_echo" with no arguments
      Then the model was shown the echo's answer with the token named "[secret:echo-token]" and no form of its value
      When the model answers "advise" with summary "done"
      Then the run's status shows "done"

  Rule: an http Effect is sent once, across an orchestrator restart and an Effector rollout
    ADR-0068. The intent row names the placement and no replica: after a restart the
    Orchestrator asks every replica for the Effect's id and follows the one that holds it. A rollout
    surges: the new replica takes new Effects while the old one finishes the one in flight and stays
    until its outcome is read. The echo counts each request by the run's marker.

    Scenario: two replicas and an orchestrator restart during the call give one send
      Given the kind instance is serving
      And the Instance Effector runs 2 replicas
      When I start the "called" workflow in mode "slow" detached
      Then the echo has received the run's call
      When the orchestrator restarts while the Effect runs
      Then the http Effect's answer is a response from the echo
      And the echo received the run's call exactly once

    Scenario: a rollout during the call gives one send, and the old replica answers it
      Given the kind instance is serving
      When I start the "called" workflow in mode "slow" detached
      Then the echo has received the run's call
      When the Instance Effector rolls out
      Then the http Effect's answer is a response from the echo
      And the echo received the run's call exactly once
      And the Instance Effector's rollout completes

  Rule: an Agent's MCP tools and an mcp Effect reach the server with the value, and the Harness holds only Stand-ins
    ADR-0079, ADR-0059. The fake MCP server runs on the host, over HTTPS under the tier's CA, and
    the kind config declares it two times, as `lookup-a` and `lookup-b`, each with its own key.
    Both keys are bound to one host in one header, so the Custodian chooses each value by the
    Stand-in that a request carries. Every converge lists the tools from a check pod, through its
    Custodian, and holds each Agent's allowlist to the live list (ADR-0019). The `tooled` Agent, in a
    Sandbox, calls a tool of each server and then picks: an MCP call is not a pick. The
    `advisedtooled` Agent is Menu-only, and calls `lookup-b` from the Instance Harness, which all
    Menu-only Agents share (ADR-0031). The `mcpcalled` workflow's `mcp` Effect calls `lookup-a` from
    the Instance Effector, which holds its key as an Effect secret. The server records the
    Authorization header of every request, and refuses a request that has no value of a key.

    Scenario: the Agent calls a tool of each of two servers on one host, each with its own key, then picks
      Given the kind instance is serving
      Then the converge listed the tools of "lookup-a" and "lookup-b" from a check pod
      When I start the "tooled" workflow in mode "agent" detached
      Then the run's Sandbox becomes Ready
      And the Harness container holds the stand-in for "MCP_A_KEY" as a file, in no env
      And the Harness container holds the stand-in for "MCP_B_KEY" as a file, in no env
      When the Agent in the Sandbox calls the MCP tool "lookup" of "lookup-a" with query "alpha"
      Then the model was shown the tool result "lookup-ok:alpha"
      When the Agent in the Sandbox calls the MCP tool "lookup" of "lookup-b" with query "beta"
      Then the model was shown the tool result "lookup-ok:beta"
      And the model was offered the MCP tools after the Working tools and before the Menu
      When the Agent in the Sandbox calls "finish" with summary "looked up both"
      Then the run's body settled as "finished"
      And the fake MCP server got each call with its own server's key, and no request without a key

    Scenario: a Menu-only Agent on the Instance Harness calls the MCP tool with its server's key, then picks
      Given the kind instance is serving
      When I start the "advisedtooled" workflow detached
      Then the model was offered "advise" from the Menu and no Working tools
      When the model calls the MCP tool "lookup" of "lookup-b" with query "gamma"
      Then the model was shown the tool result "lookup-ok:gamma"
      When the model answers "advise" with summary "looked it up"
      Then the run's status shows "done"
      And the fake MCP server got the call of "lookup-b" with query "gamma" with that server's key
      And no Sandbox was provisioned for the run

    Scenario: an mcp Effect calls the server from the Instance Effector with the key
      Given the kind instance is serving
      When I start the "mcpcalled" workflow in mode "call" detached
      Then the mcp Effect's answer is the tool's result for the run's marker
      And the fake MCP server got the Effect's call with the key of "lookup-a", and no form of the key reached the run

    Scenario: a converge whose Agent allowlists a tool the server does not list is refused
      Given the fake MCP server lists no tool "lookup"
      When I converge the kind instance
      Then the converge is refused, naming the tool "lookup" that "lookup-a" does not list

  Rule: a dispatch to another Orchestrator runs in the Instance Effector, with the key
    ADR-0071. A `dispatch` with a target runs in the Instance Effector, which holds the target's
    token as an Effect secret, sends the start to the target's door with the ledger row's id in the
    `jr2-dispatched-by` header, and with `wait` polls `GET /runs/<id>` until the run ends. The
    `dispatched` workflow's target is THIS Instance's Orchestrator, by its Service url and its
    Instance token, so the foreign path runs with no second cluster. Its callee is `called` in mode
    `slow`, which the echo holds 20 s and counts by the run's marker: an Orchestrator restart lands
    while both Effects run, and one start of the callee is one request at the echo.

    Scenario: a dispatch to this Instance by url and token starts one run across an orchestrator restart
      Given this scenario's self-token is the Instance token
      And the kind instance is serving
      When I start the "dispatched" workflow in mode "slow" detached
      Then the echo has received the run's call
      And the dispatched run names its caller from another Instance
      When the orchestrator restarts while the Effect runs
      Then the dispatch settled with the dispatched run, which ended "done"
      And the echo received the run's call exactly once

  Rule: the Hook door's mac check and its follow-up run in the Instance Effector, and so do a look's read and a Source's read
    ADR-0068, ADR-0078, ADR-0011, ADR-0017. The kind instance declares two Hooks with a `mac` verifier: `forge`, of the
    `github` kind, and `chat`, Slack's protocol with a follow-up host the tier serves (`workflows/_chat.ts`). So
    `jr2 up` places their secrets in the Instance Effector alone and converges it for them; the Orchestrator sends the
    bytes and the signature, and the Effector answers "match" or "no match". The `hooked` workflow's Gate hears both
    Hooks, and its look reads the echo with an `http` Effect marked idempotent; the `sourced` workflow's Pool reads its
    set the same way. A click's follow-up is one `http` call with no secret, to the host that `jr2 up` wrote into the
    Effector's fence from the kind's `posts`: here a Service of the scenario's namespace whose endpoint is a server on
    the host, under the tier's CA.

    Scenario: a review signed with the Hook's secret answers the run's Gate, and one signed with another is refused
      Given the kind instance is serving
      Then jr2 up converged the Instance Effector for the Hooks "forge" and "chat"
      When I start the "hooked" workflow in mode "deliver" detached
      Then the run's Gate is open
      When GitHub sends a review of the run's marker signed with another secret
      Then the Hook door answers 401
      And the run is still waiting at its Gate
      When GitHub sends a review of the run's marker signed with the Hook's secret
      Then the door delivered the event to the run's Gate
      And the run ends "done", approved by "octocat"

    Scenario: a Gate's look reads through the Instance Effector and answers the Gate with no delivery
      Given the kind instance is serving
      When I start the "hooked" workflow in mode "look" detached
      Then the run ends "done", approved by "look"
      And the echo has received the run's call

    Scenario: a read Source reads through the Instance Effector, and its Pool drains
      Given the kind instance is serving
      When I start the "sourced" workflow with a marker detached
      Then the run ends "done" with the items "n-1" and "n-2"
      And the echo has received the run's call

    Scenario: a click on the chat Hook answers the Gate, and its follow-up leaves the Instance Effector once
      Given the kind instance is serving
      And the chat kind's follow-up host answers in the scenario's namespace
      When I start the "hooked" workflow in mode "deliver" detached
      Then the run's Gate is open
      When the chat Hook sends a click on the run's marker
      Then the Hook door answers 200
      And the run ends "done", approved by "U1"
      And the follow-up host received the Gate's reply for the run, once

  Rule: a token Hook's secret reaches the Orchestrator only as its digest, which the door compares a delivery's token with
    ADR-0078. The kind instance declares `lab`, of the `gitlab` kind, whose verifier is `token`. `jr2 up` writes the
    sha-256 of its secret into the Secret `jr2-hook-digests`, which the Orchestrator mounts; the Instance Effector does
    not hold it. A delivery with the right token answers the `hooked` workflow's Gate, and one with another token is
    refused with 401.

    Scenario: an approval with the Hook's token answers the run's Gate, and one with another token is refused
      Given the kind instance is serving
      Then jr2 up gave the Orchestrator only the digest of the Hook "lab"'s secret "GL_HOOK"
      When I start the "hooked" workflow in mode "deliver" detached
      Then the run's Gate is open
      When GitLab sends an approval of the run's marker with another token
      Then the Hook door answers 401
      And the run is still waiting at its Gate
      When GitLab sends an approval of the run's marker with the Hook's token
      Then the door delivered the event to the run's Gate
      And the run ends "done", approved by "ann"

  Rule: a file-body http and a credentialed command run in the Workspace's Sandbox Effector, which the Agent cannot read
    ADR-0067, ADR-0068. The `effected` workflow's body commits a file in the Harness container, then
    runs an Effect that `jr2 up` placed in this Workspace's Sandbox Effector: an `http` whose body is the
    file to the echo with `bearer(secret("echo-token"))`, or a credentialed `command` whose env names
    the token by value and by `.path`. The provision adds the `effector` container to the pod; the
    Harness container mounts none of its volumes. A credentialed command runs against the pinned
    commit in a scratch of its own, so an uncommitted edit is never seen and the answer says
    `dirty`; its child is confined with Landlock, so the Effector's key is no file it can read.
    Every string that comes back is scrubbed. The Orchestrator reaches the Effector by the headless
    Service the provision writes beside it, which resolves to the pod's own address.

    Scenario: an http whose body is a committed Worktree file sends it, and the answer names the secret
      Given the kind instance is serving
      When I start the "effected" workflow in mode "file-body" detached
      Then the run's Sandbox pod has a Sandbox Effector beside the Agent
      When the held Effect is released
      Then the file-body http's answer is a response from the echo, whose body is the committed file

    Scenario: a credentialed command reads its secret from env and from its file, and its output is scrubbed
      Given the kind instance is serving
      When I start the "effected" workflow in mode "env" detached
      Then the credentialed command read its secret from env and from its file, and its output names it

    Scenario: a credentialed command never sees an uncommitted edit, and says the tree was dirty
      Given the kind instance is serving
      When I start the "effected" workflow in mode "dirty" detached
      Then the credentialed command saw the commit and not the edit, and says dirty

    Scenario: a credentialed command's child cannot read the Effector's key
      ADR-0068. The author's argv runs a script the Agent committed, which reads the Effector's key from
      a child of its child. Landlock denies it: the command ends with a permission error, and the
      answer and the feed carry no form of the key.
      Given the kind instance is serving
      When I start the "effected" workflow in mode "key" detached
      Then the credentialed command's child was denied the Effector's key, and the answer holds no form of it

    Scenario: a state that exits stops its credentialed command, and its process is gone from the Effector
      ADR-0067, ADR-0068. The credentialed command sleeps beside a Gate. The Gate's answer exits the
      state; the Orchestrator sends the Effector a signed DELETE on the Effect's own path, and the
      Effector ends the command's process group. The body then waits on its next Gate, so the pod
      is live while the step reads the Effector container's processes.
      Given the kind instance is serving
      When I start the "effected" workflow in mode "stop" detached
      Then the credentialed command is running in the Sandbox Effector
      When the state that runs the credentialed command exits
      Then the credentialed command's process is gone from the Sandbox Effector

    Scenario: a process that takes the Effector's port gets a signed start it cannot answer, and the Effect fails closed
      ADR-0068. The body holds on its Gate; the step starts a process in the Harness container, as the
      Agent could, that binds :8082 the moment it is free, then stops the Effector, whose
      container restarts into a port taken. Released, the file-body http's start reaches
      that process: signed, naming the secret, carrying no value of it. Its answer carries no
      signature the key verifies, so it is no answer: the Effect settles `unknown`.
      Given the kind instance is serving
      When I start the "effected" workflow in mode "takeover" detached
      And a process in the Harness container takes the Sandbox Effector's port while the Effector is down
      And the held Effect is released, and the takeover writes down its start
      Then the takeover got a signed start that carries no secret, and the Effect failed closed

  Rule: a Workspace with no Repo Slot has only /work, and its steps share it
    ADR-0051. The `shared` workflow leaves `repos` out, as a GitHub Actions job has one folder its
    steps share. The Sandbox names no Repo, so no cache is mounted and the attach is skipped. A
    command with no Effect secret writes data.txt in `/work`, which the start names, never the
    Sandbox Image's WORKDIR. The writer's Turn frames no `cwd`, so its `write` lands notes.md in
    `/work`; the editor, a second Agent, joins both into report.txt; and a file-body `http` sends
    report.txt from the Sandbox Effector, its path relative to `/work`. Only one folder that every
    step shares makes the upload hold both lines.

    Scenario: a command, two Agents and a file-body http share /work, and no Repo is attached
      Given the kind instance is serving
      When I start the "shared" workflow in mode "job" detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox names no Repo
      When the Agent writes "notes.md" through its write Working tool
      And the Agent in the Sandbox calls "drafted" with summary "wrote the notes"
      And the Agent runs "cat data.txt notes.md > report.txt && echo shared-in-$(pwd)" through its bash Working tool
      Then the model was shown the tool result "shared-in-/work"
      When the Agent in the Sandbox calls "edited" with summary "joined the notes"
      Then the upload holds the command's line and the writer's, and the command ran in the shared folder
      And the run's Sandbox is destroyed

  Rule: a nested Workspace has a Sandbox of its own, and loses it when a Machine of the run stops it
    ADR-0012. The `nested` and `pooled` workflows invoke a child `workspace()` from a state of a parent
    Workspace's body (`_nested.ts`); the child prints its pod's hostname, which is its Sandbox's name.
    A Sandbox's name comes from its Workspace's actor path, so two Pool workers that invoke their
    children with one invoke id have two Sandboxes, and a parent that enters the state again gives
    its new child the same name. A parent that leaves the state stops the child, and a stop skips the
    wrapper's `teardown`, so the host deletes the Sandbox, not the operator's idle timeout. A cancel
    deletes every Sandbox of the run.

    Scenario: two Pool workers' nested Workspaces have a Sandbox each, and each one's second round takes its name over
      Given the kind instance is serving
      When I start the "pooled" workflow as "pool" with input '{}'
      Then "pool" ends done, and each worker ran its two rounds in a Sandbox name that no other worker had
      And no Sandbox of "pool" is left within 60 seconds

    Scenario: a parent that leaves its nested Workspace's state deletes that Sandbox, and a cancel deletes both
      Given the kind instance is serving
      When I start the "nested" workflow as "leaving" with input '{"mode":"leave","sleep":"600"}'
      Then "leaving" has its parent's Sandbox and its nested Workspace's Sandbox Ready
      When I send "leave" to the Gate of "leaving"
      Then the nested Workspace's Sandbox of "leaving" is deleted within 60 seconds, and the run and its parent's Sandbox go on
      When I start the "nested" workflow as "cancelled" with input '{"mode":"leave","sleep":"600"}'
      Then "cancelled" has its parent's Sandbox and its nested Workspace's Sandbox Ready
      When I cancel "cancelled"
      Then no Sandbox of "cancelled" is left within 60 seconds
      When I cancel "leaving"
      Then no Sandbox of "leaving" is left within 60 seconds

  Rule: a signed push leaves the Sandbox Effector signed, and the sync moves the Agent's branch to it
    ADR-0067, ADR-0051. The `pushed` workflow binds the seed's push remote over ssh; its
    `git.credentials` entry names the deploy key the seed's sshd authorizes and the key the
    Effector signs with, which the scenario writes into its namespace before `jr2 up`. The Effector
    runs in the workflow's own image (`images/effector`: git and ssh). The remote verifies the
    published commit with the signing key as the one allowed signer — git's own check, in the
    pod. After the push the Agent's branch is the signed commit, and the Worktree is as it was.
    Not covered: a token push over https — the seed serves no https, and its sshd is the one
    remote that takes a push.

    Scenario: a signed ssh push verifies on the remote, and the sync changes no file
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      When I start the "pushed" workflow in mode "signed" detached
      Then the run's Sandbox pod has a Sandbox Effector beside the Agent
      When the held Effect is released
      Then the signed push published signed copies on the remote, which verify with the signer's key
      And the sync moved the Agent's branch to the signed commit, and its files, index and HEAD did not change

    Scenario: a push after the Agent rewrote the pushed commit is diverged, and pushes nothing
      Given the seed's push remote trusts this scenario's keys
      And the kind instance is serving
      When I start the "pushed" workflow in mode "diverged" detached
      Then the push after the rewrite is diverged, and the remote still holds the first push

  Rule: a GPG-signed push and a credentialed command share one Sandbox Effector, and are never live together
    ADR-0068. The `gpgsigned` workflow starts a credentialed command and a GPG-signed push at
    once, in parallel regions of one Workspace. The Effector's one lock over its two classes runs one
    after the other — a command's child is never alive beside the push's gpg-agent — and both
    complete. The push's `git.credentials` entry signs with a GPG key the scenario makes on the host
    and writes into its namespace before `jr2 up`; the Effector runs in the tier's effector image,
    which carries gnupg.

    Scenario: a credentialed command and a GPG-signed push started together both complete
      Given the seed's GPG push remote trusts this scenario's keys
      And the kind instance is serving
      When I start the "gpgsigned" workflow in mode "both" detached
      Then the credentialed command and the GPG-signed push both completed, and the remote holds the GPG-signed commit

  Rule: a Sandbox reaped while the orchestrator is down is never silently re-provisioned

    Scenario: the restored body is told its workspace is lost
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the orchestrator stops
      And the run's Sandbox is reaped behind its back
      And the orchestrator starts again
      # The Sandbox watch's first list found the CR gone and delivered `workspace.lost` INTO the
      # body, whose `lost` state invokes `fail` (ADR-0063, ADR-0073). The unpushed commits are gone;
      # resuming would have been a lie, and `done` would say that the work succeeded.
      Then the run failed with reason "the Sandbox was lost"
      And no Sandbox was re-provisioned for the run

  Rule: the Agent's only control-plane peer is the Custodian on localhost
    ADR-0013, ADR-0059. The Agent reaches its Machine through a container it can talk to but whose
    credential it cannot read: the Harness holds the control token's Stand-in, and the Custodian
    puts the token on its own routes and no other. Nothing else in the pod can deliver — which is
    what makes "the Agent never steers the workflow" enforced rather than advertised.

    Scenario: the tool call originates inside the pod and drives the Machine
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox runs the Custodian beside the Harness
      # The pod dialed out and read its Menu before the model ever spoke — visible here as the tool
      # set the Harness put on the provider request (ADR-0015/0028/0029).
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
      # The Harness container shares the pod's network namespace — so it CAN reach the
      # Orchestrator, address and all. Even the control Stand-in, which no confined child reads,
      # is worth nothing there: the control token is the Custodian's alone.
      When the Harness container posts "finish" straight to the Orchestrator
      Then the delivery is refused as unauthorized
      And the run has not settled

  Rule: no Workspace code can act as an Agent
    ADR-0076. Every Agent of a Sandbox runs in its one Harness, and they share a writable /work. So
    the boundary is not a container: it is that the credential lives only where no Workspace code
    runs. The Harness process holds the control Stand-in; each program it starts on /work — bash,
    a test, git — runs confined by Landlock, with an env that holds only the Stand-ins its
    `workspace()` grants. Each probe here runs as the model's own bash call, so it sees what
    planted code sees.

    Scenario: an Agent's bash finds no Stand-in of the pod in its env, a file, or the Harness's /proc
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent's bash looks everywhere it can for the pod's Stand-ins
      Then the Agent's bash could not read a Stand-in file, nor the Harness's environ or memory
      And the Agent's bash found no Stand-in of the pod
      And no request to the model holds a Stand-in of the pod
      # A module planted where node would look last runs only in a node whose HOME is the domain's.
      When the Agent's bash plants a module in its HOME's .node_modules and .node_libraries
      Then the Harness process's HOME, read from outside the pod, is not the HOME where the Agent planted

    Scenario: code the coder plants in /work, run by the reviewer's own tests, cannot approve the review
      Given the kind instance is serving
      When I start the "sibling" workflow in mode "review" detached
      Then the run's Sandbox becomes Ready
      When the coder's bash plants a test in /work that approves the review as the reviewer
      And the Agent in the Sandbox calls "built" with summary "done"
      And the reviewer's bash runs the tests in /work
      Then each approval the planted test sent was refused
      And the reviewer's Turn still waits for its model
      And the run has not settled

    Scenario: an Agent's program spends the held secret its workspace() grants, and holds no model key
      Given the kind instance is serving
      When I start the "sibling" workflow in mode "review" detached
      Then the run's Sandbox becomes Ready
      When the Agent's bash sends the "PROBE_KEY" Stand-in from its env to the model's host
      Then the Agent's bash held the "PROBE_KEY" Stand-in and no "JR2_PROVIDER_API_KEY"
      And the model's host received the value of "PROBE_KEY", and no Stand-in

  Rule: the domain does not stop the work an Agent normally does
    ADR-0076, ADR-0077. The domain keeps one thing from the Agent: /run/jr2, and the Harness process.
    All else that the container's uid can do, the Agent's programs can do. All of them are in one
    domain, so a later bash call finds and ends a server that an earlier call started. A move into
    another folder works, because the minimum Landlock ABI (3) has REFER. Each claim here is the model's own
    tool call, and the step reads the tool result that the model reads.

    Scenario: a server that one bash call starts, a later bash call finds and ends
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent's bash starts a server in the background
      Then the Agent's bash started the server, and it answers
      When a later bash call of the Agent finds the server and ends it
      Then the later call read the server's env and its working folder, and the server is gone

    Scenario: an Agent writes in a folder of the image that its uid owns, moves files across folders, and has the image's env
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent's bash writes in "/app", moves files across folders, and prints "E2E_IMAGE_ENV"
      Then the Agent's bash wrote in "/app"
      And each move of the Agent's bash succeeded
      And the Agent's bash listed "/", "/run" and "/run/jr2"
      And the Agent's bash saw "E2E_IMAGE_ENV" as "from-images-default"
      And the Agent's bash saw the image's LD_LIBRARY_PATH, and the Harness process has none

    Scenario: read reads the full output of a bash call that was truncated
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent's bash prints more lines than the model is shown
      Then the model was shown the tail and the name of the full output's file
      When the Agent reads the full output's file
      Then the model was shown the first line of the full output

  Rule: an Agent reads its project context in the domain, up to the Workspace's bound
    ADR-0062, ADR-0076. A child in the domain loads the context files and the skills with
    pi-coding-agent, and the Harness keeps only the files from the Turn's folder up to the bound: the
    Worktree's root by default, `/work` under `projectContext: "workspace"`, never above `/work`. A
    command writes the files before the reader's first Turn (`_contexted.ts`): the Worktree's
    CLAUDE.md and a skill, an AGENTS.md beside it that links to the control Stand-in, and files in
    the slot's folder, in `/work` and in jr2's fallback home. Each step reads the system prompt of
    the reader's first request, as the scripted model received it.

    Scenario: under the default bound, the Worktree's context file and skill reach the model, and nothing of /work, the slot's folder, jr2's home or a link to /run/jr2 does
      Given the kind instance is serving
      When I start the "contexted" workflow detached
      Then the run's Sandbox becomes Ready
      And the reader's system prompt holds the context file "/work/app/ctx/CLAUDE.md" with "CTX-WORKTREE-RULE" in pi's frame
      And the reader's system prompt lists the skill "ctx-skill" with "CTX-SKILL-DESC"
      And the reader's system prompt names no context file "/work/app/ctx/AGENTS.md"
      And the reader's system prompt holds no text of "CTX-WORK-RULE"
      And the reader's system prompt holds no text of "CTX-SLOT-RULE"
      And the reader's system prompt holds no text of "CTX-HOME-RULE"
      And the domain wrote jr2's fallback home, and the Harness logged no failure to load a project context
      When the Agent in the Sandbox calls "finish" with summary "read the rules"
      Then the run's Sandbox is destroyed

    Scenario: under projectContext "workspace", the files of /work and of the slot's folder reach the model too, outermost first
      Given the kind instance is serving
      When I start the "contexted-shared" workflow detached
      Then the run's Sandbox becomes Ready
      And the reader's system prompt holds the context file "/work/AGENTS.md" with "CTX-WORK-RULE" in pi's frame
      And the reader's system prompt holds the context file "/work/app/AGENTS.md" with "CTX-SLOT-RULE" in pi's frame
      And the reader's system prompt holds "CTX-WORK-RULE" before "CTX-SLOT-RULE" before "CTX-WORKTREE-RULE"
      And the reader's system prompt lists the skill "ctx-skill" with "CTX-SKILL-DESC"
      And the reader's system prompt names no context file "/work/app/ctx/AGENTS.md"
      And the reader's system prompt holds no text of "CTX-HOME-RULE"
      And the domain wrote jr2's fallback home, and the Harness logged no failure to load a project context
      When the Agent in the Sandbox calls "finish" with summary "read the rules"
      Then the run's Sandbox is destroyed

  Rule: the image user's context is read from a read-only mount of the Sandbox Image, and from nowhere else
    ADR-0062, ADR-0076. Each Agent runs as the image's user and can write that user's home, so
    `~/.pi/agent` as it is in the home would let one Agent write each later Agent's system prompt.
    `jr2 up` records the folder when the image has it, the pod mounts that folder of the image
    again, read-only, at its own path and at /run/jr2/user-context, and tells the Harness
    (`JR2_USER_CONTEXT`). The Harness reads it under /run/jr2 alone, and the prompt names its files
    there, where the model reads a skill's file: a folder that an Agent puts at ~/.pi/agent is never
    read, by the Harness or by the model. A command in the domain tries to
    change the folder, and to put a folder of its own in its place, before the reader's first Turn
    (`contexted-image.ts`). An image with a `USER`
    and no such folder gets no mount, and a folder that a command makes there is not read
    (`contexted-home.ts`).

    Scenario: an image's ~/.pi/agent reaches the model from a read-only mount, its auth.json never does, and the domain cannot change it or put another folder in its place
      Given the kind instance is serving
      When I start the "contexted-image" workflow detached
      Then the run's Sandbox becomes Ready
      And the reader's system prompt holds the context file "/run/jr2/user-context/AGENTS.md" with "CTX-IMAGE-RULE" in pi's frame
      And the reader's system prompt holds "CTX-IMAGE-RULE" before "CTX-WORKTREE-RULE"
      And the reader's system prompt lists the skill "img-skill" with "CTX-IMAGE-SKILL-DESC" at "/run/jr2/user-context/skills/img-skill/SKILL.md"
      And the reader's system prompt holds no text of "CTX-FAKE-RULE"
      And the reader's system prompt holds no text of "/home/node/.pi/agent"
      And no request to the model holds "CTX-AUTH-SECRET"
      And the pod mounts "/home/node/.pi/agent" read-only from its own Sandbox Image, there and under /run/jr2, and the Harness reads the user context under /run/jr2
      And each try of a command in the domain to change the image user's context failed on a read-only file system
      When the Agent in the Sandbox calls "finish" with summary "read the rules"
      Then the run's Sandbox is destroyed

    Scenario: an image with a USER and no ~/.pi/agent gets no mount, and a ~/.pi/agent that the domain makes is not read
      Given the kind instance is serving
      When I start the "contexted-home" workflow detached
      Then the run's Sandbox becomes Ready
      And the reader's system prompt holds the context file "/work/app/ctx/CLAUDE.md" with "CTX-WORKTREE-RULE" in pi's frame
      And the reader's system prompt holds no text of "CTX-MADE-RULE"
      And the domain made the image user's ~/.pi/agent, and the pod mounts none and tells the Harness none
      When the Agent in the Sandbox calls "finish" with summary "read the rules"
      Then the run's Sandbox is destroyed

  Rule: a Harness holds stand-ins, and only the Custodian puts the key on the wire
    ADR-0059, ADR-0076. Workspace code runs in the Harness container, so a key there is a key it can
    take away. The Harness holds a secret Stand-in, as a file under /run/jr2 that no confined child
    reads and in no env; the Custodian, a container the Agent executes nothing in, swaps it for the
    key toward the provider's host alone. What the Agent can take out of the pod is worth nothing
    outside it.

    Scenario: the provider receives the key, and the Harness container holds only the stand-in
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the model provider received the provider key on every turn request
      And the Harness container holds the stand-in for "JR2_PROVIDER_API_KEY" as a file, in no env
      And the provider key is nowhere in the Harness container's environment or files
      And the provider key is nowhere in the Instance Harness's Harness container
      And the Custodian's log names "JR2_PROVIDER_API_KEY" and never the key

    Scenario: a stand-in sent to a host the secret is not bound to arrives as it left
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Harness container sends the stand-in for "JR2_PROVIDER_API_KEY" to the unbound echo
      Then the unbound echo received the stand-in, and not the key

    Scenario: a request to the provider without the stand-in never reaches it
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Harness container calls the model provider with no stand-in
      Then the Custodian refuses it as missing the stand-in
      And the model provider received no request without the key

  Rule: no Harness pod reaches a cloud metadata address
    ADR-0076. Where a node's metadata service answers pods, it gives the node's cloud credential,
    which no workspace() grants. So `jr2 up` converges an egress NetworkPolicy for each Harness pod:
    every address, except the metadata addresses. kindnet enforces it. kind has no metadata service,
    so the step gives the address to the node, and a pod that the policy does not select is the
    control.

    Scenario: an Agent's bash cannot connect to the metadata address, and still reaches the model's host and the Orchestrator
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent's bash connects to the cloud metadata address, the model's host and the Orchestrator
      Then the metadata address did not answer the Agent's bash, and the model's host and the Orchestrator did

  Rule: a Harness answers the Orchestrator alone
    ADR-0058. The Harness wire drives conversations — admit a Turn, read its history, abort it — and
    its iids are derivable (ADR-0013/0057), so a caller that can reach a Harness must also hold the
    bearer the Orchestrator derives for that pod, which no pod holds (the Harness keeps only its
    digest). And no pod but the Orchestrator reaches a Harness pod at all: an ingress NetworkPolicy
    per placement, which kindnet enforces. The bearer is the control; the policy bounds where a pod
    may talk.

    Scenario: the Agent cannot drive its own Harness's wire
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      # Loopback: the same pod, so no NetworkPolicy is between them — the bearer alone refuses.
      When the Harness container admits a Turn to its own Harness
      Then the Harness refuses it as unauthorized
      And the run has not settled

    Scenario: a Sandbox cannot reach the Instance Harness
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      # The Instance Harness holds every Menu-only conversation in the Instance (ADR-0031), and the
      # kind instance's advisor converges one in every scenario's namespace.
      When the Harness container dials the Instance Harness
      Then the connection never completes

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
      # for is over on the pod — not merely forgotten by the Orchestrator: the pick's answer ended its
      # run at the step boundary, and the Orchestrator's sweep, which says that the pick was the cause,
      # settled it `ended`, whether it landed before the Harness's own end or after it.
      And the Harness reports 1 of the Agent's turns settled as "ended"
      # …and the turn `shipping` asked for is NOT among them, on the SAME instance id. The abort was
      # ordered ahead of it, so it never settled work that had not run.
      When the Agent in the Sandbox calls "ship" with summary "ok"
      Then the run's body is in "parked"
      And the Harness reports 2 of the Agent's turns settled as "ended"
      And the run's Sandbox is still there

    # The pick's own answer ends the turn above, and it settles `ended`. Here nothing is picked: the
    # Gate's answer leaves `coding` while the model is still writing its answer, so the
    # Orchestrator's sweep is the only end, and it says no cause. The Harness settles it `aborted`,
    # with no message of its own, and the sweep cut the model's request.
    Scenario: a state that stops waiting for a cause other than the Agent's pick aborts the turn mid-request
      Given the kind instance is serving
      When I start the "interrupted" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's body is in "coding"
      And the scripted model is holding the Agent's request offering "finish"
      When I send "halt" to the Gate
      Then the run's body is in "parked"
      And the scripted model's request offering "finish" was cut with no answer
      And the Harness reports the Agent's turn settled by the Orchestrator's abort
      And the run's Sandbox is still there

  Rule: a write from the review worktree cannot reach the branch or the coder's worktree
    ADR-0028. The tool layer (`workspace: "read"`) states intent and stops the honest path; the
    detached review Worktree is the containment. It sits beside the branch Worktree at the sha
    under review with a DETACHED HEAD, so a rogue write cannot move the branch and a rogue commit
    lands on a detached HEAD — it evaporates with the checkout.

    Scenario: a write probe and a commit from the review worktree leave the branch untouched
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox has repo "app" checked out on branch "feat-e2e"
      # The git steps of a detached cut (ADR-0028, ADR-0075), played in the pod. What this scenario
      # pins is the containment property those lines buy.
      When a detached review worktree is attached for repo "app" at the head of branch "feat-e2e"
      And the review worktree gets a write probe and a commit
      Then the branch ref of repo "app" branch "feat-e2e" is unmoved
      And the coder's worktree for repo "app" branch "feat-e2e" is untouched

  Rule: jr2 mounts its runtime into the user's image, and the floor holds inside the pod
    ADR-0037. A Sandbox Image is the user's Dockerfile — zero jr2 knowledge, any base — run
    byte-for-byte: the kit's Harness image is mounted as an image volume at /opt/jr2, and only the
    container's COMMAND is overridden. So the floor is a composition, not a build, and
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
    run in, so `jr2 up` converges an Instance Harness — a Harness + Custodian pod with no Workspace —
    whenever a registered Machine carries such a definition, and the Turn is admitted THERE. No
    config names or enables it: the kind instance's `advisor` definition is the whole reason the
    Deployment exists in every scenario's namespace. Placement is definition-wins: even invoked
    inside a `workspace()`, the advisor's conversation lives on the Instance Harness and never on
    the run's Sandbox, because a conversation is an Instance ID on ONE server.

    Scenario: a workflow with no Workspace runs its Agent on the Instance Harness
      Given the kind instance is serving
      When I start the "advised" workflow detached
      Then the model was offered "advise" from the Menu and no Working tools
      And the Instance Harness holds the "advisor" conversation of the run's root Machine
      When the model answers "advise" with summary "ship it"
      Then the run's status shows "done"
      And no Sandbox was provisioned for the run

    Scenario: inside a Workspace, the Menu-only Agent still runs on the Instance Harness
      Given the kind instance is serving
      When I start the "consulted" workflow detached
      Then the run's Sandbox becomes Ready
      And the model was offered "advise" from the Menu and no Working tools
      And the Instance Harness holds the "advisor" conversation of the run's body Machine
      And the run's Sandbox holds no "advisor" conversation of the run's body Machine
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
      And the run's output names the branch jr2/task-<run id>
      And the run's Sandbox is destroyed

  Rule: a Turn's Frame roots the Working tools, so a relative path lands in the Worktree
    ADR-0057, and the incident it was written for: a live `task` run whose prompt said "work in
    /work/target/summarize" while every Working tool resolved relative paths at `/work`, because
    `cwd` lived on the Agent definition and a definition is written before any run — before any
    worktree — exists. The model wrote its file outside the worktree, called `finish`, and the run
    parked at `review` claiming done. Nothing failed; the work was simply not there.

    The Frame is what closed it: `cwd` rides the Turn, the Harness roots the Working tools at it,
    and `task` frames the Worktree of the slot the coder edits. Only a real pod can answer where a
    relative path went, so the claim is played here — the scripted model writes a bare filename and
    commits with bare `git add`, and the file has to be in the Worktree and in no directory above
    it. `/work` is exactly where the retired definition-level `cwd` could only ever have pointed.

    The same commit proves git's default identity (ADR-0037): the Sandbox Image sets no git
    identity, and the command sets none, so the commit succeeds only because the Harness points
    git's system level at jr2's file. The author git prints is `jr2 Agent <agent@jr2.invalid>`.

    Scenario: a relative path from the model lands in the Worktree, and the commit is on the branch
      Given the kind instance is serving
      When I start the "task" workflow with prompt "write a SUMMARY.md for this repository" detached
      Then the run's Sandbox becomes Ready
      When the Agent writes "SUMMARY.md" through its write Working tool
      And the Agent runs "git add SUMMARY.md && git commit -q -m jr2-frame-ok && git log -1 --pretty=format:committed-%s-by-%an-%ae" through its bash Working tool
      # The marker is the git OUTPUT, not the command: `%s` is expanded by git, so only a bash tool
      # that ran in the Worktree — where the relative `git add` found the file — can produce it, and
      # `%an`/`%ae` only a commit that found jr2's default identity.
      Then the model was shown the tool result "committed-jr2-frame-ok-by-jr2 Agent-agent@jr2.invalid"
      When the Agent in the Sandbox calls "finish" with summary "wrote the summary"
      Then the run parks at the "review" Gate, with summary "wrote the summary"
      And the file "SUMMARY.md" is in the Worktree the Gate names and in no directory above it
      And the Worktree the Gate names has the commit "jr2-frame-ok" on its branch

  Rule: jr2 up makes each named Caller token, and a rotation ends the old value
    ADR-0078. A named token's value is in a Secret of its own, which `jr2 caller token` reads over
    the kube API; the Orchestrator holds only its digest, through a mount that it reads again when
    it changes. So a rotation rolls no pod, and `jr2 caller rotate` returns only when the Orchestrator has read the new digest: from then the old value is refused and the new value works. The CLI on a kube context is the
    Caller token/instance, on behalf of the user that a SelfSubjectReview names.

    Scenario: the CLI is token/instance for the kube user, a named token is its own Caller, and a rotated value is refused
      Given the kind instance is serving
      When I ask who I am
      Then I am the Caller "token/instance" on behalf of the kube user
      When I read the Caller token "ci"
      Then the Caller token "ci" acts as "token/ci"
      When I rotate the Caller token "ci"
      Then the old value of the Caller token "ci" is refused within 5 seconds
      When I read the Caller token "ci"
      Then the Caller token "ci" acts as "token/ci"
