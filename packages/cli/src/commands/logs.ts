// `jr2 logs <runId|abbrev> [agent] [-f]` (ADR-0009, ADR-0023): a run's kept conversations, printed
// as the Harness prints them to its pod log. Each line is `[<agent>] [<instance id>] <body line>`,
// and a body starts with its label (`[text]`, `[bash]`, `[<pick> answer]`, `[cut]`). The
// conversations of every Agent of the run are interleaved by the time of each entry, or `[agent]`
// keeps one: an Agent slot as `jr2 steer <runId>` lists it (`<machine path>/<agent>`), or an Agent
// name. Menu-only Agents too. It reads the Orchestrator's record, so it works after the Sandbox is
// gone, for as long as the run is kept (`runs.retain`, ADR-0065).
//
// `-f` follows: it prints what is kept, then each new entry as the Orchestrator keeps it, and
// starts to follow each new conversation of the run, until the run is not live and no conversation
// is open. The line format is the Harness's `printLines` (packages/harness/src/printer.ts); the CLI
// does not import the Harness, so it is stated again here, and the test holds the two the same.

import { JR2Client, type ConversationEntryView, type KeptConversationView } from "../client.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { activity, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";
import { parseCommand, usageLine } from "../command-table.ts";

/** How often `-f` asks for the run's conversations, to find a new one. */
export const LOGS_POLL_MS = 2_000;

/** One kept entry as the lines of the print (ADR-0023): `[<agent>] [<instance id>] ` before each line
 * of its body. An entry that kept no label prints its text alone, as the Harness printed it. */
export function printedLines(instanceId: string, entry: ConversationEntryView): string {
  const body = entry.kind === "line" ? entry.text : `[${entry.kind}] ${entry.text}`;
  return body
    .split("\n")
    .map((line) => `[${entry.agent}] [${instanceId}] ${line}\n`)
    .join("");
}

/** The conversations that `agent` names: those of that slot, else those of that Agent name. */
export function conversationsOf(
  all: readonly KeptConversationView[],
  agent: string | undefined,
): KeptConversationView[] {
  if (agent === undefined) return [...all];
  const bySlot = all.filter((c) => c.slot === agent);
  return bySlot.length ? bySlot : all.filter((c) => c.agent === agent);
}

/** Every kept entry of one conversation after `after`, page by page. */
async function entriesAfter(client: JR2Client, runId: string, instanceId: string, after: number) {
  const out: ConversationEntryView[] = [];
  for (let last = after; ; ) {
    const page = await client.conversationEntries(runId, instanceId, last);
    out.push(...page);
    if (page.length < 1000) return out;
    last = page.at(-1)!.seq;
  }
}

export async function logs(args: string[], io: Io, opts: { pollMs?: number } = {}): Promise<number> {
  const { values, positionals } = parseCommand("logs", args);
  const [given, agent] = positionals;
  if (!given || positionals.length > 2) {
    activity(io, usageLine("logs"));
    return 2;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    const ref = await resolveRunId(client, given);
    if (!ref.ok) {
      activity(io, ref.message);
      return ref.code;
    }
    const runId = ref.runId;
    const all = await client.conversations(runId);
    const chosen = conversationsOf(all, agent);
    if (agent !== undefined && chosen.length === 0) {
      const names = [...new Set(all.map((c) => c.slot ?? c.agent))];
      activity(
        io,
        `run ${runId} keeps no conversation of "${agent}"` +
          (names.length ? ` — its Agents: ${names.join(", ")}` : " — it keeps no conversation yet"),
      );
      if (!values.follow) return 1;
    }
    for (const c of chosen) {
      if (c.swept) activity(io, `${c.slot ?? c.agent} [${c.instanceId}]: ${c.swept}`);
    }

    // What is kept now, every chosen conversation interleaved by time.
    const last = new Map<string, number>();
    const kept = await Promise.all(
      chosen.map(async (c) => ({ c, entries: await entriesAfter(client, runId, c.instanceId, -1) })),
    );
    const merged = kept.flatMap(({ c, entries }) => entries.map((entry) => ({ iid: c.instanceId, entry })));
    merged.sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.entry.seq - b.entry.seq);
    for (const { iid, entry } of merged) io.stdout(printedLines(iid, entry));
    for (const { c, entries } of kept) last.set(c.instanceId, entries.at(-1)?.seq ?? -1);
    if (!values.follow) return 0;

    // Follow: each conversation from its last printed entry, and each new one from its first.
    const following = new Map<string, Promise<void>>();
    const finished = new Set<string>(); // conversations followed to the end of their feed
    const follow = (c: KeptConversationView) => {
      if (following.has(c.instanceId)) return;
      const after = last.get(c.instanceId) ?? -1;
      following.set(
        c.instanceId,
        (async () => {
          for await (const entry of client.followConversation(runId, c.instanceId, after)) {
            last.set(c.instanceId, entry.seq);
            io.stdout(printedLines(c.instanceId, entry));
          }
        })()
          .catch((err: unknown) => activity(io, `${c.slot ?? c.agent} [${c.instanceId}]: ${(err as Error).message}`))
          .finally(() => {
            following.delete(c.instanceId);
            finished.add(c.instanceId);
          }),
      );
    };
    const pollMs = opts.pollMs ?? LOGS_POLL_MS;
    for (;;) {
      // An open conversation is followed; one that is not open is followed once, to read its end.
      for (const c of conversationsOf(await client.conversations(runId), agent)) {
        if (c.open || (!finished.has(c.instanceId) && !c.cut && !c.swept)) follow(c);
      }
      const status = (await client.read(runId))?.status;
      if (status !== "active" && following.size === 0) return 0;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    target.close?.();
  }
}
