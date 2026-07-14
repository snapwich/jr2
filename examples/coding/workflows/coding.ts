// DESIGN ARTIFACT — this workflow does NOT run yet. It models jr's `start-work` orchestration
// (~/repos/jr) as a j2 Machine, written against the API j2 *should* have. This is a VALIDATION
// exercise: can j2 express an existing user workflow (jr's) faithfully? It is not a redesign of
// that workflow. `GAP(n)` markers flag surface j2 does not have today; legend at the bottom.
//
// The settled model (grill session 2026-07-11):
//
//   * j2 ships MECHANISMS, zero policy. No built-in events: `defineEvent` lets the workflow
//     declare its own (request_review, approve, ...); j2 provides only definition, transport,
//     validation, and delivery. `@j2/agent-protocol`'s CALLBACK_TOOLS demotes to an example set.
//   * Events bind to STATES via the actor that exposes them. The agent actor registers its
//     `tools` as MCP tools for its iid — handlers close over that invocation's `sendBack`, so a
//     tool call fires a transition on exactly the state that invoked the agent. `gate` is the
//     same primitive over HTTP for ANY external caller (humans via j2 send/UI, webhooks, CI):
//     each invocation is an addressable gate resource; POST /runs/:id/gates/:gate/events
//     delivers validated events into that state; leaving the state destroys the gate.
//     No routing exists anywhere — binding is the closure; the shared HTTP listener is a demux
//     implementation detail (paths are per-iid because pods need a URL to call back).
//   * Everything is statically imported. Actor logic is code; everything live is constructed
//     per-invocation from serializable input (e.g. the flue client from `input.endpoint`).
//   * `workspace(body, spec)` concerns itself ONLY with workspace things: create the Sandbox,
//     attach the right repos/worktree, hand the body the locations, destroy when the body
//     reaches final. Getting commits OUT (push, PR) is the workflow's business, not workspace's.
//     A body that parks (escalation, human review) keeps its Sandbox alive by construction.
//   * The ticket system stays jr's tk, hierarchy unchanged (features, linear task chains,
//     assignees, notes). The workflow owns plain actors that call tk — j2 has no work-source
//     abstraction in the loop. Ready-set is re-queried, never materialized.
//
//   jr                                         j2
//   -----------------------------------------  --------------------------------------------------
//   `just start-work` bash loop                the top Machine, one durable run
//   discover(): tk ready each pass             `discover` state re-querying a tk actor
//   one-agent-per-worktree symlink lock        structural: one sequential body per feature
//   signals parsed from ticket notes           workflow-defined events over MCP tools
//   `just approve` / `request-changes`         gate accepts: [approve, requestChanges]
//   session-history.jsonl resume prompts       flue Instance ID continuity (same iid = same convo)
//   JR_MAX_CONCURRENT / REVIEW_ROUNDS / RESUME context knobs on the run's input
//   exit 0 / 2 / 3 + terminal bell             final `allDone` / parked states + emit("attention")
//   worktrees persist on host; merge-all later commits leave via push + PR before humanReview

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assign, emit, enqueueActions, fromPromise, setup, stopChild } from "xstate";
import { z } from "zod";
// GAP(1): the event primitive — pure def factory + typed delivery (EventFrom derives unions).
import { defineEvent, type EventFrom } from "@j2/agent-protocol";
// GAP(2,3,4): agent actor v2 (endpoint+tools input), workspace factory, external gate actor.
import { agentRun, gate, workspace } from "@j2/orchestrator";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------------------------
// Events — ALL workflow-owned (j2 ships none). Names are this workflow's vocabulary and are
// scoped TO this workflow (another workflow's `approve` may differ); the machine event type is
// the def's name. `semantics: "deferred"` (held tool result) remains available as a mechanism
// tag but this workflow doesn't need it — jr's gates are all state-parks.
// GAP(1): defineEvent is a pure factory; the `events` manifest export below declares this
// workflow's vocabulary (serializable inputs carry names; actors resolve within the manifest).

