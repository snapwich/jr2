// The other two processes a real Agent turn needs, reduced to what conformance asserts about
// (ADR-0027: the flue-contract tier's rig, re-owned — the Harness itself now runs IN-PROCESS):
//
//   the provider  — a scripted OpenAI-compatible fake, so a turn's SHAPE is chosen by the test
//                   (where it stalls, what it half-emits, when it fails) instead of by a model.
//                   Records every request body, which is the only place context loss is visible.
//   the Custodian — what answers at `$JR2_CUSTODIAN_URL`: HTTPS at jr2's own name under a test CA,
//                   as on the Fence (ADR-0059, ADR-0084), over a real socket: the Orchestrator's
//                   surface and delivery routes as the Custodian relays them, a surface that can
//                   be killed or swapped mid-run (what a state exit does to a registration), and
//                   deliveries that can be held open (an abort mid-tool-call). The Custodian's
//                   own claims are its suite's (ADR-0059); what the Harness owes is here.
//
// Both are SHARED across a file's tests (`reset` rearms them per scenario), so per-scenario
// servers do not each wait out a keep-alive to close.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, LookupFunction } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { CUSTODIAN_URL, controlFetch } from "../../src/control-fetch.ts";
import type { Surface } from "../../src/menu.ts";

/** The control Stand-in the Harness process holds and sends as its Menu bearer (ADR-0076): secret,
 * read from its file, never the public fetch Stand-in. */
export const CONTROL_STAND_IN = "c3RhbmQtaW4tZm9yLXRoZS1jb250cm9sLXRva2VuLTA";

// ─── the scripted provider ───────────────────────────────────────────────────

/** One streaming response, under the test's control. `stall` holds the socket open forever. */
export type Turn = {
  text?: string;
  /** Emit a tool call. `partial` stops after the name — no arguments, no finish, no `[DONE]`. */
  toolCall?: { id: string; name: string; args?: string; partial?: boolean };
  /** Several tool calls in ONE assistant message — the engine runs them one at a time, in this order (ADR-0027). */
  toolCalls?: Array<{ id: string; name: string; args?: string }>;
  stall?: boolean;
  /** End the stream after what came before, with no finish and no `[DONE]` — a provider that
   * fails mid-stream. pi ends the message with stopReason `error` and keeps its partial content. */
  broken?: boolean;
  /** Answer this HTTP status with an error body instead of a stream — the provider-failure lever
   * (with `maxRetries: 0` the turn settles `failed` on the first attempt). */
  status?: number;
  /** The error body's message with `status` — what a provider says, which is what tells a rate
   * limit from quota exhaustion (ADR-0064). Default "scripted provider failure". */
  errorMessage?: string;
  /** Headers on the `status` answer — a server's `retry-after` (ADR-0064). */
  headers?: Record<string, string>;
  /** Reasoning the model streams before its answer (`reasoning_content`). */
  reasoning?: string;
  /** The usage this response reports — Compaction's only lever (ADR-0036), since a scripted
   * transcript can never fill a real window. pi DERIVES its total from the parts rather than
   * reading `total_tokens`, so the fabricated context size goes in `prompt_tokens`. The cache's
   * share of the prompt rides in `prompt_tokens_details`, as OpenAI reports it. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
};

/** One request body, as the provider received it. `tools` is where the Menu is visible — the same bytes on every Turn (ADR-0029). */
export type RecordedCall = {
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ function?: { name?: string } }>;
  /** The model id the request named — the only witness that a per-turn dial reached the wire. */
  model?: string;
  /** The thinking level the request named. pi writes a non-`off` level as `reasoning_effort` for
   * every model declaring `reasoning` (which `provider.ts` does for the custom provider), so this
   * is where a Turn's level is visible — including on the summarizer's own request (ADR-0036). */
  reasoning_effort?: string;
  /** The request's headers (node's lower-case names): attribution headers are visible here. */
  headers?: Record<string, string | string[] | undefined>;
  /** Arrival order across BOTH streams (turn requests and summarizer requests), from 1. Compaction
   * happens at a request the test does not choose, so this is the only witness that the cut landed
   * BETWEEN two requests of one turn rather than at a turn boundary. */
  seq: number;
};

