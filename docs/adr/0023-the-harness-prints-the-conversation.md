# The Harness prints the conversation, and the reasoning is the part that prints

A running workflow is watchable and its Agents are not. The visualizer shows which states are lit (ADR-0022); the run
feed carries status and Emits (ADR-0009). What an Agent is actually _doing_ — what it read, what it tried, what it
concluded — appears nowhere, so inspecting a live run means `kubectl exec` into the Sandbox and reading the worktree and
`git log`. That is outcome inspection standing in for progress inspection: it says what changed, never why, and it says
nothing at all until something has changed.

jr solved this with `just watch` — an fzf list of live sessions over a preview that tailed the session JSONL through a
jq filter rendering four things: the prompt, assistant text, `[thinking]`, and one-line tool calls. Two panes: which
agents exist, and what this one is saying. This ADR is that, made Kubernetes-native.

**The conversation was never missing — jr2 declined it.** The Orchestrator awaits settlement as an opaque promise, "the
stream carries lifecycle only" — but the Harness's event stream already carries `message_start`/`message_end` bounding
both user and assistant messages, plus text, thinking, and tool-call content
([ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)) — every line of that jq filter,
replayable from any offset. The gap was a read decision, not a missing capability, and the fix is not new plumbing.

## Decision

- **The Harness prints, and `kubectl logs` reads.** The Harness writes its own conversation to container stdout —
  in-process; the loopback subscription this originally required retired with the foreign runtime (ADR-0027).
  `kubectl logs`, `stern`, `k9s`, and any log shipper work on it the day it lands, with no jr2 surface to build, learn,
  or version.
- **The Harness is the right seat because it already holds both halves of the label.** It knows its Agent's name and the
  iid arrives per Submission. So a line is `[<agent>] [<iid>] …` with no lookup, no correlation table, and no
  orchestrator round trip. Every line of a body carries both, the later lines of a body that spans lines too. The iid is
  what tells two conversations of one Agent apart in one log: the Instance Harness hosts the Menu-only Agents of every
  run ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)), so the runs in flight print into one log, and
  a reader keeps one run's lines by the prefix `<runId>/` (a run's Agents sit at more than one Machine path, and a Turn
  that does not continue, the conversation after one jr2 faulted, and a reroll each add a part to the iid). An iid
  always holds a `/`, and a label never does, so a reader can tell the two apart. Nothing else in the pod knows both:
  the Custodian sees routes and names, never a conversation, and working-tool execution happens inside the Harness,
  invisible to every other jr2 process there.
- **Reasoning prints, and so does each pick's answer; a Working tool's result does not.** Prompts, assistant text,
  thinking, tool calls with truncated inputs, and the answer to each Menu pick. The file contents, command output, and
  API responses a Working tool returns never print. This is one cut serving two purposes, which is why it is a boundary
  and not an unfinished implementation: a Working tool's results are whatever the Agent happened to read, which is where
  a leaked secret lands, and they are also most of the bytes. A pick's answer is one bounded text per pick, and the
  bullet below states what it can still carry. Every user message the model reads prints as a prompt — the Frame's
  prompt with its Turn part, a nudge, and a Turn part the Harness restated at a step boundary
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)), which prints once as
  `[<agent>] [<iid>] [prompt] <jr2-turn>` where the model read it.
- **A pick's answer prints after its call, as the model received it.** A Menu call's result is jr2's own text: the
  receipt, an outstanding pick's answer with the reply it carries (an Effect's output, a Gate's event and payload) and
  the paragraph after a push, a refusal ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md),
  [ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)). It prints as
  `[<agent>] [<iid>] [<pick> answer] <text>`, or `[<pick> error] <text>` for an answer the model reads as an error (a
  refusal while a pick is outstanding, a pick the tool's schema refused, a pick that never reached the Orchestrator),
  under the same bound as a call's input, cut in its middle: the print keeps the answer's head (the receipt) and its end
  (what follows the reply: the paragraph after a push, "Allowed now"), and marks the cut with the number of characters
  it dropped, `… [<n> characters cut] …`. The bound is the log's copy only; the model reads the whole answer, which the
  Orchestrator (a command's output tail) and the Effector (an `http` body) already bound. It is the text the model
  already read, so printing it changes nothing the model reads; it is what lets a reader of the log, and the `@model`
  tier's kept evidence ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)),
  see what came back where the call alone said `[publish] {}`. The print scrubs nothing of its own, as the rest of the
  conversation print scrubs nothing. What an Effector returns is scrubbed as
  [ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md) claims, before it signs its answer: it
  does not return a secret it holds in the forms it sent or in common encodings. The scrub does not try to catch a
  transformed secret (a hash, a truncation, an encoding it does not list), a partial echo, or a side channel, and a
  credentialed command's child reads the secret its command names (the argv can run a file the Agent wrote), so it can
  print that secret in such a form; then it reaches the log as it reaches the model. A `command` Effect in the Harness
  container runs with no credential of its own. And the answer carries what the model read: an Effect's output, an
  `http` body, a Gate's payload. A `command` Effect's output is command output from the Agent's own container and
  environment, with the Stand-ins the Agent's `bash` holds, so a Held value that an upstream echoed into that output
  (the Custodian does not scrub responses,
  [ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)) reaches the log as it reaches the
  model, up to the bound. Those two are the residual of printing a pick's answer, stated here and in ADR-0014. A Menu
  call that one of two cuts left with no result gets jr2's text in the history
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)), which the model reads on every later request: a
  call a Harness restart cut while it was out reached the workflow, and its result comes in the next message; a call an
  abort cut while the model was still writing it did not reach the workflow, and nothing ran. A call in a message a
  provider error ended is no cut: pi runs no call of that message and drops it from every request, so jr2 gives the call
  no text (ADR-0031). The call's line printed at its message's end, as every call's does; no answer prints for it. A cut
  call's answer is no message pi emits, so the Harness prints it itself, once: as `[<pick> answer] <text>`, before the
  next prompt of the conversation that ends in the call — the first prompt of the process after a restart, or the next
  Submission's in the same process. A message's answers print in the order of its calls, whichever came back first, and
  every prompt prints after the answers of the calls before it (a nudge, a restated Turn part and a re-admission alike),
  so no call's answer prints after a prompt that follows it.
