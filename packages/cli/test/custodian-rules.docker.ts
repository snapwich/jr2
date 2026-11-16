// The pinned Envoy validates what the renderer of the Custodian of an Instance writes (ADR-0084):
// the pod's bootstrap, and the LDS and CDS files of three slots — the Instance Harness, a check pod
// and a Sandbox with each kind of rule. `envoy --mode validate` builds each listener, each cluster,
// each TLS context and each Lua filter, so it reads the leaves, the program and each slot's table
// from the paths the renderer names. The files are laid out as the Custodian pod mounts them.
//
// Then the pinned Envoy RUNS one slot's rules, for the claims that the shape of a file cannot show:
// the Host's port on a wildcard, other spellings of a refused name, the headers a target gets, the
// dial listener's log, and the Orchestrator's dial when the program fails. The Custodian suite of
// M4 runs the rest of the new shape.
//
// Opt-in: `just custodian-test` (docker + the pinned image), beside the Custodian suite.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { duplexPair } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
  CUSTODIAN_DIAL_TOKEN,
  CUSTODIAN_POD_ARGS,
  CUSTODIAN_POD_BOOTSTRAP,
  CUSTODIAN_POD_CONFIG,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_PROGRAM,
  CUSTODIAN_STATE,
  CUSTODIAN_LDS,
  CUSTODIAN_CDS,
  custodianPodBootstrap,
  custodianRef,
  custodianXds,
  emptyPlaceholders,
  JR2_CUSTODIAN_NAME,
  leafStem,
  placeholderOf,
  renderSlot,
  slotFolder,
  withPlaceholders,
  type SlotInputs,
} from "@jr2/orchestrator/internal";
import { RANGES, rule, THREE_SLOTS } from "./support/custodian-slots.ts";
import { issueCa, issueLeaf, trustBundles } from "../src/held-pki.ts";

const exec = promisify(execFile);
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "jr2-custodian-rules-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Where a path of the pod lands in `dir`: `/etc/jr2/...` under `etc/`, the state folder under `state/`. */
function local(path: string, root = dir): string {
  if (path.startsWith(CUSTODIAN_STATE)) return join(root, "state", path.slice(CUSTODIAN_STATE.length));
  return join(root, "etc", path.slice("/etc/jr2".length));
}

async function putIn(path: string, text: string, root = dir): Promise<void> {
  await mkdir(dirname(local(path, root)), { recursive: true });
  await writeFile(local(path, root), text, { mode: 0o644 });
}
const put = (path: string, text: string) => putIn(path, text);

/** The files of one slot: its Lua table, a value and a Stand-in for each name the table reads, and a
 * leaf for each Intercepted host. */
async function slotFiles(inputs: SlotInputs, ca: ReturnType<typeof issueCa>, root = dir): Promise<void> {
  const put = (path: string, text: string) => putIn(path, text, root);
  const rules = renderSlot(inputs);
  await put(rules.lua.path, rules.lua.text);
  const names = ["JR2_CONTROL_TOKEN", "JR2_SANDBOX_TOKEN", ...inputs.manifest.secrets.map((s) => s.name)];
  for (const name of names) {
    await put(`${slotFolder(inputs.slot)}/values/${name}`, `value-of-${name}\n`);
    await put(`${slotFolder(inputs.slot)}/values/${name}.standin`, `jr2-held-${name}.test\n`);
  }
  const intercepted = [
    { host: JR2_CUSTODIAN_NAME, port: 443 },
    ...inputs.manifest.egress.filter((r) => r.intercept && r.port !== 80),
  ];
  for (const { host, port } of intercepted) {
    const leaf = issueLeaf(ca, host);
    await put(`${slotFolder(inputs.slot)}/tls/${leafStem(host, port)}.crt`, leaf.cert);
    await put(`${slotFolder(inputs.slot)}/tls/${leafStem(host, port)}.key`, leaf.key);
  }
}

