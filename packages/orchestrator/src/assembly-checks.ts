// The walk's refusals, as a LISTING (ADR-0069). The walk runs twice: `jr2 up` runs it on the host
// before any cluster work, and the door runs it again over the unpacked Assembly before the
// publish lands. Both ends call these functions, so the two walks cannot drift. They return the
// lines and print nothing: `jr2 up` prints them after `refusing: `, and the door returns them in
// its `422` report.

import { isAbsolute, relative, sep } from "node:path";
import type { AnyStateMachine } from "xstate";
import { z } from "zod";
import { isStdioServer, type AnswerGrant, type GateGrant, type JR2Config } from "./config.ts";
import { senderIds } from "./party.ts";
import type { AgentMcpServer } from "./agent.ts";
import { imageContextDigest, type ImageRefs } from "./images.ts";
import { openPartsText } from "./open-effect.ts";
import { asMachine, customizeLine, partsOf, placedEffectsOf, workspacePodsOf } from "./parts.ts";
import { isGateSlot } from "./gate.ts";
import { isStandingPool, standingPoolOf } from "./pool.ts";
import { hookParts, isHook } from "./hook-kinds/door.ts";
import { open } from "./open.ts";
import { refuseEffectSecrets, type PlacementWalk } from "./secret-placement.ts";
import {
  admitUnder,
  chartFileRefusals,
  chartName,
  chartWrapperOf,
  splitChartName,
  wrapperFault,
  type ChartFile,
} from "./charts.ts";
import { doorCompat } from "./door-compat.ts";

// The comparison is the same one `jr2 up`'s foreign preflight makes, so it is exported beside the
// walk the CLI already imports (ADR-0071).
export { doorCompat, type DoorCompat } from "./door-compat.ts";
import { inputSchemaOf, isZodSchema } from "./vocabulary.ts";

/** One registered Workflow, as `loadWorkflows` gives it. */
export type LoadedWorkflow = { name: string; machine: AnyStateMachine };

/**
 * Every registered Machine that has a zod `input` on its `createMachine` config and that `jr2Setup`
 * did not make (ADR-0033). The `setup()` of xstate keeps that `input` in the config but does not read it,
 * so the Machine has no door: a start with any input passes, and the Console start form is only a
 * field for JSON. TypeScript accepts the config, so only this walk finds it. One line per Workflow,
 * naming the fix.
 * A Machine with no `input`, or with an `input` that is not zod, can still use `setup()`.
 *
 * The line text follows `refusing: ` in `jr2 up`'s output; the prefix is the caller's.
 */
export function doorRefusals(workflows: readonly LoadedWorkflow[]): string[] {
  const lines: string[] = [];
  for (const w of workflows) {
    const declared = (w.machine.config as { input?: unknown }).input;
    if (!isZodSchema(declared) || inputSchemaOf(w.machine)) continue;
    lines.push(
      `workflow "${w.name}": machine "${w.machine.id}" has a zod \`input\` on createMachine, but jr2Setup did not ` +
        "make this Machine, so no door reads that input: a run starts with any input, and the Console start form " +
        "is only a field for JSON — make the Machine with jr2Setup in place of setup() or createMachine() (leave " +
        "out `events` if it takes no workflow event) (ADR-0033)",
    );
  }
  return lines;
}

/**
 * What `jr2 up` prints of the standing Pools (ADR-0017): for each one, the chain from each Hook that
 * reaches it to its callee (`sentry → alerts → triage`; a Pool that no Hook reaches prints its own
 * chain alone), and a warning when two standing Pools dispatch to one Workflow: `cap` is for each
 * Pool, so one item that both Sources carry can take a slot in each, and the caps add. A Hook reaches
 * a Pool when its kind is one that the Source's handlers hear and it may answer the Workflow.
 */
export function standingPoolLines(
  workflows: readonly LoadedWorkflow[],
  hooks: JR2Config["hooks"] = {},
): { chains: string[]; warnings: string[] } {
  const chains: string[] = [];
  const byCallee = new Map<string, string[]>();
  for (const w of workflows) {
    const info = standingPoolOf(w.machine);
    if (!info) continue;
    byCallee.set(info.callee, [...(byCallee.get(info.callee) ?? []), w.name]);
    const reaching = Object.entries(hooks ?? {}).filter(([, hook]) => {
      if (!isHook(hook)) return false;
      const parts = hookParts(hook);
      const may = parts.may.answer;
      return info.kinds.includes(parts.kind.id) && (may === "all" || may.includes(w.name));
    });
    if (!reaching.length) chains.push(`${w.name} → ${info.callee}`);
    for (const [name] of reaching) chains.push(`${name} → ${w.name} → ${info.callee}`);
  }
  const warnings = [...byCallee]
    .filter(([, pools]) => pools.length > 1)
    .map(
      ([callee, pools]) =>
        `the standing Pools ${pools.map((p) => `"${p}"`).join(" and ")} each dispatch to "${callee}": \`cap\` is for ` +
        "each Pool, so one item that two Sources carry can take a slot in each, and the caps add (ADR-0017)",
    );
  return { chains, warnings };
}

