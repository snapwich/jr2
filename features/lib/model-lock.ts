// The lock on `features/model-instance/` (ADR-0066). The fixture copies the selected endpoint
// profile to one fixed path there before each converge (World.setupModel), and the instance reads
// it from that path. The workers of one suite write identical bytes, so they share the lock. A
// second suite in the same checkout with a DIFFERENT profile would converge against whichever copy
// landed last and file its cells under its own key, with no error. So that suite fails at once.
// A second suite with the SAME profile fails at once too. The lock names one owner, so when the
// first suite ended, a third suite with another profile could take the lock over while the second
// still converges. And two suites at once put two times `workers` × `parallel` runs in flight,
// past the bound that the profile sets.
//
// The lock records the profile, the suite and the pid of the process that owns the suite. A lock
// whose owner is gone is taken over: a suite that was killed never removes it.

import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/** What the lock file holds. */
export type ProfileLock = { profile: string; suite: string; pid: number };

/**
 * This process's suite and its owner. `just e2e-model` sets `JR2_MODEL_SUITE` to
 * `<pid>-<start>`, the recipe's own pid first, so every worker of one run names one suite and one
 * owner. Without it (cucumber-js run by hand), the suite is the cucumber process: its parallel
 * workers are threads of it (cucumber 13), so they share its pid.
 */
export function suiteOf(
  env: Record<string, string | undefined>,
  self: { pid: number },
): { suite: string; pid: number } {
  const set = /^(\d+)(-.*)?$/.exec(env.JR2_MODEL_SUITE ?? "");
  if (set) return { suite: env.JR2_MODEL_SUITE!, pid: Number(set[1]) };
  return { suite: String(self.pid), pid: self.pid };
}

/** Whether a process with this pid exists. EPERM is a process of another user: it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The refusal a second live suite gets: one message for another profile, one for the same. */
export function conflictMessage(held: ProfileLock, want: ProfileLock): string {
  if (held.profile === want.profile)
    return (
      `another @model suite (pid ${held.pid}) runs in this checkout with the same endpoint profile "${held.profile}". ` +
      `Two suites at once would put more runs in flight than the profile's workers and parallel allow, and the ` +
      `lock names one owner. Wait until the other suite ends, or run this one from another worktree`
    );
  return (
    `another @model suite (pid ${held.pid}) runs in this checkout with the endpoint profile "${held.profile}", ` +
    `and this suite selects "${want.profile}". features/model-instance/ holds one model-endpoint.json, so this ` +
    `suite would converge against the other profile and file its cells under its own key. Two profiles at once ` +
    `need two worktrees: run this one from another worktree, or wait until the other suite ends`
  );
}

function parse(text: string): ProfileLock | undefined {
  try {
    const v = JSON.parse(text) as Partial<ProfileLock>;
    return typeof v.profile === "string" && typeof v.suite === "string" && typeof v.pid === "number"
      ? (v as ProfileLock)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take or share the lock at `path` for `want`. Resolves when this suite may write the profile:
 * no live suite holds the lock, or this suite does (its workers share it). Throws
 * {@link conflictMessage} when another live suite holds it, whatever its profile. The file is written
 * whole to a temporary name first and then linked (to create) or renamed (to take over), so a
 * reader never sees half of it.
 */
export async function takeProfileLock(
  path: string,
  want: ProfileLock,
  alive: (pid: number) => boolean = pidAlive,
): Promise<void> {
  const body = `${JSON.stringify(want)}\n`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const tmp = `${path}.${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, body);
    try {
      await link(tmp, path);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      await rm(tmp, { force: true });
    }
    const held = parse(await readFile(path, "utf8").catch(() => ""));
    if (held?.suite === want.suite) return;
    if (held && alive(held.pid)) throw new Error(conflictMessage(held, want));
    // The owner is gone, or the file is not a lock: take it over, then read back who has it. Two
    // suites that take over at once both rename, and the read tells the loser.
    const mine = `${path}.${randomBytes(6).toString("hex")}`;
    await writeFile(mine, body);
    await rename(mine, path);
    const now = parse(await readFile(path, "utf8").catch(() => ""));
    if (now?.suite === want.suite) return;
    await sleep(20);
  }
  throw new Error(`could not take the @model lock at ${path}: other suites took it over again and again`);
}
