// The command table (ADR-0009, ADR-0072): every verb of the CLI as plain data — its arguments, its
// flags, the env vars it reads, what it prints, what it does — plus the sections `jr2 --help` closes
// with. One source, three readers:
//
//   - `jr2 --help` / `help` / `-h` render the whole table, and `jr2 <verb> --help` one entry;
//   - each verb's `parseArgs` options are DERIVED from its entry (`parseCommand`), and the values it
//     returns are typed by the entry's flag names, so a verb that reads a flag its entry does not
//     declare fails `pnpm typecheck`; `command-table.test.ts` holds every verb to reading each flag
//     its entry declares, so a flag cannot be accepted and undocumented, or documented and not read;
//   - the docs' CLI Reference is generated from it, so the help and the site cannot disagree.
//
// The shared addressing flags (`-n`, `--context`, `--url`) and env vars (`JR2_URL`, `JR2_TOKEN`) are
// single objects that each entry lists BY REFERENCE: the global section's "taken by" lists and the
// output section's verb lists are computed from the entries, never written, so they cannot go stale.
// Text is data and layout is the renderer's: no entry holds a line break, a column or an ADR number
// in its prose.
//
// Builtins and the Kit version only, and no other kit code: the docs generator reads this module
// without an Instance.

import { parseArgs, type ParseArgsOptionDescriptor } from "node:util";
import { KIT_VERSION } from "@jr2/orchestrator/internal";

/** One flag. A `value` placeholder makes it a string option; without one it is a boolean. */
export type Flag = {
  /** The long name, without `--`. */
  readonly name: string;
  /** The one-letter alias, without `-`. */
  readonly short?: string;
  /** The value placeholder, without `<>`; absent for a boolean flag. */
  readonly value?: string;
  /** Rendered without brackets in the synopsis. The verb itself refuses its absence. */
  readonly required?: boolean;
  readonly description: string;
};

/** One positional argument, in order. */
export type Arg = { readonly name: string; readonly optional?: boolean; readonly description: string };

/** One env var the verb reads. */
export type EnvVar = { readonly name: string; readonly description: string };

/** The ADR-0009 output classes: one JSON result on stdout, a report table on stdout, or activity alone. */
export type OutputKind = "result" | "report" | "activity";

/** What a verb prints. `form` names the spelling that prints it, when that is not the whole verb. */
export type Output = { readonly kind: OutputKind; readonly form?: string };

/** One way to call a verb that takes only some of its flags together, shown as its own overview row. */
export type Form = {
  /** The entry's flags this form takes, in order. */
  readonly flags: readonly string[];
  /** Flags that are optional in the entry and required in this form. */
  readonly required?: readonly string[];
  /** A fixed value this form gives a flag, in place of its placeholder. */
  readonly values?: Readonly<Record<string, string>>;
  readonly summary: string;
};

export type Command = {
  readonly verb: string;
  /** The sub-verb, as in `kit push`. */
  readonly sub?: string;
  /** Other spellings of the verb that dispatch to it, as `--version` for `version`. */
  readonly aliases?: readonly string[];
  readonly args: readonly Arg[];
  /** Every flag the verb accepts — its own and the shared addressing ones it takes. */
  readonly flags: readonly Flag[];
  readonly env: readonly EnvVar[];
  /** One line: what the verb does. */
  readonly summary: string;
  /** Further paragraphs, shown under the summary. */
  readonly lines: readonly string[];
  /** The ways to call it, when one synopsis would permit combinations the verb refuses. */
  readonly forms?: readonly Form[];
  readonly output: readonly Output[];
  /** ADR numbers, as `"0019"`. */
  readonly adrs: readonly string[];
};

// --- the CLI as a whole ------------------------------------------------------------------------

/** `--help` / `-h` after a verb: the dispatcher's flag, which no entry may declare. */
export const HELP_FLAG = {
  name: "help",
  short: "h",
  description: "print this command's entry, and run nothing",
} as const satisfies Flag;

/** The CLI's own header: what it is, the spellings that print the whole table, and the addressing
 * section's lead. */
export const GLOBAL = {
  summary: "orchestrate agentic workflows",
  adrs: ["0009"],
  /** The verbs that print this help. */
  help: ["help", "--help", "-h"],
  addressing: { summary: "address the deployment; each lists the verbs that take it", adrs: ["0019"] },
} as const;

// --- the shared addressing (ADR-0019) ---------------------------------------------------------

