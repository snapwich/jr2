// The Harness wire, served (ADR-0027): the five conversation endpoints, shaped byte-for-byte on
// the stub Harness (`packages/orchestrator/src/stub-harness.ts`, the normative model) with two
// documented divergences. First, every route is AUTHENTICATED (ADR-0058): the bearer the
// Orchestrator derives for this placement, checked before anything else, so a refusal says nothing
// about which conversations exist — the stub is a host-side test fixture and checks nothing.
// Second, a GET (either view) on an unknown conversation is 404. POST creates
// (that is admission) — except an admission for a kept conversation (`kept`, ADR-0062), which is
// 404 on an unknown one and creates nothing — and abort answers `{ aborted: false }`: the stub is inert by design, but a
// real Harness that answered a lost conversation with silence would park a re-attached wait
// forever. Plus ADR-0023's echo (`POST /echo`): the run-narrative events the Orchestrator tees
// here, rendered to this pod's stdout in the printer's idiom. Plus ADR-0063's attach
// (`POST /attach`): the Workspace's Repos into `/work`, run here instead of over `kubectl exec`.
// Plus ADR-0031's lifetime: each conversation persisted to a directory and rebuilt from it on boot,
// the Orchestrator's live set (`PUT /agents`) freeing the rest, and a drain that stops admitting.
// Plus ADR-0067's exec (`/exec/:id`): a Machine's `command` Effect, run as a child of this process.
// Plus ADR-0062's `GET /memory-kills`: the pod's guard kills.
// Turn execution and the attach are injected, so this module owns routing alone — wire tests drive it socket-free via `app.request()` and never touch
// pi.

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { AttachFault, attachFault } from "./attach.ts";
import { syncFault } from "./sync.ts";
import { Conversation, type RunSubmission, type UpdatesView } from "./conversation.ts";
import { Execs } from "./exec.ts";
import { KEPT_KILLS, killId, PodKills } from "./pod-kills.ts";
import { renderEchoEvent, type PrinterOut } from "./printer.ts";
import {
  conversationDir,
  conversationDirs,
  engineSeat,
  freeDir,
  readRecord,
  recorderAt,
  startRecord,
  type ConversationRecorder,
  type RecordFault,
  type EngineSeat,
  type RecordedConversation,
} from "./record.ts";
import {
  definitionFault,
  frameFault,
  resolveDefinition,
  type AgentDefinition,
  type ResolvedDefinition,
  type TurnDials,
} from "./spec.ts";
import {
  LIVE_LONG_POLL,
  STREAM_NEXT_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  VIEW_HISTORY,
  type AdmissionBody,
  type AdmissionRequest,
  type AttachError,
  type AttachRequest,
  type SyncAnswer,
  type SyncRequest,
  type AttachResponse,
  type ExecRequest,
  type HistoryMessage,
  type LiveConversation,
  type LiveSetResponse,
  type MemoryKillsResponse,
  type NotKeptResponse,
  type Notice,
  type PickAnswer,
} from "./wire.ts";

/** One conversation's identity and stream seam, as the app hands it to the turn factory. */
export type ConversationSeat = {
  agentName: string;
  instanceId: string;
  /** The Conversation's `appendMessage` — how the turn puts completed messages on the stream. */
  appendMessage: (message: HistoryMessage) => void;
  /** Where the engine keeps its part of the conversation, and the record it continues from when
   * that part is unreadable (ADR-0031). */
  engineSeat: EngineSeat;
};

