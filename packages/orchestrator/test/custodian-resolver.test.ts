// The resolver of a Custodian pod (ADR-0084), at the packet level: the answer to each query is a pure
// function of the slot's table, and some tests serve it on the loopback and ask it with Node's own
// stub resolver (c-ares) over UDP and with framed queries over TCP.

import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { connect, Server } from "node:net";
import { test } from "node:test";
import { renderSlot, type ResolverTable } from "../src/custodian-rules.ts";
import {
  custodianResolver,
  nameText,
  REFUSAL_LINES,
  refusalLog,
  resolverAnswer,
  RESOLVER_TCP_CONNECTIONS,
  RESOLVER_TCP_QUERIES,
  RESOLVER_UDP_SIZE,
  RULES_NAME,
  tcpConnection,
  tcpFrames,
  udpAnswer,
  type ResolverConn,
} from "../src/custodian-resolver.ts";
import { resolverTables } from "../src/custodian-control.ts";
import { JR2_CUSTODIAN_NAME } from "../src/custodian.ts";
import { inputsOf, rule, SANDBOX_MANIFEST } from "./_custodian-slots.ts";

const TABLE: ResolverTable = {
  slot: 3,
  version: "0123456789abcdef",
  owner: "sandbox=ws-3",
  names: [
    { name: JR2_CUSTODIAN_NAME, match: "name", address: "198.18.0.1" },
    { name: "github.com", match: "name", address: "198.18.0.2" },
    { name: "*.example.com", match: "below", address: "198.18.0.3" },
    { name: "*.deep.example.com", match: "below", address: "198.18.0.4" },
  ],
};
const ANY: ResolverTable = {
  slot: 5,
  version: "fedcba9876543210",
  owner: "pod=check-1",
  names: [
    { name: JR2_CUSTODIAN_NAME, match: "name", address: "198.18.0.1" },
    { name: "*", match: "any", address: "198.18.0.2" },
  ],
};

const T = { A: 1, NS: 2, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, OPT: 41, HTTPS: 65, AXFR: 252, ANY: 255 };

// ---- a small client: a query, and the parts of an answer -------------------------------------------

type QueryOptions = {
  id?: number;
  type?: number;
  klass?: number;
  opcode?: number;
  edns?: { size: number; version?: number };
};

function nameBytes(name: string): Buffer {
  const labels = name === "." ? [] : name.split(".").map((l) => Buffer.from(l, "latin1"));
  return Buffer.concat([...labels.flatMap((l) => [Buffer.from([l.length]), l]), Buffer.from([0])]);
}

function query(name: string | Buffer, o: QueryOptions = {}): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(o.id ?? 0x1234, 0);
  head[2] = ((o.opcode ?? 0) << 3) | 0x01; // RD
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(o.edns ? 1 : 0, 10);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(o.type ?? T.A, 0);
  tail.writeUInt16BE(o.klass ?? 1, 2);
  const opt = o.edns
    ? (() => {
        const b = Buffer.alloc(11);
        b.writeUInt16BE(T.OPT, 1);
        b.writeUInt16BE(o.edns!.size, 3);
        b[6] = o.edns!.version ?? 0;
        return b;
      })()
    : Buffer.alloc(0);
  return Buffer.concat([head, typeof name === "string" ? nameBytes(name) : name, tail, opt]);
}

type Rr = { owner: string; type: number; klass: number; ttl: number; data: Buffer; at: number };
type Parsed = {
  id: number;
  flags: { qr: boolean; aa: boolean; tc: boolean; rd: boolean; ra: boolean };
  rcode: number;
  question?: { name: Buffer; type: number };
  answers: Rr[];
  authority: Rr[];
  additional: Rr[];
};

/** A name at `at`, with compression, as text; and where the name ends in place. */
function readName(msg: Buffer, at: number): { text: string; end: number } {
  const labels: string[] = [];
  let end = -1;
  for (let hops = 0; hops < 20; hops++) {
    const n = msg[at]!;
    if (n === 0) return { text: labels.join(".") || ".", end: end === -1 ? at + 1 : end };
    if ((n & 0xc0) === 0xc0) {
      if (end === -1) end = at + 2;
      at = msg.readUInt16BE(at) & 0x3fff;
      continue;
    }
    labels.push(msg.subarray(at + 1, at + 1 + n).toString("latin1"));
    at += 1 + n;
  }
  throw new Error("a loop of pointers");
}

