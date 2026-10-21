// The Effector's wire from the Orchestrator's side (ADR-0068): the golden fixtures the Go tests
// read too (`effector/testdata/wire/`), and the signed client against an in-process fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import {
  createEffectorClient,
  DispatchOutputShape,
  DispatchStartShape,
  EffectorForged,
  EffectorNotSent,
  EffectorRefused,
  EffectStateShape,
  RefusalShape,
  requestMac,
  StartRequestShape,
  responseMac,
  type EffectorTransport,
} from "../src/effector-wire.ts";
import { basic, bearer, file, httpParts, secret, startRequestOf, text } from "../src/http-effect.ts";
import type { CommandParts } from "../src/effect.ts";
import {
  commandEnvParts,
  commandStartOf,
  pushParts,
  pushStartOf,
  fileStartOf,
  type CommandEnv,
} from "../src/sandbox-effect.ts";
import { effectorKey } from "../src/tokens.ts";
import { dispatchParts, dispatchStartOf } from "../src/dispatch-effect.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";

/** The fixtures, by the relative path the ADR names: one directory both languages read. */
const FIXTURES = fileURLToPath(new URL("../../../effector/testdata/wire/", import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const named = (prefix: string): string[] => readdirSync(FIXTURES).filter((f) => f.startsWith(prefix));

test("the golden signatures: a request and an answer signed as the Go side signs them", () => {
  const req = fixture("signature.request.json") as Record<string, string>;
  const key = Buffer.from(req.key!, "base64");
  assert.equal(requestMac(key, req.method!, req.address!, req.path!, req.time!, req.nonce!, req.body!), req.signature);
  const res = fixture("signature.response.json") as {
    key: string;
    status: number;
    method: string;
    path: string;
    nonce: string;
    body: string;
    signature: string;
  };
  assert.equal(
    responseMac(Buffer.from(res.key, "base64"), res.status, res.method, res.path, res.nonce, res.body),
    res.signature,
  );
});

test("every request fixture is what a definition encodes", () => {
  const cases: Record<string, unknown> = {
    "request.get-minimal.json": startRequestOf(
      httpParts({ method: "GET", url: "https://api.example.com/v1/status" }),
      {},
    ),
    "request.post-json-bearer.json": startRequestOf(
      httpParts({
        method: "POST",
        url: "https://jira.example.com/rest/api/2/issue",
        headers: { accept: "application/json" },
        auth: bearer(secret("jira")),
        input: z.object({ key: z.string(), body: z.string() }),
      }),
      { path: ["PROJ-7", "comment"], json: { body: "Tests pass.", visibility: null, labels: ["ci", 1, true] } },
    ),
    "request.basic-secret-in-url.json": startRequestOf(
      httpParts({
        method: "PUT",
        url: text`https://api.telegram.org/bot${secret("telegram")}/sendMessage`,
        auth: basic("bot", secret("telegram-password")),
        timeout: "5s",
        maxBody: 1024,
      }),
      { text: "hello, world\n" },
    ),
    "request.auth-text-and-secret-header.json": startRequestOf(
      httpParts({
        method: "DELETE",
        url: "http://echo.jr2-seed.svc:8080/items",
        headers: { "x-api-key": text`${secret("api-key")}`, "x-trace": text`run ${"42"}` },
        auth: text`Token ${secret("api-key")} v2`,
        timeout: "10m",
        maxBody: 1,
      }),
      { path: ["a/b", "ü ñ", "%2e%2e", ".."] },
    ),
    // The Sandbox Effector's kinds (ADR-0067).
    "request.push-signed.json": pushStartOf(
      pushParts({ sign: true }),
      repo("git@github.com:ourorg/app.git"),
      "jr2/run-1",
      {},
      [{ published: "2".repeat(40), source: "1".repeat(40) }],
    ),
    // Every pair of the Repo Slot, oldest first; an unsigned squash's `squashed` rides beside its pair.
    "request.push-pairs.json": pushStartOf(
      pushParts({ sign: true }),
      repo("git@github.com:ourorg/app.git"),
      "jr2/run-1",
      {},
      [
        { published: "2".repeat(40), source: "1".repeat(40), squashed: "unsigned" },
        { published: "4".repeat(40), source: "3".repeat(40) },
      ],
    ),
    "request.push-pinned-squash.json": pushStartOf(
      pushParts({ pin: true, sign: true, squash: true, force: true }),
      repo("https://github.com/ourorg/app.git"),
      "jr2/run-1",
      { sha: "1".repeat(40), message: "Add the report" },
    ),
    "request.command-env.json": commandStartOf(
      commandParts(["terraform", "apply", "-auto-approve"], {
        AWS_SECRET: secret("aws"),
        KUBECONFIG: secret("kube").path,
      }),
      ["terraform", "apply", "-auto-approve"],
      repo("https://github.com/ourorg/app.git"),
      "jr2/run-1",
    ),
    "request.http-file-body.json": fileStartOf(
      httpParts({
        method: "PUT",
        url: "https://files.example.com/reports",
        auth: bearer(secret("files")),
        body: file("dist/report.pdf", { contentType: "application/pdf" }),
      }),
      "app/jr2-run-1",
      { path: "dist/report.pdf" },
    ),
    // The dispatch kind (ADR-0071): a foreign start, its body whole, the token by name, the key.
    "request.dispatch-start.json": dispatchStartOf(
      dispatchParts("review", { target: { url: "https://ops.example.com/", token: secret("ops-instance") } }),
      { ticket: "PROJ-7", note: null, labels: ["ci", 1, true] },
      {
        run: "0b7e3c1a-5d2f-4e8b-9c6a-1f2e3d4c5b6a",
        slot: "review",
        effect: "3f1c7a52-1b2d-4c8e-9a0f-6b5d4e3c2a19",
        depth: 1,
        instance: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      },
    ),
    "request.dispatch-wait.json": dispatchStartOf(
      dispatchParts("task/review-loop", {
        wait: true,
        target: { url: "http://jr2-orchestrator.jr2-e2e.svc:4000", token: secret("self-token") },
      }),
      { repo: "https://github.com/ourorg/app.git", branch: "jr2/run-1" },
      {
        run: "0b7e3c1a-5d2f-4e8b-9c6a-1f2e3d4c5b6a",
        slot: "loop",
        effect: "7d2e9b40-3c1f-4a6d-8e5b-2a9c0f1e3d47",
        depth: 2,
        instance: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      },
    ),
  };
  assert.deepEqual(named("request.").sort(), Object.keys(cases).sort(), "one case per request fixture");
  for (const [name, encoded] of Object.entries(cases)) {
    assert.deepEqual(JSON.parse(JSON.stringify(encoded)), normalize(fixture(name)), name);
  }
});

/** A Repo Slot's repositories as the request fixtures name them. */
function repo(url: string) {
  return { gitDir: "app/default/.git", worktree: "app/jr2-run-1", cache: "app-14189a29", url };
}

/** A credentialed command's parts, as `command(argv, { env })` builds them. */
function commandParts(argv: string[], env: CommandEnv): CommandParts {
  return { kind: "command", argv, timeoutMs: 600_000, tail: 4096, ...commandEnvParts(env) };
}

/** The fixture `x-trace` header is two literal parts; the `text` template joins adjacent text. */
function normalize(v: unknown): unknown {
  const req = v as { headers?: Record<string, Array<{ text?: string; secret?: string }>> };
  for (const parts of Object.values(req.headers ?? {})) {
    for (let i = parts.length - 1; i > 0; i--) {
      if (parts[i]!.text !== undefined && parts[i - 1]!.text !== undefined) {
        parts[i - 1]!.text += parts[i]!.text!;
        parts.splice(i, 1);
      }
    }
  }
  return v;
}

test("the request's zod shape, which its type is inferred from, takes every request fixture and refuses each reject", () => {
  const requests = named("request.");
  assert.ok(requests.length > 0);
  for (const name of requests) {
    const parsed = StartRequestShape.safeParse(fixture(name));
    assert.ok(parsed.success, name);
    assert.deepEqual(parsed.data, fixture(name), name);
  }
  const rejects = named("reject.request");
  assert.ok(rejects.length > 0);
  for (const name of rejects) assert.ok(!StartRequestShape.safeParse(fixture(name)).success, name);
  // What a definition encodes is the shape's too.
  const encoded = startRequestOf(
    httpParts({ method: "POST", url: text`https://api.example.com/a`, auth: basic("bot", secret("pw")) }),
    { json: { n: 1 } },
  );
  assert.ok(StartRequestShape.safeParse(JSON.parse(JSON.stringify(encoded))).success);
});

test("a header the Effector refuses is one the definition refuses when the Machine loads: one reject fixture per name", () => {
  const rejects = named("reject.request-header-");
  assert.ok(rejects.length >= 9);
  for (const name of rejects) {
    const headers = (fixture(name) as { headers: Record<string, unknown> }).headers;
    for (const header of Object.keys(headers)) {
      assert.throws(
        () => httpParts({ method: "GET", url: "https://api.example.com/v1", headers: { [header]: "x" } }),
        /is not a header an Effect sets/,
        `${name}: ${header}`,
      );
    }
  }
});

test("every answer fixture decodes strictly; every reject fixture is refused", () => {
  for (const name of named("response.")) {
    const shape = name.includes("refusal") ? RefusalShape : EffectStateShape;
    assert.ok(shape.safeParse(fixture(name)).success, name);
  }
  for (const name of named("reject.response")) {
    assert.ok(!EffectStateShape.safeParse(fixture(name)).success, name);
  }
});

test("a dispatch's answers decode as a dispatch's outcome set, and its `refused` is told from an http one by its fields", () => {
  const outcomes: Record<string, string> = {
    "response.settled-dispatch-started.json": "started",
    "response.settled-dispatch-settled.json": "settled",
    "response.settled-dispatch-refused.json": "refused",
    "response.settled-dispatch-unreachable.json": "unreachable",
  };
  assert.deepEqual(named("response.settled-dispatch-").sort(), Object.keys(outcomes).sort());
  for (const [name, outcome] of Object.entries(outcomes)) {
    const state = EffectStateShape.parse(fixture(name));
    assert.deepEqual(state, fixture(name), name);
    const output = DispatchOutputShape.parse(state.output);
    assert.equal(output.outcome, outcome, name);
  }
  // The callee's output passes through whole, whatever its JSON.
  const settled = DispatchOutputShape.parse(
    (fixture("response.settled-dispatch-settled.json") as { output: unknown }).output,
  );
  assert.deepEqual((settled as { output: unknown }).output, {
    verdict: "approve",
    notes: ["[secret:ops-instance]"],
    score: 0.9,
    extra: null,
  });
  // An http `refused` has a reason; a dispatch's has the door's status and report.
  const http = (fixture("response.settled-refused.json") as { output: unknown }).output;
  assert.ok(!DispatchOutputShape.safeParse(http).success);
  assert.ok(!DispatchOutputShape.safeParse({ outcome: "refused", status: 400, reason: "x" }).success);
  // A settled status is one the Machine's type names: another word is malformed, never output.
  for (const status of ["done", "error", "cancelled", "lost", "drifted", "live"]) {
    assert.ok(DispatchOutputShape.safeParse({ outcome: "settled", run: "r", status }).success, status);
  }
  for (const status of ["active", "stopped", ""]) {
    assert.ok(!DispatchOutputShape.safeParse({ outcome: "settled", run: "r", status }).success, status);
  }
});

test("a dispatch start's shape refuses a url that is not an origin, a name `jr2 run` would not take, and no caller instance", () => {
  const good = fixture("request.dispatch-start.json") as Record<string, unknown>;
  assert.ok(DispatchStartShape.safeParse(good).success);
  for (const url of ["https://ops.example.com/x", "https://u:p@ops.example.com", "https://ops.example.com?a=1"]) {
    assert.ok(!StartRequestShape.safeParse({ ...good, url: [{ text: url }] }).success, url);
  }
  assert.ok(!StartRequestShape.safeParse({ ...good, url: [{ text: "https://a" }, { secret: "s" }] }).success);
  for (const workflow of ["", "Review", "a/b/c", "../x"]) {
    assert.ok(!StartRequestShape.safeParse({ ...good, workflow }).success, workflow);
  }
  const { instance: _instance, ...by } = good.dispatchedBy as Record<string, unknown>;
  assert.ok(!StartRequestShape.safeParse({ ...good, dispatchedBy: by }).success);
});

test("the placement's key is derived, as the Harness bearer is: the same signing key gives the same key", () => {
  const signing = Buffer.alloc(32, 7);
  assert.equal(effectorKey(signing, "instance"), effectorKey(signing, "instance"));
  assert.notEqual(effectorKey(signing, "instance"), effectorKey(signing, "sandbox-a"));
  assert.notEqual(effectorKey(signing, "instance"), effectorKey(Buffer.alloc(32, 8), "instance"));
});

const req = startRequestOf(httpParts({ method: "GET", url: "https://api.example.com" }), {});
const signal = new AbortController().signal;

test("the client starts on a replica, which its answer names, and polls that replica", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const client = createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });
  const started = await client.start("e1", req, signal);
  assert.equal(started.state, "running");
  const holder = fake.starts[0]!.replica;
  assert.equal(started.replica.name, holder);
  fake.settle({ outcome: "unknown", reason: "r" });
  const polled = await client.poll(started.replica, "e1", signal);
  assert.equal(polled.state, "settled");
  assert.ok(fake.calls.filter((c) => c.method === "GET").every((c) => c.address === started.replica.address));
});