export type HarnessAppDeps = {
  /** Build the turn executor for one conversation — `turn.ts`'s `runSubmissionFor` in
   * production (`main.ts` composes it), a stub in wire tests. */
  runSubmissionFor: (seat: ConversationSeat) => RunSubmission;
  /** Reject an admission the turn could not run — the reason, or undefined to accept. Takes the
   * RESOLVED definition (this Submission's dials already layered on), because since ADR-0049 the
   * definition and the dials arrive together and a turn runs the resolution of both: an
   * unresolvable model is caught at ADMISSION, failing the invoke as the state is entered, rather
   * than settling the Submission `failed` mid-run. Injected so this module stays pi-free
   * (`main.ts` closes it over the model registry); omitted, the model is taken on faith — which is
   * what wire tests want. The structural half of the check (`definitionFault`) needs no registry
   * and always runs. */
  checkAdmission?: (resolved: ResolvedDefinition) => string | undefined;
  /** How long a live long-poll parks before 204 "nothing yet". Default 25s (the stub's
   * cadence); short in tests. */
  longPollMs?: number;
  /**
   * Deployed as the Instance Harness (`JR2_MENU_ONLY` — deploy.ts), this process admits Menu-only
   * Agents ALONE. The admission carries its own definition (ADR-0049), so without this gate a
   * caller holding this placement's bearer could POST a `workspace: "write"` definition here and be
   * handed Working tools — code execution in the one pod ADR-0031 claims has none. The bearer
   * (ADR-0058) narrows who can try; this gate still decides what the definition may be. Placement is definition-wins; a Turn this Harness refuses runs
   * on its Workspace's Harness or nowhere. Omitted (a Sandbox's Harness), every definition admits.
   */
  menuOnly?: boolean;
  /**
   * Verify a request's bearer (ADR-0058) — every route but the unknown-route answers is gated on
   * it: admit, stream, history, abort, the echo, and the attach. The bearer is the one the Orchestrator derives
   * for THIS placement, and it must never rest in this process — the Agent has code execution in
   * the Harness container — so the check is injected: `main.ts` compares sha256(bearer) against
   * `JR2_HARNESS_TOKEN_SHA256` from the env, a digest that verifies and mints nothing. Required: a
   * Harness with no way to check a bearer is not a Harness that admits on faith.
   */
  checkBearer: (bearer: string | undefined) => boolean;
  /** Where echo lines land — the pod log (`process.stdout`) unless a test collects them. */
  echoOut?: PrinterOut;
  /** Run the attach (ADR-0063) — `attach.ts`'s `attacher()` in production, a stub in wire tests.
   * Omitted, `POST /attach` answers 501: this Harness does not attach. */
  attach?: (req: AttachRequest) => Promise<AttachResponse>;
  /** Run the sync after a push whose published commit is not the Agent's own (ADR-0067) — `sync.ts`'s `syncer()` in production. Omitted,
   * `POST /sync` answers 501. */
  sync?: (req: SyncRequest) => Promise<SyncAnswer>;
  /** The execs a `command` Effect runs as (ADR-0067) — one `Execs` per process in production.
   * Omitted, `/exec/*` answers 501: this Harness runs no command. */
  execs?: Execs;
  /** Hear the memory guard's kills (ADR-0061, layer 4) — `MemoryGuard.onKill` in production. Each
   * lands on the stream of every conversation whose Submission is running, where the Orchestrator
   * reads it and keeps a workspace notice (ADR-0062). Every kill is also kept for
   * `GET /memory-kills`, under the same id. Omitted, no kill is reported. */
  memoryKills?: (listener: (kill: { seq?: number; peak: string; limit: string }) => void) => () => void;
  /** Hear when a `bash` call returned a kill's verdict to its model — `MemoryGuard.onTold` in
   * production: the conversation goes into that kill's `told` (ADR-0062). */
  memoryTold?: (teller: (seq: number, owner: LiveConversation) => void) => () => void;
  /**
   * The directory every conversation is persisted under (ADR-0031) — `JR2_CONVERSATIONS_DIR`: the
   * Instance Harness's own PersistentVolumeClaim, a Sandbox Harness's emptyDir. Read once, when the
   * app is built, to rebuild each conversation a previous process left; written as each one goes.
   * Omitted, conversations live in memory alone and a restart loses them.
   */
  conversationsDir?: string;
  /** Where a conversation the boot cannot rebuild is said — the pod log unless a test collects it. */
  bootOut?: PrinterOut;
  /** What a record write that failed does (ADR-0031, `RecordFault`) — the pod log and exit 1 unless
   * a test catches it. */
  recordFault?: RecordFault;
};