function parse(msg: Buffer): Parsed {
  const counts = [4, 6, 8, 10].map((o) => msg.readUInt16BE(o));
  let at = 12;
  let question: Parsed["question"];
  if (counts[0] === 1) {
    const { end } = readName(msg, at);
    question = { name: msg.subarray(at, end), type: msg.readUInt16BE(end) };
    at = end + 4;
  }
  const section = (n: number): Rr[] => {
    const out: Rr[] = [];
    for (let i = 0; i < n; i++) {
      const { text, end } = readName(msg, at);
      const length = msg.readUInt16BE(end + 8);
      out.push({
        owner: text,
        type: msg.readUInt16BE(end),
        klass: msg.readUInt16BE(end + 2),
        ttl: msg.readUInt32BE(end + 4),
        data: msg.subarray(end + 10, end + 10 + length),
        at: end + 10,
      });
      at = end + 10 + length;
    }
    return out;
  };
  const answers = section(counts[1]!);
  const authority = section(counts[2]!);
  const additional = section(counts[3]!);
  assert.equal(at, msg.length, "the message ends where its records end");
  return {
    id: msg.readUInt16BE(0),
    flags: {
      qr: (msg[2]! & 0x80) !== 0,
      aa: (msg[2]! & 0x04) !== 0,
      tc: (msg[2]! & 0x02) !== 0,
      rd: (msg[2]! & 0x01) !== 0,
      ra: (msg[3]! & 0x80) !== 0,
    },
    rcode: msg[3]! & 0x0f,
    ...(question ? { question } : {}),
    answers,
    authority,
    additional,
  };
}

const ask = (table: ResolverTable | undefined, name: string | Buffer, o: QueryOptions = {}) => {
  const q = query(name, o);
  const a = resolverAnswer(table, q, "udp");
  return { ...a, q, p: a.reply ? parse(a.reply) : undefined };
};
const address = (rr: Rr) => [...rr.data].join(".");

// ---- the answers --------------------------------------------------------------------------------

test("a name of the table: A with its placeholder (TTL 60), authoritative, the ID and the question's case kept, no refusal", () => {
  const { p, q, refusal } = ask(TABLE, "GitHub.COM", { id: 0xbeef });
  assert.equal(refusal, undefined);
  assert.equal(p!.id, 0xbeef);
  assert.deepEqual(p!.flags, { qr: true, aa: true, tc: false, rd: true, ra: false });
  assert.equal(p!.rcode, 0);
  assert.deepEqual(p!.question!.name, q.subarray(12, q.length - 4), "the question goes back byte for byte");
  assert.equal(p!.answers.length, 1);
  const [a] = p!.answers;
  assert.equal(a!.owner, "GitHub.COM", "the answer's owner is the question's name, in its case");
  assert.deepEqual([a!.type, a!.klass, a!.ttl, address(a!)], [T.A, 1, 60, "198.18.0.2"]);
  assert.equal(p!.authority.length, 0);
  // ANY gets the same address.
  assert.equal(address(ask(TABLE, "github.com", { type: T.ANY }).p!.answers[0]!), "198.18.0.2");
  // jr2's own name.
  assert.equal(address(ask(TABLE, JR2_CUSTODIAN_NAME).p!.answers[0]!), "198.18.0.1");
});

test("another type of a listed name gets NODATA at once: no answer and an SOA, never a refusal", () => {
  for (const type of [T.AAAA, T.MX, T.TXT, T.HTTPS, T.NS, T.SOA]) {
    const { p, refusal } = ask(TABLE, "github.com", { type });
    assert.equal(p!.rcode, 0, `type ${type}`);
    assert.equal(p!.answers.length, 0);
    assert.equal(p!.authority.length, 1);
    assert.equal(p!.authority[0]!.type, T.SOA);
    assert.equal(p!.authority[0]!.owner, "github.com");
    assert.equal(refusal, undefined);
  }
});

