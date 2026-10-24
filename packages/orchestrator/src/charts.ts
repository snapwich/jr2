// Named Charts (ADR-0070): a Chart under a name is a Workflow and a child of its Chart wrapper,
// named `<wrapper>/<name>`, from one of two origins. A Chart FILE is the Assembly's own:
// `workflows/<wrapper>/<name>.chart.json`, one level below the flat `workflows/*.ts` (ADR-0050),
// published by `jr2 up` and admitted by the door. A RUNTIME Chart is data a caller `PUT`s behind the
// Instance token: it lives on the Orchestrator's volume at `.jr2/charts/<wrapper>/<name>.chart.json`,
// beside the Assemblies, and survives restarts.
//
// This file holds three things: the volume layout and the Chart-file discovery; what makes a
// Machine a Chart wrapper (the two facts jr2 already reads: an Open body in its `actors`, and a
// door field that is `chartSchema`); and the registry of named Charts that the routes and each
// publish change. The registry tells the RunHost about every RUNNABLE named Chart (`registerChart`)
// and keeps the unrunnable ones itself, with the reason, so that a Chart whose wrapper the Assembly
// dropped still lists and is never deleted (ADR-0070: "it is someone else's").

import { mkdir, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AnyStateMachine } from "xstate";
import { DURABLE_TMP, fsyncPath, writeDurably } from "./assembly.ts";
import { chartHash, ChartRefusal, isChartSchema, narrowedChartSchema, type AdmittedChart } from "./chart.ts";
import type { ChartText } from "./chart.ts";
import {
  chartInputOf,
  admitBodyChart,
  chartWrapperMachineOf,
  isOpenBody,
  lentIn,
  openBodyDeclarationOf,
  type LentParts,
  type OpenBodyDeclaration,
  type OpenBodyLogic,
} from "./open-body.ts";
import type { RunHost, WorkflowListing } from "./run-host.ts";
import { inputSchemaOf } from "./vocabulary.ts";

/** Where a named Chart came from (ADR-0070): the Assembly's own file, or a `PUT` at run time. */
export type ChartOrigin = "file" | "runtime";

/** A Chart under a name. `unrunnable` says why it cannot start now; it is kept, never deleted. */
export type NamedChart = {
  wrapper: string;
  name: string;
  text: ChartText;
  hash: string;
  origin: ChartOrigin;
  unrunnable?: string;
};

/** The short name of a named Chart: lower case, digits and `-`, starting with a letter or digit,
 * at most 63 characters, so its file name on the volume is always one the filesystem takes. */
export const CHART_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The suffix of a Chart file, in the Assembly and on the volume. */
export const CHART_FILE = ".chart.json";

/** The runtime Charts' directory on the volume: `<dir>/.jr2/charts`, beside the Assemblies. */
export function chartsDir(dir: string): string {
  return join(dir, ".jr2", "charts");
}

/** A named Chart's Workflow name: `<wrapper>/<name>`. A Machine's name holds no slash; this always does. */
export function chartName(wrapper: string, name: string): string {
  return `${wrapper}/${name}`;
}

/** Split a Workflow name into its wrapper and its Chart name; undefined for a Machine's name. */
export function splitChartName(workflow: string): { wrapper: string; name: string } | undefined {
  const at = workflow.indexOf("/");
  if (at <= 0 || at === workflow.length - 1) return undefined;
  return { wrapper: workflow.slice(0, at), name: workflow.slice(at + 1) };
}

/** Why `name` is not a Chart name, or undefined when it is one. */
export function chartNameFault(name: string): string | undefined {
  return CHART_NAME.test(name)
    ? undefined
    : `"${name}" is not a Chart name: lower-case letters, digits and "-", starting with a letter or a digit, at most 63 characters`;
}

// --- Chart files ---------------------------------------------------------------------------------

