// The `dispatch` Effect (ADR-0071): a run starts a run of a registered Workflow, as an act of the
// caller. An actor slot beside `command()` and `http()` (ADR-0067):
//
//   actors: {
//     review: dispatch("review", { input: reviewDoor.pick({ branch: true }), wait: true }),
//     ops: dispatch("task/review-loop", { target: { url: "https://ops.example.com", token: secret("ops") } }),
//   }
//
// The callee is named as `jr2 run` names it — a constant on the slot, never a param: the name is
// authority, the input is data. The invoke's input is the run's body, whole. Two placements, read
// from the target: with none the Effect runs in the Orchestrator's own process and starts the run
// through the run host (`RunBinding.dispatch`), with no wire and no token; with one it runs in the
// Instance Effector, which holds the token as an Effect secret and calls the other Orchestrator's
// door. A packaged Machine leaves the target Open (`target: open`) for its composer to bind.
//
// What this module adds to the Effect's restart safety (effect.ts) for this kind:
//
//   - THE KEY. The ledger row's id rides every start as the door's idempotency key (in-process
//     through the binding, foreign in the `jr2-dispatched-by` header), and the door answers a
//     repeat with the run the key already started. So a dispatch is idempotent by construction: a
//     restore that cannot tell whether its start arrived sends it again, and gets the same run.
//   - THE RUN ON THE ROW. Once the start's answer names the run, the intent row is written again
//     with it, saved at the write: a restore with it settles `started` at once, or resumes the
//     wait on that run, and never starts another.
//   - D1. When its state exits, the wait stops and the abort is recorded, "outcome unknown". The
//     run it started is never touched: the two runs are independent.
//   - REACH IS OUTPUT, DEFECTS ARE ERRORS, as for `http`: `started | settled | refused |
//     unreachable | unknown` are output; an absent run host or Effector, input that fails the
//     slot's schema, and a refused or malformed wire are `onError`.

import { randomUUID } from "node:crypto";
import type { ActorLogic, AnyActorRef, EventObject } from "xstate";
import { z } from "zod";
import type {
  DispatchOutput,
  DispatchParts,
  Duration,
  EffectLogic,
  EffectMarker,
  EffectRow,
  EffectSnapshot,
  OpenDispatchParts,
  Unknown,
} from "./effect.ts";
import {
  createEffectorClient,
  DispatchOutputShape,
  EffectorForged,
  EffectorMalformed,
  EffectorNotSent,
  EffectorRefused,
  MAX_START_BYTES,
  nodeEffectorTransport,
  ORIGIN,
  WORKFLOW_NAME,
  type DispatchStartRequest,
  type EffectorPort,
  type EffectState,
  type Replica,
} from "./effector-wire.ts";
import { OPEN_SECRET, secret, type EffectorPortFactory, type NamedSecret } from "./http-effect.ts";
import { boundRun, type AnyActorSystem, type DispatchedBy } from "./registration.ts";
import { open } from "./open.ts";
import { effectBindingShape, openEffectLogic, type OpenOf } from "./open-effect.ts";

export { DISPATCHED_BY_HEADER, type DispatchedBy, type DispatchStart } from "./registration.ts";

// --- The definition ------------------------------------------------------------------------------

/** The definition of a `dispatch` Effect (ADR-0071). Every field is optional. */
export type DispatchDefinition<S extends z.ZodObject | undefined = undefined> = {
  /** A zod schema of the run input of the Workflow. It types the `input` of the invoke and
   * `fromPick`, and `jr2 up` compares it with the input that the Workflow declares. Without it,
   * only the Workflow checks the input. */
  input?: S;
  /** `true`: end when the new run ends (`settled`). `false`, the default: end when the
   * Orchestrator accepts the run (`started`). */
  wait?: boolean;
  /** How long the Effect waits: by default 30s for the start, and 10m with `wait`. */
  timeout?: Duration;
  /** A different Orchestrator: `url` is its origin, and `token` is the secret that holds its
   * Instance token. Or `open`, which the composer binds with `customize(<import>, { effects: {
   * <slot>: { target: { url, token } } } })`. Without it, the run starts in this Orchestrator. */
  target?: { url: string; token: NamedSecret } | typeof open;
};

/** A dispatch's input: the run's body — the slot's schema's type, or any JSON object. */
export type DispatchInput<S> = S extends z.ZodObject ? z.infer<S> : Record<string, unknown>;

/** The Open part a dispatch definition states: its target, when it is `open`. */
export type DispatchOpenParts<T> = T extends typeof open ? "target" : never;

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
/** How long a re-asked request waits, at most, after a transport failure. */
const RETRY_MAX_MS = 10_000;
/** The longest delay one `setTimeout` holds (2^31-1 ms, about 24.8 days): Node fires a longer one
 * at once, so a longer bound is armed again in steps of this (`atDeadline`). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A start sent again after its bound passed (a restore of a late row) still gets this long to be
 * answered: the key finds the run it started, if it did (ADR-0071). */
