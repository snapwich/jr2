// The engine part of a conversation, for the engine jr2 runs today: pi's Session (ADR-0031). pi is
// the ENGINE, not the contract — jr2's record (`record.ts`) is the contract — so everything that
// knows pi keeps its state lives behind the `EngineSeat`: the directory is named for the engine
// (`engine/pi`), and nothing outside this module reads what pi writes there.
//
// Persisted through pi's own file-backed repo (`JsonlSessionRepo`), which appends each session
// entry as pi writes it, so a Harness that restarts reopens the session pi was carrying: every
// message, tool result and Compaction (ADR-0036) the model read. When that part is missing or will
// not open — another engine wrote it, another pi version, a torn file — the conversation continues
// from the record's history messages instead: best effort, because the record keeps what was SAID
// (role and text), not the tool calls between. The model then reads the conversation's words
// without its tool traffic, which is enough to continue a decision and says nothing false.

import { InMemorySessionRepo, JsonlSessionRepo, type AgentMessage, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { EngineSeat } from "./record.ts";
import type { HistoryMessage } from "./wire.ts";

/** The engine's name — its directory under the conversation (`engine/pi`). */
export const ENGINE = "pi";

/**
 * The pi Session a conversation's turns run on. In memory when the Harness persists nothing;
 * otherwise the latest session under the engine's directory, or — when there is none that opens — a
 * new one there, seeded with the record's history. `cwd` and `model` are the first Turn's: the
 * session's own metadata, and the identity a seeded assistant message is written under.
 */
export async function piSession(
  engine: EngineSeat | undefined,
  first: { cwd: string; model: Model<Api> },
  say: (line: string) => void = (line) => console.error(line),
): Promise<Session> {
  const dir = engine?.dir(ENGINE);
  const history = engine?.history() ?? [];
  if (dir === undefined) return seeded(await new InMemorySessionRepo().create(), history, first.model);
  const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: dir }), sessionsRoot: dir });
  let why = "no session there";
  try {
    // Newest first. `list` passes over a file pi cannot read as a session, so "none" covers it.
    const [latest] = await repo.list();
    if (latest) return await repo.open(latest);
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  // A conversation with nothing said is new, and has no part to lose. One with history is the
  // fallback, and the pod log says so: the model reads its words without its tool traffic.
  if (history.length > 0) {
    say(`harness: the engine part at ${dir} does not open (${why}) — continuing from the record's messages (ADR-0031)`);
  }
  return seeded(await repo.create({ cwd: first.cwd }), history, first.model);
}

/** Write the record's history into a fresh session, so the next prompt continues it. */
async function seeded(session: Session, history: HistoryMessage[], model: Model<Api>): Promise<Session> {
  for (const message of history) await session.appendMessage(agentMessage(message, model));
  return session;
}

/** A history message as pi carries one. An assistant message needs the model's identity and a
 * usage; it is written under the model that continues it, with nothing spent. */
function agentMessage(message: HistoryMessage, model: Model<Api>): AgentMessage {
  const timestamp = Date.now();
  if (message.role === "user") return { role: "user", content: message.text, timestamp };
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
  return assistant;
}