/**
 * Every `workflows/<wrapper>/<name>.chart.json` of an Assembly root (ADR-0070), sorted. Only one
 * level below the flat `workflows/*.ts`; a directory whose name starts with `_` or `.` is a helper
 * directory and is not read. Any other file in a wrapper directory is ignored and named to
 * `warn` (default: `console.warn`), because a directory named after its wrapper holds nothing
 * else jr2 reads. A Chart file whose stem is not a Chart name is still returned: the door refuses
 * it by name.
 *
 * `contexts` are the docker contexts the registered Machines name (`partsOf(...).images`, each
 * `dir`): jr2 reads those too, so a file that is in one, is one, or holds one is not named. A
 * module's own context sits beside it (ADR-0037, ADR-0049), so `import.meta.resolve("./python")`
 * in `workflows/pytest.ts` is `workflows/python/`, one level below the flat `workflows/*.ts`.
 */
export async function discoverChartFiles(
  root: string,
  warn: (line: string) => void = (line) => console.warn(line),
  contexts: Iterable<string> = [],
): Promise<Array<{ wrapper: string; name: string; file: string }>> {
  const workflows = join(root, "workflows");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(workflows, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const read = await contextReader(workflows, contexts);
  const found: Array<{ wrapper: string; name: string; file: string }> = [];
  // A Chart file at the flat level is the easy mistake: it is in the Assembly, and no Chart is
  // registered from it. Named, as a stray file in a wrapper's directory is.
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(CHART_FILE)) {
      warn(
        `workflows/${e.name}: ignored — a Chart file sits in workflows/<wrapper>/<name>${CHART_FILE}, ` +
          `below the Chart wrapper it runs under (ADR-0070)`,
      );
    }
  }
  for (const dirent of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const wrapper = dirent.name;
    if (wrapper.startsWith("_") || wrapper.startsWith(".")) continue;
    const dir = join(workflows, wrapper);
    for (const f of (await readdir(dir)).sort()) {
      if (f.endsWith(CHART_FILE) && f.length > CHART_FILE.length) {
        found.push({ wrapper, name: f.slice(0, -CHART_FILE.length), file: join(dir, f) });
      } else if (!read(wrapper, f)) {
        warn(
          `workflows/${wrapper}/${f}: ignored — a wrapper's directory holds Chart files ` +
            `(<name>${CHART_FILE}) and nothing else jr2 reads (ADR-0070)`,
        );
      }
    }
  }
  return found;
}

/** Whether `workflows/<wrapper>/<file>` is in a docker context, is one, or holds one. Both sides
 * are compared as real paths: a module's `import.meta.resolve` is a real path, and the root a
 * caller passes need not be (a symlinked temp directory, an Assembly behind a link). */
async function contextReader(
  workflows: string,
  contexts: Iterable<string>,
): Promise<(wrapper: string, file: string) => boolean> {
  const real = async (path: string): Promise<string> => realpath(path).catch(() => path);
  const dirs = await Promise.all([...contexts].map(real));
  if (dirs.length === 0) return () => false;
  const base = await real(workflows);
  return (wrapper, file) => {
    const path = join(base, wrapper, file);
    return dirs.some((d) => d === path || d.startsWith(path + sep) || path.startsWith(d + sep));
  };
}

/** One Chart file, read: its text, or why it could not be read as JSON. */
export type ChartFile = {
  wrapper: string;
  name: string;
  /** The path relative to the Assembly root: `workflows/<wrapper>/<name>.chart.json`. */
  path: string;
  text: unknown;
  /** Set when the file is not JSON; `text` is then undefined. */
  error?: string;
};

/** Discover and read every Chart file of an Assembly root. A file that is not JSON is returned with
 * its `error`, for the door to refuse by name. `contexts` is as {@link discoverChartFiles} has it. */
export async function readChartFiles(
  root: string,
  warn?: (line: string) => void,
  contexts?: Iterable<string>,
): Promise<ChartFile[]> {
  const out: ChartFile[] = [];
  for (const { wrapper, name, file } of await discoverChartFiles(root, warn, contexts)) {
    const path = `workflows/${wrapper}/${name}${CHART_FILE}`;
    const raw = await readFile(file, "utf8");
    try {
      out.push({ wrapper, name, path, text: JSON.parse(raw) as unknown });
    } catch (err) {
      out.push({ wrapper, name, path, text: undefined, error: `not JSON: ${(err as Error).message}` });
    }
  }
  return out;
}