export const NAMESPACE_FLAG = {
  name: "namespace",
  short: "n",
  value: "ns",
  description: "the deployment's namespace (default: the config's `name`, then the Instance folder's name)",
} as const satisfies Flag;
export const CONTEXT_FLAG = {
  name: "context",
  value: "ctx",
  description: "the kube context (default: kubectl's current context)",
} as const satisfies Flag;
export const URL_FLAG = {
  name: "url",
  value: "u",
  description: "attach to a specific orchestrator (skips kube entirely)",
} as const satisfies Flag;
export const JR2_URL = {
  name: "JR2_URL",
  description: "the orchestrator to attach to, when `--url` is not given",
} as const satisfies EnvVar;
export const JR2_TOKEN = {
  name: "JR2_TOKEN",
  description:
    "the Instance token to send: with `--url` / `JR2_URL` the only one, and otherwise used in place of the one read from the cluster",
} as const satisfies EnvVar;

/** The addressing every run verb takes: a deployment by kube, or an orchestrator by url. */
const TARGET_FLAGS = [URL_FLAG, NAMESPACE_FLAG, CONTEXT_FLAG] as const;
const TARGET_ENV = [JR2_URL, JR2_TOKEN] as const;

export type GlobalOption = { readonly flag?: Flag; readonly env?: EnvVar; readonly description: string };

/** The global options section. Which verbs take each one is computed from `COMMANDS`. */
export const GLOBAL_OPTIONS: readonly GlobalOption[] = [
  { flag: NAMESPACE_FLAG, description: NAMESPACE_FLAG.description },
  { flag: CONTEXT_FLAG, description: CONTEXT_FLAG.description },
  { flag: URL_FLAG, env: JR2_URL, description: URL_FLAG.description },
  { env: JR2_TOKEN, description: JR2_TOKEN.description },
];

// --- the verbs ---------------------------------------------------------------------------------

const RUN_ID = { name: "runId", description: "the run, or a unique prefix of its id" } as const satisfies Arg;
const JSON_REPORT = {
  name: "json",
  description: "print the one report object on stdout instead of the table",
} as const satisfies Flag;
const RESULT = [{ kind: "result" }] as const;
const ACTIVITY = [{ kind: "activity" }] as const;