export type FakeProvider = {
  url: string;
  /** Every request body the provider received since the last `reset`, in order. */
  calls: RecordedCall[];
  /** The compaction summarizer's requests (ADR-0036) — pi's own LLM call, recorded APART from
   * `calls`: it fires at a request the test does not choose, so letting it consume a script slot
   * would shift every later turn and quietly break the exact-count assertions. */
  summaries: RecordedCall[];
  /** What any summarization request answers with. `status` is the compaction-failure lever. */
  summarize: (answer: { text?: string; status?: number; stall?: boolean }) => void;
  /** True while a scripted response is deliberately holding its socket open. */
  stalled: () => boolean;
  /** Rearm for the next scenario: forget recorded calls, swap the script. */
  reset: (script: Turn[]) => void;
  close: () => Promise<void>;
};

/** How a summarization request is told apart from a turn request: pi sends it standalone, with its
 * own system prompt and no tools (`SUMMARIZATION_SYSTEM_PROMPT`, matched on its opening clause). */
const SUMMARIZER_MARK = "You are a context summarization assistant";

/** `script[n]` answers call n+1; anything past the end answers plain text. */
export async function startFakeProvider(initialScript: Turn[] = []): Promise<FakeProvider> {
  let script = initialScript;
  const calls: RecordedCall[] = [];
  const summaries: RecordedCall[] = [];
  let summaryAnswer: { text?: string; status?: number; stall?: boolean } = {};
  let seq = 0;
  let stalling = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      if (!req.url?.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model-x" }] }));
        return;
      }
      const body = JSON.parse(raw) as RecordedCall & { stream?: boolean };
      seq += 1;
      body.seq = seq;
      body.headers = req.headers;
      // pi's summarizer request is not a scripted turn: it arrives at a request the test did not
      // choose, so it is recorded apart and answered from `summarize` (ADR-0036).
      const summarizing = raw.includes(SUMMARIZER_MARK);
      let turn: Turn;
      if (summarizing) {
        summaries.push(body);
        turn = { text: summaryAnswer.text ?? "## Goal\nEverything before this was summarized.", ...summaryAnswer };
      } else {
        calls.push(body);
        turn = script[calls.length - 1] ?? { text: `turn ${calls.length}` };
      }
      const id = `chatcmpl-${seq}`;
      const created = Math.floor(Date.now() / 1000);
      // `total_tokens` is decoration: pi derives the total from the parts, so a scripted context
      // size only counts when it rides in `prompt_tokens`.
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...turn.usage };

      if (turn.status !== undefined) {
        res.writeHead(turn.status, { "content-type": "application/json", ...turn.headers });
        res.end(JSON.stringify({ error: { message: turn.errorMessage ?? "scripted provider failure" } }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "model-x", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

      if (turn.reasoning !== undefined) frame({ role: "assistant", reasoning_content: turn.reasoning });
      if (turn.text !== undefined) {
        frame({ role: "assistant" });
        frame({ content: turn.text });
      }
      if (turn.toolCall) {
        const { id: callId, name, args, partial } = turn.toolCall;
        frame({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: "" } }] });
        if (!partial) frame({ tool_calls: [{ index: 0, function: { arguments: args ?? "{}" } }] });
      }
      for (const [index, call] of (turn.toolCalls ?? []).entries()) {
        frame({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] });
        frame({ tool_calls: [{ index, function: { arguments: call.args ?? "{}" } }] });
      }
      if (turn.stall) {
        stalling += 1;
        const keepalive = setInterval(() => res.write(": keepalive\n\n"), 5000);
        res.on("close", () => {
          clearInterval(keepalive);
          stalling -= 1;
        });
        return;
      }
      if (turn.broken) {
        res.end();
        return;
      }
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "model-x", choices: [{ index: 0, delta: {}, finish_reason: turn.toolCall || turn.toolCalls ? "tool_calls" : "stop" }], usage })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    summaries,
    summarize: (answer) => (summaryAnswer = answer),
    stalled: () => stalling > 0,
    reset: (next) => {
      script = next;
      calls.length = 0;
      summaries.length = 0;
      summaryAnswer = {};
      seq = 0;
    },
    close: () => {
      server.closeAllConnections();
      return close(server);
    },
  };
}

