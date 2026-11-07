// @kind: an Agent's project context in a real pod (ADR-0062, ADR-0076). The `contexted` and
// `contexted-shared` workflows (`kind-instance/workflows/_contexted.ts`) cut a Worktree, have a
// command write context files in it, in the slot's folder, in `/work` and in jr2's fallback home,
// and then start one Agent, the reader. Its first provider request is parked at the scripted model,
// so each step reads what the model was given: the system prompt of that request, as the provider
// received it. The pod's Harness log says whether the child that loads the files failed.

import { Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { kubectl, waitForAttached, waitForReadySandbox } from "./kind.steps.ts";
import type { E2EWorld } from "./world.ts";

/** The system text of a request body as an OpenAI-compatible provider receives it. */
function systemTextOf(raw: string): string {
  const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> };
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    if (m.role !== "system" && m.role !== "developer") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content as Array<{ text?: unknown }>) if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

/** The system prompt of the reader's first request: the first turn request that offers `finish`. */
async function readerSystem(world: E2EWorld): Promise<string> {
  await waitForAttached(world);
  assert.ok(world.provider, "the scenario's scripted model is running (World.setupKind)");
  await world.provider.holding("finish");
  const call = world.provider.calls.find((c) => c.stream && c.tools.includes("mcp__jr2__finish"));
  assert.ok(call, "the reader's request reached the scripted model");
  return systemTextOf(call.raw);
}

const frameOf = (path: string, text: string) => `<project_instructions path="${path}">\n${text}\n`;

Then(
  "the reader's system prompt holds the context file {string} with {string} in pi's frame",
  { timeout: 360_000 },
  async function (this: E2EWorld, path: string, text: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(system.includes("<project_context>\nProject-specific instructions and guidelines:"), system);
    assert.ok(system.includes(frameOf(path, text)), `the frame of ${path}:\n${system}`);
  },
);

Then(
  "the reader's system prompt holds no text of {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, marker: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(!system.includes(marker), `no ${marker} in:\n${system}`);
  },
);

Then(
  "the reader's system prompt names no context file {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, path: string): Promise<void> {
    const system = await readerSystem(this);
    assert.ok(!system.includes(`<project_instructions path="${path}">`), `no frame of ${path} in:\n${system}`);
  },
);

/** The system prompt lists the skill `name` with `description`, in pi's frame and place. */
async function listsSkill(world: E2EWorld, name: string, description: string): Promise<string> {
  const system = await readerSystem(world);
  assert.ok(system.includes("<skills>\n"), system);
  assert.ok(system.includes(`<name>${name}</name>`) && system.includes(description), system);
  // The skills follow the files, and the Briefing's standing part is last (ADR-0062).
  assert.ok(system.indexOf("</project_context>") < system.indexOf("<skills>"), system);
  assert.ok(system.indexOf("</skills>") < system.indexOf("<jr2-briefing>"), system);
  return system;
}

Then(
  "the reader's system prompt lists the skill {string} with {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, name: string, description: string): Promise<void> {
    await listsSkill(this, name, description);
  },
);

Then(
  "the reader's system prompt lists the skill {string} with {string} at {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, name: string, description: string, location: string): Promise<void> {
    const system = await listsSkill(this, name, description);
    assert.ok(
      system.includes(
        `<name>${name}</name>\n    <description>${description}</description>\n    <location>${location}</location>`,
      ),
      system,
    );
  },
);

Then(
  "the reader's system prompt holds {string} before {string} before {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, a: string, b: string, c: string): Promise<void> {
    const system = await readerSystem(this);
    const [ia, ib, ic] = [system.indexOf(a), system.indexOf(b), system.indexOf(c)];
    assert.ok(ia >= 0 && ib > ia && ic > ib, `the outermost first: ${a}, ${b}, ${c} in:\n${system}`);
  },
);

Then(
  "the domain wrote jr2's fallback home, and the Harness logged no failure to load a project context",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    // The command ran in the domain, as each of the Agent's programs does: it wrote the home.
    const home = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "sh",
      "-c",
      'cat "$HOME/.pi/agent/AGENTS.md"',
    ]);
    assert.equal(home.trim(), "CTX-HOME-RULE");
    const log = await kubectl(this, ["logs", `pod/${pod}`, "-c", "harness"]);
    assert.doesNotMatch(
      log,
      /no project context/,
      log
        .split("\n")
        .filter((l) => /project context/.test(l))
        .join("\n"),
    );
    assert.doesNotMatch(log, /the image user's context in .* is read/, "jr2's fallback home is never the image's");
  },
);

Then(
  "the reader's system prompt holds {string} before {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, a: string, b: string): Promise<void> {
    const system = await readerSystem(this);
    const [ia, ib] = [system.indexOf(a), system.indexOf(b)];
    assert.ok(ia >= 0 && ib > ia, `${a} before ${b} in:\n${system}`);
  },
);