/** The wire app, and the drain a SIGTERM runs (ADR-0031). */
export type HarnessServer = {
  app: Hono;
  /** Stop admitting — every admission answers 503 from this call on — and resolve once every
   * Submission already admitted has settled. A Turn whose only pending work is its pick's poll is
   * cut at once and settles `harness_restarted` (ADR-0031). Nothing else here bounds it: the pod's
   * termination grace is a Turn's worst case, and the kubelet ends what outlives it. */
  drain: () => Promise<void>;
};

/** The bearer token on a request, if it carries one. */
function bearerOf(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/** The five wire routes over a map of Conversations, created on POST (admission creates). */
export function harnessApp(deps: HarnessAppDeps): Hono {
  return harnessServer(deps).app;
}

/** The wire app over a map of Conversations — rebuilt from `conversationsDir` first, then created
 * on POST (admission creates) — with the drain beside it. */
export function harnessServer(deps: HarnessAppDeps): HarnessServer {
  const longPollMs = deps.longPollMs ?? 25_000;
  const root = deps.conversationsDir;
  // A record that cannot be written ends the process (ADR-0031): the restart settles what it cut,
  // and a crash loop on a full volume is louder than a Turn that never settles.
  const recordFault: RecordFault =
    deps.recordFault ??
    ((err, path) => {
      process.stderr.write(
        `harness: cannot write the conversation record ${path}: ${err instanceof Error ? err.message : String(err)} — exiting, so the restart settles what it cut (ADR-0031)\n`,
      );
      process.exit(1);
    });
  // Keyed on encoded parts: iids are hierarchical (slashes — ADR-0015), so a raw `/` join
  // could collide two conversations.
  const conversations = new Map<string, Conversation>();
  const key = (agentName: string, instanceId: string) =>
    `${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
  /** Set by the drain: the Harness is going away, and admits nothing more. */
  let draining = false;

  /** A Conversation and its turn factory — new (`recorded` omitted) or rebuilt from its record. */
  const seat = (agentName: string, instanceId: string, recorded?: RecordedConversation): Conversation => {
    const dir = root === undefined ? undefined : conversationDir(root, agentName, instanceId);
    let recorder: ConversationRecorder | undefined;
    if (root !== undefined && dir !== undefined) {
      recorder = recorded ? recorderAt(dir, recordFault) : startRecord(root, agentName, instanceId, recordFault);
    }
    // The seam is circular by nature — the turn appends to the Conversation that pumps it —
    // so the closures read the binding the next statement fills.
    let created: Conversation;
    const run = deps.runSubmissionFor({
      agentName,
      instanceId,
      appendMessage: (message) => created.appendMessage(message),
      engineSeat: engineSeat(dir, () => created.historyView().messages, recordFault),
    });
    created = recorded
      ? Conversation.rebuilt(recorded, run, recorder)
      : new Conversation(agentName, instanceId, run, recorder);
    conversations.set(key(agentName, instanceId), created);
    return created;
  };

  // The boot's rebuild (ADR-0031): every conversation a previous process persisted answers again,
  // its in-flight Submissions settled `failed`. One that cannot be read is said and skipped — a
  // GET on it is the 404 of a conversation that is gone, which the Orchestrator already handles
  // (ADR-0021: a `conversation-new` notice); its directory goes on the next live-set statement
  // or the next admission to its key.
  if (root !== undefined) {
    for (const dir of conversationDirs(root)) {
      try {
        const recorded = readRecord(dir);
        seat(recorded.agentName, recorded.instanceId, recorded);
      } catch (err) {
        (deps.bootOut ?? process.stderr).write(
          `harness: conversation at ${dir} is unreadable, not rebuilt: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
  // One guard per process, one subscription per app: a kill is the whole container's, so every
  // conversation hears it, and each says it only if its Submission was running. The kill gets ONE
  // id here, and the pod keeps every kill under it for `GET /memory-kills`: a wait that stopped
  // before it read the event (its Agent's state exited) must not lose it, and the id makes a kill
  // read on both paths one notice. A conversation goes into the kill's `told` when its `bash` call
  // RETURNS the verdict to the model — not when the guard fires, since a call cut short told no
  // one (ADR-0062). The Instance Harness keeps none: it holds no Workspace, and a Menu-only Agent
  // hears conversation notices alone.
  const kills = deps.menuOnly ? undefined : new PodKills(root);
  /** The guard's number for each recent kill, to its id — as many as the pod keeps. */
  const idOfSeq = new Map<number, string>();
  deps.memoryKills?.((kill) => {
    const at = new Date();
    const id = killId(at);
    if (kill.seq !== undefined) {
      idOfSeq.set(kill.seq, id);
      for (const seq of idOfSeq.keys()) if (idOfSeq.size > KEPT_KILLS) idOfSeq.delete(seq);
    }
    // Kept first: a reader that sees the event on a stream can then always find it in the list.
    kills?.keep({ id, at: at.toISOString(), peak: kill.peak, limit: kill.limit, told: [] });
    for (const conversation of conversations.values()) {
      conversation.reportMemoryLimit({ id, peak: kill.peak, limit: kill.limit });
    }
  });
  deps.memoryTold?.((seq, owner) => {
    const id = idOfSeq.get(seq);
    if (id !== undefined) kills?.tell(id, owner);
  });

  const app = new Hono();

  // The gate (ADR-0058), ahead of every route that names a conversation or prints: a caller without
  // this placement's bearer learns nothing — not whether a conversation exists (401 before 404),
  // and a refused admission creates none.
  const gate: MiddlewareHandler = async (c, next) => {
    if (!deps.checkBearer(bearerOf(c))) return c.json({ error: "unauthorized" }, 401);
    return next();
  };
  app.use("/agents", gate);
  app.use("/agents/*", gate);
  app.use("/echo", gate);
  app.use("/attach", gate);
  app.use("/sync", gate);
  app.use("/exec/*", gate);
  app.use("/memory-kills", gate);

  /** The process's execs, or the refusal a Harness that runs none answers. */
  const execsOrRefusal = (c: Context): Execs | Response => {
    if (deps.menuOnly) {
      return c.json(
        { error: "this is the Instance Harness, which holds no Workspace — no command runs here (ADR-0031)" },
        403,
      );
    }
    return deps.execs ?? c.json({ error: "this Harness runs no command (ADR-0067)" }, 501);
  };

  // Readiness (ADR-0063): the probe asks THIS route, not the port. A pod has one network
  // namespace, so another container that takes the Harness's port answers a socket probe and
  // the pod goes Ready with no Harness in it (the scaling review's R16: an nginx on :8080 turned
  // the attach into its 404 page). Ungated and content-free — it says only "the Harness is
  // serving", which a bearer-less caller may know — and a draining Harness still answers it, so
  // the pod stays Ready while it finishes its Turns (ADR-0031).
  app.get("/healthz", (c) => c.body(null, 204));

  app.post("/agents/:name/:id", async (c) => {
    // The drain (ADR-0031): a Submission admitted now would outlive the process. Refused before
    // anything is read or created, so a 503 guarantees nothing was queued — the Orchestrator sends
    // the same admission again (harness-client.ts). `/healthz` keeps answering, so the pod stays
    // Ready while it drains: this 503 is the signal, not readiness.
    // It closes the connection, so the re-sent admission dials the Service anew rather than
    // reaching this Harness again over a kept-alive socket.
    if (draining) {
      return c.json(
        {
          error:
            "the Harness is draining for shutdown: it admits nothing more, and the Submissions it holds " +
            "are settling (ADR-0031) — admit again once its replacement serves",
        },
        503,
        { connection: "close" },
      );
    }
    const agentName = c.req.param("name");
    const instanceId = c.req.param("id");
    const sent = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // The definition rides the admission (ADR-0049), so it is checked HERE, per Submission —
    // there is no boot-time roster left to check it in. Loud and named: the 400 quotes the slot
    // the Machine declared, which is the name the author wrote.
    const fault = definitionFault(agentName, sent?.definition);
    if (fault) return c.json({ error: fault }, 400);
    // The Frame is checked beside it, and for the opposite reason to the dials below: a Turn whose
    // `cwd` was dropped runs in the wrong directory and says nothing (ADR-0057).
    const framing = frameFault(agentName, sent);
    if (framing) return c.json({ error: framing }, 400);
    const submission = admissionRequest(sent, sent?.definition as AgentDefinition);
    const resolved = resolveDefinition(submission.definition, submission);
    // The Instance Harness placement gate (ADR-0031): identity precedes dials. Checked against
    // the definition this admission carries (default "write" — ADR-0028), so the refusal holds
    // from the very first POST and no non-"none" conversation can ever exist here.
    if (deps.menuOnly && resolved.workspace !== "none") {
      return c.json(
        {
          error:
            `agent "${agentName}" has workspace: "${resolved.workspace}" — this is the Instance Harness, which ` +
            `admits Menu-only Agents alone (ADR-0031); a "${resolved.workspace}" Turn runs on its Workspace's Harness`,
        },
        403,
      );
    }
    // Before the lookup on purpose: a rejected admission must not leave an empty conversation
    // (and therefore a live turn factory) behind for an iid that never ran.
    const badRun = deps.checkAdmission?.(resolved);
    if (badRun) return c.json({ error: `agent "${agentName}": ${badRun}` }, 400);
    const known = conversations.get(key(agentName, instanceId));
    // An admission onto a conversation the Orchestrator was told this Harness keeps (ADR-0062).
    // When it keeps none (the restart did not read it back), a new one seated here would run a
    // prompt that says "continue" on an empty context. The 404 seats nothing: the Orchestrator then
    // admits a Turn with its task and the notice that the conversation is new.
    if ((sent as Partial<AdmissionBody> | undefined)?.kept === true && known === undefined) {
      return c.json<NotKeptResponse>(
        {
          kept: false,
          error:
            `no conversation "${instanceId}" for agent "${agentName}" — this Harness does not keep it, and the ` +
            `admission was for a kept conversation (ADR-0062)`,
        },
        404,
      );
    }
    const conversation = known ?? seat(agentName, instanceId);
    const admission = conversation.admit(submission);
    // The Conversation mints a relative streamUrl; the wire's is absolute (the stub's shape).
    return c.json({ ...admission, streamUrl: `${new URL(c.req.url).origin}${admission.streamUrl}` });
  });

  app.get("/agents/:name/:id", async (c) => {
    const conversation = conversations.get(key(c.req.param("name"), c.req.param("id")));
    if (!conversation) {
      return c.json(
        { error: `no conversation "${c.req.param("id")}" for agent "${c.req.param("name")}" — POST admits (ADR-0027)` },
        404,
      );
    }
    if (c.req.query("view") === VIEW_HISTORY) return c.json(conversation.historyView());
    const offset = c.req.query("offset") ?? "0";
    if (c.req.query("live") === LIVE_LONG_POLL) {
      const view = await conversation.waitForEvent(offset, longPollMs);
      if (view.events.length === 0) return c.body(null, 204, streamHeaders(view));
      return c.json(view.events, 200, streamHeaders(view));
    }
    const view = conversation.updatesView(offset);
    return c.json(view.events, 200, streamHeaders(view));
  });

  app.post("/agents/:name/:id/abort", (c) => {
    const conversation = conversations.get(key(c.req.param("name"), c.req.param("id")));
    return c.json(conversation ? conversation.abort() : { aborted: false });
  });

  // The live set (ADR-0031): the Orchestrator names every conversation its live runs hold, and
  // this Harness frees the memory and the directory of every other one — except a busy one, kept
  // until it settles and freed by the next statement. Directories the boot could not rebuild are
  // not in the map, so no statement can name them: they go too.
  app.put("/agents", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { live?: unknown } | undefined;
    const live = liveSetOf(body?.live);
    if (!live) {
      return c.json(
        {
          error:
            "live-set body must be { live: [{ agent, instanceId }, ...] } — every conversation a live run holds (ADR-0031)",
        },
        400,
      );
    }
    const held = new Set(live.map((conversation) => key(conversation.agent, conversation.instanceId)));
    let freed = 0;
    for (const [k, conversation] of conversations) {
      if (held.has(k) || conversation.busy) continue;
      conversations.delete(k);
      if (root !== undefined) freeDir(conversationDir(root, conversation.agentName, conversation.instanceId));
      freed++;
    }
    if (root !== undefined) {
      const kept = new Set(
        [...conversations.values()].map((conversation) =>
          conversationDir(root, conversation.agentName, conversation.instanceId),
        ),
      );
      for (const dir of conversationDirs(root)) {
        if (kept.has(dir)) continue;
        freeDir(dir);
        freed++;
      }
    }
    return c.json<LiveSetResponse>({ freed });
  });

  // The run-narrative echo (ADR-0023): "print these events". The body is the STRUCTURED feed —
  // rendering is this side's craft (printer.ts), so the wire never carries preformatted strings.
  // Rendering is total: an event the renderer does not recognize prints nothing and fails
  // nothing, because the log is a courtesy view and the feed remains the record. Gated like the
  // conversation routes, on the same bearer (ADR-0058) — the Instance token no longer travels here.
  app.post("/echo", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { events?: unknown } | undefined;
    if (!body || !Array.isArray(body.events)) {
      return c.json({ error: "echo body must be { events: [...] } — the structured feed events (ADR-0023)" }, 400);
    }
    const out = deps.echoOut ?? process.stdout;
    let printed = 0;
    for (const event of body.events) {
      for (const line of renderEchoEvent(event)) {
        out.write(`${line}\n`);
        printed++;
      }
    }
    return c.json({ printed });
  });

  // The attach (ADR-0063): the Workspace's Repos into `/work` — jr2's own work in the container
  // ADR-0005 gives it, not a conversation. Validated here, so a malformed body runs no git; a step
  // that fails answers 500 with the slot and git's own stderr, which the Orchestrator surfaces as
  // the provision's error.
  app.post("/attach", async (c) => {
    // The Instance Harness has no `/work` and no Repos: a Menu-only placement (ADR-0031).
    if (deps.menuOnly) {
      return c.json<AttachError>(
        { error: "this is the Instance Harness, which holds no Workspace — nothing attaches here (ADR-0031)" },
        403,
      );
    }
    if (!deps.attach) return c.json<AttachError>({ error: "this Harness does not attach (ADR-0063)" }, 501);
    const body = await c.req.json().catch(() => undefined);
    const fault = attachFault(body);
    if (fault) return c.json<AttachError>({ error: fault }, 400);
    try {
      return c.json(await deps.attach(body as AttachRequest));
    } catch (err) {
      const slot = err instanceof AttachFault ? err.slot : undefined;
      const error = err instanceof Error ? err.message : String(err);
      return c.json<AttachError>({ error, ...(slot !== undefined ? { slot } : {}) }, 500);
    }
  });

  // The sync (ADR-0067): after a push whose published commit is not the Agent's own, the Agent's
  // branch moves to the published commits — one ref, by compare-and-swap, under a clean git config. Its answer is a report; the next push
  // trusts none of it. The Instance Harness holds no Workspace, so it syncs nothing (ADR-0031).
  app.post("/sync", async (c) => {
    if (deps.menuOnly) {
      return c.json(
        { error: "this is the Instance Harness, which holds no Workspace — nothing syncs here (ADR-0031)" },
        403,
      );
    }
    if (!deps.sync) return c.json({ error: "this Harness does not sync (ADR-0067)" }, 501);
    const body = await c.req.json().catch(() => undefined);
    const fault = syncFault(body);
    if (fault) return c.json({ error: fault }, 400);
    return c.json(await deps.sync(body as SyncRequest));
  });

  // The exec (ADR-0067): a Machine's `command` Effect, run here as a child of this process — the
  // Agent's user and its Stand-ins, never a shell. Named by the Effect's id, so a second start of a
  // known id runs nothing; read by offset, long-polled like a stream; killed with its process group
  // when its state exits. The Instance Harness holds no Workspace, so it runs none (ADR-0031).
  app.post("/exec/:id", async (c) => {
    const execs = execsOrRefusal(c);
    if (!(execs instanceof Execs)) return execs;
    const body = await c.req.json().catch(() => undefined);
    const fault = execFault(body);
    if (fault) return c.json({ error: fault }, 400);
    return c.json(
      { id: c.req.param("id") },
      execs.start(c.req.param("id"), body as ExecRequest) === "started" ? 201 : 200,
    );
  });
  app.get("/exec/:id", async (c) => {
    const execs = execsOrRefusal(c);
    if (!(execs instanceof Execs)) return execs;
    const raw = c.req.query("offset");
    const offset = raw === undefined ? undefined : Number(raw);
    if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0)) {
      return c.json({ error: `offset must be a whole number, got ${raw}` }, 400);
    }
    const read = await execs.read(c.req.param("id"), {
      ...(offset !== undefined ? { offset } : {}),
      waitMs: c.req.query("live") === LIVE_LONG_POLL ? longPollMs : 0,
    });
    return read === undefined ? c.json({ error: "no such exec" }, 404) : c.json(read);
  });
  app.post("/exec/:id/kill", (c) => {
    const execs = execsOrRefusal(c);
    if (!(execs instanceof Execs)) return execs;
    // Never 404: an id not seen yet is killed before its start (exec.ts), so a kill is always kept.
    return c.json({ killed: execs.kill(c.req.param("id")) });
  });
  app.delete("/exec/:id", (c) => {
    const execs = execsOrRefusal(c);
    if (!(execs instanceof Execs)) return execs;
    execs.forget(c.req.param("id"));
    return c.body(null, 204);
  });

  // The pod's guard kills (ADR-0061, ADR-0062): the Orchestrator reads them before it admits a Turn
  // into this Workspace, and keeps a notice for each id it has not seen. A read changes nothing, so
  // a read again after a restart of either side is safe.
  app.get("/memory-kills", (c) => {
    if (!kills) {
      return c.json(
        { error: "this is the Instance Harness, which holds no Workspace — it keeps no memory kill (ADR-0031)" },
        403,
      );
    }
    return c.json<MemoryKillsResponse>({ kills: kills.list() });
  });

  // Registered after the handlers, so only methods the wire does not speak land here (the
  // stub's 405). Not on the abort path: the stub answers a GET there 404, and so does this.
  app.all("/agents/:name/:id", (c) => c.json({ error: `harness: ${c.req.method} not supported` }, 405));

  app.notFound((c) => c.json({ error: `harness: no route ${new URL(c.req.url).pathname}` }, 404));

  const drain = async (): Promise<void> => {
    draining = true;
    // A conversation's drain waits out its queue as well: those Submissions were admitted, so the
    // drain owes them their Turns exactly as it owes the running one — except a Turn that waits
    // only on its pick's answer, which it cuts at once (`Conversation.drain`).
    await Promise.all([...conversations.values()].map((conversation) => conversation.drain()));
  };

  return { app, drain };
}