const START_FLOOR_MS = 1_000;
/** How long past the slot's bound the Orchestrator follows a foreign dispatch, at most: the
 * Effector settles at the bound, and its answer has to travel back (ADR-0071). */
const FOREIGN_GRACE_MS = 10_000;

/** The definition's plain data, checked: every refusal names what to write instead. */
export function dispatchParts(workflow: string, def: DispatchDefinition<any> = {}): DispatchParts {
  if (def.target === open) {
    throw new Error("dispatchParts: an Open target has no url — read it with openDispatchParts");
  }
  const { target: _target, ...rest } = openDispatchParts(workflow, { ...def, target: open });
  if (def.target === undefined) return withInputSchema(rest, def.input);
  const target = targetOf(workflow, def.target);
  return withInputSchema({ ...rest, target, secrets: [target.token] }, def.input);
}

/** An Open target's plain data (ADR-0054): every other part checked as `dispatchParts` checks it,
 * the sentinel where the target goes, and no secret until `customize()` binds the token. */
export function openDispatchParts(workflow: string, def: DispatchDefinition<any> = {}): OpenDispatchParts {
  if (typeof workflow !== "string" || !WORKFLOW_NAME.test(workflow)) {
    throw new Error(
      `dispatch(${JSON.stringify(workflow)}): the Workflow is named as \`jr2 run\` names it — a Machine's filename ` +
        'stem ("review"), or "<wrapper>/<name>" for a named Chart: lowercase letters, digits and "-" (ADR-0071)',
    );
  }
  if (def.wait !== undefined && typeof def.wait !== "boolean") {
    throw new Error(`dispatch("${workflow}", { wait }): wait is true or false — a slot that needs both declares two`);
  }
  const wait = def.wait === true;
  const input = def.input as z.ZodType | undefined;
  if (input !== undefined && !isObjectSchema(input)) {
    throw new Error(
      `dispatch("${workflow}", { input }): the input is a z.object(...) — the run's body is a JSON object (ADR-0071)`,
    );
  }
  return withInputSchema(
    {
      kind: "dispatch",
      workflow,
      wait,
      timeoutMs:
        def.timeout === undefined
          ? wait
            ? DEFAULT_WAIT_TIMEOUT_MS
            : DEFAULT_START_TIMEOUT_MS
          : parseDuration(workflow, def.timeout),
      target: open,
      inputKeys: input === undefined ? undefined : Object.keys((input as unknown as { shape: object }).shape),
      secrets: [],
      openSecret: false,
    },
    input,
  );
}

/** The key the slot's input schema rides the parts under, as JSON Schema: what `jr2 up` and the
 * publish door compare with the callee's door (ADR-0071, door-compat.ts; parts.ts reads it). A
 * `Symbol.for` key, so a second copy of this module reads it, and not enumerable, so the parts stay
 * the plain data they print as. Written here, by the zod that built the schema. */
const DISPATCH_INPUT = Symbol.for("jr2.dispatch.input");

function withInputSchema<P extends object>(parts: P, input: z.ZodType | undefined): P {
  if (input === undefined) return parts;
  // `io: "output"`: what the driver SENDS, which is the slot schema's parse (`inputOf`), its
  // defaults filled — so a defaulted field is required here, and one left optional is not, which
  // is what the door's `required` is compared with (door-compat.ts). The door is served as
  // `io: "input"`: what it takes. A part zod cannot draw is `{}`, which the comparison reads as
  // "any".
  const schema = z.toJSONSchema(input, { io: "output", unrepresentable: "any" });
  Object.defineProperty(parts, DISPATCH_INPUT, { value: schema, enumerable: false });
  return parts;
}

/** A target, checked (ADR-0071, D-J): an origin — no path, query, fragment or userinfo, and no
 * secret in it — and a token that is a named secret. The whole target is the Open part, so
 * `secret(open)` inside one is refused. */