/** The table with its literal names, which `CommandName` and `FlagValues` are derived from. */
const TABLE = [
  {
    verb: "version",
    aliases: ["--version"],
    args: [],
    flags: [{ name: "local", description: "report what runs here and skip the cluster" }, JSON_REPORT, ...TARGET_FLAGS],
    env: [
      JR2_URL,
      {
        name: "JR2_HANDOFF_FROM",
        description: "set by the global `jr2` that handed off to this one, which the report names",
      },
    ],
    summary: "what runs here (this jr2, the global that handed off, the Instance's Kit) and what the cluster runs",
    lines: ["--local skips the cluster"],
    output: [{ kind: "report" }],
    adrs: ["0009", "0056"],
  },
  {
    verb: "init",
    args: [{ name: "dir", optional: true, description: "the folder to scaffold (default: the current directory)" }],
    flags: [{ name: "name", value: "n", description: "the package name in package.json (default: the folder's name)" }],
    env: [],
    summary: "scaffold a new instance folder",
    lines: [
      "writes AGENTS.md, with the jr2 docs index between its two jr2-docs markers (empty when this jr2 has no docs bundle), and a CLAUDE.md that imports it",
    ],
    output: ACTIVITY,
    adrs: ["0009", "0072"],
  },
  {
    verb: "check",
    args: [],
    flags: [],
    env: [],
    summary: "typecheck this instance and load its workflows, as `jr2 up` does first, with no cluster",
    lines: [
      "runs the check that `jr2 up` runs before it stages the Assembly, and exits 1 with the same refusal: a type error, a module that refuses to load (a refusal of `createMachine`, `defineEvent` or `workspace()`), an Open part, a Chart file, a dispatch, an Effect secret or a Size",
      "reads no kube context and writes no file, so an Assistant runs it before a handoff",
    ],
    output: ACTIVITY,
    adrs: ["0050"],
  },
  {
    verb: "up",
    args: [],
    flags: [
      {
        name: "yes",
        description:
          "answer the questions non-interactively: confirm first-time setup, and take the recommended git ssh key source (for CI)",
      },
      { name: "force", description: "build every image again, even one already built or deployed" },
      {
        name: "skip-provider-preflight",
        description:
          "do not run the provider preflight: no check pod checks the models, so a check that fails when the model works does not stop the converge",
      },
      NAMESPACE_FLAG,
      CONTEXT_FLAG,
    ],
    env: [{ name: "NO_COLOR", description: "draws the git ssh key menu without highlight" }],
    summary: "converge the current kube context to this instance",
    lines: [
      "reads each `git.credentials` token from the env var it names, after the Instance's .env",
      "before the cluster work, sets the text between the jr2-docs markers in AGENTS.md to the docs index of the Kit version, and changes nothing outside them; a folder with no markers is left alone",
    ],
    output: ACTIVITY,
    adrs: ["0019", "0051", "0069", "0072"],
  },
  {
    verb: "down",
    args: [],
    flags: [
      { name: "all", description: "also uninstall the per-cluster operator" },
      { name: "yes", description: "do not ask for confirmation (for CI)" },
      NAMESPACE_FLAG,
      CONTEXT_FLAG,
    ],
    env: [],
    summary: "remove the instance from the cluster",
    lines: ["--all: operator too; --yes: no confirmation"],
    output: ACTIVITY,
    adrs: ["0019"],
  },
  {
    verb: "gc",
    args: [],
    flags: [
      { name: "dry-run", description: "print what would be removed, and remove nothing" },
      {
        name: "repo-ttl",
        value: "ttl",
        description: "how long since a run last attached before an unbound Repo is garbage (default: 7d)",
      },
      CONTEXT_FLAG,
    ],
    env: [],
    summary:
      "remove jr2's images that no live instance names, and Repo resources no Machine binds and no run attached lately",
    lines: [],
    output: ACTIVITY,
    adrs: ["0039", "0051"],
  },
  {
    verb: "kit",
    sub: "push",
    args: [{ name: "registry", description: "the registry to mirror into, as `kitRegistry` names it" }],
    flags: [],
    env: [],
    summary: "mirror the published kit images into a registry",
    lines: [
      `the v${KIT_VERSION} kit images (harness, operator, orchestrator) from their canonical home, and the Custodian's pinned Envoy from its own, for a cluster whose \`kitRegistry\` names the registry`,
    ],
    output: RESULT,
    adrs: ["0044", "0059", "0069"],
  },
  {
    verb: "run",
    args: [{ name: "workflow", description: "the workflow to start, or a named Chart as `<wrapper>/<name>`" }],
    flags: [
      { name: "input", value: "json", description: "the run's input, as a JSON object (default: {})" },
      { name: "detach", description: "print the runId and return, and do not stream" },
      ...TARGET_FLAGS,
    ],
    env: TARGET_ENV,
    summary: "start a run; stream activity, print terminal result",
    lines: [
      "--detach: just print the runId and return",
      "a Chart that the door refuses prints one line for each rule that it fails",
    ],
    output: RESULT,
    adrs: ["0009", "0070"],
  },
  {
    verb: "runs",
    args: [],
    flags: [
      { name: "workflows", description: "print the Workflow listing as the JSON result instead" },
      ...TARGET_FLAGS,
    ],
    env: TARGET_ENV,
    summary: 'list live runs; "placing" names the Workspaces that wait for capacity, and "status <runId>" says why',
    lines: [
      "the Workflows a run can start on stderr, each with its origin (machine, chart file, chart) and a Chart wrapper's Charts under it; --workflows prints that listing as the result",
      "a runtime Chart has no verb: PUT or DELETE /workflows/<wrapper>/charts/<name> with the Instance token (an MCP or curl), then `jr2 run <wrapper>/<name>` starts it",
    ],
    output: RESULT,
    adrs: ["0009", "0064", "0070"],
  },
  {
    verb: "status",
    args: [{ ...RUN_ID, optional: true, description: "the run to read; without one, the instance's Repos" }],
    flags: [{ ...JSON_REPORT, description: `${JSON_REPORT.description} (without a runId)` }, ...TARGET_FLAGS],
    env: TARGET_ENV,
    summary: "print a run's current status (read-through), or the instance's Repos, per node, when given none",
    lines: [],
    output: [
      { kind: "result", form: "status <runId>" },
      { kind: "report", form: "bare status" },
    ],
    adrs: ["0048", "0051"],
  },
  {
    verb: "logs",
    args: [RUN_ID],
    flags: [{ name: "follow", short: "f", description: "follow until the run settles" }, ...TARGET_FLAGS],
    env: TARGET_ENV,
    summary: "replay a run's status; -f to follow until it settles",
    lines: [],
    output: RESULT,
    adrs: ["0009"],
  },
  {
    verb: "send",
    args: [RUN_ID],
    flags: [
      {
        name: "event",
        value: "name",
        required: true,
        description: "CANCEL (run control), or with --gate an event the gate accepts",
      },
      { name: "gate", value: "gate", description: "the open gate to deliver the event to" },
      { name: "input", value: "json", description: "the event's input, as a JSON object (with --gate)" },
      { name: "keep", description: "with --event CANCEL: keep the Workspaces for inspection until the idle timeout" },
      ...TARGET_FLAGS,
    ],
    env: TARGET_ENV,
    summary: "abandon a live run, or deliver a workflow event to an open gate",
    lines: [],
    forms: [
      {
        flags: ["event", "keep"],
        values: { event: "CANCEL" },
        summary:
          "abandon a live run and destroy its Workspaces; --keep keeps them for inspection until the idle timeout",
      },
      {
        flags: ["gate", "event", "input"],
        required: ["gate"],
        summary: "deliver a workflow event to an open gate",
      },
    ],
    output: ACTIVITY,
    adrs: ["0009", "0011", "0013", "0025"],
  },
] as const satisfies readonly Command[];

