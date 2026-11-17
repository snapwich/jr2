// The Custodian suite (ADR-0059, ADR-0084): the claims about the Custodian of an Instance that only
// real sockets can check, against the REAL engine — the pinned Envoy image, running the bootstrap
// of a Custodian pod and the rules of its slots as `custodian-rules.ts` renders them. See the rig
// for what is faked (the uplink, the pod's DNS, the targets and the Orchestrator).
//
// Three slots of one pod: slot 3 (Sandbox `ws-3`) has each kind of rule; slot 4 (Sandbox `ws-4`)
// holds the same secret as slot 3 with another value and other Stand-ins; slot 0 is the Instance
// Harness (no fetch token). `custodian-rules.docker.ts` runs the claims that need a docker network
// of their own: the port-80 chain, each address of a name, the cache of names, the dial's bound.
//
// Opt-in: `just custodian-test` (docker + the pinned image). Not in `pnpm -r test`, because the
// default gate needs no infrastructure (ADR-0010).

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  JR2_CUSTODIAN_NAME,
  leafStem,
  slotAddress,
  slotVlan,
  standIn,
  type EgressRule,
  type HeldBinding,
  type HeldManifest,
} from "@jr2/orchestrator/internal";
import {
  controlStandInOf,
  DIAL_TOKEN,
  controlTokenOf,
  fetchTokenOf,
  heldStandInOf,
  helloReply,
  httpsVia,
  httpVia,
  lanAddress,
  RANGES,
  rawVia,
  startCustodianPod,
  startHttpTarget,
  startTcpTarget,
  startUpstream,
  timeUpdates,
  type CustodianPod,
  type Dialed,
  type RigSlot,
  type Upstream,
} from "./support/custodian-rig.ts";
import { manySlots, rule } from "./support/custodian-slots.ts";

const LAN = lanAddress();
const VALUES = {
  ANTHROPIC_API_KEY: "sk-ant-value-one",
  SERVICE_TOKEN: "svc-value-two",
  LITELLM_KEY: "ll-value-three",
  UNTRUSTED_KEY: "un-value-four",
  SECOND_SERVICE_TOKEN: "svc-value-five",
  // A token push's token, and one toward a host that the Egress list also names (ADR-0068).
  push_git: "ghp-git-token-value-six",
  push_open: "ghp-open-token-value-seven",
};
/** Slot 4's value of the one secret it shares with slot 3. */
const SLOT4_KEY = "sk-ant-value-of-slot-four";
const ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);

let a: Upstream; // a.test: three secrets bound by name (the `dial-tls` listener)
let b: Upstream; // the LAN address: a paths-narrowed secret bound by address
let c: Upstream; // c.test: Tunneled
let d: Upstream; // d.test: bound, but its CA is not in upstream.crt
let wild: Upstream; // x.wild.test, under `*.wild.test`
let git: Upstream; // git.test: a smart-HTTP git server, its token bound in Basic (a push, ADR-0068)
let open: Upstream; // open.test: a token bound in Basic, and an entry names the host too
let gitRoot: string; // git.test's repositories
let web: Awaited<ReturnType<typeof startHttpTarget>>; // plain HTTP, under `*`
let echo: Awaited<ReturnType<typeof startTcpTarget>>; // raw.test and an address entry: echoes
let ssh: Awaited<ReturnType<typeof startTcpTarget>>; // ssh.test: speaks first
let orchestrator: Awaited<ReturnType<typeof startHttpTarget>>;
let harness: Awaited<ReturnType<typeof startHttpTarget>>; // a Harness pod behind the Fence (inbound)
let closedPort: number; // an inbound target where nothing listens
let pod: CustodianPod;
let slots: RigSlot[];

const binding = (name: string, host: string, port: number, headers: string[], paths?: string[]): HeldBinding => ({
  name,
  source: { kind: "literal" },
  hosts: [{ host, port, leaf: leafStem(host, port) }],
  headers,
  ...(paths ? { paths } : {}),
});

/** git in `cwd`, with no config of the host's: the suite's own. */
async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const { stdout } = await promisify(execFile)("git", args, { cwd, env });
  return stdout;
}

/** A smart-HTTP git server (`git http-backend`, CGI) for the repositories under `root`, which takes
 * only the `Authorization` given, and answers 401 to any other, as a forge does. */
function gitHttpBackend(root: string, authorization: string): Upstream["handler"] {
  return (req, res) => {
    // The scheme's name is case-insensitive (RFC 9110); the pair is not.
    if (req.headers.authorization?.replace(/^basic /i, "Basic ") !== authorization) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git.test"' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "https://git.test");
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: root,
        REMOTE_USER: "x-access-token",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      },
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (sent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [k, ...v] = line.split(":");
        if (k!.toLowerCase() === "status") status = Number(v.join(":").trim().split(" ")[0]);
        else headers[k!] = v.join(":").trim();
      }
      res.writeHead(status, headers);
      sent = true;
      res.write(head.subarray(end + 4));
    });
    child.stdout.on("end", () => res.end());
  };
}

