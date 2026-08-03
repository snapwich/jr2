# The Harness prints the conversation, and the reasoning is the part that prints

A running workflow is watchable and its Agents are not. The visualizer shows which states are lit (ADR-0022); the run
feed carries status and Emits (ADR-0009). What an Agent is actually _doing_ — what it read, what it tried, what it
concluded — appears nowhere, so inspecting a live run means `kubectl exec` into the Sandbox and reading the worktree and
`git log`. That is outcome inspection standing in for progress inspection: it says what changed, never why, and it says
nothing at all until something has changed.

jr solved this with `just watch` — an fzf list of live sessions over a preview that tailed the session JSONL through a
jq filter rendering four things: the prompt, assistant text, `[thinking]`, and one-line tool calls. Two panes: which
agents exist, and what this one is saying. This ADR is that, made Kubernetes-native.

**The conversation was never missing — j2 declined it.** The Orchestrator awaits settlement as an opaque promise, "the
stream carries lifecycle only" — but the Harness's event stream already carries `message_start`/`message_end` bounding
both user and assistant messages, plus text, thinking, and tool-call content
([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)) — every line of that jq filter,
replayable from any offset. The gap was a read decision, not a missing capability, and the fix is not new plumbing.

## Decision

- **The Harness prints, and `kubectl logs` reads.** The Harness writes its own conversation to container stdout —
  in-process; the loopback subscription this originally required retired with the foreign runtime (ADR-0027).
  `kubectl logs`, `stern`, `k9s`, and any log shipper work on it the day it lands, with no j2 surface to build, learn,
  or version.
- **The Harness is the right seat because it already holds both halves of the label.** It knows its Agent's name and the
  iid arrives per Submission. So a line is `[<agent>] [<iid>] …` with no lookup, no correlation table, and no
  orchestrator round trip. Nothing else in the pod knows both: the Adapter sees only the Machine's event menu, and
  working-tool execution happens inside the Harness, invisible to every other j2 process there.
- **Reasoning prints; results do not.** Prompts, assistant text, thinking, and tool calls with truncated inputs. File
  contents, command output, and API responses never print. This is one cut serving two purposes, which is why it is a
  boundary and not an unfinished implementation: tool results are where the secrets are, and they are also most of the
  bytes.
- **The writer structures, the reader colorizes.** Lines carry a parseable prefix and no ANSI. jr's colors were correct
  for an fzf preview, which is a terminal; `kubectl logs` output is piped, grepped, and ingested, where escape codes are
  corruption. A future reader may colorize on `isatty`.
- **A Harness also prints the run's narrative — feed events the Orchestrator pushes to an echo endpoint.** A Workspace's
  pod log should read as the whole story of the run that owns it: not just the conversations hosted there, but the
  decisions and Emits that happened around them — a ticket claimed before the Workspace existed, a Menu pick a
  [Menu-only Agent](0031-menu-only-agents-run-on-the-instance-harness.md) made on the Instance Harness. The mechanism is
  a projection of the observation feed (ADR-0022), not a second record: the Harness wire gains one instance-token-gated
  endpoint ("print these events"), and the Orchestrator — the feed's one subscriber — tees the owning run's events to
  the enclosing Workspace's Harness. At attach it replays the run's feed-so-far (the log opens with its preamble: why
  this Workspace exists); thereafter it tees live. The Harness renders — the wire payload is the structured event, and
  printing stays this ADR's craft. Three boundaries: **markers, not mirrors** — a remotely-hosted Turn echoes its
  admission and its pick, never its transcript (the transcript prints exactly once, where the Turn ran); **fire and
  forget** — a failed echo never fails anything, the feed remains the record and the log is a courtesy view; **Emit is
  the only author API** — a workflow that wants prose in the log Emits it (ADR-0011's vocabulary discipline holds; no
  `log()` primitive exists or will).
- **Live-only, and j2 promises nothing beyond the pod.** A conversation lives exactly as long as its Harness process
  (ADR-0027), so a Sandbox teardown (ADR-0012) or a lost Workspace (ADR-0021) takes it with it — the same contract
  ADR-0012 already set for the pod-local clone. A cluster that ships logs will outlive the pod anyway; that is the log
  plane's property, not a j2 guarantee, and no j2 behavior may come to depend on it.

## Considered options

- **Per-`agentRun` containers, or a pod per Agent.** Rejected on lifetime before merit: the container list is fixed when
  the CR is created, before the body has run, while `agentRun` is a per-turn invocation. Pre-declaring per _Agent_ is
  possible but pays N resident copies of a Harness image that deliberately carries the agent toolchain (ADR-0005) to run
  one at a time. It buys no isolation — containers in a pod share the network namespace, so it does not even fix the
  port contention that motivates it (ADR-0005:31) — and the git contention it would address is prohibited anyway
  (ADR-0004:95). What it actually buys is `kubectl logs -c <agent>`: a container, to avoid a prefix.
- **A trace from the Adapter.** Tempting, and wrong on the facts. The Adapter serves the Machine's event menu and
  forwards the Agent's picks (`adapter.ts:12-14`) — a handful of deliveries per turn. The Agent's working tools execute
  in the Harness, never touching it. An Adapter trace shows `deliver: review_done` and none of the four things worth
  watching.
- **Tee the stream host-side, in the Orchestrator** (the one place holding an admission and an open stream). Genuinely
  viable, and better on governance: addressable by run, and `instanceOnly` puts it behind the band ADR-0014 already
  enforces. Rejected as the larger build for the smaller reader — it needs an API, a CLI, and a format, to serve a
  reader `kubectl` already serves. Not foreclosed: it reads the same stream, so it remains the answer if the exception
  below stops being acceptable.
- **Persist transcripts beside the run snapshot.** Rejected: the Harness already serves the stream replayable from any
  offset for the life of the pod (ADR-0027), and j2 holds the coordinates in the admission ledger (`run-host.ts:651`);
  copying the contents buys retention in exchange for owning growth, retention policy, and a redaction surface, in a
  store defaulting to sqlite.
- **Print tool results, truncated.** Rejected: the first 200 bytes of a leaked config is where the good stuff is, and
  the volume it re-admits is what kubelet's 10Mi rotation would then silently discard — losing the _start_ of a long
  turn, which is the part worth reading.

## Consequences

- **The echo does not widen ADR-0014's open band.** The echo endpoint is instance-token-gated wire, so Emit payloads may
  ride it — the tokenless observation band still carries Emit types alone. What it does widen is the pod-log surface: a
  run's narrative becomes readable by whoever can read the Workspace pod's logs, the same audience the conversation
  bullet below already grants.
- **A scoped exception to ADR-0014**, recorded there. Observation is open and everything sensitive sits behind
  `instanceOnly`; this puts an Agent's reasoning in front of whoever can read pod logs. Excluding tool results bounds it
  to what an Agent reasons aloud rather than what it happened to read. Fine on kind; a real decision on a shared
  cluster.
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
- **`j2 logs` remains a status feed** and is now more confusingly named than before. Not renamed here — this ADR adds no
  command — but the collision is real and belongs to whoever next touches that surface.
- **The visualizer's eventual extension has a source.** When it grows past the graph, it reads the same stream; a page
  is a third reader of one feed, not a third way of collecting the data.