// ─── the Custodian's address, answering for a killable Orchestrator ──────────

export type FakeSandbox = {
  url: string;
  /** The same Custodian on a Unix socket, as the control socket under `/run/jr2` is (ADR-0076). */
  socket: string;
  /** The same Custodian over HTTPS at jr2's own name (`https://custodian.jr2.internal:<port>`), its
   * TLS ended with a leaf of a test CA, as on the Fence (ADR-0059, ADR-0084). `fetch` trusts that
   * CA alone and looks jr2's name up as the loopback: what the Harness's `controlFetch` does in a
   * pod, with the pod's CA and the slot's resolver. */
  https: { url: string; fetch: typeof globalThis.fetch; ca: string; lookup: LookupFunction };
  /** What the next surface read serves — a Machine state change, or a guard that changed its
   * answer, between two Submissions (ADR-0029: the Allowed picks move, the Menu does not). */
  setSurface: (surface: Surface) => void;
  /** What a state exit does to the registration: every later surface read is a 404. */
  killSurface: () => void;
  reviveSurface: () => void;
  /**
   * What a BLIP does to it, which is a different claim (ADR-0026): a 404 means "this turn is
   * over", and the Harness settles it `aborted` without asking the model; anything else is a Menu
   * it could not read at all. Only this lever produces the second — the leg of a turn that runs
   * BEFORE the model is ever asked.
   */
  faultSurface: (status?: number) => void;
  /** A stopping Orchestrator (ADR-0026): the next `reads` surface reads answer 503, then it is
   * back — what a rollout looks like from the Harness. */
  stopFor: (reads: number) => void;
  /** Every pick delivered since the last `reset`, in order. */
  delivered: Array<Record<string, unknown>>;
  /** Every surface read since the last `reset`. */
  reads: () => number;
  /** Every bearer the Harness presented, in order — the Stand-in, never a token. */
  bearers: string[];
  /** Park every LATER delivery after recording it — the abort-mid-tool-call lever. */
  holdDeliveries: () => void;
  /** Answer each later delivery with this receipt — what an Orchestrator's Machine did with the
   * pick (`moved`, `turnComplete`, the Allowed picks after the route). Cleared by `reset`; unset,
   * every pick ends the Turn. */
  answerWith: (receipt: (event: Record<string, unknown>) => Record<string, unknown>) => void;
  /** Serve each later surface read by its number (1-based since the last `reset`): a surface, or
   * an HTTP status to answer instead (a promise: an answer that takes that long). Read 1 is a
   * Submission's start; each later read is a step boundary — so a test places a change made by
   * SOMETHING ELSE (a Gate's answer, an outside event) between two exact model answers. Wins over
   * `setSurface`; cleared by `reset`. */
  surfaceByRead: (serve: (read: number) => Surface | number | Promise<Surface | number>) => void;
  /** Answer each delivery poll (`GET /agents/:iid/deliveries/:id`, ADR-0024) by its number since
   * the last `reset`: a body, or an HTTP status (a promise: an answer that takes that long). Unset,
   * a poll is a 404. */
  pollWith: (serve: (poll: number, deliveryId: string) => unknown | Promise<unknown>) => void;
  /** Every delivery poll since the last `reset`, by delivery id. */
  polls: string[];
  /** The polls whose caller closed the connection before they were answered, since the last `reset`. */
  pollsGone: () => number;
  /** Each `POST /agents/:iid/notices` (ADR-0062): the ids it says were heard. */
  acks: string[][];
  /** The slot each request stated (`X-Jr2-Slot`, ADR-0076), in order. */
  slots: string[];
  /** Rearm for the next scenario: this surface, live, responding, nothing delivered. */
  reset: (surface: Surface) => void;
  close: () => Promise<void>;
};

