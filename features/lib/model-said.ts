// What the @model drivers read off a Harness's printed conversation (ADR-0023, ADR-0066), and the
// modes a claim workflow's Agent state has. Pure, and apart from the step files, so a unit test
// can pin each reading without a cluster or a model.

import { spawn } from "node:child_process";

/** Labels the printer uses for what is not a tool call. */
const NOT_A_CALL = new Set(["prompt", "text", "thinking", "compacted"]);

/** One line of a printed conversation that matters to a claim: a tool call by name, or a prompt
 * the model read — the Frame's, a nudge, or a Turn part restated at a step boundary — by its first
 * line. */
export type Said = { call: string } | { prompt: string };

/** A restated Turn part (ADR-0029) prints as its own prompt, `<jr2-turn>` on its first line. */
export const isRestatement = (s: Said): boolean => "prompt" in s && s.prompt.startsWith("<jr2-turn>");
/** The nudge (ADR-0016) prints as its own prompt; its first sentence is fixed. The wake asks with
 * the same text. */
export const isNudge = (s: Said): boolean => "prompt" in s && s.prompt.startsWith("Your previous turn ended");

/**
 * What the model called and read in the Turn whose prompt carries `marker`, read off a Harness's
 * log — `[<agent>] [<tool>] <input>` lines, Menu tools by their bare name (ADR-0023). It runs on
 * through the nudges and the restated Turn parts of that Turn, and stops at the next trial's prompt
 * (another `[<marker>]`). `undefined` while that prompt has not printed.
 */
export function saidIn(log: string, agent: string, marker: string): Said[] | undefined {
  const lines = log.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`[${agent}] [prompt] `) && l.includes(`[${marker}]`));
  if (at === -1) return undefined;
  const line = new RegExp(`^\\[${agent}\\] \\[([^\\]]+)\\] ?(.*)$`);
  const out: Said[] = [];
  for (const text of lines.slice(at + 1)) {
    const m = line.exec(text);
    if (!m) continue;
    if (m[1] === "prompt") {
      if (/^\[[^\]]+\]/.test(m[2]!)) break; // another trial's Frame
      out.push({ prompt: m[2]! });
      continue;
    }
    // A body spans lines and only its first carries the label; a thinking line that happens to
    // open with `[Output Generation]` is not a call. A tool's name is lower-case snake, always.
    if (!NOT_A_CALL.has(m[1]!) && /^[a-z][a-z0-9_]*$/.test(m[1]!)) out.push({ call: m[1]! });
  }
  return out;
}

/** The index of the first ask (a nudge or a wake, ADR-0016) after the model's first `call`; -1 when
 * it never made that call, or was not asked after it. */
export function askAfter(said: readonly Said[], call: string): number {
  const at = said.findIndex((s) => "call" in s && s.call === call);
  return at === -1 ? -1 : said.findIndex((s, i) => i > at && isNudge(s));
}

/** The calls in `said` from index `from` on, Menu calls only (`menu` names them). */
export function menuCalls(
  said: readonly Said[],
  menu: ReadonlySet<string>,
  from = 0,
): Array<{ at: number; call: string }> {
  return said.flatMap((s, at) => (at >= from && "call" in s && menu.has(s.call) ? [{ at, call: s.call }] : []));
}

/** What a trial's printed conversation says, in one line for the failure report. */
export const told = (said: readonly Said[]): string =>
  said
    .map((s) => ("call" in s ? s.call : isNudge(s) ? "(nudge)" : isRestatement(s) ? "(restated)" : "(prompt)"))
    .join(" ");

/** A process's output, streamed from its start: `text` grows as it prints, `closed` settles when it
 * ends. A Sandbox pod's log, followed from Ready, outlives the reap that deletes the pod: the
 * stream holds everything the container printed up to then. */
export type Follow = { text: string; closed: Promise<void>; stop: () => void };

export function follow(command: string, args: readonly string[]): Follow {
  const child = spawn(command, args);
  const out: Follow = {
    text: "",
    closed: new Promise((resolve) => child.on("close", () => resolve())),
    stop: () => child.kill(),
  };
  child.stdout.on("data", (d: Buffer) => {
    out.text += d.toString();
  });
  return out;
}

// --- a claim workflow's modes ----------------------------------------------------------------------

/** The parts of an xstate state node the mode reading uses. */
export type StateNodeLike = {
  key: string;
  id: string;
  parent?: StateNodeLike;
  states: Record<string, StateNodeLike>;
  transitions: Map<string, ReadonlyArray<{ target?: ReadonlyArray<StateNodeLike> }>>;
  after: ReadonlyArray<{ target?: ReadonlyArray<StateNodeLike> }>;
};

/** One mode by what moves it: each pick it allows and where that pick goes, and where its timers
 * go. A target that is not a sibling mode is named by its state id. */
export type Modes = Record<string, { picks: Record<string, string>; after: string[] }>;

/** The modes of the Agent's state `node`, read from the built Machine — never a hand copy. */
export function modesOf(node: StateNodeLike): Modes {
  const name = (target: StateNodeLike | undefined): string =>
    target === undefined ? "" : target.parent === node ? target.key : target.id;
  const out: Modes = {};
  for (const [key, mode] of Object.entries(node.states)) {
    const picks: Record<string, string> = {};
    for (const [event, ts] of mode.transitions) {
      if (event.includes(".") || event === "*") continue;
      const target = ts.find((t) => t.target?.length)?.target?.[0];
      if (target !== undefined) picks[event] = name(target);
    }
    out[key] = { picks, after: mode.after.flatMap((t) => (t.target?.length ? [name(t.target[0])] : [])) };
  }
  return out;
}

/**
 * The mode active when the model was asked again, replayed from `initial` over `said` up to the ask
 * (its calls and its restated Turn parts, in order):
 *   - a Menu call (`menu` names them) the mode allows moves the mode; one it does not allow is
 *     refused and moves nothing;
 *   - a restated Turn part (ADR-0029) says the Allowed picks changed under the model with no pick
 *     of its own. In a claim workflow only a timer does that, so the mode's timer is taken there;
 *   - at the ask: a model asked in a mode with no picks was woken (ADR-0016), and the wake waits
 *     for a pick to open, so the mode's timers are followed to the first mode that has one.
 * A timer that fires between a step boundary's read and the model's next call is seen by neither;
 * the replay cannot tell it, and a claim's timer is long enough that it is rare.
 */
export function modeAtAsk(modes: Modes, initial: string, said: readonly Said[], menu: ReadonlySet<string>): string {
  let mode = initial;
  const timer = (): boolean => {
    const next = modes[mode]?.after[0];
    if (next === undefined) return false;
    mode = next;
    return true;
  };
  for (const s of said) {
    if ("call" in s) {
      if (menu.has(s.call)) mode = modes[mode]?.picks[s.call] ?? mode;
    } else if (isRestatement(s)) timer();
  }
  const seen = new Set<string>();
  while (modes[mode] && Object.keys(modes[mode]!.picks).length === 0 && !seen.has(mode)) {
    seen.add(mode);
    if (!timer()) break;
  }
  return mode;
}