function targetOf(workflow: string, target: unknown): { url: string; token: string } {
  const where = `dispatch("${workflow}", { target })`;
  if (typeof target !== "object" || target === null) {
    throw new Error(`${where}: a target is { url: "https://<host>", token: secret("<name>") }, or open (ADR-0071)`);
  }
  const { url, token } = target as { url?: unknown; token?: unknown };
  if (typeof url !== "string") {
    throw new Error(
      `${where}: the url is a string origin, "https://<host>[:<port>]" — a secret never sits in it; the token is ` +
        "`token: secret(...)` (ADR-0071)",
    );
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  const bare = url.replace(/\/$/, "");
  if (
    parsed === undefined ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !ORIGIN.test(bare)
  ) {
    throw new Error(
      `${where}: "${url}" is not an origin — write the scheme and the host, with a port if it is not the scheme's, ` +
        'and no path, query or userinfo: "https://ops.example.com" or "http://jr2-orchestrator.ops.svc:4000"; ' +
        "the Effector appends the door's path (ADR-0071)",
    );
  }
  if (typeof token !== "object" || token === null || typeof (token as { secret?: unknown }).secret !== "string") {
    throw new Error(`${where}: the token is a secret("<name>") holding the target's Instance token (ADR-0071)`);
  }
  const name = (token as { secret: string }).secret;
  if (name === OPEN_SECRET) {
    throw new Error(
      `${where}: secret(open) in a target — the target is the Open part, not its secret: leave the whole target ` +
        "Open (`target: open`) and let the composer bind its url and token together (ADR-0071)",
    );
  }
  secret(name);
  return { url: parsed.origin, token: name };
}

function isObjectSchema(schema: z.ZodType): boolean {
  const shape = (schema as { shape?: unknown }).shape;
  return (
    typeof shape === "object" && shape !== null && typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * The unbound logic of a dispatch whose target is Open (ADR-0054, ADR-0071), or undefined for one
 * whose target is fixed or absent. Binding builds the Effect again, whole, with `rebuild` over the
 * definition with the bound target, so the bound one is checked as any definition is.
 */
export function openDispatchOf<S extends z.ZodObject | undefined>(
  workflow: string,
  def: DispatchDefinition<S>,
  rebuild: (def: DispatchDefinition<S>) => unknown,
): EffectLogic<unknown, unknown> | undefined {
  if (def.target !== open) return undefined;
  const parts = openDispatchParts(workflow, def);
  return openEffectLogic(parts, ["target"], (binding) => {
    if (binding.url !== undefined || binding.argv !== undefined || binding.secret !== undefined) {
      throw new Error(
        `a dispatch's Open part is its target, its url and token together — bind it with ` +
          `${effectBindingShape(["target"])} (ADR-0071)`,
      );
    }
    if (binding.target === undefined) {
      throw new Error(`a dispatch's Open target is bound with ${effectBindingShape(["target"])} (ADR-0071)`);
    }
    return rebuild({ ...def, target: binding.target }) as EffectLogic<unknown, unknown>;
  });
}

/** The wire request for one foreign start (ADR-0071): the target's origin, the Workflow, the body,
 * the token by name, and who dispatched it. */
export function dispatchStartOf(
  parts: DispatchParts,
  input: Record<string, unknown>,
  dispatchedBy: DispatchedBy & { instance: string },
): DispatchStartRequest {
  if (parts.target === undefined) throw new Error("dispatchStartOf: an in-process dispatch has no wire request");
  return {
    kind: "dispatch",
    url: [{ text: parts.target.url }],
    workflow: parts.workflow,
    input,
    auth: { bearer: { secret: parts.target.token } },
    dispatchedBy,
    wait: parts.wait,
    timeoutMs: parts.timeoutMs,
  };
}

// --- The actor logic -----------------------------------------------------------------------------

type Settle = { type: "jr2.effect.settle"; output: unknown };
type Fault = { type: "jr2.effect.error"; error: unknown };

/** A dispatch's run: its abort, and — for a foreign one, once its Effector is known — the port its
 * stop goes through (ADR-0071). */
type Running = { controller: AbortController; port?: EffectorPort };
const running = new WeakMap<AnyActorRef, Running>();

/** How long a stop's DELETE may take: the Effector answers it with the wait's outcome, within its
 * poll's hold. */
const STOP_WAIT_MS = 30_000;

/**
 * A `dispatch` Effect's slot logic over an injected port factory — the seam `dispatch()` and the
 * unit tests share, as `httpWith` is for an http Effect. The factory is read only by a dispatch
 * with a target.
 */
export function dispatchWith<
  S extends z.ZodObject | undefined = undefined,
  const T extends DispatchDefinition<S>["target"] = undefined,
>(
  portFactory: EffectorPortFactory,
  workflow: string,
  def?: DispatchDefinition<S> & { target?: T },
): EffectLogic<DispatchInput<S>, DispatchOutput> & OpenOf<DispatchOpenParts<T>>;
export function dispatchWith<S extends z.ZodObject | undefined = undefined>(
  portFactory: EffectorPortFactory,
  workflow: string,
  def: DispatchDefinition<S> = {},
): EffectLogic<DispatchInput<S>, DispatchOutput> {
  const unbound = openDispatchOf(workflow, def, (bound) => dispatchWith(portFactory, workflow, bound));
  if (unbound) return unbound as EffectLogic<DispatchInput<S>, DispatchOutput>;
  const parts = dispatchParts(workflow, def);
  type I = DispatchInput<S>;
  type O = DispatchOutput;
  const logic: ActorLogic<EffectSnapshot<O, I>, EventObject, I> = {
    getInitialSnapshot: (_scope, input) => ({
      status: "active",
      output: undefined,
      error: undefined,
      input,
      effectId: randomUUID(),
    }),
    transition: (snapshot, event, { self, system }) => {
      if (snapshot.status !== "active") return snapshot;
      if (event.type === "jr2.effect.settle") {
        return { ...snapshot, status: "done", output: (event as Settle).output as O, input: undefined };
      }
      if (event.type === "jr2.effect.error") {
        return { ...snapshot, status: "error", error: (event as Fault).error, input: undefined };
      }
      if (event.type === "xstate.stop") {
        stopped(self, system, snapshot.effectId);
        return { ...snapshot, status: "stopped", input: undefined };
      }
      return snapshot;
    },
    start: (snapshot, { self, system }) => {
      if (snapshot.status !== "active") return;
      const run: Running = { controller: new AbortController() };
      running.set(self, run);
      void drive(self, system, snapshot, parts, def, portFactory, run).catch((error: unknown) => {
        if (run.controller.signal.aborted) return;
        if (self.getSnapshot().status === "active") self.send({ type: "jr2.effect.error", error } as Fault);
      });
    },
    getPersistedSnapshot: (snapshot) => snapshot,
  };
  return Object.assign(logic, { effect: parts });
}

const slotOf = (self: AnyActorRef): string => (typeof self.src === "string" ? self.src : self.id);

/** The statuses a settled dispatch names, in the store's own words (ADR-0025, ADR-0071). */
type SettledStatus = Extract<DispatchOutput, { outcome: "settled" }>["status"];

async function drive<I, O>(
  self: AnyActorRef,
  system: AnyActorSystem,
  snapshot: EffectSnapshot<O, I>,
  parts: DispatchParts,
  def: DispatchDefinition<z.ZodObject | undefined>,
  portFactory: EffectorPortFactory,
  run: Running,
): Promise<void> {
  const binding = boundRun(system);
  const id = snapshot.effectId;
  const slot = slotOf(self);
  const signal = run.controller.signal;
  const now = (): string => new Date().toISOString();
  const mark = (marker: Omit<EffectMarker, "kind" | "slot" | "effect">): void =>
    binding?.marker?.({ kind: "effect", slot, effect: id, ...marker });
  let settledOnce = false;
  const settle = (output: DispatchOutput): void => {
    if (settledOnce || signal.aborted || self.getSnapshot().status !== "active") return;
    settledOnce = true;
    // The settled row first, saved at the write: a restart before the transition is saved delivers
    // this output, and starts nothing.
    binding?.recordEffect?.(id, { state: "settled", kind: "dispatch", slot, output, at: now() });
    mark({ stage: "settled", output });
    self.send({ type: "jr2.effect.settle", output } satisfies Settle);
  };
  const unknown = (reason: string): Unknown => ({ outcome: "unknown", reason });
  const placement = parts.target === undefined ? "orchestrator" : "instance";
  const named = `${parts.workflow}${parts.target ? ` at ${parts.target.url}` : ""}`;

  const row = binding?.effectRow?.(id);
  if (row?.state === "settled") {
    await Promise.resolve();
    if (!signal.aborted && self.getSnapshot().status === "active") {
      self.send({ type: "jr2.effect.settle", output: row.output } satisfies Settle);
    }
    return;
  }
  if (row?.state === "aborted") {
    settle(unknown("its state exited while it ran; not started again"));
    return;
  }
  const prior = row?.state === "intent" && row.kind === "dispatch" ? row : undefined;
  // The intent row keeps the time it was first written: the wait's bound runs from the start, across
  // a restore.
  const at = prior?.at ?? now();
  let started: string | undefined = prior?.run;
  const intent = (): EffectRow => ({
    state: "intent",
    kind: "dispatch",
    slot,
    placement,
    idempotent: true,
    wait: parts.wait,
    ...(started !== undefined ? { run: started } : {}),
    at,
  });
  /** The run the start's answer names, written to the intent row, saved at the write: a restore
   * reads it and never starts another. */
  const pin = (runId: string, existing: boolean): void => {
    if (signal.aborted || started === runId) return;
    started = runId;
    binding?.recordEffect?.(id, intent());
    mark({ stage: "output", text: `${named}: run ${runId}${existing ? " (the key found it: started before)" : ""}` });
  };
  const deadline = Date.parse(at) + parts.timeoutMs;

  if (prior?.run !== undefined && !parts.wait) {
    // Started before the restart, and the answer is the run: nothing to send.
    await Promise.resolve();
    settle({ outcome: "started", run: prior.run });
    return;
  }

  if (parts.target === undefined) {
    const host = binding?.dispatch;
    if (!host || !binding) {
      throw new Error(
        `dispatch "${slot}" starts a run through its Orchestrator's run host, and this run has none — a dispatch ` +
          "with no target runs only under a RunHost (ADR-0071)",
      );
    }
    if (prior?.run !== undefined) {
      // In a wait at an Orchestrator restart: the run is on the row, so the wait resumes on it.
      mark({ stage: "started", text: `${named}: waiting for run ${prior.run} again, after a restart` });
      await waitIn(prior.run);
      return;
    }
    // Fresh, or in flight with no run on the row: the key makes a second start the same run.
    const input = inputOf();
    if (!prior) binding.recordEffect?.(id, intent());
    mark({
      stage: "started",
      text: prior ? `${named} (sent again under its key: a run it started is answered)` : named,
    });
    // The depth is the callee's: one below this run, which the host records as sent (ADR-0071).
    const by: DispatchedBy = { run: binding.runId, slot, effect: id, depth: (binding.depth ?? 0) + 1 };
    // The slot's bound holds the start too (ADR-0071): a run host that does not answer in it is
    // `unknown` — the start may have been taken, and a restore's re-send under the key would find it.
    const answer = await beforeDeadline(
      host.start(parts.workflow, input, by),
      prior ? Math.max(deadline, Date.now() + START_FLOOR_MS) : deadline,
      signal,
    );
    if (signal.aborted) return;
    if (answer === undefined) {
      settle(
        unknown(
          `the run host did not answer the start of ${parts.workflow} within the slot's timeout; a run may have started`,
        ),
      );
      return;
    }
    if (!answer.ok) {
      settle({ outcome: "refused", status: answer.status, report: [...answer.report] });
      return;
    }
    pin(answer.runId, answer.existing);
    if (!parts.wait) {
      settle({ outcome: "started", run: answer.runId });
      return;
    }
    await waitIn(answer.runId);
    return;
  }

  // Foreign: the Instance Effector holds the token and calls the other Orchestrator's door.
  const target = binding?.effector?.("instance");
  if (!target) {
    throw new Error(
      `dispatch "${slot}" calls another Orchestrator from the Instance Effector, and this Orchestrator knows none — ` +
        "`jr2 up` converges it when a registered Machine carries a dispatch with a target (ADR-0071)",
    );
  }
  const port = portFactory(target);
  // The wait's stop goes through this port when its state exits (ADR-0071).
  run.port = port;
  // Fresh: nothing was sent. The body is checked before the intent row, so a defect in the input is
  // the Machine's error and sends nothing.
  const req = prior ? undefined : requestFor(false);
  const big = req && tooLarge(req);
  if (big) {
    settle(big);
    return;
  }
  // The slot's bound holds the foreign path too (ADR-0071): `cut` ends every send, find and poll
  // at the bound — and a little past it, for the Effector's own answer at the bound to come back.
  // The Effect then settles `unreachable` when no replica ever took the start, else `unknown`.
  const cutter = new AbortController();
  const cut = cutter.signal;
  const onAbort = (): void => cutter.abort();
  signal.addEventListener("abort", onAbort);
  const foreignBound = deadline + Math.min(parts.timeoutMs, FOREIGN_GRACE_MS);
  const disarm = atDeadline(prior ? Math.max(foreignBound, Date.now() + START_FLOOR_MS) : foreignBound, () =>
    cutter.abort(),
  );
  /** Whether any send may have reached a replica: a restore's row may have been sent before. */
  let reached = prior !== undefined;
  const expired = (): void => {
    disarm();
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted || !cut.aborted) return;
    settle(
      reached
        ? unknown(`no outcome came from the Instance Effector within the slot's timeout; a run may have started`)
        : {
            outcome: "unreachable",
            reason: "no Instance Effector replica took the start within the slot's timeout; nothing was started",
          },
    );
  };
  /** Ask every replica. Undefined when an answer was forged (the Effect is settled then) or the
   * bound cut it. */
  const findAll = async (): Promise<{ found: EffectState | undefined } | undefined> => {
    try {
      return { found: await retrying(() => port.find(id, cut), cut) };
    } catch (err) {
      if (cut.aborted) return undefined;
      if (!(err instanceof EffectorForged)) throw err;
      settle(
        unknown(
          `${err.message}: the Orchestrator's key for this Effector is not the Effector's, or another process ` +
            "answered; not sent again",
        ),
      );
      return undefined;
    }
  };

  if (prior) {
    // In flight at an Orchestrator restart: follow the replica that holds it; when none does, send
    // it again — the key makes the door answer with the run it started, if it did.
    try {
      const asked = await findAll();
      if (!asked || cut.aborted) return;
      if (asked.found) {
        await follow(asked.found);
        return;
      }
      mark({ stage: "started", text: `${named} (sent again under its key: a run it started is answered)` });
      await send(requestFor(true));
      return;
    } finally {
      expired();
    }
  }

  binding?.recordEffect?.(id, intent());
  mark({ stage: "started", text: named });
  try {
    await send(req!);
  } finally {
    expired();
  }

  /** The run's body: the invoke's input, parsed by the slot's schema when it has one. */
  function inputOf(): Record<string, unknown> {
    let input: unknown = snapshot.input ?? {};
    if (def.input !== undefined) {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `dispatch "${slot}": its input does not match the slot's input schema — ` +
            parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        );
      }
      input = parsed.data;
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error(`dispatch "${slot}": its input is the run's body, a JSON object (ADR-0071)`);
    }
    return input as Record<string, unknown>;
  }

  /** The start, as the wire carries it. Sent `again`, its bound is what is left of the slot's,
   * counted from the intent row's first write: a re-send never starts the bound over (ADR-0071). At
   * least 1 ms: the key still answers the run, and the Effector settles at once with it. */
  function requestFor(again: boolean): DispatchStartRequest {
    const by = {
      run: binding?.runId ?? "",
      slot,
      effect: id,
      depth: (binding?.depth ?? 0) + 1,
      // The caller is foreign to the door it calls: it names its Orchestrator, as opaque text the
      // callee serves on its open band — never an Instance ID (ADR-0071).
      instance: binding?.orchestratorName ?? "an Orchestrator with no name",
    };
    const timeoutMs = again ? Math.max(1, Math.floor(deadline - Date.now())) : parts.timeoutMs;
    return dispatchStartOf({ ...parts, timeoutMs }, inputOf(), by);
  }

  /** The in-process wait (ADR-0071): the run host tells when the run leaves `live`; the slot's
   * bound ends the wait with the run still live, never the run. */
  async function waitIn(runId: string): Promise<void> {
    const host = binding!.dispatch!;
    const bounded = new AbortController();
    const abort = (): void => bounded.abort();
    signal.addEventListener("abort", abort);
    let timedOut = false;
    const disarmWait = atDeadline(deadline, () => {
      timedOut = true;
      bounded.abort();
    });
    try {
      const status = await host.settled(runId, bounded.signal);
      if (signal.aborted) return;
      settle({
        outcome: "settled",
        run: runId,
        status: status.status as SettledStatus,
        ...(status.output !== undefined ? { output: status.output } : {}),
      });
    } catch (err) {
      if (signal.aborted) return;
      if (!timedOut) throw err;
      settle({ outcome: "settled", run: runId, status: "live" });
    } finally {
      disarmWait();
      signal.removeEventListener("abort", abort);
    }
  }

  /** Send the start, and follow it. A start that never reached a replica is sent again; one whose
   * answer did not come is looked for on every replica, and sent again when none holds it — the
   * key makes that safe (ADR-0071). */
  async function send(first: DispatchStartRequest): Promise<void> {
    let req = first;
    for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
      let state: EffectState;
      try {
        state = await port.start(id, req, cut);
        reached = true;
      } catch (err) {
        if (cut.aborted) return;
        if (err instanceof EffectorRefused || err instanceof EffectorMalformed) throw err;
        if (!(err instanceof EffectorNotSent)) {
          reached = true;
          const asked = await findAll();
          if (!asked || cut.aborted) return;
          if (asked.found) {
            await follow(asked.found);
            return;
          }
        }
        await sleep(wait, cut);
        if (cut.aborted) return;
        req = requestFor(true);
        continue;
      }
      await follow(state);
      return;
    }
  }

  /** Poll the replica that holds it to its outcome — with `wait`, the Effector's own poll of the
   * door runs as long as the slot's bound. A replica that no longer knows it sends it again. */
  async function follow(first: EffectState): Promise<void> {
    let state = first;
    let replica: Replica = first.replica;
    for (;;) {
      // The door answered, and the wait runs: the intent row names the callee from now on.
      if (state.run !== undefined) pin(state.run, false);
      if (state.state === "settled" && state.output) {
        const parsed = DispatchOutputShape.safeParse(state.output);
        if (!parsed.success) throw new EffectorMalformed("the Effector's output for a dispatch is not a dispatch's");
        const output = parsed.data as DispatchOutput;
        if (output.outcome === "started" || output.outcome === "settled") pin(output.run, false);
        settle(output);
        return;
      }
      if (state.state === "unknown") {
        const asked = await findAll();
        if (!asked || cut.aborted) return;
        if (!asked.found) {
          await send(requestFor(true));
          return;
        }
        state = asked.found;
        replica = asked.found.replica;
        continue;
      }
      try {
        state = await port.poll(replica, id, cut);
      } catch (err) {
        if (cut.aborted) return;
        if (err instanceof EffectorRefused || err instanceof EffectorMalformed) throw err;
        state = { effect: id, replica, state: "unknown" };
      }
      if (cut.aborted) return;
    }
  }
}

