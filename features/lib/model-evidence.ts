// What the @model tier keeps of every trial (ADR-0066). Pure, apart from the step files, so a unit
// test pins each piece without a cluster or a model.
//
// A trial's evidence is read from places that do not outlive it: a Sandbox pod is reaped when its
// run settles (ADR-0012), and the scenario's namespace is deleted at teardown. So the tier keeps,
// for every trial, pass or not, the Harness container's printed conversation (ADR-0023), the
// Effector container's log, the Harness history view (ADR-0027), the Machine's final record, and
// for a push claim the push remote's log, under one folder per trial. Every probe only reads.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { calledIn, printedLine, told, untimed, type Follow } from "./model-said.ts";
import { outputOf } from "./model-status.ts";

/** The characters a folder name keeps as they are; every other byte is spelled `%XX`. */
const PLAIN = /^[A-Za-z0-9._-]$/;

/**
 * A model key, a cell's half or a run id as one folder name. Never refused, since keeping evidence
 * never fails a trial: a byte outside `[A-Za-z0-9._-]` (a model id's `:` or `@`, a `/`) is spelled
 * `%XX`, and so is a leading `.`, so no name leaves the folder or hides in it. An empty one is `%`.
 */
export function segment(s: string): string {
  if (s === "") return "%";
  let out = "";
  for (const ch of s) {
    if (PLAIN.test(ch) && !(out === "" && ch === ".")) out += ch;
    else for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Where one cell's trials land: `<root>/<model>/<cell>`, a cell's `/` a folder. */
export function cellDir(root: string, model: string, cell: string): string {
  return join(root, segment(model), ...cell.split("/").map(segment));
}

/** Where one trial's evidence lands: `<root>/<model>/<cell>/<runId>`. */
export function trialDir(root: string, model: string, cell: string, runId: string): string {
  return join(cellDir(root, model, cell), segment(runId));
}

/** What a probe that could not be taken writes in its file: why (the @kind dump's form). */
export const unavailable = (why: string): string => `<unavailable: ${why}>\n`;

const UNAVAILABLE = /^<unavailable: (.*)>\n?$/s;

/**
 * The note's head (ADR-0066): what the model called, read off the kept conversation, as the
 * Menu-only notes print it — `said bash (restated) submit`. A conversation that cannot be read says
 * so, and why: `said <unread: why>`. `why` is the reason when nothing was kept.
 */
export function saidNote(kept: string, marker: string, why: string): string {
  const gone = UNAVAILABLE.exec(kept);
  if (gone) return `said <unread: ${gone[1]}>`;
  if (kept.trim() === "") return `said <unread: ${why}>`;
  const said = calledIn(kept, marker);
  if (said === undefined) return "said <unread: no prompt printed in the kept conversation>";
  return `said ${told(said) || "nothing"}`;
}

/**
 * The conversations whose prompt printed in a kept conversation, in order, each once: the Agent and
 * the Instance ID its lines carry (ADR-0023). The Harness history is asked for these, so a
 * conversation at another Machine path (a Chart's Agent), or the conversation after one jr2
 * faulted (`<iid>/<epoch>`), is read where it is.
 */
export function conversationsIn(kept: string): Array<{ agent: string; iid: string }> {
  const out = new Map<string, { agent: string; iid: string }>();
  for (const line of kept.split("\n")) {
    const p = printedLine(untimed(line));
    if (p && p.rest.startsWith("[prompt] ") && !out.has(p.iid)) out.set(p.iid, { agent: p.agent, iid: p.iid });
  }
  return [...out.values()];
}

/**
 * The continued conversation (ADR-0057) a claim Agent's Harness history is asked for before any of
 * its prompts printed: every claim Agent continues, and its Machine is the `workspace()`'s body in a
 * Sandbox, the root on the Instance Harness (ADR-0031). Once a prompt printed, its line names the
 * Instance ID (`conversationsIn`).
 */
export const historyIid = (runId: string, sandbox: boolean, agent: string): string =>
  `${runId}/${sandbox ? "body" : "root"}/${agent}`;

const COMMIT = /^[0-9a-f]{40}$/;

/** A push claim's published commits, off the Machine's final record: in push order, each once. The
 * record is the one {@link outputOf} reads, so a failed trial's pushes come off the Failure's
 * `detail` (ADR-0073). */
export function publishedCommits(
  record: { status?: string; context?: { output?: Record<string, unknown> }; output?: unknown } | undefined,
): string[] {
  const pushes = record
    ? outputOf({ status: record.status ?? "", context: record.context ?? {}, output: record.output })?.pushes
    : undefined;
  if (!Array.isArray(pushes)) return [];
  const out = new Set<string>();
  for (const p of pushes as Array<{ published?: unknown }>) {
    if (typeof p?.published === "string" && COMMIT.test(p.published)) out.add(p.published);
  }
  return [...out];
}

/**
 * The seed write seat's command for the push remote's log from `main` to a published commit: each
 * commit's id, its author and committer, and its subject. Read only.
 */
export function pushRemoteLogScript(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a commit id`);
  return `git -c safe.directory='*' -C /srv/push.git log --format='%H %an <%ae> | %cn <%ce> | %s' main..${commit}`;
}

/** The parts of a pod (`kubectl get pod -o json`) the follow reads. */
export type PodSeen = {
  metadata?: { uid?: string };
  spec?: { containers?: ReadonlyArray<{ name: string }> };
  status?: { containerStatuses?: ReadonlyArray<{ name: string; restartCount?: number }> };
};

/** Which run of a container a pod holds: the pod's uid and the container's restart count. A new
 * value is a new log to follow; `undefined` when the pod is gone or has no such container. */
export function containerRun(pod: PodSeen, container: string): string | undefined {
  const uid = pod.metadata?.uid;
  if (!uid || !pod.spec?.containers?.some((c) => c.name === container)) return undefined;
  const restarts = pod.status?.containerStatuses?.find((c) => c.name === container)?.restartCount ?? 0;
  return `${uid}/${restarts}`;
}

/** A container's log kept across every follow of it. */
export type Kept = {
  /** Everything every follow printed, a line between two follows. */
  readonly text: string;
  /** The last follow's stderr, while nothing was kept from it: why the log could not be read. */
  readonly why: string | undefined;
  /** Settles when the last follow ended and `again` said no, or `stop` was called. */
  readonly closed: Promise<void>;
  stop: () => Promise<void>;
};

/** The line between two follows of one container. */
const AGAIN = "--- followed again: the container restarted ---\n";

/**
 * Follow a container's log, and follow it again each time the follow ends while `again` says so:
 * a container that had not started, or restarted, or a pod deleted and made again. `open` starts
 * one follow; `again` is asked after each one ends, with whether that follow printed anything.
 */
export function followAcross(
  open: () => Follow,
  again: (printed: boolean) => Promise<boolean>,
  opts: { pauseMs: number },
): Kept {
  let before = "";
  let current: Follow | undefined;
  let stopped = false;
  let why: string | undefined;
  const joined = (f: Follow | undefined): string =>
    f === undefined || f.text === "" ? before : before === "" ? f.text : before + AGAIN + f.text;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      const f = open();
      current = f;
      await f.closed;
      before = joined(f);
      current = undefined;
      if (f.text === "" && f.err.trim() !== "") why = f.err.trim();
      if (stopped || !(await again(f.text !== "").catch(() => false))) return;
      if (opts.pauseMs > 0) await sleep(opts.pauseMs);
    }
  };
  const closed = loop();
  return {
    get text() {
      return joined(current);
    },
    get why() {
      const live = current?.text === "" ? current.err.trim() : "";
      return live !== "" ? live : why;
    },
    closed,
    stop: async () => {
      stopped = true;
      current?.stop();
      await closed;
    },
  };
}

/** A settlement as the Harness's history view and its stream's `submission-settled` carry it
 * (ADR-0027): its outcome, the failure text of one that failed, and what its model answers spent. */
export type SettlementSeen = { submissionId: string; outcome: string; error?: unknown; usage?: unknown };

/** The settlements in one page of a conversation's stream, in order. */
export function settledIn(events: unknown): SettlementSeen[] {
  if (!Array.isArray(events)) return [];
  const out: SettlementSeen[] = [];
  for (const e of events as Array<Record<string, unknown> | null>) {
    if (e?.type !== "submission-settled" || typeof e.submissionId !== "string" || typeof e.outcome !== "string")
      continue;
    out.push({
      submissionId: e.submissionId,
      outcome: e.outcome,
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.usage !== undefined ? { usage: e.usage } : {}),
    });
  }
  return out;
}

/** The response header that names the offset a stream's next page is read from (the Harness wire). */
export const STREAM_NEXT_OFFSET = "stream-next-offset";

/**
 * One page of a conversation's stream, long-polled from `offset`: the read the Orchestrator waits on
 * a Submission with (ADR-0027). Reading it moves nothing; each reader holds its own offset.
 */
export function streamPath(agent: string, iid: string, offset: string): string {
  const q = new URLSearchParams({ offset, view: "updates", live: "long-poll" });
  return `/agents/${encodeURIComponent(agent)}/${encodeURIComponent(iid)}?${q}`;
}

/** The settlements a kept history view (`read at ...\nHTTP <status>\n<body>`) holds, when it is a 200. */
function viewSettlements(view: string): Array<{ submissionId?: unknown; usage?: unknown }> | undefined {
  const m = /^read at [^\n]*\nHTTP 200\n([\s\S]*)$/.exec(view);
  if (!m) return undefined;
  try {
    const body = JSON.parse(m[1]!) as { settlements?: Array<{ submissionId?: unknown; usage?: unknown }> };
    return Array.isArray(body.settlements) ? body.settlements : [];
  } catch {
    return undefined;
  }
}

/** The submission ids a kept history view holds, when it is a 200. */
function viewSettled(view: string): Set<string> | undefined {
  const held = viewSettlements(view);
  return held === undefined ? undefined : new Set(held.map((s) => String(s?.submissionId)));
}

/** What a trial's model answers spent (ADR-0027, ADR-0066): tokens, and the cost in US dollars. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** A Settlement's `usage`, when it is one: every field a finite number. */
export function usageOf(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!USAGE_FIELDS.every((f) => typeof v[f] === "number" && Number.isFinite(v[f]))) return undefined;
  return { input: v.input, output: v.output, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite, cost: v.cost } as Usage;
}

/** Two usages summed, field by field. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

/** Every token of a usage: input, output, and both sides of the cache. */
export const tokensOf = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite;

/**
 * What a trial's model answers spent: the sum of the usage of every settlement its evidence kept,
 * from the last history view of each conversation and from its stream, each Submission once. A
 * settlement with no usage adds nothing (its model never answered, or it was lost with a restarted
 * Harness). `undefined` when no kept settlement carries a usage: the trial's usage was not read.
 */
export function trialUsage(
  views: ReadonlyMap<string, string>,
  settled: ReadonlyMap<string, readonly SettlementSeen[]>,
): Usage | undefined {
  const bySubmission = new Map<string, Usage>();
  const take = (submissionId: unknown, usage: unknown) => {
    const u = usageOf(usage);
    if (typeof submissionId === "string" && u !== undefined && !bySubmission.has(submissionId))
      bySubmission.set(submissionId, u);
  };
  for (const view of views.values()) for (const s of viewSettlements(view) ?? []) take(s?.submissionId, s?.usage);
  for (const list of settled.values()) for (const s of list) take(s.submissionId, s.usage);
  if (bySubmission.size === 0) return undefined;
  return [...bySubmission.values()].reduce(addUsage, NO_USAGE);
}

/** What a trial kept off one Harness: each conversation's last history view, and its stream's
 * settlements. */
export type KeptSide = {
  views: ReadonlyMap<string, string>;
  settled: ReadonlyMap<string, readonly SettlementSeen[]>;
};

/**
 * `trialUsage` over every Harness a trial kept: a Sandbox trial whose Workspace encloses a
 * Menu-only seat keeps its Sandbox pod's Harness and the Instance Harness, where that seat's Turns
 * run. The same Instance ID can be kept on both sides; each Submission still counts once.
 */
export function trialUsageAcross(sides: readonly KeptSide[]): Usage | undefined {
  const views = new Map<string, string>();
  const settled = new Map<string, readonly SettlementSeen[]>();
  sides.forEach((side, i) => {
    for (const [iid, view] of side.views) views.set(`${i} ${iid}`, view);
    for (const [iid, list] of side.settled) settled.set(`${i} ${iid}`, list);
  });
  return trialUsage(views, settled);
}

/** The names `_agents.ts` exports whose `workspace` is `"none"`: the Menu-only seats (ADR-0031). */
export function menuOnlyAgents(agentsSource: string): Set<string> {
  const names = new Set<string>();
  for (const m of agentsSource.matchAll(/export const (\w+) = \{([\s\S]*?)\} satisfies AgentDefinition/g))
    if (/\bworkspace:\s*"none"/.test(m[2]!)) names.add(m[1]!);
  return names;
}

/**
 * Whether a claim workflow's `workspace()` encloses a Menu-only seat: its machine is a
 * `workspace()` and it imports a Menu-only Agent from `_agents.ts`. That seat's Turns run on the
 * Instance Harness (ADR-0031), not in the Sandbox, so the trial keeps both.
 */
export function enclosesMenuOnlySeat(workflowSource: string, menuOnly: ReadonlySet<string>): boolean {
  if (!/export const machine = workspace\(/.test(workflowSource)) return false;
  const imported = /import\s*\{([^}]*)\}\s*from\s*"\.\/_agents\.ts"/.exec(workflowSource)?.[1] ?? "";
  return imported.split(",").some((name) => menuOnly.has(name.trim()));
}

/** The claim workflows in `dir` (the tier's `workflows/`) whose `workspace()` encloses a Menu-only
 * seat (`enclosesMenuOnlySeat`), by name. */
export function menuOnlySeatedWorkflows(dir: string): Set<string> {
  const menuOnly = menuOnlyAgents(readFileSync(join(dir, "_agents.ts"), "utf8"));
  const names = new Set<string>();
  for (const file of readdirSync(dir))
    if (
      file.endsWith(".ts") &&
      !file.startsWith("_") &&
      enclosesMenuOnlySeat(readFileSync(join(dir, file), "utf8"), menuOnly)
    )
      names.add(file.slice(0, -".ts".length));
  return names;
}

/**
 * `harness-history.txt`: each Agent's last history view read, and after it every settlement its
 * stream carried that the view does not hold. A Sandbox Harness exits at the reap, so the view
 * after a Turn that settled just before it can be too late to read; that Turn's
 * `submission-settled` was read off the stream while it landed. `why` is said when nothing was kept.
 */
export function historyFile(
  views: ReadonlyMap<string, string>,
  settled: ReadonlyMap<string, readonly SettlementSeen[]>,
  why: string,
): string {
  const parts: string[] = [];
  for (const iid of new Set([...views.keys(), ...settled.keys()])) {
    const view = views.get(iid);
    const held = view === undefined ? undefined : viewSettled(view);
    const past = (settled.get(iid) ?? []).filter((s) => !held?.has(s.submissionId));
    if (view === undefined && past.length === 0) continue;
    let part = `--- ${iid} ---\n${view ?? unavailable("no history view was read")}`;
    if (past.length > 0) {
      if (!part.endsWith("\n")) part += "\n";
      part += "settled on the stream, not in the view above:\n";
      part += past.map((s) => `${JSON.stringify(s)}\n`).join("");
    }
    parts.push(part);
  }
  return parts.length === 0 ? unavailable(why) : parts.join("");
}