async function validate(bootstrap: string): Promise<{ code: number; output: string }> {
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "-v",
    `${join(dir, "etc")}:/etc/jr2:ro`,
    "-v",
    `${join(dir, "state")}:${CUSTODIAN_STATE}:ro`,
    "--user",
    `65532:${process.getgid?.() ?? 0}`,
    custodianRef(),
    "--mode",
    "validate",
    "-c",
    bootstrap,
    "--log-level",
    "warning",
  ];
  try {
    const { stdout, stderr } = await exec("docker", args, { maxBuffer: 1 << 24 });
    return { code: 0, output: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("the pinned Envoy validates the Custodian pod's bootstrap with the LDS and CDS of three slots, and each slot's chains built inline (ADR-0084)", async () => {
  const ca = issueCa("custodian-rules");
  for (const inputs of THREE_SLOTS) await slotFiles(inputs, ca);
  await put(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM);
  await put(`/etc/jr2/ca/upstream.crt`, trustBundles(ca.cert).upstream);

  const slots = THREE_SLOTS.map(renderSlot);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "jr2-orchestrator.ns.svc", port: 4000 },
    range: 3,
    ranges: RANGES,
  });
  const { lds, cds } = custodianXds(slots);
  await put(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap));
  await put(CUSTODIAN_LDS, JSON.stringify(lds));
  await put(CUSTODIAN_CDS, JSON.stringify(cds));

  // The same slot listeners and clusters as static resources: validate mode builds each one, with
  // its TLS contexts and Lua filters, whether or not it reads the watched files.
  const inline = structuredClone(bootstrap) as {
    dynamic_resources?: unknown;
    static_resources: { listeners: unknown[]; clusters: unknown[] };
  };
  delete inline.dynamic_resources;
  const strip = ({ "@type": _, ...rest }: Record<string, unknown>) => rest;
  inline.static_resources.listeners.push(...(lds.resources as Record<string, unknown>[]).map(strip));
  inline.static_resources.clusters.push(...(cds.resources as Record<string, unknown>[]).map(strip));
  await put(`${CUSTODIAN_POD_CONFIG}/inline.json`, JSON.stringify(inline));

  const pod = await validate(CUSTODIAN_POD_BOOTSTRAP);
  assert.equal(pod.code, 0, `the pod's bootstrap:\n${pod.output}`);
  assert.match(pod.output, /configuration '.*' OK/);
  const all = await validate(`${CUSTODIAN_POD_CONFIG}/inline.json`);
  assert.equal(all.code, 0, `the slots inline:\n${all.output}`);
  assert.match(all.output, /configuration '.*' OK/);
});

// ---- the slot's rules, run ----------------------------------------------------------------------

const docker = (...args: string[]) => exec("docker", args, { maxBuffer: 1 << 24 }).then((r) => r.stdout.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The address of a container on each of its networks. */
async function addresses(container: string): Promise<Record<string, string>> {
  const nets = JSON.parse(await docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", container)) as Record<
    string,
    { IPAddress: string }
  >;
  return Object.fromEntries(Object.entries(nets).map(([n, v]) => [n, v.IPAddress]));
}

/** One HTTP/1.1 request as written, and the whole answer as text. */
function rawHttp(host: string, port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s: Socket = connect(port, host);
    s.setTimeout(10_000, () => s.destroy());
    s.on("data", (d: Buffer) => chunks.push(d));
    s.on("error", () => {});
    s.on("close", () => resolve(Buffer.concat(chunks).toString()));
    s.write(request);
  });
}

const get = (host: string, port: number, authority: string, target = "/", extra = "") =>
  rawHttp(host, port, `GET ${target} HTTP/1.1\r\nHost: ${authority}\r\n${extra}Connection: close\r\n\r\n`);

/** What a TLS client that sends `servername` (none when undefined) gets back for its hello: the
 * first bytes the Custodian sends, a TLS alert (0x15) or a server hello (0x16), or nothing. */