/** Every verb, in help order. */
export const COMMANDS: readonly Command[] = TABLE;

type Entry = (typeof TABLE)[number];
type NameOf<C> = C extends { readonly verb: infer V extends string; readonly sub: infer S extends string }
  ? `${V} ${S}`
  : C extends { readonly verb: infer V extends string }
    ? V
    : never;
/** The names an entry is looked up by: the verb, or `verb sub` — derived from the table. */
export type CommandName = NameOf<Entry>;
type EntryNamed<C, N> = C extends unknown ? (NameOf<C> extends N ? C : never) : never;

/** The values bag of entry `N`: its flags' names and no other key. Each is `string | boolean`
 * whatever its kind: under `strict: false` a string option given no value is `true`. */
export type FlagValues<N extends CommandName> = {
  [F in EntryNamed<Entry, N>["flags"][number] as F["name"]]?: string | boolean;
};

// --- the closing sections ----------------------------------------------------------------------

/** One prose section after the global options. `text` is one paragraph; the renderer wraps it. */
export type Section = { readonly title: string; readonly text: string };

/** The spellings of the verbs that print `kind`, in table order. */
export function printing(kind: OutputKind): string[] {
  return COMMANDS.flatMap((c) => c.output.filter((o) => o.kind === kind).map((o) => o.form ?? nameOf(c)));
}

/** The prose sections after the global options, in order. */
export const SECTIONS: readonly Section[] = [
  {
    title: "run ids",
    text: "any <runId> above may be abbreviated to a unique prefix (4+ chars, git-style); an ambiguous prefix lists the candidates and fails rather than guessing",
  },
  {
    title: "env",
    text: "the Instance's .env is loaded before any verb; a variable already set in the environment wins",
  },
  {
    title: "output",
    text:
      `result verbs (${printing("result").join(", ")}) print one JSON result on stdout and activity on stderr, ` +
      `so \`jr2 run … | jq\` yields the result; report verbs (${printing("report").join(", ")}) print a table on ` +
      `stdout, or the one object with --json; activity verbs (${printing("activity").join(", ")}) print activity alone`,
  },
];

export const EXIT_CODES: readonly { readonly code: number; readonly meaning: string }[] = [
  { code: 0, meaning: "ok" },
  { code: 1, meaning: "runtime error" },
  { code: 2, meaning: "usage" },
];

// --- lookup + parse ------------------------------------------------------------------------------

/** `verb` or `verb sub` — the key `CommandName` spells. */
export function nameOf(command: Command): string {
  return command.sub ? `${command.verb} ${command.sub}` : command.verb;
}

export function commandNamed(name: CommandName): Command {
  const found = COMMANDS.find((c) => nameOf(c) === name);
  if (!found) throw new Error(`no command-table entry "${name}"`);
  return found;
}

/** The entries a typed verb dispatches to — one, or every sub-verb of it (`kit`). */
export function commandsFor(verb: string): Command[] {
  return COMMANDS.filter((c) => c.verb === verb || c.aliases?.includes(verb));
}