test("each other name gets NXDOMAIN with an SOA and one refusal with the name, its type and the reason", () => {
  for (const name of ["gitlab.com", "x.github.com", "example.com", "a.custodian.jr2.internal", "jr2.internal"]) {
    const { p, refusal } = ask(TABLE, name, { type: T.AAAA });
    assert.equal(p!.rcode, 3, name);
    assert.equal(p!.answers.length, 0);
    assert.equal(p!.authority[0]!.type, T.SOA);
    assert.deepEqual(refusal, { name, type: "AAAA", reason: "no-entry" });
  }
  // A random label under a listed exact name is refused too: an exact entry is one name.
  assert.equal(ask(TABLE, `r${Date.now()}.github.com`).p!.rcode, 3);
});

test("a `*.` row answers each name below its domain, the longest domain first, and never the domain itself", () => {
  assert.equal(address(ask(TABLE, "www.example.com").p!.answers[0]!), "198.18.0.3");
  assert.equal(address(ask(TABLE, "a.b.example.com").p!.answers[0]!), "198.18.0.3");
  assert.equal(address(ask(TABLE, "x.deep.example.com").p!.answers[0]!), "198.18.0.4");
  assert.equal(ask(TABLE, "notexample.com").p!.rcode, 3);
});

test("a `*` row answers each name, but never another name of jr2's domain, a reverse name or the root", () => {
  assert.equal(address(ask(ANY, "anything.test").p!.answers[0]!), "198.18.0.2");
  assert.equal(address(ask(ANY, "custodian.jr2.internal").p!.answers[0]!), "198.18.0.1");
  for (const name of ["other.jr2.internal", "8.8.8.8.in-addr.arpa", "1.0.0.0.ip6.arpa", "."]) {
    const { p, refusal } = ask(ANY, name, { type: name.endsWith("arpa") ? T.PTR : T.A });
    assert.equal(p!.rcode, 3, name);
    assert.equal(refusal!.reason, "no-entry");
  }
});

test("PTR of a placeholder gives the exact name that has it; a wildcard's placeholder and another address are refused", () => {
  const ptr = (name: string) => ask(TABLE, name, { type: T.PTR });
  const github = ptr("2.0.18.198.in-addr.arpa").p!;
  assert.equal(github.rcode, 0);
  assert.equal(github.answers[0]!.type, T.PTR);
  assert.equal(
    readName(ask(TABLE, "2.0.18.198.in-addr.arpa", { type: T.PTR }).reply!, github.answers[0]!.at).text,
    "github.com",
  );
  const own = ptr("1.0.18.198.in-addr.arpa");
  assert.equal(readName(own.reply!, own.p!.answers[0]!.at).text, JR2_CUSTODIAN_NAME);
  // The A of a placeholder's reverse name: NODATA.
  assert.equal(ask(TABLE, "2.0.18.198.in-addr.arpa").p!.answers.length, 0);
  assert.equal(ask(TABLE, "2.0.18.198.in-addr.arpa").p!.rcode, 0);
  for (const name of ["3.0.18.198.in-addr.arpa", "5.0.19.198.in-addr.arpa", "02.0.18.198.in-addr.arpa"]) {
    assert.equal(ptr(name).p!.rcode, 3, name);
  }
});

test("the TXT of `_rules.custodian.jr2.internal` is the version of the slot's rules, never cached", () => {
  const { p, refusal } = ask(TABLE, RULES_NAME, { type: T.TXT });
  assert.equal(refusal, undefined);
  const [txt] = p!.answers;
  assert.equal(txt!.type, T.TXT);
  assert.equal(txt!.ttl, 0);
  assert.equal(txt!.data.subarray(1).toString(), TABLE.version);
  assert.equal(txt!.data[0], TABLE.version.length);
  assert.equal(ask(TABLE, RULES_NAME).p!.rcode, 0, "A of the name: NODATA");
  assert.equal(ask(TABLE, RULES_NAME).p!.answers.length, 0);
});

test("a slot with no table gets REFUSED and a refusal line's reason; so does a class other than IN and a zone transfer", () => {
  const none = ask(undefined, "github.com");
  assert.equal(none.p!.rcode, 5);
  assert.deepEqual(none.refusal, { name: "github.com", type: "A", reason: "no-rules" });
  assert.equal(none.p!.question!.type, T.A);
  assert.equal(ask(TABLE, "version.bind", { type: T.TXT, klass: 3 }).refusal!.reason, "class");
  assert.equal(ask(TABLE, "github.com", { type: T.AXFR }).p!.rcode, 5);
});