async function helloReply(host: string, port: number, servername?: string): Promise<Buffer> {
  const [inner, outer] = duplexPair();
  const s = connect(port, host);
  const chunks: Buffer[] = [];
  outer.on("data", (d: Buffer) => s.write(d));
  s.on("data", (d: Buffer) => chunks.push(d));
  s.on("error", () => {});
  const client = tlsConnect({ socket: inner, host: "127.0.0.1", servername, rejectUnauthorized: false });
  client.on("error", () => {});
  await new Promise<void>((resolve) => {
    s.on("close", () => resolve());
    setTimeout(resolve, 3_000);
  });
  s.destroy();
  client.destroy();
  return Buffer.concat(chunks);
}

/** A plain target of the pinned image itself: ports 80, 6379 and 443 (TLS, with `cert`) answer 200
 * with their port and the forwarding headers that the request arrived with. */
function targetBootstrap(): unknown {
  const listener = (port: number, tls: boolean) => ({
    name: `p${port}`,
    address: { socket_address: { address: "0.0.0.0", port_value: port } },
    filter_chains: [
      {
        ...(tls
          ? {
              transport_socket: {
                name: "envoy.transport_sockets.tls",
                typed_config: {
                  "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
                  common_tls_context: {
                    tls_certificates: [
                      {
                        certificate_chain: { filename: "/etc/target/tls.crt" },
                        private_key: { filename: "/etc/target/tls.key" },
                      },
                    ],
                  },
                },
              },
            }
          : {}),
        filters: [
          {
            name: "envoy.filters.network.http_connection_manager",
            typed_config: {
              "@type":
                "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
              stat_prefix: `p${port}`,
              generate_request_id: false,
              skip_xff_append: true,
              local_reply_config: {
                body_format: {
                  text_format_source: {
                    inline_string:
                      `port=${port} xfp=%REQ(X-FORWARDED-PROTO)% xff=%REQ(X-FORWARDED-FOR)% ` +
                      "rid=%REQ(X-REQUEST-ID)% xei=%REQ(X-ENVOY-INTERNAL)% fence=%REQ(X-JR2-FENCE-SLOT)%\n",
                  },
                },
              },
              http_filters: [
                {
                  name: "envoy.filters.http.router",
                  typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" },
                },
              ],
              route_config: {
                virtual_hosts: [
                  {
                    name: "all",
                    domains: ["*"],
                    routes: [{ match: { prefix: "/" }, direct_response: { status: 200 } }],
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  return { static_resources: { listeners: [listener(80, false), listener(6379, false), listener(443, true)] } };
}

test("the pinned Envoy runs a slot's rules: a wildcard on port 80 dials port 80 alone, a wildcard carries no Intercepted host in another spelling, no target gets a forwarding header, and the Orchestrator's dial fails closed (ADR-0084, ADR-0059)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-run-"));
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const [netA, netB] = [`jr2-crules-a-${tag}`, `jr2-crules-b-${tag}`];
  const [targetName, custodianName] = [`jr2-crules-target-${tag}`, `jr2-crules-custodian-${tag}`];
  t.after(async () => {
    await docker("rm", "-f", targetName, custodianName).catch(() => {});
    await docker("network", "rm", netA, netB).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const gid = String(process.getgid?.() ?? 0);
  const user = ["--user", `65532:${gid}`, "--group-add", gid, "--read-only", "--cap-drop", "ALL"];
  await docker("network", "create", netA);
  await docker("network", "create", netB);

  // The target: `other.test` (no entry names it: `*` carries it) and `secure.test` (Intercepted).
  const ca = issueCa("custodian-rules-run");
  const targetCa = issueCa("custodian-rules-target");
  const targetLeaf = issueLeaf(targetCa, "secure.test");
  await mkdir(join(root, "target"), { recursive: true });
  await writeFile(join(root, "target", "envoy.json"), JSON.stringify(targetBootstrap()), { mode: 0o644 });
  await writeFile(join(root, "target", "tls.crt"), targetLeaf.cert, { mode: 0o644 });
  await writeFile(join(root, "target", "tls.key"), targetLeaf.key, { mode: 0o644 });
  // prettier-ignore
  await docker(
    "run", "-d", "--name", targetName, "--network", netA,
    "--network-alias", "other.test", "--network-alias", "secure.test",
    ...user, "-v", `${join(root, "target")}:/etc/target:ro`,
    custodianRef(), "-c", "/etc/target/envoy.json", "--log-level", "warning",
  );

  // One Sandbox slot: `*` on 443 and 80, and `secure.test:443` Intercepted with no secret.
  const egress = [
    rule("*", 443, "any", false, "entry"),
    rule("*", 80, "any", false, "entry"),
    rule("secure.test", 443, "name", true, "entry"),
  ];
  const placeholders = withPlaceholders(emptyPlaceholders(RANGES.placeholders), egress);
  const inputs: SlotInputs = {
    slot: 3,
    owner: { sandbox: "probe" },
    manifest: { version: 1, secrets: [], egress },
    placeholders,
    ranges: RANGES,
  };
  const slot = renderSlot(inputs);
  await slotFiles(inputs, ca, root);
  await putIn(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM, root);
  await putIn("/etc/jr2/ca/upstream.crt", trustBundles(ca.cert, targetCa.cert).upstream, root);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  }) as { static_resources: { listeners: Array<Record<string, any>> } };
  // A program that raises on the Orchestrator's dial: its target table is broken on purpose, so the
  // dial meets an error after the token check passed.
  const inbound = bootstrap.static_resources.listeners.find((l) => l.name === "inbound")!;
  const source = inbound.filter_chains[0].filters[0].typed_config.http_filters[0].typed_config.default_source_code;
  source.inline_string = (source.inline_string as string).replace("dofile(", "HELD.inbound.targets = 5\ndofile(");
  await putIn(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap), root);
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await putIn(CUSTODIAN_LDS, empty, root);
  await putIn(CUSTODIAN_CDS, empty, root);

  // prettier-ignore
  await docker(
    "create", "--name", custodianName, "--network", netA, ...user,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  );
  await docker("network", "connect", netB, custodianName);
  let output = "";
  const child = spawn("docker", ["start", "-a", custodianName], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));
  t.after(() => void child.kill());

  const target = (await addresses(targetName))[netA]!;
  let custodian: Record<string, string> = {};
  for (let i = 0; i < 100 && !(custodian[netA] && custodian[netB]); i++) {
    custodian = await addresses(custodianName).catch(() => ({}));
    await sleep(100);
  }
  const [any, secure] = [custodian[netA]!, custodian[netB]!];
  assert.ok(any && secure, `the Custodian has an address on each network: ${JSON.stringify(custodian)}`);

  // The uplink sends a slot's connection to port 20000 + slot whatever address was dialed. Here a
  // client dials the Custodian's own address, so the slot's listener takes ports 80 and 443, and
  // the placeholders of `*` and `secure.test` become the Custodian's two addresses.
  const moved = (text: string, from: string, to: string) =>
    text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`);
  let lds = JSON.stringify(custodianXds([slot]).lds);
  lds = moved(lds, placeholderOf(placeholders, "*")!, any);
  lds = moved(lds, placeholderOf(placeholders, "secure.test")!, secure);
  const parsed = JSON.parse(lds) as { version_info: string; resources: Array<Record<string, any>> };
  const on443 = structuredClone(parsed.resources[0]!);
  parsed.resources[0]!.address.socket_address.port_value = 80;
  on443.name = "slot-3-443";
  on443.address.socket_address.port_value = 443;
  parsed.resources.push(on443);
  parsed.version_info = "1";
  const xds = local(CUSTODIAN_LDS, root);
  await writeFile(`${xds}.next`, JSON.stringify(parsed), { mode: 0o644 });
  await rename(`${xds}.next`, xds);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await get(any, 80, "other.test");
    const fromTarget = await get(target, 80, "x");
    if (answer.startsWith("HTTP/1.1 200") && fromTarget.startsWith("HTTP/1.1 200")) break;
    if (Date.now() > deadline || child.exitCode !== null) {
      assert.fail(`the slot never served:\n${answer}\n${fromTarget}\n${output}`);
    }
    await sleep(200);
  }
  const body = (answer: string) => answer.slice(answer.indexOf("\r\n\r\n") + 4);
  const status = (answer: string) => answer.split("\r\n")[0];

  // Finding 1: a wildcard on port 80 dials port 80 alone, whatever port the Host names.
  for (const authority of ["other.test", "other.test:80"]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 200 OK", authority);
    assert.match(body(answer), /^port=80 /, authority);
  }
  for (const [authority, path] of [
    ["other.test:6379", "/"],
    ["other.test:6379", "http://other.test:6379/"],
    ["other.test:8080", "/"],
  ] as const) {
    const answer = await get(any, 80, authority, path);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority} ${path}: ${answer}`);
    assert.match(body(answer), /port other than 80/);
    assert.doesNotMatch(answer, /port=6379|port=8080/);
  }

  // A name with a trailing dot is refused on port 80, as the CONNECT of a tunnel refuses it.
  for (const authority of ["other.test.", "OTHER.TEST.", "other.test.:80"]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /ends in a dot/, authority);
  }

  // Finding 2: an Intercepted host and jr2's name are refused in any letter case, and with a dot.
  for (const authority of ["secure.test", "SECURE.TEST", "Secure.Test:80", "secure.test."]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /Intercepted host/, authority);
  }
  for (const authority of ["CUSTODIAN.JR2.INTERNAL", "custodian.jr2.internal.:80"]) {
    const answer = await get(any, 80, authority);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${authority}: ${answer}`);
    assert.match(body(answer), /a name of jr2's/, authority);
  }
  const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]);
  const tunneled = await helloReply(any, 443, "other.test");
  assert.equal(tunneled[0], 0x16, "a name that `*` carries is tunneled: the target's server hello");
  for (const servername of ["secure.test", "secure.test.", "custodian.jr2.internal."]) {
    const reply = await helloReply(any, 443, servername);
    assert.deepEqual(reply, alert, `${servername}: the Custodian's TLS alert, and no byte of the target`);
  }

  // Finding 3 and 8: TLS with no name on `*` is refused by name, and the dial listener's line names
  // the Sandbox as each line of the slot does.
  const nameless = await helloReply(any, 443, undefined);
  assert.notEqual(nameless[0], 0x16, "no server hello");
  const line = /jr2\.custodian slot=3 sandbox=probe action=refuse target=-:443 reason=name /;
  for (let i = 0; i < 30 && !line.test(output); i++) await sleep(200);
  assert.match(output, line);
  assert.doesNotMatch(output, /owner=/);
  // A name that does not resolve is the one `unreachable` line; a tunnel that its client closed is
  // no refusal.
  await helloReply(any, 443, "nothing.invalid");
  const unreachable =
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=nothing\.invalid:443 reason=unreachable /;
  for (let i = 0; i < 30 && !unreachable.test(output); i++) await sleep(200);
  assert.match(output, unreachable);
  assert.doesNotMatch(output, /target=other\.test:443 reason=/);

  // Finding 4: a target gets no forwarding header, on a tunnel and through an interception.
  assert.match(body(await get(any, 80, "other.test")), /^port=80 xfp=http xff=- rid=- xei=- fence=-\n$/);
  const intercepted = await new Promise<string>((resolve, reject) => {
    const s = tlsConnect({ host: secure, port: 443, servername: "secure.test", rejectUnauthorized: false }, () =>
      s.write("GET / HTTP/1.1\r\nHost: secure.test\r\nConnection: close\r\n\r\n"),
    );
    let text = "";
    s.on("data", (d: Buffer) => (text += d.toString()));
    s.on("error", reject);
    s.on("close", () => resolve(text));
  });
  assert.equal(status(intercepted), "HTTP/1.1 200 OK", intercepted);
  // The target set `https` itself: the Custodian sent no `x-forwarded-proto`.
  assert.match(body(intercepted), /^port=443 xfp=https xff=- rid=- xei=- fence=-\n$/);

  // Finding 6 and 11: the Orchestrator's dial. Each refusal of the Custodian's own says so, and an
  // error of the program refuses the dial; nothing reaches the target.
  const dial = (token: string) => get(any, 18080, "x", "/", `x-jr2-dial: ${token}\r\nx-jr2-target: ${target}:80\r\n`);
  let answer = await dial("t");
  assert.equal(status(answer), "HTTP/1.1 503 Service Unavailable", answer);
  assert.match(answer, /\r\nx-jr2-custodian: not-ready\r\n/i);
  // The token's path is a folder: it opens, and reads as nothing.
  await mkdir(local(CUSTODIAN_DIAL_TOKEN, root));
  answer = await dial("t");
  assert.equal(status(answer), "HTTP/1.1 503 Service Unavailable", answer);
  assert.match(answer, /\r\nx-jr2-custodian: not-ready\r\n/i);
  await rmdir(local(CUSTODIAN_DIAL_TOKEN, root));
  await putIn(CUSTODIAN_DIAL_TOKEN, "dial-token-value\n", root);
  answer = await dial("wrong");
  assert.equal(status(answer), "HTTP/1.1 403 Forbidden", answer);
  assert.match(answer, /\r\nx-jr2-custodian: refused\r\n/i);
  answer = await dial("dial-token-value");
  assert.equal(status(answer), "HTTP/1.1 503 Service Unavailable", answer);
  assert.match(answer, /\r\nx-jr2-custodian: refused\r\n/i);
  assert.match(body(answer), /could not decide this request/);
  assert.doesNotMatch(answer, /port=80/);
  assert.match(output, /jr2\.custodian dial action=refuse target=- reason=error /);
});

test("the pinned Envoy runs a slot's rules: the dial guard judges each address of a name, so a name whose second address is guarded never reaches it, on each dial path (ADR-0059, ADR-0084)", async (t) => {
  // A name can have more addresses than one, and Envoy connects to the next one when a connection to
  // one fails. Each name below has a first address that answers nothing and a second one that the
  // guard refuses: a slot address of the segment, or the cloud metadata address. The target listens
  // on that second address. Names resolve through the Custodian container's `/etc/hosts`, as a DNS
  // record that Workspace code's author controls could answer. No two lines share an address or a
  // name, so the resolver adds no address to a name.
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-guard-"));
  const tag = `${process.pid}-${Date.now() % 100000}`;
  const nets = ["a", "b", "c"].map((n) => `jr2-cguard-${n}-${tag}`);
  // One network for each guarded address of the target: a container has one address on a network.
  const guardedNets = [
    ["198.19.0.0/26", "198.19.0.5"],
    ["198.19.0.64/26", "198.19.0.69"],
    ["198.19.0.128/26", "198.19.0.133"],
    ["198.19.0.192/26", "198.19.0.197"],
    ["169.254.169.0/24", "169.254.169.254"],
  ].map(([subnet, address], i) => ({ net: `jr2-cguard-g${i}-${tag}`, subnet: subnet!, address: address! }));
  const [targetName, custodianName] = [`jr2-cguard-target-${tag}`, `jr2-cguard-custodian-${tag}`];
  t.after(async () => {
    await docker("rm", "-f", targetName, custodianName).catch(() => {});
    for (const n of [...nets, ...guardedNets.map((g) => g.net)]) await docker("network", "rm", n).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const gid = String(process.getgid?.() ?? 0);
  const user = ["--user", `65532:${gid}`, "--group-add", gid, "--read-only", "--cap-drop", "ALL"];
  for (const n of nets) await docker("network", "create", n);
  for (const g of guardedNets) await docker("network", "create", "--subnet", g.subnet, g.net);

  const ca = issueCa("custodian-guard-run");
  const targetCa = issueCa("custodian-guard-target");
  const targetLeaf = issueLeaf(targetCa, "secure.test");
  await mkdir(join(root, "target"), { recursive: true });
  await writeFile(join(root, "target", "envoy.json"), JSON.stringify(targetBootstrap()), { mode: 0o644 });
  await writeFile(join(root, "target", "tls.crt"), targetLeaf.cert, { mode: 0o644 });
  await writeFile(join(root, "target", "tls.key"), targetLeaf.key, { mode: 0o644 });
  // prettier-ignore
  await docker(
    "run", "-d", "--name", targetName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "target")}:/etc/target:ro`,
    custodianRef(), "-c", "/etc/target/envoy.json", "--log-level", "warning",
  );
  for (const g of guardedNets) await docker("network", "connect", "--ip", g.address, g.net, targetName);
  const target = (await addresses(targetName))[nets[0]!]!;
  // Addresses of the target's first network that no container holds: a connection to one fails.
  const nobody = (n: number) => target.replace(/\.\d+$/, `.${200 + n}`);
  const [seg1, seg2, seg3, segOnly, metadata] = guardedNets.map((g) => g.address);

  // One Sandbox slot: `*` on 443 and 80, `secure.test:443` Intercepted with no secret, and a raw
  // name on 6379.
  const egress = [
    rule("*", 443, "any", false, "entry"),
    rule("*", 80, "any", false, "entry"),
    rule("secure.test", 443, "name", true, "entry"),
    rule("raw.test", 6379, "name", false, "entry"),
  ];
  const placeholders = withPlaceholders(emptyPlaceholders(RANGES.placeholders), egress);
  const inputs: SlotInputs = {
    slot: 3,
    owner: { sandbox: "probe" },
    manifest: { version: 1, secrets: [], egress },
    placeholders,
    ranges: RANGES,
  };
  const slot = renderSlot(inputs);
  await slotFiles(inputs, ca, root);
  await putIn(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM, root);
  await putIn("/etc/jr2/ca/upstream.crt", trustBundles(ca.cert, targetCa.cert).upstream, root);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  });
  await putIn(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap), root);
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await putIn(CUSTODIAN_LDS, empty, root);
  await putIn(CUSTODIAN_CDS, empty, root);
  const hosts = [
    "127.0.0.1 localhost",
    `${target} other.test`,
    `${nobody(1)} multi.test`,
    `${seg1} multi.test`,
    `${nobody(2)} secure.test`,
    `${seg2} secure.test`,
    `${nobody(3)} raw.test`,
    `${seg3} raw.test`,
    `${nobody(4)} meta.test`,
    `${metadata} meta.test`,
    `${segOnly} seg.test`,
    "",
  ].join("\n");
  await writeFile(join(root, "hosts"), hosts, { mode: 0o644 });

  // prettier-ignore
  await docker(
    "create", "--name", custodianName, "--network", nets[0]!, ...user,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    "-v", `${join(root, "hosts")}:/etc/hosts:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  );
  for (const n of [...nets.slice(1), ...guardedNets.map((g) => g.net)]) {
    await docker("network", "connect", n, custodianName);
  }
  let output = "";
  const child = spawn("docker", ["start", "-a", custodianName], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));
  t.after(() => void child.kill());

  let custodian: Record<string, string> = {};
  for (let i = 0; i < 100 && !nets.every((n) => custodian[n]); i++) {
    custodian = await addresses(custodianName).catch(() => ({}));
    await sleep(100);
  }
  const [any, secure, raw] = nets.map((n) => custodian[n]!);
  assert.ok(any && secure && raw, `the Custodian has an address on each network: ${JSON.stringify(custodian)}`);

  // As in the test above: the slot's listener takes ports 80, 443 and 6379 of the Custodian, and the
  // placeholders of `*`, `secure.test` and `raw.test` become its three addresses.
  const moved = (text: string, from: string, to: string) =>
    text.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}:`, `"${to}:`);
  let lds = JSON.stringify(custodianXds([slot]).lds);
  lds = moved(lds, placeholderOf(placeholders, "*")!, any);
  lds = moved(lds, placeholderOf(placeholders, "secure.test")!, secure);
  lds = moved(lds, placeholderOf(placeholders, "raw.test")!, raw);
  const parsed = JSON.parse(lds) as { version_info: string; resources: Array<Record<string, any>> };
  parsed.resources = [80, 443, 6379].map((port) => {
    const listener = structuredClone(parsed.resources[0]!);
    listener.name = `slot-3-${port}`;
    listener.address.socket_address.port_value = port;
    return listener;
  });
  parsed.version_info = "1";
  const xds = local(CUSTODIAN_LDS, root);
  await writeFile(`${xds}.next`, JSON.stringify(parsed), { mode: 0o644 });
  await rename(`${xds}.next`, xds);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await get(any, 80, "other.test");
    if (answer.startsWith("HTTP/1.1 200") && /port=80 /.test(answer)) break;
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the slot never served:\n${answer}\n${output}`);
    await sleep(200);
  }
  // The target is reachable on each guarded address, so a miss below is the guard's, not the rig's.
  for (const address of [seg1, seg2, seg3, segOnly, metadata]) {
    assert.match(await get(address!, 80, "x"), /^HTTP\/1\.1 200[\s\S]*port=80 /, `the target answers on ${address}`);
  }
  const status = (answer: string) => answer.split("\r\n")[0];
  const fromTarget = /port=(80|443|6379) /;

  // Plain HTTP through `*` on port 80 (the `dial-http` listener): the slot address, and the cloud
  // metadata address, behind a first address that fails.
  for (const host of ["multi.test", "meta.test"]) {
    for (let i = 0; i < 2; i++) {
      const answer = await get(any, 80, host);
      assert.doesNotMatch(answer, fromTarget, `${host}: no byte of the target\n${answer}`);
      assert.notEqual(status(answer), "HTTP/1.1 200 OK", `${host}: ${answer}`);
    }
  }
  // A TLS tunnel through `*` on port 443 (the `dial` listener): no server hello of the target.
  for (let i = 0; i < 2; i++) {
    const reply = await helloReply(any, 443, "multi.test");
    assert.notEqual(reply[0], 0x16, "multi.test on 443: no server hello of the target");
  }
  // An Intercepted host (the `dial-tls` listener): the Custodian's own TLS to the target, refused.
  for (let i = 0; i < 2; i++) {
    const intercepted = await new Promise<string>((resolve) => {
      const s = tlsConnect({ host: secure, port: 443, servername: "secure.test", rejectUnauthorized: false }, () =>
        s.write("GET / HTTP/1.1\r\nHost: secure.test\r\nConnection: close\r\n\r\n"),
      );
      let text = "";
      s.setTimeout(10_000, () => s.destroy());
      s.on("data", (d: Buffer) => (text += d.toString()));
      s.on("error", () => resolve(text));
      s.on("close", () => resolve(text));
    });
    assert.doesNotMatch(intercepted, fromTarget, `secure.test: no byte of the target\n${intercepted}`);
    assert.notEqual(status(intercepted), "HTTP/1.1 200 OK", intercepted);
  }
  // A raw name on port 6379 (the `dial` listener): the target would answer HTTP on 6379.
  for (let i = 0; i < 2; i++) {
    const answer = await rawHttp(raw, 6379, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.doesNotMatch(answer, fromTarget, `raw.test:6379: no byte of the target\n${answer}`);
  }
  // No line of a dial says that one of these names was carried.
  assert.doesNotMatch(output, /target=(multi|meta|secure|raw)\.test\S* .*status=200/);

  // A name with no address left (a slot address alone, or `localhost`): the guard's refusal, and
  // its line.
  for (const host of ["seg.test", "localhost"]) {
    const answer = await get(any, 80, host);
    assert.equal(status(answer), "HTTP/1.1 403 Forbidden", `${host}: ${answer}`);
    assert.match(answer, /resolves to an address that the Custodian never dials/, host);
  }
  const reply = await helloReply(any, 443, "seg.test");
  assert.equal(reply.length, 0, "seg.test on 443: closed with no byte");
  for (const line of [
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=seg\.test reason=guard /,
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=seg\.test:443 reason=guard /,
    /jr2\.custodian slot=3 sandbox=probe action=refuse target=localhost reason=guard /,
  ]) {
    for (let i = 0; i < 30 && !line.test(output); i++) await sleep(200);
    assert.match(output, line);
  }
});
