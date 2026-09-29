// Briefing tests (ADR-0062): jr2's own text to the model, in its two parts. Asserted: the standing
// part follows `instructions` in its own delimited section and is byte-stable — composed once per
// seat, with no Menu names, counters or clocks in it; it states how a Turn ends, the Sandbox's CPUs
// and Size only where they are known and the Agent has Working tools, and a Menu-only Agent's lack
// of them. The Turn part follows the Frame's prompt in its own delimited block, with the working
// directory, the Allowed picks (ADR-0029) and the notices rendered to text. The seat's facts are
// read from the Downward API env and the cgroup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefedPrompt, seatFacts, standingBriefing, turnPart } from "../src/briefing.ts";

const GI = 1024 ** 3;
const INSTRUCTIONS = "You review diffs.";

test("the standing part follows the instructions, delimited, and is byte-identical on every Turn", () => {
  const standing = standingBriefing({ cpus: 2, memoryBytes: 4 * GI });
  const first = standing(INSTRUCTIONS, "write");
  const again = standing(INSTRUCTIONS, "write");
  assert.equal(first, again);
  assert.ok(first.startsWith(`${INSTRUCTIONS}\n\n<jr2-briefing>\n`), first);
  assert.ok(first.endsWith("\n</jr2-briefing>"), first);
  // Composed once per seat: the same string, not merely an equal one.
  assert.equal(standing.part("write"), standing.part("write"));
});

test("the standing part says how a Turn ends, and the Sandbox's CPUs and Size — not the node's cores", () => {
  const part = standingBriefing({ cpus: 2, memoryBytes: 4 * GI }).part("write");
  assert.match(part, /exactly one/i);
  assert.match(part, /2 CPUs/);
  assert.match(part, /4Gi of memory/);
  assert.match(part, /node's core count is not your budget/);
  // No Menu names, no counters, no clocks: nothing that could differ between two Turns.
  assert.doesNotMatch(part, /mcp__jr2__|\d{4}-\d{2}-\d{2}|Turn \d/);
});

test("a fact the seat does not know is not stated — a host run knows neither", () => {
  const part = standingBriefing({}).part("write");
  assert.doesNotMatch(part, /CPU|memory/);
  assert.match(standingBriefing({ memoryBytes: 512 * 1024 ** 2 }).part("read"), /512Mi of memory/);
  assert.doesNotMatch(standingBriefing({ memoryBytes: 512 * 1024 ** 2 }).part("read"), /CPU/);
});

test("a Menu-only Agent's standing part: no Working tools, and no CPUs or Size to budget", () => {
  const part = standingBriefing({ cpus: 2, memoryBytes: 4 * GI }).part("none");
  assert.match(part, /no Working tools/);
  assert.doesNotMatch(part, /CPU|memory/);
  assert.match(part, /exactly one/i);
});

test("the Turn part follows the prompt, delimited: working directory, Allowed picks, notices", () => {
  const prompt = "Implement the change.";
  const text = briefedPrompt(
    prompt,
    turnPart({
      workspace: "write",
      cwd: "/work/app/feature-x",
      allowed: ["finish", "dispute"],
      toolName: (name) => `mcp__jr2__${name}`,
      notices: [
        { kind: "memory-limit", scope: "workspace", agent: "coder", peak: "1.9Gi", limit: "2Gi" },
        { kind: "conversation-new", scope: "conversation", reason: "the last one was killed at its memory limit" },
      ],
    }),
  );
  assert.ok(text.startsWith(`${prompt}\n\n<jr2-turn>\n`), text);
  assert.ok(text.endsWith("\n</jr2-turn>"), text);
  const block = text.slice(prompt.length);
  assert.match(block, /Working directory: \/work\/app\/feature-x/);
  assert.match(block, /Allowed now: `mcp__jr2__finish`, `mcp__jr2__dispute`\./);
  assert.match(
    block,
    /killed at its memory limit \(peak 1\.9Gi of 2Gi\) during `coder`'s Turn; \/dev\/shm was cleared/,
  );
  assert.match(
    block,
    /This conversation is new; earlier context is gone \(the last one was killed at its memory limit\)/,
  );
  // The Allowed picks come after everything else in it: a model obeys what it read last (ADR-0029).
  assert.ok(block.indexOf("Allowed now") > block.indexOf("Working directory"));
  assert.ok(block.indexOf("Allowed now") > block.indexOf("conversation is new"));
});

test("a kernel memory kill has no peak — the notice says the limit alone", () => {
  const part = turnPart({
    workspace: "write",
    cwd: "/work",
    allowed: [],
    notices: [{ kind: "memory-limit", scope: "workspace", agent: "tester", limit: "2Gi" }],
  });
  assert.match(part, /killed at its memory limit of 2Gi during `tester`'s Turn/);
  assert.match(part, /Allowed now: none/);
});

test("a Menu-only Agent's Turn part names no working directory — it has no Working tools to root", () => {
  const part = turnPart({ workspace: "none", cwd: "/work", allowed: ["approve"] });
  assert.doesNotMatch(part, /Working directory/);
  assert.match(part, /Allowed now: `approve`\./);
});

test("the seat's facts: JR2_CPUS from the Downward API, the Size from memory.max", async () => {
  const cgroup = await mkdtemp(join(tmpdir(), "briefing-cgroup-"));
  await writeFile(join(cgroup, "memory.max"), `${4 * GI}\n`);
  assert.deepEqual(seatFacts({ JR2_CPUS: "2" }, cgroup), { cpus: 2, memoryBytes: 4 * GI });
  await writeFile(join(cgroup, "memory.max"), "max\n");
  assert.deepEqual(seatFacts({}, cgroup), {});
  assert.deepEqual(seatFacts({ JR2_CPUS: "zero" }, join(cgroup, "absent")), {});
});
