// The resolver of a Custodian pod (ADR-0084): it answers each DNS query of a Harness pod, from the
// slot's resolver table (`ResolverTable`, `custodian-rules.ts`), which the control process sets once
// Envoy carries that version of the slot's rules (`custodian-control.ts`). It runs in the `control`
// process. The uplink sends each query of slot i, whatever server the pod named, to port
// `SLOT_RESOLVER_BASE + i`, UDP and TCP: the port, not a source address, names the slot.
//
// What it answers, for the question's name (case-blind; the question goes back as it came):
//
//   a name of the table          A: its placeholder address (TTL 60). ANY: the same. Another type:
//                                NODATA (no answer, an SOA), at once, so a client that asks AAAA
//                                first does not wait
//   a placeholder's reverse name PTR: the exact name that has that address
//   `_rules.custodian.jr2.internal`  TXT: the version of the slot's rules
//   each other name              NXDOMAIN, with an SOA, and one refusal line
//   a slot with no table         REFUSED, and one refusal line
//
// An exact name of the table matches itself; `*.<domain>` matches each name below the domain; `*`
// matches each name. A wildcard never matches a name of jr2's own domain or a reverse name. EDNS0 is
// answered (version 0, no option); another version gets BADVERS.
//
// It asks no server: nothing in this module sends a query on. A log line names the slot, the Harness
// pod, the name (each byte outside a host name's letters printed as `\ddd`) and the reason. A slot
// writes at most `REFUSAL_LINES` such lines a second, and then one line with the count of the others.

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import type { ResolverName, ResolverTable } from "./custodian-rules.ts";
import { FENCE_SLOTS, JR2_CUSTODIAN_NAME, SLOT_RESOLVER_BASE } from "./custodian.ts";
import { JR2_NAME_DOMAIN } from "./egress.ts";

/** The TTL of each answer, and of a refusal's SOA (ADR-0084). */
export const RESOLVER_TTL = 60;
/** The name whose TXT is the version of the slot's rules: a check that the resolver serves them. */
export const RULES_NAME = `_rules.${JR2_CUSTODIAN_NAME}`;
/** The largest UDP answer the resolver sends, whatever a client offers (the DNS flag day size). */
export const RESOLVER_UDP_SIZE = 1232;
/** The TCP connections that one slot's resolver holds at once, and how long one may be idle. */
export const RESOLVER_TCP_CONNECTIONS = 16;
const TCP_IDLE_MS = 10_000;
/** The refusal lines that one slot writes in one second; the others are counted (`refusalLog`). */
export const REFUSAL_LINES = 20;

/** The resolver tables that it answers from: the control process's (`resolverTables`). */
export type ResolverSource = { get(slot: number): ResolverTable | undefined };

/** What the resolver says to one query: the reply (none for a message it does not answer), and the
 * refusal line's fields when it refused. */
export type ResolverAnswer = { reply?: Buffer; refusal?: { name: string; type: string; reason: string } };

// ---- the wire (RFC 1035, RFC 6891) ----------------------------------------------------------------