/** The live set's conversations, or undefined for a body that is not one. All-or-nothing: a
 * statement that cannot be read whole frees nothing, because freeing on half a list would free
 * what the other half holds. */
function liveSetOf(value: unknown): LiveConversation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const live: LiveConversation[] = [];
  for (const entry of value) {
    const { agent, instanceId } = (entry ?? {}) as Record<string, unknown>;
    if (typeof agent !== "string" || typeof instanceId !== "string") return undefined;
    live.push({ agent, instanceId });
  }
  return live;
}

/** The admit body, taken defensively where defaulting is honest: a missing/garbage `message`
 * admits an empty prompt, and a non-string dial is dropped rather than passed on as one. The
 * `definition` and the Frame's `cwd` are passed in already validated (`definitionFault` and
 * `frameFault` ran first): a turn cannot be defaulted into existence the way a missing prompt
 * can, and a defaulted `cwd` is the silent wrong directory ADR-0057 refuses. */
function admissionRequest(body: unknown, definition: AgentDefinition): AdmissionRequest {
  const sent = (body ?? {}) as Record<string, unknown>;
  return {
    definition,
    message: typeof sent.message === "string" ? sent.message : "",
    ...(typeof sent.cwd === "string" ? { cwd: sent.cwd } : {}),
    ...(typeof sent.model === "string" ? { model: sent.model } : {}),
    ...(typeof sent.thinkingLevel === "string"
      ? { thinkingLevel: sent.thinkingLevel as TurnDials["thinkingLevel"] }
      : {}),
    ...noticesOf(sent.notices),
  };
}