test("EDNS0: an OPT record is answered with version 0 and the resolver's size; another version gets BADVERS", () => {
  const { p } = ask(TABLE, "github.com", { edns: { size: 4096 } });
  assert.equal(p!.additional.length, 1);
  const [opt] = p!.additional;
  assert.deepEqual(
    [opt!.owner, opt!.type, opt!.klass, opt!.ttl, opt!.data.length],
    [".", T.OPT, RESOLVER_UDP_SIZE, 0, 0],
  );
  assert.equal(address(p!.answers[0]!), "198.18.0.2");
  const bad = ask(TABLE, "github.com", { edns: { size: 1232, version: 1 } }).p!;
  assert.equal(bad.answers.length, 0);
  assert.equal(bad.additional[0]!.ttl >>> 24, 1, "extended rcode 16 = BADVERS");
  // No OPT in the query: none in the answer.
  assert.equal(ask(TABLE, "github.com").p!.additional.length, 0);
});

test("a message that is not one query: FORMERR, NOTIMP, or no answer at all", () => {
  // Too short, and a reply (QR set): nothing.
  assert.equal(resolverAnswer(TABLE, Buffer.alloc(11), "udp").reply, undefined);
  const reply = query("github.com");
  reply[2]! |= 0x80;
  assert.equal(resolverAnswer(TABLE, reply, "udp").reply, undefined);
  // Two questions; a name that runs past the end; a compressed name in the question.
  const two = query("github.com");
  two.writeUInt16BE(2, 4);
  const short = query("github.com").subarray(0, 18);
  const pointer = query(Buffer.from([0xc0, 0x0c]));
  for (const q of [two, short, pointer]) {
    const a = resolverAnswer(TABLE, q, "udp");
    const p = parse(a.reply!);
    assert.equal(p.rcode, 1);
    assert.equal(p.question, undefined);
    assert.equal(a.refusal!.reason, "form");
  }
  const status = ask(TABLE, "github.com", { opcode: 2 });
  assert.equal(status.p!.rcode, 4);
  assert.equal(status.refusal!.reason, "opcode");
});

test("a name is logged lowercase, with each byte outside a host name's letters as \\ddd, so a line holds no other field", () => {
  assert.equal(nameText([Buffer.from("A b\nc"), Buffer.from("Test=1")]), "a\\032b\\010c.test\\0611");
  const { refusal } = ask(TABLE, Buffer.concat([Buffer.from([5]), Buffer.from("x y=z"), Buffer.from([0])]));
  assert.equal(refusal!.name, "x\\032y\\061z");
});

test("a rendered slot's table: jr2's name, each exact name and each wildcard; the owner names the Sandbox", () => {
  const manifest = {
    ...SANDBOX_MANIFEST,
    egress: SANDBOX_MANIFEST.egress
      .filter((r) => r.match !== "any")
      .concat(rule("db.corp.test", 5432, "name", false, "entry")),
  };
  const r = renderSlot(inputsOf(3, manifest, { sandbox: "ticket-a1b2c" }));
  assert.equal(r.resolver.owner, "sandbox=ticket-a1b2c");
  const a = (name: string) => ask(r.resolver, name).p!;
  for (const name of [
    "api.anthropic.com",
    "github.com",
    "registry.npmjs.org",
    "db.corp.test",
    "x.githubusercontent.com",
  ]) {
    assert.equal(a(name).rcode, 0, name);
    const want = r.resolver.names.find(
      (n) => n.name === name || (n.name === "*.githubusercontent.com" && name.endsWith(".githubusercontent.com")),
    )!;
    assert.equal(address(a(name).answers[0]!), want.address, name);
  }
  assert.equal(address(a(JR2_CUSTODIAN_NAME).answers[0]!), "198.18.0.1");
  // An address entry has no name.
  assert.equal(a("10.0.0.5").rcode, 3);
  assert.equal(a("gitlab.com").rcode, 3);
});

test("the TCP frames of a stream: a 2-byte length, messages split across chunks and several in one chunk", () => {
  const frames = tcpFrames();
  const m1 = Buffer.from("first message");
  const m2 = Buffer.from("second");
  const len = (m: Buffer) => Buffer.from([m.length >> 8, m.length & 255]);
  const stream = Buffer.concat([len(m1), m1, len(m2), m2]);
  assert.deepEqual(frames(stream.subarray(0, 1)), []);
  assert.deepEqual(frames(stream.subarray(1, 9)), []);
  const out = frames(stream.subarray(9));
  assert.deepEqual(out.map(String), ["first message", "second"]);
});

