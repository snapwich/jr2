// The Harness wire, served (ADR-0027): the five conversation endpoints, shaped byte-for-byte on
// the stub Harness (`packages/orchestrator/src/stub-harness.ts`, the normative model) with the
// one documented divergence — a GET (either view) on an unknown conversation is 404. POST creates
// (that is admission), abort answers `{ aborted: false }`: the stub is inert by design, but a
// real Harness that answered a lost conversation with silence would park a re-attached wait
// forever. Plus ADR-0023's echo (`POST /echo`): the run-narrative events the Orchestrator tees
// here, rendered to this pod's stdout in the printer's idiom. Turn execution is injected, so this
// module owns routing alone — wire tests drive it socket-free via `app.request()` and never touch
// pi.

import { Hono } from "hono";
import type { Context } from "hono";
import { Conversation, type RunSubmission, type UpdatesView } from "./conversation.ts";
import { renderEchoEvent, type PrinterOut } from "./printer.ts";
import type { AgentsSpec, TurnDials } from "./spec.ts";
import {
  LIVE_LONG_POLL,
  STREAM_NEXT_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  VIEW_HISTORY,
  type AdmissionRequest,
  type HistoryMessage,
} from "./wire.ts";

/** One conversation's identity and stream seam, as the app hands it to the turn factory. */
export type ConversationSeat = {
  agentName: string;
  instanceId: string;
  /** The Conversation's `appendMessage` — how the turn puts completed messages on the stream. */
  appendMessage: (message: HistoryMessage) => void;
};

export type HarnessAppDeps = {
  spec: AgentsSpec;
  /** Build the turn executor for one conversation — `turn.ts`'s `runSubmissionFor` in
   * production (`main.ts` composes it), a stub in wire tests. */
  runSubmissionFor: (seat: ConversationSeat) => RunSubmission;
  /** Reject an admission whose dials cannot run — the reason, or undefined to accept. A call-site
   * model is invisible to the boot check (`main.ts`), so this is where an unresolvable one is
   * caught: at ADMISSION, failing the invoke as the state is entered, rather than settling the
   * Submission `failed` mid-run. Injected so this module stays pi-free (`main.ts` closes it over
   * the model registry); omitted, dials are taken on faith — which is what wire tests want. */
  checkDials?: (dials: TurnDials) => string | undefined;
  /** How long a live long-poll parks before 204 "nothing yet". Default 25s (the stub's
   * cadence); short in tests. */
  longPollMs?: number;
  /**
   * Deployed as the Instance Harness (`J2_MENU_ONLY` — deploy.ts), this process admits Menu-only
   * Agents ALONE. The wire is unauthenticated in-cluster and the mounted spec is the full
   * agents.json (same ConfigMap, ADR-0031), so without this gate any in-cluster caller could POST
   * a `workspace: "write"` definition here and be handed Working tools — code execution in the one
   * pod ADR-0031 claims has none. Placement is definition-wins; a Turn this Harness refuses runs
   * on its Workspace's Harness or nowhere. Omitted (a Sandbox's Harness), every definition admits.
   */
  menuOnly?: boolean;
  /**
   * Verify an echo bearer (ADR-0023): the endpoint is INSTANCE-token-gated, but the raw token
   * must never enter this process — the Agent has code execution in the Harness container
   * (tokens.ts: "it never enters a Sandbox") — so the check is injected: `main.ts` compares
   * sha256(bearer) against `J2_ECHO_TOKEN_SHA256` from the env. Omitted, the endpoint refuses
   * everything (403): a Harness nobody equipped prints no narrative, and the pushing side is
   * fire-and-forget about it.
   */
  checkEchoBearer?: (bearer: string | undefined) => boolean;
  /** Where echo lines land — the pod log (`process.stdout`) unless a test collects them. */
  echoOut?: PrinterOut;
};