/**
 * Every standing Pool that is not the top Machine of its Workflow (ADR-0017): jr2 keeps one run for
 * each standing Workflow and hands that run over, so the Workflow is the Pool. One line per Machine
 * that composes one, naming the fix. `pool()` itself refuses what it can see alone (a Pool of runs
 * that does not stand, a slot with no `wait: true`, no `cap`); this is the one refusal that needs the
 * Workflow.
 *
 * The line text follows `refusing: ` in `jr2 up`'s output; the prefix is the caller's.
 */
export function standingPoolRefusals(workflows: readonly LoadedWorkflow[]): string[] {
  const lines: string[] = [];
  for (const w of workflows) {
    const seen = new Set<AnyStateMachine>();
    const walk = (machine: AnyStateMachine): void => {
      if (seen.has(machine)) return;
      seen.add(machine);
      for (const logic of Object.values(machine.implementations.actors as Record<string, unknown>)) {
        const child = asMachine(logic);
        if (!child) continue;
        if (isStandingPool(child)) {
          lines.push(
            `workflow "${w.name}": machine "${machine.id}" composes the standing Pool "${child.id}" — a standing Pool ` +
              "is the top Machine of its Workflow, because jr2 keeps one run of each standing Workflow: move the Pool " +
              "to a file of its own in workflows/ (ADR-0017)",
          );
        }
        walk(child);
      }
    };
    walk(w.machine);
  }
  return lines;
}

/**
 * Every part a registered Machine leaves Open (ADR-0051, ADR-0054): a Repo Slot with no url, an
 * Agent with no model, an Effect's url, argv or secret. One line per part, in walk order within
 * each kind, so a composer fixes all of them in one edit. Each line names the Workflow and the
 * `customize()` line that binds the part. A part on a Machine invoked inline has no fix line,
 * because no `customize()` reaches an actor without a slot key.
 *
 * The line text follows `refusing: ` in `jr2 up`'s output; the prefix is the caller's.
 */
export function openPartRefusals(workflows: readonly LoadedWorkflow[]): string[] {
  const lines: string[] = [];
  for (const w of workflows) {
    const walked = partsOf([w.machine]);
    const opened: Array<{
      slot: string | undefined;
      path: readonly string[] | undefined;
      part: Parameters<typeof customizeLine>[3];
      what: string;
      adr: string;
    }> = [
      ...walked.openSlots.map((o) => ({
        ...o,
        part: "repo" as const,
        // An Open MAP names no slot (the composer does), so it is refused as "the Repo Slots".
        what: o.slot === undefined ? "its Repo Slots" : `Repo Slot "${o.slot}"`,
        adr: "ADR-0051",
      })),
      ...walked.openAgents.map((o) => ({ ...o, part: "agent" as const, what: `Agent "${o.slot}"`, adr: "ADR-0054" })),
      // An Effect's Open url, argv or secret (ADR-0054): one binding object for an Effect with two.
      ...walked.openEffects.map(({ parts, ...o }) => ({
        ...o,
        part: parts,
        what: `the ${openPartsText(parts)} of Effect "${o.slot}"`,
        adr: "ADR-0054",
      })),
    ];
    for (const { slot, path, part, what, adr } of opened) {
      if (path === undefined) {
        lines.push(
          `workflow "${w.name}" leaves ${what} open on a Machine invoked inline — no ` +
            "customize() reaches an actor without a slot key; declare that Machine under setup({ actors }) and " +
            `bind it there  (ADR-0049, ${adr})`,
        );
        continue;
      }
      const where = path.length ? ` (on the Machine composed as ${path.map((k) => `"${k}"`).join(" → ")})` : "";
      lines.push(
        `workflow "${w.name}" leaves ${what} open${where} — bind it where the Machine is ` +
          `registered: export const machine = ${customizeLine("<import>", path, slot, part)}  (${adr})`,
      );
    }
  }
  return lines;
}

/** A tool name that a model takes (ADR-0079): Anthropic's bound, which the others' refuse no less. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** The name the model reads for one MCP tool (ADR-0079). */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** One `mcp` entry as an author writes it, for a fix line. */
function mcpEntryText(entry: AgentMcpServer, server = entry.server): string {
  const tools =
    entry.tools === undefined
      ? ""
      : entry.tools === "*"
        ? ', tools: "*"'
        : `, tools: [${entry.tools.map((t) => JSON.stringify(t)).join(", ")}]`;
  return `{ server: ${server.startsWith("<") ? `"${server}"` : JSON.stringify(server)}${tools} }`;
}

/** The `customize()` line that rebinds an Agent's `mcp` list, nested through `actors` as
 * `customize()` takes it (ADR-0054, ADR-0079). */
function mcpCustomizeLine(path: readonly string[], slot: string, list: readonly string[]): string {
  const binds = `{ agents: { ${slot}: { mcp: [${list.join(", ")}] } } }`;
  return `customize(<import>, ${path.reduceRight((parts, key) => `{ actors: { ${key}: ${parts} } }`, binds)})`;
}