// ---- the server ---------------------------------------------------------------------------------

test("served on the loopback: Node's stub resolver gets A, NODATA for AAAA, NXDOMAIN, PTR and the TXT over UDP; framed queries over TCP; a slot with no table is refused, with one line", async () => {
  const tables = resolverTables();
  tables.set(TABLE);
  const lines: string[] = [];
  const server = custodianResolver({
    tables,
    log: (l) => lines.push(l),
    host: "127.0.0.1",
    slots: [3, 4],
    port: () => 0,
  });
  await server.listen();
  try {
    const stub = new Resolver({ timeout: 2000, tries: 1 });
    stub.setServers([`127.0.0.1:${server.ports(3).udp}`]);
    assert.deepEqual(await stub.resolve4("github.com", { ttl: true }), [{ address: "198.18.0.2", ttl: 60 }]);
    await assert.rejects(stub.resolve6("github.com"), { code: "ENODATA" });
    await assert.rejects(stub.resolve4("gitlab.com"), { code: "ENOTFOUND" });
    assert.deepEqual(await stub.reverse("198.18.0.2"), ["github.com"]);
    assert.deepEqual(await stub.resolveTxt(RULES_NAME), [[TABLE.version]]);
    // A new table is answered at once.
    tables.set({
      ...TABLE,
      version: "1111111111111111",
      names: [...TABLE.names, { name: "gitlab.com", match: "name", address: "198.18.0.5" }],
    });
    assert.deepEqual(await stub.resolve4("gitlab.com"), ["198.18.0.5"]);
    assert.deepEqual(await stub.resolveTxt(RULES_NAME), [["1111111111111111"]]);

    const refused = new Resolver({ timeout: 2000, tries: 1 });
    refused.setServers([`127.0.0.1:${server.ports(4).udp}`]);
    await assert.rejects(refused.resolve4("github.com"), { code: "EREFUSED" });

    // TCP: two queries in one write, each answered in order on the same connection.
    const answers = await new Promise<Buffer[]>((resolve, reject) => {
      const conn = connect(server.ports(3).tcp, "127.0.0.1");
      const frames = tcpFrames();
      const got: Buffer[] = [];
      const framed = (q: Buffer) => Buffer.concat([Buffer.from([q.length >> 8, q.length & 255]), q]);
      conn.on("connect", () =>
        conn.write(Buffer.concat([framed(query("github.com", { id: 1 })), framed(query("nope.test", { id: 2 }))])),
      );
      conn.on("data", (chunk: Buffer) => {
        got.push(...frames(chunk));
        if (got.length === 2) {
          conn.end();
          resolve(got);
        }
      });
      conn.on("error", reject);
    });
    const [one, two] = answers.map(parse);
    assert.deepEqual([one!.id, one!.rcode, address(one!.answers[0]!)], [1, 0, "198.18.0.2"]);
    assert.deepEqual([two!.id, two!.rcode], [2, 3]);

    assert.ok(
      lines.includes("jr2.custodian dns action=refuse slot=3 sandbox=ws-3 name=gitlab.com type=A reason=no-entry"),
      lines.join("\n"),
    );
    assert.ok(
      lines.includes("jr2.custodian dns action=refuse slot=4 name=github.com type=A reason=no-rules"),
      lines.join("\n"),
    );
    assert.ok(
      lines.includes("jr2.custodian dns action=refuse slot=3 sandbox=ws-3 name=nope.test type=A reason=no-entry"),
    );
    assert.equal(
      lines.filter((l) => l.includes("name=github.com") && l.includes("slot=3")).length,
      0,
      "an answered name writes no line",
    );
  } finally {
    await server.close();
  }
});

const framedQuery = (q: Buffer) => Buffer.concat([Buffer.from([q.length >> 8, q.length & 255]), q]);

/** A TCP connection to `port` that sends `data` and reads each answer, until the connection closes
 * or, with `want`, until it has that many answers: the answers, and how the connection ended (`end`
 * from the server, or the error's code). */