/**
 * The state that invoked this Effect exited (D1) — or the host is parking the run. Parking keeps
 * the row for the restore. An exit stops the wait and records the abort, "outcome unknown"; the run
 * the Effect started runs on, untouched: the two runs are independent (ADR-0071). A foreign wait
 * runs in the Instance Effector, so it is stopped there too: one signed DELETE, best-effort, and
 * the Effector's poll of the door ends — it never sends anything to the callee.
 */
function stopped(self: AnyActorRef, system: AnyActorSystem, effectId: string): void {
  const run = running.get(self);
  running.delete(self);
  run?.controller.abort();
  const binding = boundRun(system);
  if (binding?.hostStopping) return;
  const row = binding?.effectRow?.(effectId);
  if (row?.state !== "intent" || row.kind !== "dispatch") return;
  // Sent at once, while a start may still be on the wire: the Effector keeps a stop of an id it
  // does not hold, and the start that arrives after it goes to the door and is not waited for.
  const port = row.placement === "instance" ? run?.port : undefined;
  port?.stop(effectId, AbortSignal.timeout(STOP_WAIT_MS)).catch((err: unknown) => {
    binding?.marker?.({
      kind: "effect",
      slot: row.slot,
      effect: effectId,
      stage: "aborted",
      text: `the stop did not reach the Instance Effector (${err instanceof Error ? err.message : String(err)}); it may poll the run until its timeout`,
    });
  });
  // The run it started stays on the row: the callee runs on, and the caller still names it (ADR-0071).
  const aborted: EffectRow = {
    state: "aborted",
    kind: "dispatch",
    slot: row.slot,
    ...(row.run !== undefined ? { run: row.run } : {}),
    at: new Date().toISOString(),
  };
  binding?.recordEffect?.(effectId, aborted, "with-transition");
  binding?.marker?.({
    kind: "effect",
    slot: row.slot,
    effect: effectId,
    stage: "aborted",
    text:
      row.run !== undefined
        ? `its state exited while it ran: no longer waited for; run ${row.run} runs on; outcome unknown`
        : "its state exited while it ran: no longer followed; the run may have started; outcome unknown",
  });
}