const requestReview = defineEvent({
  name: "request_review",
  description: "Hand the current task off for code review.",
  input: z.object({ summary: z.string() }),
});
const reportBlocked = defineEvent({
  name: "report_blocked",
  description: "Cannot proceed (scope expansion or environment blocker). Escalates to a human.",
  input: z.object({ reason: z.string() }),
});
const reviewVerdict = defineEvent({
  name: "review_verdict",
  description: "Deliver a review verdict on the current task or feature.",
  // Flat tagged object (ADR-0006): never a oneOf. `notes` required iff changes_requested,
  // enforced after the pick, not by the schema.
  input: z.object({ verdict: z.enum(["approved", "changes_requested"]), notes: z.string().optional() }),
});
// Human-facing (jr: `just approve` / `just request-changes`; here: `j2 send` / PR-merge webhook).
const approve = defineEvent({ name: "approve", input: z.object({}) });
const requestChanges = defineEvent({ name: "request_changes", input: z.object({ notes: z.string() }) });
const resume = defineEvent({ name: "resume", input: z.object({ note: z.string().optional() }) });
// System-facing (a work-source webhook wakes discovery early; gates serve ANY external caller).
const workReady = defineEvent({ name: "work_ready", input: z.object({}) });

// The workflow's declared vocabulary — the module contract is all named exports (machine +
// events); discovery collects this manifest and scopes name→def resolution to it. GAP(1).
export const events = [requestReview, reportBlocked, reviewVerdict, approve, requestChanges, resume, workReady];

// ---------------------------------------------------------------------------------------------
// tk actors — the workflow's own; jr's ticket hierarchy and semantics, unchanged. (Deployment
// note: where the ticket store lives for a deployed orchestrator — repos volume vs its own — is
// an open question; `j2 dev` runs where the instance folder is, exactly like jr did.)

type Ticket = {
  id: string;
  type: "task" | "feature";
  title: string;
  body: string;
  parent?: string;
  assignee: string;
  baseRef: string;
  branch: string;
};

const tk = async (...args: string[]) => (await exec("tk", args)).stdout;

/** jr discover(), grouped: the next feature with unblocked, agent-assigned work — excluding
 * features we already have a live child for. Dependency order is tk's (`tk ready`). */
const claimNextFeature = fromPromise<Ticket | null, { active: string[] }>(async ({ input }) => {
  void (await tk("ready"));
  void input.active;
  return null; // sketch: parse `tk ready`, group tasks by parent, filter active, resolve baseRef
});

/** The next ready task in THIS feature's linear chain (jr: at most one at a time, by verify'd
 * chain structure). `stalled: true` when the next task exists but is assigned to a human. */
const claimNextTask = fromPromise<{ task: Ticket | null; stalled: boolean }, { featureId: string }>(async () => {
  return { task: null, stalled: false }; // sketch: tk ready filtered to parent
});

const closeTicket = fromPromise<void, { id: string }>(async ({ input }) => void (await tk("close", input.id)));
const escalateTicket = fromPromise<void, { id: string; reason: string }>(async ({ input }) => {
  await tk("assign", input.id, "human");
  await tk("add-note", input.id, `[orchestrator] Escalated to human: ${input.reason}`);
});
const backlogCount = fromPromise<{ open: number }, void>(async () => ({ open: 0 })); // sketch: tk query

// ---------------------------------------------------------------------------------------------
// The feature body: jr's per-ticket loop. Runs INSIDE a workspace (which passes our input
// through and adds `workspace: { endpoint, workdir, repos, branch }`). Sequential by
// construction — the one-agent-per-worktree lock, as machine structure.