function tcpExchange(port: number, data: Buffer, want?: number): Promise<{ answers: Buffer[]; ended: string }> {
  return new Promise((resolve) => {
    const conn = connect(port, "127.0.0.1");
    const frames = tcpFrames();
    const answers: Buffer[] = [];
    let ended = "close";
    conn.on("connect", () => conn.write(data));
    conn.on("data", (chunk: Buffer) => {
      answers.push(...frames(chunk));
      if (answers.length === want) conn.destroy();
    });
    conn.on("end", () => (ended = "end"));
    conn.on("error", (e: NodeJS.ErrnoException) => (ended = e.code ?? "error"));
    conn.on("close", () => resolve({ answers, ended }));
  });
}

test("a TCP connection gets answers for RESOLVER_TCP_QUERIES queries, then the resolver closes it; a slot holds RESOLVER_TCP_CONNECTIONS connections", async () => {
  const tables = resolverTables();
  tables.set(TABLE);
  const server = custodianResolver({ tables, log: () => {}, host: "127.0.0.1", slots: [3], port: () => 0 });
  await server.listen();
  const held: ReturnType<typeof connect>[] = [];
  try {
    const many = Buffer.concat(
      Array.from({ length: RESOLVER_TCP_QUERIES + 6 }, (_, i) => framedQuery(query("github.com", { id: i }))),
    );
    const { answers, ended } = await tcpExchange(server.ports(3).tcp, many);
    assert.deepEqual(
      answers.map((a) => a.readUInt16BE(0)),
      Array.from({ length: RESOLVER_TCP_QUERIES }, (_, i) => i),
      "each query up to the bound is answered, in order, and no other",
    );
    assert.equal(ended, "end", "the resolver ends the connection after the last answer");

    // The slot's connections are held: one more is closed with no answer.
    for (let i = 0; i < RESOLVER_TCP_CONNECTIONS; i++) held.push(connect(server.ports(3).tcp, "127.0.0.1"));
    await Promise.all(held.map((c) => new Promise((resolve) => c.once("connect", resolve))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const more = await tcpExchange(server.ports(3).tcp, framedQuery(query("github.com")));
    assert.equal(more.answers.length, 0, `a connection above ${RESOLVER_TCP_CONNECTIONS} gets no answer`);
  } finally {
    for (const c of held) c.destroy();
    await server.close();
  }
});

test("a TCP client that reads no answer is reset after RESOLVER_TCP_QUERIES answers, within 2 s, and the other slot and its own slot over UDP still answer", async () => {
  const tables = resolverTables();
  tables.set(TABLE);
  tables.set({ ...TABLE, slot: 4, owner: "sandbox=ws-4" });
  const server = custodianResolver({ tables, log: () => {}, host: "127.0.0.1", slots: [3, 4], port: () => 0 });
  await server.listen();
  const conn = connect(server.ports(3).tcp, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => conn.once("connect", resolve).once("error", reject));
    conn.pause(); // read no answer
    let closed: string | undefined;
    conn.on("error", (e: NodeJS.ErrnoException) => (closed ??= e.code ?? "error"));
    conn.on("close", () => (closed ??= "close"));
    const framed = framedQuery(query("github.com", { id: 7 }));
    const batch = Buffer.concat(Array.from({ length: (65536 / framed.length) | 0 }, () => framed));
    // Send until the connection is closed. On the loopback the kernel takes each answer, so the
    // close is the reset after the answer to the RESOLVER_TCP_QUERIES-th query. The fake socket's
    // test below shows the reset when the kernel does not take an answer.
    const start = Date.now();
    while (closed === undefined && Date.now() - start < 2000) {
      if (!conn.write(batch)) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          conn.once("drain", () => (clearTimeout(timer), resolve()));
        });
      } else {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    assert.ok(closed !== undefined, "the resolver keeps a connection whose client reads no answer open for 2 s");

    // The other slot answers, over UDP and TCP, and so does this slot over UDP.
    const other = new Resolver({ timeout: 2000, tries: 1 });
    other.setServers([`127.0.0.1:${server.ports(4).udp}`]);
    assert.deepEqual(await other.resolve4("github.com"), ["198.18.0.2"]);
    const same = new Resolver({ timeout: 2000, tries: 1 });
    same.setServers([`127.0.0.1:${server.ports(3).udp}`]);
    assert.deepEqual(await same.resolve4("github.com"), ["198.18.0.2"]);
    const { answers } = await tcpExchange(server.ports(4).tcp, framed, 1);
    assert.equal(address(parse(answers[0]!).answers[0]!), "198.18.0.2");
  } finally {
    conn.destroy();
    await server.close();
  }
});

