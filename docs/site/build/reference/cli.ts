// The CLI page (ADR-0072), from the command table that also prints `jr2 --help`: the global
// options, the run-id, env and output rules, the exit codes, and each command — its synopsis, its
// summary and paragraphs, its arguments, flags and env vars, what it prints, and its ADRs. The
// table holds no layout, so the page and the help cannot disagree on a fact.

import {
  COMMANDS,
  EXIT_CODES,
  GLOBAL,
  GLOBAL_OPTIONS,
  SECTIONS,
  nameOf,
  usageLine,
  type Command,
  type CommandName,
  type Flag,
} from "../../../../packages/cli/src/command-table.ts";
import { anchor, code, fenced, table } from "../markdown.ts";
import { adrLinks, anchorOf, type RefContext } from "./context.ts";

export const CLI_PAGE = "reference/cli.md";
const TABLE_FILE = "packages/cli/src/command-table.ts";

export const commandAnchor = (c: Command): string => anchorOf(nameOf(c));

const OUTPUT_TEXT = {
  result: "one JSON result on stdout, and activity on stderr",
  report: "a table on stdout, or the one report object with `--json`",
  activity: "activity on stderr only",
} as const;

function flagName(f: Flag): string {
  const long = `--${f.name}${f.value === undefined ? "" : ` <${f.value}>`}`;
  return f.short ? `-${f.short}, ${long}` : long;
}

/** Text from the table, where a `<placeholder>` outside code would read as an HTML tag. */
const prose = (s: string): string =>
  s.replace(/(`[^`]*`)|(<[^>\s]+>)/g, (whole, inCode: string | undefined) => (inCode ? whole : code(whole)));

function renderCommand(ctx: RefContext, c: Command): string {
  const name = nameOf(c);
  const usage = usageLine(name as CommandName)
    .split("\n")
    .map((l) => l.replace(/^(usage: |\s+)/, ""))
    .join("\n");
  const parts = [`${anchor(commandAnchor(c))}\n\n### ${code(`jr2 ${name}`)}`, fenced("sh", usage)];
  parts.push(prose(c.summary.charAt(0).toUpperCase() + c.summary.slice(1)) + ".");
  for (const l of c.lines) parts.push(prose(l.charAt(0).toUpperCase() + l.slice(1)) + ".");
  for (const f of c.forms ?? []) {
    const fixed = f.flags.map((n) => {
      const flag = c.flags.find((x) => x.name === n)!;
      const v = f.values?.[n];
      return v === undefined ? flagName(flag) : `--${n} ${v}`;
    });
    parts.push(`With ${fixed.map(code).join(", ")}: ${prose(f.summary)}.`);
  }
  if (c.aliases?.length) parts.push(`Also spelled ${c.aliases.map((a) => code(`jr2 ${a}`)).join(", ")}.`);
  if (c.args.length)
    parts.push(
      `**Arguments**\n\n${table(
        ["Argument", "Required", "Description"],
        c.args.map((a) => [code(a.name), a.optional ? "no" : "yes", prose(a.description)]),
      )}`,
    );
  if (c.flags.length)
    parts.push(
      `**Flags**\n\n${table(
        ["Flag", "Description"],
        c.flags.map((f) => [code(flagName(f)), prose(f.description) + (f.required ? " Required." : "")]),
      )}`,
    );
  if (c.env.length)
    parts.push(
      `**Environment**\n\n${table(
        ["Variable", "Description"],
        c.env.map((e) => [code(e.name), prose(e.description)]),
      )}`,
    );
  const output = c.output.map((o) => `${o.form ? `${code(`jr2 ${o.form}`)}: ` : ""}${o.kind}, ${OUTPUT_TEXT[o.kind]}`);
  parts.push(`**Output**: ${output.join("; ")}. See [Output](#output).`);
  if (c.adrs.length) parts.push(`**Decisions**: ${adrLinks(ctx, c.adrs, CLI_PAGE, TABLE_FILE)}.`);
  return parts.join("\n\n");
}

export function renderCli(ctx: RefContext): string {
  const takenBy = (o: (typeof GLOBAL_OPTIONS)[number]) =>
    COMMANDS.filter((c) => (o.flag && c.flags.includes(o.flag)) || (o.env && c.env.includes(o.env)))
      .map((c) => `[${code(nameOf(c))}](#${commandAnchor(c)})`)
      .join(", ");
  const sections = SECTIONS.map(
    (s) =>
      `${anchor(anchorOf(s.title))}\n\n## ${s.title.charAt(0).toUpperCase() + s.title.slice(1)}\n\n${prose(s.text.charAt(0).toUpperCase() + s.text.slice(1))}.`,
  );
  return (
    [
      `The ${code("jr2")} binary: ${GLOBAL.summary} (${adrLinks(ctx, GLOBAL.adrs, CLI_PAGE, TABLE_FILE)}). ${code("jr2 --help")} prints the same table as this page, and ${code("jr2 <command> --help")} prints one command.`,
      `Commands: ${COMMANDS.map((c) => `[${code(nameOf(c))}](#${commandAnchor(c)})`).join(", ")}.`,
      `${anchor("global-options")}\n\n## Global options\n\nThese ${GLOBAL.addressing.summary} (${adrLinks(ctx, GLOBAL.addressing.adrs, CLI_PAGE, TABLE_FILE)}).\n\n${table(
        ["Flag", "Variable", "Description", "Taken by"],
        GLOBAL_OPTIONS.map((o) => [
          o.flag ? code(flagName(o.flag)) : "",
          o.env ? code(o.env.name) : "",
          prose(o.description),
          takenBy(o),
        ]),
      )}`,
      // The rules and the exit codes follow the commands, as in `--help`: the run-id rule says
      // "any `<runId>` above".
      "## Commands",
      ...COMMANDS.map((c) => renderCommand(ctx, c)),
      ...sections,
      `${anchor("exit-codes")}\n\n## Exit codes\n\n${table(
        ["Code", "Meaning"],
        EXIT_CODES.map((e) => [String(e.code), e.meaning]),
      )}`,
    ].join("\n\n") + "\n"
  );
}