type WsHandles = { endpoint: string; workdir: string; repos: Record<string, string>; branch: string };
type BodyInput = {
  runIid: string;
  feature: Ticket;
  reviewRounds: number; // JR_REVIEW_ROUNDS (5)
  retryBudget: number; // JR_RESUME_BUDGET (3)
  workspace: WsHandles; // appended by workspace() — GAP(3)
};
type BodyCtx = BodyInput & {
  task?: Ticket;
  coderRounds: number;
  archRounds: number;
  retriesLeft: number;
  reviewNotes?: string;
  prUrl?: string;
  offsets: Record<string, string>; // durable re-attach handles (ADR-0007) — GAP(5) for nesting
};

// Hierarchical iids: `<runIid>/<featureId>/<scope>/<role>` — pure data, derived not registered.
// Same iid across rounds = flue continues the conversation (jr's resume-prompt machinery, free).
const iid = (c: BodyCtx, scope: string, role: string) => `${c.runIid}/${c.feature.id}/${scope}/${role}`;

/** GAP(2): agentRun v2 input — endpoint (which Sandbox), tools BY NAME (defs resolve from this
 * workflow's `events` manifest; schemas can't ride serializable input), prompt xor attachOffset. */
const turn = (c: BodyCtx, role: string, scope: string, tools: string[], prompt: string) => {
  const id = iid(c, scope, role);
  const attachOffset = c.offsets[id];
  return {
    agentName: role,
    instanceId: id,
    endpoint: c.workspace.endpoint,
    workdir: c.workspace.workdir,
    tools,
    attachOffset,
    prompt: attachOffset ? undefined : prompt,
  };
};

const retryOrEscalate = (self: string) => [
  // jr handle_no_signal: budgeted resume. Re-entering re-invokes; attachOffset re-attaches the
  // stream instead of re-prompting. (v1 skips jr's investigator triage — a blind retry; a
  // triage turn can slot into this path later without changing the shape.)
  // `guard`/`actions` are NAMES, resolved against setup()'s registries — an inline `assign` here
  // would be typed outside the machine's event union and never fit a transition.
  { guard: "hasRetryBudget" as const, target: self, reenter: true, actions: "spendRetry" as const },
  { target: "#body.escalated" },
];

