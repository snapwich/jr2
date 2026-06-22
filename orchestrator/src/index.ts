// j2 Orchestrator — runs in its own pod, interprets a Machine, and drives Agents
// on remote Harnesses via a flue client.
//
// The kit lives here: the xstate Actor that proxies to a remote Agent run, the
// composable pieces (worktree setup, memory, ...), and example Machines (incl. the
// feature/task coding Machine). The Orchestrator entrypoint loads a Machine and
// runs it to completion.
//
// TODO: load a Machine, create the xstate actor, run it.

export {};
