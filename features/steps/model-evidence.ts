// The @model tier keeps every trial's evidence (ADR-0066): one folder per trial, pass or not, under
// `features/.tmp/model-trials/<model>/<cell>/<runId>/`. The readings are pure, in
// `features/lib/model-evidence.ts`; this file is what touches the cluster.
//
// A trial's witnesses do not outlive it. A Sandbox pod is reaped when its run settles (ADR-0012),
// and its logs go with it; the namespace is deleted at teardown. So the tier begins to keep a trial
// the moment its run starts — follows the Sandbox pod's containers from the moment the pod exists,
// polls the Harness's history view while the pod lives — and writes each file as it changes, so a
// trial that hangs until its timeout still leaves what it had. Every probe only reads: a probe that
// fails writes why into its file, never fails the trial, and never changes what the next trial does.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentsIn,
  containerRun,
  followAcross,
  historyIid,
  publishedCommits,
  saidNote,
  unavailable,
  type Kept,
  type PodSeen,
} from "../lib/model-evidence.ts";
import { follow } from "../lib/model-said.ts";

/** What the tier reads a trial's evidence with, bound to the scenario's namespace. */
export type EvidenceProbes = {
  namespace: string;
  /** `kubectl --namespace <ns> ...`, answering stdout. */
  kubectl: (args: string[]) => Promise<string>;
  /** The Harness bearer for one placement (ADR-0058). */
  auth: (placement: string) => Promise<Record<string, string>>;
  /** The push remote's log from `main` to a published commit. */
  pushLog: (commit: string) => Promise<string>;
};

/** One trial in flight: set around a driver, read by the step that starts its run. */
export type TrialContext = {
  /** The trial's marker, which its prompt carries (Menu-only claims). */
  marker: string;
  /** Whether the claim's trial runs in a Sandbox; otherwise on the Instance Harness. */
  sandbox: boolean;
  /** Whether the claim pushes: its record's published commits are logged off the push remote. */
  push: boolean;
  /** When the trial began (RFC 3339): the Instance Harness's log is kept from here. */
  since: string;
  /** The trial's folder, once its run id is known. */
  dirFor: (runId: string) => string;
  probes: EvidenceProbes;
  evidence?: TrialEvidence;
};

export const trialContext = new AsyncLocalStorage<TrialContext>();

/** The evidence of each run in flight, by run id: what a status read records into. */
const byRun = new Map<string, TrialEvidence>();

/** Begin keeping the trial's evidence now that its run exists; nothing outside a trial. */
export function beginEvidence(runId: string): void {
  const ctx = trialContext.getStore();
  if (!ctx || ctx.evidence) return;
  ctx.evidence = new TrialEvidence(runId, ctx);
  byRun.set(runId, ctx.evidence);
}

/** Record a status a driver read: the Machine's final record is the last one. */
export function recordStatus(runId: string, status: unknown): void {
  byRun.get(runId)?.record(status);
}

/** The Instance Harness StatefulSet's pod and its placement (ADR-0031, ADR-0058). */
const INSTANCE_POD = "jr2-instance-harness-0";
const INSTANCE_PLACEMENT = "jr2-instance-harness";

/** How often the history view is read while the trial runs, and the follows' files written. */
const HISTORY_EVERY_MS = 15_000;
const WRITE_EVERY_MS = 5_000;
/** How long a Sandbox trial's follows may take to end on their own after the driver returned:
 * the reap at settle ends them. */
const REAP_GRACE_MS = 30_000;

export class TrialEvidence {
  readonly dir: string;
  private stopped = false;
  private readonly written = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();
  private pod: string | undefined;
  private harness: Kept | undefined;
  private effector: Kept | undefined;
  private notSeen = "no Sandbox for the run was seen";
  private noEffector: string | undefined;
  private last: unknown;
  private readonly history = new Map<string, string>();
  private historyWhy = "the history view was never read";
  private readonly loops: Promise<void>[];

  readonly runId: string;
  private readonly ctx: TrialContext;

  constructor(runId: string, ctx: TrialContext) {
    this.runId = runId;
    this.ctx = ctx;
    this.dir = ctx.dirFor(runId);
    this.loops = [
      (ctx.sandbox ? this.watchSandbox() : this.watchInstance()).catch(() => {}),
      this.pollHistory().catch(() => {}),
      this.flushEvery().catch(() => {}),
    ];
  }