export async function startFakeCustodian(initialSurface: Surface): Promise<FakeSandbox> {
  let surface = initialSurface;
  let live = true;
  let holding = false;
  let answer: ((event: Record<string, unknown>) => Record<string, unknown>) | undefined;
  let surfaceFault: number | undefined;
  let stopping = 0;
  let surfaceReads = 0;
  let byRead: ((read: number) => Surface | number | Promise<Surface | number>) | undefined;
  let byPoll: ((poll: number, deliveryId: string) => unknown | Promise<unknown>) | undefined;
  const polls: string[] = [];
  let pollsGone = 0;
  const delivered: Array<Record<string, unknown>> = [];
  const bearers: string[] = [];
  const acks: string[][] = [];
  const slots: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      bearers.push(req.headers.authorization ?? "");
      slots.push(String(req.headers["x-jr2-slot"] ?? ""));
      if (req.url?.endsWith("/surface")) surfaceReads += 1;
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!live) return json(404, { error: "no live agent surface" });
      if (req.url?.endsWith("/surface")) {
        if (surfaceFault !== undefined) return json(surfaceFault, { error: "scripted orchestrator failure" });
        if (stopping > 0) {
          stopping -= 1;
          return json(503, { error: "the Orchestrator is stopping" });
        }
        if (byRead) {
          void Promise.resolve(byRead(surfaceReads)).then((served) =>
            typeof served === "number" ? json(served, { error: "scripted" }) : json(200, served),
          );
          return;
        }
        return json(200, surface);
      }
      if (req.method === "POST" && req.url?.endsWith("/notices")) {
        acks.push((JSON.parse(raw) as { heard: string[] }).heard);
        res.writeHead(204);
        return res.end();
      }
      const poll = /\/deliveries\/([^/?]+)/.exec(req.url ?? "");
      if (poll) {
        polls.push(decodeURIComponent(poll[1]!));
        res.on("close", () => {
          if (!res.writableEnded) pollsGone += 1;
        });
        if (!byPoll) return json(404, { error: "no delivery" });
        void Promise.resolve(byPoll(polls.length, polls.at(-1)!)).then((served) =>
          typeof served === "number" ? json(served, { error: "scripted" }) : json(200, served),
        );
        return;
      }
      const event = JSON.parse(raw) as Record<string, unknown>;
      delivered.push(event);
      if (holding) return; // parked: the response never comes
      const deliveryId = `d-${delivered.length}`;
      if (answer) return json(200, { delivered: true, event: event.type, deliveryId, ...answer(event) });
      json(200, { delivered: true, event: event.type, turnComplete: true, deliveryId });
    });
  });
  const port = await listen(server);
  // The control socket (ADR-0076): one more listener, the same answers.
  const socket = join(mkdtempSync(join(tmpdir(), "jr2-custodian-")), "control.sock");
  const onSocket: Server = createServer((req, res) => server.emit("request", req, res));
  await new Promise<void>((resolve) => onSocket.listen(socket, resolve));
  // jr2's own name over HTTPS (ADR-0084): one more listener, the same answers.
  const tls = testTls(new URL(CUSTODIAN_URL).hostname);
  const onTls: TlsServer = createTlsServer({ cert: tls.cert, key: tls.key }, (req, res) =>
    server.emit("request", req, res),
  );
  const tlsPort = await listen(onTls as unknown as Server);
  return {
    url: `http://127.0.0.1:${port}`,
    socket,
    https: {
      url: `${CUSTODIAN_URL}:${tlsPort}`,
      fetch: controlFetch({ ca: tls.ca, lookup: loopbackLookup }),
      ca: tls.ca,
      lookup: loopbackLookup,
    },
    setSurface: (next) => (surface = next),
    killSurface: () => (live = false),
    reviveSurface: () => (live = true),
    faultSurface: (status = 500) => (surfaceFault = status),
    stopFor: (reads) => (stopping = reads),
    delivered,
    reads: () => surfaceReads,
    bearers,
    acks,
    slots,
    holdDeliveries: () => (holding = true),
    answerWith: (receipt) => (answer = receipt),
    surfaceByRead: (serve) => (byRead = serve),
    pollWith: (serve) => (byPoll = serve),
    polls,
    pollsGone: () => pollsGone,
    reset: (next) => {
      surface = next;
      live = true;
      holding = false;
      answer = undefined;
      byRead = undefined;
      byPoll = undefined;
      polls.length = 0;
      pollsGone = 0;
      surfaceFault = undefined;
      stopping = 0;
      surfaceReads = 0;
      delivered.length = 0;
      bearers.length = 0;
      acks.length = 0;
      slots.length = 0;
    },
    close: () => {
      onSocket.closeAllConnections();
      onSocket.close();
      onTls.closeAllConnections();
      onTls.close();
      server.closeAllConnections();
      return close(server);
    },
  };
}

