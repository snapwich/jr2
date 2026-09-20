# Observation is a level-triggered feed, and an API before it is a page

The visualizer never updated (2026-07-19). Not slowly — structurally, in three independent ways, and each one looked
healthy while it failed.

**New runs could not appear.** The page's run list came from a one-shot `GET /workflows/:name/runs` at boot, with a ↻
button beside it. There was no push channel to subscribe to: `RunHost` held per-**run** listener sets, and `start()`
notified nobody, because nobody existed to notify. A run started after page load was unreachable by any means short of a
reload. The ↻ button was not a convenience; it was the workaround.

**A dropped stream was permanently and invisibly fatal.** The page set `feed.onerror = () => feed.close()`, defeating
EventSource's own reconnect. `onerror` cannot distinguish a clean terminal close from a blip, so the handler had to
assume the harmless case and got the other one — after which the diagram sat there, wearing its last highlight, saying
nothing.

**Nothing wrote when nothing happened.** Every feed wrote only on transitions. A run parked on a gate for hours wrote
zero bytes, so any idle intermediary dropped the connection. This is the same gap that surfaced as `error: terminated`
on an attached `jr2 run` — undici's message for a `fetch()` body that died mid-read, which reads like a run failure and
was not one. The run was fine the whole time.

The common cause is that observation had been built as a **feature of a page** rather than as a surface. A page feature
can get away with fetching once, because a person can press a button; an API cannot. So the fix is not a page patch.

## Decision

- **The observation API is real-time, and the page is its first consumer — not its purpose.** An external dashboard, a
  CI annotator, or a chat bot should be able to track a workflow without running our HTML. Every choice below is weighed
  against that reader rather than against ours.
- **`GET /workflows/:name/events`** (open band) — one connection carrying a whole workflow: every run of it appearing,
  moving, emitting and leaving, for as long as the caller stays attached. It outlives every run on it.
- **Level-triggered, not event-sourced.** `status` always carries a whole `RunObservation`, never a patch, and the
  opening `runs` frame carries the entire live set. A reconnecting client therefore converges with **no replay buffer,
  no `Last-Event-ID`, and no per-client state on the server**; re-delivery of any frame is idempotent by construction,
  so there is no gap to detect and no cursor to resume from. Same reconciliation idiom as the Lease (ADR-0021) and
  `jr2 up` (ADR-0019): say the whole truth, repeatedly, and let the reader converge.
- **Two granularities, one vocabulary.** The per-run feed stays — tracking exactly one run is a legitimate thing to
  want, and it is what `jr2 run` and `jr2 logs -f` already do. Every run-scoped frame carries `runId` even where the
  route makes it redundant, so one parser serves both.
- **`gone` is a fact, not an inference.** A run can leave the live set _without_ a terminal status: `stop()`
  deliberately leaves the stored status `"live"` so a later `restore()` picks the run back up. A client watching for
  `status === "done"` would show a stopped run as live forever, so departure is stated outright.
- **The workflow's listener set belongs to the host**, keyed by name — not to any `LiveRun`. `persist()` clears a
  settled run's own listener set, and a workflow's watcher must survive every run it watches. Placing the set on the
  host makes that structurally true instead of a comment asking the next reader not to clear the wrong one.
- **A quiet feed pings**: an SSE comment frame every 15s, on all three feeds. It is deliberately **not** Lease
  vocabulary — CONTEXT.md puts _heartbeat_ and _keepalive_ on that entry's Avoid list, and this asserts nothing and
  expects no answer. The write doubles as the liveness probe: a failed write is how a silently-dead peer is discovered,
  which is why it is wired to the handler's exit.
- **A settled run is the client's own memory.** A run appears in the page's `settled` list iff _this page_ watched it
  leave. After a hard reload they are gone, and that is correct rather than a defect: serving a finished run's state to
  an unauthenticated reader is a read-through, which stays behind the Instance token on `/runs/:id` (ADR-0014).
- **`jr2 visualize` is deleted.** Its job was to find an orchestrator, forward a port, and open a browser. With the page
  now useful on its own, that is one `kubectl port-forward` the reader already knows how to run — and the command's
  ephemeral-fallback path was quietly forwarding to a _different_ instance than the deployed one. Its one unique piece
  of value, the opaque-states warning, moves onto the page as `MachineDoc.opaqueStates`, where the person looking at the
  diagram can read it.
- **Shutdown ends feeds explicitly.** `RunHost.close()` delivers `closed` to every listener. `server.close()` waits for
  in-flight requests and an observation feed has no end of its own, so without this a single attached watcher wedges
  `jr2 dev` shutdown indefinitely.

The new route stays _inside_ the band ADR-0014 drew: no context, no `instanceId` and no `fault` at any depth, emit type
only, scoped to one workflow the caller can already name, and no store read-through.

## Considered options

- **Poll faster.** The ↻ button on an interval. Rejected because it is wrong at both ends: too slow to watch a run by,
  and pure waste against an instance where nothing is happening — which is most of the time. It also leaves the
  `onerror` and idle-timeout failures untouched, since those are not staleness.
- **A patch/delta feed with a replay buffer.** More efficient on the wire, and genuinely wrong here: it makes every
  client stateful, forces a `Last-Event-ID` cursor and server-side retention, and turns a dropped frame into permanent
  divergence with no way to notice. A whole observation is a few hundred bytes on transitions a human is watching. We
  are nowhere near the volume that would justify buying complexity with correctness.
- **Fold the per-run feed into the workflow feed.** One route is simpler. Rejected: a consumer tracking one run would
  have to receive and discard every sibling's traffic, and `jr2 run` — the most common consumer — is exactly that case.
- **Give the page a WebSocket.** Bidirectional, and nothing here needs a back-channel; control is on the guarded
  surface, deliberately. SSE reconnects on its own, survives proxies, and needs no client library.
- **Keep `jr2 visualize`, deprecated.** Rejected as the worse of the two: a command whose whole remaining value is
  opening a browser, still carrying the port-forward path that could attach to the wrong instance.

## Consequences

- **Kill-detection latency is untouched** and remains the ~5-minute Lease poll (ADR-0021). The feed reports what the
  Orchestrator believes; a workspace lost 4 minutes ago is still believed live, and now says so in real time. Lowering
  that interval, or watching Sandbox CRs, is a separate decision.
- A body machine that ignores `workspace.lost` shows healthy on this feed for as long as it ignores it. The feed reports
  the machine; it does not second-guess it.
- The page has no reload button and no reload path for settled runs — by design, per the memory rule above.
- `viz/store.js` exists so the client's logic is a pure reducer testable under `node:test`. The repo still has no jsdom
  and no browser driver, and this ADR is not an argument for adding one: the renderer is a pure function of
  `(doc, status)`, and everything else the page believes now lives in a function that takes a store and a frame.