/** The bearer token on a request, if it carries one. */
function bearerOf(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/** The five wire routes over a map of Conversations, created on POST (admission creates). */
export function harnessApp(deps: HarnessAppDeps): Hono {
  const longPollMs = deps.longPollMs ?? 25_000;
  // Keyed on encoded parts: iids are hierarchical (slashes — ADR-0015), so a raw `/` join
  // could collide two conversations.
  const conversations = new Map<string, Conversation>();
  const key = (agentName: string, instanceId: string) =>
    `${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;

  const app = new Hono();

  app.post("/agents/:name/:id", async (c) => {
    const agentName = c.req.param("name");
    const instanceId = c.req.param("id");
    const submission = admissionRequest(await c.req.json().catch(() => undefined));
    // The Instance Harness placement gate (ADR-0031): identity precedes dials. Checked against
    // the definition (default "write" — ADR-0028), not the conversation map, so the refusal
    // holds from the very first POST and no non-"none" conversation can ever exist here. An
    // unknown agent falls through to the 404 below.
    if (deps.menuOnly) {
      const definition = deps.spec.agents.find((a) => a.name === agentName)?.definition;
      const access = definition?.workspace ?? "write";
      if (definition && access !== "none") {
        return c.json(
          {
            error:
              `agent "${agentName}" has workspace: "${access}" — this is the Instance Harness, which ` +
              `admits Menu-only Agents alone (ADR-0031); a "${access}" Turn runs on its Workspace's Harness`,
          },
          403,
        );
      }
    }
    // Before the lookup on purpose: a rejected admission must not leave an empty conversation
    // (and therefore a live turn factory) behind for an iid that never ran.
    const badDials = deps.checkDials?.(submission);
    if (badDials) return c.json({ error: badDials }, 400);
    let conversation = conversations.get(key(agentName, instanceId));
    if (!conversation) {
      if (!deps.spec.agents.some((a) => a.name === agentName)) {
        return c.json(
          { error: `agent "${agentName}" is not in the mounted spec — no definition to serve (ADR-0018)` },
          404,
        );
      }
      // The seam is circular by nature — the turn appends to the Conversation that pumps it —
      // so the closure reads the binding the next statement fills.
      let created: Conversation;
      const run = deps.runSubmissionFor({
        agentName,
        instanceId,
        appendMessage: (message) => created.appendMessage(message),
      });
      created = new Conversation(agentName, instanceId, run);
      conversation = created;
      conversations.set(key(agentName, instanceId), conversation);
    }
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

  // The run-narrative echo (ADR-0023): "print these events". The body is the STRUCTURED feed —
  // rendering is this side's craft (printer.ts), so the wire never carries preformatted strings.
  // Rendering is total: an event the renderer does not recognize prints nothing and fails
  // nothing, because the log is a courtesy view and the feed remains the record.
  app.post("/echo", async (c) => {
    if (!deps.checkEchoBearer) {
      return c.json({ error: "echo is not enabled on this harness (no J2_ECHO_TOKEN_SHA256 in its environment)" }, 403);
    }
    if (!deps.checkEchoBearer(bearerOf(c))) return c.json({ error: "unauthorized" }, 401);
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

  // Registered after the handlers, so only methods the wire does not speak land here (the
  // stub's 405). Not on the abort path: the stub answers a GET there 404, and so does this.
  app.all("/agents/:name/:id", (c) => c.json({ error: `harness: ${c.req.method} not supported` }, 405));

  app.notFound((c) => c.json({ error: `harness: no route ${new URL(c.req.url).pathname}` }, 404));

  return app;
}

/** The admit body, taken defensively: a missing/garbage `message` admits an empty prompt (the
 * pre-dials behavior), and a non-string dial is dropped rather than passed on as one. */
function admissionRequest(body: unknown): AdmissionRequest {
  const sent = (body ?? {}) as Record<string, unknown>;
  return {
    message: typeof sent.message === "string" ? sent.message : "",
    ...(typeof sent.model === "string" ? { model: sent.model } : {}),
    ...(typeof sent.thinkingLevel === "string"
      ? { thinkingLevel: sent.thinkingLevel as TurnDials["thinkingLevel"] }
      : {}),
  };
}

function streamHeaders(view: UpdatesView): Record<string, string> {
  return {
    [STREAM_NEXT_OFFSET_HEADER]: view.nextOffset,
    [STREAM_UP_TO_DATE_HEADER]: String(view.upToDate),
  };
}