/**
 * The refusals of the Agents' `mcp` lists against the config's `mcp` block (ADR-0079), one line per
 * fault, in walk order: a server name the block does not declare (with the `customize()` line that
 * binds the slot to a declared one, and the block entry that declares a new one); a remote server
 * with no `tools`; an empty list; a stdio server with a list; a stdio server on a `"none"` Agent,
 * whose Turns run on the Instance Harness, where no Workspace code runs; a listed tool whose model
 * name breaks `[A-Za-z0-9_-]{1,128}`; a tool listed twice; a server named twice; and a list on a remote server whose
 * secret Workspace code in the Agent's Sandbox can spend, where only `"*"` is honest. Needs no url,
 * so the door runs it too.
 *
 * The line text follows `refusing: ` in `jr2 up`'s output; the prefix is the caller's.
 */
export function mcpRefusals(workflows: readonly LoadedWorkflow[], config: JR2Config | undefined): string[] {
  const lines: string[] = [];
  const declared = config?.mcp ?? {};
  const names = Object.keys(declared);
  const declares = names.length
    ? `the mcp block declares ${names.map((n) => `"${n}"`).join(", ")}`
    : "the mcp block of jr2.config.ts declares no server";
  const seen = new Set<string>();
  for (const w of workflows) {
    for (const agent of partsOf([w.machine]).mcpAgents) {
      const once = JSON.stringify([w.name, agent.path ?? null, agent.slot, agent.mcp]);
      if (seen.has(once)) continue;
      seen.add(once);
      const where = agent.path?.length
        ? ` (on the Machine composed as ${agent.path.map((k) => `"${k}"`).join(" → ")})`
        : "";
      const at = `workflow "${w.name}": Agent "${agent.slot}"${where}`;
      const servers = new Set<string>();
      for (const entry of agent.mcp) {
        if (servers.has(entry.server)) {
          lines.push(`${at} names the MCP server "${entry.server}" twice — one entry for each server (ADR-0079)`);
          continue;
        }
        servers.add(entry.server);
        const server = Object.hasOwn(declared, entry.server) ? declared[entry.server] : undefined;
        if (server === undefined) {
          const fix =
            agent.path === undefined
              ? "declare that Machine under setup({ actors }) and bind it there (ADR-0049)"
              : `bind the Agent to a declared server where the Machine is registered: export const machine = ${mcpCustomizeLine(
                  agent.path,
                  agent.slot,
                  agent.mcp.map((e) => mcpEntryText(e, e === entry ? "<server>" : e.server)),
                )}`;
          lines.push(
            `${at} names the MCP server "${entry.server}", which ${declares} — ${fix}; or declare it in jr2.config.ts: ` +
              `mcp: { "${entry.server}": { url: "https://<host>/mcp", secret: "<SECRET>" } } (ADR-0079)`,
          );
          continue;
        }
        if (isStdioServer(server)) {
          if (agent.workspace === "none") {
            lines.push(
              `${at} has workspace: "none" and names the stdio MCP server "${entry.server}" — a stdio server runs as ` +
                "Workspace code, inside a Sandbox's confinement, and a \"none\" Agent's Turns run on the Instance " +
                "Harness, which has none: name a remote server, or give the Agent a Workspace (ADR-0079, ADR-0031)",
            );
          }
          if (entry.tools !== undefined) {
            lines.push(
              `${at} gives a tools list for the stdio MCP server "${entry.server}" — a stdio server takes none: the ` +
                "Agent gets every tool, because the server runs as Workspace code, and a list would guard nothing. " +
                `Write ${mcpEntryText({ server: entry.server })} (ADR-0079)`,
            );
          }
          continue;
        }
        if (entry.tools === undefined) {
          lines.push(
            `${at} names the remote MCP server "${entry.server}" with no tools — a remote server needs its allowlist: ` +
              `${mcpEntryText({ server: entry.server, tools: ["<tool>"] })}, or tools: "*" for every tool (ADR-0079)`,
          );
          continue;
        }
        if (entry.tools === "*") continue;
        if (entry.tools.length === 0) {
          lines.push(
            `${at} gives MCP server "${entry.server}" an empty tools list, which offers no tool — name the tools, or ` +
              "drop the entry (ADR-0079)",
          );
          continue;
        }
        const tools = new Set<string>();
        const twice = new Set<string>();
        for (const tool of entry.tools) {
          if (tools.has(tool)) {
            if (twice.has(tool)) continue;
            twice.add(tool);
            lines.push(
              `${at} lists the tool ${JSON.stringify(tool)} of MCP server "${entry.server}" twice — a model provider ` +
                "refuses a tools block that has one name two times: list each tool once (ADR-0079)",
            );
            continue;
          }
          tools.add(tool);
          const name = mcpToolName(entry.server, tool);
          if (MCP_TOOL_NAME.test(name)) continue;
          lines.push(
            `${at} lists the tool ${JSON.stringify(tool)} of MCP server "${entry.server}": the model would read it as ` +
              `${JSON.stringify(name)}, and a tool name is [A-Za-z0-9_-], at most 128 characters — a model provider ` +
              "refuses any other (ADR-0079)",
          );
        }
      }
    }
    // An `mcp` Effect names a server of the block, and a remote one: it runs in the Instance
    // Effector, which starts no program (ADR-0079). An Open server is the Open-part refusal's.
    for (const effect of partsOf([w.machine]).effects) {
      if (effect.kind !== "mcp" || effect.server === undefined) continue;
      const once = JSON.stringify(["effect", w.name, effect.path ?? null, effect.name]);
      if (seen.has(once)) continue;
      seen.add(once);
      const where = effect.path?.length
        ? ` (on the Machine composed as ${effect.path.map((k) => `"${k}"`).join(" → ")})`
        : "";
      const at = `workflow "${w.name}": the mcp Effect "${effect.name}"${where}`;
      const entry = `mcp: { "${effect.server}": { url: "https://<host>/mcp", secret: "<SECRET>" } }`;
      const server = Object.hasOwn(declared, effect.server) ? declared[effect.server] : undefined;
      if (server === undefined) {
        lines.push(
          `${at} names the MCP server "${effect.server}", which ${declares} — declare it in jr2.config.ts: ` +
            `${entry}, or name a declared remote server (ADR-0079)`,
        );
        continue;
      }
      if (isStdioServer(server)) {
        lines.push(
          `${at} names the stdio MCP server "${effect.server}" — an mcp Effect runs in the Instance Effector, which ` +
            "starts no program, so it calls a remote server only: declare one for it in jr2.config.ts, " +
            `${entry} (ADR-0079)`,
        );
      }
    }
    // The allowlist is a guarantee about the credential (ADR-0028, ADR-0079): where Workspace code in
    // the Agent's Sandbox can spend the server's secret, a list would be a hint, so only "*".
    for (const pod of workspacePodsOf(w.machine)) {
      for (const { slot, path, entry } of pod.mcp ?? []) {
        const server = Object.hasOwn(declared, entry.server) ? declared[entry.server] : undefined;
        if (server === undefined || isStdioServer(server) || server.secret === undefined) continue;
        if (!Array.isArray(entry.tools)) continue;
        const secret = server.secret;
        const spends = spendersOf(pod, secret);
        if (spends === undefined) continue;
        const where = path?.length ? ` (on the Machine composed as ${path.map((k) => `"${k}"`).join(" → ")})` : "";
        const once = JSON.stringify(["spend", w.name, path ?? null, slot, entry.server]);
        if (seen.has(once)) continue;
        seen.add(once);
        lines.push(
          `workflow "${w.name}": Agent "${slot}"${where} gives a tools list for MCP server "${entry.server}", and ` +
            `Workspace code in its Sandbox can spend that server's secret, ${secret}: ${spends}. A list would be a ` +
            `hint, not a limit — write ${mcpEntryText({ server: entry.server, tools: "*" })}, or keep ${secret} out ` +
            "of that Workspace (ADR-0079, ADR-0028)",
        );
      }
    }
  }
  return lines;
}