/** A start over the bytes the Effector reads is output `refused` (ADR-0068): nothing is sent. */
function tooLarge(req: DispatchStartRequest): DispatchOutput | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(req), "utf8");
  if (bytes <= MAX_START_BYTES) return undefined;
  return {
    outcome: "refused",
    status: 413,
    report: [`the start is ${bytes} bytes, over the ${MAX_START_BYTES} bytes an Effector reads; nothing was sent`],
  };
}

/**
 * Call `fire` once `deadline` (epoch ms) has passed: a timer armed again in steps of at most
 * `MAX_TIMER_MS`, so a bound past 24.8 days holds — one `setTimeout` that long fires at once.
 * Answers the disarm.
 */
function atDeadline(deadline: number, fire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disarmed = false;
  const arm = (): void => {
    if (disarmed) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      fire();
      return;
    }
    timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
  };
  timer = setTimeout(arm, Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_MS));
  return () => {
    disarmed = true;
    clearTimeout(timer);
  };
}

/** `work`'s answer, or undefined when `deadline` passes or `signal` aborts first. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number, signal: AbortSignal): Promise<T | undefined> {
  let disarm = (): void => {};
  let onAbort = (): void => {};
  const ended = new Promise<undefined>((resolve) => {
    disarm = atDeadline(deadline, () => resolve(undefined));
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([work, ended]);
  } finally {
    disarm();
    signal.removeEventListener("abort", onAbort);
  }
}

async function retrying<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    try {
      return await call();
    } catch (err) {
      if (
        signal.aborted ||
        err instanceof EffectorRefused ||
        err instanceof EffectorMalformed ||
        err instanceof EffectorForged
      ) {
        throw err;
      }
      await sleep(wait, signal);
      if (signal.aborted) throw err;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms / 2 + Math.random() * (ms / 2));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseDuration(workflow: string, d: Duration): number {
  const n = Number.parseFloat(d);
  if (!(n > 0) || !/^[0-9.]+[smh]$/.test(d)) {
    throw new Error(`dispatch("${workflow}"): timeout "${d}" is not a positive duration (like "30s", "10m", "1h")`);
  }
  return d.endsWith("h") ? n * 3_600_000 : d.endsWith("m") ? n * 60_000 : n * 1000;
}

// THE authoring surface for a `dispatch` Effect (ADR-0071). With no target it starts the run in
// this Orchestrator, through the run host; with one it runs in the Instance Effector, which
// `jr2 up` converges because this definition is placed there.
/**
 * Make a `dispatch` Effect: it starts a run of a Workflow. Put it in `actors`, and invoke it from a
 * state: `actors: { triage: dispatch("triage", { input }) }`. The input of the invoke is the run
 * input of the new run, as `jr2 run --input` gives it.
 *
 * The new run is a run of its own, with its own id, its own Workspaces and its own `CANCEL`. Its
 * record names this run as the run that dispatched it. A `CANCEL` of this run does not end it.
 *
 * With no `target`, the run starts in this Orchestrator, under the current Assembly. With
 * `target: { url, token }`, it starts on the Orchestrator at `url`, and the Effect runs in the
 * Instance Effector. Every outcome is output ({@link DispatchOutput}): `started`, `settled`,
 * `refused`, `unreachable` or `unknown`. Each start carries a key, so a start that jr2 sends again
 * after a restart starts no second run.
 *
 * It refuses:
 * - a name that is not a Workflow name: ``dispatch("<name>"): the Workflow is named as `jr2 run`
 *   names it — a Machine's filename stem ("review"), or "<wrapper>/<name>" for a named Chart:
 *   lowercase letters, digits and "-" (ADR-0071)``
 * - a `wait` that is not a boolean: `dispatch("<name>", { wait }): wait is true or false — a slot
 *   that needs both declares two`
 * - an `input` that is not a `z.object()`: `dispatch("<name>", { input }): the input is a
 *   z.object(...) — the run's body is a JSON object (ADR-0071)`
 * - a `timeout` that is not a duration: `dispatch("<name>"): timeout "<timeout>" is not a positive
 *   duration (like "30s", "10m", "1h")`
 * - a `target` url that is not an origin: `dispatch("<name>", { target }): "<url>" is not an
 *   origin — write the scheme and the host, with a port if it is not the scheme's, and no path,
 *   query or userinfo`, then two examples
 * - `secret(open)` in a target: `dispatch("<name>", { target }): secret(open) in a target — the
 *   target is the Open part, not its secret`, then the fix
 *
 * `jr2 up` refuses a dispatch with no target whose Workflow the Assembly does not have, and an
 * `input` schema that the input of that Workflow does not take.
 *
 * @param workflow - The Workflow to start, as `jr2 run` names it: `"triage"`, or
 *   `"<wrapper>/<name>"` for a named Chart.
 * @param def - Optional. Each field tells what it does.
 * @returns An Effect, for `actors`.
 *
 * @example
 * ```ts
 * import { assign } from "xstate";
 * import { z } from "zod";
 * import { defineEvent, dispatch, jr2Setup } from "@jr2/orchestrator";
 *
 * const triageInput = z.object({ request: z.string() });
 *
 * const report = defineEvent({
 *   name: "report",
 *   description: "Report a request. A run of triage starts for it.",
 *   input: triageInput,
 * });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: { request: string } },
 *   events: [report],
 *   // `wait: true`: the Effect ends when the run of triage ends.
 *   actors: { triage: dispatch("triage", { input: triageInput, wait: true }) },
 * }).createMachine({
 *   id: "intake",
 *   context: { request: "" },
 *   initial: "listening",
 *   states: {
 *     listening: {
 *       invoke: { src: "gate" },
 *       on: { report: { target: "starting", actions: assign({ request: ({ event }) => event.request }) } },
 *     },
 *     starting: {
 *       invoke: {
 *         src: "triage",
 *         input: ({ context }) => ({ request: context.request }),
 *         onDone: [
 *           { guard: ({ event }) => event.output.outcome === "settled", target: "done" },
 *           { target: "listening" },
 *         ],
 *       },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/guides/start-a-run-from-a-run.md
 * @see docs/concepts/effects.md
 * @see docs/reference/decisions/0071-a-run-starts-a-run-through-a-dispatch-effect.md
 */
export function dispatch<
  S extends z.ZodObject | undefined = undefined,
  const T extends DispatchDefinition<S>["target"] = undefined,
>(
  workflow: string,
  def?: DispatchDefinition<S> & { target?: T },
): EffectLogic<DispatchInput<S>, DispatchOutput> & OpenOf<DispatchOpenParts<T>> {
  return dispatchWith(
    (target) => createEffectorClient({ key: target.key, transport: nodeEffectorTransport(target.service) }),
    workflow,
    def,
  );
}