/** Envoy flushes its access log on an interval, so a line is waited for, not read at once. */
async function line(pattern: RegExp): Promise<void> {
  for (let i = 0; i < 50 && !pattern.test(pod.output()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(pod.output(), pattern);
}

function slot3(): RigSlot {
  const manifest: HeldManifest = {
    version: 1,
    secrets: [
      binding("ANTHROPIC_API_KEY", "a.test", a.port, ["x-api-key"]),
      binding("SERVICE_TOKEN", "a.test", a.port, ["authorization"]),
      // Two secrets on one host in one header: two MCP servers of one service (ADR-0079).
      binding("SECOND_SERVICE_TOKEN", "a.test", a.port, ["authorization"]),
      binding("LITELLM_KEY", LAN, b.port, ["authorization", "x-api-key"], ["/v1/messages"]),
      binding("UNTRUSTED_KEY", "d.test", d.port, ["x-api-key"]),
      // The token of a push over https, which git sends in a Basic pair (ADR-0068).
      { ...binding("push_git", "git.test", git.port, ["authorization"]), holder: "effector", basic: true },
      { ...binding("push_open", "open.test", open.port, ["authorization"]), holder: "effector", basic: true },
    ],
    egress: [
      rule("a.test", a.port, "name", true, "held"),
      rule(LAN, b.port, "address", true, "held"),
      rule("d.test", d.port, "name", true, "held"),
      rule("git.test", git.port, "name", true, "effector"),
      rule("open.test", open.port, "name", true, "effector", "entry"),
      rule("c.test", c.port, "name", false, "entry"),
      rule("raw.test", echo.port, "name", false, "entry"),
      rule("ssh.test", ssh.port, "name", false, "repo"),
      rule(LAN, echo.port, "address", false, "entry"),
      rule("wild.test", wild.port, "below", false, "entry"),
      rule("wild.test", ssh.port, "below", false, "entry"),
      rule("*", web.port, "any", false, "entry"),
      // Names whose every address is one the Custodian never dials.
      rule("loop.test", c.port, "name", false, "entry"),
      rule("meta.test", c.port, "name", false, "entry"),
      rule("seg.test", c.port, "name", false, "entry"),
      rule("ph.test", c.port, "name", false, "entry"),
    ],
  };
  return {
    slot: 3,
    owner: { sandbox: "ws-3" },
    manifest,
    // One trailing line end is what `kubectl create secret --from-file` writes.
    values: { ...VALUES, ANTHROPIC_API_KEY: `${VALUES.ANTHROPIC_API_KEY}\n` },
  };
}

function slot4(): RigSlot {
  return {
    slot: 4,
    owner: { sandbox: "ws-4" },
    manifest: {
      version: 1,
      secrets: [binding("ANTHROPIC_API_KEY", "a.test", a.port, ["x-api-key"])],
      egress: [rule("a.test", a.port, "name", true, "held"), rule("c.test", c.port, "name", false, "entry")],
    },
    values: { ANTHROPIC_API_KEY: SLOT4_KEY },
  };
}

const slot0: RigSlot = {
  slot: 0,
  owner: { pod: "instance" },
  manifest: { version: 1, secrets: [], egress: [] },
  values: {},
};

before(async () => {
  [a, b, c, d, wild, git, open] = await Promise.all([
    startUpstream("a.test"),
    startUpstream(),
    startUpstream("c.test"),
    startUpstream("d.test"),
    startUpstream("x.wild.test"),
    startUpstream("git.test"),
    startUpstream("open.test"),
  ]);
  gitRoot = await mkdtemp(join(tmpdir(), "jr2-custodian-git-"));
  await gitIn(gitRoot, "init", "-q", "--bare", "app.git");
  git.handler = gitHttpBackend(gitRoot, `Basic ${Buffer.from(`x-access-token:${VALUES.push_git}`).toString("base64")}`);
  [web, orchestrator, harness] = await Promise.all([
    startHttpTarget(),
    startHttpTarget(),
    startHttpTarget("127.0.0.1"),
  ]);
  [echo, ssh] = await Promise.all([startTcpTarget(), startTcpTarget("SSH-2.0-suite\r\n")]);
  const closed = await startHttpTarget("127.0.0.1");
  closedPort = closed.port;
  await closed.close();
  slots = [slot0, slot3(), slot4()];
  pod = await startCustodianPod({
    slots,
    upstreamCas: [a.ca.cert, b.ca.cert, c.ca.cert, wild.ca.cert, git.ca.cert, open.ca.cert],
    orchestrator: { host: LAN, port: orchestrator.port },
    names: {
      "a.test": LAN,
      "c.test": LAN,
      "d.test": LAN,
      "x.wild.test": LAN,
      "git.test": LAN,
      "open.test": LAN,
      "loop.wild.test": "127.0.0.1",
      "raw.test": LAN,
      "ssh.test": LAN,
      "extra.test": LAN,
      "loop.test": "127.0.0.1",
      "meta.test": "169.254.169.254",
      "seg.test": "198.19.0.5",
      "ph.test": "198.18.0.9",
    },
    inboundTargets: [`127.0.0.1:${harness.port}`, `127.0.0.1:${closedPort}`],
    // Small bounds, so that a test can pass them: the slots together hold 64 connections.
    connections: { pod: 64, dial: 16 },
    extraSlots: [5],
  });
});

after(async () => {
  await pod?.stop();
  await Promise.all([a, b, c, d, wild, git, open].map((u) => u?.close()));
  if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
  await Promise.all([web, orchestrator, harness, echo, ssh].map((t) => t?.close()));
});

/** HTTPS to a bound target of slot 3, as its Harness would send it: the name's placeholder, the
 * name's TLS name, `Host: name:port`, trusting the slot's CA. */
const viaA = (opts: Omit<Parameters<typeof httpsVia>[2], "ca"> = {}, slot = 3) =>
  httpsVia(pod.at(slot, "a.test", a.port), "a.test", { authority: `a.test:${a.port}`, ca: pod.trust(slot), ...opts });
const viaB = (opts: Omit<Parameters<typeof httpsVia>[2], "ca"> = {}) =>
  httpsVia(pod.dial(3, LAN, b.port), LAN, {
    authority: `${LAN}:${b.port}`,
    ca: pod.trust(3),
    servername: false,
    ...opts,
  });
const viaD = (opts: Omit<Parameters<typeof httpsVia>[2], "ca"> = {}) =>
  httpsVia(pod.at(3, "d.test", d.port), "d.test", { authority: `d.test:${d.port}`, ca: pod.trust(3), ...opts });
const key = (name: string, slot = 3) => heldStandInOf(name, slot);

describe("toward a bound host (an Intercepted host of the slot)", () => {
  test("1. the Stand-in is swapped: x-api-key alone, Bearer, and two secrets in one request; nothing is added", async () => {
    let r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY") } });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers["x-api-key"], VALUES.ANTHROPIC_API_KEY, "the value, its trailing newline gone");
    assert.equal(r.headers.server, undefined);
    assert.ok(!Object.keys(r.headers).some((h) => h.startsWith("x-envoy")), JSON.stringify(r.headers));
    const up = a.seen.at(-1)!.headers;
    assert.ok(
      !Object.keys(up).some((h) => /^(x-envoy|x-forwarded|x-request-id|via|x-jr2)/.test(h)),
      `the target got only the client's headers: ${Object.keys(up).join(", ")}`,
    );
    assert.equal(up.host, `a.test:${a.port}`, "the target got the name, not the address dialed");

    r = await viaA({ headers: { authorization: `Bearer ${key("SERVICE_TOKEN")}` } });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers.authorization, `Bearer ${VALUES.SERVICE_TOKEN}`);

    r = await viaA({
      headers: { "x-api-key": key("ANTHROPIC_API_KEY"), authorization: `Bearer ${key("SERVICE_TOKEN")}` },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers["x-api-key"], VALUES.ANTHROPIC_API_KEY);
    assert.equal(a.seen.at(-1)?.headers.authorization, `Bearer ${VALUES.SERVICE_TOKEN}`);
  });

  test("1b. two secrets on one host in one header: each Stand-in gets its own value (ADR-0079)", async () => {
    for (const name of ["SERVICE_TOKEN", "SECOND_SERVICE_TOKEN"] as const) {
      const r = await viaA({ headers: { authorization: `Bearer ${key(name)}` } });
      assert.equal(r.status, 200, r.body);
      assert.equal(a.seen.at(-1)?.headers.authorization, `Bearer ${VALUES[name]}`, name);
    }
  });

  test("2. no Stand-in → 403, and the target receives nothing", async () => {
    const before = a.seen.length;
    const r = await viaA({ headers: { "x-api-key": "sk-something-else" } });
    assert.equal(r.status, 403);
    assert.match(r.body, /needs the stand-in of ANTHROPIC_API_KEY, SERVICE_TOKEN, SECOND_SERVICE_TOKEN/);
    assert.equal(a.seen.length, before);
  });

  test("3. a foreign credential beside a swap is removed; a credential header sent twice → 400", async () => {
    let r = await viaA({
      headers: { "x-api-key": key("ANTHROPIC_API_KEY"), authorization: "Bearer mine", "api-key": "also-mine" },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers.authorization, undefined);
    assert.equal(a.seen.at(-1)?.headers["api-key"], undefined);
    const before = a.seen.length;
    r = await viaA({ headers: { "x-api-key": [key("ANTHROPIC_API_KEY"), key("ANTHROPIC_API_KEY")] } });
    assert.equal(r.status, 400);
    assert.equal(a.seen.length, before);
  });

  test("3b. a method outside the list → 405; an underscore header → 400; nothing is sent", async () => {
    const before = a.seen.length;
    const k = { "x-api-key": key("ANTHROPIC_API_KEY") };
    for (const method of ["TRACE", "PROPFIND"]) assert.equal((await viaA({ method, headers: k })).status, 405, method);
    assert.equal((await viaA({ headers: { ...k, x_api_key: "mine" } })).status, 400);
    assert.equal(a.seen.length, before);
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.equal((await viaA({ method, headers: k })).status, 200, method);
    }
  });

  test("3c. a header the Connection header names never leaves; two Host headers → 421", async () => {
    const before = a.seen.length;
    let r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY"), connection: "keep-alive, x-api-key" } });
    assert.equal(r.status, 403, "Envoy drops what Connection names before the swap");
    r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY"), host: [`a.test:${a.port}`, "evil.example"] } });
    assert.equal(r.status, 421);
    assert.equal(a.seen.length, before);
    r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY"), connection: "keep-alive, foo", foo: "x" } });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers.foo, undefined);
    assert.equal(a.seen.at(-1)?.headers.connection, undefined);
  });

  test("4. Host ≠ target → 421; outside `paths` → 403, after \\ and ..; are read; an encoded / or \\ → 400 (a secret bound to an address)", async () => {
    const before = b.seen.length;
    assert.equal(
      (await viaA({ authority: "elsewhere.example:443", headers: { "x-api-key": key("ANTHROPIC_API_KEY") } })).status,
      421,
    );
    const lite = { authorization: `Bearer ${key("LITELLM_KEY")}` };
    assert.equal((await viaB({ path: "/key/generate", headers: lite })).status, 403);
    assert.equal((await viaB({ path: "/v1/messages/../../key/generate", headers: lite })).status, 403);
    assert.equal((await viaB({ path: "/v1/messages%2F..%2Fkey", headers: lite })).status, 400);
    assert.equal((await viaB({ path: "/v1/messages%5C..%5Ckey", headers: lite })).status, 400, "an encoded \\");
    for (const path of ["/v1/messages/..\\key", "/v1/messages/..;/key"]) {
      assert.equal((await viaB({ path, headers: lite })).status, 403, path);
    }
    assert.equal(b.seen.length, before, "none of them reached the target");
    let r = await viaB({ path: "/v1/messages?beta=true", headers: lite });
    assert.equal(r.status, 200, r.body);
    assert.equal(b.seen.at(-1)?.headers.authorization, `Bearer ${VALUES.LITELLM_KEY}`);
    r = await viaB({ path: "/v1/messages\\x", headers: lite });
    assert.equal(r.status, 200, r.body);
    assert.equal(b.seen.at(-1)?.url, "/v1/messages/x", "the target gets the path that was checked");
  });

  test("7. a target certificate that upstream.crt does not trust → 502, and nothing is sent", async () => {
    const r = await viaD({ headers: { "x-api-key": key("UNTRUSTED_KEY") } });
    assert.equal(r.status, 502);
    assert.match(r.body, new RegExp(`^jr2 custodian: d\\.test:${d.port} could not be reached: `));
    assert.equal(d.seen.length, 0);
  });

  test("7b. a target that closes the connection after it got the request → 502 that says the request may have reached it", async () => {
    a.handler = (req) => req.socket.destroy();
    const before = a.seen.length;
    const r = await viaA({ method: "POST", headers: { "x-api-key": key("ANTHROPIC_API_KEY") } });
    a.handler = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
    assert.equal(r.status, 502, r.body);
    assert.match(
      r.body,
      new RegExp(`^jr2 custodian: a\\.test:${a.port} did not answer; the request may have reached it: `),
    );
    assert.equal(a.seen.length, before + 1, "the target got the request: a second send would be a second write");
  });

  test("8. SSE: each event reaches the client within 100 ms of the target's write", async () => {
    const written: number[] = [];
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        written.push(Date.now());
        res.write(`event: delta\ndata: {"n":${n}}\n\n`);
        if (++n === 5) {
          clearInterval(tick);
          res.end();
        }
      }, 300);
    };
    const arrived: number[] = [];
    await viaA({
      headers: { "x-api-key": key("ANTHROPIC_API_KEY") },
      onResponse: (res) => res.on("data", () => arrived.push(Date.now())),
    });
    assert.equal(arrived.length, 5, `five events, one read each (got ${arrived.length})`);
    for (const [i, at] of arrived.entries()) {
      assert.ok(at - written[i]! < 100, `event ${i} arrived ${at - written[i]!} ms after its write`);
    }
  });

  test("9. abort: the client goes after 2 events, and the target sees the close within 1 s", async () => {
    let seen: { closedAt?: number } | undefined;
    a.handler = (_req, res, entry) => {
      seen = entry;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tick = setInterval(() => res.write(`data: tick\n\n`), 100);
      res.on("close", () => {
        clearInterval(tick);
        entry.closedAt ??= Date.now();
      });
    };
    let abortedAt = 0;
    await viaA({
      headers: { "x-api-key": key("ANTHROPIC_API_KEY") },
      onResponse: (res, req) => {
        let events = 0;
        res.on("data", () => {
          if (++events === 2) {
            abortedAt = Date.now();
            req.destroy();
          }
        });
      },
    }).catch(() => undefined);
    const deadline = Date.now() + 2000;
    while (seen?.closedAt === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen?.closedAt, "the target saw its request end");
    assert.ok(seen.closedAt - abortedAt < 1000, `closed ${seen.closedAt - abortedAt} ms after the abort`);
  });

  test("10. a 302 passes to the client, and the Custodian makes no second request", async () => {
    a.handler = (_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/next" });
      res.end();
    };
    const before = a.seen.length;
    const r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY") } });
    a.handler = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "https://elsewhere.example/next");
    assert.equal(a.seen.length, before + 1);
  });

  test("the PUBLIC form of a held secret's Stand-in is no Stand-in: 403, and the target gets nothing (C1b)", async () => {
    const before = a.seen.length;
    const r = await viaA({ headers: { "x-api-key": standIn("ANTHROPIC_API_KEY") } });
    assert.equal(r.status, 403, r.body);
    assert.equal(a.seen.length, before);
  });

  test("the stated slot (X-Jr2-Slot) never leaves toward a bound host", async () => {
    const r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY"), "x-jr2-slot": "body/coder" } });
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers["x-jr2-slot"], undefined);
  });
});