/** A fake of the part of a socket that `tcpConnection` uses: it records each write, end and close.
 * `untaken` is what `writableLength` says after a write: the bytes that the kernel did not take. */
class FakeConn extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  untaken = 0;
  idle?: () => void;
  calls: string[] = [];
  written: Buffer[] = [];
  setTimeout(_ms: number, cb?: () => void) {
    this.idle = cb;
    return this;
  }
  write(chunk: Buffer) {
    this.written.push(chunk);
    this.calls.push("write");
    this.writableLength = this.untaken;
    return true;
  }
  end(chunk?: Buffer) {
    if (chunk) this.written.push(chunk);
    this.calls.push("end");
    this.writableEnded = true;
    return this;
  }
  resetAndDestroy() {
    this.calls.push("reset");
    this.destroyed = true;
    return this;
  }
  destroy() {
    this.calls.push("destroy");
    this.destroyed = true;
    return this;
  }
}

/** A fake connection served by `tcpConnection` with TABLE. */
function fakeConn(): FakeConn {
  const conn = new FakeConn();
  tcpConnection(conn as unknown as ResolverConn, (q) => resolverAnswer(TABLE, q, "tcp").reply);
  return conn;
}

test("each close of a TCP connection is a reset, so the kernel keeps no answer of a closed connection: idle, the client's FIN, a message with no answer, an answer the kernel does not take", () => {
  const framed = framedQuery(query("github.com", { id: 1 }));

  const idle = fakeConn();
  idle.idle!();
  assert.deepEqual(idle.calls, ["reset"], "the idle limit resets");

  const fin = fakeConn();
  fin.emit("data", framed);
  fin.emit("end");
  assert.deepEqual(fin.calls, ["write", "reset"], "the client's FIN resets, after the answer");

  const broken = fakeConn();
  broken.emit("data", Buffer.concat([framed, framedQuery(Buffer.alloc(3)), framed]));
  assert.deepEqual(broken.calls, ["write", "reset"], "a message with no answer resets, and nothing after it is read");

  // The kernel does not take the first answer: the client does not read. Before this reset, such a
  // connection stayed until the 64th answer or the idle limit.
  const full = fakeConn();
  full.untaken = 10;
  full.emit("data", Buffer.concat(Array.from({ length: 5 }, () => framed)));
  assert.deepEqual(full.calls, ["write", "reset"], "an answer the kernel does not take resets at once");
  full.emit("data", framed);
  assert.deepEqual(full.calls, ["write", "reset"], "a reset connection answers nothing more");

  const err = fakeConn();
  err.emit("error", new Error("EPIPE"));
  assert.deepEqual(err.calls, ["reset"]);
});

test("the answer to the RESOLVER_TCP_QUERIES-th query goes with a FIN, and the connection is reset 1 s later if the client keeps it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const conn = fakeConn();
  const many = Buffer.concat(
    Array.from({ length: RESOLVER_TCP_QUERIES + 3 }, (_, i) => framedQuery(query("github.com", { id: i }))),
  );
  conn.emit("data", many);
  assert.deepEqual(conn.calls, [...Array<string>(RESOLVER_TCP_QUERIES - 1).fill("write"), "end"]);
  assert.deepEqual(
    conn.written.map((w) => w.readUInt16BE(2)),
    Array.from({ length: RESOLVER_TCP_QUERIES }, (_, i) => i),
    "each answer up to the bound, in order, the last one with the FIN",
  );
  t.mock.timers.tick(999);
  assert.equal(conn.calls.at(-1), "end", "the client has 1 s to read the last answers");
  t.mock.timers.tick(1);
  assert.equal(conn.calls.at(-1), "reset", "then the kernel keeps nothing of the connection");
  assert.equal(conn.calls.includes("destroy"), false, "no plain close");
});