export const featureBody = setup({
  types: {} as {
    context: BodyCtx;
    input: BodyInput;
    events: // workflow events derive from the defs (EventFrom = { type: name } & z.infer<input>)
      | EventFrom<typeof requestReview | typeof reportBlocked | typeof reviewVerdict>
      | EventFrom<typeof approve | typeof requestChanges | typeof resume>
      | { type: "agent.offset"; instanceId: string; offset: string } // j2 mechanism telemetry
      | { type: "agent.fault"; instanceId: string; reason: string }
      | { type: "workspace.lost" }; // restore-reconcile found our Sandbox CR gone (ADR-0012)
  },
  actors: {
    agentRun,
    gate,
    claimNextTask,
    closeTicket,
    escalateTicket,
    openPr: fromPromise<{ url: string }, { workdir: string; branch: string; feature: Ticket }>(async () => {
      // Workflow-owned: push the branch + open the PR (e.g. `git push` + `gh pr create` against
      // the workspace). THIS is how commits leave the pod — workflow's decision, not workspace's.
      throw new Error("sketch: push branch + open PR");
    }),
  },
  actions: {
    spendRetry: assign({ retriesLeft: ({ context }) => context.retriesLeft - 1 }),
  },
  guards: {
    hasRetryBudget: ({ context }) => context.retriesLeft > 0,
    underReviewCap: ({ context }) => context.coderRounds < context.reviewRounds,
    underArchCap: ({ context }) => context.archRounds < context.reviewRounds,
  },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, coderRounds: 0, archRounds: 0, retriesLeft: input.retryBudget, offsets: {} }),
  initial: "working",

  on: {
    "agent.offset": {
      actions: assign({
        offsets: ({ context, event }) => ({ ...context.offsets, [event.instanceId]: event.offset }),
      }),
    },
    // Sandbox reaped while we were down: pod-local clone + unpushed commits are gone. Policy
    // here (jr semantics): escalate — a human reopens/re-chains via tk. Resuming would be a lie.
    "workspace.lost": { target: ".escalated" },
  },

  states: {
    working: {
      initial: "claimTask",
      states: {
        claimTask: {
          invoke: {
            src: "claimNextTask",
            input: ({ context }) => ({ featureId: context.feature.id }),
            onDone: [
              {
                guard: ({ event }) => event.output.task !== null,
                target: "coding",
                actions: assign({
                  task: ({ event }) => event.output.task!,
                  coderRounds: 0,
                  reviewNotes: undefined,
                }),
              },
              // Next task is human-assigned (previously escalated): the chain stalls. Parking
              // (not finishing) keeps the Sandbox alive for inspection — teardown-on-final.
              { guard: ({ event }) => event.output.stalled, target: "#body.stalled" },
              // Chain complete → the feature ticket itself is ready → architect (jr semantics).
              { target: "#body.architectReview" },
            ],
          },
        },

        coding: {
          invoke: {
            src: "agentRun",
            input: ({ context }) =>
              turn(context, "coder", context.task!.id, [requestReview.name, reportBlocked.name], coderPrompt(context)),
          },
          on: {
            request_review: { target: "reviewing" },
            report_blocked: { target: "#body.escalated" },
            "agent.fault": retryOrEscalate("coding"),
          },
        },

        reviewing: {
          invoke: {
            src: "agentRun",
            input: ({ context }) =>
              // Reviewer: fresh persona, own conversation per task (jr: independent evaluation).
              turn(
                context,
                "reviewer",
                context.task!.id,
                [reviewVerdict.name, reportBlocked.name],
                reviewerPrompt(context),
              ),
          },
          on: {
            review_verdict: [
              { guard: ({ event }) => event.verdict === "approved", target: "closingTask" },
              {
                guard: "underReviewCap",
                target: "coding",
                actions: assign({
                  coderRounds: ({ context }) => context.coderRounds + 1,
                  reviewNotes: ({ event }) => event.notes,
                }),
              },
              { target: "#body.escalated" }, // jr: review-round cap
            ],
            report_blocked: { target: "#body.escalated" },
            "agent.fault": retryOrEscalate("reviewing"),
          },
        },

        closingTask: {
          invoke: {
            src: "closeTicket",
            input: ({ context }) => ({ id: context.task!.id }),
            onDone: { target: "claimTask" }, // re-query the chain (jr: never materialize it)
          },
        },
      },
    },

    // The architect reviews the whole feature branch. It gets the tk toolchain in-Sandbox (jr
    // parity: it reopens / creates / re-chains tasks itself via tk); "changes requested" then
    // just loops back to working, which re-queries the chain the architect edited.
    architectReview: {
      invoke: {
        src: "agentRun",
        input: ({ context }) =>
          turn(context, "architect", "feature", [reviewVerdict.name, reportBlocked.name], architectPrompt(context)),
      },
      on: {
        review_verdict: [
          { guard: ({ event }) => event.verdict === "approved", target: "openingPr" },
          {
            guard: "underArchCap",
            target: "working",
            actions: assign({
              archRounds: ({ context }) => context.archRounds + 1,
              reviewNotes: ({ event }) => event.notes,
            }),
          },
          { target: "escalated" },
        ],
        report_blocked: { target: "escalated" },
        "agent.fault": retryOrEscalate("architectReview"),
      },
    },

    // Commits leave the pod here — workflow-owned, before the human gate (they review the PR).
    openingPr: {
      invoke: {
        src: "openPr",
        input: ({ context }) => ({
          workdir: context.workspace.workdir,
          branch: context.workspace.branch,
          feature: context.feature,
        }),
        onDone: { target: "humanReview", actions: assign({ prUrl: ({ event }) => event.output.url }) },
        onError: { target: "escalated" },
      },
    },

    // jr's exit-3 gate as a parked, durable state. Each gate invocation is an addressable
    // GATE RESOURCE (concurrent features park concurrently): `GET /runs/:id` lists open gates
    // (accepts + schemas + meta); `j2 send <runId> <gate> --event '{"type":"approve"}'` (or a
    // PR-merge webhook that found its gate by meta.prUrl) POSTs to
    // /runs/:id/gates/:gate/events. Leaving the state deregisters the gate. GAP(4).
    humanReview: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          gate: context.feature.id,
          accepts: [approve.name, requestChanges.name],
          meta: { prUrl: context.prUrl, title: context.feature.title },
        }),
      },
      entry: emit(({ context }) => ({
        type: "attention", // jr's terminal bell → the run feed (SSE)
        message: `feature ${context.feature.id} awaiting review: ${context.prUrl}`,
      })),
      on: {
        approve: { target: "closingFeature" },
        request_changes: {
          target: "architectReview", // jr: rework cycle via the architect
          actions: assign({
            reviewNotes: ({ event }) => event.notes,
            archRounds: ({ context }) => context.archRounds + 1,
          }),
        },
      },
    },

    closingFeature: {
      invoke: {
        src: "closeTicket",
        input: ({ context }) => ({ id: context.feature.id }),
        onDone: { target: "done" },
      },
    },

    // Reaching final is what triggers workspace teardown (destroy). Output bubbles to the top.
    done: { type: "final", output: ({ context }) => ({ status: "done" as const, feature: context.feature.id }) },

    // Chain stalled on a human-assigned task: park (Sandbox stays up), let a human unblock us.
    stalled: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          gate: context.feature.id,
          accepts: [resume.name],
          meta: { title: context.feature.title, reason: "stalled on an escalated task" },
        }),
      },
      entry: emit(({ context }) => ({
        type: "attention",
        message: `feature ${context.feature.id} stalled on an escalated task`,
      })),
      on: { resume: { target: "working" } },
    },

    // jr: escalation is per-ticket and NON-HALTING — this feature ends, siblings keep running.
    // Finishing (final) means the workspace IS destroyed; jr-style keep-around is `stalled`
    // above. The escalated ticket carries the trail for the next run to pick up.
    escalated: {
      invoke: {
        src: "escalateTicket",
        input: ({ context }) => ({
          id: context.task?.id ?? context.feature.id,
          reason: "blocked, review-round cap, or fault budget exhausted",
        }),
        onDone: { target: "escalatedDone" },
      },
    },
    escalatedDone: {
      type: "final",
      output: ({ context }) => ({ status: "escalated" as const, feature: context.feature.id }),
    },
  },
  // xstate v5: a machine's output is its ROOT `output` — a final state's own `output` only rides
  // the done event. Forward whichever final state settled us; workspace() then passes it through
  // verbatim, so the top machine's `xstate.done.actor.*` handler sees { status, feature }.
  output: ({ event }) => (event as unknown as { output: { status: "done" | "escalated"; feature: string } }).output,
});