/**
 * The refusals of the `mcp` block's urls (ADR-0079): each remote server's `url` is an `http://` or
 * `https://` URL with no userinfo, and `https://` when the server has a `secret`, because the
 * Custodian puts a value on TLS only (ADR-0059). Host-side only: in-cluster the config reads no
 * `.env`, so a url read from it is empty there, and the door does not run this.
 */
export function mcpUrlRefusals(config: JR2Config | undefined): string[] {
  const lines: string[] = [];
  for (const [name, server] of Object.entries(config?.mcp ?? {})) {
    if (isStdioServer(server)) continue;
    const env = `process.env.${name.toUpperCase().replace(/-/g, "_")}_URL`;
    let url: URL | undefined;
    try {
      url = new URL(server.url);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
      lines.push(
        `mcp.${name}.url ${JSON.stringify(server.url)} is not an http:// or https:// URL — an unset .env variable ` +
          `reads as empty; set it, such as url: ${env} (ADR-0079)`,
      );
      continue;
    }
    if (url.username || url.password) {
      lines.push(`mcp.${name}.url carries userinfo — put the credential in secret, never in the url (ADR-0079)`);
      continue;
    }
    if (server.secret !== undefined && url.protocol !== "https:") {
      lines.push(
        `mcp.${name}.url must be an https:// URL — the server has a secret, ${server.secret}, and the Custodian ` +
          "carries TLS only (ADR-0059, ADR-0079)",
      );
    }
  }
  return lines;
}

/** How Workspace code of one pod can spend a secret, or undefined when it cannot (ADR-0079): its
 * `workspace()` grants it, a credentialed `command` there names it, or an `http` Effect there that
 * sends a Worktree file names it — a file that the Agent wrote. */
function spendersOf(pod: ReturnType<typeof workspacePodsOf>[number], secret: string): string | undefined {
  if (pod.secrets.includes(secret)) return "its workspace() lists it under secrets";
  for (const effect of pod.effects) {
    if (!(effect.secrets ?? []).includes(secret)) continue;
    if (effect.kind === "command") return `the command Effect "${effect.name}" names it`;
    if (effect.kind === "http" && effect.file) {
      return `the http Effect "${effect.name}" sends a Worktree file with it`;
    }
  }
  return undefined;
}

/**
 * What the registered Machines name for secret placement (ADR-0059, ADR-0068): every Effect and
 * every Workspace's pod, per route, and the models the Instance Harness hosts: those of the `"none"`
 * Agents and of every Open body that allows `"none"` (ADR-0070). `jr2 up` and the door build the same walk from the same Workflows.
 */