// ─── a test CA ───────────────────────────────────────────────────────────────

/** A test CA and one leaf of it for `host` (one DNS SAN), made with `openssl` in the test's tmpdir:
 * ECDSA P-256, valid from an hour back to a day ahead. With `under`, the leaf is of that CA instead
 * of a new one.
 *
 * `notBefore` is an hour back, as held-pki.ts sets it, because the wall clock can step back: a
 * certificate that starts at the current second is "not yet valid" to a handshake after such a
 * step. OpenSSL 3.0 has no `-not_before`, so `openssl ca` signs both, with `-startdate`. */
export function testTls(
  host: string,
  under?: { ca: string; caKey: string },
): { ca: string; caKey: string; cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "jr2-test-ca-"));
  const f = (name: string) => join(dir, name);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  writeFileSync(f("index.txt"), "");
  writeFileSync(f("serial"), `${randomBytes(8).toString("hex").replace(/^./, "1")}\n`);
  writeFileSync(
    f("ca.cnf"),
    [
      "[ca]",
      "default_ca = test",
      "[test]",
      `database = ${f("index.txt")}`,
      `new_certs_dir = ${dir}`,
      `serial = ${f("serial")}`,
      "default_md = sha256",
      "policy = any",
      "unique_subject = no",
      "copy_extensions = none",
      "[any]",
      "commonName = supplied",
      "",
    ].join("\n"),
  );
  // `openssl ca` writes times as UTCTime: YYMMDDHHMMSSZ.
  const start = new Date(Date.now() - 3_600_000).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  const sign = (csr: string, ext: string, out: string, signer: string[]) => {
    writeFileSync(f(`${out}.ext`), ext);
    ssl(
      "ca",
      "-batch",
      "-config",
      f("ca.cnf"),
      "-notext",
      "-startdate",
      start,
      "-days",
      "1",
      ...signer,
      "-extfile",
      f(`${out}.ext`),
      "-in",
      f(csr),
      "-out",
      f(out),
    );
  };
  if (under) {
    writeFileSync(f("ca.crt"), under.ca);
    writeFileSync(f("ca.key"), under.caKey);
  } else {
    ssl("req", "-new", ...ec, "-keyout", f("ca.key"), "-out", f("ca.csr"), "-subj", "/CN=jr2 test CA");
    sign(
      "ca.csr",
      "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
      "ca.crt",
      ["-selfsign", "-keyfile", f("ca.key")],
    );
  }
  ssl("req", "-new", ...ec, "-keyout", f("leaf.key"), "-out", f("leaf.csr"), "-subj", `/CN=${host}`);
  sign(
    "leaf.csr",
    `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid\n`,
    "leaf.crt",
    ["-cert", f("ca.crt"), "-keyfile", f("ca.key")],
  );
  return {
    ca: readFileSync(f("ca.crt"), "utf8"),
    caKey: readFileSync(f("ca.key"), "utf8"),
    cert: readFileSync(f("leaf.crt"), "utf8"),
    key: readFileSync(f("leaf.key"), "utf8"),
  };
}

/** A lookup that answers every name with the loopback: the slot's resolver, for a test. */
export const loopbackLookup: LookupFunction = (_hostname, options, callback) => {
  if ((options as { all?: boolean }).all) {
    (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
      { address: "127.0.0.1", family: 4 },
    ]);
  } else callback(null, "127.0.0.1", 4);
};

// ─── small helpers ───────────────────────────────────────────────────────────

/** Poll until `predicate` holds. The three processes settle on their own clocks. */
export async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Sever every idle keep-alive socket `fetch`'s global dispatcher holds — the Menu's and pi's
 * provider sockets. Teardown-only (fetch is dead afterwards): without it a fake's `close` waits out
 * the server's keep-alive timeout on sockets nothing will reuse. The
 * dispatcher has no public accessor; Node parks it on this well-known symbol.
 */
export async function severKeepAliveSockets(): Promise<void> {
  const dispatcher = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("undici.globalDispatcher.1")] as
    | { destroy?: () => Promise<void> }
    | undefined;
  await dispatcher?.destroy?.();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
