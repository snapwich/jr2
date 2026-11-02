// The notices this Harness can word (ADR-0062): an admission's, and a surface read's at a step
// boundary. A kind it does not know is a newer Orchestrator's — skew (ADR-0027) — and a notice
// missing its facts cannot be said truly; both are dropped rather than rendered as half a sentence.

import type { Notice, PickAnswer } from "./wire.ts";

/** The notices in `value` that this Harness can word. Garbage in the slot is none. */
export function noticesOf(value: unknown): { notices?: Notice[] } {
  if (!Array.isArray(value)) return {};
  const notices = value.filter(isNotice);
  return notices.length > 0 ? { notices } : {};
}

/** True for a notice this Harness can word. */
export function isNotice(n: unknown): n is Notice {
  const str = (v: unknown) => typeof v === "string";
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