/** The `parseArgs` options an entry's flags declare — the only options any verb parses with. */
export function optionsOf(command: Command): Record<string, ParseArgsOptionDescriptor> {
  return Object.fromEntries(
    command.flags.map((f) => [
      f.name,
      { type: f.value === undefined ? "boolean" : "string", ...(f.short ? { short: f.short } : {}) },
    ]),
  );
}

/** Parse a verb's argv against its entry. `strict: false`, as every verb always has: an unknown flag
 * is ignored, and the verb refuses what it cannot run on. The values are typed by the entry, so a
 * read of a flag the entry does not declare is a type error. */
export function parseCommand<N extends CommandName>(
  name: N,
  args: string[],
): { values: FlagValues<N>; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: optionsOf(commandNamed(name)),
  });
  return { values: values as FlagValues<N>, positionals };
}

/** True when argv asks for a verb's help: `--help` or `-h` as a flag, not as a flag's value or past `--`. */
export function asksForHelp(commands: Command[], args: string[]): boolean {
  const options: Record<string, ParseArgsOptionDescriptor> = Object.assign({}, ...commands.map(optionsOf));
  options[HELP_FLAG.name] = { type: "boolean", short: HELP_FLAG.short };
  const { values } = parseArgs({ args, allowPositionals: true, strict: false, options });
  return values[HELP_FLAG.name] === true;
}

// --- render --------------------------------------------------------------------------------------

/** The help's line width; every line wraps to it. */
const WIDTH = 100;
/** Where the overview's text column starts. */
const COLUMN = 36;
/** Where the global options' and an entry's option text column starts. */
const NARROW = 28;

function flagSpelling(f: Flag, value = f.value === undefined ? undefined : `<${f.value}>`): string {
  const name = f.short ? `-${f.short}` : `--${f.name}`;
  return value === undefined ? name : `${name} ${value}`;
}

function shared(f: Flag): boolean {
  return GLOBAL_OPTIONS.some((g) => g.flag === f);
}

function head(command: Command, aliases: boolean): string {
  return aliases && command.aliases?.length ? [nameOf(command), ...command.aliases].join(" | ") : nameOf(command);
}

/** The synopsis tokens: `verb sub`, then `<arg>` / `[arg]`, then `[--flag <v>]`… — with the shared
 * addressing flags only when `all`, and only a form's flags when given one. */