test("a start is signed for the replica it is sent to: the same request sent to another replica is refused", async () => {
  const fake = new FakeEffector(["a", "b"]);
  const sent: Array<Parameters<EffectorTransport["send"]>> = [];
  const recording: EffectorTransport = {
    replicas: fake.transport.replicas,
    send: (...args) => {
      sent.push(args);
      return fake.transport.send(...args);
    },
  };
  const client = createEffectorClient({ key: EFFECTOR_KEY, transport: recording });
  const started = await client.start("e1", req, signal);
  const [address, method, path, headers, body] = sent.find((s) => s[1] === "POST")!;
  assert.equal(address, started.replica.address);
  const other = fake.replicas.find((r) => r.address !== address)!;
  const replayed = await fake.transport.send(other.address, method, path, headers, body, signal);
  assert.equal(replayed.status, 401, "another replica refuses a start signed for the first");
  assert.equal(fake.starts.length, 1, "the one Effect started once");
});

test("find asks every replica: the one that holds it, or none", async () => {
  const fake = new FakeEffector(["a", "b", "c"]);
  const client = createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });
  await client.start("e1", req, signal);
  const found = await client.find("e1", signal);
  assert.equal(found?.replica.name, fake.starts[0]!.replica);
  assert.equal(await client.find("nobody", signal), undefined);
  assert.equal(fake.calls.filter((c) => c.method === "GET" && c.path === "/effects/nobody").length, 3);
});

