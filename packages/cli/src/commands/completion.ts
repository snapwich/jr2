// `jr2 completion bash|zsh|fish` (ADR-0009): the shell completion script, a value on stdout.
//
// The script is small and the same for each shell: on each TAB it asks this jr2 for the words that
// complete the command line, with `jr2 completion __complete <words…>`, the last word being the one
// the cursor is in. The answer comes from the command table (`complete`), so a verb, a sub-verb or a
// flag that the CLI does not take never completes. Some values come from the deployment: Workspace
// handles (from the Sandbox CRs' labels, over kube), live run ids, Workflow names, and a run's Agent
// slots (from the Orchestrator). Each lookup has 2 s: a slower one offers nothing, so a slow cluster
// never holds the shell. `__complete` is not in the table: no person types it.

import { JR2Client } from "../client.ts";
import { commandsFor, COMMANDS, parseCommand, usageLine, type Command } from "../command-table.ts";
import { resolveRoot, resolveTarget } from "../instance.ts";
import { activity, type Io } from "../output.ts";
import { kubectlWorkspaces, rowOf } from "../workspaces.ts";
import { basename } from "node:path";
import { loadConfig } from "@jr2/orchestrator/internal";

/** The longest a dynamic lookup may take before it offers nothing. */
export const LOOKUP_BUDGET_MS = 2_000;

/** A value from the deployment, by what the argument or the flag names. */
export type DynamicKind = "run" | "workflow" | "agent" | "workspace";

/** Where `complete` finds dynamic values: `run` is the run id that the line names, for `agent`. */
export type Lookup = (
  kind: DynamicKind,
  ctx: { run?: string; namespace?: string; context?: string },
) => Promise<string[]>;

/** The completion scripts: each asks `jr2 completion __complete` with the words up to the cursor. */
export const SCRIPTS: Readonly<Record<"bash" | "zsh" | "fish", string>> = {
  bash: [
    "# jr2 completion for bash: source <(jr2 completion bash)",
    "_jr2_complete() {",
    "  local IFS=$'\\n'",
    '  COMPREPLY=($(jr2 completion __complete "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))',
    "}",
    "complete -o default -F _jr2_complete jr2",
    "",
  ].join("\n"),
  zsh: [
    "#compdef jr2",
    "# jr2 completion for zsh: source <(jr2 completion zsh)",
    "_jr2() {",
    "  local -a candidates",
    // Unquoted, so an empty answer gives no element, and compadd adds no empty match.
    '  candidates=(${(f)"$(jr2 completion __complete "${(@)words[2,CURRENT]}" 2>/dev/null)"})',
    '  (( ${#candidates} )) && compadd -Q -- "${candidates[@]}"',
    "}",
    "compdef _jr2 jr2",
    "",
  ].join("\n"),
  fish: [
    "# jr2 completion for fish: jr2 completion fish | source",
    "function __jr2_complete",
    "    set -l words (commandline -opc) (commandline -ct)",
    "    jr2 completion __complete $words[2..-1] 2>/dev/null",
    "end",
    "complete -c jr2 -f -a '(__jr2_complete)'",
    "",
  ].join("\n"),
};

/** The dynamic kind of a positional argument, by its name in the table. */
function argKind(name: string): DynamicKind | "shell" | undefined {
  if (name === "runId" || name === "run") return "run";
  if (name === "workflow") return "workflow";
  if (name === "agent") return "agent";
  if (name === "ws") return "workspace";
  if (name === "shell") return "shell";
  return undefined;
}

/** Static values of a flag, or the dynamic kind it takes. */
function flagValues(name: string): string[] | DynamicKind | undefined {
  if (name === "workflow") return "workflow";
  if (name === "status")
    return ["live", "ended", "all", "active", "done", "failed", "error", "cancelled", "lost", "drifted"];
  return undefined;
}

/**
 * The words that complete `words` (the line after `jr2`; the last one is the word the cursor is in,
 * empty at a new word). Verbs, sub-verbs, flags and their values from the command table; dynamic
 * values from `lookup`. Every candidate starts with the current word.
 */
