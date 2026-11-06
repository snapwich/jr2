// A kept conversation as the Console's bottom drawer shows it (ADR-0023, ADR-0032): the entries
// that the conversation routes serve, folded into the items a person reads, and the reader of the
// `/events` stream. Pure, with no DOM and no fetch, so the test suite reads it as it reads store.ts.
//
// An entry is one body of the Harness's print: its label is `kind` and the rest is `text`. The
// print's cut is the record's cut (ADR-0023), so a Working tool's result is never here: a tool call
// with no answer is a Working tool's, and a call that an `<name> answer` or `<name> error` entry
// follows is a Menu pick.

/** One kept entry, as `GET /runs/:id/conversations/:iid` gives it — mirrors `ConversationEntry` in
 *  conversations.ts. */
export type ConversationEntry = { id: string; seq: number; at: string; agent: string; kind: string; text: string };

/** One kept conversation, as `GET /runs/:id/conversations` lists it (ADR-0023, ADR-0065). `open`
 *  says that a Turn of it is registered on the live run. */
export type ConversationRow = {
  agent: string;
  /** The Agent slot from the run's admission ledger: the address that a Steering message takes. */
  slot?: string;
  instanceId: string;
  open: boolean;
  bytes: number;
  cut: boolean;
  /** The space guard deleted the entries (ADR-0065); the row stays. */
  swept?: string;
};

/** One Agent slot of a run, as `GET /runs/:id/agents` lists it (ADR-0002): whether it has an open
 *  Turn, and whether a Caller may steer it. */
export type AgentLine = { agent: string; open: boolean; steerable: boolean };

/** What a person reads of a conversation, one item for each entry, with a tool call and its answer
 *  folded into one item. */
export type ConversationItem =
  | { type: "prompt" | "steering" | "notice"; at: string; text: string }
  | { type: "text" | "thinking"; at: string; text: string }
  | {
      type: "call";
      at: string;
      tool: string;
      input: string;
      /** The pick's answer, or its refusal (`error`). Absent for a Working tool, whose result is
       *  never kept, and for a pick that has no answer yet. */
      result?: { text: string; error: boolean };
    }
  | { type: "compacted" | "cut" | "mark"; at: string; label: string; text: string };

/** The `kind` of the marker entry that a cut leaves (ADR-0023) — `CUT_KIND` in conversations.ts. */
const CUT_KIND = "cut";

/** The first words of a Steering message's frame (ADR-0002), in each author's form. */
const STEERING = /^Steering message /;
/** The lines that a Steering message carries after its frame: the quoted text, and the closing line
 *  of a peer's message. */
const STEERING_MORE = /^(>|End of the message from )/;
/** The first word of a notice (ADR-0062). */
const NOTICE = /^Notice: /;
/** The lines that delimit the Turn part (ADR-0029): alone, they say nothing to a person. */
const TURN_TAG = /^<\/?jr2-turn>$/;

/** Cut a prompt at the lines that jr2 frames: each Steering message and each notice is an item of
 *  its own, and the text around them stays a prompt. A part that holds only the Turn part's tags
 *  is dropped. */
function splitPrompt(at: string, text: string): ConversationItem[] {
  const parts: Array<{ type: "prompt" | "steering" | "notice"; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    const last = parts[parts.length - 1];
    const type = STEERING.test(line) ? "steering" : NOTICE.test(line) ? "notice" : null;
    if (type) parts.push({ type, lines: [line] });
    else if (last?.type === "steering" && STEERING_MORE.test(line)) last.lines.push(line);
    else if (last?.type === "prompt") last.lines.push(line);
    else parts.push({ type: "prompt", lines: [line] });
  }
  return parts
    .filter((p) => p.type !== "prompt" || p.lines.some((l) => l.trim() !== "" && !TURN_TAG.test(l)))
    .map((p) => ({ type: p.type, at, text: p.lines.join("\n") }));
}

/**
 * Fold the entries of one conversation into the items a person reads. A call's answer joins the
 * newest call of the same name that has no answer yet; an answer with no call shows as a call
 * with no input. A prompt is cut at each Steering message and each notice that it carries, so each
 * shows as its own item; the frame of each is jr2's own text, so this reads it and changes nothing.
 */
export function foldEntries(entries: readonly ConversationEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const waiting = new Map<string, Extract<ConversationItem, { type: "call" }>[]>();
  for (const entry of entries) {
    const { kind, text, at } = entry;
    const answer = /^(.+) (answer|error)$/.exec(kind);
    if (answer) {
      const tool = answer[1]!;
      const result = { text, error: answer[2] === "error" };
      const call = waiting.get(tool)?.pop();
      if (call) call.result = result;
      else items.push({ type: "call", at, tool, input: "", result });
      continue;
    }
    if (kind === "prompt") {
      items.push(...splitPrompt(at, text));
    } else if (kind === "text" || kind === "thinking") {
      items.push({ type: kind, at, text });
    } else if (kind === "compacted" || kind === CUT_KIND) {
      items.push({ type: kind, at, label: kind, text });
    } else if (kind === "line" || kind.includes(" ")) {
      // A body with no label, or a mechanic line such as `[thinking level]`.
      items.push({ type: "mark", at, label: kind === "line" ? "" : kind, text });
    } else {
      const call: Extract<ConversationItem, { type: "call" }> = { type: "call", at, tool: kind, input: text };
      items.push(call);
      waiting.set(kind, [...(waiting.get(kind) ?? []), call]);
    }
  }
  return items;
}

/** Add `more` to `kept`, in sequence order, each sequence number once: a page and the stream can
 *  give the same entry, and the Harness sends a batch again after a failed send. */
export function mergeEntries(
  kept: readonly ConversationEntry[],
  more: readonly ConversationEntry[],
): ConversationEntry[] {
  if (!more.length) return kept as ConversationEntry[];
  const last = kept.length ? kept[kept.length - 1]!.seq : -Infinity;
  if (more.every((e, i) => e.seq > last && (i === 0 || e.seq > more[i - 1]!.seq))) return [...kept, ...more];
  const bySeq = new Map<number, ConversationEntry>();
  for (const e of kept) bySeq.set(e.seq, e);
  for (const e of more) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** One event of a `text/event-stream`: its name (`message` when none) and its data. */
export type SseEvent = { event: string; data: string };

/**
 * Read the complete events out of a stream's text so far, and give back the rest, which a later
 * chunk completes. The Console reads the guarded streams with `fetch`, because an `EventSource`
 * cannot send the credential (ADR-0032). Comments (`: ping`) and fields other than `event` and
 * `data` are ignored.
 */
export function readSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const text = buffer.replace(/\r\n?/g, "\n");
  let start = 0;
  for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n", start)) {
    const block = text.slice(start, end);
    start = end + 2;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest: text.slice(start) };
}
