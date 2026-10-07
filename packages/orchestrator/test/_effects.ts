// Test seams for Effects (ADR-0067): a fake Harness exec the test settles by hand, a port over the
// real `Execs` (real processes, no socket), and a stand-in Workspace that registers the ambient
// handles a `command` reads — the same registration `workspace()`'s registrar makes.

import { fromCallback, type AnyActorRef } from "xstate";
import { Execs } from "@jr2/harness/exec";
import { registerAmbientHandles, type AmbientHandles } from "../src/ambient.ts";
import type { ExecPort, ExecPortFactory } from "../src/effect.ts";
import type { ExecOutcome, ExecRead, ExecRequest } from "../src/wire.ts";

/** One exec the fake Harness was asked to start. */
export type FakeExec = { id: string; req: ExecRequest; endpoint: string; bearer?: string; output?: ExecOutcome };

/**
 * A fake Harness exec. `starts` is every exec started; `settle` ends the newest (or the named one);
 * `forgetAll` is a Harness restart — every exec unknown after it. A read of a running exec parks
 * until the test settles it or the signal aborts.
 */
export class FakeHarnessExec {
  readonly starts: FakeExec[] = [];
  readonly kills: string[] = [];
  readonly reads: Array<{ id: string; offset: number | undefined }> = [];
  private readonly execs = new Map<string, FakeExec & { stream: string; waiters: Set<() => void> }>();

  factory: ExecPortFactory = (endpoint, bearer) => this.port(endpoint, bearer);

  port(endpoint: string, bearer?: string): ExecPort {
    return {
      start: async (id, req) => {
        if (this.execs.has(id)) return;
        const exec = { id, req, endpoint, ...(bearer ? { bearer } : {}), stream: "", waiters: new Set<() => void>() };
        this.execs.set(id, exec);
        this.starts.push(exec);
      },
      read: async (id, offset, signal) => {
        this.reads.push({ id, offset });
        const exec = this.execs.get(id);
        if (!exec) return undefined;
        const end = exec.stream.length;
        if ((offset ?? end) >= end && exec.output === undefined) {
          await new Promise<void>((resolve) => {
            const wake = () => {
              exec.waiters.delete(wake);
              resolve();
            };
            exec.waiters.add(wake);
            signal.addEventListener("abort", wake, { once: true });
          });
        }
        if (signal.aborted) throw new Error("aborted");
        const from = Math.min(offset ?? end, exec.stream.length);
        const read: ExecRead = {
          state: exec.output === undefined ? "running" : "settled",
          stream: exec.stream.slice(from),
          next: exec.stream.length,
          ...(exec.output ? { output: exec.output } : {}),
        };
        return read;
      },
      kill: async (id) => {
        this.kills.push(id);
        this.settle({ outcome: "killed", signal: "SIGKILL", tail: "" }, id);
      },
      forget: async () => {},
    };
  }

  /** Append to an exec's stream (the newest, or the named one). */
  write(text: string, id = this.starts.at(-1)?.id): void {
    const exec = id && this.execs.get(id);
    if (!exec) throw new Error("no exec to write to");
    exec.stream += text;
    for (const wake of [...exec.waiters]) wake();
  }

  /** End an exec (the newest, or the named one). */
  settle(output: ExecOutcome, id = this.starts.at(-1)?.id): void {
    const exec = id && this.execs.get(id);
    if (!exec || exec.output) return;
    exec.output = output;
    for (const wake of [...exec.waiters]) wake();
  }

  /** The Harness restarted: it knows no exec. */
  forgetAll(): void {
    for (const exec of this.execs.values()) for (const wake of [...exec.waiters]) wake();
    this.execs.clear();
  }
}

/** A port over a real `Execs` — real processes, no socket. */
export function execsPort(execs: Execs): ExecPortFactory {
  return () => ({
    start: async (id, req) => void execs.start(id, req),
    read: async (id, offset) => execs.read(id, { ...(offset !== undefined ? { offset } : {}), waitMs: 1_000 }),
    kill: async (id) => void execs.kill(id),
    forget: async (id) => void execs.forget(id),
  });
}

/** The handles a stand-in Workspace registers: one Harness, one Sandbox, its Repo Slots. */
export function handles(repos: Record<string, string> = { app: "/work/app/run-1" }): AmbientHandles {
  return { endpoint: "http://harness.invalid", sandbox: "ws-1", repos, branch: "jr2/run-1" };
}

/**
 * A stand-in for `workspace()`'s registrar: invoked on a Machine's root, it registers `h` for the
 * Machine it runs in, so every actor below finds them by the parent chain (ambient.ts).
 */
export const fakeWorkspace = (h: AmbientHandles = handles()) =>
  fromCallback(({ self }: { self: AnyActorRef }) => registerAmbientHandles(self._parent!, h));