// --- Runtime Charts on the volume ----------------------------------------------------------------

/** `<dir>/.jr2/charts/<wrapper>/<name>.chart.json`. */
function runtimeChartPath(dir: string, wrapper: string, name: string): string {
  return join(chartsDir(dir), wrapper, `${name}${CHART_FILE}`);
}

/**
 * Every runtime Chart on the volume, sorted by name. A file that is not JSON, or whose name is not
 * a Chart name, is returned `unrunnable` with the reason: it is someone else's, so it is reported
 * and never deleted.
 */
export async function readRuntimeCharts(dir: string): Promise<NamedChart[]> {
  const root = chartsDir(dir);
  let wrappers: import("node:fs").Dirent[];
  try {
    wrappers = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: NamedChart[] = [];
  for (const w of wrappers.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const f of (await readdir(join(root, w.name))).sort()) {
      if (!f.endsWith(CHART_FILE) || f.length === CHART_FILE.length) continue; // a temp file of a write
      const name = f.slice(0, -CHART_FILE.length);
      const raw = await readFile(join(root, w.name, f), "utf8");
      let text: ChartText;
      try {
        text = JSON.parse(raw) as ChartText;
      } catch (err) {
        out.push({
          wrapper: w.name,
          name,
          text: {} as ChartText,
          hash: "",
          origin: "runtime",
          unrunnable: `the file on the volume is not JSON: ${(err as Error).message}`,
        });
        continue;
      }
      let hash = "";
      try {
        hash = chartHash(text);
      } catch {
        // Not hashable: the admission that follows names the fault.
      }
      const fault = chartNameFault(name);
      out.push({ wrapper: w.name, name, text, hash, origin: "runtime", ...(fault ? { unrunnable: fault } : {}) });
    }
  }
  return out;
}

/** Write a runtime Chart durably (temp file, fsync, rename, fsync the directory), as the
 * Assemblies are written: a crash leaves the old text or the new, never a part. A directory the
 * write created has its own entry made durable too, up to `.jr2`. The file holds the Chart text
 * alone. */
export async function writeRuntimeChart(dir: string, chart: NamedChart): Promise<void> {
  const target = runtimeChartPath(dir, chart.wrapper, chart.name);
  const parent = join(chartsDir(dir), chart.wrapper);
  const first = await mkdir(parent, { recursive: true });
  await writeDurably(target, `${JSON.stringify(chart.text, null, 2)}\n`);
  if (first !== undefined) {
    // `first` is the top directory mkdir made: fsync each parent from the wrapper's up to it.
    for (let at = parent; at.length >= first.length; at = join(at, "..")) await fsyncPath(join(at, ".."));
  }
}

/** Remove the temp files a crashed {@link writeRuntimeChart} left (ADR-0070), as `removeStaging`
 * does for the Assemblies. */
async function removeStaleTemps(dir: string): Promise<void> {
  const root = chartsDir(dir);
  let wrappers: import("node:fs").Dirent[];
  try {
    wrappers = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const w of wrappers.filter((e) => e.isDirectory())) {
    for (const f of await readdir(join(root, w.name))) {
      if (DURABLE_TMP.test(f)) await rm(join(root, w.name, f), { force: true });
    }
  }
}

/** Remove a runtime Chart from the volume. False when there was none. An emptied wrapper
 * directory is removed too. */