test("a stopping replica starts nothing, and another takes it; none left is EffectorNotSent", async () => {
  const fake = new FakeEffector(["a", "b"]);
  fake.replica("a").stopping = true;
  const client = createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });
  const started = await client.start("e1", req, signal);
  assert.equal(started.replica.name, "b");
  fake.replica("b").stopping = true;
  await assert.rejects(client.start("e2", req, signal), EffectorNotSent);
  fake.replica("a").down = true;
  fake.replica("b").down = true;
  await assert.rejects(client.start("e3", req, signal), EffectorNotSent);
});

test("an answer that is not the Effector's signed answer is forged; a 400 is a refusal", async () => {
  const wrongKey = new FakeEffector(["a"], "another-key-entirely");
  await assert.rejects(
    createEffectorClient({ key: EFFECTOR_KEY, transport: wrongKey.transport }).start("e1", req, signal),
    EffectorForged,
  );
  const impostor: EffectorTransport = {
    replicas: async () => ["10.0.0.9:8082"],
    send: async () => ({
      status: 202,
      headers: {},
      body: '{"effect":"e1","replica":{"name":"x","address":"y"},"state":"running"}',
    }),
  };
  await assert.rejects(
    createEffectorClient({ key: EFFECTOR_KEY, transport: impostor }).start("e1", req, signal),
    EffectorForged,
  );
  const refusing: EffectorTransport = {
    replicas: async () => ["10.0.0.1:8082"],
    send: async (_a, method, path, headers) => {
      const body = '{"error":"the request is malformed: x"}';
      return {
        status: 400,
        headers: { "x-jr2-signature": responseMac(EFFECTOR_KEY, 400, method, path, headers["x-jr2-nonce"]!, body) },
        body,
      };
    },
  };
  await assert.rejects(
    createEffectorClient({ key: EFFECTOR_KEY, transport: refusing }).start("e1", req, signal),
    EffectorRefused,
  );
});