// ---------------------------------------------------------------------------------------------
// workspace(): j2-owned wrapper — provision Sandbox + attach repos/worktree → run the body with
// the handles appended to its input → destroy when the body reaches final. Workspace-domain spec
// ONLY; it knows nothing about tickets or review rounds. GAP(3).

const featureWorkspace = workspace(featureBody, ({ input }: { input: { feature: Ticket } }) => ({
  repos: [{ name: "app", baseRef: input.feature.baseRef }],
  branch: input.feature.branch, // jr naming: <external-ref|id>-<slug>, resolved by the tk actor
}));

// ---------------------------------------------------------------------------------------------
// The top Machine: jr's main loop. Claims features with unblocked work under the concurrency
// cap, spawns one workspace(body) child per feature, reacts to completions, parks when only
// humans can act, finishes when the backlog is empty.

type CodingInput = { instanceId: string; maxConcurrent?: number; reviewRounds?: number; retryBudget?: number };
type CodingCtx = {
  runIid: string;
  maxConcurrent: number;
  reviewRounds: number;
  retryBudget: number;
  active: string[]; // feature ids only — never child refs (ADR-0007)
  escalated: string[];
  completed: string[];
};

export const machine = setup({
  types: {} as {
    context: CodingCtx;
    input: CodingInput;
    events:
      | EventFrom<typeof workReady> // push seam: an external caller POSTs to the backlog gate; poll is the fallback
      | { type: "xstate.done.actor.feature"; output: { status: "done" | "escalated"; feature: string } };
  },
  actors: { featureWorkspace, claimNextFeature, backlogCount, gate },
}).createMachine({
  id: "coding",
  context: ({ input }) => ({
    runIid: input.instanceId,
    maxConcurrent: input.maxConcurrent ?? 3, // JR_MAX_CONCURRENT
    reviewRounds: input.reviewRounds ?? 5,
    retryBudget: input.retryBudget ?? 3,
    active: [],
    escalated: [],
    completed: [],
  }),
  initial: "discover",

  states: {
    // jr discover(): re-query, launch while under the cap, then wait.
    discover: {
      always: [{ guard: ({ context }) => context.active.length >= context.maxConcurrent, target: "saturated" }],
      invoke: {
        src: "claimNextFeature",
        input: ({ context }) => ({ active: context.active }),
        onDone: [
          {
            guard: ({ event }) => event.output !== null,
            target: "discover",
            reenter: true, // claim again until saturated or dry
            // One enqueue closure, not [assign(...), spawnChild(...)]: spawnChild's own `id`/`input`
            // callbacks are typed against the machine's whole event union, so they cannot see this
            // onDone event's `output`. Enqueueing narrows it once and both actions read the feature.
            actions: enqueueActions(({ context, event, enqueue }) => {
              const feature = event.output!;
              enqueue.assign({ active: [...context.active, feature.id] });
              enqueue.spawnChild("featureWorkspace", {
                id: feature.id,
                input: {
                  runIid: context.runIid,
                  feature,
                  reviewRounds: context.reviewRounds,
                  retryBudget: context.retryBudget,
                  // + workspace: {...} appended by workspace() before the body sees it
                },
              });
            }),
          },
          { target: "settling" },
        ],
      },
    },

    saturated: {}, // all slots busy; a child settling re-enters discover (root handler below)

    // Ready-set dry: all done, or parked on humans/blocked deps? (jr exits 0/2/3 — we park.)
    settling: {
      invoke: {
        src: "backlogCount",
        onDone: [
          { guard: ({ context, event }) => event.output.open === 0 && context.active.length === 0, target: "allDone" },
          { target: "idle" },
        ],
      },
    },

    idle: {
      // The push seam IS a gate — without one, no external event can reach this state (ADR-0011
      // removed the hard-coded event types). A work-source webhook or `j2 send` wakes us early.
      invoke: { src: "gate", input: { gate: "backlog", accepts: [workReady.name] } },
      on: { work_ready: { target: "discover" } },
      after: { 30_000: { target: "discover" } }, // the ready-set mutates underneath us — re-query
    },

    allDone: { type: "final" }, // jr exit 0
  },

  on: {
    // Spawned children complete with output (no manual sendParent needed for lifecycle).
    "xstate.done.actor.*": {
      target: ".discover",
      actions: [
        stopChild(({ event }) => (event as { output: { feature: string } }).output.feature),
        assign(({ context, event }) => {
          const { status, feature } = (event as { output: { status: string; feature: string } }).output;
          return {
            active: context.active.filter((id) => id !== feature),
            completed: status === "done" ? [...context.completed, feature] : context.completed,
            escalated: status === "escalated" ? [...context.escalated, feature] : context.escalated,
          };
        }),
      ],
    },
  },
});