- **Two mechanic lines print.** A Compaction prints
  `[<agent>] [<iid>] [compacted] context <before> → ~<after> tokens (window <w>)` where it cuts
  ([ADR-0036](0036-a-turn-compacts-its-own-context-mid-flight.md)). When a model has no level of the name the Turn asked
  for ([ADR-0018](0018-instance-agents-are-definitions-jr2-assembles-the-harness.md)), the Harness prints, once in a
  Submission and before the first answer a provider gave, the level that the model ran at:
  `[thinking level] <provider>/<id> has no level "<asked>"; the Harness sent "<level>"` when the Harness clamped the
  level and sent the result, `the Harness sent effort "<word>"` when the Harness's own request sent the provider's word
  for the level (Claude Sonnet 5.5 at `off` gets effort `high`), `the provider chose "<word>"` when the answer names it,
  and `the provider chose the level` when the Harness does not know. At `off` the Harness sends no level, so an OpenAI
  completions model with no `off` gets no reasoning field, and the line says that the provider chose. Neither line is on
  the wire or in the history, and the model reads neither.
- **The writer structures, the reader colorizes.** Lines carry a parseable prefix and no ANSI. jr's colors were correct
  for an fzf preview, which is a terminal; `kubectl logs` output is piped, grepped, and ingested, where escape codes are
  corruption. A future reader may colorize on `isatty`.
- **A Harness also prints the run's narrative — feed events the Orchestrator pushes to an echo endpoint.** A Workspace's
  pod log should read as the whole story of the run that owns it: not just the conversations hosted there, but the
  decisions and Emits that happened around them — a ticket claimed before the Workspace existed, a Menu pick a
  [Menu-only Agent](0031-menu-only-agents-run-on-the-instance-harness.md) made on the Instance Harness. The mechanism is
  a projection of the observation feed (ADR-0022), not a second record: the Harness wire gains one endpoint ("print
  these events"), gated like every Harness route on the placement's bearer
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)), and the Orchestrator — the feed's one subscriber —
  tees the owning run's events to the enclosing Workspace's Harness. At attach it replays the run's feed-so-far (the log
  opens with its preamble: why this Workspace exists); thereafter it tees live. The Harness renders — the wire payload
  is the structured event, and printing stays this ADR's craft. Three boundaries: **markers, not mirrors** — a
  remotely-hosted Turn echoes its admission and its pick, never its transcript (the transcript prints exactly once,
  where the Turn ran); **fire and forget** — a failed echo never fails anything, the feed remains the record and the log
  is a courtesy view; **Emit is the only author API** — a workflow that wants prose in the log Emits it (ADR-0011's
  vocabulary discipline holds; no `log()` primitive exists or will). The echo's lines carry no iid: `[run] [status] …`,
  `[run] [emit] …`, `[<agent>] [admitted] …` and `[<agent>] [pick] …`. A Workspace's Harness serves one run, so its log
  needs no run in a line, and a marker stands for a conversation that is in another log.
- **A status is a level, so the echo coalesces it.** In an echo's queue, pending statuses collapse to the latest;
  markers and Emits keep their order. A Harness that answers slowly holds at most one status plus the markers since its
  last push, and a burst of transitions across a Pool's workers costs each Harness one push per flush, not one per
  transition. The replay buffer follows the same rule: it keeps the markers and Emits (bounded) and the latest status,
  so the preamble reads "the story so far, and where the run stands now" — old statuses are not interleaved between old
  markers; the live tail keeps the interleaving (scaling review R10, 2026-09-30).