export async function complete(words: readonly string[], lookup: Lookup): Promise<string[]> {
  const cur = words.at(-1) ?? "";
  const done = words.slice(0, -1);
  const starts = (list: Iterable<string>) => [...new Set(list)].filter((w) => w.startsWith(cur));
  if (done.length === 0) return starts(COMMANDS.map((c) => c.verb));
  const entries = commandsFor(done[0]!);
  if (entries.length === 0) return [];
  let entry: Command | undefined;
  let rest: string[];
  if (entries.some((c) => c.sub !== undefined)) {
    if (done.length === 1) return starts(entries.flatMap((c) => (c.sub ? [c.sub] : [])));
    entry = entries.find((c) => c.sub === done[1]);
    rest = done.slice(2);
  } else {
    entry = entries[0];
    rest = done.slice(1);
  }
  if (!entry) return [];

  // The addressing on the line, for the lookups.
  const flagOf = (word: string) =>
    entry.flags.find((f) => word === `--${f.name}` || (f.short !== undefined && word === `-${f.short}`));
  const given = (name: string) => {
    const i = rest.findIndex((w) => flagOf(w)?.name === name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const ctx = {
    ...(given("namespace") ? { namespace: given("namespace")! } : {}),
    ...(given("context") ? { context: given("context")! } : {}),
  };

  // A flag's value.
  const prev = flagOf(rest.at(-1) ?? "");
  if (prev?.value !== undefined && !rest.includes("--")) {
    const values = flagValues(prev.name);
    if (values === undefined) return [];
    return starts(Array.isArray(values) ? values : await lookup(values, ctx));
  }
  if (rest.includes("--")) return [];
  if (cur.startsWith("-")) return starts(entry.flags.map((f) => `--${f.name}`));

  // A positional: the arguments before the cursor, less the flags and their values.
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const f = flagOf(rest[i]!);
    if (f) {
      if (f.value !== undefined) i++;
      continue;
    }
    if (!rest[i]!.startsWith("-")) positionals.push(rest[i]!);
  }
  const arg = entry.args[positionals.length];
  const kind = arg ? argKind(arg.name) : undefined;
  if (kind === undefined) return [];
  if (kind === "shell") return starts(Object.keys(SCRIPTS));
  return starts(await lookup(kind, { ...ctx, ...(positionals[0] ? { run: positionals[0] } : {}) }));
}

/** `p`, or nothing after `ms`. A lookup that fails offers nothing too. */
export async function bounded(p: Promise<string[]>, ms = LOOKUP_BUDGET_MS): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.catch(() => []), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real lookups: the Sandbox CRs over kube, and the Orchestrator for the rest. Quiet: no
 * activity. With them, the close of each forward to the Orchestrator that a lookup holds now: a
 * lookup past its budget is still in flight when `__complete` exits. */
function deploymentLookup(io: Io): { lookup: Lookup; closeOpen: () => void } {
  const quiet: Io = { ...io, stderr: () => {} };
  const open = new Set<() => void>();
  const lookup: Lookup = async (kind, ctx) => {
    if (kind === "workspace") {
      const kube = io.workspaces ?? kubectlWorkspaces;
      let namespace = ctx.namespace;
      if (namespace === undefined) {
        const root = resolveRoot(io.cwd);
        namespace = (await loadConfig(root))?.name ?? basename(root);
      }
      const listed = await kube.list({ namespace, ...(ctx.context ? { context: ctx.context } : {}) });
      return listed.items.flatMap((cr) => {
        const row = rowOf(cr, listed.serverNow);
        return row.path ? [row.handle, row.name] : [row.name];
      });
    }
    const target = await resolveTarget(quiet, { namespace: ctx.namespace, context: ctx.context });
    const close = () => target.close?.();
    open.add(close);
    try {
      const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
      if (kind === "run") return (await client.runs({ status: "live" })).runs.map((r) => r.runId);
      if (kind === "workflow")
        return (await client.workflows()).flatMap((w) => [
          w.name,
          ...(w.wrapper?.charts ?? []).map((c) => `${w.name}/${c.name}`),
        ]);
      if (ctx.run === undefined) return [];
      const [live, kept] = await Promise.all([
        client.agents(ctx.run).catch(() => []),
        client.conversations(ctx.run).catch(() => []),
      ]);
      return [...live.map((a) => a.agent), ...kept.flatMap((c) => (c.slot ? [c.slot] : []))];
    } finally {
      open.delete(close);
      close();
    }
  };
  return {
    lookup,
    closeOpen: () => {
      for (const close of open) close();
      open.clear();
    },
  };
}

export async function completion(
  args: string[],
  io: Io,
  opts: { lookup?: Lookup; exit?: (code: number) => void; budgetMs?: number } = {},
): Promise<number> {
  if (args[0] === "__complete") {
    const deployment = opts.lookup ? undefined : deploymentLookup(io);
    const lookup = opts.lookup ?? deployment!.lookup;
    const words = await complete(args.slice(1), (kind, ctx) => bounded(lookup(kind, ctx), opts.budgetMs));
    for (const w of words) io.stdout(`${w}\n`);
    // A lookup past its budget is still in flight, and the shell waits for this process: close the
    // forward that it holds (its kubectl child also ends on this process's exit, `endsWithProcess`),
    // then exit, not waiting for the lookup.
    deployment?.closeOpen();
    (opts.exit ?? ((code: number) => process.exit(code)))(0);
    return 0;
  }
  const { positionals } = parseCommand("completion", args);
  const shell = positionals[0] as keyof typeof SCRIPTS | undefined;
  if (shell === undefined || !(shell in SCRIPTS) || positionals.length > 1) {
    activity(io, usageLine("completion"));
    return 2;
  }
  io.stdout(SCRIPTS[shell]);
  return 0;
}