export async function removeRuntimeChart(dir: string, wrapper: string, name: string): Promise<boolean> {
  const target = runtimeChartPath(dir, wrapper, name);
  try {
    await rm(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const parent = join(chartsDir(dir), wrapper);
  await fsyncPath(parent);
  await rmdir(parent).catch(() => {}); // not empty: other Charts of this wrapper stay
  return true;
}

// --- Chart wrappers ------------------------------------------------------------------------------

/** One Open body of a Chart wrapper: its slot key, its declaration, the lent set it has now. */
export type OpenBodyOf = { slot: string; declaration: OpenBodyDeclaration; lent: LentParts };

/**
 * What makes a Machine a Chart wrapper (ADR-0070), read from the two facts jr2 already reads: the
 * Open bodies in its `actors`, and its door's fields that are `chartSchema`.
 */
export type ChartWrapper = {
  /** The first Open body's slot key. */
  body: string;
  /** Every Open body, in `actors` order. A named Chart is admitted when one of them admits it,
   * the rule the start door (`admitWrapperChart`) uses for a Chart field. */
  bodies: OpenBodyOf[];
  /** The door's fields that are `chartSchema`: a named Chart supplies each of them. Empty for a
   * wrapper for in-Machine Charts only. */
  chartFields: string[];
  /** The door's other fields: the Chart's `input` keys the door can see (ADR-0070 rule 7). */
  inputKeys: string[];
};

/**
 * The lent set an Open body has under `machine`: the Machine's own implementations by the lent
 * names, read each time. Never the stamp on the slot's logic: one `openBody()` value used in two
 * Machines holds one stamp, the last `createMachine`'s. A name the Machine does not implement is
 * left out, so the door refuses a Chart that uses it.
 */
function lentSetOf(machine: AnyStateMachine, logic: OpenBodyLogic): LentParts {
  return lentIn(machine.implementations as never, openBodyDeclarationOf(logic));
}

/** The Chart wrapper a Machine is, or undefined when it declares no Open body. The bodies and the
 * lent set are seen through jr2's transparent wrappers (a Chart wrapper that is a `workspace()`'s
 * body), and the door is `machine`'s own. */
export function chartWrapperOf(machine: AnyStateMachine): ChartWrapper | undefined {
  const inner = chartWrapperMachineOf(machine).machine;
  const actors = (inner.implementations?.actors ?? {}) as Record<string, unknown>;
  const bodies: OpenBodyOf[] = [];
  for (const [slot, logic] of Object.entries(actors)) {
    if (!isOpenBody(logic)) continue;
    bodies.push({ slot, declaration: openBodyDeclarationOf(logic), lent: lentSetOf(inner, logic) });
  }
  if (!bodies.length) return undefined;
  const shape = (inputSchemaOf(machine)?.shape ?? {}) as Record<string, unknown>;
  const chartFields = Object.keys(shape).filter((k) => isChartSchema(shape[k]));
  // The door's other fields, less the body's placement: a Chart reads no url (open-body.ts).
  const inputKeys = Object.keys(chartInputOf(shape)).filter((k) => !chartFields.includes(k));
  return { body: bodies[0]!.slot, bodies, chartFields, inputKeys };
}

/**
 * Admit a named Chart's text under its wrapper (ADR-0070), with the door's other fields as the
 * Chart's `input` keys. The door cannot tell which Open body a Chart field feeds, so the Chart is
 * admitted when one body admits it: the rule the start door (`admitWrapperChart`) uses, so a
 * named Chart and the same text sent one-shot get one verdict. With more than one body, each
 * report line names the body it is about. Throws {@link ChartRefusal}.
 */
export function admitUnder(wrapper: ChartWrapper, text: unknown): AdmittedChart {
  const report: string[] = [];
  for (const body of wrapper.bodies) {
    try {
      return admitBodyChart(text, body.declaration, body.lent, { inputKeys: wrapper.inputKeys });
    } catch (err) {
      if (!(err instanceof ChartRefusal)) throw err;
      const prefix = wrapper.bodies.length > 1 ? `body "${body.slot}": ` : "";
      report.push(...err.report.map((line) => `${prefix}${line}`));
    }
  }
  throw new ChartRefusal(report);
}

/** One Machine an Assembly registers, as the registry reads it. */
export type ChartMachine = { name: string; machine: AnyStateMachine };

/**
 * Why a named Chart cannot be under `wrapper` in these Workflows, or undefined when it can
 * (ADR-0070): the wrapper must be a registered Machine, a Chart wrapper, and have a Chart door.
 */
export function wrapperFault(
  workflows: readonly ChartMachine[],
  wrapper: string,
): { status: 404 | 409; error: string } | undefined {
  const found = workflows.find((w) => w.name === wrapper);
  if (!found) return { status: 404, error: `no workflow "${wrapper}"` };
  const w = chartWrapperOf(found.machine);
  if (!w) {
    return {
      status: 409,
      error: `workflow "${wrapper}" is no Chart wrapper: it declares no Open body (openBody() in its actors), so no Chart runs under it (ADR-0070)`,
    };
  }
  if (!w.chartFields.length) {
    return {
      status: 409,
      error: `workflow "${wrapper}" has no Chart door: no field of its input is chartSchema, so its Open body binds only Charts its own states supply (ADR-0070)`,
    };
  }
  return undefined;
}

/**
 * The door's refusals for an Assembly's Chart files (ADR-0070), one line per fault, each naming the
 * file: a bad name, a wrapper that is no registered Machine, no Chart wrapper or no Chart door, a
 * file that is not JSON, and every line of the Chart door's report.
 */
export function chartFileRefusals(files: readonly ChartFile[], workflows: readonly ChartMachine[]): string[] {
  const lines: string[] = [];
  for (const f of files) {
    const nameFault = chartNameFault(f.name);
    if (nameFault) {
      lines.push(`${f.path}: ${nameFault} (ADR-0070)`);
      continue;
    }
    const fault = wrapperFault(workflows, f.wrapper);
    if (fault) {
      lines.push(
        `${f.path}: ${fault.status === 404 ? `no workflows/${f.wrapper}.ts registers the Chart wrapper "${f.wrapper}" this Chart file is under` : fault.error}`,
      );
      continue;
    }
    if (f.error !== undefined) {
      lines.push(`${f.path}: ${f.error}`);
      continue;
    }
    const w = chartWrapperOf(workflows.find((x) => x.name === f.wrapper)!.machine)!;
    try {
      admitUnder(w, f.text);
    } catch (err) {
      if (!(err instanceof ChartRefusal)) throw err;
      lines.push(...err.report.map((line) => `${f.path}: Chart refused: ${line}`));
    }
  }
  return lines;
}

// --- The registry --------------------------------------------------------------------------------

/** The RunHost methods the registry speaks through (seam B owns them). */
export type ChartHost = Pick<RunHost, "registerChart" | "unregisterChart">;

/** What `PUT` and `DELETE` refuse with: an HTTP status and a body. */
export class NamedChartError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  readonly body: Record<string, unknown>;
  constructor(status: 400 | 404 | 409 | 422, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : JSON.stringify(body));
    this.name = "NamedChartError";
    this.status = status;
    this.body = body;
  }
}

