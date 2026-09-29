// The Briefing (ADR-0062): jr2's own text to the model — the facts about the Agent's seat that a
// correct Agent would act on and cannot find out for itself, and nothing about the task (the
// Frame's) or about style (identity's). The Harness writes every word of it, here; the Orchestrator
// sends typed facts (the admission's `notices`), never text.
//
// Two parts, placed by how often they change, so the Briefing never breaks the provider's prefix
// cache (tools → system → messages):
//
//   - The STANDING part follows the Agent's `instructions` in the system prompt, in its own
//     delimited section. It is byte-stable for the seat: composed once from what this pod knows
//     (its CPUs from the Downward API, its Size from the cgroup) and the definition's `workspace`
//     access, with no clock, counter or Menu name in it.
//   - The TURN part follows the Frame's prompt, in its own delimited block, in the newest message —
//     uncached anyway, and unchanged in the history after. It carries the working directory, the
//     notices, and the Allowed picks LAST: a model obeys what it read last (ADR-0029, measured).
//
// Always on: no author switch. Every fact here passes the rule above, so removing one can only make
// the Agent act worse.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { formatBytes } from "./memory-guard.ts";
import { allowedPicksText } from "./menu.ts";
import type { ResolvedDefinition } from "./spec.ts";
import type { Notice } from "./wire.ts";

type Workspace = ResolvedDefinition["workspace"];

/** What this pod knows of its own seat. Each fact is absent where it is unknown — a host run, or
 * the Instance Harness, which is not a Sandbox — and an absent fact is not stated. */
export type SeatFacts = {
  /** The Sandbox's CPUs: the Harness container's `limits.cpu`, rounded up (`JR2_CPUS`, ADR-0060). */
  cpus?: number;
  /** The Sandbox's Size: the container cgroup's `memory.max` (ADR-0060). */
  memoryBytes?: number;
};

/** Read the seat's facts: `JR2_CPUS` from the env the operator sets through the Downward API, and
 * `memory.max` from this container's cgroup (cgroup v2). `max`, unreadable, or not a positive
 * number reads as unknown. */
export function seatFacts(env: Record<string, string | undefined>, cgroupRoot = "/sys/fs/cgroup"): SeatFacts {
  const cpus = Number(env.JR2_CPUS);
  let memoryBytes: number | undefined;
  try {
    const raw = readFileSync(join(cgroupRoot, "memory.max"), "utf8").trim();
    const n = Number(raw);
    if (raw !== "max" && Number.isFinite(n) && n > 0) memoryBytes = n;
  } catch {
    // No cgroup file: a host run.
  }
  return {
    ...(Number.isInteger(cpus) && cpus > 0 ? { cpus } : {}),
    ...(memoryBytes !== undefined ? { memoryBytes } : {}),
  };
}

/** The standing part for one seat: `(instructions, workspace)` → the system prompt, and `part`,
 * the delimited section alone. Each workspace access's section is composed once and cached, so
 * every Turn of the seat sends the same bytes. */
export type StandingBriefing = ((instructions: string, workspace: Workspace) => string) & {
  part: (workspace: Workspace) => string;
};

export function standingBriefing(facts: SeatFacts): StandingBriefing {
  const parts = new Map<Workspace, string>();
  const part = (workspace: Workspace): string => {
    let text = parts.get(workspace);
    if (text === undefined) {
      text = composeStanding(facts, workspace);
      parts.set(workspace, text);
    }
    return text;
  };
  return Object.assign((instructions: string, workspace: Workspace) => `${instructions}\n\n${part(workspace)}`, {
    part,
  });
}

function composeStanding(facts: SeatFacts, workspace: Workspace): string {
  const lines = [
    "jr2 runs the workflow you are part of. These are facts about your seat, not your task.",
    "- Your Turn ends with exactly one pick from your Menu: a call to one of the workflow's tools, one " +
      "that the <jr2-turn> block after each prompt allows now. When a pick ends your Turn, stop — call no other tool.",
  ];
  if (workspace === "none") {
    lines.push("- You have no Working tools: no shell and no files. You act only by picking from your Menu.");
  } else {
    // The CPUs and the Size are the Sandbox's, and a Menu-only Agent has nothing to spend them on.
    const cpus = facts.cpus === undefined ? undefined : `${facts.cpus} ${facts.cpus === 1 ? "CPU" : "CPUs"}`;
    const memory = facts.memoryBytes === undefined ? undefined : `${formatBytes(facts.memoryBytes)} of memory`;
    if (cpus !== undefined || memory !== undefined) {
      lines.push(`- This Sandbox has ${[cpus, memory].filter((fact) => fact !== undefined).join(" and ")}.`);
    }
    if (cpus !== undefined) {
      lines.push(
        "- The node's core count is not your budget: `os.cpus()` and `/proc/cpuinfo` report the node, " +
          `not this Sandbox. Size parallel work (test workers, build jobs) to ${cpus}.`,
      );
    }
    if (memory !== undefined) {
      lines.push(
        "- Every process you start shares that memory. At the limit your processes are killed and " +
          "`/dev/shm` is cleared.",
      );
    }
  }
  return `<jr2-briefing>\n${lines.join("\n")}\n</jr2-briefing>`;
}

/** What one Turn's part is rendered from: the Frame's `cwd`, the surface's Allowed picks, and the
 * admission's notices. `toolName` is the presenter's naming (ADR-0029). */
export type TurnFacts = {
  workspace: Workspace;
  cwd: string;
  allowed: string[];
  toolName?: (name: string) => string;
  notices?: Notice[];
};

/** The Turn part: a delimited block that follows the Frame's prompt. The Allowed picks close it. */
export function turnPart(facts: TurnFacts): string {
  const lines: string[] = [];
  // Only Working tools consume a directory; a Menu-only Agent's `/work` default names nothing.
  if (facts.workspace !== "none") lines.push(`Working directory: ${facts.cwd}`);
  for (const notice of facts.notices ?? []) lines.push(noticeText(notice));
  lines.push(allowedPicksText(facts.allowed, facts.toolName));
  return `<jr2-turn>\n${lines.join("\n")}\n</jr2-turn>`;
}

/** The Frame's prompt with the Turn part after it — the one user message a Turn sends. */
export function briefedPrompt(prompt: string, part: string): string {
  return prompt ? `${prompt}\n\n${part}` : part;
}

/** One notice in words. A notice never replaces a fault (ADR-0062): the Machine already decided;
 * this makes sure the next Agent does not work blind. */
export function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case "memory-limit": {
      const at = notice.peak === undefined ? `of ${notice.limit}` : `(peak ${notice.peak} of ${notice.limit})`;
      return (
        `Notice: the Sandbox's processes were killed at its memory limit ${at} during \`${notice.agent}\`'s Turn; ` +
        "/dev/shm was cleared. Anything that Turn left running is gone."
      );
    }
    case "conversation-new":
      return `Notice: This conversation is new; earlier context is gone (${notice.reason}).`;
  }
}
