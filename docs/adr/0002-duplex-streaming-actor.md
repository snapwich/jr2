# The Actor is a duplex streaming channel, not a request/response call

An Actor drives an Agent run via an xstate `fromCallback` actor: it `dispatch()`es the run (persisting the `dispatchId`
in Machine context), subscribes to the Harness SSE stream and maps flue events up into the Machine (`progress`,
`awaiting_approval`, `done`, …), and accepts Machine events flowing down to the Harness (approve, steer, cancel,
queue-next). On a dropped connection it re-polls status by `dispatchId` and re-subscribes.

We rejected the simpler `fromPromise`-over-synchronous-`POST` model because it structurally cannot express
human-in-the-loop: a synchronous call returns exactly once, at the end, so mid-run approval and steering are impossible,
and a held hour-long cross-pod connection is lost on any blip or Orchestrator restart. The duplex stream makes
human-in-the-loop and "steering nudges" first-class Machine states and, via the persisted `dispatchId` plus flue's
durable-execution log, lets a restarted Orchestrator re-attach to an in-flight run instead of restarting it.

Two assumptions this rests on must be validated against flue directly: (1) a run's event stream is resumable by
`dispatchId` after disconnect; (2) which Machine→Agent messages can be delivered mid-run and when they take effect
(approval and cancel are likely; true mid-turn steering is uncertain given flue's "one active operation per session").