/** The Chart counts the announce line names (ADR-0070). */
export type ChartCounts = { files: number; runtime: number; unrunnable: Array<{ name: string; reason: string }> };

/** The Workflows a registry binds to: one Assembly's Machines and Chart files. */
export type ChartBinding = {
  workflows: readonly ChartMachine[];
  files: readonly ChartFile[];
  /** The Assembly's hash, stamped on each named Chart's def (ADR-0069). */
  assembly?: string;
};

/**
 * The named Charts of one Instance (ADR-0070). `bind` re-admits every named Chart against an
 * Assembly (at boot and at each publish); `put` and `remove` are the runtime routes. Each runnable
 * Chart is registered on the host as a Workflow named `<wrapper>/<name>`; an unrunnable one is kept
 * here with its reason and listed, and a start of it is refused with that reason.
 */
export class NamedCharts {
  private readonly dir: string;
  private readonly host: ChartHost;
  /** The bound Assembly's Chart files, by Workflow name. */
  private files = new Map<string, NamedChart>();
  /** The runtime Charts on the volume, by Workflow name. */
  private readonly runtime = new Map<string, NamedChart>();
  /** The runtime Charts whose file on the volume is not JSON: nothing to admit, the reason stays. */
  private readonly broken = new Set<string>();
  /** The names registered on the host now. */
  private readonly registered = new Set<string>();
  private binding: ChartBinding = { workflows: [], files: [] };
  /** `put` and `remove` run one at a time: each awaits the volume, and a DELETE that ran inside a
   * PUT's write could answer 204 while the PUT then registers a Chart with no file. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(opts: { dir: string; host: ChartHost }) {
    this.dir = opts.dir;
    this.host = opts.host;
  }

  /** Read the runtime Charts on the volume (a boot). They are admitted at the next `bind`. */
  async load(): Promise<void> {
    await removeStaleTemps(this.dir);
    for (const c of await readRuntimeCharts(this.dir)) {
      const name = chartName(c.wrapper, c.name);
      this.runtime.set(name, c);
      if (c.hash === "" && c.unrunnable !== undefined) this.broken.add(name);
    }
  }