export function placementWalkOf(workflows: readonly LoadedWorkflow[]): PlacementWalk {
  // The walk's own `instanceHarness` (ADR-0068, ADR-0070): the models of the "none" Agents and of
  // every Open body that allows "none", so a Chart's minted "none" Agent has its key placed, or the
  // publish is refused, never a 401 mid-run.
  const { instanceHarness } = partsOf(workflows.map((w) => w.machine));
  return {
    // Per route, not per Machine object: a Machine placed twice is checked where each copy runs.
    effects: workflows.flatMap((w) => placedEffectsOf(w.machine).map((effect) => ({ workflow: w.name, effect }))),
    workspaces: workflows.flatMap((w) => workspacePodsOf(w.machine).map((pod) => ({ workflow: w.name, pod }))),
    ...(instanceHarness
      ? { instanceHarness: { models: [...instanceHarness.models], servers: [...instanceHarness.servers] } }
      : {}),
  };
}

/**
 * What a `dispatch` names, checked against what the walk can see (ADR-0071). Each dispatch with no
 * target — a same-Instance one; a foreign target is `jr2 up`'s preflight, a warning — must name a
 * Workflow the Assembly has: a Machine (`workflows/<name>.ts`), or `<wrapper>/<name>`, a named Chart
 * under a Chart wrapper the Assembly registers, from a Chart file or (when `runtime` is given) a
 * runtime Chart. A miss is an error. Without `runtime` — on the host, which cannot see the
 * Orchestrator's volume — a slashed name under a known wrapper with no Chart file is a warning.
 * Then the slot's input schema, when it has one, is compared with the callee's door
 * (`doorCompat`): a fault is an error, naming the field; a schema outside the compared subset is a
 * warning, "not compared".
 *
 * A dispatch resolves at RUN time against the current Assembly (ADR-0069); this check is of the
 * Assembly being published, so a later publish that drops the callee answers `refused` with the
 * door's 404 then, and is not refused for it here.
 */
export function dispatchRefusals(
  workflows: readonly LoadedWorkflow[],
  charts: readonly ChartFile[],
  runtime?: readonly { name: string }[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const w of workflows) {
    for (const effect of partsOf([w.machine]).effects) {
      // A target, bound or Open, is another Orchestrator's: its door is not in this Assembly.
      if (effect.kind !== "dispatch" || effect.target !== undefined || effect.open !== undefined) continue;
      const name = effect.workflow;
      const at = `workflow "${w.name}" dispatches "${name}"`;
      const once = JSON.stringify([w.name, effect.name, name]);
      if (seen.has(once)) continue;
      seen.add(once);
      const callee = calleeOf(workflows, charts, runtime, name);
      if ("error" in callee) {
        errors.push(`${at} ${callee.error} (ADR-0071)`);
        continue;
      }
      // A slashed name with no Chart the host can see still has a known door: the wrapper's minus
      // its Chart fields, the same for every Chart under it. So it is warned AND compared.
      if (callee.warning) warnings.push(`${at}: ${callee.warning} (ADR-0071)`);
      if (effect.input === undefined) continue;
      if ("notDrawn" in callee.door) {
        warnings.push(`${at}: its input schema and the door are not compared — ${callee.door.notDrawn} (ADR-0071)`);
        continue;
      }
      const compared = doorCompat(effect.input, callee.door.schema);
      if (compared.ok === "not-compared") {
        warnings.push(`${at}: its input schema and the door are not compared — ${compared.why} (ADR-0071)`);
      } else if (compared.ok === false) {
        for (const fault of compared.faults) {
          errors.push(
            `${at} with input its door does not take: ${fault} — align the slot's \`input\` with the door ` +
              "(derive it from the door's schema, `door.pick({ ... })`) (ADR-0071)",
          );
        }
      }
    }
  }
  return { errors, warnings };
}

/** The door a dispatch's name resolves to in these Workflows, or why it does not. */
function calleeOf(
  workflows: readonly LoadedWorkflow[],
  charts: readonly ChartFile[],
  runtime: readonly { name: string }[] | undefined,
  name: string,
): { door: Door; warning?: string } | { error: string } {
  const split = splitChartName(name);
  if (!split) {
    const found = workflows.find((w) => w.name === name);
    if (!found) {
      return {
        error:
          `which no Workflow in the Assembly has — add workflows/${name}.ts, or name one it registers` +
          (workflows.length ? `: ${workflows.map((w) => `"${w.name}"`).join(", ")}` : ""),
      };
    }
    return { door: doorOf(found.machine, []) };
  }
  const { wrapper, name: short } = split;
  const fault = wrapperFault(workflows, wrapper);
  if (fault) {
    return {
      error:
        fault.status === 404
          ? `which no Workflow in the Assembly has — no workflows/${wrapper}.ts registers the Chart wrapper "${wrapper}"`
          : `which no Workflow in the Assembly can be: ${fault.error}`,
    };
  }
  const machine = workflows.find((w) => w.name === wrapper)!.machine;
  const door = doorOf(machine, chartWrapperOf(machine)?.chartFields ?? []);
  const file = `workflows/${wrapper}/${short}.chart.json`;
  if (charts.some((c) => chartName(c.wrapper, c.name) === name)) return { door };
  if (runtime === undefined) {
    return {
      door,
      warning:
        `the Assembly has no Chart file ${file}, and a runtime Chart lives on the Orchestrator's volume alone, ` +
        "which jr2 up cannot see — the publish door checks it, and a run of the dispatch is refused with the door's " +
        "404 if it is not there",
    };
  }
  if (runtime.some((c) => c.name === name)) return { door };
  return {
    error:
      `which no Workflow in the Assembly has — add the Chart file ${file}; or, for a runtime Chart, PUT ` +
      `/workflows/${wrapper}/charts/${short} before this publish (a PUT needs "${wrapper}" in the current ` +
      `Assembly: when this publish adds it, publish "${wrapper}" first, then PUT the Chart, then publish the dispatch)`,
  };
}

