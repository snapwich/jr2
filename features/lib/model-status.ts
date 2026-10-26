// Reading a run's states off `jr2 status` for the @model drivers (ADR-0066), and noticed's
// reading of the conversation the Harness holds. Pure, so a unit test pins it without a cluster.
//
// A `workspace()` run's own `value` is its wrapper's — placing, attaching, running — and never its
// body's: the body is a child actor, and `jr2 status` reports its state under `children`. A driver
// that waits on the body's state reads it there.

import { isSettled } from "./run-settled.ts";

/** One live child machine under the run, as `jr2 status` reports it. */
export type RunChild = { id: string; value: unknown; children: RunChild[] };

/** Whether a Machine below the run's root — a `workspace()`'s body, at any depth — is in a state
 * named `name`, at any level of its value. */
export function bodyIn(s: { children?: RunChild[] }, name: string): boolean {
  const any = (children: RunChild[]): boolean =>
    children.some((c) => JSON.stringify(c.value ?? null).includes(`"${name}"`) || any(c.children ?? []));
  return any(s.children ?? []);
}

/**
 * noticed's setup void (ADR-0066): the first Turn did not pick `started` in its time, so the second
 * Turn, which the claim measures, did not start. Told by the run when the step stops waiting: still
 * live, and its body still in `starting`. A run that settled — a fault, a lost Workspace — is no
 * void: "every trial finished" reads it.
 */
export function stillStarting(s: { status: string; children?: RunChild[] }): boolean {
  return !isSettled(s.status) && bodyIn(s, "starting");
}

/** The parts of `jr2 status` that say how a run ended. */
export type RunEnded = {
  status: string;
  value: unknown;
  context: { output?: Record<string, unknown> };
  /** The error message of a run in status `error` (RunStatus.fault): its reason. */
  fault?: string;
  /** The run's output (RunStatus.output). For a run in status `failed`, the Failure:
   * `{ reason, detail? }` (ADR-0073). */
  output?: unknown;
};

/** The Run statuses a trial's note explains with the reason: `failed` with its Failure, `error`
 * with its fault (ADR-0073). Each other end that is not `done` (`cancelled`, `lost`, `drifted`)
 * prints its final output too. */
const EXPLAINED_STATUSES = new Set(["failed", "error", "cancelled", "lost", "drifted"]);

/**
 * How a trial's run ended, for its note (ADR-0066): `<status>/<shown>`, where `shown` is the run's
 * `value` for a root Machine and its output's `outcome` for a `workspace()` body. A run that ended
 * `failed`, `error` or in another end that is not `done` also prints its output: for `failed`, the
 * Failure with its reason; for `error`, the context's output and the `fault`. The reason is there,
 * and the namespace that held the pod log is gone when the note is read. A run that ended `done`
 * prints only the head: a claim workflow's `faulted` and `lost` states invoke `fail`.
 */
export function ended(last: RunEnded, shown: unknown = last.value): string {
  const head = `${last.status}/${typeof shown === "object" && shown !== null ? JSON.stringify(shown) : String(shown)}`;
  if (!EXPLAINED_STATUSES.has(last.status)) return head;
  const fault = last.fault !== undefined ? ` fault: ${last.fault}` : "";
  const output = last.status === "failed" && last.output !== undefined ? last.output : last.context.output;
  return `${head} ${JSON.stringify(output ?? last.value)}${fault}`;
}

/**
 * The record a trial reads off how its run ended (ADR-0066, ADR-0073): the body's output for a run
 * that ended `done`, and the Failure's `detail` for a run that ended `failed`. Each claim workflow
 * gives its `faulted` and `lost` states (and `ticket` its `stuck`) the same record, with its
 * `outcome`, as the `detail` of the `fail` that they invoke, so a driver reads the ledger of a
 * failed trial as it did when those states were final.
 */
export function outputOf(last: {
  status: string;
  context: { output?: Record<string, unknown> };
  output?: unknown;
}): Record<string, unknown> | undefined {
  if (last.status !== "failed") return last.context.output;
  const detail = (last.output as { detail?: unknown } | undefined)?.detail;
  return typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : undefined;
}

/** One message of a Harness conversation, as its `?view=history` reports it (best-effort, roles
 * and text alone). */
export type HistoryMessage = { role: string; text: string };

/** The fixed words of a memory kill's notice, as the Briefing writes it (`noticeText` in
 * `packages/harness/src/briefing.ts`, ADR-0062). */
export const MEMORY_KILL_NOTICE = "killed at its memory limit";

/** The first words of the `noticed` workflow's second-Turn prompt, for the workflow's port
 * (`SERVER_PORT` in `features/model-instance/workflows/noticed.ts`). */
export const noticedAsk = (port: number): string => `Is the server you started on port ${port} still answering?`;

/**
 * noticed (ADR-0061/0062/0066): was the second Turn told of the kill? Read off the conversation the
 * Harness holds: the second Turn's prompt — the first user message that carries `nextPrompt` —
 * carries the kill's notice in its Turn part. The step kills while no Turn runs and before the
 * second Turn starts, so a prompt with no notice is a defect in what jr2 shows the model.
 * `undefined` while no such prompt is held.
 */
export function nextTurnNoticed(messages: HistoryMessage[], nextPrompt: string): boolean | undefined {
  const prompt = messages.find((m) => m.role === "user" && m.text.includes(nextPrompt));
  return prompt === undefined ? undefined : prompt.text.includes(MEMORY_KILL_NOTICE);
}

/** noticed: whether the pod's guard kills (`GET /memory-kills`, by id) hold one that was not
 * there before the step's hog ran. */
export function newKill(before: readonly string[], after: readonly string[]): boolean {
  return after.some((id) => !before.includes(id));
}

/** The Orchestrator's refusal of a send to a Gate that is not open (`run-host.ts`). */
export const NO_OPEN_GATE = "no open gate";

/**
 * Whether a send to a Gate that the Orchestrator refused found the Gate gone with its state, so the
 * step scores the run from its final record (ADR-0066). Between the step's read and its send, the
 * body can leave the state that holds the Gate. For example, the Agent's Turn faults when its
 * nudges are spent, and the Gate goes with the state. That is so when the refusal names
 * NO_OPEN_GATE, and the status read after it shows the run settled, or the body out of `state` with
 * the Gate closed. Any other refusal, or a Gate gone while the body is still in `state`, is a
 * defect: the step throws.
 */
export function gateWentFirst(
  stderr: string,
  after: { status: string; children?: RunChild[]; gates?: Array<{ gate: string }> },
  gate: string,
  state: string,
): boolean {
  if (!stderr.includes(NO_OPEN_GATE)) return false;
  if (isSettled(after.status)) return true;
  return !bodyIn(after, state) && !(after.gates ?? []).some((g) => g.gate === gate);
}