  /**
   * Bind an Assembly (ADR-0070): take its Chart files in place of the last one's, and re-admit
   * every named Chart against its Machines. A Chart file the door admitted admits here too; a
   * runtime Chart that fails now (a lent slot or its wrapper is gone) is marked unrunnable and
   * kept. A runtime Chart whose name a Chart file of this Assembly holds is unrunnable too: the
   * file is the Instance's own. Returns the unrunnable ones, for the publish's answer.
   */
  bind(binding: ChartBinding): ChartCounts["unrunnable"] {
    this.binding = binding;
    this.files = new Map();
    for (const f of binding.files) {
      let hash = "";
      try {
        hash = chartHash(f.text as ChartText);
      } catch {
        // Not hashable: the admission below names the fault.
      }
      const chart: NamedChart = { wrapper: f.wrapper, name: f.name, text: f.text as ChartText, hash, origin: "file" };
      this.files.set(chartName(f.wrapper, f.name), this.admit(chart));
    }
    for (const [name, c] of this.runtime) {
      if (this.broken.has(name)) continue;
      this.runtime.set(name, this.judgeRuntime(c));
    }
    const live = new Set<string>();
    for (const [name, c] of [...this.files, ...this.runtime]) {
      if (c.unrunnable !== undefined || live.has(name)) continue;
      this.registerOnHost(c);
      live.add(name);
    }
    for (const name of [...this.registered]) {
      if (live.has(name)) continue;
      const { wrapper, name: short } = splitChartName(name)!;
      this.host.unregisterChart(wrapper, short);
      this.registered.delete(name);
    }
    return this.unrunnable();
  }

  /** A runtime Chart judged against the bound Assembly: unrunnable when a Chart file of it holds
   * the same name (the file is the Instance's own), else as {@link admit} judges it. */
  private judgeRuntime(c: NamedChart): NamedChart {
    const name = chartName(c.wrapper, c.name);
    return this.files.has(name)
      ? {
          ...withoutReason(c),
          unrunnable: `the Assembly's Chart file workflows/${c.wrapper}/${c.name}${CHART_FILE} holds this name (ADR-0070)`,
        }
      : this.admit(c);
  }

  /** The Chart admitted against the bound Machines: runnable, or unrunnable with the reason. */
  private admit(c: NamedChart): NamedChart {
    const chart = withoutReason(c);
    const nameFault = chartNameFault(c.name);
    if (nameFault) return { ...chart, unrunnable: nameFault };
    const fault = wrapperFault(this.binding.workflows, c.wrapper);
    if (fault) {
      return {
        ...chart,
        unrunnable:
          fault.status === 404
            ? `the Chart wrapper "${c.wrapper}" is not in the current Assembly (ADR-0070)`
            : fault.error,
      };
    }
    const wrapper = this.wrapperOf(c.wrapper);
    if (!wrapper) return { ...chart, unrunnable: `the Workflow "${c.wrapper}" is no Chart wrapper (ADR-0070)` };
    try {
      const admitted = admitUnder(wrapper, c.text);
      return { ...chart, text: admitted.text, hash: admitted.hash };
    } catch (err) {
      if (!(err instanceof ChartRefusal)) throw err;
      return { ...chart, unrunnable: `Chart refused: ${err.report.join("; ")}` };
    }
  }