/** The admission's notices (ADR-0062), kept where this Harness can word them. A kind it does not
 * know is a newer Orchestrator's — skew (ADR-0027) — and a notice missing its facts cannot be said
 * truly; both are dropped rather than rendered as half a sentence. Garbage in the slot is none. */
function noticesOf(value: unknown): { notices?: Notice[] } {
  if (!Array.isArray(value)) return {};
  const str = (v: unknown) => typeof v === "string";
  const notices = value.filter((n: unknown): n is Notice => {
    if (typeof n !== "object" || n === null) return false;
    const { kind, scope, agent, peak, limit, reason } = n as Record<string, unknown>;
    if (kind === "memory-limit") {
      // No `agent`: every kill read from the pod's list names no Turn.
      return (
        scope === "workspace" &&
        (agent === undefined || str(agent)) &&
        (limit === undefined ? peak === undefined : str(limit)) &&
        (peak === undefined || str(peak))
      );
    }
    if (kind === "pick-answer") {
      const { pick, cut, answer, stopped } = n as Record<string, unknown>;
      return (
        scope === "conversation" &&
        str(pick) &&
        typeof cut === "boolean" &&
        isPickAnswer(answer) &&
        (stopped === undefined || stopped === true)
      );
    }
    return kind === "conversation-new" && scope === "conversation" && str(reason);
  });
  return notices.length > 0 ? { notices } : {};
}