  /** The Machine's record, written when it changes. */
  record(status: unknown): void {
    this.last = status;
    this.keep("record.json", `${JSON.stringify(status, null, 2)}\n`);
  }

  /**
   * End the trial's keeping: let a Sandbox trial's follows end at the reap, stop them, read the
   * history once more, log the published commits, and write every file. Answers the note's head:
   * what the model called, read off the kept conversation. Never throws.
   */
  async finish(): Promise<string> {
    try {
      const follows = [this.harness?.closed, this.effector?.closed].filter((p) => p !== undefined);
      if (this.ctx.sandbox && follows.length > 0) await Promise.race([Promise.all(follows), sleep(REAP_GRACE_MS)]);
      else await sleep(2_000); // the Instance Harness's last lines of the trial
      this.stopped = true;
      await Promise.all(this.loops);
      await Promise.all([this.harness?.stop(), this.effector?.stop()]);
      await this.readHistory().catch(() => {});
      if (this.ctx.push) await this.keepPushLog();
      this.flush();
      await this.writing;
    } catch {
      // Evidence never fails a trial.
    } finally {
      this.stopped = true;
      byRun.delete(this.runId);
    }
    return saidNote(this.conversation(), this.ctx.marker, this.harness?.why ?? this.notSeen);
  }

  private conversation(): string {
    if (this.harness === undefined) return unavailable(this.notSeen);
    return this.harness.text !== "" ? this.harness.text : unavailable(this.harness.why ?? "the log printed nothing");
  }

  /** A Sandbox claim: find the run's Sandbox, then follow its pod's Harness and Effector from the
   * moment the pod exists until it is reaped. */
  private async watchSandbox(): Promise<void> {
    while (!this.stopped && this.pod === undefined) {
      try {
        const names = await this.ctx.probes.kubectl([
          "get",
          "sandbox",
          "-l",
          `jr2.dev/run=${this.runId}`,
          "-o",
          "jsonpath={.items[*].metadata.name}",
        ]);
        this.pod = names.split(/\s+/).find(Boolean);
      } catch (err) {
        this.notSeen = `the run's Sandboxes could not be listed: ${message(err)}`;
      }
      if (this.pod === undefined) await this.pause(2_000);
    }
    const pod = this.pod;
    if (pod === undefined) return;
    this.notSeen = `the Sandbox pod ${pod} was never seen`;
    let containers: string[] = [];
    while (!this.stopped && containers.length === 0) {
      containers = ((await this.podJson(pod)).spec?.containers ?? []).map((c) => c.name);
      if (containers.length === 0) await this.pause(1_000);
    }
    if (containers.length === 0) return;
    this.harness = await this.followContainer(pod, "harness", true);
    if (containers.includes("effector")) this.effector = await this.followContainer(pod, "effector", true);
    else this.noEffector = `the Sandbox pod ${pod} has no effector container`;
  }

  /** A Menu-only claim: the Instance Harness's printed conversation from the trial's start, across
   * a pod the step deletes and the StatefulSet makes again. */
  private async watchInstance(): Promise<void> {
    this.pod = INSTANCE_POD;
    this.harness = await this.followContainer(INSTANCE_POD, "harness", false, this.ctx.since);
  }

  /**
   * Follow one container, timestamped, and follow it again when it had printed nothing, restarted,
   * or (the Instance Harness) its pod was made again. A Sandbox pod that is gone was reaped: its
   * follow ends there.
   */
  private async followContainer(pod: string, container: string, reaped: boolean, since?: string): Promise<Kept> {
    let seen = containerRun(await this.podJson(pod), container);
    const args = [
      "--namespace",
      this.ctx.probes.namespace,
      "logs",
      "-f",
      `pod/${pod}`,
      "-c",
      container,
      "--timestamps",
      ...(since ? [`--since-time=${since}`] : []),
    ];
    return followAcross(
      () => follow("kubectl", args),
      async (printed) => {
        while (!this.stopped) {
          const now = containerRun(await this.podJson(pod), container);
          if (now === undefined && reaped) return false;
          if (now !== undefined && (!printed || now !== seen)) {
            seen = now;
            return true;
          }
          await this.pause(1_000);
        }
        return false;
      },
      { pauseMs: 2_000 },
    );
  }

  /** Read the Harness history view of each Agent seen in the conversation while the trial runs. */
  private async pollHistory(): Promise<void> {
    while (!this.stopped) {
      await this.readHistory().catch(() => {});
      await this.pause(HISTORY_EVERY_MS);
    }
  }