describe("a secret that rides Basic: a push's token (ADR-0068, ADR-0059)", () => {
  const basicOf = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const viaGit = (opts: Omit<Parameters<typeof httpsVia>[2], "ca"> = {}) =>
    httpsVia(pod.at(3, "git.test", git.port), "git.test", {
      authority: `git.test:${git.port}`,
      ca: pod.trust(3),
      path: "/app.git/info/refs?service=git-receive-pack",
      ...opts,
    });

  test("B1. a Basic pair whose password is the Stand-in: the password becomes the value, and the user stays", async () => {
    for (const scheme of ["Basic", "basic"]) {
      const r = await viaGit({
        headers: { authorization: basicOf("x-access-token", key("push_git")).replace("Basic", scheme) },
      });
      assert.equal(r.status, 200, r.body);
      assert.equal(
        git.seen.at(-1)?.headers.authorization,
        `${scheme} ${basicOf("x-access-token", VALUES.push_git).slice(6)}`,
      );
    }
    // Another user is kept as it is: only the password is swapped.
    await viaGit({ headers: { authorization: basicOf("bot", key("push_git")) } });
    assert.equal(git.seen.at(-1)?.headers.authorization, basicOf("bot", VALUES.push_git));
    // A pair whose password is not the Stand-in, or one that is no base64, swaps nothing: 403.
    const before = git.seen.length;
    for (const value of [basicOf(key("push_git"), "x"), basicOf("x-access-token", "wrong"), "Basic %%%"]) {
      const r = await viaGit({ headers: { authorization: value } });
      assert.equal(r.status, 403, value);
      assert.match(r.body, /needs the stand-in of push_git in authorization/);
    }
    assert.equal(git.seen.length, before, "nothing reached the target");
  });

  test("B2. no credential → 401 with WWW-Authenticate: Basic, and nothing reaches the target; toward a host that an entry also names, it is carried with no credential", async () => {
    const before = git.seen.length;
    const r = await viaGit();
    assert.equal(r.status, 401, r.body);
    assert.equal(r.headers["www-authenticate"], 'Basic realm="jr2"');
    assert.match(r.body, /git\.test:\d+ needs a credential/);
    assert.equal(git.seen.length, before);
    // Open: carried, with every credential header removed; the host answers for itself.
    const carried = await httpsVia(pod.at(3, "open.test", open.port), "open.test", {
      authority: `open.test:${open.port}`,
      ca: pod.trust(3),
      headers: { "x-api-key": "not-a-stand-in" },
    });
    assert.equal(carried.status, 200, carried.body);
    assert.equal(open.seen.at(-1)?.headers["x-api-key"], undefined);
    assert.equal(open.seen.at(-1)?.headers.authorization, undefined);
  });

  test("B3. git push over https through the Custodian: the first request gets the 401, the helper's pair carries the Stand-in, and the server gets the token", async () => {
    const work = await mkdtemp(join(tmpdir(), "jr2-custodian-push-"));
    // The Fence brings a connection to the slot's listener whatever address a client dials; here a
    // relay on a loopback address of its own, on the target's port, does it, so git's url and Host
    // name the target as a Sandbox's git would.
    const to = pod.at(3, "git.test", git.port);
    const relay = createNetServer((inbound) => {
      const outbound = connect(to.port, to.host);
      inbound.pipe(outbound).pipe(inbound);
      inbound.on("error", () => outbound.destroy());
      outbound.on("error", () => inbound.destroy());
    });
    await new Promise<void>((resolve) => relay.listen(git.port, "127.66.0.1", resolve));
    try {
      const ca = join(work, "ca.crt");
      await writeFile(ca, pod.trust(3));
      await gitIn(work, "init", "-q", "-b", "main", "src");
      const src = join(work, "src");
      await writeFile(join(src, "README.md"), "pushed through the Custodian\n");
      await gitIn(src, "add", "README.md");
      await gitIn(src, "-c", "user.name=suite", "-c", "user.email=suite@jr2.test", "commit", "-q", "-m", "first");
      const helper = `!f() { echo username=x-access-token; echo password=${key("push_git")}; }; f`;
      const before = git.seen.length;
      await gitIn(
        src,
        "-c",
        `http.sslCAInfo=${ca}`,
        "-c",
        `http.curloptResolve=git.test:${git.port}:127.66.0.1`,
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        "push",
        `https://git.test:${git.port}/app.git`,
        "HEAD:refs/heads/main",
      );
      const sent = git.seen.slice(before);
      const expected = basicOf("x-access-token", VALUES.push_git);
      assert.ok(sent.length >= 2, `git sent ${sent.length} requests`);
      assert.ok(
        sent.every((r) => r.headers.authorization === expected),
        "each request the server got carried the token, never the Stand-in, and none came with no credential",
      );
      const log = await gitIn(join(gitRoot, "app.git"), "log", "--format=%s", "main");
      assert.equal(log.trim(), "first", "the server holds the pushed commit");
    } finally {
      await new Promise((r) => relay.close(r));
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("two slots: each has its own Stand-ins and values", () => {
  test("slot 4's Stand-in gets slot 4's value; each slot's Stand-in on the other slot → 403, and the target gets nothing", async () => {
    let r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY", 4) } }, 4);
    assert.equal(r.status, 200, r.body);
    assert.equal(a.seen.at(-1)?.headers["x-api-key"], SLOT4_KEY);
    const before = a.seen.length;
    r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY", 4) } }, 3);
    assert.equal(r.status, 403, `slot 4's Stand-in on slot 3: ${r.body}`);
    r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY", 3) } }, 4);
    assert.equal(r.status, 403, `slot 3's Stand-in on slot 4: ${r.body}`);
    assert.equal(a.seen.length, before);
  });

  test("a slot's leaf is of its own CA: slot 4's Harness does not trust slot 3's interception", async () => {
    await assert.rejects(
      httpsVia(pod.at(3, "a.test", a.port), "a.test", { authority: `a.test:${a.port}`, ca: pod.trust(4) }),
      /certificate/,
    );
  });
});

describe("the name decides, and the Custodian dials the name (ADR-0084)", () => {
  test("a Tunneled name: TLS with its name, at its placeholder, reaches the name's target with each byte unchanged", async () => {
    const r = await httpsVia(pod.at(3, "c.test", c.port), "c.test", {
      authority: `c.test:${c.port}`,
      ca: c.ca.cert,
      headers: { "x-api-key": key("ANTHROPIC_API_KEY") },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(
      c.seen.at(-1)?.headers["x-api-key"],
      key("ANTHROPIC_API_KEY"),
      "a Stand-in to a Tunneled host arrives as it left",
    );
    await line(
      new RegExp(`jr2\\.custodian slot=3 sandbox=ws-3 action=tunnel target=c\\.test:${c.port} to=\\S+ sni=c\\.test `),
    );
  });

  test("a TLS name that does not agree with the name of the address dialed → TLS alert, and nothing reaches a target", async () => {
    const before = [c.seen.length, d.seen.length];
    assert.deepEqual(await helloReply(pod.at(3, "c.test", c.port), "d.test"), ALERT, "d.test at c.test's placeholder");
    assert.deepEqual(await helloReply(pod.at(3, "a.test", a.port), "c.test"), ALERT, "c.test at a.test's placeholder");
    assert.deepEqual([c.seen.length, d.seen.length], before);
    await line(/jr2\.custodian slot=3 sandbox=ws-3 action=refuse reason=sni port=\d+ to=\S+ sni=d\.test /);
  });

  test("plain bytes to an Intercepted host's address → a line of text, not the target", async () => {
    const reply = (await rawVia(pod.at(3, "a.test", a.port), "GET / HTTP/1.1\r\nHost: a.test\r\n\r\n")).toString();
    assert.match(reply, /^jr2 custodian: refused: this address takes TLS only on port/);
  });

  test("another slot's placeholder is no address of this slot: refused", async () => {
    // An address of slot 3's table that slot 4's table does not have.
    const four = new Set(pod.placeholders(4).rows.map((r) => r.address));
    const row = pod.placeholders(3).rows.find((r) => !four.has(r.address) && r.name === "raw.test")!;
    assert.ok(row, "slot 3 has a placeholder that slot 4 has not");
    const at = pod.dial(4, row.address, echo.port);
    assert.match(
      (await rawVia(at, "hello")).toString(),
      /^jr2 custodian: refused: no entry of the Egress list permits this address/,
    );
    assert.deepEqual(await helloReply(pod.dial(4, row.address, 443), "raw.test"), ALERT);
    // Slot 3 carries the same address and port.
    assert.equal((await rawVia(pod.dial(3, row.address, echo.port), "hello", 1_000)).toString(), "hello");
  });

  test("an address entry is tunneled byte for byte, to the address as written", async () => {
    const reply = await rawVia(pod.dial(3, LAN, echo.port), "ping\n", 1_000);
    assert.equal(reply.toString(), "ping\n");
    await line(
      new RegExp(`jr2\\.custodian slot=3 sandbox=ws-3 action=tunnel target=${LAN.replace(/\./g, "\\.")}:${echo.port} `),
    );
  });

  test("raw TCP by name: a client that speaks first, and a server that speaks first (after the 2 s wait for a TLS name)", async () => {
    assert.equal((await rawVia(pod.at(3, "raw.test", echo.port), "hello\n", 1_000)).toString(), "hello\n");
    const started = Date.now();
    const banner = await new Promise<string>((resolve) => {
      const s = connect(pod.at(3, "ssh.test", ssh.port).port, pod.at(3, "ssh.test", ssh.port).host);
      s.on("error", () => resolve(""));
      s.once("data", (d: Buffer) => {
        s.destroy();
        resolve(d.toString());
      });
      setTimeout(() => {
        s.destroy();
        resolve("");
      }, 6_000);
    });
    assert.equal(banner, "SSH-2.0-suite\r\n");
    assert.ok(Date.now() - started >= 1_900, "the listener waits for a TLS name first");
  });

  test("a wildcard carries TLS and HTTP only: a name under it on TLS, never raw bytes, and a server that speaks first gets no tunnel", async () => {
    const at = pod.at(3, "*.wild.test", wild.port);
    assert.equal((await helloReply(at, "x.wild.test"))[0], 0x16, "x.wild.test: the target's server hello");
    assert.deepEqual(await helloReply(at, "x.other.test"), ALERT, "a name outside the domain");
    assert.deepEqual(await helloReply(at, "wild.test"), ALERT, "the domain itself is not below it");
    // A protocol that sends no name: no tunnel. The banner of ssh.test's server never comes.
    const quiet = await rawVia(pod.at(3, "*.wild.test", ssh.port), undefined, 4_000);
    assert.doesNotMatch(quiet.toString(), /SSH-2\.0/);
    const notHttp = await rawVia(pod.at(3, "*.wild.test", ssh.port), "SSH-2.0-client\r\n", 2_000);
    assert.doesNotMatch(notHttp.toString(), /SSH-2\.0-suite/);
  });

  test("`*` on a port: plain HTTP by the Host's name, on the rule's port alone", async () => {
    const at = pod.at(3, "*", web.port);
    let r = await httpVia(at, `x.wild.test:${web.port}`);
    assert.equal(r.status, 200, r.body);
    assert.equal(web.seen.at(-1)?.headers.host, `x.wild.test:${web.port}`);
    for (const authority of ["x.wild.test", "x.wild.test:443", `x.wild.test:${web.port + 1}`]) {
      r = await httpVia(at, authority);
      assert.equal(r.status, 403, authority);
      assert.match(r.body, new RegExp(`a port other than ${web.port}`), authority);
    }
    r = await httpVia(at, `a.test:${web.port}`);
    assert.equal(r.status, 403, "an Intercepted host of the slot is never carried by a wildcard");
  });
});

describe("the dial guard (ADR-0059)", () => {
  test("a name whose every address is guarded — loopback, the metadata address, the segment, the placeholder range — is never dialed", async () => {
    for (const name of ["loop.test", "meta.test", "seg.test", "ph.test"]) {
      const reply = await helloReply(pod.at(3, name, c.port), name);
      assert.equal(reply.length, 0, `${name}: closed with no byte`);
      await line(
        new RegExp(
          `jr2\\.custodian slot=3 sandbox=ws-3 action=refuse target=${name.replace(".", "\\.")}:${c.port} reason=guard `,
        ),
      );
    }
    const r = await httpVia(pod.at(3, "*", web.port), `loop.wild.test:${web.port}`);
    assert.equal(r.status, 403);
    assert.match(r.body, /resolves to an address that the Custodian never dials/);
  });

  test("every spelling of an address, `localhost`, and jr2's own name are refused through `*`, and none reaches a target", async () => {
    const before = web.seen.length;
    const at = pod.at(3, "*", web.port);
    for (const host of [
      "127.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[0:0:0:0:0:ffff:a9fe:a9fe]",
      "[fd00:ec2::254]",
      "169.254.169.254",
      "2130706433",
      "127.0.0.1.",
      "LOCALHOST.",
      "localhost",
      `${LAN}`,
      JR2_CUSTODIAN_NAME,
      "CUSTODIAN.JR2.INTERNAL",
    ]) {
      const r = await httpVia(at, `${host}:${web.port}`);
      assert.equal(r.status, 403, `${host}: ${r.status} ${r.body}`);
    }
    for (const servername of ["localhost", "loop.wild.test"]) {
      assert.equal((await helloReply(at, servername)).length, 0, `${servername} on TLS: closed with no byte`);
    }
    assert.equal(web.seen.length, before);
  });
});

describe("jr2's own name: the control routes and the fetch (ADR-0059, ADR-0076)", () => {
  const control = (slot: number) => ({ authorization: `Bearer ${controlStandInOf(slot)}` });
  const fetchBearer = { authorization: `Bearer ${standIn("JR2_SANDBOX_TOKEN")}` };
  /** HTTPS to `custodian.jr2.internal` of a slot, trusting that slot's CA. */
  const jr2 = (
    slot: number,
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => httpsVia(pod.at(slot, JR2_CUSTODIAN_NAME, 443), JR2_CUSTODIAN_NAME, { ca: pod.trust(slot), path, ...opts });
  const plain = (
    slot: number,
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => httpVia(pod.at(slot, JR2_CUSTODIAN_NAME, 80), JR2_CUSTODIAN_NAME, { path, ...opts });
  const agentRoutes = [
    ["/agents/ws-3%2Fbody%2Freviewer/events", "POST", '{"type":"approve"}'],
    ["/agents/ws-3%2Fbody%2Fcoder/surface", "GET", undefined],
    ["/agents/ws-3%2Fbody%2Freviewer/deliveries/d-1", "GET", undefined],
    ["/agents/ws-3%2Fbody%2Freviewer/notices", "POST", '{"heard":["n-1"]}'],
    ["/agents/ws-3%2Fbody%2Freviewer/conversation", "POST", '{"entries":[]}'],
  ] as const;

  test("the control Stand-in swaps for the slot's control token on each of the five agent routes; an encoded Instance ID stays one segment", async () => {
    for (const [path, method, body] of agentRoutes) {
      const r = await jr2(3, path, {
        method,
        headers: { ...control(3), "content-type": "application/json", "x-api-key": "stray" },
        ...(body !== undefined ? { body } : {}),
      });
      assert.equal(r.status, 200, `${method} ${path}: ${r.body}`);
      const seen = orchestrator.seen.at(-1)!;
      assert.equal(seen.url, path);
      assert.equal(seen.headers.authorization, `Bearer ${controlTokenOf(3)}`);
      assert.equal(seen.headers["x-api-key"], undefined, "no other credential rides along");
      if (body !== undefined) assert.equal(seen.body, body);
    }
  });

  test("the ask goes to THIS slot's Sandbox, with its fetch token, on 443 and on plain port 80, whatever path the caller writes", async () => {
    for (const [slot, ask] of [
      [3, jr2],
      [3, plain],
      [4, jr2],
      [4, plain],
    ] as const) {
      const r = await ask(slot, "/fetch", {
        method: "POST",
        headers: fetchBearer,
        body: '{"identity":"github.com/a/b"}',
      });
      assert.equal(r.status, 200, r.body);
      assert.equal(orchestrator.seen.at(-1)?.url, `/sandboxes/ws-${slot}/fetch`);
      assert.equal(orchestrator.seen.at(-1)?.headers.authorization, `Bearer ${fetchTokenOf(slot)}`);
    }
  });

  test("nothing else reaches the Orchestrator: another route, another method, another Sandbox, no Stand-in, another slot's Stand-in", async () => {
    const before = orchestrator.seen.length;
    for (const [path, method, headers] of [
      ["/runs/r-1", "GET", control(3)],
      ["/workflows/ping/runs", "POST", control(3)],
      ["/runs/r-1/gates/review/events", "POST", fetchBearer],
      ["/agents/x/surface", "POST", control(3)],
      ["/agents/x/deliveries", "GET", control(3)],
      ["/sandboxes/ws-4/fetch", "POST", control(3)],
      ["/agents/x/surface", "GET", {}],
      ["/agents/x/surface", "GET", { authorization: "Bearer ws-3.forged" }],
      ["/agents/x/surface", "GET", control(4)],
    ] as const) {
      for (const r of [await jr2(3, path, { method, headers }), await plain(3, path, { method, headers })]) {
        assert.ok(r.status === 404 || r.status === 403, `${method} ${path} → ${r.status}`);
      }
    }
    // Port 80 carries the fetch alone: an agent route there is 404, with the right Stand-in.
    for (const [path, method, body] of agentRoutes) {
      const r = await plain(3, path, {
        method,
        headers: { ...control(3), "content-type": "application/json" },
        ...(body ? { body } : {}),
      });
      assert.equal(r.status, 404, `${method} ${path} on port 80`);
    }
    assert.equal(orchestrator.seen.length, before);
  });

  test("the public fetch Stand-in is refused on every agent route; the control Stand-in is refused on the fetch route", async () => {
    const before = orchestrator.seen.length;
    for (const [path, method, body] of agentRoutes) {
      const r = await jr2(3, path, {
        method,
        headers: { ...fetchBearer, "content-type": "application/json" },
        ...(body ? { body } : {}),
      });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    for (const ask of [jr2, plain]) {
      const r = await ask(3, "/fetch", { method: "POST", headers: control(3), body: "{}" });
      assert.equal(r.status, 403, r.body);
    }
    assert.equal(orchestrator.seen.length, before);
  });

  test("the stated slot (X-Jr2-Slot) passes unchanged on an agent route and is removed on the fetch route", async () => {
    let r = await jr2(3, "/agents/ws-3%2Fbody%2Freviewer/surface", {
      headers: { ...control(3), "x-jr2-slot": "body/reviewer" },
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(orchestrator.seen.at(-1)?.headers["x-jr2-slot"], "body/reviewer");
    r = await jr2(3, "/fetch", {
      method: "POST",
      headers: { ...fetchBearer, "x-jr2-slot": "body/reviewer" },
      body: "{}",
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(orchestrator.seen.at(-1)?.headers["x-jr2-slot"], undefined);
  });

  test("a connection the Orchestrator closes under a read is retried; under a pick, the answer says unreachable", async () => {
    orchestrator.drop(1);
    let r = await jr2(3, "/agents/run-1/surface", { headers: control(3) });
    assert.equal(r.status, 200, r.body);
    orchestrator.drop(1);
    r = await jr2(3, "/agents/run-1/deliveries/d-1", { headers: control(3) });
    assert.equal(r.status, 200, "a poll is retried (ADR-0024)");
    const before = orchestrator.seen.length;
    orchestrator.drop(1);
    r = await jr2(3, "/agents/run-1/events", {
      method: "POST",
      headers: { ...control(3), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 502, "a pick the Orchestrator may have read is not sent twice");
    assert.equal(r.headers["x-jr2-custodian"], "unreachable");
    assert.equal(orchestrator.seen.length, before);
  });

  test("the Instance Harness's slot: its own control token; the ask gets 404 and the fetch Stand-in opens nothing", async () => {
    let r = await jr2(0, "/agents/run%2Fadvisor/surface", { headers: control(0) });
    assert.equal(r.status, 200, r.body);
    assert.equal(orchestrator.seen.at(-1)?.headers.authorization, `Bearer ${controlTokenOf(0)}`);
    const before = orchestrator.seen.length;
    r = await jr2(0, "/fetch", { method: "POST", headers: fetchBearer, body: "{}" });
    assert.ok(r.status === 403 || r.status === 404, `the ask on the Instance Harness → ${r.status}`);
    r = await jr2(0, "/agents/run%2Fadvisor/surface", { headers: control(3) });
    assert.equal(r.status, 403, "slot 3's control Stand-in on slot 0");
    assert.equal(orchestrator.seen.length, before);
  });
});

describe("the Orchestrator's dial to a Harness pod (ADR-0084, ADR-0042)", () => {
  const TOKEN = DIAL_TOKEN;
  /** One request to the inbound listener, as the Orchestrator sends it. */
  const dial = (
    target: string | undefined,
    token: string | undefined,
    opts: { path?: string; method?: string; body?: string; headers?: Record<string, string> } = {},
  ) =>
    httpVia({ host: "127.0.0.1", port: pod.ports.inbound }, "jr2-custodian", {
      path: opts.path ?? "/healthz",
      method: opts.method ?? "GET",
      headers: {
        ...(target !== undefined ? { "x-jr2-target": target } : {}),
        ...(token !== undefined ? { "x-jr2-dial": token } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
  const harnessTarget = () => `127.0.0.1:${harness.port}`;
  const slotOf3 = slotAddress(RANGES.segment, slotVlan(0, 3));

  test("no dial token, or another one → 403 with x-jr2-custodian: refused; nothing reaches the target", async () => {
    const before = harness.seen.length;
    for (const token of [undefined, "wrong", `${TOKEN}x`]) {
      const r = await dial(harnessTarget(), token);
      assert.equal(r.status, 403, String(token));
      assert.equal(r.headers["x-jr2-custodian"], "refused");
    }
    assert.equal(harness.seen.length, before);
  });

  test("a target that is no slot of this Instance, or a port other than 8080 and 8082 → 403", async () => {
    for (const target of [
      "10.1.2.3:8080",
      `${slotOf3}:8081`,
      `${slotOf3}:22`,
      "127.0.0.1:15000",
      `${LAN}:${orchestrator.port}`,
    ]) {
      const r = await dial(target, TOKEN);
      assert.equal(r.status, 403, target);
      assert.equal(r.headers["x-jr2-custodian"], "refused", target);
      assert.match(r.body, /not port 8080 or 8082 of a slot of this Instance/);
    }
  });

  test("a target that does not answer → 503 with x-jr2-custodian: unreachable and Envoy's flags", async () => {
    const r = await dial(`127.0.0.1:${closedPort}`, TOKEN);
    assert.equal(r.status, 503, r.body);
    assert.equal(r.headers["x-jr2-custodian"], "unreachable");
    assert.match(JSON.parse(r.body).flags, /UF/);
  });

  test("a slot address passes the check: the dial goes to it (here no pod answers there)", async () => {
    const r = await dial(`${slotOf3}:8080`, TOKEN);
    assert.equal(r.status, 503, r.body);
    assert.equal(r.headers["x-jr2-custodian"], "unreachable");
  });

  test("the target gets neither header of the dial; its own x-jr2-custodian is removed, so only the Custodian's answer carries it", async () => {
    harness.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-jr2-custodian": "unreachable" });
      res.end("from the pod");
    };
    const r = await dial(harnessTarget(), TOKEN, { path: "/agents/x/turn" });
    harness.handler = undefined;
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body, "from the pod");
    assert.equal(r.headers["x-jr2-custodian"], undefined);
    const seen = harness.seen.at(-1)!;
    assert.equal(seen.url, "/agents/x/turn");
    assert.equal(seen.headers["x-jr2-dial"], undefined);
    assert.equal(seen.headers["x-jr2-target"], undefined);
    await line(new RegExp(`jr2\\.custodian dial action=inbound target=127\\.0\\.0\\.1:${harness.port} .*status=200`));
    assert.doesNotMatch(pod.output(), new RegExp(TOKEN));
  });

  test("a duplex body (a Handoff carry): each chunk of the request is answered before the next one is sent", async () => {
    harness.handler = (req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      req.on("data", (d: Buffer) => res.write(`echo:${d.toString()}`));
      req.on("end", () => res.end());
    };
    const got = await new Promise<string[]>((resolve, reject) => {
      const answers: string[] = [];
      const req = httpRequest({
        host: "127.0.0.1",
        port: pod.ports.inbound,
        method: "POST",
        path: "/handoff",
        agent: false,
        headers: { "x-jr2-target": harnessTarget(), "x-jr2-dial": TOKEN, "transfer-encoding": "chunked" },
      });
      req.on("error", reject);
      req.on("response", (res: IncomingMessage) => {
        let n = 1;
        res.on("data", (d: Buffer) => {
          answers.push(d.toString());
          if (++n <= 3) req.write(`part-${n}`);
          else req.end();
        });
        res.on("end", () => resolve(answers));
      });
      req.flushHeaders();
      req.write("part-1");
    });
    harness.handler = undefined;
    assert.deepEqual(got, ["echo:part-1", "echo:part-2", "echo:part-3"]);
  });

  test("SSE through the dial: each event reaches the Orchestrator within 100 ms of the pod's write", async () => {
    const written: number[] = [];
    harness.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        written.push(Date.now());
        res.write(`data: ${n}\n\n`);
        if (++n === 5) {
          clearInterval(tick);
          res.end();
        }
      }, 300);
    };
    const arrived: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: pod.ports.inbound,
          path: "/events",
          agent: false,
          headers: { "x-jr2-target": harnessTarget(), "x-jr2-dial": TOKEN },
        },
        (res) => {
          res.on("data", () => arrived.push(Date.now()));
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });
    harness.handler = undefined;
    assert.equal(arrived.length, 5);
    for (const [i, at] of arrived.entries()) assert.ok(at - written[i]! < 100, `event ${i}: ${at - written[i]!} ms`);
  });
});

describe("the health listener (the one a peer of the cluster can reach)", () => {
  test("14. idle connections past the pod's global limit fill the health listener alone: the Menu still answers", async () => {
    // More than the slots' global limit (64 here), none of them sending a byte.
    const sockets = await Promise.all(
      Array.from(
        { length: 200 },
        () =>
          new Promise<Socket>((resolve) => {
            const s = connect(pod.ports.health, "127.0.0.1");
            s.on("error", () => {});
            s.once("connect", () => resolve(s));
            s.once("close", () => resolve(s));
          }),
      ),
    );
    try {
      await new Promise((r) => setTimeout(r, 500));
      const open = sockets.filter((s) => !s.destroyed && s.readyState === "open").length;
      assert.ok(open <= 32, `the health listener holds few connections, not ${open}`);
      const r = await httpsVia(pod.at(3, JR2_CUSTODIAN_NAME, 443), JR2_CUSTODIAN_NAME, {
        ca: pod.trust(3),
        path: "/agents/run-1/surface",
        headers: { authorization: `Bearer ${controlStandInOf(3)}` },
      });
      assert.equal(r.status, 200, r.body);
    } finally {
      for (const s of sockets) s.destroy();
    }
    assert.equal((await fetch(`http://127.0.0.1:${pod.ports.health}/healthz`)).status, 200);
  });

  test("15. a health connection that sends nothing is closed within seconds", async () => {
    const s = connect(pod.ports.health, "127.0.0.1");
    s.on("error", () => {});
    const started = performance.now();
    await new Promise((r) => s.once("close", r));
    assert.ok(performance.now() - started < 8_000, `closed after ${Math.round(performance.now() - started)} ms`);
  });
});

describe("a change of one slot's rules", () => {
  test("an update of slot 3 does not cut a stream of slot 4, and slot 3's new rule is live when the update returns", async () => {
    const written: number[] = [];
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        written.push(Date.now());
        res.write(`data: ${n}\n\n`);
        if (++n === 10) {
          clearInterval(tick);
          res.end();
        }
      }, 300);
    };
    const arrived: number[] = [];
    const stream = viaA(
      {
        headers: { "x-api-key": key("ANTHROPIC_API_KEY", 4) },
        onResponse: (res) => res.on("data", () => arrived.push(Date.now())),
      },
      4,
    );
    await new Promise((r) => setTimeout(r, 700));
    const before = await pod.listener(4);
    const grown = slot3();
    grown.manifest.egress.push(rule("extra.test", c.port, "name", false, "entry"));
    slots = [slot0, grown, slot4()];
    const ms = await pod.update(slots);
    console.log(`# one update of slot 3 in a pod of 3 slots: live in ${ms.toFixed(0)} ms`);
    assert.equal((await helloReply(pod.at(3, "extra.test", c.port), "extra.test"))[0], 0x16, "the new rule carries");
    const r = await stream;
    a.handler = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
    assert.equal(r.status, 200);
    assert.equal(arrived.length, 10, `each event of slot 4's stream arrived (${arrived.length})`);
    assert.deepEqual(await pod.listener(4), before, "slot 4's listener was not updated");
  });

  test("11. a slot whose value cannot ride a header is refused, with a line that names the secret and not the value; the other slots serve", async () => {
    const broken: RigSlot = {
      slot: 5,
      owner: { sandbox: "ws-5" },
      manifest: {
        version: 1,
        secrets: [binding("BROKEN_KEY", "a.test", a.port, ["x-api-key"])],
        egress: [rule("a.test", a.port, "name", true, "held")],
      },
      values: { BROKEN_KEY: "abc\rdef" },
    };
    await assert.rejects(pod.update([...slots, broken]), /slot 5/);
    await line(/jr2\.custodian refuse secret=BROKEN_KEY reason=value-not-printable-ascii/);
    assert.ok(!pod.output().includes("abc\rdef") && !/abc.def/.test(pod.output()), "the value is not in the log");
    assert.equal((await pod.listener(5)).fingerprint, undefined, "slot 5 has no live rules");
    const r = await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY") } });
    assert.equal(r.status, 200, r.body);
  });
});

describe("the log", () => {
  test("12. the log holds names, never a value, a token or a Stand-in", async () => {
    const out = pod.output();
    assert.match(
      out,
      new RegExp(
        `jr2\\.custodian slot=3 sandbox=ws-3 action=intercept target=a\\.test:${a.port} secret=ANTHROPIC_API_KEY .*method=GET status=200`,
      ),
    );
    assert.match(out, /jr2\.custodian slot=3 sandbox=ws-3 action=tunnel target=/);
    assert.match(out, /jr2\.custodian slot=0 pod=instance action=intercept target=orchestrator /);
    const secrets = [
      ...Object.values(VALUES),
      SLOT4_KEY,
      ...[0, 3, 4].flatMap((s) => [controlTokenOf(s), controlStandInOf(s), fetchTokenOf(s)]),
      DIAL_TOKEN,
    ];
    for (const value of secrets) {
      assert.ok(!out.includes(value), `a value in the log: ${value.slice(0, 6)}…`);
      assert.ok(!out.includes(Buffer.from(value).toString("base64")), "a base64 value in the log");
    }
    assert.ok(!out.includes("jr2-held-"), "a Stand-in in the log");
  });
});

describe("a real client", () => {
  test("13. the Anthropic SDK streams through the Custodian with no proxy setting: the Fence brings it there, and NODE_EXTRA_CA_CERTS trusts the slot's CA", async () => {
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "m1",
              type: "message",
              role: "assistant",
              model: "m",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ] as const;
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    };
    const dir = await mkdtemp(join(tmpdir(), "jr2-custodian-sdk-"));
    try {
      const ca = join(dir, "extra.crt");
      await writeFile(ca, pod.trust(3));
      // The Fence, for this one process: a connection to `a.test` reaches the slot's listener at the
      // name's placeholder, as the resolver and the uplink bring it there in a pod. TLS, its name and
      // its trust are Node's own (`NODE_EXTRA_CA_CERTS`); the SDK gets no proxy and no agent.
      const to = pod.at(3, "a.test", a.port);
      const script = `
        import Anthropic from "@anthropic-ai/sdk";
        import tls from "node:tls";
        const connect = tls.connect;
        tls.connect = (...args) => {
          const o = typeof args[0] === "object" ? args[0] : {};
          if (o.servername === "a.test" || o.host === "a.test") return connect({ ...o, host: ${JSON.stringify(to.host)}, port: ${to.port}, servername: "a.test" }, args[1]);
          return connect(...args);
        };
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.BASE, maxRetries: 0 });
        const stream = await client.messages.create({ model: "m", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] });
        let text = "";
        for await (const e of stream) if (e.type === "content_block_delta") text += e.delta.text;
        console.log(text);`;
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          cwd: join(import.meta.dirname, ".."),
          env: {
            PATH: process.env.PATH,
            ANTHROPIC_API_KEY: key("ANTHROPIC_API_KEY"),
            BASE: `https://a.test:${a.port}`,
            NODE_EXTRA_CA_CERTS: ca,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
        child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
        child.on("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
      });
      assert.equal(out, "pong");
      assert.equal(a.seen.at(-1)?.headers["x-api-key"], VALUES.ANTHROPIC_API_KEY);
    } finally {
      a.handler = (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      };
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("time to the first SSE event: through the Custodian against direct (median of 20)", async () => {
    a.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.end();
    };
    const first = async (through: boolean): Promise<number> => {
      const start = performance.now();
      let at = 0;
      const onResponse = (res: IncomingMessage) => res.once("data", () => (at = performance.now()));
      const direct: Dialed = { host: a.host, port: a.port };
      if (through) await viaA({ headers: { "x-api-key": key("ANTHROPIC_API_KEY") }, onResponse });
      else await httpsVia(direct, "a.test", { authority: `a.test:${a.port}`, ca: a.ca.cert, onResponse });
      return at - start;
    };
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const through: number[] = [];
    const direct: number[] = [];
    for (let i = 0; i < 20; i++) {
      through.push(await first(true));
      direct.push(await first(false));
    }
    console.log(
      `# first SSE event: through the Custodian ${median(through).toFixed(1)} ms, direct ${median(direct).toFixed(1)} ms`,
    );
    assert.ok(median(through) < 250);
  });
});

describe("one update at full size (risk 4 of the plan)", () => {
  test("128 slots of 30 entries, 5 of them Intercepted with a bound secret: one slot's change is live within 500 ms", async () => {
    const grow = (m: HeldManifest, round: number): HeldManifest => ({
      ...m,
      egress: [...m.egress, rule(`grown-${round}.example.com`, 443, "name", false, "entry") as EgressRule],
    });
    const { ms, ldsBytes, allocated } = await timeUpdates(manySlots(128, 30, 5), 5, grow);
    const sorted = [...ms].sort((x, y) => x - y);
    console.log(
      `# one update of 1 slot of 128 x 30 (5 Intercepted), LDS ${ldsBytes} bytes: ${ms.map((x) => x.toFixed(0)).join(", ")} ms; median ${sorted[2]!.toFixed(0)} ms, max ${sorted.at(-1)!.toFixed(0)} ms; Envoy allocated ${Math.round((allocated ?? 0) / 2 ** 20)} MiB`,
    );
    assert.ok(sorted[2]! < 500, `median ${sorted[2]!.toFixed(0)} ms`);
  });
});