- **Pod-bound, and jr2 promises nothing beyond the pod.** A conversation lives as long as its Sandbox (ADR-0027,
  ADR-0031), so a Sandbox teardown (ADR-0012) or a lost Workspace (ADR-0021) takes it with it — the same contract
  ADR-0012 already set for the pod-local clone. A cluster that ships logs will outlive the pod anyway; that is the log
  plane's property, not a jr2 guarantee, and no jr2 behavior may come to depend on it.

## Considered options

- **Per-`agentRun` containers, or a pod per Agent.** Rejected on lifetime before merit: the container list is fixed when
  the CR is created, before the body has run, while `agentRun` is a per-turn invocation. Pre-declaring per _Agent_ is
  possible but pays N resident copies of a Harness image that deliberately carries the agent toolchain (ADR-0005) to run
  one at a time. It buys no isolation — containers in a pod share the network namespace, so it does not even fix the
  port contention that motivates it (ADR-0005:31) — and the git contention it would address is prohibited anyway
  (ADR-0004:95). What it actually buys is `kubectl logs -c <agent>`: a container, to avoid a prefix.
- **A trace from the Custodian.** Tempting, and wrong on the facts. The Custodian carries the Menu's reads and the
  Agent's picks — a handful of deliveries per turn — and the model calls, and it logs names only, never a body
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). The Agent's working tools execute in
  the Harness, never touching it. A Custodian trace shows `action=intercept … method=POST` and none of the four things
  worth watching.
- **Tee the stream host-side, in the Orchestrator** (the one place holding an admission and an open stream). Genuinely
  viable, and better on governance: addressable by run, and `instanceOnly` puts it behind the band ADR-0014 already
  enforces. Rejected as the larger build for the smaller reader — it needs an API, a CLI, and a format, to serve a
  reader `kubectl` already serves. Not foreclosed: it reads the same stream, so it remains the answer if the exception
  below stops being acceptable.
- **Persist transcripts beside the run snapshot.** Rejected: the Harness already serves the stream replayable from any
  offset for the life of the pod (ADR-0027), and jr2 holds the coordinates in the admission ledger (`run-host.ts:651`);
  copying the contents buys retention in exchange for owning growth, retention policy, and a redaction surface, in a
  store defaulting to sqlite.
- **Print a Working tool's results, truncated.** Rejected: the first 200 bytes of a leaked config is where the good
  stuff is, and the volume it re-admits is what kubelet's 10Mi rotation would then silently discard — losing the _start_
  of a long turn, which is the part worth reading. A `command` Effect's output does print, inside its pick's answer and
  under the bound: it is the output of a command the author named for the workflow, one per pick, and not what the Agent
  happened to read. The leak this rejects is still possible through it when the author's command prints a secret, and
  the bullet above states it.

## Consequences

- **The echo does not widen ADR-0014's open band.** The echo endpoint is authenticated wire (the placement's bearer,
  ADR-0058), so Emit payloads may ride it — the tokenless observation band still carries Emit types alone. What it does
  widen is the pod-log surface: a run's narrative becomes readable by whoever can read the Workspace pod's logs, the
  same audience the conversation bullet below already grants.
- **A scoped exception to ADR-0014**, recorded there. Observation is open and everything sensitive sits behind
  `instanceOnly`; this puts an Agent's reasoning, and the answers jr2 gave its picks, in front of whoever can read pod
  logs. Excluding a Working tool's results bounds it to what an Agent reasons aloud and what jr2 told it, rather than
  what it happened to read; what jr2 told it includes an Effect's output, so a `command` Effect's output and a Held
  value echoed into it reach the log as they reach the model, and so does an Effect secret in a form an Effector's scrub
  does not catch (a transformed secret, a partial echo; ADR-0068). Fine on kind; a real decision on a shared cluster.
- **It depends on an invariant that is documented but not enforced.** One Agent at a time per Workspace (ADR-0004:95,
  "structural since ADR-0012") is what makes two conversations never interleave on one container's stdout. Nothing
  refuses a body that invokes concurrent `agentRun`s; such a body corrupts a shared `default/.git` before it garbles a
  log, so enforcement is owed on its own merits — the ambient registrar (ADR-0012:32, ADR-0016) is the one thing that
  sees every Agent in a Workspace, and the place to refuse a second concurrent admission.
- **Truncation is load-bearing, not cosmetic.** Kubelet rotates container logs at 10Mi by default and drops the
  remainder. jr's filter capped `Bash` at 100 chars and unknown tools at 150 and reduced `Write`/`Edit` to a path; that
  was readability, and it is now also what keeps a long turn inside the window.
- **Live tails may miss partial output.** Text and thinking deltas are best-effort live progress, with `message_end`
  authoritative, so a reader that attaches mid-generation can miss earlier fragments until they arrive. Correct for a
  watcher; anything wanting exactness reads the completed message.
- **`jr2 logs` remains a status feed** and is now more confusingly named than before. Not renamed here — this ADR adds
  no command — but the collision is real and belongs to whoever next touches that surface.
- **The visualizer's eventual extension has a source.** When it grows past the graph, it reads the same stream; a page
  is a third reader of one feed, not a third way of collecting the data.
