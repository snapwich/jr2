// What the @model tier keeps of every trial (ADR-0066). Pure, apart from the step files, so a unit
// test pins each piece without a cluster or a model.
//
// A trial's evidence is read from places that do not outlive it: a Sandbox pod is reaped when its
// run settles (ADR-0012), and the scenario's namespace is deleted at teardown. So the tier keeps,
// for every trial, pass or not, the Harness container's printed conversation (ADR-0023), the
// Effector container's log, the Harness history view (ADR-0027), the Machine's final record, and
// for a push claim the push remote's log, under one folder per trial. Every probe only reads.

import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { calledIn, told, untimed, type Follow } from "./model-said.ts";

/** A segment the tier names a folder with: a model key, a cell's halves, a run id. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function segment(s: string): string {
  if (!SEGMENT.test(s) || s.includes("..")) throw new Error(`${JSON.stringify(s)} is not a plain path segment`);
  return s;
}

/** Where one trial's evidence lands: `<root>/<model>/<cell>/<runId>`, a cell's `/` a folder. */
export function trialDir(root: string, model: string, cell: string, runId: string): string {
  return join(root, segment(model), ...cell.split("/").map(segment), segment(runId));
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

/** The Agents whose prompt printed in a kept conversation, in order, each once. */
export function agentsIn(kept: string): string[] {
  const names = new Set<string>();
  for (const line of kept.split("\n")) {
    const m = /^\[([^\]]+)\] \[prompt\] /.exec(untimed(line));
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/**
 * The continued conversation (ADR-0057) a claim Agent's Harness history is asked for: every claim
 * Agent continues, and its Machine is the `workspace()`'s body in a Sandbox, the root on the
 * Instance Harness (ADR-0031).
 */
export const historyIid = (runId: string, sandbox: boolean, agent: string): string =>
  `${runId}/${sandbox ? "body" : "root"}/${agent}`;

const COMMIT = /^[0-9a-f]{40}$/;

/** A push claim's published commits, off the Machine's final record: in push order, each once. */
export function publishedCommits(record: { context?: { output?: Record<string, unknown> } } | undefined): string[] {
  const pushes = record?.context?.output?.pushes;
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