const TYPE = { A: 1, NS: 2, SOA: 6, PTR: 12, TXT: 16, AAAA: 28, OPT: 41, IXFR: 251, AXFR: 252, ANY: 255 } as const;
const CLASS_IN = 1;
const CLASS_ANY = 255;
const RCODE = { NOERROR: 0, FORMERR: 1, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;
/** BADVERS (RFC 6891): an extended rcode, 16, of which the OPT record carries the upper 8 bits. */
const BADVERS_HIGH = 1;
const TYPE_TEXT: Record<number, string> = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
const SOA_TEXT = { mname: JR2_CUSTODIAN_NAME, rname: `hostmaster.${JR2_CUSTODIAN_NAME}` };

type Question = {
  /** The question as it came: its name, type and class, so the answer keeps the name's case. */
  raw: Buffer;
  labels: Buffer[];
  type: number;
  klass: number;
};
type Edns = { size: number; version: number };

class FormatError extends Error {}

/** The labels of a name at `at`, and the offset after it. No compression: a question holds none. */
function readName(msg: Buffer, at: number): { labels: Buffer[]; end: number } {
  const labels: Buffer[] = [];
  let length = 0;
  for (;;) {
    if (at >= msg.length) throw new FormatError("the name runs past the message");
    const n = msg[at]!;
    if (n === 0) return { labels, end: at + 1 };
    if (n > 63) throw new FormatError("a label is compressed or longer than 63 bytes");
    if (at + 1 + n > msg.length) throw new FormatError("a label runs past the message");
    length += n + 1;
    if (length > 254) throw new FormatError("the name is longer than 255 bytes");
    labels.push(msg.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
}

/** A name as the table and the log write it: lowercase, labels joined by dots, and each byte
 * outside letters, digits, `-` and `_` printed as `\ddd`, so a line cannot carry another field. */
export function nameText(labels: readonly Buffer[]): string {
  if (labels.length === 0) return ".";
  return labels
    .map((label) =>
      [...label]
        .map((b) => {
          const c = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
          const ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x5f;
          return ok ? String.fromCharCode(c) : `\\${String(c).padStart(3, "0")}`;
        })
        .join(""),
    )
    .join(".");
}

function encodeName(name: string): Buffer {
  if (name === ".") return Buffer.from([0]);
  const parts = name.split(".").map((l) => Buffer.from(l, "ascii"));
  return Buffer.concat([...parts.flatMap((p) => [Buffer.from([p.length]), p]), Buffer.from([0])]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/** One resource record: its owner (encoded), type, class, TTL and data. */
function record(owner: Buffer, type: number, klass: number, ttl: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(klass, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, head, data]);
}

/** A pointer to the question's name, at offset 12: an answer's owner, in the question's own case. */
const QUESTION_NAME = Buffer.from([0xc0, 0x0c]);

function soa(owner: Buffer): Buffer {
  const counts = Buffer.alloc(20);
  counts.writeUInt32BE(1, 0); // serial
  for (let i = 1; i < 5; i++) counts.writeUInt32BE(RESOLVER_TTL, i * 4); // refresh, retry, expire, minimum
  const data = Buffer.concat([encodeName(SOA_TEXT.mname), encodeName(SOA_TEXT.rname), counts]);
  return record(owner, TYPE.SOA, CLASS_IN, RESOLVER_TTL, data);
}

function ipv4(address: string): Buffer {
  return Buffer.from(address.split(".").map(Number));
}

function opt(badvers: boolean): Buffer {
  // Owner `.`, the size this resolver takes, extended rcode and version 0, no flags, no option.
  return record(Buffer.from([0]), TYPE.OPT, RESOLVER_UDP_SIZE, badvers ? BADVERS_HIGH << 24 : 0, Buffer.alloc(0));
}

type Reply = {
  id: number;
  rd: boolean;
  rcode: number;
  question?: Question;
  answers?: Buffer[];
  authority?: Buffer[];
  edns?: Edns;
  badvers?: boolean;
};

function message(r: Reply, limit: number): Buffer {
  const build = (answers: Buffer[], authority: Buffer[], tc: boolean): Buffer => {
    const extra = r.edns ? [opt(r.badvers ?? false)] : [];
    const head = Buffer.alloc(12);
    head.writeUInt16BE(r.id, 0);
    // QR, opcode 0, AA (the resolver is the only authority a pod has), TC, RD as asked; RA 0.
    head[2] = 0x80 | 0x04 | (tc ? 0x02 : 0) | (r.rd ? 0x01 : 0);
    head[3] = r.rcode & 0x0f;
    head.writeUInt16BE(r.question ? 1 : 0, 4);
    head.writeUInt16BE(answers.length, 6);
    head.writeUInt16BE(authority.length, 8);
    head.writeUInt16BE(extra.length, 10);
    return Buffer.concat([head, ...(r.question ? [r.question.raw] : []), ...answers, ...authority, ...extra]);
  };
  const whole = build(r.answers ?? [], r.authority ?? [], false);
  // Truncated: the question alone, with TC, so the client asks again over TCP.
  return whole.length <= limit ? whole : build([], [], true);
}

// ---- the answer -----------------------------------------------------------------------------------

/** The table's row for `name` (lowercase): an exact name first, then the longest `*.` domain, then
 * `*`. A wildcard never covers jr2's own domain or a reverse name. */
function rowOf(table: ResolverTable, name: string): ResolverName | undefined {
  const exact = table.names.find((n) => n.match === "name" && n.name === name);
  if (exact) return exact;
  if (name === "." || inDomain(name, JR2_NAME_DOMAIN) || inDomain(name, "arpa")) return undefined;
  const below = table.names
    .filter((n) => n.match === "below" && name.endsWith(n.name.slice(1)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return below ?? table.names.find((n) => n.match === "any");
}

function inDomain(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`);
}

/** The address of a reverse name `d.c.b.a.in-addr.arpa`, or undefined. */
function reverseAddress(name: string): string | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.in-addr\.arpa$/.exec(name);
  if (!m || m.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith("0")))) return undefined;
  return [m[4], m[3], m[2], m[1]].join(".");
}

/**
 * The resolver's answer to one query of a slot, from its table (undefined: the slot has no rules).
 * `transport` sets the size: a UDP answer is at most 512 bytes, or what the client offers in its
 * OPT record up to {@link RESOLVER_UDP_SIZE}; a larger one is truncated. Pure.
 */
export function resolverAnswer(
  table: ResolverTable | undefined,
  query: Buffer,
  transport: "udp" | "tcp",
): ResolverAnswer {
  // A message too short for a header, or a reply, gets no answer: there is no one to answer.
  if (query.length < 12 || (query[2]! & 0x80) !== 0) return {};
  const id = query.readUInt16BE(0);
  const rd = (query[2]! & 0x01) !== 0;
  const opcode = (query[2]! >> 3) & 0x0f;
  const base = { id, rd };
  const refuse = (rcode: number, reason: string, q?: Question, edns?: Edns): ResolverAnswer => ({
    reply: message({ ...base, rcode, ...(q ? { question: q } : {}), ...(edns ? { edns } : {}) }, 512),
    refusal: { name: q ? nameText(q.labels) : "-", type: q ? typeText(q.type) : "-", reason },
  });

  let question: Question;
  let edns: Edns | undefined;
  try {
    if (query.readUInt16BE(4) !== 1) throw new FormatError("a query has one question");
    if (query.readUInt16BE(6) !== 0 || query.readUInt16BE(8) !== 0) throw new FormatError("a query has no answer");
    const { labels, end } = readName(query, 12);
    if (end + 4 > query.length) throw new FormatError("the question runs past the message");
    question = {
      raw: query.subarray(12, end + 4),
      labels,
      type: query.readUInt16BE(end),
      klass: query.readUInt16BE(end + 2),
    };
    edns = readEdns(query, end + 4, query.readUInt16BE(10));
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    return refuse(RCODE.FORMERR, "form");
  }
  if (opcode !== 0) return refuse(RCODE.NOTIMP, "opcode", question, edns);
  if (edns && edns.version !== 0) {
    return { reply: message({ ...base, rcode: 0, question, edns, badvers: true }, 512) };
  }
  const limit = transport === "tcp" ? 65_535 : edns ? Math.min(Math.max(edns.size, 512), RESOLVER_UDP_SIZE) : 512;
  const reply = (r: Omit<Reply, "id" | "rd" | "question" | "edns">): Buffer =>
    message({ ...base, question, ...(edns ? { edns } : {}), ...r }, limit);

  if (table === undefined) return refuse(RCODE.REFUSED, "no-rules", question, edns);
  if (question.klass !== CLASS_IN && question.klass !== CLASS_ANY) {
    return refuse(RCODE.REFUSED, "class", question, edns);
  }
  if (question.type === TYPE.AXFR || question.type === TYPE.IXFR) {
    return refuse(RCODE.REFUSED, "transfer", question, edns);
  }

  const name = nameText(question.labels);
  const nodata = (): ResolverAnswer => ({ reply: reply({ rcode: RCODE.NOERROR, authority: [soa(QUESTION_NAME)] }) });

  if (name === RULES_NAME) {
    if (question.type !== TYPE.TXT && question.type !== TYPE.ANY) return nodata();
    const text = Buffer.from(table.version, "ascii");
    const txt = record(QUESTION_NAME, TYPE.TXT, CLASS_IN, 0, Buffer.concat([Buffer.from([text.length]), text]));
    return { reply: reply({ rcode: RCODE.NOERROR, answers: [txt] }) };
  }

  const reverse = reverseAddress(name);
  const named =
    reverse === undefined ? undefined : table.names.find((n) => n.match === "name" && n.address === reverse);
  if (named) {
    if (question.type !== TYPE.PTR && question.type !== TYPE.ANY) return nodata();
    const ptr = record(QUESTION_NAME, TYPE.PTR, CLASS_IN, RESOLVER_TTL, encodeName(named.name));
    return { reply: reply({ rcode: RCODE.NOERROR, answers: [ptr] }) };
  }

  const row = rowOf(table, name);
  if (row === undefined) {
    return {
      reply: reply({ rcode: RCODE.NXDOMAIN, authority: [soa(Buffer.from([0]))] }),
      refusal: { name, type: typeText(question.type), reason: "no-entry" },
    };
  }
  if (question.type !== TYPE.A && question.type !== TYPE.ANY) return nodata();
  const a = record(QUESTION_NAME, TYPE.A, CLASS_IN, RESOLVER_TTL, ipv4(row.address));
  return { reply: reply({ rcode: RCODE.NOERROR, answers: [a] }) };
}

/** The query's OPT record, if it has one, from the additional section at `at`. */
function readEdns(msg: Buffer, at: number, count: number): Edns | undefined {
  let edns: Edns | undefined;
  for (let i = 0; i < count; i++) {
    const { labels, end } = readName(msg, at);
    if (end + 10 > msg.length) throw new FormatError("a record runs past the message");
    const type = msg.readUInt16BE(end);
    const length = msg.readUInt16BE(end + 8);
    if (end + 10 + length > msg.length) throw new FormatError("a record's data runs past the message");
    if (type === TYPE.OPT) {
      if (edns || labels.length !== 0) throw new FormatError("one OPT record, owned by the root");
      edns = { size: msg.readUInt16BE(end + 2), version: msg[end + 5]! };
    }
    at = end + 10 + length;
  }
  return edns;
}

function typeText(type: number): string {
  return TYPE_TEXT[type] ?? `TYPE${type}`;
}

// ---- the server -----------------------------------------------------------------------------------

export type CustodianResolverOptions = {
  tables: ResolverSource;
  log?: (line: string) => void;
  /** The address each socket binds. Default `0.0.0.0`: the pod's rule set admits only the uplink's
   * map to these ports. */
  host?: string;
  /** The slots it serves. Default: each slot of the range. */
  slots?: readonly number[];
  /** The port of a slot. Default `SLOT_RESOLVER_BASE + slot`; 0 takes a free port (tests). */
  port?: (slot: number) => number;
};

export type CustodianResolver = {
  /** Binds the UDP and the TCP socket of each slot. Throws when one cannot be bound. */
  listen(): Promise<void>;
  /** The bound ports of a slot. */
  ports(slot: number): { udp: number; tcp: number };
  close(): Promise<void>;
};

/** The resolver of a Custodian pod: one UDP and one TCP socket for each slot. */
export function custodianResolver(opts: CustodianResolverOptions): CustodianResolver {
  const log = opts.log ?? ((line: string) => console.log(line));
  const host = opts.host ?? "0.0.0.0";
  const slots = opts.slots ?? Array.from({ length: FENCE_SLOTS }, (_, i) => i);
  const portOf = opts.port ?? ((slot: number) => SLOT_RESOLVER_BASE + slot);
  const udp = new Map<number, UdpSocket>();
  const tcp = new Map<number, Server>();
  const open = new Set<Socket>();
  const refusals = refusalLog(log);
  let second: ReturnType<typeof setInterval> | undefined;

  const answer = (slot: number, query: Buffer, transport: "udp" | "tcp"): Buffer | undefined => {
    const table = opts.tables.get(slot);
    const a = resolverAnswer(table, query, transport);
    if (a.refusal) {
      const r = a.refusal;
      refusals.refuse(slot, table?.owner, `name=${r.name} type=${r.type} reason=${r.reason}`);
    }
    return a.reply;
  };

  const serveUdp = (slot: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = createSocket("udp4");
      socket.on("message", (msg, from) => {
        const reply = answer(slot, msg, "udp");
        if (reply) socket.send(reply, from.port, from.address);
      });
      socket.once("error", reject);
      socket.bind(portOf(slot), host, () => {
        socket.off("error", reject);
        // A send that fails (the pod went) loses one answer; the client asks again.
        socket.on("error", () => {});
        udp.set(slot, socket);
        resolve();
      });
    });

  const serveTcp = (slot: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const server = createServer((conn) => {
        open.add(conn);
        conn.once("close", () => open.delete(conn));
        tcpConnection(conn, (q) => answer(slot, q, "tcp"));
      });
      server.maxConnections = RESOLVER_TCP_CONNECTIONS;
      server.once("error", reject);
      server.listen(portOf(slot), host, () => {
        server.off("error", reject);
        tcp.set(slot, server);
        resolve();
      });
    });

  return {
    async listen() {
      for (const slot of slots) {
        await serveUdp(slot);
        await serveTcp(slot);
      }
      second = setInterval(() => refusals.second(), 1000);
      second.unref();
    },
    ports(slot) {
      const u = udp.get(slot)?.address();
      const t = tcp.get(slot)?.address();
      if (!u || !t || typeof t === "string") throw new Error(`the resolver of slot ${slot} is not bound`);
      return { udp: u.port, tcp: t.port };
    },
    async close() {
      clearInterval(second);
      refusals.second();
      for (const s of udp.values()) s.close();
      const closed = [...tcp.values()].map((s) => new Promise<void>((resolve) => s.close(() => resolve())));
      for (const conn of open) conn.destroy();
      await Promise.all(closed);
      udp.clear();
      tcp.clear();
    },
  };
}

/** The refusal lines of the resolver, with a bound for each slot: at most `REFUSAL_LINES` lines in
 * one second. Each refusal above the bound is counted, and `second()` (called each second) writes one
 * line with the count (`suppressed=N`) for each slot that had one. So one Sandbox that asks for many
 * names fills the log with at most `REFUSAL_LINES + 1` lines a second, and the lines of the other
 * slots and of the control process stay in it. */
export function refusalLog(log: (line: string) => void): {
  refuse(slot: number, owner: string | undefined, fields: string): void;
  second(): void;
} {
  const slots = new Map<number, { lines: number; suppressed: number; owner: string | undefined }>();
  const head = (slot: number, owner: string | undefined) =>
    `jr2.custodian dns action=refuse slot=${slot}${owner ? ` ${owner}` : ""}`;
  return {
    refuse(slot, owner, fields) {
      let s = slots.get(slot);
      if (!s) slots.set(slot, (s = { lines: 0, suppressed: 0, owner }));
      s.owner = owner;
      if (s.lines < REFUSAL_LINES) {
        s.lines++;
        log(`${head(slot, owner)} ${fields}`);
      } else {
        s.suppressed++;
      }
    },
    second() {
      for (const [slot, s] of slots) {
        if (s.suppressed > 0) log(`${head(slot, s.owner)} suppressed=${s.suppressed}`);
      }
      slots.clear();
    },
  };
}

/** One TCP connection: each message has a 2-byte length (RFC 1035 4.2.2), and each query gets its
 * answer in order. A connection idle for 10 s, or one that sends a message the resolver does not
 * answer, is closed.
 *
 * A client that does not read its answers stops being read: when the socket's buffer is full, the
 * connection pauses, and the queries of the last chunk wait until the client reads. So one
 * connection holds at most one chunk of queries and one buffer of answers, and the kernel's window
 * stops the client's next queries. A paused connection has no activity, so the idle limit closes it. */
function tcpConnection(conn: Socket, answer: (query: Buffer) => Buffer | undefined): void {
  conn.setTimeout(TCP_IDLE_MS, () => conn.destroy());
  conn.on("error", () => conn.destroy());
  const frames = tcpFrames();
  let queries: Buffer[] = [];
  let next = 0;
  const pump = (): void => {
    while (next < queries.length) {
      const reply = answer(queries[next++]!);
      if (!reply) {
        conn.destroy();
        return;
      }
      if (!conn.write(Buffer.concat([u16(reply.length), reply]))) {
        conn.pause();
        return; // 'drain' calls pump again
      }
    }
    queries = [];
    next = 0;
    if (conn.isPaused()) conn.resume();
  };
  conn.on("data", (chunk: Buffer) => {
    for (const query of frames(chunk)) queries.push(query);
    if (!conn.writableNeedDrain) pump();
  });
  conn.on("drain", pump);
}

/** The DNS messages in a TCP stream, chunk by chunk: each chunk gives the messages it completes. */
export function tcpFrames(): (chunk: Buffer) => Buffer[] {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const out: Buffer[] = [];
    while (pending.length >= 2) {
      const length = pending.readUInt16BE(0);
      if (pending.length < 2 + length) break;
      out.push(pending.subarray(2, 2 + length));
      pending = pending.subarray(2 + length);
    }
    return out;
  };
}