  /** One read of each Agent's history; a 200 replaces the last view kept, anything else is kept
   * only while there is none. */
  private async readHistory(): Promise<void> {
    const pod = this.pod;
    if (pod === undefined) return;
    const placement = this.ctx.sandbox ? pod : INSTANCE_PLACEMENT;
    const agents = agentsIn(this.harness?.text ?? "");
    for (const agent of agents.length > 0 ? agents : [this.ctx.sandbox ? "coder" : "advisor"]) {
      const iid = historyIid(this.runId, this.ctx.sandbox, agent);
      try {
        const view = await this.historyOf(pod, placement, iid);
        if (view.startsWith("HTTP 200") || !this.history.has(iid))
          this.history.set(iid, `read at ${new Date().toISOString()}\n${view}`);
      } catch (err) {
        this.historyWhy = `the history view of ${iid} could not be read: ${message(err)}`;
      }
    }
  }

  /** `GET /agents/<agent>/<iid>?view=history` over a port-forward: `HTTP <status>` and the body
   * (the @kind dump's shape) — each settlement, with the failure text of one that failed. */
  private async historyOf(pod: string, placement: string, iid: string): Promise<string> {
    const headers = await this.ctx.probes.auth(placement);
    const agent = iid.slice(iid.lastIndexOf("/") + 1);
    const child = spawn("kubectl", ["--namespace", this.ctx.probes.namespace, "port-forward", `pod/${pod}`, ":8080"]);
    try {
      const local = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`port-forward pod/${pod} did not start`)), 10_000);
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
          const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]!);
          }
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`port-forward pod/${pod} exited (${code})`));
        });
      });
      const res = await fetch(`http://127.0.0.1:${local}/agents/${agent}/${encodeURIComponent(iid)}?view=history`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      return `HTTP ${res.status}\n${await res.text()}\n`;
    } finally {
      child.kill();
    }
  }

  /** The push remote's log from `main` to each published commit of the final record. */
  private async keepPushLog(): Promise<void> {
    const commits = publishedCommits(this.last as Parameters<typeof publishedCommits>[0]);
    if (commits.length === 0) {
      this.keep("push-log.txt", unavailable("no published commit in the Machine's final record"));
      return;
    }
    const parts: string[] = [];
    for (const commit of commits) {
      let log: string;
      try {
        log = await this.ctx.probes.pushLog(commit);
      } catch (err) {
        log = unavailable(message(err));
      }
      parts.push(`--- main..${commit} ---\n${log}`);
    }
    this.keep("push-log.txt", parts.join(""));
  }

  private async flushEvery(): Promise<void> {
    while (!this.stopped) {
      this.flush();
      await this.pause(WRITE_EVERY_MS);
    }
  }

  /** Write what is kept so far. */
  private flush(): void {
    this.keep("conversation.txt", this.conversation());
    if (this.ctx.sandbox) {
      this.keep(
        "effector.txt",
        this.effector === undefined
          ? unavailable(this.noEffector ?? this.notSeen)
          : this.effector.text !== ""
            ? this.effector.text
            : unavailable(this.effector.why ?? "the log printed nothing"),
      );
    }
    this.keep(
      "harness-history.txt",
      this.history.size === 0
        ? unavailable(this.historyWhy)
        : [...this.history].map(([iid, view]) => `--- ${iid} ---\n${view}`).join(""),
    );
    if (this.last === undefined) this.keep("record.json", unavailable("no status of the run was read"));
  }

  /** Write `name` when its content changed; writes are serial, and a failed write is dropped. */
  private keep(name: string, content: string): void {
    if (this.written.get(name) === content) return;
    this.written.set(name, content);
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(join(this.dir, name), content);
      } catch {
        // Evidence never fails a trial.
      }
    });
  }

  private async podJson(pod: string): Promise<PodSeen> {
    try {
      return JSON.parse(await this.ctx.probes.kubectl(["get", `pod/${pod}`, "-o", "json"])) as PodSeen;
    } catch {
      return {};
    }
  }

  /** Sleep up to `ms`, waking within a second of the stop. */
  private async pause(ms: number): Promise<void> {
    for (let left = ms; left > 0 && !this.stopped; left -= 1_000) await sleep(Math.min(left, 1_000));
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).trim();
