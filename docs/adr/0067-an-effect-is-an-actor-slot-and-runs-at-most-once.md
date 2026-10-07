# An Effect is an actor slot, and runs at most once

An Effect is work a Machine does outside itself. The first kind is `command`: run a program in the Workspace.

## Decision

- **A `command` runs in the Harness container of its Workspace's Sandbox**, as a child of the Harness process: the
  Agent's user, the Sandbox Image's tools, the same Stand-ins as the Agent's `bash` (ADR-0059), and no credential of its
  own. The Harness serves it on `/exec/:id`, behind the same bearer as every Harness route (ADR-0058); the Instance
  Harness holds no Workspace and refuses it (ADR-0031).
- **argv, never shell text.** Each entry is one argument; the Harness spawns `argv[0]` with no shell. `sh -c` is the
  author's explicit choice, in the argv, and its result is not a trusted verdict.
- **One id runs once.** An exec is named by its Effect's id; a second start of a known id runs nothing.
- **The process group ends with the exec.** Each exec leads its own group; its timeout, a kill, and its top process's
  exit each SIGKILL the group, so nothing it started outlives it.
- **A bounded tail is the output; the full stream is read by offset.** stdout and stderr in arrival order; a read with
  no offset starts at the end. A Harness restart forgets every exec.

## Considered options

- **Run a command in an Effector container.** Rejected: a command runs the Workspace's own code, which the Agent wrote;
  it needs the Sandbox Image's tools and the Agent's user, and it must hold no secret the Agent could not.
- **Take a command as a shell string.** Rejected: an Agent's param in a string is a shell injection.

## Consequences

- A command a Harness restart cut is not known to the rebuilt Harness.