Then(
  "no request to the model holds {string}",
  { timeout: 360_000 },
  async function (this: E2EWorld, marker: string): Promise<void> {
    await readerSystem(this);
    const calls = this.provider!.calls;
    assert.ok(calls.length > 0);
    for (const call of calls) assert.ok(!call.raw.includes(marker), `no ${marker} in a request:\n${call.raw}`);
  },
);

type PodSpec = {
  spec: {
    containers: Array<{
      name: string;
      image: string;
      env?: Array<{ name: string; value?: string }>;
      volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>;
    }>;
    volumes?: Array<{ name: string; image?: { reference: string } }>;
  };
};

/** The Harness container of the run's Sandbox pod, and the pod's volumes. */
async function harnessOf(world: E2EWorld): Promise<{ pod: string; spec: PodSpec["spec"] }> {
  const pod = (await waitForReadySandbox(world)).metadata.name;
  const spec = (JSON.parse(await kubectl(world, ["get", `pod/${pod}`, "-o", "json"])) as PodSpec).spec;
  return { pod, spec };
}

Then(
  "the pod mounts {string} read-only from its own Sandbox Image, there and under \\/run\\/jr2, and the Harness reads the user context under \\/run\\/jr2",
  { timeout: 120_000 },
  async function (this: E2EWorld, dir: string): Promise<void> {
    const { pod, spec } = await harnessOf(this);
    const harness = spec.containers.find((c) => c.name === "harness");
    assert.ok(harness, JSON.stringify(spec.containers.map((c) => c.name)));
    const volume = spec.volumes?.find((v) => v.name === "user-context");
    assert.equal(volume?.image?.reference, harness.image, "the Sandbox Image again");
    assert.deepEqual(
      harness.volumeMounts?.filter((m) => m.name === "user-context"),
      [dir, "/run/jr2/user-context"].map((mountPath) => ({
        name: "user-context",
        mountPath,
        subPath: dir.slice(1),
        readOnly: true,
      })),
    );
    assert.equal(harness.env?.filter((e) => e.name === "JR2_USER_CONTEXT").at(-1)?.value, dir);
    const log = await kubectl(this, ["logs", `pod/${pod}`, "-c", "harness"]);
    assert.ok(
      log.includes(`the image user's context in ${dir} is read, from a read-only mount at /run/jr2/user-context`),
      log,
    );
    assert.doesNotMatch(log, /no project context|no user context/, log);
  },
);

Then(
  "each try of a command in the domain to change the image user's context failed on a read-only file system",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    const { pod } = await harnessOf(this);
    const writes = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "cat",
      "/work/ctx-image-writes.txt",
    ]);
    assert.doesNotMatch(writes, /WROTE/, writes);
    assert.equal(writes.match(/Read-only file system/g)?.length, 4, writes);
    assert.match(writes, /^home:\/home\/node$/m, writes);
    // The move of `~/.pi` and a folder of the command's own at `~/.pi/agent`: done, or refused by an
    // overlay file system that does not move an image's folder. Either way, the reader's prompt has
    // the image's rule (the steps before).
    assert.match(writes, /^MOVED$|EXDEV/m, writes);
    // The image's files, as the image has them, where the Harness reads them.
    const rule = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "cat",
      "/run/jr2/user-context/AGENTS.md",
    ]);
    assert.equal(rule.trim(), "CTX-IMAGE-RULE");
  },
);

Then(
  "the domain made the image user's ~\\/.pi\\/agent, and the pod mounts none and tells the Harness none",
  { timeout: 120_000 },
  async function (this: E2EWorld): Promise<void> {
    const { pod, spec } = await harnessOf(this);
    const made = await kubectl(this, [
      "exec",
      `pod/${pod}`,
      "-c",
      "harness",
      "--",
      "sh",
      "-c",
      'cat "$HOME/.pi/agent/AGENTS.md"',
    ]);
    assert.equal(made.trim(), "CTX-MADE-RULE", "the command wrote the folder in the user's own home");
    assert.ok(!spec.volumes?.some((v) => v.name === "user-context"));
    const harness = spec.containers.find((c) => c.name === "harness")!;
    // jr2 names it with "" for none; the API server leaves an empty `value` out.
    const announced = harness.env?.filter((e) => e.name === "JR2_USER_CONTEXT").at(-1);
    assert.ok(announced, "jr2 sets JR2_USER_CONTEXT, so no harness.env entry names a folder");
    assert.equal(announced.value ?? "", "");
    const log = await kubectl(this, ["logs", `pod/${pod}`, "-c", "harness"]);
    assert.doesNotMatch(log, /the image user's context in .* is read/, log);
    assert.doesNotMatch(log, /no project context|no user context/, log);
  },
);
