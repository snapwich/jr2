// The Harness wire, served (ADR-0027): the five conversation endpoints, shaped byte-for-byte on
// the stub Harness (`packages/orchestrator/src/stub-harness.ts`, the normative model) with two
// documented divergences. First, every route is AUTHENTICATED (ADR-0058): the bearer the
// Orchestrator derives for this placement, checked before anything else, so a refusal says nothing
// about which conversations exist — the stub is a host-side test fixture and checks nothing.
// Second, a GET (either view) on an unknown conversation is 404. POST creates
// (that is admission), abort answers `{ aborted: false }`: the stub is inert by design, but a
// real Harness that answered a lost conversation with silence would park a re-attached wait
// forever. Plus ADR-0023's echo (`POST /echo`): the run-narrative events the Orchestrator tees
// here, rendered to this pod's stdout in the printer's idiom. Plus ADR-0063's attach
// (`POST /attach`): the Workspace's Repos into `/work`, run here instead of over `kubectl exec`.
// Plus ADR-0031's lifetime: each conversation persisted to a directory and rebuilt from it on boot,
// the Orchestrator's live set (`PUT /agents`) freeing the rest, and a drain that stops admitting.
// Turn execution and the attach are injected, so this module owns routing alone — wire tests drive it socket-free via `app.request()` and never touch
// pi.

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { AttachFault, attachFault } from "./attach.ts";
import { Conversation, type RunSubmission, type UpdatesView } from "./conversation.ts";
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
  type AdmissionRequest,
  type AttachError,
  type AttachRequest,
  type AttachResponse,
  type HistoryMessage,
  type LiveConversation,
  type LiveSetResponse,
  type Notice,
} from "./wire.ts";

/** One conversation's identity and stream seam, as the app hands it to the turn factory. */
export type ConversationSeat = {
  agentName: string;
  instanceId: string;
  /** The Conversation's `appendMessage` — how the turn puts completed messages on the stream. */
  appendMessage: (message: HistoryMessage) => void;
  /** Where the engine keeps its part of the conversation, and the record it continues from when
   * that part is unreadable (ADR-0031). */
  engine: EngineSeat;
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
  /** Hear the memory guard's kills (ADR-0061, layer 4) — `MemoryGuard.onKill` in production. Each
   * lands on the stream of every conversation whose Submission is running, where the Orchestrator
   * reads it and keeps a workspace notice (ADR-0062). Omitted, no kill is reported. */
  memoryKills?: (listener: (kill: { peak: string; limit: string }) => void) => () => void;
  /**
   * The directory every conversation is persisted under (ADR-0031) — `JR2_CONVERSATIONS_DIR`: the
   * Instance Harness's own PersistentVolumeClaim, a Sandbox Harness's emptyDir. Read once, when the
   * app is built, to rebuild each conversation a previous process left; written as each one goes.
   * Omitted, conversations live in memory alone and a restart loses them.
   */
  conversationsDir?: string;
  /** Where a conversation the boot cannot rebuild is said — the pod log unless a test collects it. */
  bootOut?: PrinterOut;
};

/** The wire app, and the drain a SIGTERM runs (ADR-0031). */
export type HarnessServer = {
  app: Hono;
  /** Stop admitting — every admission answers 503 from this call on — and resolve once every
   * Submission already admitted has settled. Nothing here bounds it: the pod's termination grace
   * is a Turn's worst case, and the kubelet ends what outlives it. */
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
      recorder = recorded ? recorderAt(dir) : startRecord(root, agentName, instanceId);
    }
    // The seam is circular by nature — the turn appends to the Conversation that pumps it —
    // so the closures read the binding the next statement fills.
    let created: Conversation;
    const run = deps.runSubmissionFor({
      agentName,
      instanceId,
      appendMessage: (message) => created.appendMessage(message),
      engine: engineSeat(dir, () => created.historyView().messages),
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
  // conversation hears it, and each says it only if its Submission was running.
  deps.memoryKills?.((kill) => {
    for (const conversation of conversations.values()) conversation.reportMemoryLimit(kill);
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

  app.post("/agents/:name/:id", async (c) => {
    // The drain (ADR-0031): a Submission admitted now would outlive the process. Refused before
    // anything is read or created, so a 503 guarantees nothing was queued — the Orchestrator sends
    // the same admission again (harness-client.ts). The readiness probe is the socket (deploy.ts,
    // the operator), so the pod stays Ready while it drains: this 503 is the signal, not readiness.
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
    const conversation = conversations.get(key(agentName, instanceId)) ?? seat(agentName, instanceId);
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

  // Registered after the handlers, so only methods the wire does not speak land here (the
  // stub's 405). Not on the abort path: the stub answers a GET there 404, and so does this.
  app.all("/agents/:name/:id", (c) => c.json({ error: `harness: ${c.req.method} not supported` }, 405));

  app.notFound((c) => c.json({ error: `harness: no route ${new URL(c.req.url).pathname}` }, 404));

  const drain = async (): Promise<void> => {
    draining = true;
    // A conversation's idle waits out its queue as well: those Submissions were admitted, so the
    // drain owes them their Turns exactly as it owes the running one.
    await Promise.all([...conversations.values()].map((conversation) => conversation.idle()));
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
      return scope === "workspace" && str(agent) && str(limit) && (peak === undefined || str(peak));
    }
    return kind === "conversation-new" && scope === "conversation" && str(reason);
  });
  return notices.length > 0 ? { notices } : {};
}

function streamHeaders(view: UpdatesView): Record<string, string> {
  return {
    [STREAM_NEXT_OFFSET_HEADER]: view.nextOffset,
    [STREAM_UP_TO_DATE_HEADER]: String(view.upToDate),
  };
}
