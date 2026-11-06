@kind
Feature: the jr2 workspace verbs and the kept conversation, against real Sandboxes on kind
  ADR-0009, ADR-0012, ADR-0021, ADR-0076, ADR-0023. `jr2 workspace ls | shell | forward | rm` read and
  act on the Sandbox CRs over the kube API alone, with no Orchestrator: kube RBAC is the gate. A
  handle is `<run-prefix>/<workspace path>`, from the CR's `jr2.dev/workspace-path` annotation, and
  the `jr2.dev/workspace` label carries a selector form of that path. `shell` runs in the Agents'
  Landlock domain, so it never reads the control Stand-in. `rm` removes only a Sandbox that no run
  holds.

  The Harness of each pod sends its conversation to the Orchestrator during the Turn, so
  `jr2 logs` reads it after the pod is gone, and after a pod that is killed in a Turn.

  Same infrastructure as kind.feature: `just e2e-kind-up`, then `just e2e-kind`.

  Rule: ls lists a run's Workspace by its handle with no Orchestrator, and the conversation outlives the Orchestrator's pod

    Scenario: the Sandbox carries its path as a label, and ls finds it with the Orchestrator scaled to zero
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      And the run's Sandbox carries its Workspace path in the jr2.dev/workspace label
      And jr2 logs of the run prints a "coder" line holding "[prompt]"
      When the orchestrator stops
      And I list the run's Workspaces
      Then the Workspace list has the run's Sandbox as "held", by its handle
      When I complete a Workspace handle for jr2 workspace shell
      Then the completions include the run's handle
      When the orchestrator starts again
      # The kept conversation is in conversations.db on the Orchestrator's volume, so it outlives the pod.
      Then jr2 logs of the run prints a "coder" line holding "[prompt]"
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"

  Rule: shell runs in the Agents' domain, which cannot read the control Stand-in, or in the User Container with --user

    Scenario: a command in the shell works in the Workspace, and is denied the control Stand-in
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When I run "pwd" in the run's Workspace with jr2 workspace shell
      Then the shell's command exits 0 and prints "/work"
      When I run "cat /run/jr2/control/standin" in the run's Workspace with jr2 workspace shell
      Then the shell's command fails and prints no Stand-in of the pod
      When I run "env" in the run's Workspace with jr2 workspace shell
      Then the shell's command exits 0 and its env holds no Stand-in of the pod and no JR2_ name but the Custodian's address
      When I run "id" in the run's User Container with jr2 workspace shell --user
      Then the command exits 1
      And stderr names "has no User Container"

    Scenario: shell --user runs in the User Container, the seat that jr2 does not own
      Given the kind instance is serving
      When I start the "seated" workflow detached
      Then the run's Sandbox becomes Ready
      When I run ". /etc/os-release && echo $ID" in the run's User Container with jr2 workspace shell --user
      Then the shell's command exits 0 and prints "alpine"

  Rule: forward carries a local port to a port in the Sandbox pod

    Scenario: a server in the pod answers through the forward, and through --stdio by the ssh handle
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When a server in the run's Sandbox answers "hello from the pod" on port 8765
      Then jr2 workspace forward to port 8765 reaches it at the address it prints
      And jr2 workspace forward --stdio to port 8765, by the Sandbox's name.jr2, carries one connection to it

  Rule: rm refuses a Sandbox that a run holds, and removes one that no run holds

    Scenario: rm refuses the live run's Sandbox, and removes it after a cancel that keeps it
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When I remove the run's Workspace with jr2 workspace rm
      Then the command exits 1
      And stderr names "cancel the run first"
      And the run's Sandbox is still there
      When I cancel the run and keep its Workspace
      And I list the run's Workspaces
      Then the Workspace list has the run's Sandbox as "released", by its handle
      When I remove the run's Workspace with jr2 workspace rm
      Then the command exits 0
      And the run's Sandbox is destroyed

  Rule: the conversation outlives the pod

    Scenario: jr2 logs reads a real Harness's conversation after the run's Sandbox is gone
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent runs "echo kept-by-the-orchestrator" through its bash Working tool
      Then jr2 logs of the run prints a "coder" line holding "echo kept-by-the-orchestrator"
      When the Agent in the Sandbox calls "finish" with summary "ok"
      Then the run's status shows "done"
      And the run's Sandbox is destroyed
      And jr2 logs of the run prints a "coder" line holding "[prompt]"
      And jr2 logs of the run prints a "coder" line holding "echo kept-by-the-orchestrator"

    Scenario: the entries sent before the pod is killed in a Turn are still kept
      Given the kind instance is serving
      When I start the "sandboxed" workflow detached
      Then the run's Sandbox becomes Ready
      When the Agent runs "echo before-the-kill" through its bash Working tool
      Then jr2 logs of the run prints a "coder" line holding "echo before-the-kill"
      When the run's Sandbox pod is killed in the Turn
      # The read comes after the Orchestrator has handled the loss, so a loss that drops the run's
      # conversations fails here.
      Then the run failed with reason "the Sandbox was lost"
      And jr2 logs of the run prints a "coder" line holding "echo before-the-kill"

  Rule: jr2 logs reads a Menu-only Agent's conversation, which the Instance Harness sends

    Scenario: jr2 logs reads the conversation of a Menu-only Agent on the Instance Harness
      Given the kind instance is serving
      When I start the "advised" workflow detached
      Then the model was offered "advise" from the Menu and no Working tools
      When the model answers "advise" with summary "ship it"
      Then the run's status shows "done"
      And jr2 logs of the run prints a "advisor" line holding "[prompt]"