// --- Prompts (jr's subagent-task.md template + persona instructions live in the Agent personas;
// these are the per-turn task framings) -------------------------------------------------------

function coderPrompt(c: BodyCtx): string {
  const feedback = c.reviewNotes ? `\n\nReview feedback to address:\n${c.reviewNotes}` : "";
  return `Implement task ${c.task!.id}: ${c.task!.title}\n\n${c.task!.body}${feedback}\n\nWork in ${c.workspace.workdir}. Commit with 'Tk-Task: ${c.task!.id}' trailers. Call request_review when done.`;
}
function reviewerPrompt(c: BodyCtx): string {
  return `Review task ${c.task!.id} (${c.task!.title}) on branch ${c.workspace.branch} in ${c.workspace.workdir}. Verify tests. Call review_verdict.`;
}
function architectPrompt(c: BodyCtx): string {
  return `Feature ${c.feature.id} (${c.feature.title}): all tasks closed. Review the full branch for coherence, acceptance criteria, regressions. You may reopen/create/re-chain tasks with tk, then call review_verdict.`;
}

// =============================================================================================
// GAP LEGEND — what j2 had to build for this file to run (the build plan this artifact
// produced). STATUS 2026-07-12: ALL GAPS LANDED — GAP(1) e86d04c, GAP(4) 98b80ae, GAP(2)
// b656b40+3892959, GAP(3)+(5) the workspace/durability commits following them. The legend is
// kept as the map of what each mechanism is and where its edges are; remaining work is listed
// per-gap as "landed with" notes. The model: ADR-0011 (defineEvent, closure-bound delivery,
// gate, static imports) covers GAP(1)/(2)/(4); ADR-0012 (workspace wrapper) covers GAP(3);
// GAP(5) extends ADR-0007.
//
// GAP(1) `defineEvent` — pure def factory: name + zod input (+ semantics tag: ack | deferred |
//        poll) + EventFrom<def> type helper (setup unions derive from defs — no drift). NO
//        global registry: each workflow declares its vocabulary via `export const events`
//        (module contract = all named exports: machine + events); discovery collects the
//        manifest; actors resolve names per-workflow (run identity flows via the actor
//        `system`, host-mapped to the run). Same name may differ across workflows; unlisted
//        name = invoke-time error naming the workflow and its declared set. CALLBACK_TOOLS
//        demotes to an example set built on this.
// GAP(2) agentRun v2 — input gains `endpoint` (which Sandbox; rides the persisted child input,
//        so restore re-attaches to the right Harness) and `tools` (event names). On invoke it
//        registers its iid's MCP toolset with the process demux — handlers close over THIS
//        invocation's sendBack, so calls land in the invoking state; tools/list serves exactly
//        the registered set (state-scoped menus, ADR-0006, for free); deregister on stop.
//        The demux (`/mcp/<iid>` → live closure) replaces byInstance→root routing in RunHost.
//        Dev/e2e: `j2 dev` hosts a wire-compatible stub Harness on localhost — endpoint is just
//        a URL, agentRun keeps ONE code path; the in-process stub port retires; e2e plays the
//        agent against /mcp/<iid>. Stub scope = workspace-less test workflows only.
// GAP(3) `workspace(body, spec)` — spec is workspace-domain only ({ repos: [{name, baseRef}],
//        branch }). Provision Sandbox CR + worktree attach → run body with input = parent input
//        + { workspace: { endpoint, workdir, repos, branch } } → body final = destroy CR →
//        workspace output = body output. Parked body = live Sandbox (that IS the retain policy).
//        ALWAYS real (kind/cluster) — no stub mode, the data plane is never faked; dev needs the
//        j2-created kind cluster (repos/ via extraMounts, ADR-0009). e2e for workspace flows =
//        the kind tier.
//        Landed with: SandboxPort as HOST infrastructure on the run binding (one cluster per
//        instance — RunHostOptions.sandbox; workflows keep static imports); the canonical port
//        shells kubectl (labels j2.dev/run + j2.dev/workflow; port-forward reach for host-side
//        dev on a name-deterministic local port, healed by the reconcile probe); `j2 cluster up`
//        bakes repos/→/repos extraMounts + installs the CRD; `j2 dev` reconciles repos/ and
//        wires the port when j2.config.ts has `sandbox: { image }`.
//        VERIFIED on kind (2026-07-12, `@kind` e2e tier): provision → attach → agent admitted
//        against the in-pod Harness → MCP tool → body final → CR destroyed. One bug the cluster
//        found that no unit test could: the Sandbox CR must carry a WRITABLE work volume — the
//        operator runs the Harness as an unprivileged uid, so cloning into an image-owned /work
//        failed with "permission denied" on every attach (fixed: an emptyDir at workRoot, which
//        is also the volume ADR-0005's User Container shares).
// GAP(4) `gate` — same primitive over HTTP for ANY external caller (humans, webhooks, CI); each
//        invocation is an addressable GATE resource: input { gate, accepts: [names], meta? },
//        registration scoped to the state. Shares one registration table with GAP(2)'s demux
//        (address → { defs, deliver closure, meta }); MCP + gates API are dialect adapters.
//        GET /runs/:id lists open gates (accepts + schemas + meta — what j2 send / a UI / a
//        webhook translator discover); POST /runs/:id/gates/:gate/events validates against the
//        registered schema and delivers via sendBack (replaces hard-coded APPROVE/CANCEL/STEER —
//        CANCEL stays reserved, run-level). Per-gate addressing because concurrent bodies park
//        concurrently. Cross-run inbox (GET /gates) deferred.
// GAP(5) Nested durability — offsets/handles now live in CHILD context (body machines); restore
//        must fold child offsets + rewrite grandchild agentRun inputs recursively, and reconcile
//        each feature's Sandbox CR (present → re-attach; absent → `workspace.lost` delivered
//        into the restored body — this workflow routes it to escalated, ADR-0012).
//        Landed with: persistence rides the actor system's INSPECTION stream (a grandchild
//        agent.offset assigned into body context never notifies root subscribers — probed);
//        restore rewrites agentRun inputs recursively, each level's context.offsets scoping the
//        children below it; spawnChild'd machine children proven to restore; the wrapper's
//        reconcile probe re-runs on every restore (callback actors restart), delivering
//        workspace.lost when the CR is gone. One empirical trap this file now reflects: machine
//        output MUST be declared at the ROOT (final-state `output` only rides the done event).
//        VERIFIED on kind: an orchestrator killed mid-run restores onto the SAME Sandbox at the
//        SAME endpoint (the port-forward is re-derived from the CR name and healed by the probe)
//        and the agent's MCP surface comes back; a Sandbox reaped while the orchestrator was down
//        delivers workspace.lost into the restored body, which settles it — never a silent
//        re-provision. Both are `@kind` scenarios now.
//
// Open note, deliberately deferred (2026-07-12; not blocking GAP(1)-(4)): the tk store. The real
// question is a CONSISTENCY LOOP, not storage: the orchestrator's tk actors and the architect's
// in-Sandbox tk edits must see each other's writes (architectReview → working re-queries the
// chain the architect edited; jr had one host filesystem, j2 doesn't). Leading candidate:
// tickets as a repo in config.repos synced by plain git — orchestrator holds the canonical
// writable clone (fetch before query, push on mutate), feature workspaces clone it, the
// architect pushes ticket edits. Alternative: tk-over-HTTP (orchestrator serves a tk API).
//
// Deliberately out (jr parity): merge-all/rebase-feature (the forge handles merges now that
// review is PR-based), rate-limit handling (Harness/flue infra), the investigator persona (v1 =
// budgeted blind retry on agent.fault; a triage turn can slot into retryOrEscalate later).
// =============================================================================================