test("a TCP client that sends its queries and its FIN gets each answer before the reset", async () => {
  const tables = resolverTables();
  tables.set(TABLE);
  const server = custodianResolver({ tables, log: () => {}, host: "127.0.0.1", slots: [3], port: () => 0 });
  await server.listen();
  try {
    const answers = await new Promise<Buffer[]>((resolve) => {
      const conn = connect({ port: server.ports(3).tcp, host: "127.0.0.1", allowHalfOpen: true });
      const frames = tcpFrames();
      const got: Buffer[] = [];
      conn.on("connect", () =>
        conn.end(Buffer.concat([1, 2, 3].map((id) => framedQuery(query("github.com", { id }))))),
      );
      conn.on("data", (chunk: Buffer) => got.push(...frames(chunk)));
      conn.on("error", () => {});
      conn.on("close", () => resolve(got));
    });
    assert.deepEqual(
      answers.map((a) => a.readUInt16BE(0)),
      [1, 2, 3],
    );
  } finally {
    await server.close();
  }
});

test("an error of a slot's TCP server (a failed accept) does not end the process, and the slot still answers", async (t) => {
  const servers: Server[] = [];
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
    servers.push(this);
    return (listen as (...a: unknown[]) => Server).apply(this, args);
  });
  const tables = resolverTables();
  tables.set(TABLE);
  const server = custodianResolver({ tables, log: () => {}, host: "127.0.0.1", slots: [3], port: () => 0 });
  await server.listen();
  t.mock.restoreAll();
  try {
    assert.equal(servers.length, 1);
    assert.doesNotThrow(() =>
      servers[0]!.emit("error", Object.assign(new Error("accept EPROTO"), { code: "EPROTO", syscall: "accept" })),
    );
    const { answers } = await tcpExchange(server.ports(3).tcp, framedQuery(query("github.com", { id: 4 })), 1);
    assert.equal(address(parse(answers[0]!).answers[0]!), "198.18.0.2");
  } finally {
    await server.close();
  }
});

test("a UDP query from port 0 gets no answer, and a throw of the send or of the answer loses one answer, not the process", () => {
  const q = query("github.com", { id: 9 });
  const sent: { port: number; address: string }[] = [];
  const send = (_reply: Buffer, port: number, address: string) => void sent.push({ port, address });
  const answer = (m: Buffer) => resolverAnswer(TABLE, m, "udp").reply;

  udpAnswer(answer, send, q, { port: 0, address: "127.0.0.1" });
  assert.equal(sent.length, 0, "no answer to port 0");

  // As Node's dgram does for a port it refuses.
  const throwing = () => {
    throw Object.assign(new RangeError("Port should be > 0 and < 65536"), { code: "ERR_SOCKET_BAD_PORT" });
  };
  assert.doesNotThrow(() => udpAnswer(answer, throwing, q, { port: 53, address: "127.0.0.1" }));
  assert.doesNotThrow(() =>
    udpAnswer(
      () => {
        throw new Error("a defect");
      },
      send,
      q,
      { port: 53, address: "127.0.0.1" },
    ),
  );
  assert.equal(sent.length, 0);

  // The next query of the slot is answered.
  udpAnswer(answer, send, q, { port: 40000, address: "127.0.0.1" });
  assert.deepEqual(sent, [{ port: 40000, address: "127.0.0.1" }]);
});

test("refusal lines: at most REFUSAL_LINES for each slot in one second, then one line with the count of the others", () => {
  const lines: string[] = [];
  const log = refusalLog((l) => lines.push(l));
  for (let i = 0; i < REFUSAL_LINES + 5; i++) log.refuse(3, "sandbox=ws-3", `name=n${i}.test type=A reason=no-entry`);
  log.refuse(4, undefined, "name=x.test type=A reason=no-rules");
  assert.equal(lines.length, REFUSAL_LINES + 1);
  assert.equal(lines[0], "jr2.custodian dns action=refuse slot=3 sandbox=ws-3 name=n0.test type=A reason=no-entry");
  assert.equal(lines.at(-1), "jr2.custodian dns action=refuse slot=4 name=x.test type=A reason=no-rules");
  log.second();
  assert.equal(lines.at(-1), "jr2.custodian dns action=refuse slot=3 sandbox=ws-3 suppressed=5");
  assert.equal(lines.length, REFUSAL_LINES + 2, "a slot under the bound writes no count line");
  // A new second: the bound starts again, and a second with nothing suppressed writes no count.
  log.refuse(3, "sandbox=ws-3", "name=again.test type=A reason=no-entry");
  log.second();
  assert.equal(
    lines.at(-1),
    "jr2.custodian dns action=refuse slot=3 sandbox=ws-3 name=again.test type=A reason=no-entry",
  );
  assert.equal(lines.length, REFUSAL_LINES + 3);
});