  /** Register a Chart that {@link admit} found runnable against the bound Assembly. A wrapper that
   * is gone registers nothing: the caller judged the Chart against this binding, so it cannot be. */
  private registerOnHost(c: NamedChart): void {
    const found = this.binding.workflows.find((w) => w.name === c.wrapper);
    const wrapper = found && chartWrapperOf(found.machine);
    if (!found || !wrapper) return;
    const name = chartName(c.wrapper, c.name);
    this.host.registerChart({
      name,
      machine: found.machine,
      // Nothing to inject (ADR-0011), as for every Workflow an Assembly registers.
      provide: () => ({}),
      ...(this.binding.assembly !== undefined ? { assembly: this.binding.assembly } : {}),
      wrapper: { body: wrapper.body, chartFields: wrapper.chartFields },
      chart: { wrapper: c.wrapper, name: c.name, text: c.text, hash: c.hash, origin: c.origin },
    });
    this.registered.add(name);
  }

  /** The named Chart under this Workflow name: the Chart file, before a runtime Chart it shadows. */
  get(workflow: string): NamedChart | undefined {
    return this.files.get(workflow) ?? this.runtime.get(workflow);
  }

  /** Every named Chart that cannot start now, with the reason, sorted by name then origin. */
  unrunnable(): ChartCounts["unrunnable"] {
    return [...this.files.values(), ...this.runtime.values()]
      .filter((c) => c.unrunnable !== undefined)
      .map((c) => ({ name: chartName(c.wrapper, c.name), reason: c.unrunnable! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What the announce line names. */
  counts(): ChartCounts {
    return { files: this.files.size, runtime: this.runtime.size, unrunnable: this.unrunnable() };
  }

  /**
   * The host's listing with every unrunnable named Chart added (ADR-0070): inside its wrapper's
   * entry when the wrapper is registered, else as an entry of its own. The host lists the runnable
   * ones, since it registers them.
   */
  listing(base: WorkflowListing[]): WorkflowListing[] {
    const out = base.map((w) => (w.wrapper ? { ...w, wrapper: { ...w.wrapper, charts: [...w.wrapper.charts] } } : w));
    for (const c of [...this.files.values(), ...this.runtime.values()]) {
      if (c.unrunnable === undefined) continue;
      const name = chartName(c.wrapper, c.name);
      const entry = out.find((w) => w.name === c.wrapper && w.wrapper);
      if (entry?.wrapper) {
        const charts = entry.wrapper.charts.filter((x) => !(x.name === c.name && x.origin === c.origin));
        charts.push({ name: c.name, origin: c.origin, unrunnable: c.unrunnable });
        entry.wrapper.charts = charts.sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
      } else if (!out.some((w) => w.name === name && w.origin === c.origin)) {
        out.push({ name, origin: c.origin, unrunnable: c.unrunnable });
      }
    }
    // A named Chart lists inside its wrapper's entry, not beside it (ADR-0070): an entry of its own
    // stays only for a Chart whose wrapper the listing does not give.
    const inside = new Set(
      out.flatMap((w) => (w.wrapper ? w.wrapper.charts.map((c) => `${chartName(w.name, c.name)} ${c.origin}`) : [])),
    );
    return out.filter((w) => w.origin === "machine" || !inside.has(`${w.name} ${w.origin}`));
  }

  /** The Chart wrapper a bound Workflow is; undefined for a Machine with no Open body or an
   * unknown name. */
  wrapperOf(workflow: string): ChartWrapper | undefined {
    const found = this.binding.workflows.find((w) => w.name === workflow);
    return found && chartWrapperOf(found.machine);
  }

  /** The narrowed grammar of a Chart wrapper (`GET /workflows/:wrapper/chart-schema`); undefined
   * when `wrapper` is no Chart wrapper. The first Open body's, when it declares more than one. */
  schema(wrapper: string): Record<string, unknown> | undefined {
    const w = this.wrapperOf(wrapper);
    return w ? narrowedChartSchema(w.bodies[0]!.declaration) : undefined;
  }

  /**
   * `PUT /workflows/:wrapper/charts/:name` (ADR-0070): admit the text under the wrapper, write it to
   * the volume durably, and register it. `created` is false when it replaced a runtime Chart of the
   * same name; a live run of the old text keeps its own. Throws {@link NamedChartError}.
   */
  put(
    wrapper: string,
    name: string,
    text: unknown,
  ): Promise<{ created: boolean; name: string; hash: string; unrunnable?: string }> {
    return this.serial(() => this.putNow(wrapper, name, text));
  }

  private async putNow(
    wrapper: string,
    name: string,
    text: unknown,
  ): Promise<{ created: boolean; name: string; hash: string; unrunnable?: string }> {
    const nameFault = chartNameFault(name);
    if (nameFault) throw new NamedChartError(400, { error: nameFault });
    const fault = wrapperFault(this.binding.workflows, wrapper);
    if (fault) throw new NamedChartError(fault.status, { error: fault.error });
    const full = chartName(wrapper, name);
    if (this.files.has(full)) {
      throw new NamedChartError(409, {
        error: `"${full}" is a Chart file of the Assembly (workflows/${wrapper}/${name}${CHART_FILE}): change it there and \`jr2 up\` (ADR-0070)`,
      });
    }
    const w = this.wrapperOf(wrapper)!;
    let admitted: AdmittedChart;
    try {
      admitted = admitUnder(w, text);
    } catch (err) {
      if (err instanceof ChartRefusal) throw new NamedChartError(422, { error: "refused", report: err.report });
      throw err;
    }
    const chart: NamedChart = { wrapper, name, text: admitted.text, hash: admitted.hash, origin: "runtime" };
    await writeRuntimeChart(this.dir, chart);
    // A publish can bind a new Assembly while the write awaits. The text is judged again, with no
    // await, against the binding there is NOW, so this Chart is registered only under a wrapper
    // that admits it, and is kept unrunnable with the reason when that wrapper does not.
    const created = !this.runtime.has(full);
    const judged = this.judgeRuntime(chart);
    this.runtime.set(full, judged);
    this.broken.delete(full);
    if (judged.unrunnable === undefined) this.registerOnHost(judged);
    else if (this.registered.delete(full)) this.host.unregisterChart(wrapper, name);
    return {
      created,
      name: full,
      hash: admitted.hash,
      ...(judged.unrunnable !== undefined ? { unrunnable: judged.unrunnable } : {}),
    };
  }

  /** Run `step` after every `put` and `remove` before it has settled; at once when none is. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.pending === 0 ? step() : this.queue.then(step, step);
    this.pending++;
    this.queue = run.then(
      () => void this.pending--,
      () => void this.pending--,
    );
    return run;
  }

  /**
   * `DELETE /workflows/:wrapper/charts/:name` (ADR-0070): remove a runtime Chart from the volume and
   * the registry. A live run of it keeps its text. Throws {@link NamedChartError}: 409 for a Chart
   * file, which is the Instance's own; 404 when there is no such runtime Chart.
   */
  remove(wrapper: string, name: string): Promise<void> {
    return this.serial(() => this.removeNow(wrapper, name));
  }

  private async removeNow(wrapper: string, name: string): Promise<void> {
    const full = chartName(wrapper, name);
    if (this.files.has(full)) {
      throw new NamedChartError(409, {
        error: `a Chart file is the Instance's own: remove workflows/${wrapper}/${name}${CHART_FILE} and \`jr2 up\` (ADR-0070)`,
      });
    }
    const held = this.runtime.has(full);
    // Only a path that names a Chart reaches the volume: a wrapper is a Workflow's filename stem,
    // never `..`, a separator or a NUL. Any other fault of the volume here is "no such Chart".
    const onVolume = !chartNameFault(name) && !/^\.|[/\\\0]/.test(wrapper);
    const removed = onVolume
      ? await removeRuntimeChart(this.dir, wrapper, name).catch((err: unknown) => {
          if (held) throw err; // a Chart this registry holds: its file's fault is a real one
          return false;
        })
      : false;
    if (!held && !removed) throw new NamedChartError(404, { error: `no named Chart "${full}"` });
    this.runtime.delete(full);
    this.broken.delete(full);
    if (this.registered.delete(full)) this.host.unregisterChart(wrapper, name);
  }
}

/** A named Chart without its `unrunnable` reason, to be judged again. */
function withoutReason(c: NamedChart): NamedChart {
  const { unrunnable: _, ...rest } = c;
  return rest;
}