/** A door as the comparison reads it: its JSON Schema (null: it declares no input), or why zod
 * could not draw one. */
type Door = { schema: Record<string, unknown> | null } | { notDrawn: string };

/** A Workflow's door as JSON Schema, exactly as `GET /workflows/<name>` serves it (run-host.ts
 * `inputSchema`): null for a Machine that declares none; for a named Chart the wrapper's minus its
 * Chart fields, which the Chart supplies (ADR-0070). A door zod cannot draw (`z.date()`,
 * `z.custom()`) is not drawn as "any", which would guess "compatible": it is not compared. */
function doorOf(machine: AnyStateMachine, chartFields: readonly string[]): Door {
  let schema = inputSchemaOf(machine);
  if (!schema) return { schema: null };
  if (chartFields.length) schema = schema.omit(Object.fromEntries(chartFields.map((f) => [f, true])) as never);
  try {
    return { schema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> };
  } catch (err) {
    return {
      notDrawn: `the door has a part JSON Schema cannot state (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * The `answer` items that name single Gates (ADR-0078), checked against the Machines that they
 * name. Each item of `callers.tokens.<name>.may.answer` and of each issuer's `groups` map that is
 * `{ workflow, gates }` must name a Workflow of this Assembly, and each Gate name must be the invoke
 * id of a Gate in one Machine of that Workflow (ADR-0011): its registered Machine, each Machine that
 * it composes, and for a Chart wrapper each of its Chart files. A name that two Machines of one
 * Workflow have is refused too, because one name would open both Gates.
 *
 * A runtime Chart is not in the Assembly (ADR-0070), so its Gates cannot be checked: a name that
 * only a runtime Chart of a wrapper can have, and an item for a Chart that no Chart file is, are
 * warnings. The lines follow `refusing: ` and `warning: ` in `jr2 up`'s output; the prefixes are the
 * caller's.
 */
export function gateScopeChecks(
  workflows: readonly LoadedWorkflow[],
  config: JR2Config | undefined,
  charts: readonly ChartFile[] = [],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const grants: Array<{ at: string; grant: AnswerGrant | undefined }> = [];
  for (const [name, token] of Object.entries(config?.callers?.tokens ?? {})) {
    grants.push({ at: `callers.tokens.${name}.may.answer`, grant: token.may.answer });
  }
  (config?.callers?.issuers ?? []).forEach((issuer, i) => {
    for (const [value, may] of Object.entries(issuer.groups)) {
      grants.push({ at: `callers.issuers.${i}.groups.${value}.answer`, grant: may.answer });
    }
  });
  for (const { at, grant } of grants) {
    if (grant === undefined || grant === "all") continue;
    for (const item of grant) {
      if (typeof item === "string") continue;
      const checked = checkGateGrant(item, workflows, charts);
      errors.push(...checked.errors.map((line) => `${at}: ${line}`));
      warnings.push(...checked.warnings.map((line) => `${at}: ${line}`));
    }
  }
  return { errors, warnings };
}

/** One Machine's Gates, named for a line: its Machine id, or a Chart file's path. */
type GateHolder = { label: string; gates: ReadonlySet<string> };

/** The Gates of a registered Machine and of each Machine that it composes, one holder for each
 * Machine. A composed Machine is a key of the Machine's `actors`, or a plain child Machine written
 * inline on a state's `invoke.src`, which runs with its own Gates as a named one does. */
function gateHoldersOf(root: AnyStateMachine): GateHolder[] {
  const out: GateHolder[] = [];
  const seen = new Set<AnyStateMachine>();
  const walk = (machine: AnyStateMachine): void => {
    if (seen.has(machine)) return;
    seen.add(machine);
    const { gates } = senderIds(machine);
    if (gates.size) out.push({ label: `machine "${machine.id}"`, gates });
    const actors = machine.implementations.actors as Record<string, unknown>;
    const visit = (node: AnyStateMachine["root"]): void => {
      const written = [node.config.invoke ?? []].flat() as Array<{ src?: unknown } | undefined>;
      node.invoke.forEach((inv, i) => {
        const child = asMachine(typeof inv.src === "string" ? actors[inv.src] : inv.src) ?? asMachine(written[i]?.src);
        if (child) walk(child);
      });
      for (const state of Object.values(node.states)) visit(state);
    };
    visit(machine.root);
    for (const logic of Object.values(actors)) {
      const child = asMachine(logic);
      if (child) walk(child);
    }
  };
  walk(root);
  return out;
}

/** A Chart file's Gates, or none when the Chart does not admit: `chartFileRefusals` says why. */
function chartHolder(file: ChartFile, machine: AnyStateMachine): GateHolder | undefined {
  const wrapper = chartWrapperOf(machine);
  if (!wrapper || file.error !== undefined) return undefined;
  try {
    return { label: file.path, gates: new Set(admitUnder(wrapper, file.text).gates) };
  } catch {
    return undefined;
  }
}

function checkGateGrant(
  item: GateGrant,
  workflows: readonly LoadedWorkflow[],
  charts: readonly ChartFile[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const split = splitChartName(item.workflow);
  const registered = workflows.find((w) => w.name === (split?.wrapper ?? item.workflow));
  if (!registered) {
    errors.push(
      `{ workflow: "${item.workflow}", gates } names the Gates of a Workflow that this Assembly does not register, so ` +
        "jr2 cannot check them: name a registered Workflow or a Chart file (ADR-0078)",
    );
    return { errors, warnings };
  }
  const own = gateHoldersOf(registered.machine);
  const wrapper = chartWrapperOf(registered.machine);
  const runtime = wrapper !== undefined && wrapper.chartFields.length > 0;
  // Each Workflow that the item opens is one set of Machines: the wrapper's own, and for each Chart
  // its Chart besides.
  const files = charts.filter((f) => f.wrapper === registered.name && (split === undefined || f.name === split.name));
  if (split !== undefined && files.length === 0) {
    const line =
      `{ workflow: "${item.workflow}", gates } names a Chart that is no Chart file of this Assembly; ` +
      "a runtime Chart's Gates cannot be checked at jr2 up (ADR-0070, ADR-0078)";
    if (runtime) warnings.push(line);
    else errors.push(`${line}, and "${registered.name}" takes no runtime Chart`);
    return { errors, warnings };
  }
  const sets: GateHolder[][] = split === undefined ? [own] : [];
  // A Chart file that does not admit has Gates that jr2 cannot read: `chartFileRefusals` refuses it
  // with its own line, and a name that only it could have gets no second line.
  let unread = false;
  for (const f of files) {
    const chart = chartHolder(f, registered.machine);
    if (chart) sets.push([...own, chart]);
    else unread = true;
  }
  const known = [...new Set(sets.flat().flatMap((h) => [...h.gates]))].sort();
  for (const gate of item.gates) {
    const holders = sets.map((set) => set.filter((h) => h.gates.has(gate)));
    const twice = holders.find((h) => h.length > 1);
    if (twice) {
      errors.push(
        `Gate "${gate}" of Workflow "${item.workflow}" is in more than one Machine (${twice.map((h) => h.label).join(", ")}), ` +
          "so the one name would open each of those Gates: give one of them an invoke id of its own (ADR-0078)",
      );
      continue;
    }
    if (holders.some((h) => h.length === 1) || unread) continue;
    const has = known.length ? `its Gates are ${known.map((g) => `"${g}"`).join(", ")}` : "it has no Gate";
    const line =
      `Workflow "${item.workflow}" has no Gate "${gate}" — a Gate's name is its invoke id: the invoke id that the ` +
      `author wrote, or else the key path of its gated state; ${has} (ADR-0011, ADR-0078)`;
    if (runtime && split === undefined) {
      warnings.push(`${line}; a runtime Chart of it may have one, which jr2 up cannot check`);
    } else errors.push(line);
  }
  return { errors, warnings };
}

export type AssemblyRefusalInput = {
  /** The Assembly's `jr2.config.ts`, loaded; `undefined` when it ships none. */
  config: JR2Config | undefined;
  /** Every Workflow the Assembly registers, loaded. */
  workflows: readonly LoadedWorkflow[];
  /**
   * The Assembly's Chart files (ADR-0070), read: `workflows/<wrapper>/<name>.chart.json`. Each is
   * admitted against its wrapper's Open body by the same door a run's Chart passes. Absent, none.
   */
  charts?: readonly ChartFile[];
  /**
   * The runtime Charts on the Orchestrator's volume (ADR-0070), by Workflow name
   * (`<wrapper>/<name>`): what a dispatch of a named Chart may resolve to beside the Chart files
   * (ADR-0071). The door can see them; absent, none.
   */
  runtimeCharts?: readonly { name: string }[];
  /**
   * The image map the Orchestrator reads per provision (ADR-0038), or a reader of it. Present
   * only when deployed: a host-booted process has no map, and no Sandbox to provision. When
   * present, every `file:` context a Machine names must have its digest in the map.
   */
  images?: () => Promise<ImageRefs>;
  /**
   * The directory the Assembly was imported from. A refusal names a `file:` context relative to
   * it (`images/box`), as the composer's own folder holds it: at the door that directory is a
   * staging path, which is gone when the refusal arrives.
   */
  root?: string;
};

/**
 * The door's walk (ADR-0069): the refusals the Orchestrator can see in an Assembly it has already
 * imported. An import error, a missing `export const machine` and a Vocabulary error are the
 * caller's: they throw at import, before this runs. Here: a zod `input` that no door reads, every
 * Open part, a secret the config does not declare (or a literal one too short to scrub), a `file:`
 * image context whose digest the mounted image map does not hold, and a Chart file that does not
 * admit under its wrapper (ADR-0070), each line naming the file. The door runs this after `jr2 up`
 * did its cluster work, so each check is true when the Assembly lands.
 */
export async function assemblyRefusals(input: AssemblyRefusalInput): Promise<string[]> {
  const lines = [
    ...doorRefusals(input.workflows),
    ...standingPoolRefusals(input.workflows),
    ...openPartRefusals(input.workflows),
    ...mcpRefusals(input.workflows, input.config),
  ];
  // A Chart file is the Instance's own (ADR-0070): one that fails refuses the publish.
  if (input.charts?.length) lines.push(...chartFileRefusals(input.charts, input.workflows));
  // An `answer` item that names single Gates names Gates that the Assembly has (ADR-0078). Its
  // warnings have no channel in the publish's answer: `jr2 up` printed them before the publish.
  lines.push(...gateScopeChecks(input.workflows, input.config, input.charts ?? []).errors);
  // A same-Instance dispatch names a Workflow this Assembly has (ADR-0071). The door sees the
  // runtime Charts, so a miss is an error here. Its warnings (a schema "not compared") have no
  // channel in the publish's answer, and are dropped: `jr2 up` printed them before the publish.
  lines.push(...dispatchRefusals(input.workflows, input.charts ?? [], input.runtimeCharts ?? []).errors);
  try {
    refuseEffectSecrets(input.config ?? {}, placementWalkOf(input.workflows));
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
  }
  const images = partsOf(input.workflows.map((w) => w.machine)).images;
  const where = (dir: string): string => {
    const rel = input.root === undefined ? undefined : relative(input.root, dir);
    return rel !== undefined && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
      ? rel.split(sep).join("/")
      : dir;
  };
  if (input.images && images.length) {
    let refs: ImageRefs | undefined;
    try {
      refs = await input.images();
    } catch (err) {
      lines.push(err instanceof Error ? err.message : String(err));
    }
    if (refs) {
      for (const image of images) {
        const digest = await imageContextDigest(image.dir);
        if (refs.sandbox[digest] === undefined) {
          const named = input.workflows
            .filter((w) => partsOf([w.machine]).images.some((i) => i.dir === image.dir))
            .map((w) => `"${w.name}"`);
          const by = named.length ? ` that workflow ${named.join(", ")} names` : "";
          lines.push(
            `the Sandbox Image context ${where(image.dir)}${by} (digest ${digest}) is not in the image map — ` +
              "`jr2 up` builds every `file:` context and writes the map before it publishes (ADR-0038, ADR-0069)",
          );
        }
      }
    }
  }
  return lines;
}

/**
 * The hooked Gates whose delivery a lost delivery can stop (ADR-0011, ADR-0054): a Gate slot that
 * hears a Hook and has no look, on a state with no `after`; and a Gate slot whose look a package left
 * `open` and nobody bound. `jr2 up` WARNS and does not refuse, because a person can still answer the
 * Gate with `jr2 send`. A Gate with `look: "none"` hears a command, which is an edge: no warning. One
 * line per Gate slot and state, over the registered Machine and every Machine that it composes.
 */
export function gateLookWarnings(workflows: readonly LoadedWorkflow[]): string[] {
  const lines: string[] = [];
  for (const w of workflows) {
    const seen = new Set<AnyStateMachine>();
    const walk = (machine: AnyStateMachine): void => {
      if (seen.has(machine)) return;
      seen.add(machine);
      const actors = machine.implementations.actors as Record<string, unknown>;
      const visit = (node: AnyStateMachine["root"]): void => {
        for (const inv of node.invoke) {
          const logic = typeof inv.src === "string" ? actors[inv.src] : inv.src;
          const child = asMachine(logic);
          if (child) walk(child);
          if (!isGateSlot(logic)) continue;
          const slot = inv.src as string;
          const parts = logic.gateSlot;
          if (parts.look === open) {
            lines.push(
              `workflow "${w.name}": Gate slot "${slot}" on "${node.id}" leaves its look open — a delivery lost in an ` +
                "outage stops the run until a person answers the Gate: bind it with customize(machine, { gates: { " +
                `${slot}: { look } } }), or give it look: "none" (ADR-0011, ADR-0054)`,
            );
            continue;
          }
          const hears = Object.values(parts.hooks).some((keys) => Object.keys(keys).length > 0);
          if (!hears || parts.look !== undefined || node.after.length > 0) continue;
          lines.push(
            `workflow "${w.name}": Gate slot "${slot}" on "${node.id}" hears a Hook and has no look and no \`after\` on ` +
              "its state — a delivery lost in an outage stops the run until a person answers the Gate: give it a " +
              'look, or look: "none" for a Gate that hears a command (ADR-0011)',
          );
        }
        for (const child of Object.values(node.states)) visit(child);
      };
      visit(machine.root);
      for (const logic of Object.values(actors)) {
        const child = asMachine(logic);
        if (child) walk(child);
      }
    };
    walk(w.machine);
  }
  return lines;
}