/** A pick answer's facts this Harness can word (ADR-0024, ADR-0067): absent (no reply came), a
 * party's event with its payload, a child's output, or what the Machine's `answer` action set. */
function isPickAnswer(value: unknown): value is PickAnswer | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const { kind, event, payload, sender, actor } = value as Record<string, unknown>;
  if (kind === "output") return typeof actor === "string" && "output" in value;
  if (kind === "answer") return "value" in value;
  if (kind !== "event" || typeof event !== "string") return false;
  if (typeof payload !== "object" || payload === null) return false;
  if (sender === undefined) return true;
  if (typeof sender !== "object" || sender === null) return false;
  const { party, id } = sender as Record<string, unknown>;
  return (party === "agent" || party === "gate") && typeof id === "string";
}

/** Why a body is not an `ExecRequest`, or undefined. argv is a non-empty list of strings — never a
 * string, which a shell would read; a `cwd` is absolute, as a Turn's Frame is (ADR-0057). */
function execFault(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return "the body is not an exec request";
  const { argv, cwd, timeoutMs, tail } = body as Record<string, unknown>;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
    return "argv must be a non-empty list of strings — each one argument, never shell text";
  }
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/"))) return "cwd must be an absolute path";
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) return "timeoutMs must be a positive number";
  if (typeof tail !== "number" || !(tail >= 0)) return "tail must be a number, 0 or more";
  return undefined;
}

function streamHeaders(view: UpdatesView): Record<string, string> {
  return {
    [STREAM_NEXT_OFFSET_HEADER]: view.nextOffset,
    [STREAM_UP_TO_DATE_HEADER]: String(view.upToDate),
  };
}