function tokens(command: Command, opts: { all?: boolean; form?: Form; aliases?: boolean } = {}): string[] {
  const { all = false, form, aliases = false } = opts;
  const args = command.args.map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`));
  const own = form
    ? form.flags.map((name) => command.flags.find((f) => f.name === name)!)
    : command.flags.filter((f) => !shared(f));
  const flags = [...own, ...(all ? command.flags.filter(shared) : [])].map((f) => {
    const fixed = form?.values?.[f.name];
    const spelled = fixed === undefined ? flagSpelling(f) : flagSpelling(f, fixed);
    const required = f.required || fixed !== undefined || form?.required?.includes(f.name);
    return required ? spelled : `[${spelled}]`;
  });
  return [head(command, aliases), ...args, ...flags];
}

/** `verb sub <arg> [arg] [--flag <v>]…` — with the shared addressing flags only when `all`. */
export function synopsis(command: Command, all = false): string {
  return tokens(command, { all }).join(" ");
}

/** Lay `words` out after `prefix`, wrapped to `WIDTH`; each further line is indented by `indent`. */
function fill(prefix: string, words: string[], indent: number): string[] {
  const out: string[] = [];
  let line = prefix;
  let bare = true;
  for (const word of words) {
    if (!bare && line.length + 1 + word.length > WIDTH) {
      out.push(line);
      line = " ".repeat(indent) + word;
    } else {
      line = bare ? line + word : `${line} ${word}`;
    }
    bare = false;
  }
  out.push(line);
  return out;
}

/** Word-wrap `text` to `WIDTH`, each line indented by `indent` spaces. */
function wrap(text: string, indent: number): string[] {
  return fill(" ".repeat(indent), text.split(" "), indent);
}

/** `usage: jr2 <synopsis>` for each form of the entry (one when it has none), wrapped with a hanging
 * indent under the synopsis. */
function usageLines(command: Command): string[] {
  const forms: (Form | undefined)[] = command.forms?.length ? [...command.forms] : [undefined];
  return forms.flatMap((form, i) => {
    const prefix = i === 0 ? "usage: jr2 " : "       jr2 ";
    const [first, ...rest] = tokens(command, { all: true, form });
    return fill(prefix, [first!, ...rest], prefix.length + first!.length + 1);
  });
}

/** The usage a verb prints on a usage error. */
export function usageLine(name: CommandName): string {
  return usageLines(commandNamed(name)).join("\n");
}

function adrs(list: readonly string[]): string {
  return list.length ? ` (${list.map((n) => `ADR-${n}`).join(", ")})` : "";
}

/** Two columns: `left` at 2, the wrapped `text` paragraphs at `column` — on the same line when it fits. */
function row(left: string, texts: readonly string[], column: number): string[] {
  const body = texts.flatMap((t) => wrap(t, column));
  const first = `  ${left}`;
  if (first.length + 2 <= column && body.length) return [first.padEnd(column) + body[0]!.trimStart(), ...body.slice(1)];
  return [first, ...body];
}

/** The overview rows of one entry: one per form, or one with the summary and its paragraphs. */
function overview(command: Command): string[] {
  if (command.forms?.length) {
    return command.forms.flatMap((form, i) =>
      row(
        tokens(command, { form, aliases: true }).join(" "),
        [form.summary + (i === 0 ? adrs(command.adrs) : "")],
        COLUMN,
      ),
    );
  }
  return row(
    tokens(command, { aliases: true }).join(" "),
    [command.summary + adrs(command.adrs), ...command.lines],
    COLUMN,
  );
}

/** The verbs whose entries take `option` — the global section's computed "taken by". */
function takenBy(option: GlobalOption): string[] {
  return COMMANDS.filter(
    (c) => (option.flag && c.flags.includes(option.flag)) || (option.env && c.env.includes(option.env)),
  ).map(nameOf);
}

function globalSpelling(option: GlobalOption): string {
  const flag = option.flag
    ? `${option.flag.short ? `-${option.flag.short}/` : ""}--${option.flag.name} <${option.flag.value}>`
    : undefined;
  return [flag, option.env?.name].filter(Boolean).join(" / ");
}

/** `jr2 --help`: the whole table. */
export function renderHelp(): string {
  const lines = [
    `jr2 — ${GLOBAL.summary}${adrs(GLOBAL.adrs)}`,
    "",
    `usage: jr2 <command> [args]        (jr2 <command> --${HELP_FLAG.name} | -${HELP_FLAG.short}: that command alone;`,
    `                                    jr2 ${GLOBAL.help.join(" | ")}: this help)`,
    "",
    ...COMMANDS.flatMap(overview),
    "",
    `global — ${GLOBAL.addressing.summary}${adrs(GLOBAL.addressing.adrs)}:`,
    ...GLOBAL_OPTIONS.flatMap((g) => row(globalSpelling(g), [g.description, `(${takenBy(g).join(", ")})`], NARROW)),
  ];
  for (const s of SECTIONS) {
    const label = `${s.title}: `;
    lines.push("", ...fill(label, s.text.split(" "), label.length));
  }
  lines.push("", `exit codes: ${EXIT_CODES.map((e) => `${e.code} ${e.meaning}`).join(", ")}`);
  return lines.join("\n");
}

/** `jr2 <verb> --help`: one entry, every flag and env var named. */
export function renderCommand(command: Command): string {
  const lines = [...usageLines(command), "", ...wrap(command.summary + adrs(command.adrs), 2)];
  for (const l of command.lines) lines.push(...wrap(l, 2));
  for (const form of command.forms ?? [])
    lines.push(...wrap(`${tokens(command, { form }).join(" ")}: ${form.summary}`, 2));
  if (command.aliases?.length) lines.push(...wrap(`also: ${command.aliases.map((a) => `jr2 ${a}`).join(", ")}`, 2));
  if (command.args.length) {
    lines.push("", "arguments:");
    for (const a of command.args)
      lines.push(...row(a.optional ? `[${a.name}]` : `<${a.name}>`, [a.description], NARROW));
  }
  if (command.flags.length) {
    lines.push("", "options:");
    for (const f of command.flags) {
      const spelling = `${f.short ? `-${f.short}, ` : ""}--${f.name}${f.value === undefined ? "" : ` <${f.value}>`}`;
      lines.push(...row(spelling, [f.description], NARROW));
    }
  }
  if (command.env.length) {
    lines.push("", "env:");
    for (const e of command.env) lines.push(...row(e.name, [e.description], NARROW));
  }
  return lines.join("\n");
}
