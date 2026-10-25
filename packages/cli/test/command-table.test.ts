// The command table (ADR-0009, ADR-0072): one source for what each verb accepts and what the help
// says. The claims: every verb parses with its entry's options and no others, and reads every flag
// its entry declares (a read of an undeclared one is `pnpm typecheck`'s to refuse: `FlagValues`);
// every env var the CLI reads is named in an entry; `jr2 <verb> --help` prints that entry and never
// runs the verb.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  COMMANDS,
  commandNamed,
  GLOBAL,
  GLOBAL_OPTIONS,
  nameOf,
  optionsOf,
  renderCommand,
  renderHelp,
  synopsis,
  type CommandName,
} from "../src/command-table.ts";
import type { Io } from "../src/output.ts";
import { KIT_VERSION } from "@jr2/orchestrator/internal";

const SRC = join(import.meta.dirname, "..", "src");

/** The verb file a table entry lives in: `commands/<verb>.ts`. */
async function sourceOf(verb: string): Promise<string> {
  return readFile(join(SRC, "commands", `${verb}.ts`), "utf8");
}

test("every verb file parses with its own entry's options, and with no parseArgs of its own", async () => {
  const files = (await readdir(join(SRC, "commands"))).filter((f) => f.endsWith(".ts"));
  const verbs = new Set(COMMANDS.map((c) => c.verb));
  assert.deepEqual(
    files.map((f) => f.replace(/\.ts$/, "")).sort(),
    [...verbs].sort(),
    "one verb file per table verb, and no verb without an entry",
  );
  for (const command of COMMANDS) {
    const source = await sourceOf(command.verb);
    assert.doesNotMatch(source, /\bparseArgs\b/, `${command.verb}.ts declares options outside the table`);
    const calls = [...source.matchAll(/parseCommand\("([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(calls, [nameOf(command)], `${command.verb}.ts parses once, with its own entry`);
  }
});

/** The flag names a verb file reads off its `parseCommand` values: `values.x`, `values["x"]`, and
 * the shared addressing three that `targetOptions(values)` reads. `(?<![.\w])` leaves out another
 * object's `values` (`held.values`, `Object.values`); a computed `values[name]` is not a flag read. */
function flagsRead(source: string): Set<string> {
  const read = new Set<string>();
  for (const m of source.matchAll(/(?<![.\w])values\.([a-z][\w]*)/g)) read.add(m[1]!);
  for (const m of source.matchAll(/(?<![.\w])values\["([^"]+)"\]/g)) read.add(m[1]!);
  if (/\btargetOptions\(values\)/.test(source)) for (const name of ["url", "namespace", "context"]) read.add(name);
  return read;
}

test("every verb file reads each flag its entry declares, and no other", async () => {
  for (const command of COMMANDS) {
    const read = flagsRead(await sourceOf(command.verb));
    assert.deepEqual([...read].sort(), command.flags.map((f) => f.name).sort(), `${command.verb}.ts`);
  }
});

test("the flag-read scan sees both spellings, and the shared three through targetOptions", () => {
  const read = flagsRead('values.yes; values["dry-run"]; held.values.x; Object.values(m); targetOptions(values)');
  assert.deepEqual([...read].sort(), ["context", "dry-run", "namespace", "url", "yes"]);
});

test("the options a verb parses with are exactly its entry's flags", () => {
  for (const command of COMMANDS) {
    const options = optionsOf(command);
    assert.deepEqual(Object.keys(options).sort(), command.flags.map((f) => f.name).sort(), nameOf(command));
    for (const flag of command.flags) {
      assert.equal(options[flag.name]?.type, flag.value === undefined ? "boolean" : "string", `--${flag.name}`);
      assert.equal(options[flag.name]?.short, flag.short, `--${flag.name}'s alias`);
    }
    const shorts = command.flags.flatMap((f) => (f.short ? [f.short] : []));
    assert.equal(new Set(shorts).size, shorts.length, `${nameOf(command)}: no alias twice`);
    assert.ok(!command.flags.some((f) => f.name === "help" || f.short === "h"), "--help/-h is the dispatcher's");
  }
});

test("every env var the CLI reads is named in the table", async () => {
  // `HOME` is the platform's, not jr2's; every other name read off the environment is the user's to set.
  const named = new Set([...COMMANDS.flatMap((c) => c.env.map((e) => e.name))]);
  const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".ts"));
  const read = new Set<string>();
  for (const file of files) {
    // Comment lines left out: the scaffold's templates show an author `process.env` in a comment.
    const source = (await readFile(join(SRC, file), "utf8"))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");
    for (const m of source.matchAll(/\b(?:io\.env|process\.env)\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]!);
  }
  read.delete("HOME");
  // The handoff variable is read by name through its constant (`env[HANDOFF_ENV]`).
  read.add("JR2_HANDOFF_FROM");
  for (const name of read) assert.ok(named.has(name), `${name} is read but no entry names it`);
});

test("a form names only its entry's flags", () => {
  for (const command of COMMANDS) {
    const names = command.flags.map((f) => f.name);
    for (const form of command.forms ?? []) {
      for (const name of [...form.flags, ...(form.required ?? []), ...Object.keys(form.values ?? {})]) {
        assert.ok(names.includes(name), `${nameOf(command)}: a form names --${name}`);
      }
    }
  }
});

test("prose holds no ADR number: an entry's ADRs are data", () => {
  for (const command of COMMANDS) {
    const prose = [
      command.summary,
      ...command.lines,
      ...(command.forms ?? []).map((f) => f.summary),
      ...command.args.map((a) => a.description),
      ...command.flags.map((f) => f.description),
      ...command.env.map((e) => e.description),
    ];
    for (const text of prose) assert.doesNotMatch(text, /ADR-/, `${nameOf(command)}: ${text}`);
  }
});

test("each ADR an entry names is a file in docs/adr/", async () => {
  const adrs = new Set(
    (await readdir(join(import.meta.dirname, "..", "..", "..", "docs", "adr"))).map((f) => f.slice(0, 4)),
  );
  const named = [
    ...GLOBAL.adrs.map((adr) => ["global", adr] as const),
    ...GLOBAL.addressing.adrs.map((adr) => ["global addressing", adr] as const),
    ...COMMANDS.flatMap((command) => command.adrs.map((adr) => [nameOf(command), adr] as const)),
  ];
  for (const [where, adr] of named) {
    assert.match(adr, /^\d{4}$/, `${where}: write an ADR as its bare number, as "0019"`);
    assert.ok(adrs.has(adr), `${where}: no ADR-${adr} in docs/adr/`);
  }
});

test("the help names every entry, and the shared options with the verbs that take them", () => {
  const help = renderHelp();
  for (const command of COMMANDS.filter((c) => !c.forms)) {
    const name = nameOf(command);
    const head = [name, ...(command.aliases ?? [])].join(" | ");
    assert.ok(help.includes(head + synopsis(command).slice(name.length)), name);
  }
  assert.match(help, /version \| --version \[--local\] \[--json\]/);
  assert.match(help, /send <runId> --event CANCEL \[--keep\]/);
  assert.match(help, /send <runId> --gate <gate> --event <name> \[--input <json>\]/);
  assert.match(help, /down \[--all\] \[--yes\]/);
  assert.match(help, /JR2_TOKEN/);
  const namespace = GLOBAL_OPTIONS.find((g) => g.flag?.name === "namespace")!;
  assert.ok(namespace, "-n is a global option");
  assert.match(help, /\(version, up, down, run, runs, status, logs, send\)/, "-n is taken by up and down too");
  assert.match(help, /exit codes: 0 ok, 1 runtime error, 2 usage/);
  assert.match(help, /jr2 help \| --help \| -h/);
});

test("the output section's verb lists are computed: each entry is named once, send as activity", () => {
  const help = renderHelp().replace(/\s+/g, " ");
  assert.match(help, /result verbs \(kit push, run, runs, status <runId>, logs\)/);
  assert.match(help, /report verbs \(version, bare status\)/);
  assert.match(help, /activity verbs \(init, check, up, down, gc, send\)/);
});

test("every line of the help, and of each entry's, fits the width", () => {
  for (const text of [renderHelp(), ...COMMANDS.map(renderCommand)]) {
    for (const line of text.split("\n")) assert.ok(line.length <= 100, `${line.length}: ${line}`);
  }
});

/** A kube port that records every touch and answers none — a verb that ran would show here. */
function untouchable(touched: string[]) {
  return new Proxy(
    {},
    {
      get: (_, key) => () => {
        touched.push(String(key));
        throw new Error(`touched ${String(key)}`);
      },
    },
  );
}

for (const command of COMMANDS) {
  for (const flag of ["--help", "-h"]) {
    test(`jr2 ${nameOf(command)} ${flag} prints its entry and runs nothing`, async () => {
      // An Instance folder, so an instance verb that ran would get past the folder walk to the
      // ports below — `up --help` must never reach a cluster.
      const dir = await mkdtemp(join(tmpdir(), "jr2-help-"));
      await writeFile(join(dir, "jr2.config.ts"), `export default { name: "help" };\n`);
      try {
        const out: string[] = [];
        const err: string[] = [];
        const touched: string[] = [];
        const io: Io = {
          stdout: (s) => out.push(s),
          stderr: (s) => err.push(s),
          env: {},
          cwd: dir,
          kube: untouchable(touched) as Io["kube"],
          kubeAdmin: untouchable(touched) as Io["kubeAdmin"],
          build: untouchable(touched) as Io["build"],
          typecheck: untouchable(touched) as Io["typecheck"],
          fetch: () => {
            touched.push("fetch");
            throw new Error("fetched");
          },
        };
        const argv = [command.verb, ...(command.sub ? [command.sub] : []), flag];
        assert.equal(await main(argv, io), 0);
        assert.ok(err.join("").startsWith(`usage: jr2 ${nameOf(command)}`), err.join(""));
        assert.deepEqual(out, [], "help is activity: nothing on stdout");
        assert.deepEqual(touched, []);
        assert.deepEqual(await readdir(dir), ["jr2.config.ts"], "nothing is written (`init --help` scaffolds nothing)");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("`jr2 kit --help` prints the sub-verbs' entries, and `--version --help` the version entry", async () => {
  for (const [argv, name] of [
    [["kit", "--help"], "kit push"],
    [["--version", "--help"], "version"],
  ] as const) {
    const err: string[] = [];
    const io: Io = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: "/" };
    assert.equal(await main([...argv], io), 0);
    assert.ok(err.join("").startsWith(`usage: jr2 ${name}`));
  }
});

test("-h as a flag's value, or past `--`, is not a help request", async () => {
  // `send` resolves its target before anything else it could print, and cwd "/" holds no Instance:
  // reaching that error proves the verb ran.
  for (const argv of [
    ["send", "abcd1234", "--event", "go", "--gate", "g", "--input", "-h"],
    ["run", "--", "-h"],
  ]) {
    const err: string[] = [];
    const io: Io = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: "/" };
    assert.equal(await main(argv, io), 1, argv.join(" "));
    assert.match(err.join(""), /not inside a jr2 instance/);
  }
});

test("a usage error prints the verb's usage line from the table", async () => {
  const err: string[] = [];
  const io: Io = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: "/" };
  assert.equal(await main(["run"], io), 2);
  assert.ok(err.join("").startsWith(`usage: jr2 ${synopsis(commandNamed("run" satisfies CommandName), true)}`));
});

test("`jr2 kit push --help` names the Kit version whose images it mirrors", () => {
  assert.match(
    renderCommand(commandNamed("kit push")),
    new RegExp(`the v${KIT_VERSION.replace(/\./g, "\\.")} kit images`),
  );
});
